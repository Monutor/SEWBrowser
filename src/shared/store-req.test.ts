import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { asStoreReqs, PLUGIN_NAME_RE, STORE_VALUE_MAX } from './store-req.ts'

describe('asStoreReqs — запись chrome.storage.local из гостя', () => {
  it('корректный set проходит без изменений', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'tasks-notify', op: 'set', data: { seen: { 1: 2 } } }]), [
      { plugin: 'tasks-notify', op: 'set', data: { seen: { 1: 2 } } },
    ])
  })

  it('корректный remove проходит, ключи остаются строками', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'sew-helper', op: 'remove', keys: ['a', 'b'] }]), [
      { plugin: 'sew-helper', op: 'remove', keys: ['a', 'b'] },
    ])
  })

  it('не-объекты и массивы отбрасываются', () => {
    assert.deepEqual(asStoreReqs([null, undefined, 5, 'x', ['a']]), [])
  })

  it('пустая очередь — пустой результат', () => {
    assert.deepEqual(asStoreReqs([]), [])
  })

  it('без plugin отбрасывается', () => {
    assert.deepEqual(asStoreReqs([{ op: 'set', data: {} }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 7, op: 'set', data: {} }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: '', op: 'set', data: {} }]), [])
  })

  it('plugin вне безопасного имени файла отбрасывается (path traversal)', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', 'a b', 'a'.repeat(65)]) {
      assert.deepEqual(asStoreReqs([{ plugin: bad, op: 'set', data: {} }]), [], `plugin=${bad}`)
    }
  })

  it('безопасные имена плагинов принимаются', () => {
    assert.ok(PLUGIN_NAME_RE.test('sew-inventory'))
    assert.ok(PLUGIN_NAME_RE.test('tasks-notify'))
    assert.ok(PLUGIN_NAME_RE.test('a'))
  })

  it('неизвестный op отбрасывается', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'drop', data: {} }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 'a' }]), [])
  })

  it('set без объекта данных отбрасывается', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'set' }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'set', data: [] }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'set', data: 5 }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'set', data: null }]), [])
  })

  it('remove без массива ключей отбрасывается', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'remove' }]), [])
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'remove', keys: 'a' }]), [])
  })

  it('не-строковые ключи remove отфильтровываются', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'remove', keys: ['x', 1, null, 'y'] }]), [
      { plugin: 'a', op: 'remove', keys: ['x', 'y'] },
    ])
  })

  it('remove, у которого не осталось ключей, отбрасывается', () => {
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'remove', keys: [1, 2] }]), [])
  })

  it('слишком большой payload отбрасывается — гостю нельзя забить диск', () => {
    const huge = { blob: 'x'.repeat(STORE_VALUE_MAX + 1) }
    assert.deepEqual(asStoreReqs([{ plugin: 'a', op: 'set', data: huge }]), [])
  })

  it('payload ровно на границе проходит', () => {
    // {"blob":"..."} — обёртка сама добавляет ~11 байт, поэтому берём с запасом
    const data = { blob: 'x'.repeat(STORE_VALUE_MAX - 64) }
    assert.equal(asStoreReqs([{ plugin: 'a', op: 'set', data }]).length, 1)
  })
})