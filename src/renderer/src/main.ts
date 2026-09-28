import './styles.css'
import { createTaskAlert } from './task-alert'
import { createAddressMenu, type AddressMenuController } from './address-menu'
import { openFind, closeFind, wireFindbar } from './findbar'
import { wireUpdater } from './updatebar'
import {
  createFolderPasswordPrompt,
  passwordPromptEl,
  type FolderPasswordPromptController,
} from './folder-prompt'
import { activeTab, activeView, focusOrOpenTab, initTabs, listTabs, openTab } from './tabs'
import { setStatus, startStatusPolling, hideError, wireErrorOverlay } from './status-ui'
import { pushPluginStores, guestJS, lastGuestErr } from './guest'
import { isAllowed as isAllowedUrl, resolveTasksUrl } from './util'
import { captureActiveTabScreenshot, wireShotPreview } from './screenshot'
import { isHelpOpen, closeHelp, toggleHelp, wireHelp } from './help-overlay'
import { initShortcuts, wireShortcuts } from './shortcuts'
import {
  initTabsOverlay, tabsOverlayEl, closeTabs, refreshTabsList, openEditForm, deleteTab, moveTab, moveTabToFolder, wireTabs,
} from './tabs-overlay'
import { initLinkStrip, currentViewUrl, renderStrip, closeGroupPanel, updateActiveTab } from './link-strip'
import { initNavStore, orderedGroups } from './nav-store'
import {
  closeTemplates, closeTemplatesManage, templatesOverlayEl, templatesManageOverlayEl, wireTemplates,
} from './templates-overlay'
import { openAccounts, closeAccounts, wireAccounts, checkLoginForm, accountsOverlayEl, setLoginPrompted } from './accounts-overlay'
import { wireDownloads, closeDownloads, downloadsOverlayEl } from './downloads-overlay'
import { initSettings, wireSettings, closeSettings, settingsOverlayEl } from './settings-overlay'
import { initBridges, startScansBridge, startSewHelperBridge, startTasksNotifyBridge } from './bridges'
import { initTabEvents, startLinkIntake, wireTabEvents } from './tab-events'
import { initPrintBridge, openPrintDialog, wirePrintDialog } from './print-bridge'
import { wireToolbar } from './toolbar'
import { initAddressBar, updateAddressBar, updateTitlebarTitle, updateNavButtons, navigate, applyZoomForCurrentPage, changeZoom } from './address-bar'

/** Разрешён ли URL: allowlist выключен — да; иначе хост должен попасть под шаблон. */
function isAllowed(url: string): boolean {
  return isAllowedUrl(url, config?.allowlist, config?.allowlistEnabled ?? false)
}

/** Адрес страницы задач: относительный путь дополняем адресом текущей страницы. */
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

/**
 * Разрешить работу с защищённой папкой: защиты нет, пароль «запомнен» на
 * настроенный срок (тогда диалога нет) или введён верно. false — отмена/ошибка.
 */
function ensureFolderAccess(folderId: string): Promise<boolean> {
  return folderPrompt ? folderPrompt.authorize(folderId) : Promise.resolve(false)
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
const taskAlertBar = document.getElementById('task-alert-bar') as HTMLElement | null
const taskAlert = taskAlertRoot && taskAlertTitle && taskAlertText && taskAlertOpen && taskAlertAll && taskAlertClose && taskAlertBar
  ? createTaskAlert({
      root: taskAlertRoot,
      title: taskAlertTitle,
      text: taskAlertText,
      open: taskAlertOpen,
      all: taskAlertAll,
      close: taskAlertClose,
      bar: taskAlertBar
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
      }
    },
  )
  // Подпись масштаба должна совпадать с реальным зумом активной вкладки
  try {
    addressMenu.syncZoom(activeView()?.getZoomFactor() ?? 1)
  } catch {
    /* гость ещё не готов */
  }
}

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
      getAddressMenu: () => addressMenu
    },
  )
  initPrintBridge({
    config: () => config,
    savePrintConfig: async (print) => {
      config = await window.shell.setConfig({ print })
    },
    currentViewUrl
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
    updateActiveTab
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
      wireShotPreview
    },
  )
  initShortcuts({
    config: () => config,
    cancelFolderPasswordPrompt,
    getAddressMenu: () => addressMenu,
    isHelpOpen,
    closeHelp,
    toggleHelp
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
    }
  })
  wireSettings()
  wireAccounts()
  wireDownloads()
  wireHelp()
  wireTemplates({ plugins: () => plugins })
  initTabsOverlay({
    config: () => config,
    requireFolderPassword: ensureFolderAccess,
    cancelFolderPasswordPrompt
  })
  initLinkStrip({
    config: () => config,
    ensureFolderAccess,
    closeTabs,
    moveTab,
    openEditForm,
    deleteTab,
    moveTabToFolder,
    navigateCurrent: (url) => {
      void navigate(url)
    }
  })
  initNavStore({
    config: () => config,
    setConfig: async (patch) => {
      config = await window.shell.setConfig(patch)
      return config
    },
    renderStrip,
    refreshTabsList,
    closeGroupPanel
  })
  wireTabs()
  folderPrompt = createFolderPasswordPrompt({
    findFolder: (folderId) => orderedGroups().find((g) => g.id === folderId),
    rememberMinutes: () => config?.folderPasswordRememberMinutes ?? 5
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
      }
    }
  })
  startStatusPolling({ config: () => config })
  startLinkIntake()
  initBridges({
    config: () => config,
    plugins: () => plugins,
    taskAlert: () => taskAlert,
    tasksUrl,
    isAllowed
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
