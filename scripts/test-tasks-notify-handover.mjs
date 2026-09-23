// RED: грузит features/tasks-notify/tasks-notify.js в vm со стабами и
// проверяет опрос выдачи (handover). Запуск: node scripts/test-tasks-notify-handover.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const HANDOVER_TASK = {
  objectId: 'S187',
  taskId: 381001,
  orderNumber: '4102571553',
  status: 'CREATED',
  type: { code: 'MPP_PICKUP', description: 'Самовывоз' },
  operationType: 'HANDOVER_TASK',
}

function makeSandbox(handoverTasks) {
  const store = {}
  const urls = []
  let tickCb = null
  const stubFetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || ''
    urls.push(u)
    if (u.includes('/api/io-handover-v2-bff/task')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ responseBody: { tasks: handoverTasks } }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ responseBody: { relocations: [] } }) })
  }
  const sandbox = {
    console,
    setInterval: (cb) => { tickCb = cb; return 1; },
    clearInterval: () => {},
    setTimeout: () => 0,
    fetch: stubFetch,
    window: null,
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {}
            for (const k of keys) if (k in store) out[k] = store[k]
            cb(out)
          },
          set: (obj, cb) => { Object.assign(store, obj); cb(); },
        },
      },
    },
  }
  sandbox.window = { fetch: stubFetch }
  vm.createContext(sandbox)
  const src = readFileSync('features/tasks-notify/tasks-notify.js', 'utf8')
  vm.runInContext(src, sandbox, { filename: 'tasks-notify.js' })
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); }
  return { sandbox, store, urls, tick: () => tickCb(), flush }
}

test('первый тик без Bearer — пропуск (awaiting SPA auth)', async () => {
  const t = makeSandbox([])
  await t.flush()
  assert.equal(t.sandbox.window.__tasksNotifyState.lastError, 'awaiting SPA auth')
})

test('выдача: новое задание попадает в очередь с url handover', async () => {
  const t = makeSandbox([HANDOVER_TASK])
  await t.flush()
  // Сеем Bearer через перехваченный запрос SPA (как в живом flow)
  await t.sandbox.window.fetch('/v2/api/io-relocation-bff/relocation/search', {
    headers: { Authorization: 'Bearer test-token' },
  })
  await t.tick()
  await t.flush()
  const req = t.sandbox.window.__tasksNotifyReq
  // baseline: первый тик с Bearer молча сидит seen, очередь пуста
  assert.equal(req.length, 0)
  assert.ok(t.urls.some((u) => u.includes('/api/io-handover-v2-bff/task?objectId=S187')))
  // Второй тик с новым заданием — уже не baseline
  t.store.seenHandover = { 999: Date.now() }
  await t.tick()
  await t.flush()
  assert.equal(t.sandbox.window.__tasksNotifyReq.length, 1)
  const item = t.sandbox.window.__tasksNotifyReq[0]
  assert.equal(item.id, 381001)
  assert.equal(item.url, '/v2/handover-v2/tasks')
  assert.equal(item.kind, 'handover')
  assert.ok(item.title.includes('4102571553'))
  // Повторный тик — дублей нет
  await t.tick()
  await t.flush()
  assert.equal(t.sandbox.window.__tasksNotifyReq.length, 1)
})
