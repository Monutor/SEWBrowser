/**
 * Шим гостевой страницы проверяем в node: он работает только с полями window,
 * DOM не нужен — достаточно подсунуть объект-окно.
 *
 * Проверяем канал store: у <webview> нет preload, поэтому window.shell в госте
 * отсутствует и запись chrome.storage.local должна уйти в очередь
 * window.__shellStoreReq, а не остаться в памяти страницы (её затирает
 * pushPluginStores снапшотом из main).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHROME_SHIM } from './chrome-shim.ts'

type StoreLocal = {
  get(keys?: unknown, cb?: (v: unknown) => void): unknown
  set(obj: unknown, cb?: () => void): unknown
  remove(keys: unknown, cb?: () => void): unknown
}

/** Окно гостя + прогон шима по нему */
function runShim(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const win: Record<string, unknown> = { ...extra }
  new Function('window', CHROME_SHIM)(win)
  return win
}

function localOf(win: Record<string, unknown>): StoreLocal {
  return (win.chrome as { storage: { local: StoreLocal } }).storage.local
}

function chromeFor(win: Record<string, unknown>, name: string): StoreLocal {
  const factory = win.__shellChromeFor as (n: string) => { storage: { local: StoreLocal } }
  return factory(name).storage.local
}

describe('chrome-шим: запись storage из гостя без preload', () => {
  it('set без моста кладёт запись в очередь window.__shellStoreReq', () => {
    const win = runShim({ __shellPluginName: 'tasks-notify' })
    localOf(win).set({ seen: { '111': { t: 1 } } })
    assert.deepEqual(win.__shellStoreReq, [
      { plugin: 'tasks-notify', op: 'set', data: { seen: { '111': { t: 1 } } } },
    ])
  })

  it('set кладёт данные и в снимок страницы — чтение не ждёт ответа моста', () => {
    const win = runShim({ __shellPluginName: 'tasks-notify' })
    localOf(win).set({ seen: { '111': { t: 1 } } })
    assert.deepEqual((win.__shellPluginStores as Record<string, unknown>)['tasks-notify'], {
      seen: { '111': { t: 1 } },
    })
  })

  it('фабрика __shellChromeFor пишет от своего имени плагина', () => {
    const win = runShim({ __shellPluginName: 'tasks-notify' })
    chromeFor(win, 'sew-helper').set({ barcodeDbIndex: { a: 1 } })
    assert.deepEqual(win.__shellStoreReq, [
      { plugin: 'sew-helper', op: 'set', data: { barcodeDbIndex: { a: 1 } } },
    ])
  })

  it('remove кладёт список ключей в очередь', () => {
    const win = runShim()
    chromeFor(win, 'sew-inventory').remove(['zoneByLp', 'lastRun'])
    assert.deepEqual(win.__shellStoreReq, [
      { plugin: 'sew-inventory', op: 'remove', keys: ['zoneByLp', 'lastRun'] },
    ])
  })

  it('remove без ключей не засоряет очередь', () => {
    const win = runShim()
    chromeFor(win, 'sew-inventory').remove([])
    chromeFor(win, 'sew-inventory').remove(undefined)
    assert.deepEqual(win.__shellStoreReq ?? [], [])
  })

  it('set при живом мосте идёт в IPC и в очередь не попадает', async () => {
    const calls: unknown[] = []
    const win = runShim({
      __shellPluginName: 'tasks-notify',
      shell: {
        pluginDataGet: async () => ({}),
        pluginDataSet: (plugin: string, data: unknown) => {
          calls.push([plugin, data])
          return Promise.resolve(true)
        },
      },
    })
    await localOf(win).set({ seen: { '1': 1 } })
    assert.deepEqual(calls, [['tasks-notify', { seen: { '1': 1 } }]])
    assert.equal(win.__shellStoreReq, undefined)
  })

  it('очередь обрезается, чтобы страница не съела память гостя', () => {
    const win = runShim({ __shellPluginName: 'tasks-notify' })
    for (let i = 0; i < 250; i += 1) localOf(win).set({ n: i })
    const queue = win.__shellStoreReq as { data: { n: number } }[]
    assert.equal(queue.length, 200)
    assert.equal(queue[0].data.n, 50)
    assert.equal(queue[queue.length - 1].data.n, 249)
  })

  it('get без моста читает из снимка window.__shellPluginStores', async () => {
    const win = runShim({
      __shellPluginName: 'tasks-notify',
      __shellPluginStores: { 'tasks-notify': { seen: { a: 1 } } },
    })
    const all = await Promise.resolve(localOf(win).get())
    assert.deepEqual(all, { seen: { a: 1 } })
  })
})
