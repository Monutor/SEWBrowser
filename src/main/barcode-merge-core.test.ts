import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTRA_LIMIT,
  mergeRows,
  normalizeRow,
  parseExtraJson,
  rowsFromIndexText,
  rowsFromSheet,
} from './barcode-merge-core.ts'

describe('normalizeRow', () => {
  it('принимает позицию с кодом товара и печатным ШК', () => {
    assert.deepEqual(normalizeRow({ sku: '400110453', barcode: '465575293017258909', name: '(МП) ZUGEL' }), {
      sku: '400110453',
      barcode: '465575293017258909',
      name: '(МП) ZUGEL',
    })
  })

  it('без кода товара позиция не годится', () => {
    assert.equal(normalizeRow({ sku: '', barcode: '461021658203858909', name: 'x' }), null)
    // Заголовок колонки, телефон из соседней ячейки — не код товара.
    assert.equal(normalizeRow({ sku: 'Материал', barcode: '461021658203858909' }), null)
    assert.equal(normalizeRow({ sku: '123-456', barcode: '461021658203858909' })?.sku, '123-456')
  })

  it('ШК — только цифры разумной длины: буквы рисуются как Code 128, но это не штрих', () => {
    assert.equal(normalizeRow({ sku: '400110453', barcode: 'не код' }), null)
    // Номер артикула в колонке ШК — самая частая ошибка чужого файла.
    assert.equal(normalizeRow({ sku: '400110453', barcode: 'ZOE602B' }), null)
    assert.equal(normalizeRow({ sku: '400110453', barcode: '' }), null)
    // Полоса из полусотни цифр на этикетке 95 мм не помещается.
    assert.equal(normalizeRow({ sku: '400110453', barcode: '1'.repeat(50) }), null)
    // Короткий код из базы печатается — Code 128 берёт любые цифры.
    assert.equal(normalizeRow({ sku: '400110453', barcode: '12' })?.barcode, '12')
    assert.equal(normalizeRow({ sku: '400110453', barcode: '4660294839975' })?.barcode, '4660294839975')
  })

  it('табы и переводы строк в наименовании не попадают в позицию', () => {
    const row = normalizeRow({ sku: '1', barcode: '461021658203858909', name: 'два\tтаба\nи перевод' })
    assert.equal(row?.name, 'два таба и перевод')
  })
})

describe('rowsFromSheet', () => {
  it('берёт колонки по заголовкам, а не по буквам', () => {
    const outcome = rowsFromSheet([
      ['Наименование', 'Материал', 'Код EAN/UPC'],
      ['(МП)В/И/пан. ZUGEL ZIH604B', '400110453', '465575293017258909'],
    ])
    assert.equal(outcome.rows.length, 1)
    assert.deepEqual(outcome.rows[0], {
      sku: '400110453',
      barcode: '465575293017258909',
      name: '(МП)В/И/пан. ZUGEL ZIH604B',
    })
  })

  it('«Номер товара Эльдорадо» не путается с кодом товара', () => {
    const outcome = rowsFromSheet([
      ['Материал', 'Номер товара Эльдорадо', 'Код EAN/UPC', 'Номер материала'],
      ['400110453', '590110453', '465575293017258909', '(МП) ZUGEL'],
    ])
    assert.equal(outcome.rows[0]?.sku, '400110453')
  })

  it('один артикул дважды с разными ШК — берётся последний', () => {
    // Так же ведёт себя поиск по индексу (last wins), иначе приложенный файл
    // печатал бы не тот штрих, который пользованик принёс последним.
    const outcome = rowsFromSheet([
      ['Материал', 'Код EAN/UPC'],
      ['400418437', '461021658148258909'],
      ['400418437', '461021658199458909'],
    ])
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.rows[0]?.barcode, '461021658199458909')
  })

  it('строки без кода или с непечатным ШК считаются пропущенными', () => {
    const outcome = rowsFromSheet([
      ['Материал', 'Код EAN/UPC'],
      ['400110453', '465575293017258909'],
      ['', '465575293017258909'],
      ['400110474', 'не код'],
    ])
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.skipped, 2)
  })

  it('в шапке нет нужных колонок — понятная ошибка с перечнем заголовков', () => {
    assert.throws(
      () => rowsFromSheet([['Товар', 'Цена'], ['чай', '100']]),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /нет колонки/)
        assert.match(message, /Материал/)
        assert.match(message, /Товар/)
        return true
      },
    )
  })

  it('пустой лист и файл без шапки — ошибка, а не ноль позиций', () => {
    assert.throws(() => rowsFromSheet([]), /пустой/)
    assert.throws(() => rowsFromSheet([['', '', '']]), /пустой/)
  })

  it('шапка может быть не первой строкой', () => {
    const outcome = rowsFromSheet([
      ['', '', ''],
      ['Отчёт по штрихам', '', ''],
      ['Материал', 'Код EAN/UPC'],
      ['400110453', '465575293017258909'],
    ])
    assert.equal(outcome.rows[0]?.sku, '400110453')
  })

  it('пустые хвосты строк не сдвигают колонки', () => {
    const outcome = rowsFromSheet([
      ['Материал', 'Код EAN/UPC', 'Номер материала'],
      ['400110453', '465575293017258909', 'ZUGEL'],
      ['400110474'],
    ])
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.skipped, 1)
  })
})

describe('rowsFromIndexText', () => {
  it('строки индекса чужого db.json становятся позициями', () => {
    const outcome = rowsFromIndexText(
      ['400110453\t465575293017258909\t(МП)В/И/пан. ZUGEL ZIH604B', '400110474\t461021658023258909\t(МП) ZOE602B'].join('\n'),
    )
    assert.equal(outcome.rows.length, 2)
    assert.equal(outcome.rows[1]?.sku, '400110474')
    assert.equal(outcome.rows[1]?.name, '(МП) ZOE602B')
  })

  it('битая строка стоит одной позиции, а не всего файла', () => {
    const outcome = rowsFromIndexText('мусор\n400110453\t465575293017258909\tZUGEL\n')
    assert.equal(outcome.rows.length, 1)
    assert.equal(outcome.skipped, 1)
  })
})

describe('mergeRows', () => {
  it('новые позиции дописываются, прежние не трогаются', () => {
    const merged = mergeRows(
      [{ sku: '4001', barcode: '465575293017258909', name: 'старое' }],
      [{ sku: '4002', barcode: '461021658023258909', name: 'новое' }],
    )
    assert.equal(merged.added, 1)
    assert.equal(merged.updated, 0)
    assert.deepEqual(merged.rows.map((row) => row.sku), ['4001', '4002'])
    assert.equal(merged.rows[0]?.name, 'старое')
  })

  it('тот же артикул перекрывается: файл пользователя — источник правды', () => {
    const merged = mergeRows(
      [{ sku: '400357926', barcode: '461021658203858909', name: 'из базы' }],
      [{ sku: '400357926', barcode: '461021658105558909', name: 'из файла' }],
    )
    assert.equal(merged.added, 0)
    assert.equal(merged.updated, 1)
    assert.equal(merged.rows.length, 1)
    assert.equal(merged.rows[0]?.barcode, '461021658105558909')
  })

  it('непечатная позиция на входе не портит файл приложенных', () => {
    const merged = mergeRows([], [{ sku: '4001', barcode: 'не код', name: 'x' }])
    assert.equal(merged.rows.length, 0)
    assert.equal(merged.skipped, 1)
  })

  it('файл приложенных с дублем артикула оставляет первый', () => {
    const merged = mergeRows(
      [
        { sku: '4001', barcode: '465575293017258909', name: 'первый' },
        { sku: '4001', barcode: '461021658023258909', name: 'второй' },
      ],
      [],
    )
    assert.equal(merged.rows.length, 1)
    assert.equal(merged.rows[0]?.name, 'первый')
  })

  it('повторное приложение того же файла ничего не меняет', () => {
    const file = [
      { sku: '4001', barcode: '465575293017258909', name: 'ZUGEL' },
      { sku: '4002', barcode: '461021658023258909', name: 'ZOE' },
    ]
    const first = mergeRows([], file)
    const second = mergeRows(first.rows, file)
    assert.equal(second.added, 0)
    assert.equal(second.updated, 2)
    assert.deepEqual(second.rows, first.rows)
  })

  it('лимит на размер дополнения объявлен и не равен размеру базы', () => {
    assert.ok(EXTRA_LIMIT < 100_000, 'дополнение — десятки позиций, а не чужая база')
  })
})

describe('parseExtraJson', () => {
  it('читает файл приложенных позиций', () => {
    const payload = parseExtraJson(
      JSON.stringify({ version: 1, updatedAt: 1750000000000, source: 'ШК МП Цюгель.xlsx', rows: [
        { sku: '400110453', barcode: '465575293017258909', name: 'ZUGEL' },
      ] }),
    )
    assert.equal(payload.source, 'ШК МП Цюгель.xlsx')
    assert.equal(payload.updatedAt, 1750000000000)
    assert.equal(payload.rows.length, 1)
  })

  it('битый файл даёт пустое дополнение, а не исключение', () => {
    // Приложенное — дополнение: его потеря не должна ломать печать по базе.
    assert.deepEqual(parseExtraJson('не json').rows, [])
    assert.deepEqual(parseExtraJson('{"rows":"не массив"}').rows, [])
    assert.deepEqual(parseExtraJson('[1,2,3]').rows, [])
    assert.equal(parseExtraJson('{"rows":[{"sku":"","barcode":"1"}]}').rows.length, 0)
  })
})