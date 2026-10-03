import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { scansToggleTitle } from './scans-core.ts'

describe('scansToggleTitle', () => {
  it('на блоке, который виден, предлагает скрыть', () => {
    assert.equal(scansToggleTitle(true), 'Скрыть блок «Сканы»')
  })

  it('на скрытом блоке предлагает показать', () => {
    assert.equal(scansToggleTitle(false), 'Показать блок «Сканы»')
  })

  it('одинаков для обоих состояний — состояния различаются', () => {
    assert.notEqual(scansToggleTitle(true), scansToggleTitle(false))
  })
})
