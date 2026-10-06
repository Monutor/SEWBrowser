import { activeTab, type ShellTab } from './tabs'
import { guestJS } from './guest'
import { setStatus } from './status-ui'
import { parseGuestFlag, toggleTitle } from './inventory-core'
import { isGuestReady } from './tab-events'

/**
 * Кнопка-тумблер «Автоподсчёт ЛП» в тулбаре: показывает и прячет плавающую
 * панель плагина `sew-inventory` на активной вкладке.
 *
 * Панель живёт в госте и стартует скрытой (features/sew-inventory/main.js,
 * `window.__sewInventory.setVisible`). У вкладки своё состояние: открытая на
 * одной вкладке панель на другой не появляется.
 *
 * Правда — в госте: ответы на `isVisible` читаем при смене вкладки, а `Map`
 * держит последнее известное значение, чтобы кнопка не мигала между ответами.
 * IIFE заканчивается `()()` — ловушка 17: результат executeJavaScript обязан быть
 * structured-cloneable, поэтому отдаём строку '1'/'0'/'?'.
 */

const CODE_IS_VISIBLE =
  '(function(){var a=window.__sewInventory;return a&&a.isVisible?String(a.isVisible()?1:0):"?"})()'
const CODE_TOGGLE =
  '(function(){var a=window.__sewInventory;return a&&a.toggle?String(a.toggle()?1:0):"?"})()'

const PLUGIN_OFF = 'Плагин «Автоподсчёт ЛП» выключен в настройках'

let button: HTMLButtonElement | null = null
const visibleByTab = new Map<number, boolean>()

/** Гость не ответил (плагина нет) — тусклая кнопка с пояснением в подсказке. */
function paint(on: boolean, answered: boolean): void {
  if (!button) return
  const live = answered && on
  button.classList.toggle('panel-on', live)
  button.classList.toggle('nav-off', !answered)
  button.setAttribute('aria-pressed', live ? 'true' : 'false')
  button.title = answered ? toggleTitle(on) : PLUGIN_OFF
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
    const visible = parseGuestFlag(await guestJS<string>(tab, 'inventory-toggle', CODE_TOGGLE))
    if (visible === null) {
      console.warn('[inventory-toggle] гость не ответил:', PLUGIN_OFF)
      paint(false, false)
      setStatus(PLUGIN_OFF)
      return
    }
    if (tab.id !== activeTab()?.id) return
    visibleByTab.set(tab.id, visible)
    paint(visible, true)
  } catch (err) {
    console.warn('[inventory-toggle] не удалось переключить панель:', err)
  }
}

/**
 * Синхронизировать кнопку с активной вкладкой. Ставит кэш сразу, потом уточняет
 * его ответом гостя — вызывается при каждой активации вкладки.
 */
export async function refreshInventoryToggle(): Promise<void> {
  const tab = activeTab()
  if (!button) return
  if (!tab) {
    paint(false, false)
    return
  }
  const cached = visibleByTab.get(tab.id) ?? false
  paint(cached, true)
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
    paint(cached, false)
    return
  }
  try {
    const visible = parseGuestFlag(await guestJS<string>(tab, 'inventory-vis', CODE_IS_VISIBLE))
    if (visible === null) {
      paint(cached, false)
      return
    }
    visibleByTab.set(tab.id, visible)
    // За время ответа могли переключиться — тогда рисует следующий refresh.
    if (tab.id === activeTab()?.id) paint(visible, true)
  } catch (err) {
    console.warn('[inventory-vis] не удалось прочитать состояние панели:', err)
  }
}

/**
 * Гость перезагрузился: панель в нём создаётся заново и стартует скрытой, кэш
 * оболочки протух. Звонок из tab-events на did-finish-load.
 */
export function resetInventoryToggle(tab: ShellTab): void {
  visibleByTab.set(tab.id, false)
  if (tab.id === activeTab()?.id) paint(false, true)
}

/** Вкладка закрыта — забываем её состояние. */
export function dropInventoryToggle(tabId: number): void {
  visibleByTab.delete(tabId)
}

export function wireInventoryToggle(): void {
  button = document.getElementById('btn-inventory') as HTMLButtonElement | null
  if (!button) return
  button.addEventListener('click', () => void toggleActive())
  void refreshInventoryToggle()
}