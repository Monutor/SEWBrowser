import { net } from 'electron'

/** Единственные URL, доступные через BFF-мост (BFF mvideo для sew-helper) */
const BFF_URL_RE = /^https:\/\/www\.mvideo\.ru\/(bff\/product-details\?productId=[\w-]+|products\/[\w-]+)\/?$/

export interface BffResult {
  ok: boolean
  status: number
  data: unknown
}

const FAIL: BffResult = { ok: false, status: 0, data: null }

/**
 * Запрос к BFF mvideo из main-процесса. Гость ходить туда напрямую не может:
 * BFF отдаёт ACAO только www.mvideo.ru, из страницы SEW запрос режется CORS.
 * net.fetch CORS не подвержен, а куки у него общие с гостевыми webview
 * (default session). URL строго из BFF_URL_RE — мост не должен становиться
 * открытым прокси.
 *
 * Пользуются и renderer (ipc 'net:fetch' — гостевая страница вкладки), и
 * окна страницы (см. pageWindow.ts: там насос BFF крутится без renderer).
 */
export async function bffFetch(url: unknown): Promise<BffResult> {
  if (typeof url !== 'string' || !BFF_URL_RE.test(url)) return FAIL
  try {
    const sku = /productId=([\w-]+)/.exec(url)?.[1]
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (sku) {
      // прогрев кук — зеркалит ensureCookies() из background.js расширения
      try {
        await (await net.fetch(`https://www.mvideo.ru/products/${sku}`)).text()
      } catch {
        // прогрев не критичен — пробуем BFF как есть
      }
      headers.Referer = `https://www.mvideo.ru/products/${sku}`
    }
    const res = await net.fetch(url, { headers })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    return { ok: res.ok, status: res.status, data }
  } catch {
    return FAIL
  }
}
