import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PRICETAG_KEYS, VALIDATORS, dropInvalidPricetags, pickMaxLiveTabs, pickPricetagConfig } from './config-core.ts'

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

/** Бюджет живых гостей по умолчанию — то же значение, что в DEFAULTS (config.ts). */
const LIVE_TABS_FALLBACK = 4

describe('pickMaxLiveTabs — бюджет живых гостей', () => {
  it('0 из config.json выключает выгрузку, а не превращается в дефолт', () => {
    // Пользователь руками ставит 0, чтобы вкладки не выгружались. Раньше здесь
    // возвращался дефолт: SEWBrowser продолжал молча выгружать фоновые вкладки,
    // и обещание из документации SewConfig («0 — не выгружать») было ложью.
    assert.equal(pickMaxLiveTabs(0, LIVE_TABS_FALLBACK), 0)
    // -0 тоже выключение (Math.floor(-0.4) === -0, но проверим явно: значение
    // должно быть ровно 0, а не мусором уйти в дефолт).
    assert.equal(Object.is(pickMaxLiveTabs(-0, LIVE_TABS_FALLBACK), 0), true)
  })

  it('положительное целое и его дробная часть берутся как есть, вниз', () => {
    assert.equal(pickMaxLiveTabs(1, LIVE_TABS_FALLBACK), 1)
    assert.equal(pickMaxLiveTabs(4, LIVE_TABS_FALLBACK), 4)
    assert.equal(pickMaxLiveTabs(16, LIVE_TABS_FALLBACK), 16)
    assert.equal(pickMaxLiveTabs(3.9, LIVE_TABS_FALLBACK), 3)
  })

  it('отсутствие поля и мусор из файла идут на дефолт', () => {
    for (const bad of [undefined, null, '4', '', {}, [], true, NaN, Infinity, -Infinity]) {
      assert.equal(pickMaxLiveTabs(bad, LIVE_TABS_FALLBACK), LIVE_TABS_FALLBACK, `${JSON.stringify(bad)} должен давать дефолт`)
    }
  })

  it('отрицательное значение — мусор, а не «выключить выгрузку»', () => {
    // -1 в файле получается опечаткой («-0» при правке), а не намерением. Если
    // бы от него шёл 0, то битое значение молча отключало бы экономию памяти —
    // ровно тот исход, ради которого 0 нельзя приравнивать к мусору.
    for (const bad of [-1, -4, -0.5, -100]) {
      assert.equal(pickMaxLiveTabs(bad, LIVE_TABS_FALLBACK), LIVE_TABS_FALLBACK, `${bad} должен давать дефолт`)
    }
  })

  it('битый дефолт не вырождается в 0 — выгрузка не отключается молча', () => {
    // 0 означает «не выгружать», поэтому дефолт ни при каких обстоятельствах не
    // должен стать нулём: иначе правка вызова или битое значение в DEFAULTS
    // тихо отключили бы экономию памяти у всех вкладок.
    for (const bad of [undefined, null, 0, -1, NaN, '4', {}]) {
      const out = pickMaxLiveTabs('мусор', bad as unknown as number)
      assert.equal(out, LIVE_TABS_FALLBACK, `fallback ${JSON.stringify(bad)} должен давать дефолт`)
      assert.ok(out >= 1, `fallback ${JSON.stringify(bad)} не должен давать 0`)
    }
  })

  it('валидный 0 остаётся 0 независимо от дефолта', () => {
    // Наоборот: 0 — осознанный выбор пользователя, и подмена дефолта не должна
    // его перебивать, иначе фикс снова станет ложью.
    assert.equal(pickMaxLiveTabs(0, undefined), 0)
    assert.equal(pickMaxLiveTabs(0, 8), 0)
    assert.equal(pickMaxLiveTabs(0, 0), 0)
  })

  it('явный дефолт вызывающего уважается', () => {
    assert.equal(pickMaxLiveTabs(undefined, 8), 8)
    assert.equal(pickMaxLiveTabs(undefined, 8.7), 8)
    assert.equal(pickMaxLiveTabs('мусор', 2), 2)
  })
})