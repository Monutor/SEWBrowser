import {
  activeTab,
  activeView,
  isActiveTab,
  isSplit,
  noteTabNavigated,
  openTab,
  setSplitFocus,
  setTabFavicon,
  setTabGuestId,
  setTabTitle,
  setTabUrl,
  splitPaneOf,
  type ShellTab,
} from './tabs'
import { extractNewTabUrls, hostOfTabUrl, normalizeFaviconUrl } from './tabs-core.ts'
import { LINK_HOOK, LINK_TAKE, guestJS, injectPlugins, isExternalProtocol } from './guest'
import { renderFindCount } from './findbar'
import { hideError, setStatus, showError } from './status-ui'
import { hostOf } from './util'

/**
 * События гостевого <webview> (favicon, навигация, allowlist, жизненный цикл
 * загрузки) и приём ссылок из перехваченных кликов.
 */
export interface TabEventsDeps {
  plugins(): PluginInfo[]
  isAllowed(url: string): boolean
  setLoginPrompted(value: boolean): void
  checkLoginForm(interactive: boolean): void
  updateTitlebarTitle(): void
  updateAddressBar(): void
  updateNavButtons(): void
  applyZoomForCurrentPage(): void
  updateActiveTab(): void
  /** Гость загрузился заново: состояние панели «Автоподсчёт ЛП» сброшено */
  resetInventoryToggle(tab: ShellTab): void
  /** Гость загрузился заново: кнопке «Сканы» возвращён кэш состояния */
  resetScansToggle(): void
}

let deps!: TabEventsDeps

function toolbarEl(): HTMLElement | null {
  return document.getElementById('toolbar') as HTMLElement | null
}

// Забор ссылок, перехваченных в гостевой странице (Ctrl+клик / средняя кнопка).
// Только активная вкладка: в фоне пользователь не кликает.
let linkIntakeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Вкладки, в которых гость подтвердил, что LINK_HOOK встал. Спецификация §8.2:
 * executeJavaScript дёргаем ТОЛЬКО после подтверждения, иначе опрос раз в
 * 400 мс бьёт IPC впустую (2.5 раза в секунду) на любой странице без хука —
 * в том числе до первой инъекции, на упавшей странице и на странице логина.
 * WeakSet по самому <webview>: запись уносится вместе с закрытой вкладкой,
 * ручная чистка не нужна.
 */
const linkHookReady = new WeakSet<SewWebViewElement>()

/**
 * Гости, в которых уже пришёл dom-ready. executeJavaScript до него бросает
 * «The WebView must be attached to the DOM…», поэтому проверку формы входа
 * запускаем только по готовым гостям — иначе переключение на ещё грузящуюся
 * вкладку засоряет консоль предупреждением. Снимается на новом документе
 * (did-navigate), как и linkHookReady.
 */
const guestReady = new WeakSet<SewWebViewElement>()

async function pumpLinkIntake(): Promise<boolean> {
  const view = activeView()
  if (!view) return false
  // Хук не подтверждён — в гостя не идём вообще.
  if (!linkHookReady.has(view)) return false
  let raw: unknown
  try {
    raw = await view.executeJavaScript(LINK_TAKE)
  } catch {
    return false
  }
  const urls = extractNewTabUrls(raw)
  for (const url of urls) {
    // Тот же выбор, что у оболочки для window.open: разрешённый http(s) —
    // вкладкой внутри, остальное — во внешнем браузере. Без этой развилки
    // не-allowlisted ссылка создавала бы вкладку, которая тут же отскочит
    // на lastAllowedUrl: хук уже сделал preventDefault, до навигации дело
    // не дошло, и ветка setWindowOpenHandler сюда не приходит.
    if (deps.isAllowed(url)) openTab(url)
    else {
      setStatus('открыто во внешнем приложении')
      void window.shell.openExternal(url)
    }
  }
  return urls.length > 0
}

export function startLinkIntake(): void {
  if (linkIntakeTimer !== null) return
  const tick = async (): Promise<void> => {
    let hadWork = false
    try {
      hadWork = await pumpLinkIntake()
    } catch {
      hadWork = false
    }
    linkIntakeTimer = setTimeout(tick, hadWork ? 100 : 400)
  }
  linkIntakeTimer = setTimeout(tick, 400)
}


/**
 * Оригинальная иконка сайта: читаем `<link rel="icon">` из гостя, картинку
 * забирает main (оболочка CORS не обойдёт) и отдаёт готовый data-URL.
 * Кэш по хосту: иконка у сайта одна, перерисовывать её на каждый did-navigate незачем.
 */
const FAVICON_CACHE_LIMIT = 200
const faviconCache = new Map<string, string>()

export async function loadTabFavicon(tab: ShellTab): Promise<void> {
  let href = ''
  let pageUrl = ''
  try {
    pageUrl = tab.view.getURL()
    // IIFE и строка на выходе: executeJavaScript клонирует значение результата
    href = (await guestJS<string>(
      tab,
      'favicon-href',
      '(function(){try{var l=document.querySelector(\'link[rel~="icon"]\');' +
        'return l && l.href ? String(l.href) : ""}catch(e){return ""}})()',
    )) ?? ''
  } catch {
    return
  }
  const src = normalizeFaviconUrl(href, pageUrl)
  if (!src) {
    setTabFavicon(tab, '')
    return
  }
  // Вклеенная сайтом картинка идёт в <img> без похода в main
  if (src.startsWith('data:')) {
    setTabFavicon(tab, src)
    return
  }
  const host = hostOfTabUrl(src) || src
  const cached = faviconCache.get(host)
  if (cached !== undefined) {
    setTabFavicon(tab, cached)
    return
  }
  try {
    const data = await window.shell.fetchFavicon(src)
    if (data) {
      if (faviconCache.size >= FAVICON_CACHE_LIMIT) faviconCache.clear()
      faviconCache.set(host, data)
    }
    setTabFavicon(tab, data ?? '')
  } catch {
    // иконка не критична — останется буквенный кружок
  }
}

// События конкретной вкладки. UI трогаем только у активной, инъекция плагинов — у всех.
export function wireTabEvents(tab: ShellTab): void {
  const view = tab.view
  // Клик по странице в разделённой панели переводит фокус на неё: от фокусной
  // панели зависят адресная строка, зум, поиск, печать и скриншот.
  view.addEventListener('mousedown', () => {
    if (!isSplit()) return
    const pane = splitPaneOf(tab)
    if (pane) setSplitFocus(pane)
  })
  view.addEventListener('dom-ready', () => {
    guestReady.add(view)
    // Привязка гостевого webContents для перехвата хоткеев внутри страницы.
    // id запоминаем вкладке: по нему оболочка публикует опросного хоста,
    // которому main не даёт троттлить таймеры.
    try {
      setTabGuestId(tab, view.getWebContentsId())
      window.shell.attachGuest(view.getWebContentsId())
    } catch (err) {
      console.warn('[shell] guest attach failed:', err)
    }
  })
  view.addEventListener('page-title-updated', (event) => {
    setTabTitle(tab, event.title)
    if (isActiveTab(tab)) deps.updateTitlebarTitle()
  })
  view.addEventListener('did-navigate', (event) => {
    // Новый документ = новое window → флаг готовности старого хука мёртв.
    // did-navigate-in-page сюда НЕ попадает (там тот же документ, хук жив).
    linkHookReady.delete(view)
    guestReady.delete(view)
    console.log('[shell] did-navigate:', event.url)
    if (deps.isAllowed(event.url)) {
      setTabUrl(tab, event.url)
      noteTabNavigated(tab)
      if (isActiveTab(tab)) {
        deps.updateAddressBar()
        deps.updateTitlebarTitle()
        deps.updateNavButtons()
        deps.applyZoomForCurrentPage()
        deps.updateActiveTab()
      }
    } else {
      // Показываем заблокированный хост — так проще дополнять allowlist
      const blocked = hostOf(event.url) || event.url
      if (isActiveTab(tab)) setStatus(`blocked: ${blocked}`)
      // Откатываемся на lastAllowedUrl, но только если он сам разрешён: вкладка,
      // открытая по не-allowlisted ссылке, иначе зациклится сама на себя
      // (did-navigate → bounce-back на тот же URL → did-navigate → …).
      const fallback = tab.lastAllowedUrl
      if (!fallback || !deps.isAllowed(fallback)) {
        if (isActiveTab(tab)) showError(`Хост ${blocked} не разрешён allowlist`)
        return
      }
      void view.loadURL(fallback).catch((err) => console.warn('[shell] bounce-back failed:', err))
    }
  })
  view.addEventListener('did-navigate-in-page', (event) => {
    setTabUrl(tab, event.url)
    if (isActiveTab(tab)) deps.updateAddressBar()
  })
  view.addEventListener('did-finish-load', () => {
    void injectPlugins(tab, deps.plugins())
    // Панель плагина в новом документе создаётся заново и стартует скрытой —
    // состояние, запомненное оболочкой до перезагрузки, протухло.
    deps.resetInventoryToggle(tab)
    // Блок «Сканы» пересоздаётся в новом документе, но его состояние лежит в
    // localStorage гостя и не меняется — просто возвращаем кнопке кэш (заново
    // читать нельзя: плагин ещё не инъецирован).
    deps.resetScansToggle()
    // Готовность хука — только ПОСЛЕ успешной инъекции: до подтверждения
    // pumpLinkIntake в гостя не ходит. Упала инъекция — не подтверждаем,
    // опрос просто не пойдёт (ретраи и таймауты не нужны).
    linkHookReady.delete(view)
    void view.executeJavaScript(LINK_HOOK).then(
      () => {
        linkHookReady.add(view)
      },
      () => {
        // страница могла закрыться или упасть — хук не критичен
      },
    )
    try {
      setTabTitle(tab, view.getTitle())
    } catch {
      // заголовок недоступен — останется хост
    }
    void loadTabFavicon(tab)
    if (isActiveTab(tab)) deps.updateTitlebarTitle()
    // Появилась форма входа? Предлагаем выбрать аккаунт (с паузой —
    // SPA достраивает форму уже после события загрузки)
    if (isActiveTab(tab)) setTimeout(() => void deps.checkLoginForm(false), 1200)
  })
  view.addEventListener('did-fail-load', (event) => {
    if (!event.isMainFrame) return
    // -3 (ERR_ABORTED) — прерванная загрузка, например откат allowlist; не ошибка
    if (event.errorCode === -3) return
    // Ссылки на внешние приложения (mailto:, tel:) — открываем снаружи
    if (isExternalProtocol(event.url)) {
      if (isActiveTab(tab)) setStatus('открыто во внешнем приложении')
      void window.shell.openExternal(event.url)
      return
    }
    console.error('[shell] did-fail-load:', event.errorCode, event.errorDescription)
    if (!isActiveTab(tab)) return
    setStatus(`fail: ${event.errorDescription}`)
    showError(`${event.errorDescription} (код ${event.errorCode})`)
  })
  view.addEventListener('did-start-loading', () => {
    // loginPrompted сбрасываем всем вкладкам: предложение выбрать аккаунт общее
    // для оболочки, и форма могла появиться в фоновой вкладке.
    deps.setLoginPrompted(false)
    if (!isActiveTab(tab)) return
    hideError()
    toolbarEl()?.classList.add('loading')
  })
  view.addEventListener('did-stop-loading', () => {
    if (!isActiveTab(tab)) return
    toolbarEl()?.classList.remove('loading')
  })
  view.addEventListener('found-in-page', (event) => {
    if (!isActiveTab(tab)) return
    const result = event.result
    if (!result.finalUpdate) return
    renderFindCount(result.matches, result.activeMatchOrdinal)
  })
}

/** Гость загрузился до dom-ready - executeJavaScript в него уже можно. */
export function isGuestReady(view: SewWebViewElement): boolean {
  return guestReady.has(view)
}

/**
 * Забыть, что webview когда-то был готов: вызывается при выгрузке гостя по
 * бюджету. Новый гость получит те же флаги заново на dom-ready/did-finish-load.
 */
export function resetViewFlags(view: SewWebViewElement): void {
  linkHookReady.delete(view)
  guestReady.delete(view)
}

/** Передать зависимости оболочки. Обязательно до wireTabEvents/startLinkIntake. */
export function initTabEvents(next: TabEventsDeps): void {
  deps = next
}
