import { activeTab } from './tabs'
import { guestJS } from './guest'
import { setStatus } from './status-ui'
import { parseGuestFlag } from './inventory-core'
import { scansToggleTitle } from './scans-core'
import { isGuestReady } from './tab-events'

/**
 * Кнопка-тумблер «Сканы» в тулбаре: показывает и прячет плавающий блок плагина
 * `scans-block` на активной вкладке.
 *
 * Блок живёт в госте и стартует скрытым (features/scans-block/block.js,
 * `window.__sewScans.setVisible`). Состояние, в отличие от «Автоподсчёта»,
 * общее для всех вкладок SEW — оно лежит в localStorage гостя, поэтому кэш
 * здесь один, а не Map по вкладкам.
 *
 * Правда — в госте: `isVisible` перечитываем при смене вкладки и после
 * перезагрузки гостя, а локальный кэш нужен, чтобы кнопка не мигала между
 * ответами. IIFE заканчивается `()()` — ловушка 17: результат
 * executeJavaScript обязан быть structured-cloneable, поэтому отдаём строку.
 */

const CODE_IS_VISIBLE =
  '(function(){var a=window.__sewScans;return a&&a.isVisible?String(a.isVisible()?1:0):"?"})()'
const CODE_TOGGLE =
  '(function(){var a=window.__sewScans;return a&&a.toggle?String(a.toggle()?1:0):"?"})()'

const PLUGIN_OFF = 'Плагин «Сканы» выключен в настройках'

let button: HTMLButtonElement | null = null
let lastVisible = false

/** Гость не ответил (плагина нет) — тусклая кнопка с пояснением в подсказке. */
function paint(on: boolean, answered: boolean): void {
  if (!button) return
  const live = answered && on
  button.classList.toggle('panel-on', live)
  button.classList.toggle('nav-off', !answered)
  button.setAttribute('aria-pressed', live ? 'true' : 'false')
  button.title = answered ? scansToggleTitle(on) : PLUGIN_OFF
}

/** Клик по тумблеру: гость сам инвертирует и вернёт новое состояние. */
async function toggleActive(): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  if (!tab.loaded) {
    setStatus('вкладка ещё загружается')
    return
  }
  try {
    const visible = parseGuestFlag(await guestJS<string>(tab, 'scans-toggle', CODE_TOGGLE))
    if (visible === null) {
      console.warn('[scans-toggle] гость не ответил:', PLUGIN_OFF)
      paint(false, false)
      setStatus(PLUGIN_OFF)
      return
    }
    // Состояние общее для всех вкладок гостя — рисуем сразу, даже если за время
    // ответа переключились: следующий refresh уточнит.
    lastVisible = visible
    paint(visible, true)
  } catch (err) {
    console.warn('[scans-toggle] не удалось переключить блок:', err)
  }
}

/**
 * Синхронизировать кнопку с активной вкладкой. Ставит кэш сразу, потом уточняет
 * его ответом гостя — вызывается при каждой активации вкладки.
 */
export async function refreshScansToggle(): Promise<void> {
  if (!button) return
  const tab = activeTab()
  if (!tab) {
    paint(false, false)
    return
  }
  paint(lastVisible, true)
  // Ленивая вкладка: гостя ещё нет — состояние узнаем при следующей активации
  // или клике, кнопка остаётся кликабельной (клик скажет «загружается»).
  if (!tab.loaded) {
    paint(false, false)
    return
  }
  // Гость ещё не прошёл dom-ready (вкладка только что открыта, переключились на
  // грузящуюся или восстановили выгруженную) — executeJavaScript бросил бы
  // «The WebView must be attached to the DOM…». Состояние уточним при следующей
  // активации или после перезагрузки гостя.
  if (!isGuestReady(tab.view)) {
    paint(lastVisible, false)
    return
  }
  try {
    const visible = parseGuestFlag(await guestJS<string>(tab, 'scans-vis', CODE_IS_VISIBLE))
    if (visible === null) {
      paint(lastVisible, false)
      return
    }
    lastVisible = visible
    paint(visible, true)
  } catch (err) {
    console.warn('[scans-vis] не удалось прочитать состояние блока:', err)
  }
}

/**
 * Гость перезагрузился. Состояние блока живёт в его localStorage, поэтому при
 * перезагрузке оно НЕ меняется — заново читать нечего, и читать сразу после
 * `did-finish-load` вредно: плагин ещё не инъецирован, гость ответит «?» и
 * кнопка на секунду станет «плагина нет». Просто возвращаем кэш на место.
 * Звонок из tab-events на did-finish-load.
 */
export function resetScansToggle(): void {
  paint(lastVisible, true)
}

export function wireScansToggle(): void {
  button = document.getElementById('btn-scans') as HTMLButtonElement | null
  if (!button) return
  button.addEventListener('click', () => void toggleActive())
  void refreshScansToggle()
}
