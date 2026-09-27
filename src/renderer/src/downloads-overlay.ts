import { setStatus } from './status-ui'
import { formatDateTime, formatSize } from './util'

// Ссылки на DOM берём лениво: модуль импортируется при загрузке оболочки,
// а разметка может быть ещё не готова. Гарды вида `if (!x()) return` в коде
// ниже остаются рабочими — на момент вызова элемента может не быть.
function downloadsBarEl(): HTMLElement {
  return document.getElementById('downloads') as HTMLElement
}

function overlayEl(): HTMLElement {
  return document.getElementById('downloads-overlay') as HTMLElement
}

function historyEl(): HTMLElement {
  return document.getElementById('downloads-history') as HTMLElement
}

function filterEl(): HTMLSelectElement {
  return document.getElementById('downloads-filter') as HTMLSelectElement
}

let downloadsOpen = false
let downloadsRecords: DownloadedFile[] = []

/** Открыт ли оверлей «Загрузки» — нужно escape-цепочке в main. */
export function isDownloadsOpen(): boolean {
  return downloadsOpen
}

/** Элемент оверлея — нужен списку пар в wireOverlayDismiss. */
export function downloadsOverlayEl(): HTMLElement {
  return overlayEl()
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
  if (!downloadsBarEl()) return
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
    downloadsBarEl().textContent = `↓ ${current.name}${progress}${extra}`
    downloadsBarEl().classList.toggle('done', false)
    downloadsBarEl().onclick = null
    downloadsBarEl().hidden = false
    return
  }
  const last = [...downloads.values()].pop()
  if (!last) {
    downloadsBarEl().hidden = true
    downloadsBarEl().onclick = null
    return
  }
  if (last.status === 'done') {
    downloadsBarEl().textContent = `✓ ${last.name}`
    downloadsBarEl().classList.toggle('done', true)
    const path = last.path
    downloadsBarEl().onclick = path ? () => void window.shell.showItemInFolder(path) : null
  } else {
    downloadsBarEl().textContent = `✕ ${last.name}`
    downloadsBarEl().classList.toggle('done', false)
    downloadsBarEl().onclick = null
  }
  downloadsBarEl().hidden = false
  downloadsHideTimer = setTimeout(() => {
    if (downloadsBarEl()) downloadsBarEl().hidden = true
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

export function wireDownloads(): void {
  document.getElementById('btn-downloads')?.addEventListener('click', () => void openDownloads())
  document.getElementById('downloads-close')?.addEventListener('click', closeDownloads)
  document.getElementById('downloads-clear')?.addEventListener('click', () => void clearDownloadsHistory())
  filterEl()?.addEventListener('change', () => renderDownloadsHistory(downloadsRecords))
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
  if (!filterEl()) return
  const current = filterEl().value
  const seen = new Set<string>()
  filterEl().innerHTML = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'Все сотрудники'
  filterEl().append(all)
  for (const rec of downloadsRecords) {
    const key = rec.fio ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = rec.fio ? whoLabel(rec) : 'Неизвестно'
    filterEl().append(opt)
  }
  // Выбор переживает обновление, если сотрудник ещё есть в списке
  filterEl().value = Array.from(filterEl().options).some((o) => o.value === current)
    ? current
    : ''
}

function renderDownloadsHistory(records: DownloadedFile[]): void {
  if (!historyEl()) return
  downloadsRecords = records
  rebuildDownloadsFilter()
  const filter = filterEl()?.value ?? ''
  const visible = filter ? records.filter((r) => (r.fio ?? '') === filter) : records
  historyEl().innerHTML = ''
  if (visible.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = records.length === 0 ? 'Пока ничего не скачано' : 'Нет записей для этого сотрудника'
    historyEl().append(empty)
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
    historyEl().append(row)
  }
}

async function refreshDownloadsHistory(): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.listDownloads())
  } catch (err) {
    console.warn('[shell] downloads history failed:', err)
  }
}

export async function openDownloads(): Promise<void> {
  if (!overlayEl()) return
  overlayEl().hidden = false
  downloadsOpen = true
  await refreshDownloadsHistory()
  void renderDownloadsDir()
}

export function closeDownloads(): void {
  downloadsOpen = false
  if (overlayEl()) overlayEl().hidden = true
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
