import { setStatus } from './status-ui'

const updatebar = (): HTMLElement | null => document.getElementById('updatebar')
const updateText = (): HTMLElement | null => document.getElementById('update-text')
const updateAction = (): HTMLButtonElement | null =>
  document.getElementById('update-action') as HTMLButtonElement | null

type UpdaterUiState = 'idle' | 'available' | 'downloading' | 'ready'
let updaterState: UpdaterUiState = 'idle'
/** Ручная проверка из настроек (флаг отличает её от тихого автостарта) */
let manualUpdateCheck = false
let updaterVersion = ''
let updaterPercent = 0

function renderUpdater(): void {
  const bar = updatebar()
  const text = updateText()
  const action = updateAction()
  if (!bar || !text || !action) return
  if (updaterState === 'idle') {
    bar.hidden = true
    return
  }
  bar.hidden = false
  action.disabled = false
  if (updaterState === 'available') {
    text.textContent = `Доступно обновление ${updaterVersion}`
    action.textContent = 'Скачать и установить'
    action.onclick = (): void => {
      updaterState = 'downloading'
      updaterPercent = 0
      renderUpdater()
      window.shell.downloadUpdate().catch((err) => {
        console.warn('[shell] download update failed:', err)
        updaterState = 'available'
        renderUpdater()
        setStatus(String(err?.message ?? 'не удалось скачать обновление'))
      })
    }
  } else if (updaterState === 'downloading') {
    text.textContent = `Скачивание обновления… ${updaterPercent}%`
    action.textContent = 'Скачивается…'
    action.disabled = true
    action.onclick = null
  } else {
    text.textContent = `Обновление ${updaterVersion} готово`
    action.textContent = 'Перезапустить'
    action.onclick = (): void => window.shell.installUpdate()
  }
}

export function wireUpdater(): void {
  document.getElementById('update-close')?.addEventListener('click', () => {
    const bar = updatebar()
    if (bar) bar.hidden = true
  })
  window.shell.onUpdater((event) => {
    if (event.type === 'available') {
      manualUpdateCheck = false
      updaterState = 'available'
      updaterVersion = event.version ?? ''
    } else if (event.type === 'progress') {
      updaterState = 'downloading'
      updaterPercent = event.percent ?? 0
    } else if (event.type === 'ready') {
      updaterState = 'ready'
      updaterVersion = event.version ?? updaterVersion
    } else if (event.type === 'uptodate') {
      // Тихо при автостарте; тост — только по ручной проверке из настроек
      if (!manualUpdateCheck) return
      manualUpdateCheck = false
      setStatus('у вас последняя версия')
    } else {
      // error — показываем только если пользователь уже в процессе
      if (manualUpdateCheck) {
        manualUpdateCheck = false
        setStatus(`не удалось проверить: ${event.message ?? 'ошибка'}`)
        return
      }
      // во время скачивания показывает catch у downloadUpdate()
      if (updaterState === 'idle' || updaterState === 'downloading') return
      setStatus(`обновление: ${event.message ?? 'ошибка'}`)
      return
    }
    renderUpdater()
  })
}

/** Ручная проверка обновлений из окна настроек: результат — тостом в статус. */
export function checkForUpdatesManually(): void {
  manualUpdateCheck = true
  setStatus('проверяем обновления…')
  window.shell.checkForUpdates().catch((err) => {
    manualUpdateCheck = false
    const msg = err instanceof Error && err.message ? err.message : String(err ?? '')
    // В dev хендлера нет вообще («No handler registered») — честно говорим,
    // что проверка только в сборке; таймаут и прочие — текстом ошибки.
    setStatus(/no handler/i.test(msg) ? 'проверка доступна только в установленной версии' : msg || 'не удалось проверить')
  })
}
