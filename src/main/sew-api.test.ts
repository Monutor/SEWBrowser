import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSewApi, isSewHost, isValidSewUsername, safeHost, sewHeaders, sewUrl, SEW_ORIGIN } from './sew-api.ts'

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

test('sewHeaders: только Accept — Authorization у SEW не используется', () => {
  // По HAR SEW не шлёт Bearer НИГДЕ: 0 из 395 запросов /api/* и 0 из 128
  // /v2/api/*. Сессия держится на куках сессии, которые net.fetch берёт из
  // общего хранилища. Лишний Authorization шлюз /api/ отбивал 403.
  assert.deepEqual(sewHeaders(), { Accept: 'application/json' })
  assert.deepEqual(sewHeaders('181165'), { Accept: 'application/json', 'x-username': '181165' })
  assert.equal('Authorization' in sewHeaders('181165'), false)
})

test('isValidSewUsername: табельный номер и подобное — да, мусор и инъекция — нет', () => {
  assert.equal(isValidSewUsername('181165'), true)
  assert.equal(isValidSewUsername('00193918'), true)
  assert.equal(isValidSewUsername('user_name-01.a'), true)
  assert.equal(isValidSewUsername(''), false)
  assert.equal(isValidSewUsername(' 181165'), false)
  assert.equal(isValidSewUsername('181 165'), false)
  assert.equal(isValidSewUsername('181165\r\nX-Evil: 1'), false)
  assert.equal(isValidSewUsername('ы'), false)
  assert.equal(isValidSewUsername('a'.repeat(65)), false)
  assert.equal(isValidSewUsername(181165), false)
  assert.equal(isValidSewUsername(null), false)
})

test('sewHeaders: логин SEW добавляет x-username, битое значение молча игнорируется', () => {
  assert.deepEqual(sewHeaders('181165'), {
    Accept: 'application/json',
    'x-username': '181165',
  })
  assert.deepEqual(sewHeaders('не валидный'), { Accept: 'application/json' })
})

test('createSewApi: к подсистеме ценников уходят и Bearer, и Referer', async () => {
  const seen: Array<{ init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '181165',
    fetchImpl: (_url, init) => {
      seen.push({ init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  // Живой отказ показал обе половины: без Referer шлюз отвечал 403, с Referer,
  // но без Bearer — 401. Значит подсистеме ценников нужны оба заголовка сразу,
  // а не выбор одного из них. HAR этого не показывал: запросы самой SPA ходят с
  // куками, поэтому Bearer там и не нужен, а у нашего net.fetch сессионные
  // куки могут не долететь — на них полагаться нельзя.
  await api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} })
  const init = seen[0].init as { headers: Record<string, string> }
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers['x-username'], '181165')
})
test('createSewApi: x-username берётся из конфига и уходит в запрос', async () => {
  const seen: Array<{ init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '181165',
    fetchImpl: (_url, init) => {
      seen.push({ init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  await api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} })
  const init = seen[0].init as { headers: Record<string, string> }
  assert.equal(init.headers['x-username'], '181165')
})

test('createSewApi: пустой логин в конфиге — запрос без x-username, а не с пустым', async () => {
  const seen: Array<{ init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '',
    fetchImpl: (_url, init) => {
      seen.push({ init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  await api.json('/api/pricetags-print-tasks/sew/pricetag/search')
  const init = seen[0].init as { headers: Record<string, string> }
  assert.equal('x-username' in init.headers, false)
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
  await assert.rejects(() => api.json('/api/x'), /вкладка SEW не найдена/)
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

test('createSewApi: post() не разбирает тело — пустой ответ SEW не ошибка', async () => {
  const seen: Array<{ url: string; init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: (url, init) => {
      seen.push({ url, init })
      // Закрытие задания печати ценников SEW отвечает 200 с content-length: 0:
      // res.json() такое тело отклоняет, и раньше это роняло всю сборку PDF.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
        text: () => Promise.resolve(''),
      })
    },
    guestEval: mockGuest(),
  })
  assert.equal(await api.post('/api/pricetags-print-tasks/sew/print-task/finish/20804168', {}), undefined)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${SEW_ORIGIN}/api/pricetags-print-tasks/sew/print-task/finish/20804168`)
  const init = seen[0].init as { method: string; headers: Record<string, string>; body: string }
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers['Content-Type'], 'application/json')
  assert.equal(init.body, '{}')
})

test('createSewApi: post() по-прежнему прокидывает status не-2xx', async () => {
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: () =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
        text: () => Promise.resolve(''),
      }),
    guestEval: mockGuest(),
  })
  await assert.rejects(() => api.post('/api/pricetags-print-tasks/sew/print-task/cancel/1', {}), (err: Error & { status?: number }) => err.status === 401)
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
test('createSewApi: при отказе SEW тело ответа не теряется, а в тексте ошибки видно какой запрос отбили', async () => {
  // Причина отказа объяснена только в теле: по коду 403 мы умеем лишь
  // догадаться («нет прав»). Плюс нужен сам путь — иначе отладка идёт вслепую.
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '181165',
    fetchImpl: () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
        text: () =>
          Promise.resolve('{"responseHeader":{"errors":[{"message":"Нет прав на шаблон"}]}}'),
      }),
    guestEval: mockGuest(),
  })
  await assert.rejects(
    () => api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} }),
    (err: unknown) => {
      const e = err as { status?: number; body?: string; message?: string }
      assert.equal(e.status, 403)
      assert.match(String(e.body), /Нет прав на шаблон/)
      assert.match(String(e.message), /403/)
      assert.match(String(e.message), /pricetag\/search/)
      return true
    },
  )
})

test('createSewApi: тело ошибки читается мягко — обрыв или не-JSON не роняют разбор ответа', async () => {
  const api = createSewApi({
    guestIds: () => [7],
    fetchImpl: () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
        text: () => Promise.reject(new Error('поток оборвался')),
      }),
    guestEval: mockGuest(),
  })
  await assert.rejects(
    () => api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} }),
    (err: unknown) => {
      const e = err as { status?: number; body?: string }
      assert.equal(e.status, 500)
      assert.equal(e.body, '')
      return true
    },
  )
})
test('createSewApi: Bearer уходит во все сервисы SEW, Referer — тоже', async () => {
  // Разводить сервисы по Bearer не нужно: профиль /v2/api/* отвечал 200 и с
  // ним, а подсистема ценников после появления Referer стала требовать и его
  // (иначе 401). Отсюда правило проще — шлём оба заголовка везде.
  const seen: Array<{ url: string; init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '181165',
    fetchImpl: (url, init) => {
      seen.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  await api.json('/v2/api/sew/v1/profile')
  await api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} })
  const profile = seen[0].init as { headers: Record<string, string> }
  const search = seen[1].init as { headers: Record<string, string> }
  assert.equal(profile.headers.Authorization, 'Bearer tok')
  assert.equal(search.headers.Authorization, 'Bearer tok')
  assert.equal(search.headers.Referer, `${SEW_ORIGIN}/v2/pricetags/print/search`)
})
test('createSewApi: к подсистеме ценников идёт Referer страницы SPA — net.fetch его не ставит', async () => {
  // По HAR у всех успешных запросов подсистемы Referer = страница SPA. Наш
  // fetch выполняется не из страницы, поэтому заголовок не проставляется сам,
  // а шлюз на его отсутствие вполне может отвечать 403 с пустым телом.
  const seen: Array<{ init: unknown }> = []
  const api = createSewApi({
    guestIds: () => [7],
    sewUsername: () => '181165',
    fetchImpl: (_url, init) => {
      seen.push({ init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') })
    },
    guestEval: mockGuest(),
  })
  await api.json('/api/pricetags-print-tasks/sew/pricetag/search', { method: 'POST', body: {} })
  const search = seen[0].init as { headers: Record<string, string> }
  assert.equal(search.headers.Referer, `${SEW_ORIGIN}/v2/pricetags/print/search`)
})