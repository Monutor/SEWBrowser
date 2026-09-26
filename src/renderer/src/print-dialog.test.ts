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
import { createPrintDialog, type PrintDialogController, type PrintDialogElements, type PrintDialogHooks } from './print-dialog.ts'

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

// Мини-дом для контроллера: своего jsdom в проекте нет (как в address-menu.test.ts)
interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  src: string
  hidden: boolean
  value: string
  checked: boolean
  disabled: boolean
  dataset: Record<string, string>
  attrs: Record<string, string>
  children: FakeEl[]
  parent: FakeEl | null
  listeners: Array<{ type: string; fn: (event: unknown) => void }>
  appendChild(node: FakeEl): FakeEl
  replaceChildren(...nodes: FakeEl[]): void
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: (event: unknown) => void): void
}

function mkEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    src: '',
    hidden: false,
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    attrs: {},
    children: [],
    parent: null,
    listeners: [],
    appendChild(node: FakeEl): FakeEl {
      node.parent = el
      el.children.push(node)
      return node
    },
    replaceChildren(...nodes: FakeEl[]): void {
      for (const n of nodes) n.parent = el
      el.children = nodes
    },
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value
    },
    getAttribute(name: string): string | null {
      return name in el.attrs ? el.attrs[name] : null
    },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      el.listeners.push({ type, fn })
    },
  }
  return el
}

function fire(el: FakeEl, type: string, event: unknown = { target: null }): void {
  for (const listener of [...el.listeners]) {
    if (listener.type === type) listener.fn(event)
  }
}

// Контроллер создаёт <option> через document.createElement
;(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => mkEl(tag),
}

const ELEMENT_KEYS: Array<keyof PrintDialogElements> = [
  'settings', 'overlay', 'title', 'destination', 'printerRow', 'rangeMode', 'rangeCustom',
  'rangeFrom', 'rangeTo', 'copies', 'landscape', 'pageSize', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'noMargins', 'scale', 'printBackground', 'displayHeaderFooter',
  'thumbs', 'thumbsNote', 'showAll', 'pageCounter', 'status', 'cancel', 'savePdf', 'print',
]

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]) // '%PDF'

interface Harness {
  el: Record<keyof PrintDialogElements, FakeEl>
  dialog: PrintDialogController
  printers: ShellPrinter[]
  printersFail: Error | null
  /** Настоящее число страниц, которое «сообщает» pdf.js */
  pages: number
  /** Сколько миниатюр хук реально рисует; null = рисует все доступные */
  renderedPages: number | null
  /** Заголовок документа; '' — фолбэк «Документ» */
  title: string
  buildCalls: PrintSettings[]
  printCalls: PrintSettings[]
  saveCalls: Array<{ settings: PrintSettings; bytes: Uint8Array }>
  persisted: PrintSettings[]
  /** Лимиты, с которыми звали renderThumbs */
  renderCalls: number[]
  buildFail: Error | null
  renderFail: Error | null
  printFail: Error | null
  /** Гейты держат хук, чтобы поймать busy-окно (Promise, который отпускает тест) */
  buildGate: Promise<void> | null
  printGate: Promise<void> | null
}

function setup(partial: Partial<Harness> = {}): Harness {
  const el = {} as Record<keyof PrintDialogElements, FakeEl>
  for (const key of ELEMENT_KEYS) el[key] = mkEl(key === 'thumbs' ? 'div' : 'input')
  el.overlay.hidden = true
  const h: Harness = {
    el,
    dialog: null as unknown as PrintDialogController,
    printers: [{ name: 'HP', displayName: 'HP LaserJet', description: '' }],
    printersFail: null,
    pages: 3,
    renderedPages: null,
    title: 'Документ',
    buildCalls: [],
    printCalls: [],
    saveCalls: [],
    persisted: [],
    renderCalls: [],
    buildFail: null,
    renderFail: null,
    printFail: null,
    buildGate: null,
    printGate: null,
    ...partial,
  }
  const elements = {} as Record<keyof PrintDialogElements, HTMLElement>
  for (const key of ELEMENT_KEYS) elements[key] = el[key] as unknown as HTMLElement
  const hooks: PrintDialogHooks = {
    listPrinters: async () => {
      if (h.printersFail) throw h.printersFail
      return h.printers
    },
    buildPdf: async (settings) => {
      h.buildCalls.push(settings)
      if (h.buildFail) throw h.buildFail
      if (h.buildGate) await h.buildGate
      return PDF_BYTES
    },
    renderThumbs: async (_bytes, limit) => {
      if (h.renderFail) throw h.renderFail
      h.renderCalls.push(limit)
      // pageCount — из pdf.js, количество нарисованных миниатюр может быть меньше
      const count = Math.max(0, Math.min(limit, h.renderedPages ?? h.pages))
      return { pageCount: h.pages, thumbs: Array.from({ length: count }, () => 'data:image/png;base64,AAA') }
    },
    doPrint: async (settings) => {
      if (h.printGate) await h.printGate
      if (h.printFail) throw h.printFail
      h.printCalls.push(settings)
    },
    doSavePdf: async (settings, bytes) => {
      h.saveCalls.push({ settings, bytes })
      return true
    },
    documentTitle: () => h.title,
    persist: async (settings) => {
      h.persisted.push(settings)
    },
  }
  h.dialog = createPrintDialog(elements as PrintDialogElements, hooks)
  return h
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  // macrotask-хвост: с гейтами цепочка успевает дойти до записи состояния
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('диалог печати', () => {
  it('открывается, наполняет поля и показывает превью со счётчиком', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ deviceName: 'HP', landscape: true, copies: 2 }))
    assert.equal(h.dialog.isOpen(), true)
    assert.equal(h.el.overlay.hidden, false)
    assert.equal(h.el.title.textContent, 'Документ')
    assert.equal(h.el.rangeMode.value, 'all')
    assert.equal(h.el.copies.value, '2')
    assert.equal(h.el.landscape.value, 'landscape')
    assert.equal(h.el.pageSize.value, 'A4')
    assert.equal(h.el.marginTop.value, '20')
    assert.equal(h.el.scale.value, '100')
    assert.equal(h.el.pageCounter.textContent, 'Страница 1 из 3')
    assert.equal(h.el.thumbs.children.length, 3)
    assert.equal(h.buildCalls.length, 1)
  })

  it('второй open() пока открытого диалога игнорирует', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    await h.dialog.open(normalizePrintSettings({ copies: 5 }))
    assert.equal(h.el.copies.value, '1')
  })

  it('прячет блок принтера и блокирует «Печать», когда принтеров нет', async () => {
    const h = setup({ printers: [] })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.printerRow.hidden, true)
    assert.equal(h.el.print.disabled, true)
    assert.equal(h.el.savePdf.disabled, false)
    assert.equal(h.el.status.textContent, 'Принтеры не найдены — доступно сохранение в PDF')
  })

  it('при сбое списка принтеров остаётся только PDF и показывается подсказка', async () => {
    const h = setup({ printersFail: new Error('WMI сломал') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.destination.children.length, 1)
    assert.equal(h.el.printerRow.hidden, true)
    assert.equal(h.el.status.textContent, 'Не удалось получить список принтеров')
  })

  it('недоступный принтер из конфига переключает назначение на PDF с подсказкой', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'Нет такого' }))
    assert.equal(h.dialog.currentSettings().destination, 'pdf')
    assert.equal(h.el.status.textContent, 'Принтер «Нет такого» больше не доступен — печатаем в PDF')
  })

  it('refresh пересчитывает превью с новыми полями', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    h.el.scale.value = '150'
    await h.dialog.refresh()
    assert.equal(h.buildCalls.length, 2)
    assert.equal(h.buildCalls[1].scale, 150)
  })

  it('клик по миниатюре выбирает текущую страницу', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.thumbs.children[2], 'click', { target: h.el.thumbs.children[2] })
    assert.equal(h.dialog.currentPage(), 3)
    assert.equal(h.el.pageCounter.textContent, 'Страница 3 из 3')
    assert.equal(h.el.thumbs.children[2].className, 'print-thumb current')
  })

  it('«Показать все» снимает лимит в 10 миниатюр', async () => {
    const h = setup({ pages: 12 })
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.el.thumbs.children.length, 10)
    assert.equal(h.el.thumbsNote.textContent, 'Показаны первые 10 из 12')
    assert.equal(h.el.showAll.hidden, false)
    fire(h.el.showAll, 'click')
    await flush()
    assert.equal(h.el.thumbs.children.length, 12)
    assert.equal(h.el.thumbsNote.textContent, '')
    assert.equal(h.el.showAll.hidden, true)
  })

  it('«Сохранить как PDF» отдаёт байты, сохраняет настройки и закрывает', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.savePdf, 'click')
    await flush()
    assert.equal(h.saveCalls.length, 1)
    assert.deepEqual(Array.from(h.saveCalls[0].bytes), Array.from(PDF_BYTES))
    assert.equal(h.persisted.length, 1)
    assert.equal(h.el.overlay.hidden, true)
  })

  it('«Печать» зовёт doPrint, persist и закрывает', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.printCalls.length, 1)
    assert.equal(h.persisted.length, 1)
    assert.equal(h.el.overlay.hidden, true)
  })

  it('при сбое buildPdf показывает ошибку и блокирует кнопки', async () => {
    const h = setup({ buildFail: new Error('нет содержимого') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.status.textContent, 'Не удалось построить предпросмотр: нет содержимого')
    assert.equal(h.el.print.disabled, true)
    assert.equal(h.el.savePdf.disabled, true)
    assert.equal(h.el.overlay.hidden, false)
  })

  it('падение рендера миниатюр не блокирует печать и сохранение (спека §9)', async () => {
    const h = setup({ renderFail: new Error('битый PDF') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.status.textContent, 'Не удалось построить предпросмотр')
    assert.equal(h.el.print.disabled, false)
    assert.equal(h.el.savePdf.disabled, false)
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.printCalls.length, 1)
  })

  it('при сбое doPrint показывает ошибку, разблокирует кнопки, не закрывает и не сохраняет', async () => {
    const h = setup({ printFail: new Error('диалог не открылся') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.el.status.textContent, 'Печать не удалась: диалог не открылся')
    assert.equal(h.el.print.disabled, false)
    assert.equal(h.el.overlay.hidden, false)
    assert.equal(h.persisted.length, 0)
  })

  it('«Отмена» закрывает диалог и ничего не сохраняет', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.cancel, 'click')
    assert.equal(h.dialog.isOpen(), false)
    assert.equal(h.persisted.length, 0)
  })

  it('кнопка «Поля: нет» обнуляет все четыре поля', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.noMargins, 'click')
    assert.equal(h.el.marginTop.value, '0')
    assert.equal(h.el.marginBottom.value, '0')
    assert.equal(h.el.marginLeft.value, '0')
    assert.equal(h.el.marginRight.value, '0')
  })

  it('pageCount() берётся из pdf.js, а не из числа нарисованных миниатюр', async () => {
    // pdf.js знает 12 страниц, а миниатюр хук нарисовал 3 — счётчик и подсказка
    // обязаны считать от 12, иначе «из N» соврёт
    const h = setup({ pages: 12, renderedPages: 3 })
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.dialog.pageCount(), 12)
    assert.equal(h.el.thumbs.children.length, 3)
    assert.equal(h.el.pageCounter.textContent, 'Страница 1 из 12')
    assert.equal(h.el.thumbsNote.textContent, 'Показаны первые 3 из 12')
    // первая отрисовка ограничена десятью страницами…
    assert.deepEqual(h.renderCalls, [10])
    // …а «Показать все» перезапрашивает все страницы по pageCount, не пересобирая PDF
    assert.equal(h.buildCalls.length, 1)
    fire(h.el.showAll, 'click')
    await flush()
    assert.deepEqual(h.renderCalls, [10, 12])
    assert.equal(h.buildCalls.length, 1)
  })

  it('на время пересчёта превью кнопки заблокированы, печать и сохранение не срабатывают', async () => {
    // Пока собирается новый PDF, в bytes лежит сборка по прежним настройкам —
    // сохранив её, пользователь получил бы не тот документ
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.savePdf.disabled, false)
    let release = (): void => {}
    h.buildGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const refreshing = h.dialog.refresh()
    await flush()
    assert.equal(h.dialog.isBusy(), true)
    assert.equal(h.el.print.disabled, true)
    assert.equal(h.el.savePdf.disabled, true)
    assert.equal(h.el.cancel.disabled, true)
    fire(h.el.print, 'click')
    fire(h.el.savePdf, 'click')
    await flush()
    assert.equal(h.printCalls.length, 0)
    assert.equal(h.saveCalls.length, 0)
    release()
    await refreshing
    assert.equal(h.dialog.isBusy(), false)
    assert.equal(h.el.savePdf.disabled, false)
  })

  it('во время печати close() и «Отмена» не закрывают, после успеха диалог закрывается', async () => {
    // close() зовут Escape и клик по фону оверлея — мимо кнопки «Отмена»,
    // поэтому прерывать печать нельзя (спека §6)
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    let release = (): void => {}
    h.printGate = new Promise<void>((resolve) => {
      release = resolve
    })
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.dialog.isBusy(), true)
    h.dialog.close()
    fire(h.el.cancel, 'click')
    assert.equal(h.dialog.isOpen(), true)
    assert.equal(h.el.overlay.hidden, false)
    release()
    await flush()
    assert.equal(h.dialog.isOpen(), false)
    assert.equal(h.el.overlay.hidden, true)
    assert.equal(h.persisted.length, 1)
    assert.equal(h.dialog.isBusy(), false)
  })

  it('при упавшем рендере pageCount() не ноль — печать по диапазону не уйдёт в весь документ', async () => {
    // printPageRangesFor при pageCount = 0 отдаёт пустой массив, а пустой
    // pageRanges в webview.print означает «печатать всё» (R-12)
    const h = setup({ renderFail: new Error('битый PDF') })
    await h.dialog.open(normalizePrintSettings({ rangeMode: 'current' }))
    assert.equal(h.dialog.pageCount(), 1)
    const ranges = printPageRangesFor(h.dialog.currentSettings(), h.dialog.pageCount(), h.dialog.currentPage())
    assert.ok(ranges.length > 0)
  })

  it('previewBytes() отдаёт собранный PDF и null после сбоя сборки', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    assert.deepEqual(Array.from(h.dialog.previewBytes() ?? []), Array.from(PDF_BYTES))
    h.buildFail = new Error('нет содержимого')
    await h.dialog.refresh()
    assert.equal(h.dialog.previewBytes(), null)
  })

  it('пустой заголовок документа подставляет «Документ»', async () => {
    const h = setup({ title: '' })
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.el.title.textContent, 'Документ')
  })

  it('refresh синхронизирует видимость блока произвольного диапазона', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.el.rangeCustom.hidden, true)
    h.el.rangeMode.value = 'custom'
    await h.dialog.refresh()
    assert.equal(h.el.rangeCustom.hidden, false)
    h.el.rangeMode.value = 'all'
    await h.dialog.refresh()
    assert.equal(h.el.rangeCustom.hidden, true)
  })

  it('«Сохранить как PDF» без кэша собирает PDF заново', async () => {
    const h = setup({ buildFail: new Error('нет содержимого') })
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.dialog.previewBytes(), null)
    assert.equal(h.buildCalls.length, 1)
    h.buildFail = null // вторая сборка уже удаётся — кэша нет, значит пересобираем
    fire(h.el.savePdf, 'click')
    await flush()
    assert.equal(h.buildCalls.length, 2)
    assert.equal(h.saveCalls.length, 1)
    assert.deepEqual(Array.from(h.saveCalls[0].bytes), Array.from(PDF_BYTES))
    assert.equal(h.persisted.length, 1)
    assert.equal(h.el.overlay.hidden, true)
  })
})
