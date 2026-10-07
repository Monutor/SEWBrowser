import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSewApi, isSewHost, safeHost, sewHeaders, sewUrl, SEW_ORIGIN } from './sew-api.ts'

/** Мок гостя на SEW-странице: на запрос адреса отдаёт URL, на Bearer-скрипт — токен.
 *  Две ветки различать обязательно — клиент сперва сверяет, что вкладка SEW. */
function mockGuest(url = `${SEW_ORIGIN}/v2/`, token = 'Bearer tok'): (id: number, code: string) => Promise<unknown> {
  return (_id, code) => Promise.resolve(code === 'location.href' ? url : token)
}

test('sewUrl: принимает только /api и /v2/api пути SEW', () => {
  assert.equal(
    sewUrl('/api/pricetags-print-tasks/sew/pricetag/search'),
    `${SEW_ORIGIN}/api/pricetags-print-tasks/sew/pricetag/search`,
  )
  assert.equal(sewUrl('/v2/api/sew/v1/profile'), `${SEW_ORIGIN}/v2/api/sew/v1/profile`)
  assert.equal(sewUrl('/api/a b'), null)
  assert.equal(sewUrl('https://evil.example/api/x'), null)
  assert.equal(sewUrl('/api/../etc'), null)
  assert.equal(sewUrl('/other/x'), null)
  assert.equal(sewUrl('/api/naïve'), null)
  // второй '?' в query не проходит: разделитель должен быть один
  assert.equal(sewUrl('/api/x?a=1?b=2'), null)
})

test('sewUrl: абсолютный URL своего хоста принимается, чужого и другой — нет', () => {
  // runStockDownload передаёт готовый stockReportUrl(shop) — его надо пропустить
  const withQuery = `${SEW_ORIGIN}/v2/api/stockmanagement/report/stock-balance?storeId=S187`
  assert.equal(sewUrl(withQuery), withQuery)
  assert.equal(sewUrl(`${SEW_ORIGIN}/v2/api/sew/v1/profile?a=1`), `${SEW_ORIGIN}/v2/api/sew/v1/profile?a=1`)
  assert.equal(sewUrl('http://sew.mvideoeldorado.ru/v2/api/sew/v1/profile'), null)
  assert.equal(sewUrl('https://sew.mvideoeldorado.ru.evil.com/v2/api/x'), null)
  assert.equal(sewUrl(`${SEW_ORIGIN}/etc/passwd`), null)
})

test('sewHeaders: Bearer и Accept', () => {
  assert.deepEqual(sewHeaders('Bearer abc'), { Accept: 'application/json', Authorization: 'Bearer abc' })
})

test('safeHost/isSewHost: хост и его поддомены', () => {
  assert.equal(safeHost('https://sew.mvideoeldorado.ru/v2/'), 'sew.mvideoeldorado.ru')
  assert.equal(safeHost('не url'), '')
  assert.equal(isSewHost('https://sew.mvideoeldorado.ru/v2/'), true)
  assert.equal(isSewHost('https://mvideoeldorado.ru/v2/'), true)
  assert.equal(isSewHost('https://sew.mvideoeldorado.ru.evil.com/'), false)
  assert.equal(isSewHost('https://evil.com/'), false)
})

test('createSewApi: без Bearer — понятная ошибка, сеть не трогаем', async () => {
  let called = 0
  const api = createSewApi({
    guestIds: () => [],
    fetchImpl: () => {
      called += 1
      throw new Error('не должен быть вызван')
    },
    guestEval: () => Promise.reject(new Error('нет гостя')),
  })
  await assert.rejects(() => api.json('/api/x'), /Bearer SEW не найден/)
  assert.equal(called, 0)
})

test('createSewApi: POST уходит с Bearer и JSON-телом', async () => {
  const seen: Array<{ url: string; init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: (url, init) => {
      seen.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  const data = await api.json('/api/pricetags-print-tasks/sew/print-task', { method: 'POST', body: { a: 1 } })
  assert.deepEqual(data, { ok: 1 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${SEW_ORIGIN}/api/pricetags-print-tasks/sew/print-task`)
  const init = seen[0].init as { method: string; headers: Record<string, string>; body: string }
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers['Content-Type'], 'application/json')
  assert.equal(init.body, '{"a":1}')
})

test('createSewApi: не-2xx прокидывает status в ошибку', async () => {
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    guestEval: mockGuest(),
  })
  await assert.rejects(() => api.json('/api/x'), (err: Error & { status?: number }) => err.status === 403)
})

test('createSewApi: путь не проходит allowlist — запрос не делается', async () => {
  let called = 0
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: () => {
      called += 1
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  await assert.rejects(() => api.json('/etc/passwd'), /недопустимый путь/)
  assert.equal(called, 0)
})

test('createSewApi: гость не на SEW-хосте пропускается, токен берётся у следующего', async () => {
  const asked: Array<[number, string]> = []
  // 1 — Keycloak SSO: токен в storage есть, но вкладка не SEW;
  // 2 — подделанный хост sew.mvideoeldorado.ru.evil.com;
  // 3 — настоящая вкладка SEW, её токен и должен уйти в запрос.
  const urls = ['https://kc.tech.mvideo.ru/auth', 'https://sew.mvideoeldorado.ru.evil.com/v2/', `${SEW_ORIGIN}/v2/`]
  const api = createSewApi({
    guestIds: () => [1, 2, 3],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    guestEval: (id, code) => {
      const branch = code === 'location.href' ? 'url' : 'bearer'
      asked.push([id, branch])
      if (branch === 'url') return Promise.resolve(urls[id - 1])
      return Promise.resolve(id === 3 ? 'Bearer tok' : 'Bearer чужой')
    },
  })
  assert.equal(await api.fetchBearer(), 'Bearer tok')
  // у чужих гостей Bearer даже не спрашивали
  assert.deepEqual(asked, [[1, 'url'], [2, 'url'], [3, 'url'], [3, 'bearer']])
})

test('createSewApi: fetchBearer — гости по очереди, мусор отбрасывается, сеть не трогаем', async () => {
  const asked: Array<[number, string]> = []
  const api = createSewApi({
    guestIds: () => [1, 2],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    guestEval: (id, code) => {
      asked.push([id, code === 'location.href' ? 'url' : 'bearer'])
      // первый гость не готов (нет dom-ready) — уходим к следующему
      if (id === 1) return Promise.reject(new Error('гость недоступен'))
      return Promise.resolve(code === 'location.href' ? `${SEW_ORIGIN}/v2/` : 'Bearer tok')
    },
  })
  assert.equal(await api.fetchBearer(), 'Bearer tok')
  assert.deepEqual(asked, [[1, 'url'], [2, 'url'], [2, 'bearer']])

  const junk = createSewApi({
    guestIds: () => [1, 2],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    guestEval: (id, code) =>
      Promise.resolve(code === 'location.href' ? `${SEW_ORIGIN}/v2/` : id === 1 ? 'Bearer tok' : 'Bearer later'),
  })
  assert.equal(await junk.fetchBearer(), 'Bearer tok')

  const none = createSewApi({
    guestIds: () => [1],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    // без префикса Bearer это не токен SEW, а мусор со страницы
    guestEval: mockGuest(`${SEW_ORIGIN}/v2/`, 'eyJhbGciOi...'),
  })
  assert.equal(await none.fetchBearer(), null)
})

test('createSewApi: text() отдаёт строку как есть, без разбора JSON', async () => {
  const seen: Array<{ url: string; init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: (url, init) => {
      seen.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('a,b\n1,2') })
    },
    guestEval: mockGuest(),
  })
  assert.equal(await api.text('/api/x/csv'), 'a,b\n1,2')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${SEW_ORIGIN}/api/x/csv`)
  const init = seen[0].init as { method: string; body: unknown }
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
})