import { setStatus } from './status-ui'
import { playTnSound } from './bridges'

// Кнопка «Скачать остатки» в тулбаре и её настройки (папка + код магазина)
// в оверлее «Загрузки». Само скачивание делает main: renderer только зовёт
// shell.downloadStock() и показывает результат.

/**
 * Подписи строк настроек: путь папки остатков (или системные «Загрузки»,
 * если папка не задана) и текущий код магазина.
 */
async function renderStockRows(): Promise<void> {
  const dirEl = document.getElementById('stock-dir')
  const idEl = document.getElementById('stock-object-id') as HTMLInputElement | null
  let dir = ''
  let objectId = ''
  try {
    const config = await window.shell.getConfig()
    dir = config.stockDir ?? ''
    objectId = config.stockObjectId ?? ''
  } catch (err) {
    console.warn('[shell] failed to read stock settings:', err)
  }
  if (dirEl) {
    dirEl.textContent = dir || 'Загрузки (системная)'
    dirEl.title = dir
  }
  if (idEl && document.activeElement !== idEl) idEl.value = objectId
}

async function pickStockDir(): Promise<void> {
  try {
    const dir = await window.shell.pickStockDir()
    if (!dir) return
    await renderStockRows()
    setStatus('папка остатков изменена')
  } catch (err) {
    console.warn('[shell] failed to pick stock dir:', err)
  }
}

async function resetStockDir(): Promise<void> {
  try {
    await window.shell.setConfig({ stockDir: '' })
    await renderStockRows()
    setStatus('папка остатков — системные «Загрузки»')
  } catch (err) {
    console.warn('[shell] failed to reset stock dir:', err)
  }
}

/**
 * Код магазина пишем по 'change' (Enter/потеря фокуса), а не на каждый
 * вводящий символ. Валидирует сам main — если он отверг значение, вернуть
 * в поле то, что реально сохранено, и объяснить почему.
 */
async function saveStockObjectId(value: string): Promise<void> {
  const wanted = value.trim()
  try {
    const config = await window.shell.setConfig({ stockObjectId: wanted })
    if (config.stockObjectId !== wanted) {
      await renderStockRows()
      setStatus(`код магазина «${wanted}» не принят: только латиница, цифры, дефис и _`)
      return
    }
    setStatus('код магазина сохранён')
  } catch (err) {
    console.warn('[shell] failed to save stock object id:', err)
  }
}

/**
 * Скачивание остатков. main шлёт свои события 'started'/'progress'/'done',
 * поэтому прогресс виден в оверлее «Загрузки» и в истории; тут только
 * итог: звук на успех, текст ошибки — в статус.
 */
async function downloadStockReport(): Promise<void> {
  const btn = document.getElementById('btn-stock') as HTMLButtonElement | null
  if (btn) btn.disabled = true
  setStatus('скачиваем остатки…')
  try {
    const result = await window.shell.downloadStock()
    if (result.ok) {
      setStatus(`остатки сохранены: ${result.name ?? result.path ?? 'файл'}`)
      await playTnSound('rel')
    } else {
      setStatus(`остатки не скачались: ${result.error ?? 'неизвестная ошибка'}`)
    }
  } catch (err) {
    console.warn('[shell] stock download failed:', err)
    setStatus('остатки не скачались')
  } finally {
    if (btn) btn.disabled = false
    await renderStockRows()
  }
}

export function wireStockReport(): void {
  document.getElementById('btn-stock')?.addEventListener('click', () => void downloadStockReport())
  document.getElementById('stock-dir-pick')?.addEventListener('click', () => void pickStockDir())
  document.getElementById('stock-dir-reset')?.addEventListener('click', () => void resetStockDir())
  document.getElementById('stock-object-id')?.addEventListener('change', (event: Event) => {
    void saveStockObjectId((event.target as HTMLInputElement).value)
  })
  void renderStockRows()
}
