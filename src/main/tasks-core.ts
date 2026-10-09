/**
 * Чистая логика санитизации уведомлений tasks-notify.
 *
 * Зачем: title/body/url приходят в main ОТ ГОСТЕВОЙ СТРАНИЦЫ (недоверенный
 * SPA set.mvideoeldorado.ru) через window.__sewTasksReq. Раньше проверялись
 * только typeof у id и title: гость мог напечатать в системном уведомлении
 * приложения любой текст и подсунуть ссылку на любой https-хост, а клик по
 * уведомлению открывал её вместо SEW.
 */

/** Заглушка: открыть список заданий, если гость не дал годный url. */
export const TASKS_DEFAULT_PATH = '/v2/relocation/tasks'

export const TITLE_MAX = 120
export const BODY_MAX = 400
export const URL_MAX = 512

export type TaskNotifyItem = { id: number; title: string; body: string; url: string }

/** Обрезать по границе символа (не разрывая суррогатную пару). */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value
  let cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  // хвост с высоким суррогатом — это половина пары, её отбрасываем
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/**
 * Разрешён ли url из уведомления: только http(s) и только хост из allowlist.
 * Пустая/битая строка допустима — её заменит заглушка.
 */
export function isAllowedNotifyUrl(url: string, isUrlAllowed: (url: string) => boolean): boolean {
  if (!url) return true
  if (!/^https?:\/\//i.test(url)) return false
  return isUrlAllowed(url)
}

/**
 * Привести пачку уведомлений к безопасному виду: отфильтровать мусор,
 * обрезать длины и заменить недоверенный url заглушкой.
 */
export function sanitizeTaskNotifications(
  items: unknown,
  isUrlAllowed: (url: string) => boolean,
): TaskNotifyItem[] {
  if (!Array.isArray(items)) return []
  const out: TaskNotifyItem[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const x = raw as { id?: unknown; title?: unknown; body?: unknown; url?: unknown }
    if (typeof x.id !== 'number' || !Number.isFinite(x.id)) continue
    if (typeof x.title !== 'string' || !x.title) continue
    const rawUrl = typeof x.url === 'string' ? x.url : ''
    // Обрезать url нельзя: обрыв пути/запроса даёт битую ссылку. Слишком
    // длинное, как и недоверенное, заменяем заглушкой.
    const url =
      rawUrl.length > 0 && rawUrl.length <= URL_MAX && isAllowedNotifyUrl(rawUrl, isUrlAllowed)
        ? rawUrl
        : TASKS_DEFAULT_PATH
    out.push({
      id: x.id,
      title: clamp(x.title, TITLE_MAX),
      body: typeof x.body === 'string' ? clamp(x.body, BODY_MAX) : '',
      url,
    })
  }
  return out
}
