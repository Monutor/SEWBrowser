import { activeTab, activeView, canTabGoBack, canTabGoForward } from './tabs'
import type { AddressMenuController } from './address-menu'
import { hostOf, normalizeUrl } from './util'
import { setStatus } from './status-ui'

/** DOM-элементы, которые ну��ны модулю. Передаются один раз из main. */
export interface AddressBarElements {
  address: HTMLInputElement | null
  titlebarTitle: HTMLElement | null
  back: HTMLElement | null
  forward: HTMLElement | null
}

export interface AddressBarDeps {
  /** Проверка allowlist (обёртка в main над чистой isAllowed из util). */
  isAllowed(url: string): boolean
  /** Текущий конфиг оболочки; null до init — тогда зум не трогаем. */
  config(): ShellConfig | null
  /** Сохранить карту зумов и обновить конфиг в main. */
  setZoomConfig(zoom: Record<string, number>): Promise<void>
  /** Меню «⋮» нужно для syncZoom; собирается позже, чем сам модуль. */
  getAddressMenu(): AddressMenuController | null
}

let elements: AddressBarElements = {
  address: null,
  titlebarTitle: null,
  back: null,
  forward: null,
}
let deps: AddressBarDeps

/**
 * Единственная точка сборки модуля: main отдаёт элементы и зависимости.
 * Всё остальное — чистые функции, которые можно звать сразу после init.
 */
export function initAddressBar(el: AddressBarElements, d: AddressBarDeps): void {
  elements = el
  deps = d
}

export function updateAddressBar(): void {
  if (!elements.address) return
  const view = activeView()
  if (!view) return
  try {
    elements.address.value = view.getURL() ?? ''
  } catch {
    // webview ещё не готов — игнорируем
  }
}

/** Заголовок активной страницы по центру titlebar (как в макете). */
export function updateTitlebarTitle(): void {
  if (!elements.titlebarTitle) return
  const tab = activeTab()
  elements.titlebarTitle.textContent = tab ? tab.title : ''
}

/**
 * Тусклые «назад/вперёд», когда переходить некуда. У <webview> нет canGoBack,
 * поэтому состояние ведём сами: переход назад/вперёд включает одну сторону,
 * обычная навигация включает «назад» и гасит «вперёд».
 */
export function updateNavButtons(): void {
  const tab = activeTab()
  if (elements.back) elements.back.classList.toggle('nav-off', !tab || !canTabGoBack(tab))
  if (elements.forward) elements.forward.classList.toggle('nav-off', !tab || !canTabGoForward(tab))
}

export async function navigate(url: string): Promise<void> {
  const target = normalizeUrl(url)
  if (!target) return
  if (deps.isAllowed(target)) {
    const view = activeView()
    if (!view) return
    try {
      await view.loadURL(target)
    } catch (err) {
      console.warn('[shell] loadURL failed:', err)
    }
  } else {
    setStatus('blocked by allowlist')
  }
}

// ---------- Зум ----------

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function nearestZoomIndex(factor: number): number {
  let best = 0
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[best] - factor)) best = i
  }
  return best
}

/** Применяет запомненный для текущего хоста зум (вызывается при навигации) */
export function applyZoomForCurrentPage(): void {
  const config = deps.config()
  if (!config) return
  const view = activeView()
  if (!view) return
  try {
    const host = hostOf(view.getURL() ?? '')
    const factor = (host && config.zoom[host]) || 1
    view.setZoomFactor(factor)
    deps.getAddressMenu()?.syncZoom(factor)
  } catch {
    // webview ещё не готов — применится при следующей навигации
  }
}

export async function changeZoom(dir: 1 | -1 | 'reset'): Promise<void> {
  const config = deps.config()
  if (!config) return
  const view = activeView()
  if (!view) return
  let current = 1
  try {
    current = view.getZoomFactor()
  } catch {
    // страница не готова — нечего масштабировать
    return
  }
  const next =
    dir === 'reset'
      ? 1
      : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, nearestZoomIndex(current) + dir))]
  try {
    view.setZoomFactor(next)
  } catch {
    return
  }
  deps.getAddressMenu()?.syncZoom(next)
  const host = hostOf(view.getURL() ?? '')
  if (host) {
    config.zoom[host] = Math.round(next * 100) / 100
    try {
      await deps.setZoomConfig(config.zoom)
    } catch (err) {
      console.warn('[shell] failed to persist zoom:', err)
    }
  }
  setStatus(`${Math.round(next * 100)}%`)
}
