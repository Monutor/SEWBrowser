import './styles.css'
import { createTaskAlert, formatTaskAlertText, getTaskAlertUrls } from './task-alert'
import { createAddressMenu, type AddressMenuController } from './address-menu'
import { createShotPreview, type ShotPreviewController } from './shot-preview'
import {
  bytesToBase64,
  createPrintDialog,
  normalizePrintSettings,
  PRINT_PAPER_NAMES,
  printOptions,
  printToPdfOptions,
  suggestedPdfName,
  type PrintDialogController,
  type PrintDialogElements,
  type PrintDialogHooks,
} from './print-dialog'
import { openFind, closeFind, isFindActive, isFindInput, renderFindCount, wireFindbar } from './findbar'
import { wireUpdater, checkForUpdatesManually } from './updatebar'
import {
  createFolderPasswordPrompt,
  passwordPromptEl,
  type FolderPasswordPromptController,
} from './folder-prompt'
import {
  hostOfTabUrl,
  extractNewTabUrls,
  normalizeFaviconUrl,
} from './tabs-core.ts'
import {
  activeTab,
  activeView,
  canTabGoBack,
  canTabGoForward,
  closeTab,
  cycleTab,
  focusOrOpenTab,
  initTabs,
  isActiveTab,
  listTabs,
  noteTabHistory,
  noteTabNavigated,
  openTab,
  primaryTab,
  selectTabIndex,
  setTabFavicon,
  setTabTitle,
  setTabUrl,
  setSplitFocus,
  splitPaneOf,
  isSplit,
  unsplit,
  type ShellTab,
} from './tabs'

import { setStatus, hideToast, showError, hideError, wireErrorOverlay } from './status-ui'
import {
  injectPlugins,
  pushPluginStores,
  guestJS,
  isExternalProtocol,
  lastGuestErr,
  LINK_HOOK,
  LINK_TAKE,
} from './guest'
import { normalizeUrl, hostOf, isAllowed as isAllowedUrl, resolveTasksUrl, formatSize, errText, withTimeout, formatDateTime } from './util'

/**
 * Обёртки над чистыми функциями из util.ts: подставляют конфиг, чтобы в коде
 * не мериться allowlist-ом и базовым URL вручную в каждом месте.
 */
function isAllowed(url: string): boolean {
  return isAllowedUrl(url, config?.allowlist, config?.allowlistEnabled ?? false)
}

function tasksUrl(url: string): string {
  const base = activeView()?.getURL() || config?.startUrl || ''
  return resolveTasksUrl(url, base, config?.startUrl || '')
}

const addressInput = document.getElementById('address') as HTMLInputElement | null
/** Меню «⋮» в конце адресной строки; собирается в wireAddressMenu */
let addressMenu: AddressMenuController | null = null
/** Диалог печати; собирается в wirePrintDialog */
let printDialog: PrintDialogController | null = null
/** Превью снимка экрана; собирается в wireShotPreview */
let shotPreview: ShotPreviewController | null = null
/** Диалог пароля защищённой папки; собирается в init */
let folderPrompt: FolderPasswordPromptController | null = null

/** Пароль папки: null при отмене или если контроллер ещё не собран. */
function promptFolderPassword(folderId: string): Promise<string | null> {
  return folderPrompt ? folderPrompt.prompt(folderId) : Promise.resolve(null)
}

/** Разрешить операцию с защищённой папкой; false — пароль не введён. */
function requireFolderPassword(folderId: string): Promise<boolean> {
  return folderPrompt ? folderPrompt.require(folderId) : Promise.resolve(false)
}

/** Скрыть диалог ввода пароля, разрешив промис как «отмена». */
function cancelFolderPasswordPrompt(): void {
  folderPrompt?.cancel()
}
/** Debounce пересчёта превью печати (250 мс) */
let printRefreshTimer: number | null = null
/** Последний список принтеров от main — нужен строке «Принтер» диалога */
let printPrinters: ShellPrinter[] = []
/** Синхронизация нашей части диалога (строка принтера + список бумаги).
 *  Замыкание из wirePrintDialog: контроллер эти куски не ведёт, а держит
 *  только скрытость строки, поэтому звать его приходится из openPrintDialog */
let printPanelSync: (() => void) | null = null
/** Вкладка, снятая при открытии диалога. Хоткеи висят на window, поэтому
 *  Ctrl+Tab/Ctrl+3 переводит активную вкладку, пока печать открыта: без
 *  фиксации цели превью, системная печать и имя PDF уехали бы на чужой документ */
let printTargetView: SewWebViewElement | null = null
const titlebarTitle = document.getElementById('titlebar-title') as HTMLElement | null
const btnBack = document.getElementById('btn-back') as HTMLButtonElement | null
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement | null
const statusEl = document.getElementById('status') as HTMLElement | null
const toastEl = document.getElementById('toast') as HTMLElement | null
const taskAlertRoot = document.getElementById('task-alert') as HTMLElement | null
const taskAlertTitle = document.getElementById('task-alert-title') as HTMLElement | null
const taskAlertText = document.getElementById('task-alert-text') as HTMLElement | null
const taskAlertOpen = document.getElementById('task-alert-open') as HTMLButtonElement | null
const taskAlertAll = document.getElementById('task-alert-all') as HTMLButtonElement | null
const taskAlertClose = document.getElementById('task-alert-close') as HTMLButtonElement | null
const taskAlert = taskAlertRoot && taskAlertTitle && taskAlertText && taskAlertOpen && taskAlertAll && taskAlertClose
  ? createTaskAlert({
      root: taskAlertRoot,
      title: taskAlertTitle,
      text: taskAlertText,
      open: taskAlertOpen,
      all: taskAlertAll,
      close: taskAlertClose,
    })
  : null
const toolbar = document.getElementById('toolbar') as HTMLElement | null


// Оверлей ошибки сети
const errorOverlay = document.getElementById('error-overlay') as HTMLElement | null
const errorText = document.getElementById('error-text') as HTMLElement | null

// Настройки
const settingsOverlay = document.getElementById('settings-overlay') as HTMLElement | null
const setStartUrl = document.getElementById('set-starturl') as HTMLInputElement | null
const setAllowlistEnabled = document.getElementById('set-allowlist-enabled') as HTMLInputElement | null
const setAllowlist = document.getElementById('set-allowlist') as HTMLTextAreaElement | null
const setPlugins = document.getElementById('set-plugins') as HTMLElement | null
const setTnObjectId = document.getElementById('set-tn-objectid') as HTMLInputElement | null
const setTnInterval = document.getElementById('set-tn-interval') as HTMLInputElement | null
const setTnAlertTtl = document.getElementById('set-tn-alert-ttl') as HTMLInputElement | null
const setTnSound = document.getElementById('set-tn-sound') as HTMLInputElement | null
const setTnSoundName = document.getElementById('set-tn-sound-name') as HTMLElement | null
const setTnSoundHoName = document.getElementById('set-tn-sound-ho-name') as HTMLElement | null
const setStorageUsage = document.getElementById('set-storage-usage') as HTMLElement | null
const setCookies = document.getElementById('set-cookies') as HTMLElement | null
const setClearOnExit = document.getElementById('set-clear-on-exit') as HTMLSelectElement | null
const setScannerApp = document.getElementById('set-scanner-app') as HTMLInputElement | null
const setScannerArgs = document.getElementById('set-scanner-args') as HTMLInputElement | null
const setScannerAppBrowse = document.getElementById('set-scanner-app-browse') as HTMLButtonElement | null
const setScanFolderAdd = document.getElementById('set-scan-folder-add') as HTMLButtonElement | null
const setScanFoldersList = document.getElementById('set-scan-folders') as HTMLElement | null

// Загрузки
const downloadsEl = document.getElementById('downloads') as HTMLElement | null
const downloadsOverlay = document.getElementById('downloads-overlay') as HTMLElement | null
const downloadsHistory = document.getElementById('downloads-history') as HTMLElement | null
const downloadsFilter = document.getElementById('downloads-filter') as HTMLSelectElement | null
let downloadsOpen = false
let downloadsRecords: DownloadedFile[] = []

const templatesOverlay = document.getElementById('templates-overlay') as HTMLElement | null
const templatesList = document.getElementById('templates-list') as HTMLElement | null
const templatesManageOverlay = document.getElementById('templates-manage-overlay') as HTMLElement | null
let templatesOpen = false
let templatesManageOpen = false

// Вкладки навигации
const tabstrip = document.getElementById('tabstrip') as HTMLElement | null
const tabsEl = document.getElementById('tabs') as HTMLElement | null
const tabGroupPanel = document.getElementById('tab-group-panel') as HTMLElement | null
const tabsOverlay = document.getElementById('tabs-overlay') as HTMLElement | null
const tabsList = document.getElementById('tabs-list') as HTMLElement | null
const tabForm = document.getElementById('tab-form') as HTMLElement | null
const tabNameInput = document.getElementById('tab-name') as HTMLInputElement | null
const tabUrlInput = document.getElementById('tab-url') as HTMLInputElement | null
const tabsExport = document.getElementById('tabs-export') as HTMLElement | null
const tabsImport = document.getElementById('tabs-import') as HTMLElement | null
const tabsImportFile = document.getElementById('tabs-import-file') as HTMLInputElement | null
const folderForm = document.getElementById('folder-form') as HTMLElement | null
const folderNameInput = document.getElementById('folder-name') as HTMLInputElement | null
const folderProtect = document.getElementById('folder-protect') as HTMLInputElement | null
const folderPassword = document.getElementById('folder-password') as HTMLInputElement | null
const folderPwdField = document.getElementById('folder-pwd-field') as HTMLElement | null
const tabFolderSelect = document.getElementById('tab-folder') as HTMLSelectElement | null
let editingTabId: string | null = null
let editingFolderId: string | null = null
/** ID папок, свёрнутых в оверлее (sentinel UNASSIGNED_FOLDER — «без папки»). */
const collapsedFolders = new Set<string>()
/** ID папки, развёрнутой списком под лентой (по одному). null — все свёрнуты. */
let expandedGroupId: string | null = null
/** Обработчик клика вне выпадающего списка папки; удерживается для снятия. */
let panelOutsideHandler: ((event: MouseEvent) => void) | null = null
let tabsOpen = false

let config: ShellConfig | null = null
let plugins: PluginInfo[] = []
/** Все плагины (включая выключенные) — для настроек */
let allPlugins: { name: string; enabled: boolean }[] = []
let isFullscreen = false

/**
 * Статус пишется в настройки; разовые подсказки (toast=true) дополнительно
 * всплывают тостом справа внизу на 3.5 c. Технический счётчик (polling)
 * идёт с toast=false, чтобы не спамить.
 */
/**
 * Минимальный window.chrome для перенесённых content-скриптов Chrome-расширений.
 * storage.local — из снапшота window.__shellPluginStores, который оболочка пушит
 * в страницу при инжекте и обновляет при изменениях: у <webview> НЕТ preload,
 * поэтому window.shell в гостевой странице отсутствует и IPC оттуда недоступен
 * (данные плагинов — шаблоны и т.п., несекретные; credentials/куки/конфиг таким
 * путём не отдаются вообще). Запись — в снапшот + оппортунистически в IPC.
 * Сообщения от оболочки — через window.__chromeShimReceive (fan-out по onMessage).
 * Имя текущего плагина loader кладёт в window.__shellPluginName перед его кодом.
 */
/** Забрать снапшот данных всех плагинов из main и положить в гостевую страницу */
/**
 * BFF-мост для sew-helper: гость складывает запросы в window.__sewHelperBffReq,
 * оболочка забирает их (splice — атомарно), ходит в main через netFetch
 * (net.fetch: без CORS, куки общие с webview через default session) и кладёт
 * ответы в window.__sewHelperBffRes[id]. Опрос каждые 500 мс, только если
 * плагин загружен.
 */
/** Именованный вызов гостя: при reject пишет КАКОЙ вызов упал и с чем.
 *  Без этого безликий "GUEST_VIEW_MANAGER_CALL: ..." не даёт понять виновника.
 *  Повторы с тем же текстом глушим (дедуп по ключу `${tab.id}:${label}`),
 *  исключение пробрасываем. */
let sewHelperBridgeStarted = false
let bffTakeDiagged = false
/** Адаптивный опрос: 500мс при работе, до 2000мс в простое + пауза когда окно скрыто */
let bffDelay = 500
let bffBusy = false
function startSewHelperBridge(): void {
  if (sewHelperBridgeStarted) return
  sewHelperBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      bffDelay = 2000
      setTimeout(tick, bffDelay)
      return
    }
    if (!bffBusy) {
      bffBusy = true
      void pumpSewHelperBff()
        .then((hadWork) => {
          bffDelay = hadWork ? 500 : Math.min(2000, bffDelay + 250)
        })
        .catch(() => {
          bffDelay = Math.min(2000, bffDelay + 250)
        })
        .finally(() => {
          bffBusy = false
        })
    }
    setTimeout(tick, bffDelay)
  }
  setTimeout(tick, 500)
}

async function pumpSewHelperBff(): Promise<boolean> {
  try {
    if (!plugins.some((p) => p.name === 'sew-helper')) return false
    // Обходим ВСЕ вкладки: BFF-запрос может прийти из любой, а в госте у него
    // 30-секундный таймаут ожидания ответа — не опросим вкладку, она зависнет.
    // hadWork: был ли хоть один запрос — по нему адаптивный таймер держит 500мс.
    let hadWork = false
    for (const tab of listTabs()) {
      // Гостевая часть — полностью неубиваемая (вложенные try/catch): reject
      // executeJavaScript Electron всегда дублирует внутренним логом
      // "GUEST_VIEW_MANAGER_CALL: ...", поэтому гость не должен кидать
      // в принципе.
      // take возвращает JSON-СТРОКУ (structured clone результата падает на
      // объектах только в экзотике, строка — всегда безопасна). КРИТИЧНО:
      // IIFE обязана заканчиваться `()()` — голая `(function(){...})` без вызова
      // возвращает сам объект функции, а он неклонируем:
      // "GUEST_VIEW_MANAGER_CALL: An object could not be cloned" (ловушка 17).
      let rawTake: string
      try {
        rawTake = await guestJS<string>(
          tab,
          'bff-take',
          '(function(){try{var q=window.__sewHelperBffReq;if(!Array.isArray(q))return "[]";' +
            'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
        )
      } catch (err) {
        // take возвращает строку во всех ветках — клон здесь ни при чём.
        // Фиксируем состояние ГЕСТА (синхронные хост-вызовы, без клона),
        // чтобы понять, в какой момент падает invoke. Однократно.
        if (!bffTakeDiagged) {
          bffTakeDiagged = true
          try {
            console.warn(
              `[guestjs:bff-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
            )
          } catch {
            // ignore
          }
        }
        continue
      }
      let reqs: Array<{ id: string; url: string }> = []
      try {
        const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
        if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; url: string }>
      } catch {
        reqs = []
      }
      for (const req of reqs) {
        if (!req || typeof req.id !== 'string' || typeof req.url !== 'string') continue
        hadWork = true
        let res: { ok: boolean; status: number; data: unknown }
        try {
          res = await window.shell.netFetch(req.url)
        } catch {
          res = { ok: false, status: 0, data: null }
        }
        try {
          await guestJS<boolean>(
            tab,
            'bff-write',
            '(function(id,payload){try{(window.__sewHelperBffRes = window.__sewHelperBffRes || {})[id]=payload;return true}catch(e){return false}})' +
              '(' +
              JSON.stringify(req.id) +
              ',' +
              JSON.stringify(res ?? { ok: false, status: 0, data: null }) +
              ')',
          )
        } catch {
          // вкладка могла закрыться между опросом и ответом — гость повторит запрос сам (retry)
        }
      }
    }
    return hadWork
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

/**
 * Мост для в-page блока «Сканы»: гость складывает запросы в
 * window.__sewScansReq, оболочка забирает их (splice — атомарно) и ходит в main
 * через window.shell.* (у гостя нет window.shell, поэтому мост — в renderer).
 * Ответи кладём в window.__sewScansRes[id] как JSON-СТРОКУ (structured clone
 * падает на объектах; строка безопасна). IIFE ОБЯЗАТНО заканчивается `()()`
 * (ловушка 17: голая `(function(){...})` без вызова не клонируется → GUEST_VIEW_MANAGER_CALL).
 */
let scansBridgeStarted = false
let scansTakeDiagged = false
/** Тот же адаптивный опрос, что у BFF-моста: быстро при работе, медленно в простое */
let scansDelay = 500
let scansBusy = false
function startScansBridge(): void {
  if (scansBridgeStarted) return
  scansBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      scansDelay = 2000
      setTimeout(tick, scansDelay)
      return
    }
    if (!scansBusy) {
      scansBusy = true
      void pumpScansBridge()
        .then((hadWork) => {
          scansDelay = hadWork ? 500 : Math.min(2000, scansDelay + 250)
        })
        .catch(() => {
          scansDelay = Math.min(2000, scansDelay + 250)
        })
        .finally(() => {
          scansBusy = false
        })
    }
    setTimeout(tick, scansDelay)
  }
  setTimeout(tick, 500)
}

async function pumpScansBridge(): Promise<boolean> {
  try {
    if (!plugins.some((p) => p.name === 'scans-block')) return false
    // Как и BFF-мост: запрос «Сканы» может прийти из любой вкладки, а ответ
    // ждёт в госте с таймаутом — обходим все вкладки подряд.
    let hadWork = false
    for (const tab of listTabs()) {
      let rawTake: string
      try {
        rawTake = await guestJS<string>(
          tab,
          'scans-take',
          '(function(){try{var q=window.__sewScansReq;if(!Array.isArray(q))return "[]";' +
            'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
        )
      } catch (err) {
        if (!scansTakeDiagged) {
          scansTakeDiagged = true
          try {
            console.warn(
              `[guestjs:scans-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
            )
          } catch {
            // ignore
          }
        }
        continue
      }
      let reqs: Array<{ id: string; type: string; payload?: unknown }> = []
      try {
        const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
        if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; type: string; payload?: unknown }>
      } catch {
        reqs = []
      }
      for (const req of reqs) {
        if (!req || typeof req.id !== 'string' || typeof req.type !== 'string') continue
        hadWork = true
        let result: unknown
        try {
          switch (req.type) {
            case 'list':
              result = await window.shell.listScans()
              break
            case 'read':
              result = typeof req.payload === 'string' ? await window.shell.readScanFile(req.payload) : null
              break
            case 'launch':
              result = await window.shell.launchScannerApp()
              break
            case 'pick':
              result = await window.shell.pickScanFile()
              break
            case 'open':
              result = typeof req.payload === 'string' ? await window.shell.openScanFile(req.payload) : false
              break
            case 'show':
              result = typeof req.payload === 'string' ? await window.shell.showScanInFolder(req.payload) : false
              break
            case 'delete':
              result = typeof req.payload === 'string' ? await window.shell.deleteScan(req.payload) : []
              break
            default:
              result = { ok: false, error: 'unknown type' }
          }
        } catch (err) {
          console.warn(`[scans-bridge] ${req.type} failed:`, err)
          result = { ok: false, error: String((err as Error)?.message ?? err) }
        }
        try {
          await guestJS<boolean>(
            tab,
            'scans-write',
            '(function(id,payload){try{(window.__sewScansRes = window.__sewScansRes || {})[id]=payload;return true}catch(e){return false}})' +
              '(' +
              JSON.stringify(req.id) +
              ',' +
              JSON.stringify(result ?? null) +
              ')',
          )
        } catch {
          // вкладка могла закрыться между опросом и ответом — гость повторит запрос сам
        }
      }
    }
    return hadWork
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

let tasksNotifyStarted = false
let tasksNotifyDiagged = false
let tasksNotifyDelay = 5000
let tasksNotifyBusy = false
/** Свой звук из настроек (soundFile/soundName — перемещение, soundFileHo/soundNameHo — выдача); '' — стандартный бип */
let tnSoundFileRel = ''
let tnSoundFileHo = ''
/** Кэш Audio своих звуков по слотам (ключ — soundFile); сбрасывается при смене/сбросе настройки */
const tnCustomAudio: Record<'rel' | 'ho', { audio: HTMLAudioElement | null; key: string }> = {
  rel: { audio: null, key: '' },
  ho: { audio: null, key: '' },
}

/** Стандартный бип 880 Гц (дефолт, когда своего файла нет или он битый) */
function playTnBeep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.frequency.value = 880; gain.gain.value = 0.15
    osc.onended = (): void => { ctx.close().catch(() => undefined) }
    osc.start(); osc.stop(ctx.currentTime + 0.25)
    setTimeout(() => { ctx.close().catch(() => undefined) }, 1000)
  } catch { /* без звука */ }
}

/** Свой файл слота — приоритет; любая неудача — молча стандартный бип */
async function playTnSound(slot: 'rel' | 'ho'): Promise<void> {
  const file = slot === 'ho' ? tnSoundFileHo : tnSoundFileRel
  if (file) {
    try {
      const cached = tnCustomAudio[slot]
      if (!cached.audio || cached.key !== file) {
        const data = await window.shell.getSound(slot)
        if (!data) throw new Error('no custom sound')
        cached.audio = new Audio(`data:${data.mime};base64,${data.base64}`)
        cached.key = file
      } else {
        cached.audio.currentTime = 0
      }
      await cached.audio.play()
      return
    } catch { /* fallback ниже */ }
  }
  playTnBeep()
}
function startTasksNotifyBridge(): void {
  if (tasksNotifyStarted) return
  tasksNotifyStarted = true
  const tick = (): void => {
    if (!tasksNotifyBusy) {
      tasksNotifyBusy = true
      void pumpTasksNotify()
        .then((hadWork) => { tasksNotifyDelay = hadWork ? 5000 : Math.min(15000, tasksNotifyDelay + 1000) })
        .catch(() => { tasksNotifyDelay = Math.min(15000, tasksNotifyDelay + 1000) })
        .finally(() => { tasksNotifyBusy = false })
    }
    setTimeout(tick, tasksNotifyDelay)
  }
  setTimeout(tick, 5000)
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
    if (isAllowed(url)) openTab(url)
    else {
      setStatus('открыто во внешнем приложении')
      void window.shell.openExternal(url)
    }
  }
  return urls.length > 0
}

function startLinkIntake(): void {
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

/** Дефолт времени показа уведомлений tasks-notify, сек (0 = не скрывать) */
const TN_ALERT_TTL_DEFAULT_SEC = 60

/** Нормализация «Времени показа уведомлений»: 0 = не скрывать, пустое/мусор → дефолт */
function normalizeTnAlertTtl(raw: unknown): number {
  if (typeof raw === 'string' && !raw.trim()) return TN_ALERT_TTL_DEFAULT_SEC
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : TN_ALERT_TTL_DEFAULT_SEC
}

/**
 * «Время показа уведомлений» из настроек плагина. Читается в момент показа,
 * поэтому новое значение применяется без перезапуска гостя.
 */
async function readTnAlertTtl(): Promise<number> {
  try {
    const data = await window.shell.pluginDataGet('tasks-notify', ['settings'])
    return normalizeTnAlertTtl((data.settings as { alertTtlSec?: unknown } | undefined)?.alertTtlSec)
  } catch {
    return TN_ALERT_TTL_DEFAULT_SEC
  }
}

async function pumpTasksNotify(): Promise<boolean> {
  try {
    if (!plugins.some((p) => p.name === 'tasks-notify')) return false
    const tab = primaryTab()
    if (!tab) return false
    const rawTake = await guestJS<string>(
      tab,
      'tasks-take',
      // Здесь же поднимаем arm: если первая вкладка закрылась, primaryTab()
      // переехал на другую, а её __tnInit уже отработал и вышел (гость не был
      // хостом на момент загрузки) — код плагина повторно не инжектится, флаг
      // оболочка обновляет только на did-finish-load. Флаг ставим ДО arm'а.
      '(function(){try{window.__shellPollHost = true;' +
        'if (typeof window.__tnArmTasksNotify === "function") window.__tnArmTasksNotify();' +
        'var q=window.__tasksNotifyReq;if(!Array.isArray(q))return "[]";' +
        'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
    ).catch((err) => {
      if (!tasksNotifyDiagged) {
        tasksNotifyDiagged = true
        try {
          console.warn(`[guestjs:tasks-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`)
        } catch { /* ignore */ }
      }
      throw err
    })
    let reqs: Array<{ id: number; kind?: string; title: string; body: string; url: string; sound?: boolean }> = []
    try {
      const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
      if (Array.isArray(parsed)) reqs = parsed as typeof reqs
    } catch { reqs = [] }
    if (!Array.isArray(reqs) || reqs.length === 0) return false
    const valid = reqs.filter((r) => r && typeof r.id === 'number' && typeof r.title === 'string')
    if (valid.length === 0) return false
    try {
      await window.shell.notifyTasks(valid)
    } catch (err) {
      console.warn('[tasks-notify] notifyTasks failed:', err)
    }
    const first = valid[0]
    if (valid.some((r) => r.sound !== false)) {
      void playTnSound(first.kind === 'handover' ? 'ho' : 'rel')
    }
    const taskText = formatTaskAlertText(first)
    const toastText = valid.length > 1 ? `${taskText} (+${valid.length - 1})` : taskText
    const taskUrls = getTaskAlertUrls(first)
    const openUrl = tasksUrl(taskUrls.open)
    const allUrl = taskUrls.all ? tasksUrl(taskUrls.all) : undefined
    // Клик по баннеру открывает задание вкладкой, как и клик по OS-уведомлению
    // (ниже onTasksOpen): навигация в текущей вкладке уничтожила бы её работу.
    taskAlert?.show(toastText, () => {
      focusOrOpenTab(openUrl)
    }, allUrl ? () => {
      focusOrOpenTab(allUrl)
    } : undefined, await readTnAlertTtl())
    return true
  } catch {
    return false
  }
}

function updateAddressBar(): void {
  if (!addressInput) return
  const view = activeView()
  if (!view) return
  try {
    addressInput.value = view.getURL() ?? ''
  } catch {
    // webview ещё не готов — игнорируем
  }
}

/** Заголовок активной страницы по центру titlebar (как в макете). */
function updateTitlebarTitle(): void {
  if (!titlebarTitle) return
  const tab = activeTab()
  titlebarTitle.textContent = tab ? tab.title : ''
}

/**
 * Тусклые «назад/вперёд», когда переходить некуда. У <webview> нет canGoBack,
 * поэтому состояние ведём сами: переход назад/вперёд включает одну сторону,
 * обычная навигация включает «назад» и гасит «вперёд».
 */
function updateNavButtons(): void {
  const tab = activeTab()
  if (btnBack) btnBack.classList.toggle('nav-off', !tab || !canTabGoBack(tab))
  if (btnForward) btnForward.classList.toggle('nav-off', !tab || !canTabGoForward(tab))
}

async function navigate(url: string): Promise<void> {
  const target = normalizeUrl(url)
  if (!target) return
  if (isAllowed(target)) {
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
function applyZoomForCurrentPage(): void {
  if (!config) return
  const view = activeView()
  if (!view) return
  try {
    const host = hostOf(view.getURL() ?? '')
    const factor = (host && config.zoom[host]) || 1
    view.setZoomFactor(factor)
    addressMenu?.syncZoom(factor)
  } catch {
    // webview ещё не готов — применится при следующей навигации
  }
}

async function changeZoom(dir: 1 | -1 | 'reset'): Promise<void> {
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
  addressMenu?.syncZoom(next)
  const host = hostOf(view.getURL() ?? '')
  if (host) {
    config.zoom[host] = Math.round(next * 100) / 100
    try {
      config = await window.shell.setConfig({ zoom: config.zoom })
    } catch (err) {
      console.warn('[shell] failed to persist zoom:', err)
    }
  }
  setStatus(`${Math.round(next * 100)}%`)
}

// ---------- Оверлей ошибки сети ----------

/** Настройки tasks-notify из plugin-data (тот же ключ 'settings', что читает гость каждый тик) */
async function loadTnSettings(): Promise<void> {
  try {
    const data = await window.shell.pluginDataGet('tasks-notify', ['settings'])
    const s = (data?.settings ?? {}) as { objectId?: unknown; intervalSec?: unknown; alertTtlSec?: unknown; sound?: unknown; soundFile?: unknown; soundName?: unknown; soundFileHo?: unknown; soundNameHo?: unknown }
    if (setTnObjectId) setTnObjectId.value = typeof s.objectId === 'string' && s.objectId ? s.objectId : 'S187'
    if (setTnInterval) {
      setTnInterval.value = String(
        typeof s.intervalSec === 'number' && s.intervalSec >= 15 ? Math.floor(s.intervalSec) : 60,
      )
    }
    if (setTnAlertTtl) setTnAlertTtl.value = String(normalizeTnAlertTtl(s.alertTtlSec))
    if (setTnSound) setTnSound.checked = s.sound !== false
    tnSoundFileRel = typeof s.soundFile === 'string' ? s.soundFile : ''
    tnSoundFileHo = typeof s.soundFileHo === 'string' ? s.soundFileHo : ''
    if (setTnSoundName) {
      setTnSoundName.textContent =
        tnSoundFileRel && typeof s.soundName === 'string' && s.soundName ? s.soundName : 'Стандартный звук'
    }
    if (setTnSoundHoName) {
      setTnSoundHoName.textContent =
        tnSoundFileHo && typeof s.soundNameHo === 'string' && s.soundNameHo ? s.soundNameHo : 'Стандартный звук'
    }
  } catch (err) {
    console.warn('[shell] failed to load tasks-notify settings:', err)
  }
}

function openSettings(): void {
  if (!config || !settingsOverlay) return
  if (setStartUrl) setStartUrl.value = config.startUrl
  if (setAllowlistEnabled) setAllowlistEnabled.checked = config.allowlistEnabled
  if (setAllowlist) setAllowlist.value = config.allowlist.join('\n')
  if (setPlugins) {
    setPlugins.innerHTML = ''
    // Показываем ВСЕ плагины (включая выключенные), иначе выключенный
    // пропадал из списка и его нельзя было включить обратно.
    const list = allPlugins.length > 0 ? allPlugins : plugins.map((p) => ({ name: p.name, enabled: true }))
    for (const plugin of list) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.dataset.plugin = plugin.name
      checkbox.checked = config.plugins[plugin.name] ?? plugin.enabled ?? true
      label.append(checkbox, document.createTextNode(plugin.name))
      setPlugins.append(label)
    }
    if (list.length === 0) {
      const empty = document.createElement('span')
      empty.textContent = 'Нет загруженных плагинов'
      setPlugins.append(empty)
    }
  }
  if (setClearOnExit) setClearOnExit.value = config.clearOnExit
  void loadTnSettings()
  if (setScannerApp) setScannerApp.value = config.scannerAppPath ?? ''
  if (setScannerArgs) setScannerArgs.value = (config as ShellConfig).scannerAppArgs ?? ''
  void renderScanFolders()
  settingsOverlay.hidden = false
  void refreshStoragePanel()
}

function closeSettings(): void {
  if (settingsOverlay) settingsOverlay.hidden = true
}

async function saveSettings(): Promise<void> {
  if (!config) return
  const pluginChecks = setPlugins?.querySelectorAll<HTMLInputElement>('input[data-plugin]') ?? []
  const pluginStates: Record<string, boolean> = {}
  pluginChecks.forEach((checkbox) => {
    const name = checkbox.dataset.plugin
    if (name) pluginStates[name] = checkbox.checked
  })
  const patch: Partial<ShellConfig> = {
    startUrl: normalizeUrl(setStartUrl?.value ?? '') || config.startUrl,
    allowlistEnabled: setAllowlistEnabled?.checked ?? config.allowlistEnabled,
    allowlist: (setAllowlist?.value ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    plugins: pluginStates,
    clearOnExit: (setClearOnExit?.value as ShellConfig['clearOnExit']) ?? config.clearOnExit,
    scannerAppPath: setScannerApp?.value.trim() ?? config.scannerAppPath,
    scannerAppArgs: setScannerArgs?.value.trim() ?? (config as ShellConfig).scannerAppArgs ?? '',
  }
  try {
    const oldStartUrl = config.startUrl
    config = await window.shell.setConfig(patch)
    // Настройки tasks-notify — в plugin-data плагина; гость подхватит со следующего тика.
    // Пишем отдельно: их падение не отменяет уже сохранённый основной конфиг.
    try {
      const tnInterval = Math.floor(Number(setTnInterval?.value))
      const tnAlertTtl = normalizeTnAlertTtl(setTnAlertTtl?.value)
      await window.shell.pluginDataSet('tasks-notify', {
        settings: {
          objectId: setTnObjectId?.value.trim() || 'S187',
          intervalSec: Number.isFinite(tnInterval) && tnInterval >= 15 ? tnInterval : 60,
          alertTtlSec: tnAlertTtl,
          sound: setTnSound?.checked !== false,
          soundFile: tnSoundFileRel,
          soundName: setTnSoundName?.textContent ?? '',
          soundFileHo: tnSoundFileHo,
          soundNameHo: setTnSoundHoName?.textContent ?? '',
        },
      })
    } catch (tnErr) {
      console.warn('[shell] failed to save tasks-notify settings:', tnErr)
      setStatus('настройки сохранены, но настройки уведомлений — нет')
      return
    }
    closeSettings()
    setStatus('настройки сохранены')
    if (config.startUrl !== oldStartUrl) {
      if (addressInput) addressInput.value = config.startUrl
      void navigate(config.startUrl)
    }
  } catch (err) {
    console.warn('[shell] failed to save settings:', err)
    setStatus('не удалось сохранить настройки')
  }
}

async function clearSessionAndLogout(): Promise<void> {
  if (!window.confirm('Очистить все данные сессии (куки, кэш, хранилища) и выйти из SEW?')) return
  try {
    await window.shell.clearSession()
    closeSettings()
    // Сессия общая для всего окна — перезагружаем ВСЕ вкладки, иначе неактивные
    // продолжают рендерить залогиненную SEW до ручного F5.
    for (const tab of listTabs()) {
      try {
        tab.view.reload()
      } catch (err) {
        console.warn('[shell] tab reload failed:', err)
      }
    }
    setStatus('сессия очищена')
  } catch (err) {
    console.warn('[shell] failed to clear session:', err)
    setStatus('не удалось очистить сессию')
  }
}

async function renderScanFolders(): Promise<void> {
  if (!setScanFoldersList) return
  setScanFoldersList.innerHTML = ''
  const folders = config?.scanFolders ?? []
  if (folders.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'scan-folder-empty'
    empty.textContent = 'Папки не добавлены — нажмите «Добавить папку»'
    setScanFoldersList.append(empty)
    return
  }
  for (const folder of folders) {
    const row = document.createElement('div')
    row.className = 'scan-folder-row'
    const pathEl = document.createElement('div')
    pathEl.className = 'scan-folder-path'
    pathEl.textContent = folder.path
    pathEl.title = folder.path
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'scan-folder-remove'
    removeBtn.textContent = '✕'
    removeBtn.title = 'Удалить папку'
    removeBtn.setAttribute('aria-label', `Удалить папку ${folder.path}`)
    removeBtn.addEventListener('click', async () => {
      if (!window.confirm(`Удалить папку со сканами ${folder.path}?`)) return
      const next = (config?.scanFolders ?? []).filter((f) => f.id !== folder.id)
      config = await window.shell.setConfig({ scanFolders: next })
      void renderScanFolders()
    })
    row.append(pathEl, removeBtn)
    setScanFoldersList.append(row)
  }
}

function wireSettings(): void {
  document.getElementById('btn-settings')?.addEventListener('click', openSettings)
  document.getElementById('set-save')?.addEventListener('click', () => void saveSettings())
  document.getElementById('set-cancel')?.addEventListener('click', closeSettings)
  document.getElementById('set-scanner-app-browse')?.addEventListener('click', async () => {
    try {
      const path = await window.shell.browseScannerApp()
      if (path && setScannerApp) setScannerApp.value = path
    } catch (err) {
      console.warn('[shell] scans:browse-app failed:', err)
    }
  })
  document.getElementById('set-scan-folder-add')?.addEventListener('click', async () => {
    try {
      const path = await window.shell.browseScanFolder()
      if (!path) return
      const current = config?.scanFolders ?? []
      if (current.some((f) => f.path.toLowerCase() === path.toLowerCase())) {
        setStatus('папка уже добавлена')
        return
      }
      config = await window.shell.setConfig({ scanFolders: [...current, { path }] })
      void renderScanFolders()
    } catch (err) {
      console.warn('[shell] scans:browse-folder failed:', err)
    }
  })
  const wireTnSoundSlot = (
    slot: 'rel' | 'ho',
    pickId: string,
    previewId: string,
    resetId: string,
    nameEl: HTMLElement | null,
    setFile: (v: string) => void,
  ): void => {
    document.getElementById(pickId)?.addEventListener('click', async () => {
      try {
        const picked = await window.shell.pickSound(slot)
        if (!picked) return
        setFile(picked.file)
        tnCustomAudio[slot] = { audio: null, key: '' }
        if (nameEl) nameEl.textContent = picked.name
      } catch (err) {
        console.warn('[shell] sound:pick failed:', err)
      }
    })
    document.getElementById(previewId)?.addEventListener('click', () => {
      void playTnSound(slot)
    })
    document.getElementById(resetId)?.addEventListener('click', async () => {
      try {
        await window.shell.clearSound(slot)
      } catch (err) {
        console.warn('[shell] sound:clear failed:', err)
      }
      setFile('')
      tnCustomAudio[slot] = { audio: null, key: '' }
      if (nameEl) nameEl.textContent = 'Стандартный звук'
    })
  }
  wireTnSoundSlot('rel', 'set-tn-sound-pick', 'set-tn-sound-preview', 'set-tn-sound-reset', setTnSoundName,
    (v) => { tnSoundFileRel = v })
  wireTnSoundSlot('ho', 'set-tn-sound-ho-pick', 'set-tn-sound-ho-preview', 'set-tn-sound-ho-reset', setTnSoundHoName,
    (v) => { tnSoundFileHo = v })
  document.getElementById('set-clear-session')?.addEventListener('click', () => void clearSessionAndLogout())
  document.getElementById('set-reload-app')?.addEventListener('click', () => {
    // Ручная проверка обновлений на GitHub. Если версия есть — покажется
    // updatebar «Доступно обновление», если нет — тост «у вас последняя версия».
    closeSettings()
    checkForUpdatesManually()
  })
  document
    .getElementById('set-clear-cache')
    ?.addEventListener('click', () => void clearStorageTarget('cache'))
  document
    .getElementById('set-clear-cookies')
    ?.addEventListener('click', () => void clearStorageTarget('cookies'))
  document.getElementById('acc-add')?.addEventListener('click', () => openAccountForm())
  document.getElementById('acc-save')?.addEventListener('click', () => void saveAccountForm())
  document.getElementById('acc-cancel')?.addEventListener('click', closeAccountForm)
  document.getElementById('acc-eye')?.addEventListener('click', (event) => {
    if (!accPassword) return
    const show = accPassword.type === 'password'
    accPassword.type = show ? 'text' : 'password'
    ;(event.target as HTMLElement).innerHTML = show ? '&#128064;' : '&#128065;'
  })
  document.getElementById('accounts-cancel')?.addEventListener('click', closeAccounts)
  setStartUrl?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveSettings()
  })
}

// ---------- Хранилище: использование, куки, выборочная очистка ----------

function renderCookies(cookies: CookieInfo[]): void {
  if (!setCookies) return
  setCookies.innerHTML = ''
  if (cookies.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = 'Нет куки'
    setCookies.append(empty)
    return
  }
  for (const cookie of cookies) {
    const row = document.createElement('div')
    row.className = 'cookie-row'
    const expiry = cookie.session
      ? 'сессионная'
      : cookie.expirationDate
        ? new Date(cookie.expirationDate * 1000).toLocaleDateString('ru-RU')
        : '—'
    const info = document.createElement('span')
    info.textContent =
      `${cookie.name} @ ${cookie.domain} · ${expiry} · ${formatSize(cookie.size)}` +
      `${cookie.httpOnly ? ' · httpOnly' : ''}`
    info.title = `Путь: ${cookie.path}${cookie.secure ? ' · secure' : ''}`
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = `Удалить куку ${cookie.name}`
    del.addEventListener('click', () => void removeCookie(cookie))
    row.append(info, del)
    setCookies.append(row)
  }
}

/** IPC с таймаутом: зависший вызов превращается в читаемую ошибку, а не вечное «считаем…» */
async function refreshStoragePanel(): Promise<void> {
  if (setStorageUsage) setStorageUsage.textContent = 'считаем…'
  try {
    // Запросы независимы: показываем то, что прочиталось, и точный текст ошибки того, что нет
    const [usageRes, cookiesRes] = await Promise.allSettled([
      withTimeout(window.shell.getStorageUsage(), 10000, 'кэша'),
      withTimeout(window.shell.listCookies(), 10000, 'куки'),
    ])
    const parts: string[] = []
    if (usageRes.status === 'fulfilled' && typeof usageRes.value?.cacheBytes === 'number') {
      parts.push(`HTTP-кэш: ${formatSize(usageRes.value.cacheBytes)}`)
    } else {
      const reason = usageRes.status === 'rejected' ? usageRes.reason : new Error('нет данных')
      console.warn('[shell] storage usage failed:', reason)
      parts.push(`кэш: ошибка (${errText(reason)})`)
    }
    if (cookiesRes.status === 'fulfilled' && Array.isArray(cookiesRes.value)) {
      parts.push(`куки: ${cookiesRes.value.length} шт`)
      renderCookies(cookiesRes.value)
    } else {
      const reason =
        cookiesRes.status === 'rejected' ? cookiesRes.reason : new Error('нет данных')
      console.warn('[shell] cookies list failed:', reason)
      parts.push(`куки: ошибка (${errText(reason)})`)
      renderCookies([])
    }
    const tab = activeTab()
    if (tab) {
      try {
        const estimate = (await guestJS<{ usage: number } | null>(
          tab,
          'storage-estimate',
          'navigator.storage && navigator.storage.estimate ' +
            '? navigator.storage.estimate().then((e) => ({ usage: e.usage ?? 0 })).catch(() => null) ' +
            ': Promise.resolve(null)',
        ))
        if (estimate) parts.push(`данные сайта: ${formatSize(estimate.usage)}`)
      } catch {
        // страница не готова — показываем без данных сайта
      }
    }
    if (setStorageUsage) setStorageUsage.textContent = parts.join(' · ')
  } catch (err) {
    console.warn('[shell] storage panel refresh failed:', err)
    if (setStorageUsage) setStorageUsage.textContent = `не удалось прочитать: ${errText(err)}`
  }
}

async function removeCookie(cookie: CookieInfo): Promise<void> {
  try {
    await window.shell.removeCookie(cookie)
    await refreshStoragePanel()
  } catch (err) {
    console.warn('[shell] remove cookie failed:', err)
  }
}

async function clearStorageTarget(target: 'cache' | 'cookies'): Promise<void> {
  if (target === 'cookies' && !window.confirm('Очистить все куки? Придётся заново войти в SEW.')) {
    return
  }
  try {
    await window.shell.clearStorage(target)
    if (target === 'cookies') {
      // Куки общие для всего окна — перезагружаем ВСЕ вкладки, иначе неактивные
      // продолжают рендерить залогиненную SEW до ручного F5.
      for (const tab of listTabs()) {
        try {
          tab.view.reload()
        } catch (err) {
          console.warn('[shell] tab reload failed:', err)
        }
      }
    }
    await refreshStoragePanel()
    setStatus(target === 'cache' ? 'кэш очищен' : 'куки очищены')
  } catch (err) {
    console.warn('[shell] clear storage failed:', err)
    setStatus('не удалось очистить')
  }
}

// ---------- Аккаунты SEW ----------

const accountsOverlay = document.getElementById('accounts-overlay') as HTMLElement | null
const setAccounts = document.getElementById('set-accounts') as HTMLElement | null
const accForm = document.getElementById('acc-form') as HTMLElement | null
const accFio = document.getElementById('acc-fio') as HTMLInputElement | null
const accTabNum = document.getElementById('acc-tabnum') as HTMLInputElement | null
const accPassword = document.getElementById('acc-password') as HTMLInputElement | null
let accountsOpen = false
let loginPrompted = false
let editingAccountId: string | null = null

function accountLabel(a: AccountInfo): string {
  return a.fio ? `${a.fio} · ${a.tabNum}` : a.tabNum
}

/** Список аккаунтов в окне «Аккаунты SEW»: войти / изменить / удалить */
async function renderAccountsList(): Promise<AccountInfo[]> {
  if (setAccounts) setAccounts.innerHTML = ''
  let accounts: AccountInfo[] = []
  try {
    accounts = await window.shell.listAccounts()
  } catch (err) {
    console.warn('[shell] list accounts failed:', err)
  }
  if (!setAccounts) return accounts
  if (accounts.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = 'Нет сохранённых аккаунтов'
    setAccounts.append(empty)
    return accounts
  }
  for (const a of accounts) {
    const row = document.createElement('div')
    row.className = 'account-row'
    const info = document.createElement('span')
    info.textContent = accountLabel(a)
    const login = document.createElement('button')
    login.textContent = 'Войти'
    login.className = 'login-btn'
    login.title = 'Подставить логин и пароль, войти'
    login.addEventListener('click', () => void fillLogin(a.id))
    const edit = document.createElement('button')
    edit.textContent = '✎'
    edit.title = 'Изменить'
    edit.addEventListener('click', () => openAccountForm(a))
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = 'Удалить'
    del.addEventListener('click', () => void deleteAccount(a))
    row.append(info, login, edit, del)
    setAccounts.append(row)
  }
  return accounts
}

async function deleteAccount(a: AccountInfo): Promise<void> {
  if (!window.confirm(`Удалить аккаунт «${accountLabel(a)}»?`)) return
  try {
    await window.shell.removeAccount(a.id)
    if (editingAccountId === a.id) closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт удалён')
  } catch (err) {
    console.warn('[shell] remove account failed:', err)
  }
}

function openAccountForm(a?: AccountInfo): void {
  editingAccountId = a?.id ?? null
  if (accFio) accFio.value = a?.fio ?? ''
  if (accTabNum) accTabNum.value = a?.tabNum ?? ''
  if (accPassword) {
    accPassword.value = ''
    accPassword.placeholder = a ? 'Пусто — не менять' : 'Пароль'
    accPassword.type = 'password'
  }
  const eye = document.getElementById('acc-eye')
  if (eye) eye.innerHTML = '&#128065;'
  if (accForm) accForm.hidden = false
  accTabNum?.focus()
}

function closeAccountForm(): void {
  editingAccountId = null
  if (accForm) accForm.hidden = true
}

async function saveAccountForm(): Promise<void> {
  const tabNum = accTabNum?.value.trim() ?? ''
  const password = accPassword?.value ?? ''
  if (!tabNum) {
    setStatus('укажите табельный номер')
    return
  }
  if (!editingAccountId && !password) {
    setStatus('укажите пароль')
    return
  }
  try {
    await window.shell.saveAccount({
      id: editingAccountId ?? undefined,
      fio: accFio?.value ?? '',
      tabNum,
      password,
    })
    closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт сохранён')
  } catch (err) {
    console.warn('[shell] save account failed:', err)
    setStatus(`не удалось сохранить: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------- Окно «Аккаунты SEW»: выбор для входа + управление ----------

async function openAccounts(manual: boolean): Promise<void> {
  const accounts = await renderAccountsList()
  if (accounts.length === 0) {
    // Авто-обнаружение формы входа: предлагать нечего — молча выходим.
    // Ручное открытие: сразу показываем форму добавления.
    if (!manual) return
    openAccountForm()
    setStatus('добавьте аккаунт SEW для автовхода')
  }
  if (!accountsOverlay) return
  accountsOverlay.hidden = false
  accountsOpen = true
}

function closeAccounts(): void {
  accountsOpen = false
  closeAccountForm()
  if (accountsOverlay) accountsOverlay.hidden = true
}

/** Есть ли на странице видимое поле пароля (форма входа)? */
async function hasLoginForm(): Promise<boolean> {
  const tab = activeTab()
  if (!tab) return false
  try {
    const found = await guestJS<unknown>(
      tab,
      'login-form',
      '!!document.querySelector(\'input[type="password"]:not([disabled])\')',
    )
    return found === true
  } catch {
    return false
  }
}

async function checkLoginForm(manual: boolean): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  // Гость может быть ещё не готов (вкладка только что открыта или переключились
  // на грузящуюся) — executeJavaScript бросит, а проверять форму там нечего.
  if (!guestReady.has(tab.view)) return
  if (accountsOpen) return
  if (!manual && loginPrompted) return
  if (!(await hasLoginForm())) return
  loginPrompted = true
  await openAccounts(false)
}

/**
 * Подставляет табельный номер + пароль и нажимает «Войти».
 * Значения задаём через нативный сеттер value + события input/change,
 * иначе React/Vue-формы не заметят программную подстановку.
 */
async function fillLogin(accountId: string): Promise<void> {
  closeAccounts()
  let secrets: { tabNum: string; password: string } | null = null
  try {
    secrets = await window.shell.getAccountSecrets(accountId)
  } catch (err) {
    console.warn('[shell] get secrets failed:', err)
  }
  if (!secrets) {
    setStatus('не удалось получить данные аккаунта')
    return
  }
  const payload = JSON.stringify({ tabNum: secrets.tabNum, password: secrets.password })
  secrets = null
  const script =
    '(function(creds){' +
    'var pass=document.querySelector(\'input[type="password"]:not([disabled])\');' +
    'if(!pass) return "no-password-field";' +
    'var inputs=Array.prototype.slice.call(document.querySelectorAll("input")).filter(function(el){' +
    'return el!==pass&&!el.disabled&&el.type!=="hidden"&&el.type!=="submit"&&el.type!=="checkbox"' +
    '&&el.type!=="radio"&&el.type!=="password"&&el.offsetParent!==null;});' +
    'var user=inputs.find(function(el){return /user|login|email|tabnum|account|name/i' +
    '.test(el.name+" "+el.id+" "+el.placeholder);})||inputs[0];' +
    'function setVal(el,v){var desc=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value")' +
    '||Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");' +
    'if(desc&&desc.set)desc.set.call(el,v);else el.value=v;' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}' +
    'if(user)setVal(user,creds.tabNum);' +
    'setVal(pass,creds.password);' +
    'var form=pass.form||(user&&user.form);' +
    'var submit=form?form.querySelector(\'button[type="submit"],input[type="submit"]\')' +
    ':document.querySelector(\'button[type="submit"]\');' +
    'setTimeout(function(){if(submit)submit.click();else if(form)' +
    '{if(form.requestSubmit)form.requestSubmit();else form.submit();}},300);' +
    'return "ok";})(' +
    payload +
    ')'
  const tab = activeTab()
  if (!tab) return
  try {
    await guestJS<unknown>(tab, 'fill-login', script)
    setStatus('вход…')
  } catch (err) {
    console.warn('[shell] autofill failed:', err)
    setStatus('не удалось заполнить форму')
  }
}

// ---------- Загрузки ----------

interface DownloadState {
  name: string
  status: 'active' | 'done' | 'error'
  percent: number
  received: number
  path?: string
}

const downloads = new Map<number, DownloadState>()
let downloadsHideTimer: ReturnType<typeof setTimeout> | null = null

function formatBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

function renderDownloads(): void {
  if (!downloadsEl) return
  if (downloadsHideTimer) {
    clearTimeout(downloadsHideTimer)
    downloadsHideTimer = null
  }
  const active = [...downloads.entries()].filter(([, d]) => d.status === 'active')
  if (active.length > 0) {
    const [[, current], ...rest] = active
    const extra = rest.length > 0 ? ` (+${rest.length})` : ''
    const progress =
      current.percent >= 0 ? ` — ${current.percent}%` : ` — ${formatBytes(current.received)}`
    downloadsEl.textContent = `↓ ${current.name}${progress}${extra}`
    downloadsEl.classList.toggle('done', false)
    downloadsEl.onclick = null
    downloadsEl.hidden = false
    return
  }
  const last = [...downloads.values()].pop()
  if (!last) {
    downloadsEl.hidden = true
    downloadsEl.onclick = null
    return
  }
  if (last.status === 'done') {
    downloadsEl.textContent = `✓ ${last.name}`
    downloadsEl.classList.toggle('done', true)
    const path = last.path
    downloadsEl.onclick = path ? () => void window.shell.showItemInFolder(path) : null
  } else {
    downloadsEl.textContent = `✕ ${last.name}`
    downloadsEl.classList.toggle('done', false)
    downloadsEl.onclick = null
  }
  downloadsEl.hidden = false
  downloadsHideTimer = setTimeout(() => {
    if (downloadsEl) downloadsEl.hidden = true
  }, 6000)
}

function pruneDownloads(): void {
  while (downloads.size > 20) {
    const oldestDone = [...downloads.keys()].find((id) => downloads.get(id)?.status !== 'active')
    if (oldestDone === undefined) break
    downloads.delete(oldestDone)
  }
}

/**
 * Папка сохранения файлов по умолчанию. Показываем путь или «Загрузки»,
 * если папка не задана (= системная) либо её больше нет на диске — тогда
 * подпись вводит в заблуждение.
 */
async function renderDownloadsDir(): Promise<void> {
  const el = document.getElementById('downloads-dir')
  if (!el) return
  let dir = ''
  try {
    dir = (await window.shell.getConfig()).downloadsDir ?? ''
  } catch (err) {
    console.warn('[shell] failed to read downloads dir:', err)
  }
  el.textContent = dir || 'Загрузки (системная)'
  el.title = dir
}

async function pickDownloadsDir(): Promise<void> {
  try {
    const dir = await window.shell.pickDownloadsDir()
    if (dir) {
      await renderDownloadsDir()
      setStatus('папка сохранения изменена')
    }
  } catch (err) {
    console.warn('[shell] failed to pick downloads dir:', err)
  }
}

async function resetDownloadsDir(): Promise<void> {
  try {
    await window.shell.setConfig({ downloadsDir: '' })
    await renderDownloadsDir()
    setStatus('папка сохранения — системные «Загрузки»')
  } catch (err) {
    console.warn('[shell] failed to reset downloads dir:', err)
  }
}

function wireDownloads(): void {
  document.getElementById('btn-downloads')?.addEventListener('click', () => void openDownloads())
  document.getElementById('downloads-close')?.addEventListener('click', closeDownloads)
  document.getElementById('downloads-clear')?.addEventListener('click', () => void clearDownloadsHistory())
  downloadsFilter?.addEventListener('change', () => renderDownloadsHistory(downloadsRecords))
  document.getElementById('downloads-dir-pick')?.addEventListener('click', () => void pickDownloadsDir())
  document.getElementById('downloads-dir-reset')?.addEventListener('click', () => void resetDownloadsDir())
  window.shell.onDownload((event) => {
    if (event.type === 'started') {
      downloads.set(event.id, {
        name: event.name,
        status: 'active',
        percent: -1,
        received: 0,
        path: event.path,
      })
    } else if (event.type === 'progress') {
      const current = downloads.get(event.id)
      if (current && current.status === 'active') {
        current.percent = event.percent ?? -1
        current.received = event.received ?? 0
      }
    } else if (event.ok) {
      const current = downloads.get(event.id)
      if (current) {
        current.status = 'done'
        current.path = event.path
      } else {
        downloads.set(event.id, { name: event.name, status: 'done', percent: 100, received: 0, path: event.path })
      }
    } else if (event.cancelled) {
      downloads.delete(event.id)
    } else {
      const current = downloads.get(event.id)
      if (current) current.status = 'error'
      else downloads.set(event.id, { name: event.name, status: 'error', percent: -1, received: 0 })
    }
    pruneDownloads()
    renderDownloads()
    // Окно истории открыто — подтягиваем свежие записи
    if (downloadsOpen) void refreshDownloadsHistory()
  })
}

// ---------- Окно «Загрузки»: история файлов ----------

function whoLabel(rec: DownloadedFile): string {
  if (!rec.fio) return 'неизвестно'
  return rec.tabNum ? `${rec.fio} (${rec.tabNum})` : rec.fio
}

function rebuildDownloadsFilter(): void {
  if (!downloadsFilter) return
  const current = downloadsFilter.value
  const seen = new Set<string>()
  downloadsFilter.innerHTML = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'Все сотрудники'
  downloadsFilter.append(all)
  for (const rec of downloadsRecords) {
    const key = rec.fio ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = rec.fio ? whoLabel(rec) : 'Неизвестно'
    downloadsFilter.append(opt)
  }
  // Выбор переживает обновление, если сотрудник ещё есть в списке
  downloadsFilter.value = Array.from(downloadsFilter.options).some((o) => o.value === current)
    ? current
    : ''
}

function renderDownloadsHistory(records: DownloadedFile[]): void {
  if (!downloadsHistory) return
  downloadsRecords = records
  rebuildDownloadsFilter()
  const filter = downloadsFilter?.value ?? ''
  const visible = filter ? records.filter((r) => (r.fio ?? '') === filter) : records
  downloadsHistory.innerHTML = ''
  if (visible.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = records.length === 0 ? 'Пока ничего не скачано' : 'Нет записей для этого сотрудника'
    downloadsHistory.append(empty)
    return
  }
  for (const rec of visible) {
    const row = document.createElement('div')
    row.className = 'download-row'
    const icon = document.createElement('span')
    icon.className = 'download-icon'
    icon.textContent = rec.state === 'done' ? '✓' : '✕'
    const info = document.createElement('div')
    info.className = 'download-info'
    const name = document.createElement('span')
    name.className = 'download-name'
    name.textContent = rec.name
    name.title = rec.path || rec.name
    name.addEventListener('click', () => void openHistoryFile(rec))
    const meta = document.createElement('span')
    meta.className = 'download-meta'
    const sizePart = rec.bytes > 0 ? `${formatSize(rec.bytes)} · ` : ''
    const whoPart = rec.fio ? ` · ${whoLabel(rec)}` : ' · неизвестно'
    meta.textContent = `${sizePart}${formatDateTime(rec.finishedAt)}${whoPart}${rec.state === 'error' ? ' · ошибка' : ''}`
    info.append(name, meta)
    const show = document.createElement('button')
    show.textContent = '📁'
    show.title = 'Показать в папке'
    show.addEventListener('click', () => void showHistoryFile(rec))
    const del = document.createElement('button')
    del.className = 'dl-remove'
    del.textContent = '✕'
    del.title = 'Убрать из списка'
    del.addEventListener('click', () => void deleteHistoryRecord(rec.id))
    row.append(icon, info, show, del)
    downloadsHistory.append(row)
  }
}

async function refreshDownloadsHistory(): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.listDownloads())
  } catch (err) {
    console.warn('[shell] downloads history failed:', err)
  }
}

async function openDownloads(): Promise<void> {
  if (!downloadsOverlay) return
  downloadsOverlay.hidden = false
  downloadsOpen = true
  await refreshDownloadsHistory()
  void renderDownloadsDir()
}

function closeDownloads(): void {
  downloadsOpen = false
  if (downloadsOverlay) downloadsOverlay.hidden = true
}

async function openHistoryFile(rec: DownloadedFile): Promise<void> {
  try {
    const ok = await window.shell.openDownloadFile(rec.id)
    if (!ok) setStatus('файл не найден (перемещён или удалён)')
  } catch (err) {
    console.warn('[shell] open download failed:', err)
  }
}

async function showHistoryFile(rec: DownloadedFile): Promise<void> {
  try {
    const ok = await window.shell.showDownload(rec.id)
    if (!ok) setStatus('файл не найден (перемещён или удалён)')
  } catch (err) {
    console.warn('[shell] show download failed:', err)
  }
}

async function deleteHistoryRecord(id: string): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.removeDownload(id))
  } catch (err) {
    console.warn('[shell] remove download failed:', err)
  }
}

async function clearDownloadsHistory(): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.clearDownloads())
  } catch (err) {
    console.warn('[shell] clear downloads failed:', err)
  }
}

// ---------- Внешние протоколы (mailto:, tel:) ----------

/** Не http(s) — отдаём внешнему приложению, а не оверлею ошибки */
// ---------- Шорткаты ----------

async function handleShortcut(name: string): Promise<void> {
  switch (name as ShortcutName) {
    case 'new-tab': {
      openTab(config?.startUrl ?? '')
      break
    }
    case 'close-tab': {
      const tab = activeTab()
      if (tab) closeTab(tab.id)
      break
    }
    case 'next-tab': {
      cycleTab(1)
      break
    }
    case 'prev-tab': {
      cycleTab(-1)
      break
    }
    case 'tab-1':
    case 'tab-2':
    case 'tab-3':
    case 'tab-4':
    case 'tab-5':
    case 'tab-6':
    case 'tab-7':
    case 'tab-8':
    case 'tab-9': {
      selectTabIndex(Number(name.slice(4)))
      break
    }
    case 'reload': {
      const view = activeView()
      if (view) view.reload()
      break
    }
    case 'hard-reload': {
      const view = activeView()
      if (view) {
        view.reloadIgnoringCache()
        setStatus('перезагрузка мимо кэша')
      }
      break
    }
    case 'focus-address':
      addressInput?.focus()
      addressInput?.select()
      break
    case 'accounts':
      void openAccounts(true)
      break
    case 'templates':
      void openTemplates()
      break
    case 'back': {
      const tab = activeTab()
      if (!tab || !canTabGoBack(tab)) break
      noteTabHistory(tab, -1)
      tab.view.goBack()
      break
    }
    case 'forward': {
      const tab = activeTab()
      if (!tab || !canTabGoForward(tab)) break
      noteTabHistory(tab, 1)
      tab.view.goForward()
      break
    }
    case 'fullscreen':
      try {
        isFullscreen = await window.shell.setFullscreen()
      } catch (err) {
        console.warn('[shell] fullscreen toggle failed:', err)
      }
      break
    case 'help':
      toggleHelp()
      break
    case 'print':
      void openPrintDialog(activeTab())
      break
    case 'screenshot':
      void captureActiveTabScreenshot()
      break
    case 'find':
      openFind()
      break
    case 'zoom-in':
      void changeZoom(1)
      break
    case 'zoom-out':
      void changeZoom(-1)
      break
    case 'zoom-reset':
      void changeZoom('reset')
      break
    case 'settings':
      openSettings()
      break
    case 'escape':
      cancelFolderPasswordPrompt()
      if (helpOverlay && !helpOverlay.hidden) {
        closeHelp()
        break
      }
      if (addressMenu?.isOpen()) {
        addressMenu.close()
        break
      }
      if (printDialog?.isOpen()) {
        printDialog.close()
        break
      }
      if (shotPreview?.isOpen()) {
        shotPreview.close()
        break
      }
      // Последним приоритетом: разделение сворачиваем, когда все панели закрыты
      if (isSplit()) {
        unsplit()
        break
      }
      if (expandedGroupId !== null) {
        closeGroupPanel()
        break
      }
      if (templatesManageOpen) closeTemplatesManage()
      else if (templatesOpen) closeTemplates()
      else if (accountsOpen) closeAccounts()
      else if (downloadsOpen) closeDownloads()
      else if (tabsOpen) closeTabs()
      else if (isFindActive()) closeFind()
      else if (settingsOverlay && !settingsOverlay.hidden) closeSettings()
      else if (document.activeElement === addressInput && addressInput) addressInput.blur()
      else if (isFullscreen) {
        isFullscreen = false
        try {
          await window.shell.setFullscreen(false)
        } catch {
          // игнорируем
        }
      }
      break
    default:
      break
  }
}

/** Буквы — по event.code (не зависит от раскладки клавиатуры) */
function shortcutFromEvent(event: KeyboardEvent): ShortcutName | null {
  const mod = event.ctrlKey || event.metaKey
  const { key, code } = event
  // Хоткеи вкладок — перед F5/templates, чтобы Ctrl+Shift+T остался шаблонами.
  if (mod && !event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) {
    return `tab-${event.code.slice(5)}` as 'tab-1'
  }
  if (mod && !event.shiftKey && !event.altKey && (event.code === 'KeyT' || event.key === 't')) return 'new-tab'
  if (mod && !event.shiftKey && !event.altKey && (event.code === 'KeyW' || event.key === 'w')) return 'close-tab'
  if (mod && (event.code === 'Tab' || event.key === 'Tab')) return event.shiftKey ? 'prev-tab' : 'next-tab'
  if (key === 'F5') return mod ? 'hard-reload' : 'reload'
  if (mod && code === 'KeyR') return 'reload'
  if (mod && event.shiftKey && code === 'KeyL') return 'accounts'
  if (mod && event.shiftKey && code === 'KeyT') return 'templates'
  if (mod && code === 'KeyL') return 'focus-address'
  if (mod && code === 'KeyF') return 'find'
  if (mod && code === 'KeyP') return 'print'
  if (mod && event.shiftKey && code === 'KeyS') return 'screenshot'
  // Numpad: DOM-key зависит от NumLock/раскладки, поэтому ловим и по code
  // (паритет с guestShortcutName в main, где numpad маппится явно).
  if (mod && (key === '=' || key === '+' || code === 'NumpadAdd')) return 'zoom-in'
  if (mod && (key === '-' || key === '_' || code === 'NumpadSubtract')) return 'zoom-out'
  if (mod && (key === '0' || code === 'Numpad0')) return 'zoom-reset'
  if (mod && code === 'Comma') return 'settings'
  if (event.altKey && key === 'ArrowLeft') return 'back'
  if (event.altKey && key === 'ArrowRight') return 'forward'
  if (key === 'F11') return 'fullscreen'
  if (key === 'F1' && !mod) return 'help'
  if (key === 'Escape') return 'escape'
  return null
}

/** Снимок активной вкладки: PNG приходит в превью, на диск пишет сам пользователь */
async function captureActiveTabScreenshot(): Promise<void> {
  const view = activeView()
  if (!view) {
    setStatus('нет активной вкладки')
    return
  }
  try {
    openShotPreview(await window.shell.captureScreenshot(view.getWebContentsId()))
  } catch {
    setStatus('снимок не удался')
  }
}

/**
 * Открывает превью снимка. main отдаёт PNG как data URL и имя файла по
 * умолчанию; на диск ничего не пишется, пока пользователь не нажмёт
 * «Сохранить как…» или «Копировать».
 */
const helpOverlay = document.getElementById('help-overlay') as HTMLElement | null

/** Справочник по клавишам и возможностям. Содержимое статичное — в разметке. */
function openHelp(): void {
  if (!helpOverlay) return
  helpOverlay.hidden = false
}

function closeHelp(): void {
  if (!helpOverlay) return
  helpOverlay.hidden = true
}

function toggleHelp(): void {
  if (helpOverlay?.hidden) openHelp()
  else closeHelp()
}

function wireHelp(): void {
  document.getElementById('btn-help')?.addEventListener('click', toggleHelp)
  document.getElementById('help-close-x')?.addEventListener('click', closeHelp)
  helpOverlay?.addEventListener('click', (event) => {
    if (event.target === helpOverlay) closeHelp()
  })
}

function openShotPreview(result: ScreenshotResult): void {
  if (!result || !result.ok || !result.dataUrl) {
    setStatus('снимок не удался')
    return
  }
  const guestId = activeView()?.getWebContentsId() ?? 0
  if (!guestId) {
    setStatus('нет активной вкладки')
    return
  }
  const shown = shotPreview?.open({
    dataUrl: result.dataUrl,
    name: result.name || 'снимок.png',
    guestId,
  })
  if (!shown) setStatus('снимок не удался')
}

/**
 * Характерный щелчок затвора при успешном снимке — два коротких щелчка
 * с интервалом, как у механического затвора. Синтезируем на месте (WebAudio),
 * чтобы не тащить звуковой файл в проект; по образцу playTnBeep.
 */
function playShutterClick(): void {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.value = 0.22
    // Два щелчка: первый резкий, второй чуть тише и ниже — так узнаётся затвор
    for (const [delayMs, freq] of [[0, 1800], [70, 1250]] as const) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      // Быстрый спад: иначе щелчок превращается в квак
      env.gain.setValueAtTime(0, ctx.currentTime + delayMs / 1000)
      env.gain.linearRampToValueAtTime(1, ctx.currentTime + delayMs / 1000 + 0.002)
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delayMs / 1000 + 0.05)
      osc.connect(env)
      env.connect(gain)
      osc.start(ctx.currentTime + delayMs / 1000)
      osc.stop(ctx.currentTime + delayMs / 1000 + 0.06)
    }
    setTimeout(() => { ctx.close().catch(() => undefined) }, 500)
  } catch { /* звук не критичен для снимка */ }
}

function wireShortcuts(): void {
  // Шорткаты, когда фокус в shell-UI (тулбар, адресная строка).
  // Когда фокус внутри страницы — те же имена прилетают из main-процесса
  // через before-input-event (см. window.shell.onShortcut ниже).
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const name = shortcutFromEvent(event)
    if (!name) return
    // Esc в поле поиска обрабатывается локально в wireFindbar
    if (isFindInput(event.target) && event.key === 'Escape') return
    event.preventDefault()
    void handleShortcut(name)
  })
  window.shell.onShortcut((name) => void handleShortcut(name))
  // Снимок из контекстного меню main: результат прилетает событием.
  window.shell.onScreenshotPreview((result) => openShotPreview(result))
}

function wireAddressMenu(): void {
  const popup = document.getElementById('address-menu') as HTMLElement | null
  const button = document.getElementById('address-menu-btn') as HTMLButtonElement | null
  const zoomValue = document.getElementById('address-zoom-value') as HTMLElement | null
  if (!popup || !button || !zoomValue || !addressInput) return
  const zoomOut = document.getElementById('address-zoom-out') as HTMLElement | null
  const zoomIn = document.getElementById('address-zoom-in') as HTMLElement | null
  const find = document.getElementById('address-menu-find') as HTMLElement | null
  const copy = document.getElementById('address-menu-copy') as HTMLElement | null
  const print = document.getElementById('address-menu-print') as HTMLElement | null
  if (!zoomOut || !zoomIn || !find || !copy || !print) return
  addressMenu = createAddressMenu(
    { button, popup, zoomOut, zoomValue, zoomIn, find, copy, print, input: addressInput },
    {
      onZoom: (dir) => {
        void changeZoom(dir)
      },
      onFind: () => openFind(),
      onCopy: () => {
        const url = currentViewUrl()
        if (!url) {
          setStatus('нечего копировать')
          return
        }
        void window.shell
          .copyText(url)
          .then((ok) => setStatus(ok ? 'адрес скопирован' : 'не удалось скопировать адрес'))
          .catch(() => setStatus('не удалось скопировать адрес'))
      },
      onPrint: () => {
        void openPrintDialog(activeTab())
      },
    },
  )
  // Подпись масштаба должна совпадать с реальным зумом активной вкладки
  try {
    addressMenu.syncZoom(activeView()?.getZoomFactor() ?? 1)
  } catch {
    /* гость ещё не готов */
  }
}

/** Превью снимка экрана: картинка + «Сохранить как…» / «Копировать» */
function wireShotPreview(): void {
  const overlay = document.getElementById('shot-overlay') as HTMLElement | null
  const image = document.getElementById('shot-image') as HTMLImageElement | null
  const caption = document.getElementById('shot-caption') as HTMLElement | null
  const save = document.getElementById('shot-save') as HTMLButtonElement | null
  const copy = document.getElementById('shot-copy') as HTMLButtonElement | null
  const closeX = document.getElementById('shot-close-x') as HTMLButtonElement | null
  if (!overlay || !image || !caption || !save || !copy || !closeX) return
  shotPreview = createShotPreview(
    { overlay, image, caption, save, copy, close: closeX },
    {
      onSave: (shot) => {
        void window.shell
          .saveScreenshotAs(shot.dataUrl, shot.guestId)
          .then((res) => {
            if (res && res.ok) setStatus('снимок сохранён')
            // false = пользователь отменил диалог — молчим, как и в печати
            else if (res) setStatus('не удалось сохранить снимок')
          })
          .catch(() => setStatus('не удалось сохранить снимок'))
      },
      onCopy: (shot) => {
        void window.shell
          .copyScreenshotImage(shot.dataUrl)
          .then((ok) => setStatus(ok ? 'снимок в буфере обмена' : 'не удалось скопировать'))
          .catch(() => setStatus('не удалось скопировать'))
      },
      onOpen: () => playShutterClick(),
    },
  )
}

/** Ширина миниатюры превью печати, CSS-px. Должна совпадать с .print-thumb в styles.css. */
const PRINT_THUMB_WIDTH = 210
/** z-index оверлея печати на время показа: поднимаем выше карточки задачи
 *  (#task-alert, 100), иначе она ложится прямо на панель печати */
const PRINT_OVERLAY_Z = 200

function printElements(): PrintDialogElements | null {
  const get = (id: string): HTMLElement | null => document.getElementById(id)
  const ids: Record<keyof PrintDialogElements, string> = {
    overlay: 'print-overlay',
    title: 'print-title',
    destination: 'print-destination',
    printerRow: 'print-printer-row',
    rangeMode: 'print-range-mode',
    rangeCustom: 'print-range-custom',
    rangeFrom: 'print-range-from',
    rangeTo: 'print-range-to',
    copies: 'print-copies',
    landscape: 'print-landscape',
    pageSize: 'print-page-size',
    marginTop: 'print-margin-top',
    marginBottom: 'print-margin-bottom',
    marginLeft: 'print-margin-left',
    marginRight: 'print-margin-right',
    noMargins: 'print-no-margins',
    scale: 'print-scale',
    printBackground: 'print-background',
    displayHeaderFooter: 'print-header-footer',
    thumbs: 'print-thumbs',
    thumbsNote: 'print-thumbs-note',
    showAll: 'print-show-all',
    pageCounter: 'print-page-counter',
    status: 'print-status',
    cancel: 'print-cancel',
    savePdf: 'print-save',
    print: 'print-go',
    settings: 'print-settings',
  }
  const out = {} as Record<keyof PrintDialogElements, HTMLElement>
  for (const key of Object.keys(ids) as Array<keyof PrintDialogElements>) {
    const el = get(ids[key])
    if (!el) return null
    out[key] = el
  }
  return out as PrintDialogElements
}

/** Снять отложенный пересчёт превью: перед новым таймером и перед «Показать все».
 *  Возвращает true, если таймер ДЕЙСТВИТЕЛЬНО был запланирован и его сняли, —
 *  вызывающему нужно знать это, чтобы перевзводить пересчёт только тогда,
 *  когда есть что пересчитывать (см. клик по «Показать все»). */
function cancelScheduledPrintRefresh(): boolean {
  if (printRefreshTimer === null) return false
  window.clearTimeout(printRefreshTimer)
  printRefreshTimer = null
  return true
}

/** Пересчёт превью с debounce: поля меняются мышью, PDF печатать не каждый раз */
function schedulePrintRefresh(): void {
  cancelScheduledPrintRefresh()
  printRefreshTimer = window.setTimeout(() => {
    printRefreshTimer = null
    // Пока идёт печать/сохранение/«Показать все», refresh() нельзя: он сбрасывает
    // busy в своём finally и вернул бы кнопки под системным диалогом (или
    // перебил renderAllThumbs по generation и сбросил showAll). Поэтому не
    // пропускаем пересчёт, а перевзводим таймер — окно занятости узкое.
    if (printDialog?.isBusy()) {
      schedulePrintRefresh()
      return
    }
    void printDialog?.refresh()
  }, 250)
}

/**
 * Единственная точка входа в диалог печати: Ctrl+P, пункт меню адреса
 * и «Печать…» из контекстного меню гостя.
 */
async function openPrintDialog(tab: ShellTab | null): Promise<void> {
  if (!tab) {
    setStatus('нет активной вкладки')
    return
  }
  if (!printDialog) {
    setStatus('диалог печати недоступен')
    return
  }
  if (printDialog.isOpen()) return
  // Цель печати фиксируем здесь и навсегда: хоткеи слушаются на window, оверлей их
  // не перехватывает, поэтому Ctrl+Tab/Ctrl+3 во время печати сделал бы активной
  // другую вкладку — и превью, печать и имя PDF поехали бы на чужой документ
  printTargetView = tab.view ?? activeView()
  await printDialog.open(normalizePrintSettings(config?.print))
  // Контроллер пересобрал «Назначение» и заполнил поля — досинхронизируем нашу
  // часть (строка принтера, список бумаги) под фактический выбор
  printPanelSync?.()
}

/** Заголовок документа для шапки диалога и имени PDF — всегда у зафиксированной
 *  цели печати, иначе Ctrl+Tab переименовал бы сохраняемый файл */
function titleForPrint(): string {
  try {
    return (printTargetView ?? activeView())?.getTitle() ?? ''
  } catch {
    return ''
  }
}

function wirePrintDialog(): void {
  const elements = printElements()
  if (!elements) return
  // Цель, снятая при открытии диалога; activeView() — запасной путь, если
  // openPrintDialog цели не зафиксировал (например, гость не дал view)
  const view = (): SewWebViewElement | null => printTargetView ?? activeView()

  // Строка «Принтер» в разметке пустая: контроллер умеет только скрывать её,
  // содержимое собираем здесь через DOM API (без innerHTML — текст небезопасен)
  const printerCaption = document.createElement('span')
  printerCaption.className = 'print-label'
  printerCaption.textContent = 'Принтер'
  const printerInfo = document.createElement('span')
  printerInfo.className = 'print-label'
  printerInfo.style.color = 'var(--text-2)'
  elements.printerRow.replaceChildren(printerCaption, printerInfo)

  const destinationSelect = elements.destination as HTMLSelectElement
  const paperSelect = elements.pageSize as HTMLSelectElement

  /** Принтер, выбранный в «Назначении»; null — PDF или принтер исчез из списка */
  const selectedPrinter = (): ShellPrinter | null =>
    printPrinters.find((p) => p.name === destinationSelect.value) ?? null

  /**
   * Список бумаги. В режиме принтера A6 убираем: webview.print его не понимает,
   * и printOptions тогда молча ставит usePrinterDefaultPageSize — пользователь
   * получил бы бумагу принтера по умолчанию вместо выбранной. Для PDF A6 доступен.
   */
  const paperNames = (forPrinter: boolean): PrintPageSizeName[] => {
    // A4 первым (самый частый), остальные в порядке PRINT_PAPER_NAMES
    const base: PrintPaperName[] = ['A4', ...PRINT_PAPER_NAMES.filter((name) => name !== 'A4')]
    return forPrinter ? base : [...base, 'A6']
  }

  const repaintPaper = (forPrinter: boolean): void => {
    const names = paperNames(forPrinter)
    const previous = paperSelect.value
    paperSelect.replaceChildren(
      ...names.map((name) => {
        const option = document.createElement('option')
        option.value = name
        option.textContent = name
        return option
      }),
    )
    // Значение могло остаться от режима PDF (A6) или от прежнего списка: пустой
    // select выглядит как поломка, поэтому откатываемся на первый размер
    paperSelect.value = (names as readonly string[]).includes(previous) ? previous : names[0]
  }

  const repaintPrinterRow = (): void => {
    const printer = selectedPrinter()
    printerInfo.textContent = printer
      ? `${printer.displayName || printer.name}${printer.description ? ` — ${printer.description}` : ''}`
      : 'Файл PDF, принтер не используется'
  }

  const syncPrintPanel = (): void => {
    const forPrinter = selectedPrinter() !== null
    repaintPaper(forPrinter)
    repaintPrinterRow()
  }
  printPanelSync = syncPrintPanel

  // Слои и срок жизни цели: тост (#toast, 50) во время печати только шумит под
  // затемнением, а карточка задачи (#task-alert, 100) легла бы прямо на панель.
  // Поэтому на время показа поднимаем оверлей над обоими, тост гасим вместе с
  // таймером, а по закрытию забываем цель печати.
  const watchPrintOverlay = (): void => {
    const apply = (): void => {
      const visible = !elements.overlay.hidden
      elements.overlay.style.zIndex = visible ? String(PRINT_OVERLAY_Z) : ''
      // Диалог закрыт (любой путь: Отмена, крестик, Escape, клик по фону,
      // closeNow после печати) — цель больше не нужна
      if (!visible) printTargetView = null
      if (!visible) return
      hideToast()
    }
    apply()
    // Наблюдатель, а не вызовы в точках закрытия: контроллер закрывает оверлей
    // сам (после печати/сохранения) и отдельного хука не даёт
    new MutationObserver(apply).observe(elements.overlay, {
      attributes: true,
      attributeFilter: ['hidden'],
    })
  }

  const hooks: PrintDialogHooks = {
    listPrinters: async () => {
      const list = await window.shell.listPrinters()
      // description в ShellPrinter обязателен, а из main может прийти пустым
      printPrinters = (Array.isArray(list) ? list : []).map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || p.displayName || p.name,
      }))
      return printPrinters
    },
    buildPdf: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      return target.printToPDF(printToPdfOptions(settings))
    },
    // pdf.js весит около мегабайта, а печатает пользователь далеко не всегда —
    // тянем модуль лениво, при первом открытии диалога.
    renderThumbs: async (data, limit) => {
      const { renderPdfThumbnails } = await import('./print-preview')
      return renderPdfThumbnails(data, PRINT_THUMB_WIDTH, limit)
    },

    doPrint: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      const pageCount = printDialog?.pageCount() ?? 0
      const current = printDialog?.currentPage() ?? 1
      await target.print(printOptions(settings, settings.deviceName, pageCount, current))
    },
    doSavePdf: async (_settings, bytes) => {
      const name = suggestedPdfName(titleForPrint())
      return window.shell.savePdf(bytesToBase64(bytes), name)
    },
    documentTitle: () => titleForPrint(),
    persist: async (settings) => {
      config = await window.shell.setConfig({ print: settings })
    },
  }
  printDialog = createPrintDialog(elements, hooks)
  // Любое изменение настроек пересчитывает превью
  elements.settings.addEventListener('change', schedulePrintRefresh)
  elements.settings.addEventListener('input', schedulePrintRefresh)
  // Смена назначения меняет и список бумаги, и строку принтера. Слушатель висит
  // на самом select: он сработает раньше контейнера #print-settings, значит
  // refresh() уже прочитает исправленные значения
  elements.destination.addEventListener('change', syncPrintPanel)
  // «Поля: нет» проставляет значения через fill(): ни input, ни change оно не
  // порождает, а клик по <button> их тоже не даёт — превью без пересчёта
  // осталось бы старым. Идём через schedulePrintRefresh: refresh() напрямую
  // сбросил бы busy, если клик пришёлся на печать/сохранение (их кнопки
  // блокируются, а поля полей — нет)
  elements.noMargins.addEventListener('click', schedulePrintRefresh)
  // «Показать все» — самое свежее намерение пользователя, поэтому отложенный
  // пересчёт снимаем: иначе он отработал бы сразу после runAction и опять
  // показал только первые 10 миниатюр (refresh обнуляет showAll). Но снимать его
  // «насовсем» тоже нельзя: правка поля, сделанная в предшествующие 250 мс, молча
  // выпала бы из превью. Поэтому таймер перевзводим ТОЛЬКО если он реально был
  // запланирован: иначе (обычный клик, без свежих правок) мы бы через 250 мс
  // вызвали refresh(), который детерминированно сбросил бы showAll и вернул ленту
  // к первым 10 миниатюрам — «Показать все» стал бы недостижимым на документах
  // длиннее 10 страниц. schedulePrintRefresh сам переждёт конца runAction
  // (isBusy) и дольёт превью по актуальным полям.
  elements.showAll.addEventListener('click', () => {
    if (cancelScheduledPrintRefresh()) schedulePrintRefresh()
  })
  // Клик по фону оверлея закрывает диалог
  elements.overlay.addEventListener('click', (event) => {
    if (event.target === elements.overlay) printDialog?.close()
  })
  document.getElementById('print-cancel-x')?.addEventListener('click', () => printDialog?.close())
  watchPrintOverlay()
  syncPrintPanel()
}

function wireToolbar(): void {
  wireAddressMenu()
  wirePrintDialog()
  wireShotPreview()
  btnBack?.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab || !canTabGoBack(tab)) return
    noteTabHistory(tab, -1)
    tab.view.goBack()
  })
  btnForward?.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab || !canTabGoForward(tab)) return
    noteTabHistory(tab, 1)
    tab.view.goForward()
  })
  document.getElementById('btn-home')?.addEventListener('click', () => {
    if (config) void navigate(config.startUrl)
  })
  document.getElementById('btn-mvideo')?.addEventListener('click', () => {
    focusOrOpenTab('https://www.mvideo.ru/')
  })
  document.getElementById('btn-reload')?.addEventListener('click', () => {
    const view = activeView()
    if (view) view.reload()
  })
  document.getElementById('btn-barcode')?.addEventListener('click', () => {
    focusOrOpenTab('https://monutor.github.io/warehouse-barcode-generator/')
  })
  document.getElementById('btn-products')?.addEventListener('click', () => {
    focusOrOpenTab('https://monutor.github.io/DataBaseProducts/')
  })
  document.getElementById('btn-accounts')?.addEventListener('click', () => void openAccounts(true))
  document.getElementById('btn-screenshot')?.addEventListener('click', () => void captureActiveTabScreenshot())
  // NB: btn-templates подписывается в wireTemplates() — дубль здесь давал
  // двойной openTemplates() и задвоенный список шаблонов.

  if (addressInput) {
    addressInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') void navigate(addressInput.value)
    })
  }

  document.getElementById('btn-min')?.addEventListener('click', () => window.shell.windowMin())
  document.getElementById('btn-max')?.addEventListener('click', () => window.shell.windowMax())
  document.getElementById('btn-close')?.addEventListener('click', () => window.shell.windowClose())

  document.getElementById('btn-scans')?.addEventListener('click', async () => {
    const tab = activeTab()
    if (!tab) return
    try {
      await guestJS<void>(tab, 'scans-open', '(function(){try{window.dispatchEvent(new CustomEvent("scans-block:open"))}catch(e){}})()')
    } catch (err) {
      console.warn('[shell] failed to open scans block:', err)
    }
  })

  // DevTools webview — только в debug-режиме
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && config?.debug) {
      event.preventDefault()
      const view = activeView()
      if (view) view.openDevTools()
    }
  })
}

/**
 * Оригинальная иконка сайта: читаем `<link rel="icon">` из гостя, картинку
 * забирает main (оболочка CORS не обойдёт) и отдаёт готовый data-URL.
 * Кэш по хосту: иконка у сайта одна, перерисовывать её на каждый did-navigate незачем.
 */
const FAVICON_CACHE_LIMIT = 200
const faviconCache = new Map<string, string>()

async function loadTabFavicon(tab: ShellTab): Promise<void> {
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
function wireTabEvents(tab: ShellTab): void {
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
    // Привязка гостевого webContents для перехвата хоткеев внутри страницы
    try {
      window.shell.attachGuest(view.getWebContentsId())
    } catch (err) {
      console.warn('[shell] guest attach failed:', err)
    }
  })
  view.addEventListener('page-title-updated', (event) => {
    setTabTitle(tab, event.title)
    if (isActiveTab(tab)) updateTitlebarTitle()
  })
  view.addEventListener('did-navigate', (event) => {
    // Новый документ = новое window → флаг готовности старого хука мёртв.
    // did-navigate-in-page сюда НЕ попадает (там тот же документ, хук жив).
    linkHookReady.delete(view)
    guestReady.delete(view)
    console.log('[shell] did-navigate:', event.url)
    if (isAllowed(event.url)) {
      setTabUrl(tab, event.url)
      noteTabNavigated(tab)
      if (isActiveTab(tab)) {
        updateAddressBar()
        updateTitlebarTitle()
        updateNavButtons()
        applyZoomForCurrentPage()
        updateActiveTab()
      }
    } else {
      // Показываем заблокированный хост — так проще дополнять allowlist
      const blocked = hostOf(event.url) || event.url
      if (isActiveTab(tab)) setStatus(`blocked: ${blocked}`)
      // Откатываемся на lastAllowedUrl, но только если он сам разрешён: вкладка,
      // открытая по не-allowlisted ссылке, иначе зациклится сама на себя
      // (did-navigate → bounce-back на тот же URL → did-navigate → …).
      const fallback = tab.lastAllowedUrl
      if (!fallback || !isAllowed(fallback)) {
        if (isActiveTab(tab)) showError(`Хост ${blocked} не разрешён allowlist`)
        return
      }
      void view.loadURL(fallback).catch((err) => console.warn('[shell] bounce-back failed:', err))
    }
  })
  view.addEventListener('did-navigate-in-page', (event) => {
    setTabUrl(tab, event.url)
    if (isActiveTab(tab)) updateAddressBar()
  })
  view.addEventListener('did-finish-load', () => {
    void injectPlugins(tab, plugins)
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
    if (isActiveTab(tab)) updateTitlebarTitle()
    // Появилась форма входа? Предлагаем выбрать аккаунт (с паузой —
    // SPA достраивает форму уже после события загрузки)
    if (isActiveTab(tab)) setTimeout(() => void checkLoginForm(false), 1200)
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
    loginPrompted = false
    if (!isActiveTab(tab)) return
    hideError()
    toolbar?.classList.add('loading')
  })
  view.addEventListener('did-stop-loading', () => {
    if (!isActiveTab(tab)) return
    toolbar?.classList.remove('loading')
  })
  view.addEventListener('found-in-page', (event) => {
    if (!isActiveTab(tab)) return
    const result = event.result
    if (!result.finalUpdate) return
    renderFindCount(result.matches, result.activeMatchOrdinal)
  })
}

function startStatusPolling(): void {
  setInterval(async () => {
    const tab = activeTab()
    if (!tab) return
    try {
      const count = await guestJS<unknown>(tab, 'datalog-count', '(window.__sewDataLog || []).length')
      setStatus(config?.debug ? `req: ${count} · debug` : `req: ${count}`, false)
    } catch {
      // страница ещё не готова — игнорируем
    }
  }, 2000)
}

// ---------- Шаблоны SEW (порт расширения SEW-Pattern) ----------
const TEMPLATES_PLUGIN = 'sew-pattern'

interface TemplateItem {
  id: string
  name?: string
  preset?: string
  fields?: Record<string, string>
}

async function loadTemplateItems(): Promise<TemplateItem[]> {
  try {
    const data = await window.shell.pluginDataGet(TEMPLATES_PLUGIN, ['sew_templates'])
    return Array.isArray(data.sew_templates) ? (data.sew_templates as TemplateItem[]) : []
  } catch (err) {
    console.warn('[templates] load failed:', err)
    return []
  }
}

/** chrome-совместимая прослойка для options.js расширения (выполняется в shell-окне) */
function makeShellChrome(pluginName: string): unknown {
  // Отписки onChanged: без карты removeListener не мог снять конкретный обработчик.
  const changedUnsubs = new Map<(changes: Record<string, { newValue: unknown }>, area: string) => void, () => void>()
  const pickGet = (
    keys: unknown,
    cb?: (res: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | undefined => {
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : undefined
    const p = window.shell.pluginDataGet(pluginName, list).then((all) => {
      if (keys === undefined || keys === null) return all
      if (typeof keys === 'string') return all[keys] !== undefined ? { [keys]: all[keys] } : {}
      if (typeof keys === 'object' && !Array.isArray(keys)) {
        // Форма { key: defaultValue }: отсутствующие ключи подменяются дефолтами (семантика Chrome).
        const defaults = keys as Record<string, unknown>
        const withDefaults: Record<string, unknown> = {}
        for (const k of Object.keys(defaults)) withDefaults[k] = all[k] !== undefined ? all[k] : defaults[k]
        return withDefaults
      }
      const out: Record<string, unknown> = {}
      for (const k of list ?? []) out[k] = all[k]
      return out
    })
    if (typeof cb === 'function') {
      p.then(cb)
      return undefined
    }
    return p
  }
  return {
    storage: {
      local: {
        get: pickGet,
        set: (obj: Record<string, unknown>, cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataSet(pluginName, obj)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
        remove: (keys: string[], cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataRemove(pluginName, keys)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue: unknown }>, area: string) => void): void => {
          if (changedUnsubs.has(fn)) return // повторный add того же fn — не дублируем
          const unsub = window.shell.onPluginDataChanged(({ plugin }) => {
            if (plugin !== pluginName) return
            try {
              fn({ sew_templates: { newValue: true } }, 'local')
            } catch {
              // игнорируем
            }
          })
          changedUnsubs.set(fn, unsub)
        },
        removeListener: (fn: (changes: Record<string, { newValue: unknown }>, area: string) => void): void => {
          changedUnsubs.get(fn)?.()
          changedUnsubs.delete(fn)
        },
      },
    },
    runtime: { lastError: undefined as undefined },
  }
}

let templatesRefreshCall = 0

async function refreshTemplatesList(): Promise<void> {
  if (!templatesList) return
  const myCall = ++templatesRefreshCall
  templatesList.innerHTML = ''
  const templates = await loadTemplateItems()
  // Пока грузили, мог прийти более свежий вызов (двойной клик, хоткей + кнопка) —
  // устаревший результат не рисуем, иначе строки задвоятся.
  if (myCall !== templatesRefreshCall) return
  if (templates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'settings-row'
    empty.textContent = 'Нет шаблонов. Откройте «Управление шаблонами» и создайте первый.'
    templatesList.append(empty)
    return
  }
  for (const tpl of templates) {
    const fieldCount = tpl.fields ? Object.keys(tpl.fields).length : 0
    const presetName = tpl.preset === 'trn' ? 'ТрН' : tpl.preset || 'ТрН'
    const row = document.createElement('div')
    row.className = 'templates-row'
    const name = document.createElement('span')
    name.className = 'tpl-name'
    name.textContent = tpl.name || 'Без имени'
    const meta = document.createElement('span')
    meta.className = 'tpl-meta'
    meta.textContent = `${presetName} · ${fieldCount} полей`
    row.append(name, meta)
    row.addEventListener('click', () => void applyTemplateFromShell(tpl.id))
    templatesList.append(row)
  }
}

async function openTemplates(): Promise<void> {
  if (!templatesOverlay) return
  await refreshTemplatesList()
  templatesOverlay.hidden = false
  templatesOpen = true
}

function closeTemplates(): void {
  if (!templatesOverlay) return
  templatesOverlay.hidden = true
  templatesOpen = false
}

/** Применить шаблон к открытой форме SEW — через onMessage-подписку content-скрипта */
async function applyTemplateFromShell(id: string): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  try {
    const delivered = await guestJS<boolean>(
      tab,
      'apply-template',
      `typeof window.__chromeShimReceive === 'function'` +
        ` ? (window.__chromeShimReceive({action:'applyTemplate',templateId:${JSON.stringify(id)}}), true)` +
        ` : false`,
    )
    closeTemplates()
    setStatus(delivered ? 'шаблон применён' : 'откройте форму в SEW и повторите')
  } catch (err) {
    console.warn('[templates] apply failed:', err)
    setStatus('не удалось применить шаблон')
  }
}

function openTemplatesManage(): void {
  if (!templatesManageOverlay) return
  templatesManageOverlay.hidden = false
  templatesManageOpen = true
}

function closeTemplatesManage(): void {
  if (!templatesManageOverlay) return
  templatesManageOverlay.hidden = true
  templatesManageOpen = false
}

// ---------- Вкладки навигации ----------

function openTabs(): void {
  if (!tabsOverlay) return
  editingTabId = null
  editingFolderId = null
  resetFolderForm()
  tabForm && (tabForm.hidden = true)
  refreshTabsList()
  tabsOverlay.hidden = false
  tabsOpen = true
}

function closeTabs(): void {
  if (!tabsOverlay) return
  tabsOverlay.hidden = true
  tabsOpen = false
  editingTabId = null
  editingFolderId = null
  resetFolderForm()
  tabForm && (tabForm.hidden = true)
}

function generateTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

/** Сентинель для вкладок без папки (не может совпасть с реальным id — начинается с _). */
const UNASSIGNED_FOLDER = '__unassigned__'

function hasUserFolders(): boolean {
  return (config?.folders ?? []).length > 0
}

/** Папки в порядке хранения + фиктивная секция «Без папки» в начале. */
function orderedGroups(): Array<{ id: string; name: string; passwordId?: string }> {
  return [{ id: UNASSIGNED_FOLDER, name: 'Без папки' }, ...(config?.folders ?? [])]
}

/** Вкладки конкретной папки (UNASSIGNED_FOLDER — вкладки без folderId). */
function tabsInFolder(folderId: string): NavTab[] {
  const tabs = config?.tabs ?? []
  if (folderId === UNASSIGNED_FOLDER) return tabs.filter((t) => !t.folderId)
  return tabs.filter((t) => t.folderId === folderId)
}

function generateFolderId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

async function saveFolders(folders: NavFolder[]): Promise<void> {
  const updated = await window.shell.setConfig({ folders })
  if (updated && 'folders' in updated) config = updated as ShellConfig
  closeGroupPanel()
  renderStrip()
  refreshTabsList()
}

/** Свернуть/развернуть секцию папки в ленте и оверлее. */
function toggleFolderCollapse(folderId: string): void {
  if (collapsedFolders.has(folderId)) collapsedFolders.delete(folderId)
  else collapsedFolders.add(folderId)
  renderStrip()
  refreshTabsList()
}

/** Заполнить <select> папками (всегда есть опция «Без папки»). */
function fillFolderSelect(sel: HTMLSelectElement, folderId: string | undefined): void {
  sel.innerHTML = ''
  const unassigned = document.createElement('option')
  unassigned.value = UNASSIGNED_FOLDER
  unassigned.textContent = 'Без папки'
  sel.append(unassigned)
  for (const f of config?.folders ?? []) {
    const opt = document.createElement('option')
    opt.value = f.id
    opt.textContent = f.name
    sel.append(opt)
  }
  sel.value = folderId ?? UNASSIGNED_FOLDER
}

async function saveTabs(tabs: NavTab[]): Promise<void> {
  const updated = await window.shell.setConfig({ tabs })
  if (updated && 'tabs' in updated) config = updated as ShellConfig
  closeGroupPanel()
  renderStrip()
  refreshTabsList()
}

function currentViewUrl(): string {
  try {
    return activeView()?.getURL() ?? ''
  } catch {
    return ''
  }
}

// Лента ссылок в третьей строке оболочки (под полосой вкладок и тулбаром).
// Всегда видима (даже при пустом списке), иначе кнопки +/⋮ внутри скрытой
// ленты недостижимы, а в тулбаре отдельной кнопки не было — на чистой
// установке вкладки нельзя было создать. При отсутствии папок — плоская лента
// (обратная совместимость); при наличии вкладки без папки отображаются плоскими
// строками, а по реальным папкам строятся группы, раскрытие которых показывает
// список вкладок выпадающим блоком под лентой.
function renderStrip(): void {
  if (!tabstrip || !tabsEl || !config) return
  tabstrip.hidden = false
  tabsEl.innerHTML = ''
  const current = currentViewUrl()
  // Вкладки без папки отображаем плоскими строками (без группы «Без папки»).
  for (const tab of tabsInFolder(UNASSIGNED_FOLDER)) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab' + (tab.url === current ? ' active' : '')
    btn.dataset.url = tab.url
    btn.textContent = tab.name
    btn.title = tab.url
    btn.addEventListener('click', () => focusOrOpenTab(tab.url))
    tabsEl.append(btn)
  }
  if (!hasUserFolders()) return
  for (const group of orderedGroups()) {
    if (group.id === UNASSIGNED_FOLDER) continue
    const groupTabs = tabsInFolder(group.id)
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'tab-group-header'
    header.dataset.folderId = group.id
    const chevron = document.createElement('span')
    chevron.className = 'tab-group-chevron'
    chevron.textContent = expandedGroupId === group.id ? '▼' : '▶'
    const label = document.createElement('span')
    label.className = 'tab-group-name'
    label.textContent = group.name
    const count = document.createElement('span')
    count.className = 'tab-group-count'
    count.textContent = String(groupTabs.length)
    header.append(chevron, label, count)
    header.title = group.id === UNASSIGNED_FOLDER ? `Вкладки без папки (${groupTabs.length})` : `${group.name} (${groupTabs.length})`
    header.addEventListener('click', () => toggleExpandInStrip(group.id))
    tabsEl.append(header)
  }
}

/** Развернуть вкладки папки списком под лентой (по одному). Повторный клик — свернуть.
 *  Защищённую папку разворачиваем только после ввода правильного пароля. */
async function toggleExpandInStrip(folderId: string): Promise<void> {
  // Свёрнутая папка — разворачиваем (защищённую: с запросом пароля).
  if (expandedGroupId === folderId) {
    closeGroupPanel()
    renderStrip()
    return
  }
  const group = orderedGroups().find((g) => g.id === folderId)
  // Защищённую папку разворачиваем только после ввода правильного пароля.
  if (group?.passwordId && (await promptFolderPassword(folderId)) === null) return // Отмена.
  expandedGroupId = folderId
  renderStrip()
  renderGroupPanel()
}

/** Скрыть выпадающий список папки и снять обработчики. */
function closeGroupPanel(): void {
  expandedGroupId = null
  if (tabGroupPanel) tabGroupPanel.hidden = true
  if (tabGroupPanel) tabGroupPanel.innerHTML = ''
  if (panelOutsideHandler) {
    document.removeEventListener('click', panelOutsideHandler, true)
    panelOutsideHandler = null
  }
}

/** Построить выпадающий список вкладок развёрнутой папки под лентой. */
function renderGroupPanel(): void {
  if (!tabGroupPanel) return
  if (expandedGroupId === null) {
    closeGroupPanel()
    return
  }
  const group = orderedGroups().find((g) => g.id === expandedGroupId)
  if (!group) {
    closeGroupPanel()
    return
  }
  const groupTabs = tabsInFolder(group.id)

  tabGroupPanel.innerHTML = ''
  const section = document.createElement('div')
  section.className = 'tg-section'
  const head = document.createElement('div')
  head.className = 'tg-section-head'
  const headName = document.createElement('span')
  headName.textContent = group.name
  const headCount = document.createElement('span')
  headCount.className = 'tg-count'
  headCount.textContent = `(${groupTabs.length})`
  head.append(headName, headCount)
  section.append(head)

  const list = document.createElement('div')
  list.className = 'tg-list'
  if (!groupTabs.length) {
    const empty = document.createElement('div')
    empty.className = 'tabs-empty-hint'
    empty.textContent = 'Нет вкладок'
    list.append(empty)
  }
  const current = currentViewUrl()
  for (const tab of groupTabs) {
    const row = document.createElement('div')
    row.className = 'tg-row' + (tab.url === current ? ' active' : '')
    row.dataset.url = tab.url
    const name = document.createElement('span')
    name.className = 'tg-name'
    name.textContent = tab.name
    name.title = tab.url
    const url = document.createElement('span')
    url.className = 'tg-url'
    url.textContent = tab.url
    row.append(name, url)
    row.addEventListener('click', () => {
      focusOrOpenTab(tab.url)
      closeGroupPanel()
    })
    list.append(row)
  }
  section.append(list)
  tabGroupPanel.append(section)

  // Показываем до измерения (display:none дает scrollWidth=0), всё синхронно — без мерцания.
  tabGroupPanel.hidden = false

  // Привязка под шапку папки: ширина из CSS, центрирование под кнопкой с отступом от краёв.
  const header = tabstrip?.querySelector<HTMLElement>(`.tab-group-header[data-folder-id="${expandedGroupId}"]`)
  if (header) {
    const rect = header.getBoundingClientRect()
    let left = rect.left + (rect.width - tabGroupPanel.offsetWidth) / 2
    left = Math.max(12, Math.min(left, window.innerWidth - 12 - tabGroupPanel.offsetWidth))
    tabGroupPanel.style.left = `${left}px`
  }

  wireGroupPanelDismiss()
}

/** Закрытие выпадающего списка: клик вне панели или Esc. */
function wireGroupPanelDismiss(): void {
  if (panelOutsideHandler) return
    panelOutsideHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      // Клик по строке вкладки — её собственный слушатель навигирует и закрывает.
      if (target && target.closest('.tg-row')) return
      // Клик по шапке группы обрабатывается её собственным слушателем — не закрываем.
      if (target && target.closest('.tab-group-header')) return
      closeGroupPanel()
    }
  document.addEventListener('click', panelOutsideHandler, true)
}

// Точечное обновление активного класса без пересборки ленты (без потери фокуса).
function updateActiveTab(): void {
  if (!tabsEl) return
  const current = currentViewUrl()
  for (const el of tabsEl.querySelectorAll<HTMLElement>('.tab')) {
    el.classList.toggle('active', el.dataset.url === current)
  }
  if (tabGroupPanel && expandedGroupId !== null) {
    for (const row of tabGroupPanel.querySelectorAll<HTMLElement>('.tg-row')) {
      row.classList.toggle('active', row.dataset.url === current)
    }
  }
}

// Строка вкладки в оверлее: название/ссылка + перемещение по папке, поднять/
// опустить (в пределах папки), редактирование, удаление. Клик по строке —
// навигация; кнопки и селектор папки через stopPropagation.
function createTabRow(tab: NavTab): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tab-row'
  row.dataset.tabId = tab.id
  const info = document.createElement('div')
  info.className = 'tab-info'
  const name = document.createElement('span')
  name.className = 'tab-name'
  name.textContent = tab.name
  name.title = tab.url
  const url = document.createElement('span')
  url.className = 'tab-url'
  url.textContent = tab.url
  info.append(name, url)
  row.append(info)
  row.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest('.tab-row button') || (e.target as HTMLElement).closest('.tab-folder-select')) return
    void closeTabs()
    focusOrOpenTab(tab.url)
  })
  const up = tabRowButton('↑', 'Поднять выше', () => void moveTab(tab.id, -1))
  const down = tabRowButton('↓', 'Опустить ниже', () => void moveTab(tab.id, 1))
  const edit = tabRowButton('✎', 'Редактировать', () => openEditForm(tab))
  const del = tabRowButton('🗑', 'Удалить', () => void deleteTab(tab.id), 'tab-del')
  row.append(up, down, edit, del)
  const sel = document.createElement('select')
  sel.className = 'tab-folder-select'
  sel.title = 'Папка'
  fillFolderSelect(sel, tab.folderId)
  sel.addEventListener('change', (e: Event) => {
    const v = (e.target as HTMLSelectElement).value
    void moveTabToFolder(tab.id, v === UNASSIGNED_FOLDER ? null : v)
  })
  row.append(sel)
  return row
}

function tabRowButton(text: string, title: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = extraClass
  b.textContent = text
  b.title = title
  b.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); onClick() })
  return b
}

// Список вкладок в оверлее управления. При отсутствии папок — плоский список
// (как раньше); при наличии — секции по папкам со сворачиванием.
function refreshTabsList(): void {
  if (!tabsList || !config) return
  const cfg = config
  tabsList.innerHTML = ''
  if (!hasUserFolders()) {
    for (const tab of config.tabs) tabsList.append(createTabRow(tab))
    return
  }
  // Вкладки без папки — плоским списком (без секции «Без папки»).
  for (const tab of tabsInFolder(UNASSIGNED_FOLDER)) tabsList.append(createTabRow(tab))
  for (const group of orderedGroups()) {
    if (group.id === UNASSIGNED_FOLDER) continue
    const groupTabs = tabsInFolder(group.id)
    const section = document.createElement('div')
    section.className = 'folder-section' + (collapsedFolders.has(group.id) ? ' collapsed' : '')
    section.dataset.folderId = group.id
    const header = document.createElement('div')
    header.className = 'folder-header'
    const chevron = document.createElement('span')
    chevron.className = 'folder-chevron'
    chevron.textContent = collapsedFolders.has(group.id) ? '▶' : '▼'
    const titleEl = document.createElement('span')
    titleEl.className = 'folder-name'
    titleEl.textContent = group.name
    const count = document.createElement('span')
    count.className = 'folder-count'
    count.textContent = String(groupTabs.length)
    header.append(chevron, titleEl, count)
    // Сворачивание секции по клику на шапке (кнопки переименования/удаления — отдельно).
    header.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      if (target && target.closest('.folder-rename, .folder-del')) return
      toggleFolderCollapse(group.id)
    })
    if (group.id !== UNASSIGNED_FOLDER) {
      const rename = tabRowButton('✎', 'Переименовать', () => openFolderForm(cfg.folders.find((f) => f.id === group.id)))
      rename.className = 'folder-rename'
      header.append(rename)
      const del = tabRowButton('🗑', 'Удалить папку (вкладки станут «без папки»)', () => void deleteFolder(group.id), 'folder-del')
      header.append(del)
    }
    section.append(header)
    const body = document.createElement('div')
    body.className = 'folder-tabs'
    if (!groupTabs.length) {
      const empty = document.createElement('div')
      empty.className = 'tabs-empty-hint'
      empty.textContent = 'Нет вкладок'
      body.append(empty)
    }
    for (const tab of groupTabs) body.append(createTabRow(tab))
    section.append(body)
    tabsList.append(section)
  }
}

function openEditForm(tab: NavTab): void {
  editingTabId = tab.id
  if (tabNameInput) tabNameInput.value = tab.name
  if (tabUrlInput) tabUrlInput.value = tab.url
  if (tabFolderSelect) fillFolderSelect(tabFolderSelect, tab.folderId)
  tabForm && (tabForm.hidden = false)
  tabNameInput?.focus()
}

function resetForm(): void {
  editingTabId = null
  if (tabNameInput) tabNameInput.value = ''
  if (tabUrlInput) tabUrlInput.value = ''
  tabForm && (tabForm.hidden = true)
}

async function saveCurrentTab(): Promise<void> {
  const name = tabNameInput?.value.trim() ?? ''
  const urlRaw = tabUrlInput?.value.trim() ?? ''
  if (!name || !urlRaw) {
    setStatus('Укажите название и ссылку')
    return
  }
  const url = normalizeUrl(urlRaw)
  let folderId: string | undefined
  if (tabFolderSelect) {
    const v = tabFolderSelect.value
    folderId = v === UNASSIGNED_FOLDER ? undefined : v
  } else {
    const existing = config?.tabs.find((t) => t.id === editingTabId)
    folderId = existing?.folderId
  }
  const tabs = [...(config?.tabs ?? [])]
  if (editingTabId) {
    const i = tabs.findIndex((t) => t.id === editingTabId)
    if (i !== -1) tabs[i] = { ...tabs[i], name, url, folderId }
  } else {
    tabs.push({ id: generateTabId(), name, url, folderId })
  }
  await saveTabs(tabs)
  resetForm()
}

async function deleteTab(id: string): Promise<void> {
  if (!config || !window.confirm('Удалить вкладку?')) return
  const tabs = config.tabs.filter((t) => t.id !== id)
  await saveTabs(tabs)
}

// Перемещение вкладки вверх/вниз внутри своей папки (или «без папки»).
async function moveTab(id: string, dir: number): Promise<void> {
  if (!config) return
  const tabs = config.tabs
  const target = tabs.find((t) => t.id === id)
  if (!target) return
  const groupId = target.folderId ?? UNASSIGNED_FOLDER
  const groupTabs = tabs.filter((t) => (t.folderId ?? UNASSIGNED_FOLDER) === groupId)
  const idx = groupTabs.findIndex((t) => t.id === id)
  const j = idx + dir
  if (idx === -1 || j < 0 || j >= groupTabs.length) return
  const iFull = tabs.findIndex((t) => t.id === id)
  const jFull = tabs.findIndex((t) => t.id === groupTabs[j].id)
  ;[tabs[iFull], tabs[jFull]] = [tabs[jFull], tabs[iFull]]
  await saveTabs(tabs)
}

// Смена папки вкладки (из селектора в оверлее).
async function moveTabToFolder(id: string, folderId: string | null): Promise<void> {
  if (!config) return
  const tabs = [...config.tabs]
  const i = tabs.findIndex((t) => t.id === id)
  if (i === -1) return
  tabs[i] = { ...tabs[i], folderId: folderId ?? undefined }
  await saveTabs(tabs)
}

// ---------- Папки для вкладок ----------

function openFolderForm(folder?: NavFolder): void {
  editingFolderId = folder?.id ?? null
  if (folderNameInput) folderNameInput.value = folder?.name ?? ''
  // Защита: для уже защищённой папки галочка включена, поле пустое (пароль не показываем).
  if (folderProtect) {
    folderProtect.checked = !!folder?.passwordId
    if (folderPassword) folderPassword.placeholder = folder?.passwordId ? 'Новый пароль (пусто = без изменений)' : ''
  }
  toggleFolderPasswordField()
  folderForm && (folderForm.hidden = false)
  folderNameInput?.focus()
}

function resetFolderForm(): void {
  editingFolderId = null
  if (folderNameInput) folderNameInput.value = ''
  if (folderProtect) folderProtect.checked = false
  if (folderPassword) { folderPassword.value = ''; folderPassword.placeholder = '' }
  toggleFolderPasswordField()
  folderForm && (folderForm.hidden = true)
}

/** Показать/скрыть поле пароля в зависимости от галочки «защитить папку». */
function toggleFolderPasswordField(): void {
  const show = folderProtect?.checked ?? false
  if (folderPwdField) folderPwdField.hidden = !show
  if (show && folderPassword) folderPassword.focus()
}

async function saveCurrentFolder(): Promise<void> {
  const name = folderNameInput?.value.trim() ?? ''
  if (!name) {
    setStatus('Укажите название папки')
    return
  }
  const protectChecked = folderProtect?.checked ?? false
  // Пароль тримим сразу: пробелы по краям не значимы (хранилище тоже тримит),
  // иначе пароль из одних пробелов молча снимал бы защиту или лочил папку.
  const password = (folderPassword?.value ?? '').trim()
  const folders = [...(config?.folders ?? [])]
  if (editingFolderId) {
    const i = folders.findIndex((f) => f.id === editingFolderId)
    if (i !== -1) {
      const existing = folders[i]
      // Снятие или смена пароля уже защищённой папки — только после проверки текущего пароля.
      const touchesProtection = !protectChecked || Boolean(password)
      if (existing.passwordId && touchesProtection && !(await requireFolderPassword(existing.id))) return
      if (protectChecked && password) {
        // Задать или заменить пароль.
        const pid = await window.shell.saveFolderPassword(existing.id, password)
        folders[i] = { ...existing, name, ...(pid ? { passwordId: pid } : {}) }
        if (!pid) setStatus('Шифрохранилище недоступно — папка без пароля')
      } else if (!protectChecked) {
        // Снять защиту.
        await window.shell.clearFolderPassword(existing.id)
        folders[i] = { ...existing, name, passwordId: undefined }
      } else if (existing.passwordId) {
        // Галочка включена, но пароль пустой — оставляем старый (редактирование имени).
        folders[i] = { ...existing, name }
      } else {
        // Галочка включена, пароль пустой и раньше его не было — без защиты (с предупреждением).
        folders[i] = { ...existing, name, passwordId: undefined }
        setStatus('Пароль пустой — папка сохранена без защиты')
      }
    }
  } else {
    const id = generateFolderId()
    if (protectChecked && password) {
      const pid = await window.shell.saveFolderPassword(id, password)
      folders.push({ id, name, ...(pid ? { passwordId: pid } : {}) })
      if (!pid) setStatus('Шифрохранилище недоступно — папка без пароля')
    } else {
      // Галка защиты с пустым паролем — папка без защиты, но не молча.
      if (protectChecked) setStatus('Пароль пустой — папка создана без защиты')
      folders.push({ id, name })
    }
  }
  await saveFolders(folders)
  resetFolderForm()
}

async function deleteFolder(id: string): Promise<void> {
  // Защищённую папку удаляем только после проверки пароля.
  if (!(await requireFolderPassword(id))) return
  if (!config || !window.confirm('Удалить папку? Вкладки из неё станут «без папки».')) return
  const folders = config.folders.filter((f) => f.id !== id)
  // Вкладки удалённой папки переходят в «без папки».
  const tabs = config.tabs.map((t) => (t.folderId === id ? { ...t, folderId: undefined } : t))
  await Promise.all([saveFolders(folders), saveTabs(tabs)])
}

/** Формат файла: заголовок для валидации + папки + массив вкладок. */
const TABS_FILE_FORMAT = 'sewbrowser-tabs'
const TABS_FILE_VERSION = 2

interface TabFilePayload {
  format: string
  version: number
  /** Папки (v2); старые файлы v1 без них. */
  folders?: NavFolder[]
  tabs: NavTab[]
}

function buildTabsJson(): string {
  const payload: TabFilePayload = {
    format: TABS_FILE_FORMAT,
    version: TABS_FILE_VERSION,
    folders: (config?.folders ?? []).map((f) => ({ id: f.id, name: f.name })),
    tabs: (config?.tabs ?? []).map((t) => ({ id: t.id, name: t.name, url: t.url, ...(t.folderId ? { folderId: t.folderId } : {}) })),
  }
  return JSON.stringify(payload, null, 2)
}

async function exportTabs(): Promise<void> {
  const tabs = config?.tabs ?? []
  if (!tabs.length) {
    setStatus('Нет вкладок для экспорта')
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const ok = await window.shell.saveTabsFile(buildTabsJson(), `sewbrowser-tabs-${stamp}.json`)
  setStatus(ok ? `Экспорт: ${tabs.length} вкладок (${(config?.folders ?? []).length} папок) сохранён` : 'Экпорт отменён')
}

function importTabs(file: File): void {
  const reader = new FileReader()
  reader.onload = async () => {
    let data: Partial<TabFilePayload>
    try {
      data = JSON.parse(String(reader.result ?? '')) as Partial<TabFilePayload>
    } catch {
      setStatus('Файл не является валидным JSON')
      return
    }
    if (data.format !== TABS_FILE_FORMAT || !Array.isArray(data.tabs)) {
      setStatus('Неверный формат файла (ожидался экспорт вкладок SEWBrowser)')
      return
    }
    const tabs: NavTab[] = []
    for (const raw of data.tabs) {
      if (!raw || typeof raw !== 'object') continue
      const name = String((raw as NavTab).name ?? '').trim()
      const urlRaw = String((raw as NavTab).url ?? '').trim()
      if (!name || !urlRaw) continue
      tabs.push({ id: generateTabId(), name, url: normalizeUrl(urlRaw), ...(typeof (raw as NavTab).folderId === 'string' ? { folderId: (raw as NavTab).folderId } : {}) })
    }
    // Папки из файла (v2): полная замена структуры. Коллизии id — пересоздаём,
    // ссылки вкладок переписываем через карту ремаппинга (иначе повторный импорт
    // разваливает раскладку: вкладки выпадают в «без папки»).
    const importedFolders: NavFolder[] = []
    const folderIds = new Set<string>()
    const folderRemap = new Map<string, string>()
    if (Array.isArray(data.folders)) {
      for (const raw of data.folders) {
        if (!raw || typeof raw !== 'object') continue
        const fname = String((raw as NavFolder).name ?? '').trim()
        let fid = String((raw as NavFolder).id ?? '')
        if (!fname || !fid) continue
        if ((config?.folders ?? []).some((f) => f.id === fid)) {
          // Коллизия с текущей структурой — новый id + ремаппинг ссылок вкладок.
          const nid = generateFolderId()
          folderRemap.set(fid, nid)
          fid = nid
        } else if (folderIds.has(fid)) {
          // Дубль внутри файла — новый id без ремаппинга (вкладки остаются у первой папки).
          fid = generateFolderId()
        }
        folderIds.add(fid)
        importedFolders.push({ id: fid, name: fname })
      }
    }
    // Переписываем ссылки вкладок на пересозданные папки, затем отсекаем «висячие».
    for (const t of tabs) {
      if (t.folderId) t.folderId = folderRemap.get(t.folderId) ?? t.folderId
    }
    // Отсекаем «висячие» ссылки на папки, которых нет в импортированном наборе.
    for (const t of tabs) {
      if (t.folderId && !folderIds.has(t.folderId)) t.folderId = undefined
    }
    if (!tabs.length) {
      setStatus('В файле нет валидных вкладок')
      return
    }
    if (!window.confirm(`Заменить текущие ${config?.tabs.length ?? 0} вкладок на ${tabs.length} импортированные?`)) {
      return
    }
    await saveTabs(tabs)
    // Если в файле есть папки — заменяем структуру папок целиком.
    if (importedFolders.length) await saveFolders(importedFolders)
    setStatus(`Импорт: ${tabs.length} вкладок из ${file.name}`)
  }
  reader.onerror = () => setStatus('Не удалось прочитать файл')
  reader.readAsText(file)
}

function wireTabs(): void {
  document.getElementById('tab-add')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-manage')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-add-new')?.addEventListener('click', () => { resetForm(); openEditForm({ id: '', name: '', url: '' }) })
  tabsExport?.addEventListener('click', () => void exportTabs())
  tabsImport?.addEventListener('click', () => { if (tabsImportFile) tabsImportFile.click() })
  tabsImportFile?.addEventListener('change', (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void importTabs(file)
    // Снимаем значение, чтобы повторный выбор того же файла снова сработал
    if (tabsImportFile) tabsImportFile.value = ''
  })
  document.getElementById('tab-save')?.addEventListener('click', () => void saveCurrentTab())
  document.getElementById('tab-cancel')?.addEventListener('click', () => { resetForm() })
  document.getElementById('tabs-close')?.addEventListener('click', closeTabs)
  tabNameInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
  tabUrlInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
  document.getElementById('folder-add-new')?.addEventListener('click', () => openFolderForm())
  document.getElementById('folder-save')?.addEventListener('click', () => void saveCurrentFolder())
  document.getElementById('folder-cancel')?.addEventListener('click', () => resetFolderForm())
  folderProtect?.addEventListener('change', toggleFolderPasswordField)
  folderNameInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentFolder() })
}

function wireTemplates(): void {
  document.getElementById('btn-templates')?.addEventListener('click', () => void openTemplates())
  document.getElementById('templates-manage')?.addEventListener('click', () => {
    closeTemplates()
    openTemplatesManage()
  })
  document.getElementById('templates-close')?.addEventListener('click', closeTemplates)
  document.getElementById('manageCloseBtn')?.addEventListener('click', closeTemplatesManage)
  // options.js расширения — дословно, с shell-прослойкой вместо chrome.*
  // Нюанс: options.js ждёт DOMContentLoaded, но документ оболочки к этому
  // моменту давно загружен — подписку перехватываем и вызываем колбэк сразу.
  const pattern = plugins.find((p) => p.name === TEMPLATES_PLUGIN)
  if (pattern?.options) {
    const pendingDcl: Array<(event: Event) => void> = []
    const origAddEventListener = document.addEventListener.bind(document)
    function patchedAddEventListener(type: string, listener: unknown, options?: unknown): void {
      if (type === 'DOMContentLoaded' && typeof listener === 'function' && document.readyState !== 'loading') {
        pendingDcl.push(listener as (event: Event) => void)
        return
      }
      ;(origAddEventListener as (...args: unknown[]) => void)(type, listener, options)
    }
    document.addEventListener = patchedAddEventListener as typeof document.addEventListener
    try {
      const runOptions = new Function('chrome', pattern.options) as (chrome: unknown) => void
      runOptions(makeShellChrome(TEMPLATES_PLUGIN))
    } catch (err) {
      console.warn('[templates] options init failed:', err)
    } finally {
      document.addEventListener = origAddEventListener
    }
    for (const cb of pendingDcl) {
      try {
        cb(new Event('DOMContentLoaded'))
      } catch (err) {
        console.warn('[templates] options DCL callback failed:', err)
      }
    }
  }
  // Список применения — живой: обновляем при изменении шаблонов
  window.shell.onPluginDataChanged(({ plugin }) => {
    if (plugin === TEMPLATES_PLUGIN && templatesOpen) void refreshTemplatesList()
  })
}

// Клик строго по фону оверлея (мимо карточки) закрывает модалку
function wireOverlayDismiss(): void {
  const pairs: Array<[HTMLElement | null, () => void]> = [
    [settingsOverlay, closeSettings],
    [accountsOverlay, closeAccounts],
    [downloadsOverlay, closeDownloads],
    [tabsOverlay, closeTabs],
    [templatesOverlay, closeTemplates],
    [templatesManageOverlay, closeTemplatesManage],
    [passwordPromptEl(), cancelFolderPasswordPrompt],
  ]
  for (const [overlay, close] of pairs) {
    overlay?.addEventListener('click', (event: MouseEvent) => {
      if (event.target === overlay) close()
    })
  }
}

function applyAppVersion(): void {
  const el = document.getElementById('app-version') as HTMLElement | null
  if (!el) return
  window.shell.getVersion().then((v) => {
    if (v) el.textContent = 'v' + v
  }).catch(() => { /* noop */ })
}

async function init(): Promise<void> {
  config = await window.shell.getConfig()
  plugins = await window.shell.getPlugins()
  try {
    allPlugins = await window.shell.getAllPlugins()
  } catch {
    allPlugins = []
  }
  applyAppVersion()

  wireToolbar()
  wireShortcuts()
  wireFindbar()
  wireErrorOverlay()
  wireSettings()
  wireDownloads()
  wireHelp()
  wireTemplates()
  wireTabs()
    folderPrompt = createFolderPasswordPrompt({
      findFolder: (folderId) => orderedGroups().find((g) => g.id === folderId),
    })
    folderPrompt.wire()
  wireUpdater()
  wireOverlayDismiss()
  initTabs({
    container: document.getElementById('tab-views') as HTMLElement,
    strip: document.getElementById('tabbar-strip') as HTMLElement,
    newTabButton: document.getElementById('tabbar-new') as HTMLButtonElement,
    startUrl: config.startUrl,
    // Allowlist-инвариант в одном месте: openTab не создаёт вкладку для
    // запрещённого хоста, статус тот же, что у navigate.
    isAllowed: (url) => isAllowed(url),
    onBlocked: () => setStatus('blocked by allowlist'),
    hooks: {
      wire: (tab) => {
        wireTabEvents(tab)
      },
      onActivated: () => {
        updateAddressBar()
        updateTitlebarTitle()
        updateNavButtons()
        try {
          addressMenu?.syncZoom(activeView()?.getZoomFactor() ?? 1)
        } catch {
          /* гость ещё не готов */
        }
        applyZoomForCurrentPage()
        updateActiveTab()
        // Оверлей сети и findbar описывают предыдущую вкладку, на новой они
        // врут: «Повторить» перезагрузил бы уже другую страницу (спека §7.2/§12).
        hideError()
        toolbar?.classList.remove('loading')
        closeFind()
        // Фоновая вкладка могла догрузить форму входа, пока была неактивной —
        // при возврате фокуса проверяем её (checkLoginForm сам гасит повтор
        // через loginPrompted/accountsOpen).
        void checkLoginForm(false)
      },
      onClosed: (tab) => {
        // Ключи гостевых вызовов не чистятся сами — снимаем префикс вкладки,
        // иначе за сессию накапливается мусор.
        for (const key of Object.keys(lastGuestErr)) {
          if (key.startsWith(`${tab.id}:`)) delete lastGuestErr[key]
        }
      },
      onPrimaryChanged: (tab) => {
        // Вкладку переставили, опросная сменилась — гасим опрос в прежней.
        // Новый хост поднимет его сам при первом взятии очереди (tasks-take).
        void guestJS<void>(tab, 'poll-host-off', 'window.__shellPollHost = false;').catch(() => {})
      },
    },
  })
  startStatusPolling()
  startLinkIntake()
  startSewHelperBridge()
  startScansBridge()
  startTasksNotifyBridge()

  // Данные плагинов меняются из оверлеев оболочки — перепушиваем снапшот в страницу
  window.shell.onPluginDataChanged(() => void pushPluginStores())
  // Живые обновления папки сканов: main шлёт 'scans:changed' при каждом изменении —
  // форвардим список в гостя событием 'scans-block:update' (блок перерисуется сам).
  window.shell.onScansChanged((files) => {
    const payload = JSON.stringify(files ?? [])
    for (const tab of listTabs()) {
      void guestJS<void>(tab, 'scans-push', '(function(list){try{window.dispatchEvent(new CustomEvent("scans-block:update",{detail:list}))}catch(e){}})(' + payload + ')').catch(() => {})
    }
  })
  // Клик по OS-уведомлению tasks-notify: main прислал URL — открываем вкладкой
  // (относительный путь резолвим против текущего URL, иначе allowlist режет)
  window.shell.onTasksOpen?.((url) => {
    focusOrOpenTab(tasksUrl(url))
  })
  // window.open / target=_blank из гостя: открываем отдельной вкладкой справа
  window.shell.onOpenNewTab((url) => {
    openTab(url)
  })
  // ПКМ по странице гостя → «Печать…»: main шлёт 'shell:open-print'
  window.shell.onOpenPrint(() => {
    void openPrintDialog(activeTab())
  })

  if (addressInput) addressInput.value = config.startUrl
  // Стартовую навигацию отдаём менеджеру вкладок: он создаёт webview, вешает
  // обработчики (hooks.wire) и только потом ставит src.
  openTab(config.startUrl, { activate: true })
  renderStrip()
  setStatus(config.debug ? 'debug' : '')
}

void init().catch((err) => {
  console.error('[shell] init failed:', err)
  setStatus(`init: ${String(err)}`)
})
