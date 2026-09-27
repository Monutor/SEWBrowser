import {
  activeTab,
  activeView,
  canTabGoBack,
  canTabGoForward,
  closeTab,
  cycleTab,
  noteTabHistory,
  openTab,
  selectTabIndex,
  isSplit,
  unsplit,
} from './tabs'
import { shortcutFromEvent } from './shortcuts-core.ts'
import { setStatus } from './status-ui'
import { openFind, closeFind, isFindActive, isFindInput } from './findbar'
import { changeZoom } from './address-bar'
import { captureActiveTabScreenshot, closeShotPreviewIfOpen, openShotPreview } from './screenshot'
import { openPrintDialog, closePrintDialogIfOpen } from './print-bridge'
import { openSettings, closeSettings, isSettingsOpen } from './settings-overlay'
import { openAccounts, closeAccounts, isAccountsOpen } from './accounts-overlay'
import {
  openTemplates,
  closeTemplates,
  isTemplatesOpen,
  isTemplatesManageOpen,
  closeTemplatesManage,
} from './templates-overlay'
import { closeDownloads, isDownloadsOpen } from './downloads-overlay'
import { closeTabs, isTabsOpen } from './tabs-overlay'
import { isGroupPanelOpen, closeGroupPanel } from './link-strip'
import type { AddressMenuController } from './address-menu'

export interface ShortcutsDeps {
  config(): ShellConfig | null
  cancelFolderPasswordPrompt(): void
  getAddressMenu(): AddressMenuController | null
  isHelpOpen(): boolean
  closeHelp(): void
  toggleHelp(): void
}

let deps!: ShortcutsDeps

let isFullscreen = false

export function initShortcuts(d: ShortcutsDeps): void {
  deps = d
}

function addressInputEl(): HTMLInputElement | null {
  return document.getElementById('address') as HTMLInputElement | null
}

/** Снимает фокус с адресной строки, если он там. true — значит был и снят. */
function blurAddressInput(): boolean {
  const address = addressInputEl()
  if (!address || document.activeElement !== address) return false
  address.blur()
  return true
}

export function wireShortcuts(): void {
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
async function handleShortcut(name: string): Promise<void> {
  switch (name as ShortcutName) {
    case 'new-tab': {
      openTab(deps.config()?.startUrl ?? '')
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
      addressInputEl()?.focus()
      addressInputEl()?.select()
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
      deps.toggleHelp()
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
      deps.cancelFolderPasswordPrompt()
      if (deps.isHelpOpen()) {
        deps.closeHelp()
        break
      }
      if (deps.getAddressMenu()?.isOpen()) {
        deps.getAddressMenu()?.close()
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
      if (isGroupPanelOpen()) {
        closeGroupPanel()
        break
      }
      if (isTemplatesManageOpen()) closeTemplatesManage()
      else if (isTemplatesOpen()) closeTemplates()
      else if (isAccountsOpen()) closeAccounts()
      else if (isDownloadsOpen()) closeDownloads()
      else if (isTabsOpen()) closeTabs()
      else if (isFindActive()) closeFind()
      else if (isSettingsOpen()) closeSettings()
      else if (blurAddressInput()) {
        // адресная строка получила фокус — снимаем
      } else if (isFullscreen) {
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
