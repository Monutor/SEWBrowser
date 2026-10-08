import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PRICETAG_KEYS, VALIDATORS, dropInvalidPricetags, pickPricetagConfig } from './config-core.ts'

/**
 * Дефолты фичи «Ценники» — те же значения, что в DEFAULTS (config.ts).
 * Дублируем намеренно: config.ts импортирует electron и под `node --test`
 * физически не грузится, поэтому тестать приходится сам модуль config-core.ts.
 */
const DEFAULTS = {
  pricetagObjectId: 'S187',
  pricetagTemplateId: 89,
  pricetagPaperColorId: 1,
  pricetagCopies: 1,
  pricetagBarcodeWidth: 100,
}

describe('pickPricetagConfig — merge пользовательского config.json', () => {
  it('битое значение из файла заменяется дефолтом, а не мусором уходит в SEW', () => {
    // Каждый ключ со своим видом мусора из config.json: правильный JSON,
    // но значения нет (пользователь правил руками).
    assert.deepEqual(pickPricetagConfig({ pricetagObjectId: 187 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagTemplateId: '89' }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagPaperColorId: null }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: {} }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: [] }, DEFAULTS), DEFAULTS)
  })

  it('отсутствующие в файле ключи берутся из дефолтов', () => {
    assert.deepEqual(pickPricetagConfig({}, DEFAULTS), DEFAULTS)
    // Явно undefined — тоже «нет значения», не тихо протаскиваем undefined дальше.
    assert.deepEqual(pickPricetagConfig({ pricetagTemplateId: undefined }, DEFAULTS), DEFAULTS)
  })

  it('число вне диапазона заменяется дефолтом', () => {
    assert.deepEqual(pickPricetagConfig({ pricetagTemplateId: 0 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagTemplateId: -89 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagTemplateId: 89.5 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagPaperColorId: 0 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagPaperColorId: 4 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: 0 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: 1000 }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: 2.5 }, DEFAULTS), DEFAULTS)
  })

  it('код магазина с пробелом, точкой, .. или длиннее 16 символов — дефолт', () => {
    // objectId уходит в query-параметр SEW и в имя файла, поэтому фильтр строгий.
    for (const bad of ['S 187', 'S.187', '..', '../S187', 'S187/../x', '', 'A'.repeat(17)]) {
      assert.deepEqual(pickPricetagConfig({ pricetagObjectId: bad }, DEFAULTS), DEFAULTS, `код ${JSON.stringify(bad)} должен отбрасываться`)
    }
  })

  it('валидные значения из файла сохраняются без изменения', () => {
    const user = {
      pricetagObjectId: 'S012',
      pricetagTemplateId: 96,
      pricetagPaperColorId: 3,
      pricetagCopies: 999,
      // намеренно не дефолтное 100: тест обязан доказать, что значение взято
      // из файла, а не подставлено дефолтом
      pricetagBarcodeWidth: 250,
    }
    assert.deepEqual(pickPricetagConfig(user, DEFAULTS), user)
  })

  it('валидное значение одного магазина не мешает остальным ключам', () => {
    assert.deepEqual(pickPricetagConfig({ pricetagObjectId: 'S012', pricetagCopies: '3' }, DEFAULTS), {
      ...DEFAULTS,
      pricetagObjectId: 'S012',
    })
  })
})

describe('dropInvalidPricetags — патч config:set', () => {
  it('невалидные ключи выбрасываются из патча, чтобы не затереть значение в файле', () => {
    assert.deepEqual(dropInvalidPricetags({ pricetagObjectId: 'S 187' }), {})
    assert.deepEqual(dropInvalidPricetags({ pricetagTemplateId: '89' }), {})
    assert.deepEqual(dropInvalidPricetags({ pricetagPaperColorId: 4 }), {})
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 0 }), {})
  })

  it('валидные значения остаются в патче как есть', () => {
    assert.deepEqual(dropInvalidPricetags({ pricetagObjectId: 'S012' }), { pricetagObjectId: 'S012' })
    assert.deepEqual(dropInvalidPricetags({ pricetagTemplateId: 96 }), { pricetagTemplateId: 96 })
    assert.deepEqual(dropInvalidPricetags({ pricetagPaperColorId: 2 }), { pricetagPaperColorId: 2 })
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 999 }), { pricetagCopies: 999 })
  })

  it('отсутствующие в патче ключи не добавляются и не удаляются', () => {
    // config:set присылает только изменённые поля — отсутствие ключа не значит
    // «сбросить в дефолт», поле в файле должно остаться как было.
    assert.deepEqual(dropInvalidPricetags({}), {})
    assert.deepEqual(dropInvalidPricetags({ stockObjectId: 'S012' }), { stockObjectId: 'S012' })
  })

  it('валидный ключ переживает невалидный сосед в том же патче', () => {
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 5, pricetagPaperColorId: '2' }), {
      pricetagCopies: 5,
    })
  })

  it('неизвестные и чужие ключи патча не трогаются', () => {
    const patch = {
      stockObjectId: 'S187',
      pricetagCopies: 3,
      maxLiveTabs: 2,
      print: { destination: 'pdf' },
      downloadsDir: '',
    }
    assert.deepEqual(dropInvalidPricetags(patch), patch)
  })

  it('аргумент патча не мутируется — возвращается новый объект', () => {
    const patch = { pricetagCopies: 0, pricetagObjectId: 'S012' }
    const cleaned = dropInvalidPricetags(patch)
    assert.deepEqual(patch, { pricetagCopies: 0, pricetagObjectId: 'S012' })
    assert.notEqual(cleaned, patch)
  })

  it('тот же невалидный ключ отбрасывается обоими путями', () => {
    // Правила валидации не должны разъезжаться между merge и патчем, иначе
    // значение, отброшенное в патче, снова всплывёт из файла при следующем чтении.
    for (const value of ['S.187', 'S 187', 'A'.repeat(17)]) {
      assert.deepEqual(pickPricetagConfig({ pricetagObjectId: value }, DEFAULTS).pricetagObjectId, 'S187')
      assert.equal('pricetagObjectId' in dropInvalidPricetags({ pricetagObjectId: value }), false)
    }
  })
})

describe('ключи патч-пути и валидаторы не разъезжаются', () => {
  it('патч-путь обходит ровно те ключи, для которых заведён валидатор', () => {
    // Пока список ключей можно было написать руками, добавление пятого ключа
    // ценников могло забыться именно в нём: typecheck проходил бы
    // (Record исчерпывающе типизирован, а массив строк — нет), патч-путь
    // config:set молча потерял бы санитайз, и битое значение доехало бы до
    // config.json. Сортировка — сравниваем множества, порядок тут не значит.
    assert.deepEqual([...PRICETAG_KEYS].sort(), Object.keys(VALIDATORS).sort())
  })

  it('невалидное значение выбрасывается из патча для каждого ключа из VALIDATORS', () => {
    // null невалиден сразу для всех пяти проверок: код магазина ждёт строку,
    // остальные четыре — число, а null не то и не другое. Ключи берём из
    // VALIDATORS, поэтому новый ключ ценников попадает в проверку сам.
    for (const key of Object.keys(VALIDATORS)) {
      assert.deepEqual(dropInvalidPricetags({ [key]: null }), {}, `ключ ${key} должен выбрасываться из патча`)
    }
  })

  it('merge-путь уводит невалидное значение каждого ключа из VALIDATORS на дефолт', () => {
    for (const key of Object.keys(VALIDATORS)) {
      assert.deepEqual(pickPricetagConfig({ [key]: null }, DEFAULTS), DEFAULTS, `ключ ${key} должен уходить на дефолт`)
    }
  })
})