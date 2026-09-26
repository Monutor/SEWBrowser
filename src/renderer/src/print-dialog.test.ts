import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  bytesToBase64,
  mmToInches,
  normalizePrintSettings,
  printMarginsInches,
  printOptions,
  printPageRangesFor,
  printToPdfOptions,
  suggestedPdfName,
} from './print-dialog.ts'

const base = normalizePrintSettings(undefined)

describe('normalizePrintSettings', () => {
  it('на мусоре отдаёт дефолты', () => {
    assert.deepEqual(base, {
      destination: 'pdf',
      deviceName: '',
      rangeMode: 'all',
      rangeFrom: 1,
      rangeTo: 1,
      copies: 1,
      landscape: false,
      pageSize: 'A4',
      marginTop: 20,
      marginBottom: 20,
      marginLeft: 10,
      marginRight: 10,
      scale: 100,
      printBackground: false,
      displayHeaderFooter: false,
    })
  })

  it('достаёт валидные значения', () => {
    const s = normalizePrintSettings({
      destination: 'printer',
      deviceName: 'HP LaserJet',
      rangeMode: 'custom',
      rangeFrom: 2,
      rangeTo: 5,
      copies: 3,
      landscape: true,
      pageSize: 'A3',
      marginTop: 5,
      marginBottom: 6,
      marginLeft: 7,
      marginRight: 8,
      scale: 150,
      printBackground: true,
      displayHeaderFooter: true,
    })
    assert.equal(s.destination, 'printer')
    assert.equal(s.deviceName, 'HP LaserJet')
    assert.equal(s.rangeMode, 'custom')
    assert.equal(s.copies, 3)
    assert.equal(s.pageSize, 'A3')
    assert.equal(s.scale, 150)
    assert.equal(s.printBackground, true)
    assert.equal(s.displayHeaderFooter, true)
  })

  it('чинит значения вне диапазонов', () => {
    const s = normalizePrintSettings({
      copies: 0,
      scale: 500,
      marginTop: 90,
      pageSize: 'А4',
      rangeFrom: -3,
      landscape: 'да',
    })
    assert.equal(s.copies, 1)
    assert.equal(s.scale, 100)
    assert.equal(s.marginTop, 20)
    assert.equal(s.pageSize, 'A4')
    assert.equal(s.rangeFrom, 1)
    assert.equal(s.landscape, false)
  })
})

describe('mmToInches', () => {
  it('переводит миллиметры в дюймы', () => {
    assert.equal(mmToInches(25.4), 1)
    assert.equal(mmToInches(10), 0.3937)
    assert.equal(mmToInches(0), 0)
  })
})

describe('printMarginsInches', () => {
  it('переводит все четыре поля', () => {
    assert.deepEqual(printMarginsInches(base), {
      top: 0.7874,
      bottom: 0.7874,
      left: 0.3937,
      right: 0.3937,
    })
  })
})

describe('printToPdfOptions', () => {
  it('собирает аргументы и не добавляет pageRanges', () => {
    const opts = printToPdfOptions(normalizePrintSettings({ landscape: true, scale: 150, printBackground: true }))
    assert.equal(opts.landscape, true)
    assert.equal(opts.scale, 1.5)
    assert.equal(opts.printBackground, true)
    assert.equal(opts.displayHeaderFooter, false)
    assert.equal(opts.pageSize, 'A4')
    assert.ok(!('pageRanges' in opts))
  })
})

describe('printPageRangesFor', () => {
  it('для «всех страниц» диапазона нет', () => {
    assert.deepEqual(printPageRangesFor(base, 10, 3), [])
  })

  it('для «текущей» берёт выбранную страницу с clamp', () => {
    const s = normalizePrintSettings({ rangeMode: 'current' })
    // webview.print ждёт индексы 0-based, поэтому страница 4 → индекс 3
    assert.deepEqual(printPageRangesFor(s, 10, 4), [{ from: 3, to: 3 }])
    assert.deepEqual(printPageRangesFor(s, 10, 99), [{ from: 9, to: 9 }])
    assert.deepEqual(printPageRangesFor(s, 10, 0), [{ from: 0, to: 0 }])
  })

  it('для произвольного диапазона клампит границы к числу страниц', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 2, rangeTo: 4 })
    assert.deepEqual(printPageRangesFor(s, 10, 1), [{ from: 1, to: 3 }])
    assert.deepEqual(printPageRangesFor(s, 3, 1), [{ from: 1, to: 2 }])
    assert.deepEqual(printPageRangesFor(s, 1, 1), [{ from: 0, to: 0 }])
  })

  it('при пустом числе страниц диапазона нет', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 })
    assert.deepEqual(printPageRangesFor(s, 0, 1), [])
  })
})

describe('printOptions', () => {
  it('собирает аргументы системной печати с полями в пикселях', () => {
    const opts = printOptions(
      normalizePrintSettings({ copies: 2, landscape: true, printBackground: true }),
      'HP LaserJet',
      10,
      1,
    )
    assert.equal(opts.silent, false)
    assert.equal(opts.deviceName, 'HP LaserJet')
    assert.equal(opts.copies, 2)
    assert.equal(opts.landscape, true)
    assert.equal(opts.printBackground, true)
    assert.equal(opts.pageSize, 'A4')
    assert.equal(opts.scaleFactor, 1)
    // режим «все страницы» → диапазон пустой, поле не передаём
    assert.equal(opts.pageRanges, undefined)
    // webview.print ждёт поля в пикселях и только свои (marginType: 'custom')
    assert.deepEqual(opts.margins, { marginType: 'custom', top: 76, bottom: 76, left: 38, right: 38 })
    // A6 принтер не понимает — поле размера не передаём вовсе
    const a6 = printOptions(normalizePrintSettings({ pageSize: 'A6' }), 'HP LaserJet', 10, 1)
    assert.equal('pageSize' in a6, false)
  })

  it('подставляет диапазон, когда он есть', () => {
    const opts = printOptions(normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 }), 'XPS', 5, 1)
    assert.deepEqual(opts.pageRanges, [{ from: 0, to: 1 }])
  })
})

describe('bytesToBase64', () => {
  it('кодирует байты в base64', () => {
    assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=')
    assert.equal(bytesToBase64(new Uint8Array(0)), '')
  })

  it('переживает больше одного чанка', () => {
    const big = new Uint8Array(70000).fill(65)
    const encoded = bytesToBase64(big)
    assert.equal(encoded.length, Math.ceil(70000 / 3) * 4)
    assert.equal(encoded.slice(0, 4), 'QUFB')
  })
})

describe('suggestedPdfName', () => {
  it('достраивает расширение и чистит пути', () => {
    assert.equal(suggestedPdfName('Отчёт за март'), 'Отчёт за март.pdf')
    assert.equal(suggestedPdfName('Отчёт.pdf'), 'Отчёт.pdf')
    assert.equal(suggestedPdfName('  '), 'document.pdf')
    // разделители заменяются пробелом, а не вырезаются
    assert.equal(suggestedPdfName('a/b:c'), 'a b c.pdf')
  })
})
