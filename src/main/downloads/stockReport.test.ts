import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bearerHeader, isValidObjectId, parseStockReport, stockFileName, stockReportUrl } from './stockReport.ts'

/** Начало zip-контейнера: xlsx — это zip с XML внутри. */
const ZIP_B64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14, 0x00]).toString('base64')
const HTML_B64 = Buffer.from('<!doctype html><html><body>login</body></html>', 'utf-8').toString('base64')

describe('isValidObjectId', () => {
  it('принимает код магазина', () => {
    assert.equal(isValidObjectId('S187'), true)
    assert.equal(isValidObjectId('S-187_a'), true)
  })

  it('отбрасывает всё, что не может попасть в URL', () => {
    assert.equal(isValidObjectId(''), false)
    assert.equal(isValidObjectId('S187&x=1'), false)
    assert.equal(isValidObjectId('S187/x'), false)
    assert.equal(isValidObjectId('../../etc/passwd'), false)
    assert.equal(isValidObjectId('S 187'), false)
    assert.equal(isValidObjectId('S'.repeat(17)), false)
    assert.equal(isValidObjectId(undefined), false)
    assert.equal(isValidObjectId(187), false)
  })
})

describe('stockReportUrl', () => {
  it('собирает адрес отчёта из кода магазина', () => {
    assert.equal(
      stockReportUrl('S187'),
      'https://sew.mvideoeldorado.ru/v2/api/stockmanagement/report/stock-balance?objectId=S187',
    )
  })
})

describe('parseStockReport', () => {
  it('разбирает конверт с xlsx и отдаёт байты с датой ответа', () => {
    const parsed = parseStockReport({
      responseHeader: { responseDate: '2026-09-29T05:56:03Z' },
      responseBody: { fileData: ZIP_B64 },
    })
    assert.equal(parsed.responseDate, '2026-09-29T05:56:03Z')
    assert.equal(parsed.data.subarray(0, 2).toString('latin1'), 'PK')
    assert.equal(parsed.ext, 'xlsx')
  })

  it('не принимает HTML вместо файла — это протухшая сессия', () => {
    assert.throws(() => parseStockReport({ responseBody: { fileData: HTML_B64 } }), /HTML/i)
  })

  it('требует fileData', () => {
    assert.throws(() => parseStockReport({}), /fileData/)
    assert.throws(() => parseStockReport({ responseBody: {} }), /fileData/)
    assert.throws(() => parseStockReport({ responseBody: { fileData: 42 } }), /fileData/)
    assert.throws(() => parseStockReport({ responseBody: { fileData: '' } }), /fileData/)
  })

  it('терпит отсутствие responseHeader — дата ответа не обязательна', () => {
    const parsed = parseStockReport({ responseBody: { fileData: ZIP_B64 } })
    assert.equal(parsed.responseDate, '')
    assert.equal(parsed.ext, 'xlsx')
  })

  it('определяет расширение по содержимому, а не по Content-Type', () => {
    const csv = parseStockReport({
      responseBody: { fileData: Buffer.from('sku;qty\r\n1;2\r\n', 'utf-8').toString('base64') },
    })
    assert.equal(csv.ext, 'csv')
    const xls = parseStockReport({
      responseBody: { fileData: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]).toString('base64') },
    })
    assert.equal(xls.ext, 'xls')
  })
})

describe('stockFileName', () => {
  it('переносит дату из даты ответа сервера в локальную', () => {
    // Точное значение зависит от часового пояса машины, формат — нет.
    assert.match(stockFileName('S187', '2026-09-29T05:56:03Z', 'xlsx'), /^Остатки S187 \d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('при пустой дате ответа берёт сегодняшнюю', () => {
    const now = new Date(2026, 8, 29, 12, 0, 0)
    assert.equal(stockFileName('S187', '', 'xlsx', now), 'Остатки S187 2026-09-29.xlsx')
  })

  it('при негодной дате ответа берёт сегодняшнюю', () => {
    const now = new Date(2026, 0, 2, 9, 0, 0)
    assert.equal(stockFileName('S187', 'ерунда', 'xlsx', now), 'Остатки S187 2026-01-02.xlsx')
  })

  it('без кода магазина не оставляет двойной пробел', () => {
    assert.match(stockFileName('', '2026-09-29T05:56:03Z', 'xlsx'), /^Остатки \d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  it('подставляет расширение, определённое по содержимому', () => {
    const now = new Date(2026, 8, 29)
    assert.equal(stockFileName('S187', '', 'csv', now), 'Остатки S187 2026-09-29.csv')
  })

  it('не выпускает в имя слеши даже с кривым кодом магазина', () => {
    const now = new Date(2026, 8, 29)
    const name = stockFileName('../../evil', '', 'xlsx', now)
    assert.equal(name.includes('/'), false)
    assert.equal(name.includes('\\'), false)
  })
})

describe('bearerHeader', () => {
  it('берёт токен из перехваченного заголовка', () => {
    assert.equal(bearerHeader('Bearer eyJhbGciOi.J9.sig'), 'Bearer eyJhbGciOi.J9.sig')
  })

  it('обрезает пробелы вокруг значения', () => {
    assert.equal(bearerHeader('  Bearer abc.def.ghi \n'), 'Bearer abc.def.ghi')
  })

  it('отбрасывает не-строку (страница отдала мусор)', () => {
    assert.equal(bearerHeader(null), null)
    assert.equal(bearerHeader(undefined), null)
    assert.equal(bearerHeader(42), null)
    assert.equal(bearerHeader({ token: 'Bearer abc' }), null)
  })

  it('отбрасывает пустую строку и голую схему без токена', () => {
    assert.equal(bearerHeader(''), null)
    assert.equal(bearerHeader('Bearer '), null)
    assert.equal(bearerHeader('Bearer'), null)
  })

  it('отбрасывает неверную схему в другом регистре', () => {
    assert.equal(bearerHeader('bearer abc.def.ghi'), null)
    assert.equal(bearerHeader('Basic dXNlcjpwYXNz'), null)
  })

  it('режет несоразмерно длинное значение', () => {
    assert.equal(bearerHeader('Bearer ' + 'a'.repeat(5000)), null)
  })
})
