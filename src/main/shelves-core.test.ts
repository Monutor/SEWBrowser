import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseShelvesFile, zoneOfShelf } from './shelves-core.ts'

/**
 * Разбор локальной базы полок (src/database/shelves.json) в выдачу для гостя.
 * Проверяем то, на чём потом строится комбобокс полок и ЛП-автоматика
 * sew-inventory: имя зоны по разделу, дедупликацию одинаковых имён и разбор
 * строк обратно в «зона / ячейка».
 */
const FILE = {
  version: '20260706083701',
  shelves: [
    { name: 'А-С01-1', barcode: 'STL000000010001', section: 'А' },
    { name: 'В-С11-1', barcode: 'STL000033780001', section: 'В' },
    { name: 'В-С11-2', barcode: 'STL000033790001', section: 'В' },
    { name: 'С ВИТРИНЫ', barcode: 'STL001747940012', section: 'ПИКАП' },
    { name: 'ТОРГОВЫЙ ЗАЛ', barcode: 'STL000000010003', section: 'СЛУЖЕБНАЯ' },
    { name: 'КОМПОНЕНТНЫЙ ТЗ', barcode: 'STL008738420001', section: 'СЛУЖЕБНАЯ' },
    { name: 'Верх.ТЗ-1', barcode: 'STL008045410001', section: 'Верх.ТЗ' },
  ],
}

describe('zoneOfShelf — раздел shelves.json -> название зоны SEW', () => {
  it('буквы А…Р и латинская A — основной склад', () => {
    assert.equal(zoneOfShelf('А', 'А-С01-1'), 'Основной склад')
    assert.equal(zoneOfShelf('Р', 'Р-С01-1'), 'Основной склад')
    assert.equal(zoneOfShelf('A', 'A-1'), 'Основной склад')
  })

  it('ПИКАП — зона выдачи у витрины', () => {
    assert.equal(zoneOfShelf('ПИКАП', 'С ВИТРИНЫ'), 'Пикап')
  })

  it('служебная полка сама является зоной, но прописными словами', () => {
    assert.equal(zoneOfShelf('СЛУЖЕБНАЯ', 'ТОРГОВЫЙ ЗАЛ'), 'Торговый зал')
    assert.equal(zoneOfShelf('СЛУЖЕБНАЯ', 'ПРИЁМКА'), 'Приёмка')
    // Аббревиатуру в названии зоны оставляем прописной: «ТЗ», а не «тз»
    assert.equal(zoneOfShelf('СЛУЖЕБНАЯ', 'КОМПОНЕНТНЫЙ ТЗ'), 'Компонентный ТЗ')
  })

  it('неизвестный раздел отдаём как есть, а не придумываем зону', () => {
    // Придуманная зона подставила бы ЛП-автоматике чужую ячейку
    assert.equal(zoneOfShelf('Верх.ТЗ', 'Верх.ТЗ-1'), 'Верх.ТЗ')
    assert.equal(zoneOfShelf('', 'ХЗ-1'), '')
  })
})

describe('parseShelvesFile — выдача для гостя', () => {
  it('строки полок собираются в «зона \\t ячейка \\t штрих», зоны — словарём', () => {
    const { payload, count, duplicates } = parseShelvesFile(JSON.stringify(FILE))
    assert.equal(payload.version, '20260706083701')
    assert.equal(count, 7)
    assert.equal(duplicates, 0)

    const rows = payload.rows.map((row) => row.split('\t'))
    // Гость получает полку обратно как { zone, cell, barcode }
    const main = payload.zones.indexOf('Основной склад')
    assert.deepEqual(payload.rows.map((row) => payload.zones[Number(row.split('\t')[0])]), [
      'Верх.ТЗ',
      'Компонентный ТЗ',
      'Основной склад',
      'Основной склад',
      'Основной склад',
      'Пикап',
      'Торговый зал',
    ])
    assert.ok(main >= 0)
    // Гость получает полку обратно как { zone, cell, barcode }
    assert.deepEqual(
      rows.filter((row) => row[0] === String(main)),
      [
        [String(main), 'А-С01-1', 'STL000000010001'],
        [String(main), 'В-С11-1', 'STL000033780001'],
        [String(main), 'В-С11-2', 'STL000033790001'],
      ],
    )
    // Пропусков нет: строк столько же, сколько полок
    assert.equal(payload.rows.length, count)
  })

  it('полки отсортированы по зоне, потом по ячейке', () => {
    const { payload } = parseShelvesFile(JSON.stringify(FILE))
    const keys = payload.rows.map((row) => {
      const [idx, cell] = row.split('\t')
      return `${payload.zones[Number(idx)]} ${cell}`
    })
    assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b, 'ru')))
  })

  it('одинаковое имя с РАЗНЫМИ штрихами остаётся один раз, берём первый', () => {
    const withDup = {
      shelves: [
        { name: 'В-С11-1', barcode: 'STL000033780001', section: 'В' },
        { name: 'В-С11-1', barcode: 'STL000003480001', section: 'В' },
      ],
    }
    const { payload, count, duplicates } = parseShelvesFile(JSON.stringify(withDup))
    assert.equal(count, 1)
    assert.equal(duplicates, 1)
    assert.deepEqual(payload.rows, ['0\tВ-С11-1\tSTL000033780001'])
  })

  it('полка без штриха или без имени пропускается молча, файл не падает', () => {
    const { payload } = parseShelvesFile(
      JSON.stringify({
        shelves: [
          { name: 'А-С01-1', section: 'А' },
          { barcode: 'STL000000010002', section: 'А' },
          null,
          { name: 'А-С01-2', barcode: 'STL000000010003', section: 'А' },
        ],
      }),
    )
    assert.deepEqual(payload.rows, ['0\tА-С01-2\tSTL000000010003'])
  })

  it('табы и переводы строк в имени не разрывают построчную выдачу', () => {
    const { payload } = parseShelvesFile(
      JSON.stringify({ shelves: [{ name: 'А-С01\n1\t', barcode: 'STL1', section: 'А' }] }),
    )
    assert.deepEqual(payload.rows, ['0\tА-С01 1\tSTL1'])
    assert.equal(payload.rows[0].split('\t').length, 3)
  })

  it('без массива shelves — ошибка, а не пустой список полок', () => {
    assert.throws(() => parseShelvesFile(JSON.stringify({ version: '1' })), /shelves/)
    assert.throws(() => parseShelvesFile('не json'), /JSON/)
  })
})