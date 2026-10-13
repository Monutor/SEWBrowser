import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { buildIndexText, isGzip, parseDbJsonText, unpackDbJson } from './barcode-db-core.ts'

/* ── Формат файла ───────────────────────────────────────────────────────── */

test('isGzip: магия 1F 8B, а не Content-Type', () => {
  assert.equal(isGzip(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])), true)
  assert.equal(isGzip(new Uint8Array([0x5b, 0x7b, 0x22])), false, 'обычный JSON')
  assert.equal(isGzip(new Uint8Array([0x1f])), false, 'короче двух байт')
  assert.equal(isGzip(new Uint8Array(0)), false)
})

test('unpackDbJson: gzip и обычный JSON читаются одинаково', () => {
  const json = '[{"Код товара":"1","ШК товара":"4660294839975","Наименование":"Ballu"}]'
  assert.equal(unpackDbJson(new TextEncoder().encode(json)), json)
  assert.equal(unpackDbJson(gzipSync(Buffer.from(json, 'utf8'))), json)
})

test('unpackDbJson: кириллица не бьётся', () => {
  const json = '[{"Код товара":"1","ШК товара":"693996262756465284","Наименование":"(A)В/Г/пан. Midea"}]'
  assert.equal(unpackDbJson(gzipSync(Buffer.from(json, 'utf8'))), json)
})

/* ── Индекс ─────────────────────────────────────────────────────────────── */

test('buildIndexText: строка в порядке SKU, ШК, наименование', () => {
  const db = [{ 'Код товара': '400438912', 'ШК товара': '4660294839975', 'Наименование': 'AC Ballu BPAC-07 SL/N6' }]
  const stats = buildIndexText(db)
  assert.equal(stats.items, 1)
  assert.equal(stats.skipped, 0)
  assert.equal(stats.text, '400438912\t4660294839975\tAC Ballu BPAC-07 SL/N6')
})

test('buildIndexText: запись без SKU или без ШК пропускается', () => {
  const db = [
    { 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'A' },
    { 'Код товара': '', 'ШК товара': '4660294839975', 'Наименование': 'B' },
    { 'Код товара': '3', 'ШК товара': '   ', 'Наименование': 'C' },
    { 'Наименование': 'D' },
    { 'Код товара': 5, 'ШК товара': 6, 'Наименование': 'E' },
  ]
  const stats = buildIndexText(db)
  assert.equal(stats.items, 1)
  assert.equal(stats.skipped, 4, 'числовые коды тоже мусор — в базе всё строками')
})

test('buildIndexText: таб и перевод строки в наименовании не ломают индекс', () => {
  // Одна табая позиция сдвинула бы все следующие при разборе — это тихая
  // порча, которая проявилась бы только на печати «не того товара».
  const db = [{ 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'Пылесос\tбордовый\n3000 Вт' }]
  const stats = buildIndexText(db)
  assert.equal(stats.text, '1\t4660294839975\tПылесос бордовый 3000 Вт')
  assert.equal(stats.text.split('\n').length, 1, 'перевод строки в индексе = вторая позиция')
})

test('buildIndexText: пустое наименование не теряет позицию', () => {
  const db = [{ 'Код товара': '6010089', 'ШК товара': '6010089', 'Наименование': '' }]
  assert.equal(buildIndexText(db).text, '6010089\t6010089\t')
})

test('buildIndexText: мусор на входе — пустой индекс, а не исключение', () => {
  for (const bad of [null, undefined, 'текст', 42, {}]) {
    const stats = buildIndexText(bad)
    assert.equal(stats.items, 0, String(bad))
    assert.equal(stats.text, '')
  }
})

test('buildIndexText: позиции db.json в том же порядке, что в базе', () => {
  const db = [
    { 'Код товара': '3', 'ШК товара': '4660294839976', 'Наименование': 'C' },
    { 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'A' },
    { 'Код товара': '2', 'ШК товара': '4660294839977', 'Наименование': 'B' },
  ]
  assert.deepEqual(buildIndexText(db).text.split('\n'), [
    '3\t4660294839976\tC',
    '1\t4660294839975\tA',
    '2\t4660294839977\tB',
  ])
})

test('buildIndexText: круговой путь gzip → JSON → индекс без потерь', () => {
  const db = [
    { 'Код товара': '400438912', 'ШК товара': '4660294839975', 'Наименование': 'AC Ballu BPAC-07 SL/N6' },
    { 'Код товара': '4269907', 'ШК товара': '693996262756465284', 'Наименование': '(A)В/Г/пан. Midea MG699TTGB' },
    { 'Код товара': '6010089', 'ШК товара': '6010089', 'Наименование': 'Установка Холодильника Side-by-Side' },
  ]
  const packed = gzipSync(Buffer.from(JSON.stringify(db), 'utf8'))
  const stats = buildIndexText(JSON.parse(unpackDbJson(packed)))
  assert.equal(stats.items, 3)
  assert.equal(stats.skipped, 0)
})

/* ── Разбор без полного JSON.parse ───────────────────────────────────────── */

const DB = [
  { 'Код товара': '400438912', 'ШК товара': '4660294839975', 'Наименование': 'AC Ballu BPAC-07 SL/N6' },
  { 'Код товара': '4269907', 'ШК товара': '693996262756465284', 'Наименование': '(A)В/Г/пан. Midea MG699TTGB' },
  { 'Код товара': '6010089', 'ШК товара': '6010089', 'Наименование': 'Установка Холодильника Side-by-Side' },
  { 'Код товара': '4278495', 'ШК товара': '35', 'Наименование': '(МП)Кровать Ami Империя Голд 1800 Б09' },
]

test('parseDbJsonText: даёт тот же индекс, что и полный разбор', () => {
  const json = JSON.stringify(DB)
  const fast = parseDbJsonText(json)
  const slow = buildIndexText(JSON.parse(json))
  assert.ok(fast)
  assert.deepEqual(fast, slow)
})

test('parseDbJsonText: одна запись и пустой массив', () => {
  const one = parseDbJsonText(JSON.stringify([DB[0]]))
  assert.ok(one)
  assert.equal(one.items, 1)
  assert.equal(one.text, '400438912\t4660294839975\tAC Ballu BPAC-07 SL/N6')
  const none = parseDbJsonText('[]')
  assert.ok(none)
  assert.equal(none.items, 0)
  assert.equal(none.text, '')
})

test('parseDbJsonText: битые записи считаются пропущенными, а не роняют базу', () => {
  const stats = parseDbJsonText(JSON.stringify([DB[0], { 'Наименование': 'без кода' }, DB[1]]))
  assert.ok(stats)
  assert.equal(stats.items, 2)
  assert.equal(stats.skipped, 1)
})

test('parseDbJsonText: кавычки и экранирование в наименовании не ломают разбор', () => {
  const db = [{ 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'Пылесос "Karcher" \\ серия, 2000 Вт' }]
  const fast = parseDbJsonText(JSON.stringify(db))
  assert.ok(fast)
  assert.equal(fast.text, buildIndexText(JSON.parse(JSON.stringify(db))).text)
  assert.match(fast.text, /Karcher/)
})

test('parseDbJsonText: не массив объектов — null, вызывающий откатится на JSON.parse', () => {
  assert.equal(parseDbJsonText(''), null)
  assert.equal(parseDbJsonText('   '), null)
  assert.equal(parseDbJsonText('{"a":1}'), null)
  assert.equal(parseDbJsonText('[1,2,3]'), null, 'не объекты')
  assert.equal(parseDbJsonText('[{"a":1}, 5]'), null, 'разделитель не сработал — нужен откат')
  assert.equal(parseDbJsonText('[{"a":1},{'), null, 'обрезанный файл')
})

test('parseDbJsonText: разделитель не берёт разрез по строковому значению', () => {
  // Ключевой случай фолбэка: если наименование содержит «},{», наивный разрез
  // порвёт объект — JSON.parse куска упадёт, и мы получим null, а не половину
  // базы. Проверяем, что именно так и происходит.
  const db = [{ 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'скоба },{' }]
  const json = JSON.stringify(db)
  assert.equal(parseDbJsonText(json), null)
  // …и полный разбор при этом справляется — база не потеряна.
  assert.equal(buildIndexText(JSON.parse(json)).items, 1)
})

test('parseDbJsonText: фигурные скобки без разделителя разрез не путают', () => {
  // Обратная сторона: обычные скобки в наименовании безопасны, быстрый путь
  // обязан на них отработать, а не откатываться на полный разбор.
  const db = [{ 'Код товара': '1', 'ШК товара': '4660294839975', 'Наименование': 'скоба { и запятая }, внутри' }]
  const json = JSON.stringify(db)
  const fast = parseDbJsonText(json)
  assert.ok(fast)
  assert.equal(fast.text, buildIndexText(JSON.parse(json)).text)
})