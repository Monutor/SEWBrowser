import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPatchRejection } from './pricetags-core.ts'

// Правки оверлея «Ценники»: при отказе патча main прежний код звал
// openPricetags(), который гасит введённые артикулы и найденные позиции.
// Откат должен трогать ТОЛЬКО отвергнутое поле.

test('принятый патч: отказа нет, откатывать нечего', () => {
  const r = detectPatchRejection({ copies: 3 }, { copies: 3 })
  assert.deepEqual(r.rejected, [])
  assert.deepEqual(r.values, {})
  assert.deepEqual(r.labels, [])
  assert.equal(r.message, null)
})

test('отвергнутый логин: возвращаем прежнее значение, артикулы не трогаем', () => {
  const r = detectPatchRejection(
    { sewUsername: '181165й' },
    { sewUsername: '181165' },
    { sewUsername: 'Логин SEW' },
  )
  assert.deepEqual(r.rejected, ['sewUsername'])
  assert.deepEqual(r.values, { sewUsername: '181165' })
  assert.deepEqual(r.labels, ['Логин SEW'])
  assert.ok(r.message && r.message.includes('Логин SEW'))
  assert.ok(r.message && r.message.includes('артикул'), 'статус должен обещать, что ввод сохранён')
})

test('отвергнутые копии: main вернул прежнее значение', () => {
  const r = detectPatchRejection({ copies: 0 }, { copies: 1 }, { copies: 'Копий каждого' })
  assert.deepEqual(r.rejected, ['copies'])
  assert.deepEqual(r.values, { copies: 1 })
  assert.deepEqual(r.labels, ['Копий каждого'])
})

test('несколько отвергнутых полей перечисляются в порядке патча', () => {
  const r = detectPatchRejection(
    { copies: 0, sewUsername: 'йог' },
    { copies: 2, sewUsername: 'ivanov' },
    { copies: 'Копий каждого', sewUsername: 'Логин SEW' },
  )
  assert.deepEqual(r.rejected, ['copies', 'sewUsername'])
  assert.deepEqual(r.values, { copies: 2, sewUsername: 'ivanov' })
  assert.deepEqual(r.labels, ['Копий каждого', 'Логин SEW'])
  // Множественное число без «настройкамии» и прочих склеек.
  assert.ok(r.message && r.message.includes('значения не приняты'), r.message ?? '')
  assert.ok(r.message && !r.message.includes('настройкамии'), r.message ?? '')
})

test('подпись неизвестного ключа — сам ключ, сообщение всё равно читаемо', () => {
  const r = detectPatchRejection({ mystery: 'x' }, { mystery: 'y' })
  assert.deepEqual(r.labels, ['mystery'])
  assert.ok(r.message && r.message.includes('mystery'))
})

test('без подписей сообщение всё равно называет ключ', () => {
  const r = detectPatchRejection({ copies: 0 }, { copies: 1 })
  assert.ok(r.message && r.message.includes('copies'))
})

test('сравнение строковое: форма отдаёт строку, конфиг — число', () => {
  assert.deepEqual(detectPatchRejection({ copies: 3 }, { copies: '3' }).rejected, [])
  assert.deepEqual(detectPatchRejection({ copies: 3 }, { copies: 4 }).rejected, ['copies'])
})

test('ключ, которого вовсе нет в ответе main, считается отвергнутым', () => {
  const r = detectPatchRejection({ store: 'S187' }, {})
  assert.deepEqual(r.rejected, ['store'])
  assert.deepEqual(r.values, { store: undefined })
})

test('мусор на входе не роняет: пустые патч и next — отказа нет', () => {
  for (const bad of [null, undefined, 'строка', 42, []]) {
    const r = detectPatchRejection(bad, bad)
    assert.deepEqual(r.rejected, [], JSON.stringify(bad))
    assert.equal(r.message, null)
  }
})

test('правка в пустое значение не считается отказом (пользователь очистил поле)', () => {
  // main принимает пустой логин — это отказ не по значению, а по отсутствию.
  assert.deepEqual(detectPatchRejection({ sewUsername: '' }, { sewUsername: '' }).rejected, [])
})

test('сообщение при отказе не обещает сохранение отвергнутого поля', () => {
  const r = detectPatchRejection({ copies: 0 }, { copies: 1 }, { copies: 'Копий каждого' })
  assert.ok(r.message)
  assert.ok(r.message.includes('откат'), r.message ?? '')
})
