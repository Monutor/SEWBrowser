import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseGuestFlag, toggleTitle } from './inventory-core.ts'

describe('parseGuestFlag', () => {
  it('читает "1" как показанную панель', () => {
    assert.equal(parseGuestFlag('1'), true)
  })
  it('читает "0" как скрытую панель', () => {
    assert.equal(parseGuestFlag('0'), false)
  })
  it('режет пробелы', () => {
    assert.equal(parseGuestFlag(' 1 '), true)
  })
  it('возвращает null на "?" — плагина нет в госте', () => {
    assert.equal(parseGuestFlag('?'), null)
  })
  it('возвращает null на мусоре и на нестроке', () => {
    assert.equal(parseGuestFlag('да'), null)
    assert.equal(parseGuestFlag(undefined), null)
    assert.equal(parseGuestFlag(null), null)
    assert.equal(parseGuestFlag(1), null)
  })
})

describe('toggleTitle', () => {
  it('на открытой панели обещает скрыть', () => {
    assert.equal(toggleTitle(true), 'Скрыть панель «Автоподсчёт ЛП»')
  })
  it('на закрытой обещает показать', () => {
    assert.equal(toggleTitle(false), 'Показать панель «Автоподсчёт ЛП»')
  })
})