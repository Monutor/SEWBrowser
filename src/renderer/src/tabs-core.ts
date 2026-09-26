/**
 * Чистые функции для вкладок — без DOM, чтобы покрываться node:test.
 * Всё, что зависит от разметки, живёт в tabs.ts.
 */

const HTTP_SCHEME_RE = /^https?:\/\//i
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Приводит сырой ввод к абсолютному http(s) URL. '' — открывать нечего. */
export function normalizeTabUrl(raw: string): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  if (!HTTP_SCHEME_RE.test(value) && ANY_SCHEME_RE.test(value)) return ''
  const candidate = HTTP_SCHEME_RE.test(value) ? value : `https://${value}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.href
  } catch {
    return ''
  }
}

/** Хост URL в нижнем регистре; '' — URL не разобрать. */
export function hostOfTabUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Подпись вкладки: заголовок страницы, иначе хост, иначе 'SEW'. */
export function tabTitle(pageTitle: string, url: string): string {
  const title = (pageTitle ?? '').trim()
  if (title) return title
  return hostOfTabUrl(url) || 'SEW'
}

/** Следующий индекс по кругу; -1 — переключать нечего. */
export function cycleTabIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1
  return ((current + delta) % count + count) % count
}

/** Индекс вкладки по номеру 1..9; -1 — номера вне списка. */
export function clampTabIndex(count: number, oneBased: number): number {
  if (count <= 0) return -1
  const index = oneBased - 1
  if (index < 0 || index >= count) return -1
  return index
}

/**
 * Фавиконка вкладки: буква хоста + детерминированный цвет от того же хоста
 * (без сети и без favicon сайта — цвет одинаковый при каждом запуске).
 */
export function tabFavicon(url: string): { letter: string; color: string } {
  const host = hostOfTabUrl(url)
  if (!host) return { letter: '?', color: 'hsl(220, 12%, 45%)' }
  let hash = 0
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) % 360
  return { letter: host[0].toUpperCase(), color: `hsl(${hash}, 55%, 45%)` }
}

/**
 * Разбирает ответ гостя из window.__shellNewTabReq и оставляет только
 * корректные http(s)-ссылки — всё остальное (мусор, javascript:, mailto:) пропускаем.
 */
export function extractNewTabUrls(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    const url = (item as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || !url) continue
    if (!HTTP_SCHEME_RE.test(url)) continue
    out.push(url)
  }
  return out
}
