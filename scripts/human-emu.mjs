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
    '\nreturn { EMU_TEMPO_MIN_SEC, EMU_TEMPO_MAX_SEC, EMU_SHORT_DEFAULT_PCT, EMU_OVER_DEFAULT_PCT,' +
    ' EMU_PCT_CEIL, EMU_SPEED_FLOOR_SEC, EMU_SPEED_CEIL_SEC, EMU_SHORT_MAX_DEFAULT, EMU_OVER_MAX_DEFAULT,' +
    ' EMU_DEPTH_MIN, EMU_DEPTH_MAX, EMU_STALL_PCT,' +
    ' emuNum, emuClamp, emuPct, emuDepth, emuRandSec, emuStallFactor, emuRoll, emuTarget, emuDescribe }'
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

test('emuPct и emuDepth зажимают мусор и границы', () => {
  assert.equal(api.emuPct(undefined, api.EMU_SHORT_DEFAULT_PCT), api.EMU_SHORT_DEFAULT_PCT)
  assert.equal(api.emuPct('мусор', 7), 7)
  assert.equal(api.emuPct(-5, 7), 0)
  assert.equal(api.emuPct(500, 7), api.EMU_PCT_CEIL)
  assert.equal(api.emuDepth(undefined, api.EMU_SHORT_MAX_DEFAULT), api.EMU_SHORT_MAX_DEFAULT)
  assert.equal(api.emuDepth(0, 3), api.EMU_DEPTH_MIN)
  assert.equal(api.emuDepth(1000, 2), api.EMU_DEPTH_MAX)
  // Глубина всегда целая — иначе Math.floor(r()*дробь) давал бы плавающий сдвиг.
  assert.equal(api.emuDepth(2.6, 3), 3)
})

test('emuRoll: 0 % у обоих — без отклонений, 100 % — всегда отклонение', () => {
  assert.equal(api.emuRoll(0, 0, () => 0), null)
  assert.equal(api.emuRoll(0, 0, () => 0.5), null)
  assert.equal(api.emuRoll(100, 0, () => 0.1), 'short')
  assert.equal(api.emuRoll(0, 100, () => 0.1), 'over')
  assert.equal(api.emuRoll(100, 100, () => 0.1), 'short')
  // Ниже порога — как будто отклонений нет.
  assert.equal(api.emuRoll(3, 3, () => 0.99), null)
})

test('частоты недостачи и излишка независимы', () => {
  let short = 0
  let over = 0
  for (let i = 0; i < 40000; i++) {
    const dev = api.emuRoll(1, 1)
    if (dev === 'short') short++
    if (dev === 'over') over++
  }
  const shortPct = (short / 40000) * 100
  const overPct = (over / 40000) * 100
  assert.ok(shortPct > 0.9 && shortPct < 1.1, 'доля недостачи ' + shortPct.toFixed(2) + ' %, ожидалось ~1 %')
  assert.ok(overPct > 0.85 && overPct < 1.05, 'доля излишка ' + overPct.toFixed(2) + ' %, ожидалось ~1 %')
  // Ноль у одного вида не выключает другой.
  let onlyOver = 0
  for (let i = 0; i < 20000; i++) {
    if (api.emuRoll(0, 2) === 'over') onlyOver++
  }
  const onlyOverPct = (onlyOver / 20000) * 100
  assert.ok(onlyOverPct > 1.8 && onlyOverPct < 2.2, 'доля излишка ' + onlyOverPct.toFixed(2) + ' %, ожидалось ~2 %')
})

test('emuTarget: без отклонения — весь остаток', () => {
  assert.equal(api.emuTarget(7, null), 7)
  assert.equal(api.emuTarget(7, null, 3, () => 0), 7)
  assert.equal(api.emuTarget(0, null), 0)
  assert.equal(api.emuTarget(-3, null), 0)
})

test('emuTarget: недостача — минус 1..глубина, излишек — плюс 1..глубина', () => {
  assert.equal(api.emuTarget(7, 'short', 3, () => 0), 6)
  assert.equal(api.emuTarget(7, 'short', 3, () => 0.99), 4)
  assert.equal(api.emuTarget(7, 'over', 2, () => 0), 8)
  assert.equal(api.emuTarget(7, 'over', 2, () => 0.99), 9)
  // Остаток меньше самой недостачи — уходим в ноль, а не в минус.
  assert.equal(api.emuTarget(2, 'short', 3, () => 0.5), 0)
  assert.equal(api.emuTarget(1, 'short', 3, () => 0), 0)
})

test('глубина отклонения настраивается отдельно для каждого вида', () => {
  assert.equal(api.emuTarget(10, 'short', 1, () => 0.99), 9)
  assert.equal(api.emuTarget(10, 'short', 5, () => 0.99), 5)
  assert.equal(api.emuTarget(10, 'over', 1, () => 0.99), 11)
  assert.equal(api.emuTarget(10, 'over', 5, () => 0.99), 15)
  // Ноль в настройке поднимается до минимума (отклонение в 0 единиц не бывает),
  // а мусор берёт дефолт — настройка не может тихо отключить отклонения.
  assert.equal(api.emuTarget(10, 'short', 0, () => 0.99), 10 - 1)
  assert.equal(api.emuTarget(10, 'over', 'мусор', () => 0.99), 10 + api.EMU_OVER_MAX_DEFAULT)
})

test('emuDescribe собирает итоги и молчит, когда отклонений не было', () => {
  assert.equal(api.emuDescribe({ short: 0, over: 0 }), '')
  assert.equal(api.emuDescribe(null), '')
  assert.equal(api.emuDescribe({ short: 1, over: 3 }), 'недостача: 1, излишек: 3')
})

test('модельный прогон: план сходится с остатками в границах отклонений', () => {
  const rows = []
  for (let i = 0; i < 300; i++) rows.push({ sku: 'SKU-' + i, qty: 4, counted: 1 })
  const deviations = { short: 0, over: 0 }
  let planned = 0
  let real = 0
  for (const row of rows) {
    const remaining = Math.max(0, row.qty - row.counted)
    const dev = api.emuRoll(3, 3)
    if (dev) deviations[dev]++
    planned += api.emuTarget(remaining, dev, dev === 'over' ? api.EMU_OVER_MAX_DEFAULT : api.EMU_SHORT_MAX_DEFAULT)
    real += remaining
  }
  const totalDev = deviations.short + deviations.over
  assert.ok(totalDev > 0, 'на 300 позициях при 3 % отклонения должны случиться')
  // Недостача стоит до 3 единиц позиции, излишек добавляет до 2.
  assert.ok(planned >= real - deviations.short * api.EMU_SHORT_MAX_DEFAULT)
  assert.ok(planned <= real + deviations.over * api.EMU_OVER_MAX_DEFAULT)
  assert.equal(api.emuDescribe(deviations) !== '', true)
})