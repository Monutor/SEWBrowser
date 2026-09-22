import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { screenshotFileName } from './screenshot.ts'

describe('screenshotFileName', () => {
  it('строит имя sew-shot-YYYY-MM-DD-HH-mm-ss.png', () => {
    assert.equal(screenshotFileName(new Date(2026, 8, 16, 14, 5, 9)), 'sew-shot-2026-09-16-14-05-09.png')
  })

  it('добивает нулями однозначные компоненты даты', () => {
    assert.equal(screenshotFileName(new Date(2026, 0, 2, 3, 4, 5)), 'sew-shot-2026-01-02-03-04-05.png')
  })
})
