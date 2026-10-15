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

/** Размеры полосы на этикетке, в мм.
 *
 *  Ширина фиксированная — полоса занимает всю ширину этикетки. Раньше стоял
 *  `max-width` с `width:auto`, и это ограничивало полосу сверху, но никогда не
 *  увеличивало: EAN-13 (117 модулей, 62 мм в натуральную величину) рисовался
 *  заметно уже этикетки, хотя места было с избытком. `height:auto` сохраняет
 *  пропорцию viewBox — полоса не растягивается, а масштабируется целиком, и
 *  высота сама подстраивается под длину кода: чем длиннее код, тем ниже полоса.
 *
 *  `maxHeightMm` — страховка на случай неожиданно широкого кода: полоса
 *  упрётся в высоту и уменьшит ширину, сохранив пропорцию, вместо того чтобы
 *  залезть под подпись. При текущей базе (самый длинный код — 18 знаков,
 *  253 модуля) это 12.9 мм при полной ширине, до 26 мм не доходит. */
const BARCODE_BOX = {
  widthMm: SHEET_LAYOUT.labelWidthMm - 4,
  maxHeightMm: 26,
} as const

/** Поля этикетки, мм. Снизу поле заметно больше верхнего: подпись вынесена из
 *  потока в футер этикетки, и место под неё надо ЗАРЕЗЕРВИРОВАТЬ. Иначе полоса
 *  центрируется по всей рамке, а цифры кода (нижняя строка футера) наезжают на
 *  её низ: у EAN-13 полоса высотой ~24.9 мм, и снизу остаётся ~7.8 мм — как раз
 *  столько занимает строка подписи. */
export const LABEL_PADDING = { top: 2, side: 2, bottom: 8 } as const

/** Подпись этикетки: кегли (CSS-пиксели), межстрочные интервалы и отступы от
 *  низа рамки, мм. Подняли кегли после того, как в строку с названием добавили
 *  артикул: на прежних 13px/9px цифры кода и артикул читались в упор. */
export const LABEL_TEXT = {
  codePx: 15,
  codeLineHeight: 1.1,
  namePx: 10,
  nameLineHeight: 1.25,
  codeBottomMm: 7,
  nameBottomMm: 2,
} as const

/** Одна этикетка.
 *
 *  Под полосой печатается сам штрих-код, под ним — наименование и артикул, так
 *  же, как в Monutor/warehouse-barcode-generator (`JsBarcode` с
 *  `displayValue: true`, где цифры кода выводятся под полосами, а
 *  `.print-label-name` несёт название).
 *
 *  Артикул стоит ПЕРВЫМ в строке с названием, хотя раньше его здесь не было
 *  вовсе: `.nm` обрезается многоточием по хвосту, и при длинном названии
 *  артикул в конце строки просто исчез бы. Он нужен, чтобы отличить одноимённые
 *  позиции и найти товар в SEW глазами. Рядом с названием, а не отдельным
 *  блоком — на 45 мм этикетке третья строка не помещается, а пустую полосу под
 *  наименованием отдавать под что-то ещё не за что.
 *
 *  Сама полоса не растягивается: SVG сохраняет пропорцию viewBox, а этикетка
 *  вписывает её в рамку `width/max-height` (как `.print-label svg` в том
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
  const sku = item.sku ? `<span class="sku">${escapeHtml(item.sku)}</span>` : ''
  const sep = sku && item.name ? '<span class="sep">·</span>' : ''
  const name = item.name ? `<span class="nm">${escapeHtml(item.name)}</span>` : ''
  return (
    `<div class="label">${svg}` +
    `<div class="code">${escapeHtml(item.barcode)}</div>` +
    `<div class="name">${sku}${sep}${name}</div>` +
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
    // Штрих — единственный потокющий элемент внутри рамки, поэтому
    // justify-content:center ставит его ровно по центру по вертикали. Подпись
    // абсолютно спозиционирована у низа: если держать её в потоке, она «тянула»
    // бы центр блока вниз и штрих уезжал вверх — именно так штрих и стоял выше
    // середины рамки. Теперь штрих по середине, а текст — футером у низа.
    // Поле снизу (LABEL_PADDING.bottom) — зарезервированное место под футер:
// полоса центрируется по СВОБОДНОЙ высоте, и без резерва цифры кода ложатся
// на её нижние полосы.
    `padding:${LABEL_PADDING.top}mm ${LABEL_PADDING.side}mm ${LABEL_PADDING.bottom}mm;` +
    'border:1px dashed #bbb;position:relative;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;break-inside:avoid;page-break-inside:avoid;overflow:hidden}' +
    // Ширина фиксирована по этикетке, `height:auto` держит пропорцию viewBox —
    // полоса масштабируется целиком, а не растягивается по одной оси.
    `.label svg{width:${BARCODE_BOX.widthMm}mm;height:auto;max-height:${BARCODE_BOX.maxHeightMm}mm;display:block}` +
    // Подпись прижата к низу рамки и по центру: штрих остаётся по середине, а
    // цифры и наименование с артикулом не сдвигают его вверх. `.code` выше,
    // `.name` ниже — читаются сверху вниз.
    `.code{position:absolute;left:0;right:0;bottom:${LABEL_TEXT.codeBottomMm}mm;text-align:center;font:700 ${LABEL_TEXT.codePx}px/${LABEL_TEXT.codeLineHeight} Consolas,"Courier New",monospace}` +
    // Строка с названием и артикулом — flex: артикул `.sku` не сжимается никогда,
    // а длинное название `.nm` уходит в многоточие, но артикул остаётся читаемым.
    `.name{position:absolute;left:0;right:0;bottom:${LABEL_TEXT.nameBottomMm}mm;display:flex;align-items:baseline;justify-content:center;gap:1mm;font-size:${LABEL_TEXT.namePx}px;line-height:${LABEL_TEXT.nameLineHeight};color:#333;max-width:100%;overflow:hidden}` +
    '.name .sku{flex:none;font-weight:600;color:#000}' +
    '.name .sep{flex:none;color:#999}' +
    '.name .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    `.bad{font-size:${LABEL_TEXT.namePx}px;color:#a00}` +
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