import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBarcode } from './barcode-core.ts'
import {
  INDEX_FIELD_SEP,
  MAX_LABELS_PER_JOB,
  SHEET_LAYOUT,
  barcodeFileName,
  barcodeItem,
  escapeHtml,
  expandCopies,
  parseIndexLine,
  renderBarcodeSheet,
} from './barcode-print-core.ts'

/** Позиция из строки индекса — в тесте всегда успешна, поэтому null убираем
 *  один раз здесь, а не восемью `!` по коду. */
function row(sku: string, barcode: string, name: string) {
  return barcodeItem({ sku, barcode, name })!
}

/* ── Строка индекса ─────────────────────────────────────────────────────── */

test('parseIndexLine: строка в порядке SKU, ШК, наименование', () => {
  const row = parseIndexLine(`400438912${INDEX_FIELD_SEP}4660294839975${INDEX_FIELD_SEP}AC Ballu BPAC-07 SL/N6`)
  assert.deepEqual(row, { sku: '400438912', barcode: '4660294839975', name: 'AC Ballu BPAC-07 SL/N6' })
})

test('parseIndexLine: кириллица и пустое наименование не ломают разбор', () => {
  assert.deepEqual(parseIndexLine(`4269907${INDEX_FIELD_SEP}693996262756465284${INDEX_FIELD_SEP}(A)В/Г/пан. Midea MG699TTGB`), {
    sku: '4269907',
    barcode: '693996262756465284',
    name: '(A)В/Г/пан. Midea MG699TTGB',
  })
  assert.deepEqual(parseIndexLine(`6010089${INDEX_FIELD_SEP}6010089${INDEX_FIELD_SEP}`), {
    sku: '6010089',
    barcode: '6010089',
    name: '',
  })
})

test('parseIndexLine: битая строка — null, а не позиция с пустым SKU', () => {
  assert.equal(parseIndexLine(''), null)
  assert.equal(parseIndexLine('   '), null)
  assert.equal(parseIndexLine(`400438912${INDEX_FIELD_SEP}4660294839975`), null, 'нет наименования')
  assert.equal(parseIndexLine(`${INDEX_FIELD_SEP}4660294839975${INDEX_FIELD_SEP}Ш`), null, 'пустой SKU')
  assert.equal(parseIndexLine(`400438912${INDEX_FIELD_SEP}${INDEX_FIELD_SEP}Ш`), null, 'пустой ШК')
})

test('barcodeItem: symbology та же, что на листе', () => {
  assert.deepEqual(barcodeItem({ sku: '400438912', barcode: '4660294839975', name: 'Ballu' }), {
    sku: '400438912',
    name: 'Ballu',
    barcode: '4660294839975',
    symbology: 'ean13',
  })
  assert.equal(barcodeItem({ sku: '4269907', barcode: '693996262756465284', name: 'Midea' })?.symbology, 'code128')
  assert.equal(barcodeItem({ sku: '1', barcode: '', name: 'пусто' }), null)
})

/* ── Копии ──────────────────────────────────────────────────────────────── */

test('expandCopies: каждая позиция повторяется N раз, порядок ввода сохранён', () => {
  const items = [row('1', '4660294839975', 'A'), row('2', '693996262756465284', 'B')]
  assert.deepEqual(expandCopies(items, 3)?.map((item) => item.sku), ['1', '1', '1', '2', '2', '2'])
  assert.deepEqual(expandCopies(items, 1)?.length, 2)
  assert.deepEqual(expandCopies([], 5), [])
})

test('expandCopies: копии вне диапазона — отказ, а не тихая единица', () => {
  const items = [row('1', '4660294839975', 'A')]
  assert.equal(expandCopies(items, 0), null)
  assert.equal(expandCopies(items, -3), null)
  assert.equal(expandCopies(items, 1.5), null)
  assert.equal(expandCopies(items, '3'), null)
  assert.equal(expandCopies(items, null), null)
  assert.equal(expandCopies(items, Number.NaN), null)
})

test('expandCopies: слишком много этикеток — отказ до сборки PDF', () => {
  const items = Array.from({ length: 400 }, (_, i) => row(String(i), '4660294839975', 'A'))
  assert.equal(expandCopies(items, 2)?.length, 800)
  assert.equal(expandCopies(items, 1)?.length, 400)
  assert.equal(expandCopies(items, 3), null, '1200 > 999')
  assert.ok(MAX_LABELS_PER_JOB < 10_000)
})

/* ── Экранирование ──────────────────────────────────────────────────────── */

test('escapeHtml: спецсимволы из наименования не ломают разметку', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;')
  assert.equal(escapeHtml("O'Brien"), 'O&#39;Brien')
  assert.equal(escapeHtml('обычный текст'), 'обычный текст')
})

/* ── Лист ───────────────────────────────────────────────────────────────── */

const sample = [
  barcodeItem({ sku: '400438912', barcode: '4660294839975', name: 'AC Ballu BPAC-07 SL/N6' })!,
  barcodeItem({ sku: '4269907', barcode: '693996262756465284', name: '(A)В/Г/пан. Midea MG699TTGB' })!,
]

test('renderBarcodeSheet: страница A4 и раскладка 2×4 по 95×45 мм', () => {
  const html = renderBarcodeSheet(sample, { title: 'S187' })
  assert.match(html, /@page\{size:A4;margin:6mm\}/)
  assert.match(html, new RegExp(`repeat\\(${SHEET_LAYOUT.columns},${SHEET_LAYOUT.labelWidthMm}mm\\)`))
  assert.match(html, new RegExp(`height:${SHEET_LAYOUT.labelHeightMm}mm`))
  assert.match(html, /<h1>S187<\/h1>/)
  assert.equal(SHEET_LAYOUT.columns * SHEET_LAYOUT.rows, SHEET_LAYOUT.perPage)
})

test('renderBarcodeSheet: этикеток ровно столько же, сколько позиций', () => {
  const html = renderBarcodeSheet(sample)
  assert.equal((html.match(/class="label"/g) ?? []).length, 2)
  assert.equal((html.match(/<svg/g) ?? []).length, 2)
  assert.match(html, /class="sku">400438912</)
  assert.match(html, /class="sku">4269907</)
})

test('renderBarcodeSheet: наименование с разметкой экранируется', () => {
  const item = barcodeItem({ sku: '1', barcode: '4660294839975', name: '<img src=x onerror=alert(1)>' })!
  const html = renderBarcodeSheet([item])
  assert.ok(!html.includes('<img'))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('renderBarcodeSheet: штрих тянется на всю ширину этикетки', () => {
  // Иначе 18-значный код уехал бы за край и не читался бы — ради него и
  // выбрана широкая этикетка. Ширина задаётся в мм, а не `width:100%`:
  // у абсолютно позиционированного <svg> `width:auto` не растягивается между
  // left и right, это собственная ширина, и полоса обрезалась краем этикетки.
  const html = renderBarcodeSheet(sample)
  const innerMm = SHEET_LAYOUT.labelWidthMm - 2 * 2 // минус отступы слева и справа
  assert.match(html, new RegExp(`\\.label svg\\{position:absolute;left:2mm;width:${innerMm}mm;`))
})

test('renderBarcodeSheet: высота полосы задана явно, а не выведена из пропорции', () => {
  // Регресс: при width:100% и height:auto браузер считал высоту по пропорции
  // viewBox, и EAN-13 (117 модулей в ширину против 64 в высоту) занимал
  // 49.8 мм при доступных 41 мм — полоса выдавливала .sku и .name под
  // overflow:hidden, и подпись уезжала тем ниже, чем длиннее код.
  const html = renderBarcodeSheet(sample)
  assert.doesNotMatch(html, /\.label svg\{width:100%;height:auto/)
  const mm = html.match(/\.label svg\{[^}]*height:(\d+(?:\.\d+)?)mm/)
  assert.ok(mm, 'высота полосы должна быть задана в мм')
  // Полоса плюс обе строки подписи должны помещаться в этикетку. Подпись — это
  // отдельный ряд грида, поэтому считаем обе строки целиком: .sku задаёт свой
  // line-height 1.1, .name наследует 1.25 от body. 1px при 96dpi = 0.2646 мм.
  const PX_MM = 25.4 / 96
  const contentMm = SHEET_LAYOUT.labelHeightMm - 2 * 2
  const textMm = (13 * 1.1 + 9 * 1.25) * PX_MM
  assert.ok(
    Number(mm[1]) + textMm < contentMm,
    `полоса ${mm[1]}мм + подпись ${textMm.toFixed(1)}мм должны влезать в ${contentMm}мм`,
  )
  // preserveAspectRatio=none держит полосу во всю ширину: без него SVG вписался
  // бы по высоте и оставил бы этикетку пустой по бокам.
  assert.match(html, /preserveAspectRatio="none"/)
})

test('renderBarcodeSheet: полоса по центру этикетки, подпись внизу', () => {
  // Полоса вне потока и центрируется сдвигом на половину своей высоты: в
  // потоке она центрировалась бы в остатке после подписи и уезжала выше
  // середины. Подпись — единственное, что держит поток, и прижата к низу.
  const html = renderBarcodeSheet(sample)
  assert.match(html, /\.label svg\{position:absolute;/)
  assert.match(html, /top:50%;transform:translateY\(-50%\)/)
  assert.match(html, /justify-content:flex-end/)
  // Ширина задана в мм, а не через left/right: у абсолютного <svg> `width:auto`
  // не растягивается между ними — это собственная ширина, и полоса обрезалась
  // краем этикетки.
  assert.match(html, /\.label svg\{position:absolute;left:2mm;width:91mm;/)
  // Подпись центрируется под полосой: без align-items колонка уводила её влево.
  assert.match(html, /align-items:center;justify-content:flex-end/)
})

test('renderBarcodeSheet: этикетка не рвётся между страницами', () => {
  const html = renderBarcodeSheet(sample)
  assert.match(html, /break-inside:avoid/)
  assert.match(html, /page-break-inside:avoid/)
  assert.match(html, /overflow:hidden/)
})

test('renderBarcodeSheet: пустой список даёт валидный пустой лист', () => {
  const html = renderBarcodeSheet([])
  assert.match(html, /^<!doctype html>/)
  assert.equal((html.match(/class="label"/g) ?? []).length, 0)
})

test('barcodeFileName: дата и минуты', () => {
  assert.equal(barcodeFileName(new Date(2026, 9, 13, 15, 12)), 'Штрихи 2026-10-13-1512.pdf')
  assert.equal(barcodeFileName(new Date(2026, 11, 1, 8, 5)), 'Штрихи 2026-12-01-0805.pdf')
})

/* ── Сквозная связка: всё, что уйдёт в PDF, должно печататься ───────────── */

test('сквозная проверка: позиция из индекса печатается и совпадает с исходной базой', () => {
  // Тот путь, который пройдёт пользователь: строка индекса с диска → позиция
  // → этикетка. Если symbology разъедется между оверлеем и листом, тест
  // поймает это тут, а не на бумаге.
  const lines = [
    `400438912${INDEX_FIELD_SEP}4660294839975${INDEX_FIELD_SEP}AC Ballu BPAC-07 SL/N6`,
    `4269907${INDEX_FIELD_SEP}693996262756465284${INDEX_FIELD_SEP}(A)В/Г/пан. Midea MG699TTGB`,
    `6010089${INDEX_FIELD_SEP}6010089${INDEX_FIELD_SEP}Установка Холодильника Side-by-Side`,
  ]
  const items = lines.map((line) => barcodeItem(parseIndexLine(line)!)).filter((item) => item !== null)
  assert.equal(items.length, 3)
  const expanded = expandCopies(items, 2)!
  assert.equal(expanded.length, 6)
  const html = renderBarcodeSheet(expanded)
  assert.equal((html.match(/<svg/g) ?? []).length, 6)
  // Symbology листа совпадает с расчётом из ядра — превью и печать рисуют
  // одно и то же, и оверлей показывает не то, что уйдёт на бумагу.
  for (const item of items) {
    const built = buildBarcode(item.barcode)
    assert.ok(built)
    assert.equal(built.symbology, item.symbology)
  }
})