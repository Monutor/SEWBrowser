import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Чистая логика плагина лежит в features/tasks-notify/core.js (его склеивает
// loader ПЕРЕД tasks-notify.js). Файл не входит в «src/**/*.test.ts», поэтому
// тест на него живёт здесь и грузит исходник так же, как scripts/human-emu.mjs.
const SRC = readFileSync(new URL('../../../features/tasks-notify/core.js', import.meta.url), 'utf8')
const api = new Function(
  SRC +
    '\nreturn { TN_INTERVAL_MIN_SEC, TN_INTERVAL_DEFAULT_SEC, tnIntervalSec, tnIntervalChanged }',
)() as {
  TN_INTERVAL_MIN_SEC: number
  TN_INTERVAL_DEFAULT_SEC: number
  tnIntervalSec(value: unknown): number
  tnIntervalChanged(currentSec: unknown, nextSec: unknown): boolean
}

test('период из настроек принимается, дробный округляется вниз', () => {
  assert.equal(api.tnIntervalSec(300), 300)
  assert.equal(api.tnIntervalSec(15), 15)
  assert.equal(api.tnIntervalSec('120'), 120)
  assert.equal(api.tnIntervalSec('2,5'), api.TN_INTERVAL_DEFAULT_SEC)
  assert.equal(api.tnIntervalSec(90.7), 90)
})

test('мусор и слишком малый период дают дефолт', () => {
  assert.equal(api.tnIntervalSec(undefined), 60)
  assert.equal(api.tnIntervalSec(null), 60)
  assert.equal(api.tnIntervalSec(''), 60)
  assert.equal(api.tnIntervalSec('часто'), 60)
  assert.equal(api.tnIntervalSec(NaN), 60)
  assert.equal(api.tnIntervalSec(0), 60)
  assert.equal(api.tnIntervalSec(5), 60)
  assert.equal(api.tnIntervalSec(-300), 60)
})

test('первый запуск всегда переставляет таймер', () => {
  assert.equal(api.tnIntervalChanged(0, 60), true)
  assert.equal(api.tnIntervalChanged(null, 60), true)
  assert.equal(api.tnIntervalChanged(undefined, 300), true)
})

test('сменившийся период переставляет таймер без перезагрузки страницы', () => {
  assert.equal(api.tnIntervalChanged(60, 300), true)
  assert.equal(api.tnIntervalChanged(300, 60), true)
})

test('тот же период таймер не трогает — иначе сбросится отсчёт', () => {
  assert.equal(api.tnIntervalChanged(60, 60), false)
  assert.equal(api.tnIntervalChanged(300, '300'), false)
  // Мусор в настройках сводится к дефолту, а не «значит, период другой».
  assert.equal(api.tnIntervalChanged(60, 'ерунда'), false)
  assert.equal(api.tnIntervalChanged(60, 7), false)
})
