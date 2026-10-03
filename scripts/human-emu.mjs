// Стенд фичи: features/sew-inventory/core.js — «эмуляция человека»
// (случайный темп, зависания, отклонения по позициям).
// core.js идёт в гостя склеенным с main.js, поэтому экспортов не имеет —
// читаем исходник и собираем функции через new Function.
// Запуск: node scripts/human-emu.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../features/sew-inventory/core.js', import.meta.url), 'utf8')
const api = new Function(
  SRC +
    '\nreturn { EMU_TEMPO_MIN_SEC, EMU_TEMPO_MAX_SEC, EMU_ERROR_DEFAULT_PCT, EMU_SPEED_FLOOR_SEC,' +
    ' EMU_SPEED_CEIL_SEC, EMU_SHORT_MAX, EMU_OVER_MAX, EMU_STALL_PCT,' +
    ' emuNum, emuClamp, emuRandSec, emuStallFactor, emuRoll, emuTarget, emuDescribe }'
)()

test('emuNum понимает запятую как десятичный разделитель и откатывается к дефолту', () => {
  assert.equal(api.emuNum('1,5', 0), 1.5)
  assert.equal(api.emuNum(' 2 ', 0), 2)
  assert.equal(api.emuNum('мусор', 7), 7)
  assert.equal(api.emuNum(undefined, 7), 7)
  assert.equal(api.emuNum(null, 7), 7)
})

test('emuRandSec держится диапазона и меняет границы местами', () => {
  assert.equal(api.emuRandSec(1, 3, () => 0), 1)
  assert.equal(api.emuRandSec(1, 3, () => 1), 3)
  assert.equal(api.emuRandSec(1, 3, () => 0.5), 2)
  // Перепутанные границы не дают пустой диапазон.
  assert.equal(api.emuRandSec(3, 1, () => 0), 1)
  assert.equal(api.emuRandSec(3, 1, () => 1), 3)
})

test('emuRandSec зажимает абсурдные значения', () => {
  assert.equal(api.emuRandSec(0, 999, () => 0), api.EMU_SPEED_FLOOR_SEC)
  assert.equal(api.emuRandSec(0, 999, () => 1), api.EMU_SPEED_CEIL_SEC)
  assert.equal(api.emuRandSec('мусор', 'мусор', () => 0), api.EMU_TEMPO_MIN_SEC)
})

test('emuStallFactor: без шанса — единица, при шансе — множитель 2–3', () => {
  assert.equal(api.emuStallFactor(0, () => 0), 1)
  assert.equal(api.emuStallFactor(0, () => 0.99), 1)
  // Шанс 100 % — зависает всегда, но не чаще одного раза на бросок множителя.
  const always = api.emuStallFactor(100, () => 0.5)
  assert.ok(always >= 2 && always <= 3, 'множитель в 2–3, получено ' + always)
  // Порог не срабатывает: rnd()*100 >= pct.
  assert.equal(api.emuStallFactor(5, () => 0.9), 1)
})

test('emuRoll: 0 % — без отклонений, 100 % — тип по кубику', () => {
  assert.equal(api.emuRoll(0, () => 0), null)
  assert.equal(api.emuRoll(0, () => 0.5), null)
  assert.equal(api.emuRoll(100, () => 0.1), 'skip')
  assert.equal(api.emuRoll(100, () => 0.6), 'short')
  assert.equal(api.emuRoll(100, () => 0.8), 'over')
  // Ниже порога — как будто отклонений нет.
  assert.equal(api.emuRoll(3, () => 0.99), null)
})

test('частота отклонений держится заданного процента', () => {
  let hits = 0
  for (let i = 0; i < 20000; i++) {
    if (api.emuRoll(3) !== null) hits++
  }
  const pct = (hits / 20000) * 100
  assert.ok(pct > 2.4 && pct < 3.6, 'доля отклонений ' + pct.toFixed(2) + ' %, ожидалось ~3 %')
})

test('emuTarget: без отклонения — весь остаток', () => {
  assert.equal(api.emuTarget(7, null), 7)
  assert.equal(api.emuTarget(7, null, () => 0), 7)
  assert.equal(api.emuTarget(0, null), 0)
  assert.equal(api.emuTarget(-3, null), 0)
})

test('emuTarget: пропуск — ноль, недостача — минус 1–3, излишек — плюс 1–2', () => {
  assert.equal(api.emuTarget(7, 'skip', () => 0), 0)
  assert.equal(api.emuTarget(7, 'short', () => 0), 6)
  assert.equal(api.emuTarget(7, 'short', () => 0.99), 4)
  assert.equal(api.emuTarget(7, 'over', () => 0), 8)
  assert.equal(api.emuTarget(7, 'over', () => 0.99), 9)
  // Остаток меньше самой недостачи — уходим в ноль, а не в минус.
  assert.equal(api.emuTarget(2, 'short', () => 0.5), 0)
  assert.equal(api.emuTarget(1, 'short', () => 0), 0)
})

test('emuDescribe собирает итоги и молчит, когда отклонений не было', () => {
  assert.equal(api.emuDescribe({ skip: 0, short: 0, over: 0 }), '')
  assert.equal(api.emuDescribe(null), '')
  assert.equal(
    api.emuDescribe({ skip: 2, short: 1, over: 3 }),
    'пропущено позиций: 2, недостача: 1, излишек: 3'
  )
})

test('модельный прогон: план сходится с остатками в границах отклонений', () => {
  const rows = []
  for (let i = 0; i < 300; i++) rows.push({ sku: 'SKU-' + i, qty: 4, counted: 1 })
  const deviations = { skip: 0, short: 0, over: 0 }
  let planned = 0
  let real = 0
  for (const row of rows) {
    const remaining = Math.max(0, row.qty - row.counted)
    const dev = api.emuRoll(3)
    if (dev) deviations[dev]++
    planned += api.emuTarget(remaining, dev)
    real += remaining
  }
  const totalDev = deviations.skip + deviations.short + deviations.over
  assert.ok(totalDev > 0, 'на 300 позициях при 3 % отклонения должны случиться')
  // Пропуск стоит все 3 единицы позиции, недостача — до 3, излишек добавляет до 2.
  assert.ok(planned >= real - deviations.skip * 3 - deviations.short * api.EMU_SHORT_MAX)
  assert.ok(planned <= real + deviations.over * api.EMU_OVER_MAX)
  assert.equal(api.emuDescribe(deviations) !== '', true)
})