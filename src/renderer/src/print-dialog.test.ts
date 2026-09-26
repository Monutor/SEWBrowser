import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PRINT_PAPER_NAMES,
  bytesToBase64,
  mmToInches,
  mmToPixels,
  normalizePrintSettings,
  printMarginsInches,
  printMarginsPx,
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

  it('мусорные поля дают дефолты, а не нули', () => {
    // Number(null/''/false) === 0, и 0 проходит проверку диапазона 0..50 мм —
    // раньше из-за этого поля молча схлопывались в 0 мм вместо дефолтных
    const s = normalizePrintSettings({
      marginTop: null,
      marginBottom: '',
      marginLeft: false,
      marginRight: undefined,
    })
    assert.equal(s.marginTop, base.marginTop)
    assert.equal(s.marginBottom, base.marginBottom)
    assert.equal(s.marginLeft, base.marginLeft)
    assert.equal(s.marginRight, base.marginRight)
  })

  it('валидные значения полей сохраняются, включая 0 мм', () => {
    const s = normalizePrintSettings({
      marginTop: 0,
      marginBottom: 7.5,
      marginLeft: '8',
      marginRight: 50,
    })
    assert.equal(s.marginTop, 0)
    assert.equal(s.marginBottom, 7.5)
    assert.equal(s.marginLeft, 8)
    assert.equal(s.marginRight, 50)
  })
})

describe('mmToInches', () => {
  it('переводит миллиметры в дюймы', () => {
    assert.equal(mmToInches(25.4), 1)
    assert.equal(mmToInches(10), 0.3937)
    assert.equal(mmToInches(0), 0)
  })
})

describe('mmToPixels', () => {
  it('переводит миллиметры в пиксели при 96 dpi', () => {
    assert.equal(mmToPixels(25.4), 96)
    assert.equal(mmToPixels(20), 76)
    assert.equal(mmToPixels(10), 38)
  })

  it('на 0 мм и на мусоре отдаёт 0', () => {
    assert.equal(mmToPixels(0), 0)
    assert.equal(mmToPixels(NaN), 0)
  })
})

describe('printMarginsPx', () => {
  it('отдаёт все четыре стороны в пикселях с marginType custom', () => {
    assert.deepEqual(printMarginsPx(base), {
      marginType: 'custom',
      top: 76,
      bottom: 76,
      left: 38,
      right: 38,
    })
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

  it('при from > to отдаёт диапазон из одной страницы', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 5, rangeTo: 2 })
    assert.deepEqual(printPageRangesFor(s, 10, 1), [{ from: 4, to: 4 }])
  })

  it('при пустом числе страниц диапазона нет', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 })
    assert.deepEqual(printPageRangesFor(s, 0, 1), [])
  })

  it('нецелое число страниц округляет вниз, индексы остаются целыми', () => {
    const s = normalizePrintSettings({ rangeMode: 'current' })
    assert.deepEqual(printPageRangesFor(s, 10.9, 99), [{ from: 9, to: 9 }])
    const c = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 99 })
    assert.deepEqual(printPageRangesFor(c, 10.9, 1), [{ from: 0, to: 9 }])
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
    // размер задан явно → флаг принтера взаимоисключающий и не выставляется
    assert.equal(opts.usePrinterDefaultPageSize, undefined)
    // режим «все страницы» → диапазон пустой, поле не передаём
    assert.equal(opts.pageRanges, undefined)
    // webview.print ждёт поля в пикселях и только свои (marginType: 'custom')
    assert.deepEqual(opts.margins, { marginType: 'custom', top: 76, bottom: 76, left: 38, right: 38 })
  })

  it('подставляет диапазон, когда он есть', () => {
    const opts = printOptions(normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 }), 'XPS', 5, 1)
    assert.deepEqual(opts.pageRanges, [{ from: 0, to: 1 }])
  })

  it('при размере, которого нет у принтера, просит размер принтера по умолчанию', () => {
    // A6 в WebviewTagPrintOptions отсутствует. Молчать нельзя: по документации
    // Electron при отсутствии валидного pageSize и usePrinterDefaultPageSize === false
    // печать падает с ошибкой, поэтому флаг обязателен.
    const opts = printOptions(normalizePrintSettings({ pageSize: 'A6' }), 'HP LaserJet', 10, 1)
    assert.equal(opts.usePrinterDefaultPageSize, true)
    assert.equal('pageSize' in opts, false)
  })

  it('каждый размер из PRINT_PAPER_NAMES доезжает до pageSize', () => {
    for (const name of PRINT_PAPER_NAMES) {
      const opts = printOptions(normalizePrintSettings({ pageSize: name }), 'HP LaserJet', 10, 1)
      assert.equal(opts.pageSize, name)
      assert.equal(opts.usePrinterDefaultPageSize, undefined)
    }
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
