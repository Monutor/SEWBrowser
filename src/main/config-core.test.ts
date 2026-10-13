import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PRICETAG_KEYS, VALIDATORS, dropInvalidPricetags, pickPricetagConfig } from './config-core.ts'

/**
 * Дефолты фичи печати — те же значения, что в DEFAULTS (config.ts). Дублируем
 * намеренно: config.ts импортирует electron и под `node --test` физически не
 * грузится, поэтому тестать приходится сам модуль config-core.ts.
 *
 * После снятия печати ценников через SEW от фичи остался один ключ —
 * pricetagCopies (число копий на листе штрихов). Тесты на два пути отказа
 * (merge файла и патч config:set) сохранены: именно они ловят значения,
 * «похожие на правильные, но не годные».
 */
const DEFAULTS = {
  pricetagCopies: 1,
}

describe('pickPricetagConfig — merge пользовательского config.json', () => {
  it('битое значение из файла заменяется дефолтом, а не мусором уходит в печать', () => {
    // Правильный JSON, но значения нет (пользователь правил руками).
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: {} }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: [] }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: '3' }, DEFAULTS), DEFAULTS)
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: null }, DEFAULTS), DEFAULTS)
  })

  it('отсутствующие в файле ключи берутся из дефолтов', () => {
    assert.deepEqual(pickPricetagConfig({}, DEFAULTS), DEFAULTS)
    // Явно undefined — тоже «нет значения», не тихо протаскиваем undefined дальше.
    assert.deepEqual(pickPricetagConfig({ pricetagCopies: undefined }, DEFAULTS), DEFAULTS)
  })

  it('число вне диапазона или не целое заменяется дефолтом', () => {
    // Копии множатся на листе: 0 и дробь печатать нельзя, 1000 — опечатка.
    for (const bad of [0, -1, 1000, 2.5, NaN, Infinity]) {
      assert.deepEqual(pickPricetagConfig({ pricetagCopies: bad }, DEFAULTS), DEFAULTS, `копии ${bad} должны отбрасываться`)
    }
  })

  it('валидные значения из файла сохраняются без изменения', () => {
    const user = {
      // намеренно не дефолтная 1: тест обязан доказать, что значение взято
      // из файла, а не подставлено дефолтом
      pricetagCopies: 999,
    }
    assert.deepEqual(pickPricetagConfig(user, DEFAULTS), user)
  })

  it('границы диапазона валидны', () => {
    assert.equal(pickPricetagConfig({ pricetagCopies: 1 }, DEFAULTS).pricetagCopies, 1)
    assert.equal(pickPricetagConfig({ pricetagCopies: 999 }, DEFAULTS).pricetagCopies, 999)
  })
})

describe('dropInvalidPricetags — патч config:set', () => {
  it('невалидные ключи выбрасываются из патча, чтобы не затереть значение в файле', () => {
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 0 }), {})
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 2.5 }), {})
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: '3' }), {})
  })

  it('валидные значения остаются в патче как есть', () => {
    assert.deepEqual(dropInvalidPricetags({ pricetagCopies: 999 }), { pricetagCopies: 999 })
  })

  it('отсутствующие в патче ключи не добавляются и не удаляются', () => {
    // config:set присылает только изменённые поля — отсутствие ключа не значит
    // «сбросить в дефолт», поле в файле должно остаться как было.
    assert.deepEqual(dropInvalidPricetags({}), {})
    assert.deepEqual(dropInvalidPricetags({ stockObjectId: 'S012' }), { stockObjectId: 'S012' })
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
    const patch = { pricetagCopies: 0 }
    const cleaned = dropInvalidPricetags(patch)
    assert.deepEqual(patch, { pricetagCopies: 0 })
    assert.notEqual(cleaned, patch)
  })

  it('тот же невалидный ключ отбрасывается обоими путями', () => {
    // Правила валидации не должны разъезжаться между merge и патчем, иначе
    // значение, отброшенное в патче, снова всплывёт из файла при следующем чтении.
    for (const value of [0, 1000, '3', null]) {
      assert.deepEqual(pickPricetagConfig({ pricetagCopies: value }, DEFAULTS).pricetagCopies, 1)
      assert.equal('pricetagCopies' in dropInvalidPricetags({ pricetagCopies: value }), false)
    }
  })
})

describe('ключи патч-пути и валидаторы не разъезжаются', () => {
  it('патч-путь обходит ровно те ключи, для которых заведён валидатор', () => {
    // Пока список ключей можно было написать руками, добавление нового ключа
    // могло забыться именно в нём: typecheck проходил бы (Record исчерпывающе
    // типизирован, а массив строк — нет), патч-путь config:set молча потерял бы
    // санитайз, и битое значение доехало бы до config.json. Сортировка —
    // сравниваем множества, порядок тут не значит.
    assert.deepEqual([...PRICETAG_KEYS].sort(), Object.keys(VALIDATORS).sort())
  })

  it('невалидное значение выбрасывается из патча для каждого ключа из VALIDATORS', () => {
    // Ключи берём из VALIDATORS, поэтому новый ключ попадает в проверку сам.
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