import assert from 'node:assert/strict'
import { test } from 'node:test'

const moduleUrl = new URL('../src/renderer/src/task-alert.ts', import.meta.url)

function makeElement() {
  return { hidden: true, textContent: '', onclick: null, style: {}, offsetWidth: 0 }
}

test('баннер задания остаётся видимым до закрытия или перехода', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  const root = makeElement()
  const title = makeElement()
  const text = makeElement()
  const open = makeElement()
  const all = makeElement()
  const close = makeElement()
  const bar = makeElement()
  const opened = []

  const alert = loaded.createTaskAlert({ root, title, text, open, all, close, bar })
  alert.show('Новое задание: перемещение', () => opened.push('opened'))

  assert.equal(root.hidden, false)
  assert.equal(title.textContent, 'Новое задание')
  assert.equal(text.textContent, 'Новое задание: перемещение')

  open.onclick()
  assert.equal(root.hidden, true)
  assert.deepEqual(opened, ['opened'])

  alert.show('Новая выдача: самовывоз', () => opened.push('opened again'))
  assert.equal(root.hidden, false)
  close.onclick()
  assert.equal(root.hidden, true)
  assert.deepEqual(opened, ['opened'])
})

test('для перемещения доступны переход к заданию и списку', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  assert.deepEqual(
    loaded.getTaskAlertUrls({
      kind: 'relocation',
      id: 1626328,
      url: '/v2/relocation/tasks',
    }),
    {
      open: '/v2/relocation/tasks/1626328',
      all: '/v2/relocation/tasks',
    },
  )

  const root = makeElement()
  const all = makeElement()
  const actions = []
  const alert = loaded.createTaskAlert({
    root,
    title: makeElement(),
    text: makeElement(),
    open: makeElement(),
    all,
    close: makeElement(),
    bar: makeElement(),
  })
  alert.show('Задание №1626328', () => actions.push('open'), () => actions.push('all'))

  assert.equal(all.hidden, false)
  all.onclick()
  assert.deepEqual(actions, ['all'])
  assert.equal(root.hidden, true)
})

test('для выдачи остаётся только переход к текущему URL', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  assert.deepEqual(
    loaded.getTaskAlertUrls({
      kind: 'handover',
      id: 42,
      url: '/v2/handover-v2/tasks',
    }),
    { open: '/v2/handover-v2/tasks' },
  )

  const all = makeElement()
  const alert = loaded.createTaskAlert({
    root: makeElement(),
    title: makeElement(),
    text: makeElement(),
    open: makeElement(),
    all,
    close: makeElement(),
    bar: makeElement(),
  })
  alert.show('Новая выдача', () => undefined)

  assert.equal(all.hidden, true)
  assert.equal(all.onclick, null)
})

test('для перемещения баннер показывает номер и зоны', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  assert.equal(
    loaded.formatTaskAlertText({
      kind: 'relocation',
      title: 'Новое задание: перемещение',
      body: '#42 · Зона источника → Зона приёмника',
    }),
    'Задание №42 · Источник: Зона источника · Приемник: Зона приёмника',
  )
})

test('полоска таймера тикает на время показа и прячется вместе с карточкой', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  const root = makeElement()
  const bar = makeElement()
  const alert = loaded.createTaskAlert({
    root,
    title: makeElement(),
    text: makeElement(),
    open: makeElement(),
    all: makeElement(),
    close: makeElement(),
    bar,
  })

  alert.show('Задание №42', () => undefined, undefined, 60)
  assert.equal(bar.hidden, false)
  assert.equal(bar.style.animationDuration, '60s')
  // Сброс анимации перед рестартом — иначе повторный show не поедет заново.
  assert.equal(bar.style.animation, '')

  // TTL = 0 («не скрывать») — таймеру нечего показывать.
  alert.show('Новая выдача', () => undefined, undefined, 0)
  assert.equal(bar.hidden, true)
})

test('таймер перезапускается с нуля на каждом новом задании', async () => {
  const loaded = await import(moduleUrl).catch(() => null)
  assert.ok(loaded, 'task-alert module should exist')
  const bar = makeElement()
  const alert = loaded.createTaskAlert({
    root: makeElement(),
    title: makeElement(),
    text: makeElement(),
    open: makeElement(),
    all: makeElement(),
    close: makeElement(),
    bar,
  })

  alert.show('Первое', () => undefined, undefined, 30)
  assert.equal(bar.style.animationDuration, '30s')
  alert.show('Второе', () => undefined, undefined, 90)
  assert.equal(bar.style.animationDuration, '90s')
  alert.close()
  assert.equal(bar.hidden, true)
})
