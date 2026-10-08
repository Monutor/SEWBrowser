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

/** Логин SEW — личный табельный номер сотрудника (напр. 181165). Именно его
 *  SPA кладёт в `x-username` на каждом запросе подсистемы `/api/pricetags-*`
 *  (40 из 40 запросов в HAR); без него SEW не понимает, от чьего имени act, и
 *  отвечает 403 — вплоть до пустого списка шаблонов в оверлее ценников.
 *
 *  Набор символов сознательно узкий: значение уходит в HTTP-заголовок, поэтому
 *  пробел, перевод строки и не-ASCII пропускаем — иначе значение из config.json
 *  стало бы вектором инъекции заголовка. */
export function isValidSewUsername(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)
}

/** Страница SPA, с которой SEW ждёт запросы подсистемы ценников.
 *
 *  Зачем: наш запрос уходит из main через `net.fetch`, а не из страницы, поэтому
 *  браузер не проставляет за него `Referer`. В HAR у всех успешных запросов
 *  `/api/pricetags-*` этот заголовок есть, и шлюз вполне может отвечать на его
 *  отсутствие 403 с пустым телом — такое наблюдалось на живом SEW. */
const PRICETAG_PAGE = `${SEW_ORIGIN}/v2/pricetags/print/search`

/** Заголовки запроса к SEW: `Accept` и логин из конфига.
 *
 *  `Authorization: Bearer` здесь НЕ отправляется намеренно. По HAR SEW не носит
 *  Bearer нигде — 0 из 395 запросов `/api/*` и 0 из 128 `/v2/api/*`; сессия держится
 *  на куках, которые `net.fetch` берёт из общего хранилища. Наблюдалось: профиль
 *  `/v2/api/…` с лишним Bearer проходил, а `/api/pricetags-print-tasks/…` отбивал
 *  403 — шлюз один лишний заголовок терпит, другой нет. Bearer для `/v2/api/*`
 *  добавляется на стороне `request()`: HAR этого префикса не содержит вовсе, и
 *  осторожность стоит здесь дороже единообразия. */
export function sewHeaders(username?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // Незаданный или битый логин не подставляем «как есть»: пустой x-username
  // SEW трактует как анонимного пользователя, и отказ приходит оттуда же,
  // откуда пришёл бы при его отсутствии, — но уже с чуть другой диагностикой.
  if (isValidSewUsername(username)) headers['x-username'] = username
  return headers
}

/** Адрес страницы гостя — им сверяется, что вкладка именно SEW, а не SSO. */
const GUEST_URL_JS = 'location.href'

/** Логин, который живая SPA SEW кладёт в `x-username` (перехват в плагине
 *  `sew-auth`). Это то, за кого SEW видит текущую сессию: если поле «Логин SEW»
 *  в ценниках содержит другой табельный номер, подсистема ценников отвечает
 *  «Access Denied». Значение живёт только в памяти страницы. */
const SEW_USERNAME_JS = '(function () { try { return typeof window.__sewAuthUsername === "string" ? window.__sewAuthUsername : null } catch (e) { return null } })()'

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
  /** Логин SEW из конфига пользователя — заголовок `x-username`. Геттер, а не
   *  значение, потому что конфиг меняется на лету (`config:set`), и закеплированный
   *  в closure логин устарел бы до перезапуска. */
  sewUsername?: () => string
}

export interface SewApi {
  fetchBearer(): Promise<string | null>
  /** Логин текущей сессии SEW по перехвату SPA; null — перехвата не было
   *  (например, SPA ещё не делала запросов к подсистеме ценников). */
  fetchSessionUsername(): Promise<string | null>
  json(path: string, init?: SewHttpInit): Promise<unknown>
  text(path: string): Promise<string>
  /** POST, тело ответа не читается. Нужно там, где SEW отвечает 200 с пустым
   *  телом (content-length: 0) — закрытие задания печати ценников: res.json()
   *  такое тело отклоняет, и вызывающий получал бы ошибку вместо успеха. */
  post(path: string, body: unknown): Promise<void>
}

/** Ошибка HTTP-ответа SEW: `status` нужен вызывающему, чтобы отличить
 *  протухшую сессию (401) от запрета (403) — тексты разные. `body` — тело
 *  отказа: там SEW пишет настоящую причину, и без неё тексты выше остаются
 *  догадкой по коду. */
export interface SewStatusError extends Error {
  status: number
  body?: string
}

/** Тело не-2xx ответа. Не-JSON, оборванный поток или отсутствующий метод —
 *  пустая строка, а не исключение: разбор отказа не должен падать. */
async function readErrorBody(res: { text?: () => Promise<string> }): Promise<string> {
  if (typeof res.text !== 'function') return ''
  try {
    return (await res.text()).slice(0, 2000)
  } catch {
    return ''
  }
}

export function createSewApi(deps: SewApiDeps): SewApi {
  /** Первая вкладка SEW, у которой pick вернул непустое значение. Гость не на
   *  SEW-хосте (Keycloak SSO, подделанный домен) и неготовый пропускается —
   *  ровно как в fetchBearer. */
  async function firstFromSewGuest(pick: (id: number) => Promise<string | null>): Promise<string | null> {
    for (const id of deps.guestIds()) {
      let value: string | null = null
      try {
        const url = String((await deps.guestEval(id, GUEST_URL_JS)) ?? '')
        if (!isSewHost(url)) continue
        value = await pick(id)
      } catch {
        // гость ещё не готов (нет dom-ready) или уже выгружен — следующий
        continue
      }
      if (value) return value
    }
    return null
  }

  /** Заголовок Authorization из первой вкладки SEW, которая его отдала, иначе
   *  null. URL гостя сверяется обязательно: в allowlist есть Keycloak SSO
   *  (kc.tech.mvideo.ru), там в storage тоже лежит `keycloak.token` — без
   *  сверки чужой токен ушёл бы в запрос и SEW ответил бы 401, а вызывающий
   *  показал бы «сессия протухла». */
  async function fetchBearer(): Promise<string | null> {
    const raw = await firstFromSewGuest((id) =>
      Promise.resolve(deps.guestEval(id, SEW_BEARER_JS) as Promise<string | null>),
    )
    return bearerHeader(raw)
  }

  async function fetchSessionUsername(): Promise<string | null> {
    const raw = await firstFromSewGuest((id) =>
      Promise.resolve(deps.guestEval(id, SEW_USERNAME_JS) as Promise<string | null>),
    )
    const value = typeof raw === 'string' ? raw.trim() : ''
    return isValidSewUsername(value) ? value : null
  }

  async function request(path: string, init: SewHttpInit | undefined, as: 'json' | 'text' | 'none'): Promise<unknown> {
    const url = sewUrl(path)
    if (!url) throw new Error(`недопустимый путь SEW-API: ${path}`)
    // Вкладка SEW нужна как признак живой сессии и как источник Bearer: сам токен
    // уходит в заголовки у всех сервисов. Без вкладки нет и сессии — тогда нужен
    // внятный отказ, а не 401 от шлюза.
    const auth = await fetchBearer()
    if (!auth) throw new Error('вкладка SEW не найдена — откройте SEW, войдите и повторите')
    const res = await deps.fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: {
        ...sewHeaders(deps.sewUsername?.()),
        // Живой отказ вскрыл обе половины: к подсистеме ценников без Referer
        // шлюз отвечал 403, а с Referer, но без Bearer — 401. Нужны оба
        // заголовка сразу, поэтому шлём их везде, а не выбираем по префиксу
        // пути (профиль /v2/api/* отвечал 200 и с Bearer, и с Referer).
        Authorization: auth,
        Referer: PRICETAG_PAGE,
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!res.ok) {
      // Тело отказа — единственное место, где SEW пишет настоящую причину;
      // по коду статуса мы умеем только догадываться. Обрезаем, чтобы HTML-дамп
      // или капча не утекли в сообщение целиком, и читаем мягко: оборванный
      // поток не должен ронять разбор ответа.
      const err = new Error(
        `SEW ответил HTTP ${res.status} на ${init?.method ?? 'GET'} ${path}`,
      ) as SewStatusError
      err.status = res.status
      err.body = await readErrorBody(res)
      throw err
    }
    if (as === 'none') return undefined
    return as === 'text' ? res.text() : res.json()
  }

  return {
    fetchBearer,
    fetchSessionUsername,
    json: (path, init) => request(path, init, 'json') as Promise<unknown>,
    text: (path) => request(path, undefined, 'text') as Promise<string>,
    post: (path, body) => request(path, { method: 'POST', body }, 'none') as Promise<void>,
  }
}