import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DownloadRecord {
  id: string
  name: string
  path: string
  bytes: number
  state: 'done' | 'error'
  /** ISO-строки: когда началось и когда завершилось */
  startedAt: string
  finishedAt: string
  /** Кто скачал: из аккаунта автовхода или со страницы SEW (может отсутствовать) */
  fio?: string
  tabNum?: string
}

const MAX_RECORDS = 100

function historyFile(): string {
  return join(app.getPath('userData'), 'downloads.json')
}

function isRecord(v: unknown): v is DownloadRecord {
  const r = (v ?? {}) as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.path === 'string' &&
    typeof r.bytes === 'number' &&
    (r.state === 'done' || r.state === 'error') &&
    typeof r.startedAt === 'string' &&
    typeof r.finishedAt === 'string' &&
    (r.fio === undefined || typeof r.fio === 'string') &&
    (r.tabNum === undefined || typeof r.tabNum === 'string')
  )
}

export function loadDownloadHistory(): DownloadRecord[] {
  try {
    if (!existsSync(historyFile())) return []
    const parsed: unknown = JSON.parse(readFileSync(historyFile(), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecord)
  } catch {
    // повреждённый файл — начинаем с пустой истории
    return []
  }
}

function saveHistory(records: DownloadRecord[]): void {
  try {
    writeFileSync(historyFile(), JSON.stringify(records, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[downloads] failed to write history:', err)
  }
}

/** Новая запись — в начало, старые сверх лимита отбрасываются */
export function appendDownloadRecord(rec: DownloadRecord): DownloadRecord[] {
  const all = [rec, ...loadDownloadHistory()].slice(0, MAX_RECORDS)
  saveHistory(all)
  return all
}

export function removeDownloadRecord(id: string): DownloadRecord[] {
  const all = loadDownloadHistory().filter((r) => r.id !== id)
  saveHistory(all)
  return all
}

export function clearDownloadHistory(): DownloadRecord[] {
  saveHistory([])
  return []
}
