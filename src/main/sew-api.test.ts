import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSewApi, isSewHost, safeHost, sewHeaders, sewUrl, SEW_ORIGIN } from './sew-api.ts'

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
    guestEval: () => Promise.resolve('Bearer tok'),
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
    guestEval: () => Promise.resolve('Bearer tok'),
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
    guestEval: () => Promise.resolve('Bearer tok'),
  })
  await assert.rejects(() => api.json('/etc/passwd'), /недопустимый путь/)
  assert.equal(called, 0)
})

test('createSewApi: fetchBearer — гости по очереди, мусор отбрасывается, сеть не трогаем', async () => {
  const asked: number[] = []
  const api = createSewApi({
    guestIds: () => [1, 2],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    guestEval: (id) => {
      asked.push(id)
      // первый гость не готов (нет dom-ready) — уходим к следующему
      if (id === 1) return Promise.reject(new Error('гость недоступен'))
      return Promise.resolve('Bearer tok')
    },
  })
  assert.equal(await api.fetchBearer(), 'Bearer tok')
  assert.deepEqual(asked, [1, 2])

  const junk = createSewApi({
    guestIds: () => [1, 2],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    guestEval: (id) => Promise.resolve(id === 1 ? 'Bearer tok' : 'Bearer later'),
  })
  assert.equal(await junk.fetchBearer(), 'Bearer tok')

  const none = createSewApi({
    guestIds: () => [1],
    fetchImpl: () => Promise.reject(new Error('сеть не нужна')),
    // без префикса Bearer это не токен SEW, а мусор со страницы
    guestEval: () => Promise.resolve('eyJhbGciOi...'),
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
    guestEval: () => Promise.resolve('Bearer tok'),
  })
  assert.equal(await api.text('/api/x/csv'), 'a,b\n1,2')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${SEW_ORIGIN}/api/x/csv`)
  const init = seen[0].init as { method: string; body: unknown }
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
})