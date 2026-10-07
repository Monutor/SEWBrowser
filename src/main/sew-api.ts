import { bearerHeader } from './downloads/stockReport.ts'

/** Общий клиент SEW для main: адрес, заголовки, Bearer и разбор ответов.
 *  Без импорта electron — `net` и работа с гостями приходят инъекцией, иначе
 *  юнит-тесты `node --test` файл не поднимут (та же конвенция, что у
 *  createFolderUnlockStore в src/main/credentials/folderUnlock.ts).
 *  Импорт stockReport — с расширением `.ts` по той же причине: файл поднимает
 *  node сам, без сборки. */

export const SEW_ORIGIN = 'https://sew.mvideoeldorado.ru'
/** Хост API — тот же, что у SEW_ORIGIN, отдельным литералом не дублируем. */
const SEW_HOSTNAME = new URL(SEW_ORIGIN).hostname

const SEW_HOST_RE = /(^|\.)mvideoeldorado\.ru$/i
/** Мост не должен превратиться в прокси: путь строим только из литералов
 *  вызывающего кода, произвольные URL из renderer сюда не доходят. */
const SEW_PATH_RE = /^\/(v2\/)?api\/[\w\-./]*$/
/** Query — отдельно от пути: `stockReportUrl(shop)` отдаёт готовый URL с
 *  `?objectId=…`, и такой вызов не должен отбрасываться. Разделитель — первое
 *  вхождение `?`, второе не допускается: allowlist от этого не слабеет. */
const SEW_QUERY_RE = /^\?[\w\-._~%!$&'()*+,;=:@/]*$/

/** Хост URL в нижнем регистре; '' на не-строке/битом URL. */
export function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isSewHost(url: string): boolean {
  return SEW_HOST_RE.test(safeHost(url))
}

/** Полный URL SEW-API либо null, если путь не проходит allowlist. Принимает и
 *  путь (`/api/…`), и готовый абсолютный URL своего хоста — `stockReportUrl()`
 *  из stockReport.ts отдаёт второй, и его переписывать не нужно. */
export function sewUrl(target: string): string | null {
  if (typeof target !== 'string') return null
  let path = target
  if (/^https?:\/\//i.test(target)) {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return null
    }
    if (parsed.hostname.toLowerCase() !== SEW_HOSTNAME || parsed.protocol !== 'https:') return null
    path = parsed.pathname + parsed.search
  }
  const queryAt = path.indexOf('?')
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt)
  const query = queryAt < 0 ? '' : path.slice(queryAt)
  if (!SEW_PATH_RE.test(pathname) || (query && !SEW_QUERY_RE.test(query))) return null
  if (path.includes('..')) return null
  return `${SEW_ORIGIN}${pathname}${query}`
}

export function sewHeaders(auth: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: auth }
}

/** Адрес страницы гостя — им сверяется, что вкладка именно SEW, а не SSO. */
const GUEST_URL_JS = 'location.href'

/** Bearer SEW из localStorage гостя: `window.__sewAuthBearer` (его ставит плагин
 *  `features/sew-auth`), иначе токен keycloak. Перенесено из src/main/index.ts. */
const SEW_BEARER_JS = `(function () {
    try {
      if (typeof window.__sewAuthBearer === 'string' && window.__sewAuthBearer) {
        return window.__sewAuthBearer
      }
      var stores = []
      try { stores.push(window.sessionStorage) } catch (e) {}
      try { stores.push(window.localStorage) } catch (e) {}
      for (var i = 0; i < stores.length; i++) {
        var raw = stores[i].getItem('keycloak.token')
        if (!raw) continue
        var parsed = null
        try { parsed = JSON.parse(raw) } catch (e) {}
        var tok = parsed && (parsed.token || parsed.idToken || parsed.accessToken)
        if (typeof tok === 'string' && tok) return 'Bearer ' + tok
      }
    } catch (e) {}
    return null
  })()`

export interface SewHttpInit {
  method?: string
  body?: unknown
}

interface SewResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export interface SewApiDeps {
  /** Идентификаторы подключённых гостей. `attachedGuests` живёт внутри
   *  `createWindow()`, наружу не экспортируется — поэтому инъекция. */
  guestIds: () => Iterable<number>
  /** `net.fetch` из electron. */
  fetchImpl: (url: string, init?: unknown) => Promise<SewResponse>
  /** Выполняет код в госте; бросает, если гостя нет или он не готов. */
  guestEval(id: number, code: string): Promise<unknown>
}

export interface SewApi {
  fetchBearer(): Promise<string | null>
  json(path: string, init?: SewHttpInit): Promise<unknown>
  text(path: string): Promise<string>
  /** POST, тело ответа не читается. Нужно там, где SEW отвечает 200 с пустым
   *  телом (content-length: 0) — закрытие задания печати ценников: res.json()
   *  такое тело отклоняет, и вызывающий получал бы ошибку вместо успеха. */
  post(path: string, body: unknown): Promise<void>
}

/** Ошибка HTTP-ответа SEW: `status` нужен вызывающему, чтобы отличить
 *  протухшую сессию (401) от запрета (403) — тексты разные. */
export interface SewStatusError extends Error {
  status: number
}

export function createSewApi(deps: SewApiDeps): SewApi {
  /** Заголовок Authorization из первой вкладки SEW, которая его отдала, иначе
   *  null. URL гостя сверяется обязательно: в allowlist есть Keycloak SSO
   *  (kc.tech.mvideo.ru), там в storage тоже лежит `keycloak.token` — без
   *  сверки чужой токен ушёл бы в запрос и SEW ответил бы 401, а вызывающий
   *  показал бы «сессия протухла». */
  async function fetchBearer(): Promise<string | null> {
    for (const id of deps.guestIds()) {
      let raw: unknown = null
      try {
        const url = String((await deps.guestEval(id, GUEST_URL_JS)) ?? '')
        if (!isSewHost(url)) continue
        raw = await deps.guestEval(id, SEW_BEARER_JS)
      } catch {
        // гость ещё не готов (нет dom-ready) или уже выгружен — следующий
        continue
      }
      const header = bearerHeader(raw)
      if (header) return header
    }
    return null
  }

  async function request(path: string, init: SewHttpInit | undefined, as: 'json' | 'text' | 'none'): Promise<unknown> {
    const url = sewUrl(path)
    if (!url) throw new Error(`недопустимый путь SEW-API: ${path}`)
    const auth = await fetchBearer()
    if (!auth) throw new Error('Bearer SEW не найден: откройте страницу SEW и повторите')
    const res = await deps.fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: {
        ...sewHeaders(auth),
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!res.ok) {
      const err = new Error(`SEW ответил HTTP ${res.status}`) as SewStatusError
      err.status = res.status
      throw err
    }
    if (as === 'none') return undefined
    return as === 'text' ? res.text() : res.json()
  }

  return {
    fetchBearer,
    json: (path, init) => request(path, init, 'json') as Promise<unknown>,
    text: (path) => request(path, undefined, 'text') as Promise<string>,
    post: (path, body) => request(path, { method: 'POST', body }, 'none') as Promise<void>,
  }
}