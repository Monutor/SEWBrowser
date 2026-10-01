import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { parseQty, parseSharedStrings, readStockBalance } from './xlsx-core.ts'

/** Минимальный zip-писатель: xlsx в тесте собираем сами, фикстуры в репозитории
 *  держать незачем, а проверять надо и чтение контейнера тоже. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const raw = Buffer.from(text, 'utf-8')
    const data = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const SHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><worksheet><dimension ref="A1:W5"/><sheetData>'

function sheetRow(cells: Record<string, string>, row: number): string {
  const inner = Object.entries(cells)
    .map(([col, value]) => `<c r="${col}${row}" t="inlineStr"><is><t>${value}</t></is></c>`)
    .join('')
  return `<row r="${row}">${inner}</row>`
}

/** Выгрузка как у SEW: шапка из 23 колонок, дальше позиции. */
function makeXlsx(rows: Array<Record<string, string>>): Buffer {
  const header: Record<string, string> = {
    A: 'Магазин',
    B: 'Зона',
    C: 'Ячейки хранения',
    D: 'ШК ячейки хранения',
    E: 'Код товара',
    F: 'Наименование',
    G: 'Количество',
    H: 'Тип',
    P: 'ШК товара',
    Q: 'Компонент',
  }
  const body = [sheetRow(header, 1), ...rows.map((r, i) => sheetRow(r, i + 2))]
  return zip({
    'xl/workbook.xml': '<workbook/>',
    'xl/sharedStrings.xml': '<?xml version="1.0" encoding="UTF-8"?><sst count="0" uniqueCount="0"/>',
    'xl/worksheets/sheet1.xml': SHEET_HEAD + body.join('') + '</sheetData></worksheet>',
  })
}

describe('parseQty', () => {
  it('читает целые, дробные и с запятой', () => {
    assert.equal(parseQty('2'), 2)
    assert.equal(parseQty(' 12 '), 12)
    assert.equal(parseQty('2,5'), 2.5)
  })

  it('мусор и пусто дают 0', () => {
    assert.equal(parseQty(''), 0)
    assert.equal(parseQty('ерунда'), 0)
    assert.equal(parseQty('-3'), 0)
  })
})

describe('parseSharedStrings', () => {
  it('собирает строки из <si> и склеивает разорванные <t>', () => {
    const xml =
      '<sst count="3"><si><t>Зона</t></si><si><r><t>Код </t></r><r><t>товара</t></r></si><si><t>Количество</t></si></sst>'
    assert.deepEqual(parseSharedStrings(xml), ['Зона', 'Код товара', 'Количество'])
  })

  it('пустой sst даёт пустой список', () => {
    assert.deepEqual(parseSharedStrings('<sst count="0" uniqueCount="0"/>'), [])
  })
})

describe('readStockBalance', () => {
  it('собирает позиции по зоне ЛП и суммирует количество по ячейкам', () => {
    const data = makeXlsx([
      { A: 'S187', B: 'Торговый зал', C: 'ТОРГОВЫЙ ЗАЛ', E: '400438912', F: 'AC Ballu BPAC-07', G: '2', P: '4660294839975' },
      { A: 'S187', B: 'Торговый зал', C: 'Зал-2', E: '400438912', F: 'AC Ballu BPAC-07', G: '3', P: '4660294839975' },
      { A: 'S187', B: 'Основной склад', C: 'З-С02-1', E: '400438914', F: 'AC Ballu BPAC-09', G: '7', P: '4660294839982' },
      { A: 'S187', B: 'Торговый зал', C: 'Зал-3', E: '400497610', F: 'GP Sony DualSense', G: '1', P: '4660294840000' },
    ])

    const result = readStockBalance(data, { zone: 'Торговый зал' })

    assert.equal(result.totalRows, 4)
    assert.equal(result.matchedRows, 3)
    assert.deepEqual(result.zones, ['Торговый зал', 'Основной склад'])
    assert.equal(result.rows.length, 2)
    assert.deepEqual(result.rows[0], {
      sku: '400438912',
      name: 'AC Ballu BPAC-07',
      qty: 5,
      barcode: '4660294839975',
      zone: 'Торговый зал',
      cell: 'ТОРГОВЫЙ ЗАЛ',
      cellBarcode: '',
      cells: 2,
    })
    assert.equal(result.rows[1].sku, '400497610')
  })

  it('отбирает только SKU из ЛП', () => {
    const data = makeXlsx([
      { B: 'Торговый зал', E: '400438912', G: '2' },
      { B: 'Торговый зал', E: '400497610', G: '1' },
      { B: 'Торговый зал', E: '400501349', G: '4' },
    ])

    const result = readStockBalance(data, { zone: 'Торговый зал', skus: ['400497610', '400501349'] })

    assert.equal(result.matchedRows, 2)
    assert.deepEqual(result.rows.map((r) => r.sku), ['400497610', '400501349'])
  })

  it('зона сравнивается без учёта регистра и «ё»', () => {
    const data = makeXlsx([
      { B: 'торговый  ЗАЛ', E: '1', G: '1' },
      { B: 'Торговый зал', E: '2', G: '1' },
      { B: 'Звонкий зал', E: '3', G: '1' },
    ])

    const result = readStockBalance(data, { zone: 'Торговый зал' })

    assert.deepEqual(result.rows.map((r) => r.sku), ['1', '2'])
  })

  it('SKU сравнивается без ведущих нулей', () => {
    const data = makeXlsx([{ B: 'Торговый зал', E: '004003209', G: '2' }])

    const result = readStockBalance(data, { skus: ['4003209'] })

    assert.equal(result.rows[0].sku, '004003209')
    assert.equal(result.matchedRows, 1)
  })

  it('пропускает строки без SKU и с нулевым количеством', () => {
    const data = makeXlsx([
      { B: 'Торговый зал', E: '', G: '2' },
      { B: 'Торговый зал', E: '5', G: '0' },
      { B: 'Торговый зал', E: '6', G: '3' },
    ])

    const result = readStockBalance(data)

    assert.equal(result.totalRows, 3)
    assert.deepEqual(result.rows.map((r) => r.sku), ['6'])
  })

  it('без фильтра по зоне берёт весь файл', () => {
    const data = makeXlsx([
      { B: 'Торговый зал', E: '1', G: '2' },
      { B: 'Основной склад', E: '2', G: '3' },
    ])

    const result = readStockBalance(data)

    assert.equal(result.rows.length, 2)
    assert.equal(result.matchedRows, 2)
  })

  it('читает общие строки, числа и entity-символы', () => {
    const data = zip({
      'xl/sharedStrings.xml':
        '<sst count="4"><si><t>Зона</t></si><si><t>Код товара</t></si><si><t>Количество</t></si><si><t>ШК товара</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row>' +
        '<c r="B1" t="s"><v>0</v></c><c r="E1" t="s"><v>1</v></c>' +
        '<c r="G1" t="s"><v>2</v></c><c r="P1" t="s"><v>3</v></c>' +
        '</row><row>' +
        '<c r="B2" t="inlineStr"><is><t>Торговый зал</t></is></c>' +
        '<c r="E2" t="inlineStr"><is><t>7</t></is></c>' +
        '<c r="G2"><v>4</v></c>' +
        '<c r="P2" t="inlineStr"><is><t>Philips &amp; Co</t></is></c>' +
        '</row></sheetData></worksheet>',
    })

    const result = readStockBalance(data)

    assert.deepEqual(result.rows, [
      { sku: '7', name: '', qty: 4, barcode: 'Philips & Co', zone: 'Торговый зал', cell: '', cellBarcode: '', cells: 1 },
    ])
  })

  it('ругается на негодный файл, а не отдаёт пустой состав', () => {
    assert.throws(() => readStockBalance(Buffer.from('PK\x03\x04', 'latin1')), /zip/)
    assert.throws(() => readStockBalance(Buffer.from('<html>вход</html>', 'utf-8')), /zip/)
    assert.throws(
      () => readStockBalance(zip({ 'xl/sharedStrings.xml': '<sst/>' })),
      /нет листа/,
    )
    assert.throws(
      () =>
        readStockBalance(
          zip({
            'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Магазин</t></is></c></row></sheetData></worksheet>',
          }),
        ),
      /Код товара/,
    )
  })

  it('пустой лист без строк — понятная ошибка', () => {
    assert.throws(
      () => readStockBalance(zip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData></sheetData></worksheet>' })),
      /пустой/,
    )
  })

  it('понимает и сжатый (deflate), и несжатый лист', () => {
    const rows = [{ B: 'Торговый зал', E: '9', G: '6' }]
    const packed = readStockBalance(makeXlsx(rows))
    const stored = readStockBalance(
      zip({
        'xl/sharedStrings.xml': '<sst count="0"/>',
        'xl/worksheets/sheet1.xml': SHEET_HEAD + sheetRow({ B: 'Зона', E: 'Код товара', G: 'Количество' }, 1) + sheetRow(rows[0], 2) + '</sheetData></worksheet>',
      }, 0),
    )
    assert.equal(packed.rows[0].qty, 6)
    assert.deepEqual(stored.rows, packed.rows)
  })
})