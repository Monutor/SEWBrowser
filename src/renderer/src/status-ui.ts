// Статусная строка, всплывающее уведомление и оверлей ошибки.
// Ссылки на DOM берутся лениво (внутри функций), а не на верхнем уровне.

import { activeTab, activeView } from './tabs'
import { guestJS } from './guest'

let toastTimer: ReturnType<typeof setTimeout> | null = null

const statusEl = (): HTMLElement | null => document.getElementById('status')
const toastEl = (): HTMLElement | null => document.getElementById('toast')
const errorText = (): HTMLElement | null => document.getElementById('error-text')
const errorOverlay = (): HTMLElement | null => document.getElementById('error-overlay')

/**
 * Статус пишется в настройки; разовые подсказки (toast=true) дополнительно
 * всплывают тостом справа внизу на 3.5 c. Технический счётчик (polling)
 * идёт с toast=false, чтобы не спамить.
 */
export function setStatus(text: string, toast = true): void {
  const status = statusEl()
  if (status) status.textContent = text
  if (!toast || !text) return
  const toastNode = toastEl()
  if (!toastNode) return
  toastNode.textContent = text
  toastNode.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    const node = toastEl()
    if (node) node.hidden = true
  }, 3500)
}

/** Прячет всплывающее уведомление и сбрасывает таймер. */
export function hideToast(): void {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
  const toastNode = toastEl()
  if (toastNode) toastNode.hidden = true
}

export function showError(text: string): void {
  const label = errorText()
  if (label) label.textContent = text
  const overlay = errorOverlay()
  if (overlay) overlay.hidden = false
}

export function hideError(): void {
  const overlay = errorOverlay()
  if (overlay) overlay.hidden = true
}

export function wireErrorOverlay(): void {
  document.getElementById('error-retry')?.addEventListener('click', () => {
    const view = activeView()
    if (!view) return
    hideError()
    view.reload()
  })
}

export interface StatusPollingDeps {
  config(): { debug?: boolean } | null
}

/**
 * Периодически пишет в статусную строку счётчик запросов гостевой страницы
 * (window.__sewDataLog). В режиме debug добавляет пометку. Страница может
 * быть ещё не готова — тогда такт просто пропускается.
 */
export function startStatusPolling(deps: StatusPollingDeps): void {
  setInterval(async () => {
    const tab = activeTab()
    if (!tab) return
    try {
      const count = await guestJS<unknown>(tab, 'datalog-count', '(window.__sewDataLog || []).length')
      setStatus(deps.config()?.debug ? `req: ${count} · debug` : `req: ${count}`, false)
    } catch {
      // страница ещё не готова — игнорируем
    }
  }, 2000)
}
