import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Чистая логика плагина лежит в features/sew-inventory/core.js (его же
// склеивает loader ПЕРЕД main.js — функции становятся глобальными).
// Файл не входит в «src/**/*.test.ts», поэтому тест на него живёт здесь и
// грузит исходник так же, как ручной стенд scripts/human-emu.mjs.
const SRC = readFileSync(new URL('../../../features/sew-inventory/core.js', import.meta.url), 'utf8')
const api = new Function(SRC + '\nreturn { invAnswered, invTakeAnswer }')() as {
  invAnswered(box: unknown, id: unknown): boolean
  invTakeAnswer(box: unknown, id: unknown): { answered: boolean; value: unknown }
}

test('мост ответил, даже если ответ falsy — отмена диалога это null', () => {
  assert.equal(api.invAnswered({ pick1: null }, 'pick1'), true)
  assert.equal(api.invAnswered({ pick1: '' }, 'pick1'), true)
  assert.equal(api.invAnswered({ pick1: false }, 'pick1'), true)
  assert.equal(api.invAnswered({ pick1: 0 }, 'pick1'), true)
})

test('нет ключа — ответа ещё нет', () => {
  assert.equal(api.invAnswered({}, 'pick1'), false)
  assert.equal(api.invAnswered(null, 'pick1'), false)
  assert.equal(api.invAnswered(undefined, 'pick1'), false)
  assert.equal(api.invAnswered('строка', 'pick1'), false)
})

test('не-строка id не считается запросом', () => {
  assert.equal(api.invAnswered({ a: 1 }, undefined), false)
  assert.equal(api.invAnswered({ a: 1 }, null), false)
  assert.equal(api.invAnswered({ a: 1 }, 42), false)
})

test('ключ с прототипа ответом не считается', () => {
  assert.equal(api.invAnswered(Object.create({ pick1: 'подмена' }) as object, 'pick1'), false)
  assert.equal(api.invAnswered(Object.create(null) as object, 'toString'), false)
})

test('забор ответа отдаёт значение и убирает ключ', () => {
  const box: Record<string, unknown> = { pick1: null }
  const taken = api.invTakeAnswer(box, 'pick1')
  assert.equal(taken.answered, true)
  assert.equal(taken.value, null)
  assert.equal(Object.prototype.hasOwnProperty.call(box, 'pick1'), false)
})

test('повторный забор того же ключа — ответа уже нет', () => {
  const box: Record<string, unknown> = { pick1: 'C:\\остатки.xlsx' }
  assert.equal(api.invTakeAnswer(box, 'pick1').value, 'C:\\остатки.xlsx')
  const second = api.invTakeAnswer(box, 'pick1')
  assert.equal(second.answered, false)
  assert.equal(second.value, undefined)
})

test('забор несуществующего ключа ничего не удаляет и не падает', () => {
  const box: Record<string, unknown> = { other: 1 }
  assert.equal(api.invTakeAnswer(box, 'pick1').answered, false)
  assert.deepEqual(box, { other: 1 })
  assert.equal(api.invTakeAnswer(null, 'pick1').answered, false)
})

// Сквозной контракт гость↔оболочка: оболочка кладёт ответ выражением из
// src/renderer/src/bridges.ts (answerInventory), гость забирает invTakeAnswer'ом.
const writeAnswer = (win: { __sewInventoryRes?: Record<string, unknown> }, id: string, mainResult: unknown): void => {
  const payload = JSON.stringify(mainResult ?? null)
  ;(win.__sewInventoryRes = win.__sewInventoryRes || {})[id] = JSON.parse(payload)
}

test('отмена диалога проходит мост за один тик, а не через таймаут', () => {
  const win: { __sewInventoryRes?: Record<string, unknown> } = {}
  // Гость только что поставил запрос — ответа в окне ещё нет.
  assert.equal(api.invTakeAnswer(win.__sewInventoryRes, 'pick1').answered, false)
  // Оболочка открыла диалог, пользователь нажал «Отмена» → pickStockFile вернул null.
  writeAnswer(win, 'pick1', null)
  const taken = api.invTakeAnswer(win.__sewInventoryRes, 'pick1')
  assert.equal(taken.answered, true)
  assert.equal(taken.value, null)
  // Ключ убран — повторный опрос не «съест» тот же ответ.
  assert.equal(api.invTakeAnswer(win.__sewInventoryRes, 'pick1').answered, false)
})

test('успешно выбранный путь доходит без изменений', () => {
  const win: { __sewInventoryRes?: Record<string, unknown> } = {}
  writeAnswer(win, 'pick1', 'C:\\остатки S187.xlsx')
  assert.equal(api.invTakeAnswer(win.__sewInventoryRes, 'pick1').value, 'C:\\остатки S187.xlsx')
})
