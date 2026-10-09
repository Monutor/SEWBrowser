/**
 * Проверка хоста иконки вкладки для моста favicon:fetch. Чистая логика без сети,
 * чтобы покрываться node:test (см. scans-core.ts — тот же приём для путей сканов).
 *
 * Мост нужен потому, что renderer не может забрать картинку с чужого хоста (CORS).
 * Но URL иконки приходит из гостевой страницы (`link[rel~="icon"]`), поэтому без
 * проверки это запрос с куками сессии на любой хост, включая внутреннюю сеть.
 */

type Allowlist = readonly string[] | unknown

/** Хост URL в нижнем регистре; '' для мусора, data:, javascript: и прочих схем */
function hostOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  return parsed.host.toLowerCase()
}

/** Шаблон allowlist: `*.domain` — сам домен и поддомены, иначе точное совпадение */
function hostMatchesPattern(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase()
  if (!p) return false
  if (p.startsWith('*.')) {
    const domain = p.slice(2)
    if (!domain) return false
    return host === domain || host.endsWith(`.${domain}`)
  }
  return host === p
}

/**
 * Иконку вкладки качать можно только у хста самой страницы или у хоста из
 * allowlist. Всё остальное — отказ: гость не должен превращать мост в probes
 * во внутреннюю сеть. allowlistEnabled=false снимает проверку (как у isAllowedUrl).
 */
export function isAllowedFaviconUrl(
  faviconUrl: unknown,
  pageUrl: unknown,
  allowlist: Allowlist,
  allowlistEnabled: boolean,
): boolean {
  const host = hostOf(faviconUrl)
  if (!host) return false
  if (allowlistEnabled === false) return true
  const pageHost = hostOf(pageUrl)
  if (pageHost && host === pageHost) return true
  if (!Array.isArray(allowlist)) return false
  return allowlist.some((pattern) => typeof pattern === 'string' && hostMatchesPattern(host, pattern))
}
