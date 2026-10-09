import assert from 'node:assert/strict'
import test from 'node:test'

import { resetNestedTemplateModals } from './templates-modals.ts'

interface FakeEl {
  cls: Set<string>
  removed: string[]
  onclick: unknown
  classList: { remove(name: string): void }
}

function fakeEl(withOpen: boolean): FakeEl {
  const cls = new Set<string>(withOpen ? ['open'] : [])
  const el: FakeEl = {
    cls,
    removed: [],
    onclick: null,
    classList: {
      remove(name: string) {
        el.removed.push(name)
        cls.delete(name)
      }
    }
  }
  return el
}

function fakeDoc(els: Record<string, FakeEl | null>): Document {
  return { getElementById: (id: string) => (els[id] ?? null) } as unknown as Document
}

test('закрытие управления снимает .open с формы шаблона', () => {
  const form = fakeEl(true)
  resetNestedTemplateModals(fakeDoc({ templateModal: form }))
  assert.equal(form.cls.has('open'), false)
})

test('закрытие управления снимает .open с диалога подтверждения', () => {
  const confirm = fakeEl(true)
  resetNestedTemplateModals(fakeDoc({ confirmModal: confirm }))
  assert.equal(confirm.cls.has('open'), false)
})

test('закрытие управления отвязывает кнопку удаления', () => {
  const del = fakeEl(false)
  del.onclick = () => assert.fail('кнопка удаления не должна сработать после закрытия')
  resetNestedTemplateModals(fakeDoc({ confirmDeleteBtn: del }))
  assert.equal(del.onclick, null)
})

test('закрытие управления чистит все три узла разом', () => {
  const form = fakeEl(true)
  const confirm = fakeEl(true)
  const del = fakeEl(false)
  del.onclick = () => undefined
  resetNestedTemplateModals(fakeDoc({ templateModal: form, confirmModal: confirm, confirmDeleteBtn: del }))
  assert.equal(form.cls.has('open'), false)
  assert.equal(confirm.cls.has('open'), false)
  assert.equal(del.onclick, null)
})

test('неизвестные id не роняют закрытие', () => {
  assert.doesNotThrow(() => resetNestedTemplateModals(fakeDoc({})))
})

test('узел есть, но .open не стояло — закрытие идёт без ошибок', () => {
  const confirm = fakeEl(false)
  resetNestedTemplateModals(fakeDoc({ confirmModal: confirm }))
  assert.deepEqual(confirm.removed, ['open'])
})

test('чужой класс не снимается', () => {
  const form = fakeEl(false)
  form.cls.add('visible')
  resetNestedTemplateModals(fakeDoc({ templateModal: form }))
  assert.equal(form.cls.has('visible'), true)
})
