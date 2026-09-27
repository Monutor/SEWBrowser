import './styles.css'
import { createTaskAlert, formatTaskAlertText, getTaskAlertUrls } from './task-alert'
import { createAddressMenu, type AddressMenuController } from './address-menu'
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
import { captureActiveTabScreenshot, closeShotPreviewIfOpen, openShotPreview, playShutterClick, wireShotPreview } from './screenshot'
import { initNavStore, isFolderCollapsed, UNASSIGNED_FOLDER, generateTabId, hasUserFolders, orderedGroups, tabsInFolder, generateFolderId, saveFolders, toggleFolderCollapse, fillFolderSelect, saveTabs, buildTabsJson, exportTabs, importTabs, type NavStoreDeps } from './nav-store'
import { openTemplates, closeTemplates, closeTemplatesManage, isTemplatesOpen, isTemplatesManageOpen, templatesOverlayEl, templatesManageOverlayEl, wireTemplates, type TemplatesDeps } from './templates-overlay'
import {
  openAccounts,
  closeAccounts,
  wireAccounts,
  checkLoginForm,
  isAccountsOpen,
  accountsOverlayEl,
  setLoginPrompted,
} from './accounts-overlay'
import { wireDownloads, openDownloads, closeDownloads, isDownloadsOpen, downloadsOverlayEl } from './downloads-overlay'
import { initSettings, wireSettings, openSettings, closeSettings, isSettingsOpen, settingsOverlayEl, type SettingsDeps } from './settings-overlay'
import {
  TN_ALERT_TTL_DEFAULT_SEC,
  initBridges,
  normalizeTnAlertTtl,
  playTnSound,
  readTnAlertTtl,
  resetTnCustomAudio,
  setTnSoundFile,
  setTnSoundFiles,
  startScansBridge,
  startSewHelperBridge,
  startTasksNotifyBridge,
  tnSoundFile,
} from './bridges'
import { isGuestReady, initTabEvents, startLinkIntake, wireTabEvents, type TabEventsDeps } from './tab-events'
import {
  closePrintDialogIfOpen,
  initPrintBridge,
  openPrintDialog,
  printElements,
  schedulePrintRefresh,
  wirePrintDialog,
} from './print-bridge'
import { wireToolbar } from './toolbar'
import { initAddressBar, updateAddressBar, updateTitlebarTitle, updateNavButtons, navigate, applyZoomForCurrentPage, changeZoom } from './address-bar'

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
// Загрузки


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

/** Дефолт времени показа уведомлений tasks-notify, сек (0 = не скрывать) */

// ---------- Оверлей ошибки сети ----------




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
      if (closePrintDialogIfOpen()) {
        break
      }
      if (closeShotPreviewIfOpen()) {
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
      if (isTemplatesManageOpen()) closeTemplatesManage()
      else if (isTemplatesOpen()) closeTemplates()
      else if (isAccountsOpen()) closeAccounts()
      else if (isDownloadsOpen()) closeDownloads()
      else if (tabsOpen) closeTabs()
      else if (isFindActive()) closeFind()
      else if (isSettingsOpen()) closeSettings()
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
    section.className = 'folder-section' + (isFolderCollapsed(group.id) ? ' collapsed' : '')
    section.dataset.folderId = group.id
    const header = document.createElement('div')
    header.className = 'folder-header'
    const chevron = document.createElement('span')
    chevron.className = 'folder-chevron'
    chevron.textContent = isFolderCollapsed(group.id) ? '▶' : '▼'
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


// Клик строго по фону оверлея (мимо карточки) закрывает модалку
function wireOverlayDismiss(): void {
  const pairs: Array<[HTMLElement | null, () => void]> = [
    [settingsOverlayEl(), closeSettings],
    [accountsOverlayEl(), closeAccounts],
    [downloadsOverlayEl(), closeDownloads],
    [tabsOverlay, closeTabs],
    [templatesOverlayEl(), closeTemplates],
    [templatesManageOverlayEl(), closeTemplatesManage],
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

  initAddressBar(
    { address: addressInput, titlebarTitle, back: btnBack, forward: btnForward },
    {
      isAllowed,
      config: () => config,
      setZoomConfig: async (zoom) => {
        config = await window.shell.setConfig({ zoom })
      },
      getAddressMenu: () => addressMenu,
    },
  )
  initPrintBridge({
    config: () => config,
    savePrintConfig: async (print) => {
      config = await window.shell.setConfig({ print })
    },
    currentViewUrl,
  })
  initTabEvents({
    plugins: () => plugins,
    isAllowed,
    setLoginPrompted,
    checkLoginForm: (interactive) => {
      void checkLoginForm(interactive)
    },
    updateTitlebarTitle,
    updateAddressBar,
    updateNavButtons,
    applyZoomForCurrentPage,
    updateActiveTab,
  })
  startLinkIntake()
  wireToolbar(
    { address: addressInput, back: btnBack, forward: btnForward },
    {
      config: () => config,
      navigate,
      openAccounts,
      captureActiveTabScreenshot,
      wireAddressMenu,
      wirePrintDialog,
      wireShotPreview,
    },
  )
  wireShortcuts()
  wireFindbar()
  wireErrorOverlay()
  initSettings({
    config: () => config,
    setConfig: async (patch) => {
      config = await window.shell.setConfig(patch)
      return config
    },
    plugins: () => plugins,
    allPlugins: () => allPlugins,
    gotoStartUrl: (url) => {
      if (addressInput) addressInput.value = url
      void navigate(url)
    },
  })
  wireSettings()
  wireAccounts()
  wireDownloads()
  wireHelp()
  wireTemplates({ plugins: () => plugins })
  initNavStore({
    config: () => config,
    setConfig: async (patch) => {
      config = await window.shell.setConfig(patch)
      return config
    },
    renderStrip,
    refreshTabsList,
    closeGroupPanel,
  })
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
  initBridges({
    config: () => config,
    plugins: () => plugins,
    taskAlert: () => taskAlert,
    tasksUrl,
    isAllowed,
  })
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
