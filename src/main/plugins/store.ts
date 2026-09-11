import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Персистентное key-value хранилище данных плагинов — замена chrome.storage.local
 * для перенесённых Chrome-расширений. Один JSON-файл на плагин:
 * %APPDATA%/SEWBrowser/plugin-data/<name>.json
 */
export type PluginData = Record<string, unknown>

function storeDir(): string {
  const dir = join(app.getPath('userData'), 'plugin-data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Имя плагина -> безопасное имя файла (защита от path traversal) */
function fileOf(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(name)) return null
  return join(storeDir(), `${name}.json`)
}

function readAll(name: string): PluginData {
  const file = fileOf(name)
  if (!file || !existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PluginData)
      : {}
  } catch {
    // повреждённый файл — начинаем с пустого
    return {}
  }
}

export function getPluginData(name: string, keys?: string[]): PluginData {
  const all = readAll(name)
  if (!keys) return all
  const out: PluginData = {}
  for (const key of keys) {
    if (typeof key === 'string') out[key] = all[key]
  }
  return out
}

export function setPluginData(name: string, obj: Record<string, unknown>): boolean {
  const file = fileOf(name)
  if (!file || !obj || typeof obj !== 'object') return false
  try {
    writeFileSync(file, JSON.stringify({ ...readAll(name), ...obj }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

export function removePluginData(name: string, keys: string[]): boolean {
  const file = fileOf(name)
  if (!file) return false
  const all = readAll(name)
  for (const key of keys) {
    if (typeof key === 'string') delete all[key]
  }
  try {
    writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}
