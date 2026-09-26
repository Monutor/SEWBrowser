/** Дефолты настроек печати: A4, книжная, поля как в Windows (20/20/10/10 мм) */
const DEFAULTS: PrintSettings = {
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
}

/** Все размеры бумаги, которые хранить можно: A6 понимает только printToPDF */
const PAGE_SIZES: readonly PrintPageSizeName[] = ['A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid']

/** Размеры бумаги, которые понимает webview.print: A6 в списке принтера отсутствует */
export const PRINT_PAPER_NAMES: readonly PrintPaperName[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid']

/** Привести любой мусор из config.json к валидным настройкам */
export function normalizePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  const v = raw as Record<string, unknown>
  const int = (x: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.floor(Number(x))
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const mm = (x: unknown, fallback: number): number => {
    const n = Math.round(Number(x) * 100) / 100
    return Number.isFinite(n) && n >= 0 && n <= 50 ? n : fallback
  }
  const size = typeof v.pageSize === 'string' && PAGE_SIZES.includes(v.pageSize as PrintPageSizeName) ? (v.pageSize as PrintPageSizeName) : DEFAULTS.pageSize
  return {
    destination: v.destination === 'printer' ? 'printer' : DEFAULTS.destination,
    deviceName: typeof v.deviceName === 'string' ? v.deviceName : DEFAULTS.deviceName,
    rangeMode: v.rangeMode === 'current' || v.rangeMode === 'custom' ? v.rangeMode : DEFAULTS.rangeMode,
    rangeFrom: int(v.rangeFrom, 1, 100000, DEFAULTS.rangeFrom),
    rangeTo: int(v.rangeTo, 1, 100000, DEFAULTS.rangeTo),
    copies: int(v.copies, 1, 99, DEFAULTS.copies),
    landscape: v.landscape === true,
    pageSize: size,
    marginTop: mm(v.marginTop, DEFAULTS.marginTop),
    marginBottom: mm(v.marginBottom, DEFAULTS.marginBottom),
    marginLeft: mm(v.marginLeft, DEFAULTS.marginLeft),
    marginRight: mm(v.marginRight, DEFAULTS.marginRight),
    scale: int(v.scale, 10, 200, DEFAULTS.scale),
    printBackground: v.printBackground === true,
    displayHeaderFooter: v.displayHeaderFooter === true,
  }
}

/** Миллиметры → дюймы (единица полей printToPDF), округление до 4 знаков */
export function mmToInches(mm: number): number {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return Math.round((n / 25.4) * 10000) / 10000
}

/** Миллиметры → пиксели при 96 dpi (единица полей webview.print), округление до целого */
export function mmToPixels(mm: number): number {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return Math.round((n * 96) / 25.4)
}

/** Поля для printToPDF — в дюймах */
export function printMarginsInches(s: PrintSettings): PrintPdfMargins {
  return {
    top: mmToInches(s.marginTop),
    bottom: mmToInches(s.marginBottom),
    left: mmToInches(s.marginLeft),
    right: mmToInches(s.marginRight),
  }
}

/** Поля для webview.print — в пикселях. Свои поля Electron принимает
 *  ТОЛЬКО при marginType: 'custom', поэтому все четыре стороны обязательны. */
export function printMarginsPx(s: PrintSettings): PrintMarginsPx {
  return {
    marginType: 'custom',
    top: mmToPixels(s.marginTop),
    bottom: mmToPixels(s.marginBottom),
    left: mmToPixels(s.marginLeft),
    right: mmToPixels(s.marginRight),
  }
}

/** Аргументы printToPDF. pageRanges здесь НЕ применяем: сохраняем весь документ. */
export function printToPdfOptions(s: PrintSettings): PrintToPdfOptionsLike {
  return {
    landscape: s.landscape,
    printBackground: s.printBackground,
    scale: s.scale / 100,
    displayHeaderFooter: s.displayHeaderFooter,
    pageSize: s.pageSize,
    margins: printMarginsInches(s),
  }
}

function clampPage(n: number, pageCount: number): number {
  if (!Number.isFinite(n)) return 1
  const max = Math.max(1, pageCount)
  return Math.min(Math.max(1, Math.floor(n)), max)
}

function isPaperName(v: PrintPageSizeName): v is PrintPaperName {
  return (PRINT_PAPER_NAMES as readonly string[]).includes(v)
}

/** Диапазон страниц для webview.print: индексы 0-based, to включительно.
 *  Пустой массив = печатать всё (поле pageRanges тогда не передаём). */
export function printPageRangesFor(s: PrintSettings, pageCount: number, currentPage: number): PrintPageRange[] {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return []
  if (s.rangeMode === 'current') {
    const p = clampPage(currentPage, pageCount) - 1
    return [{ from: p, to: p }]
  }
  if (s.rangeMode === 'custom') {
    const from = clampPage(s.rangeFrom, pageCount) - 1
    const to = Math.max(from, clampPage(s.rangeTo, pageCount) - 1)
    return [{ from, to }]
  }
  return []
}

/** Аргументы системной печати: silent всегда false — показываем диалог Windows (R4) */
export function printOptions(
  s: PrintSettings,
  deviceName: string,
  pageCount: number,
  currentPage: number,
): PrintOptionsLike {
  const ranges = printPageRangesFor(s, pageCount, currentPage)
  const opts: PrintOptionsLike = {
    silent: false,
    deviceName,
    printBackground: s.printBackground,
    landscape: s.landscape,
    copies: s.copies,
    margins: printMarginsPx(s),
    scaleFactor: s.scale / 100,
  }
  if (ranges.length) opts.pageRanges = ranges
  // A6 принтер не понимает, а свой размер в микронах мы не храним — поле
  // не передаём вовсе, принтер возьмёт свой размер по умолчанию
  if (isPaperName(s.pageSize)) opts.pageSize = s.pageSize
  return opts
}

/** Uint8Array → base64 (для существующего window.shell.savePdf) */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 32768
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Имя файла для сохранения PDF: без расширения → с .pdf, без путей */
export function suggestedPdfName(title: string): string {
  const cleaned = (typeof title === 'string' ? title : '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  if (!cleaned) return 'document.pdf'
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`
}
