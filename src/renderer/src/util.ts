// Чистые функции без доступа к DOM и состоянию оболочки.
// Перенесено из main.ts без изменения логики (кроме isAllowed/resolveTasksUrl:
// состояние config и activeView() раньше читались из замыкания, теперь
// передаются аргументами).

import { hostOfTabUrl } from './tabs-core.ts'

export function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

export function hostOf(url: string): string {
  return hostOfTabUrl(url)
}

/**
 * Логика совпадает с allowlist в конфиге (проверка синхронная, в will-navigate).
 * allowlistEnabled=false — проверка выключена, всё разрешено.
 */
export function isAllowed(
  url: string,
  allowlist: string[] | undefined,
  allowlistEnabled: boolean,
): boolean {
  if (!allowlistEnabled) return true
  const host = hostOf(url)
  if (!host) return false
  if (!Array.isArray(allowlist)) return false
  return allowlist.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const domain = p.slice(2)
      return host === domain || host.endsWith(`.${domain}`)
    }
    return host === p
  })
}

/**
 * Очередь tasks-notify несёт относительный путь ('/v2/relocation/tasks'):
 * hostOf('') пуст → isAllowed режет. Резолвим против base (текущий URL геста),
 * fallback — startUrl из конфига.
 */
export function resolveTasksUrl(raw: string, base: string, fallback: string): string {
  const value = (raw || '').trim() || '/v2/relocation/tasks'
  if (/^https?:\/\//i.test(value)) return value
  try {
    return new URL(value, base).href
  } catch {
    try {
      return new URL(value, fallback).href
    } catch {
      return fallback + (value.startsWith('/') ? value : `/${value}`)
    }
  }
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 Б'
  return formatBytes(bytes)
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`таймаут чтения ${label}`)), ms),
    ),
  ])
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
