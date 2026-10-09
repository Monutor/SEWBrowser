// core.js — чистая логика таймера опроса заданий (без DOM и chrome).
// Склеивается loader'ом ПЕРЕД tasks-notify.js (manifest.renderer), поэтому
// функции становятся глобальными — отсюда префикс tn. Только var/function:
// файл склеивается с другими, const/let на верхнем уровне запрещены.

// Ниже этого порога SEW-запросы бесполезно часты, а выше — «уведомление
// придёт через полчаса». Те же границы, что в панели настроек.
var TN_INTERVAL_MIN_SEC = 15
var TN_INTERVAL_DEFAULT_SEC = 60

/**
 * Нормализация периода опроса, сек. Мусор и значения ниже порога → дефолт.
 * Вынесено из __tnGetSettings, потому что тем же правилом пользуется сверка
 * «изменился ли период» при переarm'е.
 */
function tnIntervalSec(value) {
  var n = typeof value === 'number' ? value : parseFloat(String(value === undefined || value === null ? '' : value).replace(',', '.'))
  if (!isFinite(n) || n < TN_INTERVAL_MIN_SEC) return TN_INTERVAL_DEFAULT_SEC
  return Math.floor(n)
}

/**
 * Сменился ли период, из-за чего нужно переставить таймер.
 * currentSec — период, реально стоящий на таймере (0 — таймера ещё нет),
 * nextSec — что пришло из настроек.
 * Первый запуск всегда даёт true. Одинаковый период таймер не трогает: arm
 * зовётся оболочкой каждые 5–15 с, и пересоздание на каждом опросе
 * сбрасывало бы отсчёт — опрос до утра не наступил бы.
 */
function tnIntervalChanged(currentSec, nextSec) {
  if (typeof currentSec !== 'number' || !isFinite(currentSec) || currentSec <= 0) return true
  return currentSec !== tnIntervalSec(nextSec)
}
