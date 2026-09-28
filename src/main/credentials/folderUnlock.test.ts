import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFolderUnlockStore, normalizeRememberMinutes } from './folderUnlock.ts'

describe('createFolderUnlockStore', () => {
  it('разблокирует папку на заданное число минут', () => {
    let now = 1_000_000
    const store = createFolderUnlockStore(() => now)
    store.unlock('f1', 5)
    assert.equal(store.isUnlocked('f1'), true)
    // 4:59 — ещё открыто, 5:01 — уже нет.
    now += 4 * 60_000 + 59_000
    assert.equal(store.isUnlocked('f1'), true)
    now += 2_000
    assert.equal(store.isUnlocked('f1'), false)
  })

  it('не трогает другие папки', () => {
    const store = createFolderUnlockStore(() => 0)
    store.unlock('f1', 5)
    assert.equal(store.isUnlocked('f2'), false)
  })

  it('lock снимает разблокировку, clear — все сразу', () => {
    const store = createFolderUnlockStore(() => 0)
    store.unlock('f1', 5)
    store.unlock('f2', 5)
    store.lock('f1')
    assert.equal(store.isUnlocked('f1'), false)
    assert.equal(store.isUnlocked('f2'), true)
    store.clear()
    assert.equal(store.isUnlocked('f2'), false)
  })

  it('мусорное время запоминания не разблокирует папку', () => {
    const store = createFolderUnlockStore(() => 0)
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) store.unlock('f1', bad)
    assert.equal(store.isUnlocked('f1'), false)
  })

  it('повторный unlock продлевает срок, дробные минуты округляются вниз', () => {
    let now = 0
    const store = createFolderUnlockStore(() => now)
    store.unlock('f1', 1)
    now += 60_000
    store.unlock('f1', 0.5)
    assert.equal(store.isUnlocked('f1'), false)
    now = 0
    store.unlock('f1', 5)
    now += 60_000
    store.unlock('f1', 10)
    now += 5 * 60_000
    assert.equal(store.isUnlocked('f1'), true)
  })
})

describe('normalizeRememberMinutes', () => {
  it('оставляет корректные минуты как есть', () => {
    assert.equal(normalizeRememberMinutes(5, 5), 5)
    assert.equal(normalizeRememberMinutes(60, 5), 60)
  })

  it('дробные минуты округляет вниз, мусор берёт из fallback', () => {
    assert.equal(normalizeRememberMinutes('7.9', 5), 7)
    assert.equal(normalizeRememberMinutes('', 5), 5)
    assert.equal(normalizeRememberMinutes('abc', 5), 5)
    assert.equal(normalizeRememberMinutes(Number.NaN, 5), 5)
  })

  it('держит значение в диапазоне 1..1440', () => {
    assert.equal(normalizeRememberMinutes(0, 5), 1)
    assert.equal(normalizeRememberMinutes(-10, 5), 1)
    assert.equal(normalizeRememberMinutes(100000, 5), 1440)
  })
})
