// core.js — чистая логика «эмуляции человека» для автоподсчёта ЛП.
// Файл склеивается loader'ом ПЕРЕД main.js (manifest.renderer), поэтому функции
// оказываются в глобальной области гостевой страницы — отсюда префикс emu,
// чтобы не пересечься с именами из main.js. Никаких DOM и chrome здесь нет:
// только расчёты, их можно гонять в node (scripts/human-emu.mjs).
//
// Что считает:
//   - случайный темп одной единицы в диапазоне [мин, макс] — человек не
//     работает с одинаковой паузой между кликами;
//   - «зависание» — та же единица, но пауза в 2–3 раза длиннее (иногда человек
//     задумывается). Не настройка, а константа: убирается одним числом;
//   - отклонение по позиции: null (считаем как есть) / 'skip' (пропустить
//     позицию) / 'short' (недостача) / 'over' (излишек);
//   - сколько единиц плагин должен внести по позиции с учётом отклонения.

var EMU_TEMPO_MIN_SEC = 1
var EMU_TEMPO_MAX_SEC = 3
var EMU_ERROR_DEFAULT_PCT = 3

// Границы скорости как у обычного темпа: быстрее 0,4 с SEW не успевает принять
// ШК, а больше 10 с — уже не автовнос.
var EMU_SPEED_FLOOR_SEC = 0.4
var EMU_SPEED_CEIL_SEC = 10

// Насколько глубоко врезаемся: недостача 1–3 единицы, излишек 1–2.
var EMU_SHORT_MAX = 3
var EMU_OVER_MAX = 2

// Шанс «зависания» на одной позиции.
var EMU_STALL_PCT = 5
var EMU_STALL_FACTOR_MIN = 2
var EMU_STALL_FACTOR_MAX = 3

function emuNum(value, fallback) {
  var parsed = parseFloat(String(value === undefined || value === null ? '' : value).replace(',', '.'))
  return isFinite(parsed) ? parsed : fallback
}

function emuClamp(value, lo, hi) {
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}

/** Случайный темп одной единицы, секунды. Границы зажимаются и меняются местами. */
function emuRandSec(min, max, rnd) {
  var r = rnd || Math.random
  var a = emuClamp(emuNum(min, EMU_TEMPO_MIN_SEC), EMU_SPEED_FLOOR_SEC, EMU_SPEED_CEIL_SEC)
  var b = emuClamp(emuNum(max, EMU_TEMPO_MAX_SEC), EMU_SPEED_FLOOR_SEC, EMU_SPEED_CEIL_SEC)
  if (a > b) {
    var tmp = a
    a = b
    b = tmp
  }
  return a + (b - a) * r()
}

/**
 * Множитель паузы: 1 — обычная единица, 2–3 — человек завис на этой позиции.
 * Частота задаётся константой EMU_STALL_PCT, а не настройкой панели.
 */
function emuStallFactor(pct, rnd) {
  var r = rnd || Math.random
  var p = emuClamp(emuNum(pct, 0), 0, 100)
  if (p <= 0) return 1
  if (r() * 100 >= p) return 1
  return EMU_STALL_FACTOR_MIN + (EMU_STALL_FACTOR_MAX - EMU_STALL_FACTOR_MIN) * r()
}

/**
 * Тип отклонения для одной позиции: 'skip' | 'short' | 'over' | null.
 * Один бросок на позицию, а не на единицу: «частота ошибок, %» читается как
 * «доля позиций, посчитанных с расхождением». Типы — 50/25/25.
 */
function emuRoll(pct, rnd) {
  var r = rnd || Math.random
  var p = emuClamp(emuNum(pct, 0), 0, 100)
  if (p <= 0) return null
  if (r() * 100 >= p) return null
  var pick = r()
  if (pick < 0.5) return 'skip'
  if (pick < 0.75) return 'short'
  return 'over'
}

/**
 * Сколько единиц плагин должен внести по позиции. remaining — остаток минус
 * уже посчитанное в ЛП. dev === null — считаем всё, как без эмуляции.
 */
function emuTarget(remaining, dev, rnd) {
  var r = rnd || Math.random
  var base = Math.max(0, Math.round(emuNum(remaining, 0)))
  if (dev === 'skip') return 0
  if (dev === 'short') return Math.max(0, base - (1 + Math.floor(r() * EMU_SHORT_MAX)))
  if (dev === 'over') return base + 1 + Math.floor(r() * EMU_OVER_MAX)
  return base
}

/** Человекочитаемые итоги внедрённых отклонений для статус-бара. */
function emuDescribe(counts) {
  var src = counts && typeof counts === 'object' ? counts : {}
  var parts = []
  if (src.skip) parts.push('пропущено позиций: ' + src.skip)
  if (src.short) parts.push('недостача: ' + src.short)
  if (src.over) parts.push('излишек: ' + src.over)
  return parts.join(', ')
}