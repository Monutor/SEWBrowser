/** Чистая логика печати штрихов: разбор строки локального индекса, раскладка
 *  листа A4 и сборка HTML, который потом уходит в `htmlToPdf`.
 *  Видна и main, и renderer, и тестам — поэтому без DOM, electron и node. */
import { barcodeSvg, buildBarcode, type BarcodeSymbology } from './barcode-core.ts'

/** Позиция, готовая к печати: всё нужное уже в памяти, сети не требуется. */
export interface BarcodeItem {
  sku: string
  name: string
  /** Значение штрих-кода из базы (то, что уходит в сканер). */
  barcode: string
  symbology: BarcodeSymbology
}

/** Раскладка листа. 2×4 крупными этикетками выбрано сознательно: самый длинный
 *  код в базе даёт 145 модулей (18 знаков), и на более узкой этикетке модуль
 *  падает до ~0.45 мм — часть сканеров такой штрих не берёт. Здесь модуль
 *  выходит ~0.5 мм, 40 этикеток на лист. */
export const SHEET_LAYOUT = {
  columns: 2,
  rows: 4,
  labelWidthMm: 95,
  labelHeightMm: 45,
  gapMm: 4,
  /** Сколько этикеток помещается на один лист. */
  perPage: 8,
} as const

/** Больше 999 этикеток за раз — это уже не печать, а случайный ввод: PDF
 *  раздувается на сотни страниц и пользователь не понимает, что произошло. */
export const MAX_LABELS_PER_JOB = 999

/** Разделитель в строке индекса. Таб не встречается в SKU и в наименованиях
 *  SEW, поэтому строка однозначна и переживает перенос файла между системами. */
export const INDEX_FIELD_SEP = '\t'

export interface DbRow {
  sku: string
  barcode: string
  name: string
}

/** Строка компактного индекса → позиция. `null` на битой строке: индекс
 *  читается построчно, и одна испорченная строка не должна ронять печать. */
export function parseIndexLine(line: string): DbRow | null {
  const parts = String(line ?? '').split(INDEX_FIELD_SEP)
  if (parts.length < 3) return null
  const sku = parts[0].trim()
  const barcode = parts[1].trim()
  if (!sku || !barcode) return null
  // Наименование может содержать табы — они не несут смысла, склеиваем.
  const name = parts.slice(2).join(' ').trim()
  return { sku, barcode, name }
}

/** Позиция из строки индекса: symbology выбираем сразу, чтобы и оверлей, и
 *  лист печати показывали одно и то же. `null`, если код не кодируется. */
export function barcodeItem(row: DbRow): BarcodeItem | null {
  const built = buildBarcode(row.barcode)
  if (!built) return null
  return { sku: row.sku, name: row.name, barcode: row.barcode, symbology: built.symbology }
}

/** Копии: каждую позицию печатаем N раз, порядок исходного ввода сохраняем.
 *  Копии вне 1…MAX — не тихая единица, а отказ: пользователь, попросивший
 *  50 копий, должен получить 50, а не один штрих. Дробные отклоняем по той же
 *  причине — «1.5 копии» это опечатка, а не просьба. */
export function expandCopies(items: readonly BarcodeItem[], copies: unknown): BarcodeItem[] | null {
  if (typeof copies !== 'number' || !Number.isInteger(copies)) return null
  if (copies < 1) return null
  if (items.length * copies > MAX_LABELS_PER_JOB) return null
  const out: BarcodeItem[] = []
  for (const item of items) {
    for (let i = 0; i < copies; i += 1) out.push(item)
  }
  return out
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/** Рамка, в которую этикетка вписывает штрих, в мм. Аналог
 *  `.print-label svg { max-width: 80mm; max-height: 30mm }` в
 *  Monutor/warehouse-barcode-generator; ширина здесь берётся по этикетке
 *  (95 мм за вычетом отступов), высота ограничена, чтобы полоса не съедала
 *  подпись. */
const BARCODE_BOX = {
  widthMm: SHEET_LAYOUT.labelWidthMm - 4,
  heightMm: 24,
} as const

/** Одна этикетка.
 *
 *  Под полосой печатается сам штрих-код, а под ним наименование — так же, как в
 *  Monutor/warehouse-barcode-generator (`JsBarcode` с `displayValue: true`,
 *  где цифры кода выводятся под полосами, а `.print-label-name` несёт
 *  название). Прежде здесь стоял артикул товара: он для переборки бесполезен —
 *  в сканер вводится штрих, и если он не берётся, человек вводит руками цифры
 *  именно с этикетки.
 *
 *  Сама полоса не растягивается: SVG сохраняет пропорцию viewBox, а этикетка
 *  вписывает её в рамку `max-width/max-height` (как `.print-label svg` в том
 *  проекте). Раньше полоса растягивалась на всю ширину этикетки через
 *  `preserveAspectRatio=none`, и короткий код получал непропорционально
 *  толстые полосы. */
function renderLabel(item: BarcodeItem): string {
  let svg = ''
  try {
    svg = barcodeSvg(item.barcode, { moduleWidth: 2, height: 64 })
  } catch {
    svg = '<div class="bad">код не печатается</div>'
  }
  return (
    `<div class="label">${svg}` +
    `<div class="code">${escapeHtml(item.barcode)}</div>` +
    `<div class="name">${escapeHtml(item.name)}</div>` +
    '</div>'
  )
}

export interface SheetOptions {
  /** Заголовок в шапке листа (обычно магазин или «Штрихи»). */
  title?: string
}

/**
 * Лист A4 с этикетками. `@page` задан явно, а `preferCSSPageSize` в
 * `htmlToPdf` уважает его — иначе Chromium печатал бы в Letter и раскладка
 * поехала бы.
 */
export function renderBarcodeSheet(items: readonly BarcodeItem[], options: SheetOptions = {}): string {
  const labels = items.map(renderLabel).join('')
  const title = options.title ? `<h1>${escapeHtml(options.title)}</h1>` : ''
  const perPage = SHEET_LAYOUT.perPage
  return (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(options.title ?? 'Штрихи')}</title><style>` +
    // Шрифты системные и уже есть в Chromium: инлайнить @font-face ради цифр
    // не нужно, а document.fonts.ready в htmlToPdf ждёт их загрузки.
    '*{box-sizing:border-box;margin:0;padding:0}' +
    `@page{size:A4;margin:6mm}` +
    'body{font:11px/1.25 "Segoe UI",Arial,sans-serif;color:#000}' +
    `h1{font-size:11px;font-weight:600;margin-bottom:3mm;color:#333}` +
    `.sheet{display:grid;grid-template-columns:repeat(${SHEET_LAYOUT.columns},${SHEET_LAYOUT.labelWidthMm}mm);` +
    `gap:${SHEET_LAYOUT.gapMm}mm;align-content:start}` +
    `.label{width:${SHEET_LAYOUT.labelWidthMm}mm;height:${SHEET_LAYOUT.labelHeightMm}mm;` +
    // position:relative — база для центрирования полосы; поток держит только
    // подпись, прижатую к низу (justify-content:flex-end). Раньше полоса была
    // в потоке и центрировалась в остатке после подписи, из-за чего её центр
    // уезжал на ~3.5 мм выше середины этикетки.
    'padding:2mm;border:1px dashed #bbb;position:relative;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:flex-end;break-inside:avoid;page-break-inside:avoid;overflow:hidden}' +
    // Полоса вне потока и ровно по центру этикетки (left/top 50% и сдвиг на
    // половину своих размеров). Размеры не задаём — `width:auto; height:auto`
    // оставляют пропорцию viewBox, а max-width/max-height вписывают полосу в
    // рамку: так же, как `.print-label svg` в warehouse-barcode-generator.
    // Раньше здесь стоял `height:16mm` с preserveAspectRatio=none — полоса
    // растягивалась на всю ширину этикетки, и короткий код выходил с
    // непропорционально толстыми полосами.
    `.label svg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
    `width:auto;height:auto;max-width:${BARCODE_BOX.widthMm}mm;max-height:${BARCODE_BOX.heightMm}mm;display:block}` +
    // Под полосой — сам штрих-код: его вводят руками, если сканер не взял.
    '.code{font:700 13px/1.1 Consolas,"Courier New",monospace}' +
    '.name{font-size:9px;color:#333;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.bad{font-size:9px;color:#a00}' +
    '</style></head><body>' +
    `${title}<div class="sheet">${labels}</div>` +
    '</body></html>'
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Имя PDF вида «Штрихи 2026-10-13-1512.pdf» — минута в имени, как у ценников. */
export function barcodeFileName(now: Date): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `Штрихи ${stamp}.pdf`
}