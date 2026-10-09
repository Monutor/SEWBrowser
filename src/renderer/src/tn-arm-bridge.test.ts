import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Склейка ровно как делает loader: parts.join('\n;\n') — core.js, затем tasks-notify.js.
// Проверяем, что arm подхватывает новый период БЕЗ перезагрузки страницы.
//
// Таймеры подменяются ИНЪЕКЦИЕЙ В КОД (setInterval/clearInterval — параметры
// new Function), а не через window: плагин зовёт глобальные setInterval, и
// настоящий таймер на 300 с держал бы event loop стенда.
function loadPlugin(initial: Record<string, unknown>) {
  const parts = ['core.js', 'tasks-notify.js'].map(
    (f) => readFileSync(new URL(`../../../features/tasks-notify/${f}`, import.meta.url), 'utf8'),
  )
  const code = parts.join('\n;\n')
  const timers: Array<{ ms: number; fn: () => void }> = []
  const settings: Record<string, unknown> = { ...initial }
  const live = (): Array<{ ms: number }> => timers.filter((t) => t.ms > 0)
  const setInterval = (fn: () => void, ms: number): number => {
    timers.push({ ms, fn })
    return timers.length
  }
  const clearInterval = (id: number): void => {
    const t = timers[id - 1]
    if (t) t.ms = -1
  }
  const win: Record<string, unknown> = {
    __shellPollHost: true,
    __tnHooked: true, // перехват Bearer тут не нужен
  }
  const chrome = {
    storage: {
      local: {
        get: (_keys: unknown, cb: (res: Record<string, unknown>) => void) => cb({ settings }),
        set: (_obj: unknown, cb: () => void) => cb(),
      },
    },
  }
  // Тик без Bearer выходит сразу, но подстрахуемся: сети в стенде нет.
  const fetch = (): Promise<never> => Promise.reject(new Error('нет сети в стенде'))
  const api = new Function(
    'window',
    'chrome',
    'setInterval',
    'clearInterval',
    'fetch',
    code + '\nreturn { arm: __tnArm, armed: function () { return !!window.__tnArmed } }',
  )(win, chrome, setInterval, clearInterval, fetch) as { arm(): void; armed(): boolean }
  return { api, live, settings, timers }
}

test('первый arm ставит таймер с периодом из настроек', () => {
  const h = loadPlugin({ intervalSec: 300 })
  assert.equal(h.api.armed(), true)
  assert.equal(h.live().length, 1)
  assert.equal(h.live()[0]?.ms, 300000)
})

test('повторный arm с тем же периодом таймер не пересоздаёт', () => {
  const h = loadPlugin({ intervalSec: 300 })
  h.api.arm()
  h.api.arm()
  h.api.arm()
  assert.equal(h.live().length, 1)
  assert.equal(h.live()[0]?.ms, 300000)
})

test('смена периода в настройках переставляет таймер без перезагрузки', () => {
  const h = loadPlugin({ intervalSec: 60 })
  assert.equal(h.live()[0]?.ms, 60000)
  // Пользователь поставил 300 с в панели настроек и сохранил.
  h.settings.intervalSec = 300
  h.api.arm()
  assert.equal(h.live().length, 1, 'старый таймер должен быть снят, новый — один')
  assert.equal(h.live()[0]?.ms, 300000)
})

test('обратная смена периода тоже применяется', () => {
  const h = loadPlugin({ intervalSec: 300 })
  h.settings.intervalSec = 60
  h.api.arm()
  assert.equal(h.live().length, 1)
  assert.equal(h.live()[0]?.ms, 60000)
})

test('мусор в периоде не ломает таймер и не плодит дубли', () => {
  const h = loadPlugin({ intervalSec: 'ерунда' })
  assert.equal(h.live()[0]?.ms, 60000)
  h.api.arm()
  h.api.arm()
  assert.equal(h.live().length, 1)
  assert.equal(h.live()[0]?.ms, 60000)
})
