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
import { initShortcuts, wireShortcuts } from './shortcuts'
import { shortcutFromEvent } from './shortcuts-core.ts'
import { initTabsOverlay, isTabsOpen, tabsOverlayEl, openTabs, closeTabs, refreshTabsList, openEditForm, saveCurrentTab, deleteTab, moveTab, moveTabToFolder, openFolderForm, saveCurrentFolder, deleteFolder, wireTabs } from './tabs-overlay'
import { initLinkStrip, isGroupPanelOpen, currentViewUrl, renderStrip, closeGroupPanel, updateActiveTab, createTabRow, tabRowButton } from './link-strip'
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

let config: ShellConfig | null = null
let plugins: PluginInfo[] = []
/** Все плагины (включая выключенные) — для настроек */
let allPlugins: { name: string; enabled: boolean }[] = []

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

// ---------- Оверлей ошибки сети ----------

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

function wireOverlayDismiss(): void {
  const pairs: Array<[HTMLElement | null, () => void]> = [
    [settingsOverlayEl(), closeSettings],
    [accountsOverlayEl(), closeAccounts],
    [downloadsOverlayEl(), closeDownloads],
    [tabsOverlayEl(), closeTabs],
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
  initShortcuts({
    config: () => config,
    cancelFolderPasswordPrompt,
    getAddressMenu: () => addressMenu,
    isHelpOpen: () => Boolean(helpOverlay && !helpOverlay.hidden),
    closeHelp,
    toggleHelp,
  })
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
  initTabsOverlay({
    config: () => config,
    promptFolderPassword,
    requireFolderPassword,
    cancelFolderPasswordPrompt,
  })
  initLinkStrip({
    config: () => config,
    promptFolderPassword,
    closeTabs,
    moveTab,
    openEditForm,
    deleteTab,
    moveTabToFolder,
  })
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
