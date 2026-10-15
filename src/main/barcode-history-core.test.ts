import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HISTORY_LIMIT, mergeHistory, parseHistory } from './barcode-history-core.ts'

/**
 * История введённых кодов товара: чистое ядро без electron, поэтому тестируется
 * как есть. Проверяем то, на чём потом строится список в оверлее «Штрихи».
 */
describe('parseHistory — файл истории', () => {
  it('читает список кодов', () => {
    assert.deepEqual(parseHistory(JSON.stringify({ skus: ['4258653', '400438912'], updatedAt: 1 })), [
      '4258653',
      '400438912',
    ])
  })

  it('битый JSON, объект вместо массива и не-строки дают пустой список', () => {
    assert.deepEqual(parseHistory('не json'), [])
    assert.deepEqual(parseHistory(JSON.stringify({ skus: '4258653' })), [])
    // Число приводится к строке (код мог записаться числом), null/{}/пробелы — вон
    assert.deepEqual(parseHistory(JSON.stringify({ skus: [null, {}, 1, '  ', '42'] })), ['1', '42'])
  })

  it('дубли в файле схлопываются, порядок сохраняется', () => {
    assert.deepEqual(parseHistory(JSON.stringify({ skus: ['1', '2', '1'] })), ['1', '2'])
  })
})

describe('mergeHistory — добавление кодов', () => {
  it('новые коды идут сверху, старые остаются ниже', () => {
    assert.deepEqual(mergeHistory(['1', '2'], ['3']), ['3', '1', '2'])
  })

  it('повторный ввод поднимает код наверх, а не дублирует его', () => {
    assert.deepEqual(mergeHistory(['1', '2', '3'], ['3']), ['3', '1', '2'])
  })

  it('внутри одного ввода порядок сохраняется', () => {
    assert.deepEqual(mergeHistory([], ['9', '8', '7']), ['9', '8', '7'])
  })

  it('мусор и пустые коды отбрасываются', () => {
    const mixed = ['', '  ', null, 5, '2'] as unknown as string[]
    assert.deepEqual(mergeHistory(['1'], mixed), ['5', '2', '1'])
  })

  it('лимит режет хвост, свежие коды остаются', () => {
    const current = Array.from({ length: 5 }, (_, i) => String(i + 1))
    assert.deepEqual(mergeHistory(current, ['6', '7'], 4), ['6', '7', '1', '2'])
    assert.equal(mergeHistory(current, [], 4).length, 4)
  })

  it('пустое добавление историю не меняет', () => {
    assert.deepEqual(mergeHistory(['1'], []), ['1'])
  })

  it('лимит по умолчанию — HISTORY_LIMIT', () => {
    const many = Array.from({ length: HISTORY_LIMIT + 50 }, (_, i) => String(i + 1))
    assert.equal(mergeHistory([], many).length, HISTORY_LIMIT)
  })
})