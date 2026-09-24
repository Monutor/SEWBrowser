import assert from 'node:assert/strict'
import { test } from 'node:test'

const moduleUrl = new URL('../src/renderer/src/task-alert.ts', import.meta.url)

function makeElement() {
  return { hidden: true, textContent: '', onclick: null }
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
  const opened = []

  const alert = loaded.createTaskAlert({ root, title, text, open, all, close })
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
