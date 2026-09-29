import { BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHROME_SHIM } from '../shared/chrome-shim'
import { bffFetch } from './bff'
import { getConfig } from './config'
import { loadPlugins } from './plugins/loader'
import { getPluginData } from './plugins/store'

/**
 * «Открыть вкладку в новом окне» (Ctrl+ЛКМ по вкладке или пункт контекстного
 * меню). Это НЕ второе окно оболочки: отдельный BrowserWindow грузит страницу
 * напрямую, без тулбара, ленты и полосы вкладок. Зато в нём работают плагины
 * (sew-helper и прочие) — код и CSS инжектятся тем же способом, что и в
 * <webview>-вкладку, только со стороны main.
 *
 * preload здесь принципиально нет: страница удалённая, а window.shell дал бы
 * ей доступ к credentials/кукам/конфигу. Данные плагинов кладём в страницу
 * снимком (window.__shellPluginStores) — ровно как делает renderer для гостя.
 */

/** Насос BFF: задержка между тиками, как у renderer-моста (bridges.ts). */
const BFF_ACTIVE_MS = 500
const BFF_MAX_MS = 2000
/** Максимум «страничных» окон одновременно — иначе Ctrl+ЛКМ спавнит их пачками. */
const MAX_PAGE_WINDOWS = 8

const openWindows = new Set<BrowserWindow>()

/** Забрать очередь BFF-запросов из страницы. IIFE обязана звать себя: `()()`. */
const BFF_TAKE = `(function(){try{var q=window.__sewHelperBffReq;if(!Array.isArray(q))return "[]";try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()`

/** Положить ответ BFF в страницу. Результат — structured-cloneable. */
function bffWrite(id: string, payload: unknown): string {
  return (
    '(function(id,payload){try{(window.__sewHelperBffRes = window.__sewHelperBffRes || {})[id]=payload;return true}catch(e){return false}})' +
    '(' +
    JSON.stringify(id) +
    ',' +
    JSON.stringify(payload) +
    ')'
  )
}

/** Снапшот данных всех включённых плагинов (то же, что шлёт renderer гостю). */
function pluginStoresSnapshot(): Record<string, Record<string, unknown>> {
  const snapshot: Record<string, Record<string, unknown>> = {}
  for (const plugin of loadPlugins(getConfig())) {
    snapshot[plugin.name] = getPluginData(plugin.name)
  }
  return snapshot
}

/** Код одного плагина в IIFE с его собственным `chrome` (как в renderer, guest.ts). */
function pluginScript(name: string, code: string): string {
  const key = JSON.stringify(name)
  return (
    `window.__shellPluginName = ${key};` +
    `window.__shellPlugins = window.__shellPlugins || {};` +
    `window.__shellPluginError = window.__shellPluginError || {};` +
    `if (!window.__shellPlugins[${key}]) {` +
    `window.__shellPlugins[${key}] = 1;\n(() => {\nconst chrome = window.__shellChromeFor(${key});\ntry {\n${code}\n} catch (e) {\nwindow.__shellPluginError[${key}] = String((e && e.stack) || e);\nconsole.error('[shell-plugin:' + ${key} + ']', e);\n}\n})();`
  )
}

/** Инжект плагинов в загруженную страницу окна. */
async function injectPlugins(win: BrowserWindow): Promise<void> {
  const wc = win.webContents
  const plugins = loadPlugins(getConfig())
  // Снапшот данных плагинов — до кода, чтобы первые чтения видели значения.
  // Опросным хостом это окно НЕ является: уведомления о заданиях идут из
  // первой вкладки оболочки, иначе они придут дважды.
  await wc
    .executeJavaScript(
      `window.__shellPluginStores = ${JSON.stringify(pluginStoresSnapshot())};` +
        `window.__shellPollHost = false;`,
    )
    .catch(() => undefined)
  for (const plugin of plugins) {
    try {
      if (plugin.styles) await wc.insertCSS(plugin.styles)
    } catch (err) {
      console.warn(`[page-window:${plugin.name}] insertCSS failed:`, err)
    }
    if (!plugin.code) continue
    try {
      await wc.executeJavaScript(CHROME_SHIM)
      await wc.executeJavaScript(pluginScript(plugin.name, plugin.code))
      // init лежит в манифесте (loader его в LoadedPlugin не кладёт) — так же
      // его отдаёт renderer в PluginInfo.
      if (plugin.manifest.init) await wc.executeJavaScript(plugin.manifest.init)
    } catch (err) {
      console.warn(`[page-window:${plugin.name}] injection failed:`, err)
    }
  }
  await wc.executeJavaScript('window.__shellPluginName = null;').catch(() => undefined)
}

/**
 * Насос BFF-моста для окна: без него фичи sew-helper, ходящие на BFF mvideo,
 * висели бы по 30-секундному таймауту гостя.
 */
function startBffPump(win: BrowserWindow): void {
  // Насос нужен только sew-helper; проверка — один раз на окно (перечитывать
  // features/ с диска каждый тик нельзя). Включили плагин в настройках позже —
  // насос появится в следующем открытом окне.
  if (!loadPlugins(getConfig()).some((plugin) => plugin.name === 'sew-helper')) return
  let delay = 500
  let busy = false
  const tick = async (): Promise<void> => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    let hadWork = false
    if (!busy && win.isVisible()) {
      busy = true
      try {
        const raw = (await win.webContents.executeJavaScript(BFF_TAKE)) as unknown
        let reqs: Array<{ id: string; url: string }> = []
        try {
          const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : '[]')
          if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; url: string }>
        } catch {
          reqs = []
        }
        for (const req of reqs) {
          if (!req || typeof req.id !== 'string' || typeof req.url !== 'string') continue
          hadWork = true
          const res = await bffFetch(req.url)
          await win.webContents.executeJavaScript(bffWrite(req.id, res)).catch(() => undefined)
        }
      } catch {
        // страница могла уйти или быть перегружена — следующий тик повторит
      } finally {
        busy = false
      }
    }
    if (win.isDestroyed()) return
    const next = hadWork ? BFF_ACTIVE_MS : Math.min(BFF_MAX_MS, delay + 250)
    delay = next
    setTimeout(() => void tick(), next)
  }
  setTimeout(() => void tick(), 500)
}

export interface PageWindowDeps {
  /** Серверная копия allowlist-проверки (та же, что у гостевых вкладок). */
  isAllowed: (url: string) => boolean
}

/**
 * Открыть страницу в отдельном окне. Возвращает false, если URL не разрешён
 * или уже открыто максимум окон.
 */
export function openPageWindow(rawUrl: unknown, rawTitle: unknown, deps: PageWindowDeps): boolean {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!/^https?:/i.test(url)) return false
  if (!deps.isAllowed(url)) {
    console.warn('[page-window] nav blocked:', url.slice(0, 200))
    return false
  }
  if (openWindows.size >= MAX_PAGE_WINDOWS) {
    console.warn('[page-window] limit reached:', MAX_PAGE_WINDOWS)
    return false
  }

  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : url
  const devIcon = join(__dirname, '..', '..', 'resources', 'icon.png')
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title,
    icon: existsSync(devIcon) ? devIcon : undefined,
    webPreferences: {
      contextIsolation: true,
      // preload здесь не нужен и опасен: страница удалённая (см. шапку модуля).
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  openWindows.add(win)
  win.setMenu(null)
  win.on('closed', () => openWindows.delete(win))

  const denyBlocked = (event: Electron.Event, target: string): void => {
    if (!deps.isAllowed(target)) {
      event.preventDefault()
      console.log('[page-window] nav blocked:', target.slice(0, 200))
    }
  }
  win.webContents.on('will-navigate', denyBlocked)
  win.webContents.on('will-redirect', denyBlocked)
  // window.open из страницы: разрешённое — ещё одно такое же окно,
  // внешние схемы — системному приложению, остальное режем (как у гостя).
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const trimmed = target.trim()
    if (/^https?:/i.test(trimmed)) {
      if (deps.isAllowed(trimmed)) openPageWindow(trimmed, '', deps)
      else void shell.openExternal(trimmed)
    } else if (/^(mailto|tel):/i.test(trimmed)) {
      void shell.openExternal(trimmed)
    }
    return { action: 'deny' }
  })
  // Плагины — на каждой догрузке: SPA у SEW с редиректами SSO, и страница
  // после редиректа приходит заново (шим и код плагинов идемпотентны).
  win.webContents.on('did-finish-load', () => {
    void injectPlugins(win)
  })
  startBffPump(win)
  void win.loadURL(url).catch((err) => console.warn('[page-window] load failed:', err))
  return true
}
