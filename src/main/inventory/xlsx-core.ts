/**
 * Разбор выгрузки остатков SEW (`Остатки <магазин> <дата>.xlsx`) в чистые
 * данные для плагина `sew-inventory`. Модуль без electron и без сети — чтобы
 * покрыть тестами; IPC-обработчик только вызывает его.
 *
 * Что важно знать о файле (снято с реальной выгрузки 01.10.2026, S187):
 *  - это zip, внутри `xl/worksheets/sheet1.xml` и `xl/sharedStrings.xml`;
 *  - `sharedStrings.xml` в выгрузке SEW ПУСТОЙ — все значения, включая числа,
 *    лежат инлайном в ячейках (`t="inlineStr"`), поэтому общий разбор строк
 *    обязателен, а оптимизация «числа не трогаем» тут не работает;
 *  - шапка — первая строка листа, данные со второй; колонки фиксированы
 *    (A … W), но берём их по ЗАГОЛОВКАМ, а не по буквам — при смене выгрузки
 *    SEW порядок может поехать;
 *  - одна строка = товар на конкретной ячейке хранения, а не на склад: один
 *    SKU встречается в разных ячейках и зонах, поэтому количество для ЛП —
 *    сумма строк нужной зоны.
 *
 * Файл на 9 000 позиций разворачивается в ~12 МБ XML, поэтому разбор идёт по
 * буферу, а построчного чтения потоком нет: 12 МБ в main переживаются спокойно,
 * зато код остаётся читаемым.
 */
import { inflateRawSync } from 'node:zlib'

/** Заголовки колонок выгрузки → наши поля. Ключ — нормализованный заголовок. */
const FIELDS = {
  sku: 'кодтовара',
  name: 'наименование',
  qty: 'количество',
  zone: 'зона',
  cell: 'ячейкихранения',
  cellBarcode: 'шкячейкихранения',
  barcode: 'шктовара',
  brand: 'бренд',
} as const

type Field = keyof typeof FIELDS

/** Поля, без которых разбор бессмыслен. */
const REQUIRED: Field[] = ['sku', 'qty']

export interface StockRow {
  sku: string
  name: string
  /** Сумма по всем ячейкам зоны */
  qty: number
  barcode: string
  zone: string
  /** Первая ячейка хранения, где товар найден */
  cell: string
  cellBarcode: string
  /** Сколько строк (ячеек) сложилось в эту позицию */
  cells: number
}

export interface StockBalanceOptions {
  /** Зона ЛП — точное совпадение по колонке «Зона» (регистр и «ё» не важны) */
  zone?: string
  /** Список SKU из ЛП: пустой/незаданный — берём весь файл */
  skus?: readonly string[]
}

export interface StockBalance {
  /** Строк данных в файле, без шапки */
  totalRows: number
  /** Строк, прошедших фильтры */
  matchedRows: number
  /** Позиции по SKU, в порядке файла */
  rows: StockRow[]
  /** Зоны файла (для панели), не больше 50 */
  zones: string[]
}

interface ZipEntry {
  method: number
  csize: number
  localOffset: number
}

/** Каталог zip: читаем центральный каталог (нашёлся с конца файла). */
function readZipIndex(data: Buffer): Map<string, ZipEntry> {
  const min = Math.max(0, data.length - 66000)
  let eocd = -1
  for (let i = data.length - 22; i >= min; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('xlsx: не найден конец zip-каталога — это не xlsx')
  const count = data.readUInt16LE(eocd + 10)
  let off = data.readUInt32LE(eocd + 16)
  const out = new Map<string, ZipEntry>()
  for (let n = 0; n < count; n++) {
    if (off + 46 > data.length || data.readUInt32LE(off) !== 0x02014b50) break
    const nameLen = data.readUInt16LE(off + 28)
    const extraLen = data.readUInt16LE(off + 30)
    const commentLen = data.readUInt16LE(off + 32)
    out.set(data.toString('utf-8', off + 46, off + 46 + nameLen), {
      method: data.readUInt16LE(off + 10),
      csize: data.readUInt32LE(off + 20),
      localOffset: data.readUInt32LE(off + 42),
    })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * Текст одного файла из zip. Распакованный лист — 12 МБ, но в utf-8-строку он
 * укладывается без потерь кириллицы, а «буквы в latin1 + точечная перекодировка»
 * из предыдущей версии модуля ломала общие строки: их читает уже готовый
 * utf-8, и двойная перекодировка давала мусор вместо «Зона».
 */
function readZipText(data: Buffer, index: Map<string, ZipEntry>, name: string): string {
  const entry = index.get(name)
  if (!entry) throw new Error('xlsx: нет файл ' + name)
  const lo = entry.localOffset
  if (lo + 30 > data.length) throw new Error('xlsx: битый заголовок ' + name)
  const nameLen = data.readUInt16LE(lo + 26)
  const extraLen = data.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const raw = data.subarray(start, start + entry.csize)
  if (entry.method === 0) return raw.toString('utf-8')
  if (entry.method === 8) return inflateRawSync(raw).toString('utf-8')
  throw new Error('xlsx: неподдерживаемый метод сжатия ' + entry.method)
}

/** Заголовок в «ключ поля»: нижний регистр, без пробелов и «ё». */
function fieldKey(title: string): string {
  return title.toLowerCase().replace(/ё/g, 'е').replace(/[\s-]+/g, '')
}

/** Зона для сравнения: регистр, «ё» и лишние пробелы не должны мешать. */
function zoneKey(zone: string): string {
  return zone.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/** SKU для сравнения: только цифры, ведущие нули убираем — в ЛП и в файле
 *  формат может отличаться («00400320672» и «400320672» — один товар). */
function skuKey(sku: string): string {
  const digits = sku.trim()
  return /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, '') : digits.trim()
}

/** «2», «2,5», « 3 » → 2 / 2.5 / 3; мусор → 0. */
export function parseQty(raw: string): number {
  const n = Number(raw.trim().replace(/\s+/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Текст ячейки: снимаем entity-ссылки, которые SEW пишет в названиях («Philips &amp; Co»). */
function cellText(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, code: string) => {
    if (code.startsWith('#')) {
      const num = code.startsWith('#x') || code.startsWith('#X') ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(num) ? String.fromCodePoint(num) : match
    }
    return ENTITIES[code] ?? match
  })
}

const ROW_RE = /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g
const CELL_RE = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const INLINE_RE = /<t[^>]*>([\s\S]*?)<\/t>/
const VALUE_RE = /<v>([\s\S]*?)<\/v>/

/** Ячейки одной строки: буква колонки → значение (уже utf-8, без тегов). */
function readCells(rowXml: string, shared: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  CELL_RE.lastIndex = 0
  for (let m = CELL_RE.exec(rowXml); m; m = CELL_RE.exec(rowXml)) {
    const column = m[1]
    const attrs = m[2] ?? ''
    const body = m[3] ?? ''
    let value = ''
    if (body) {
      if (/t="inlineStr"/.test(attrs)) {
        const inline = INLINE_RE.exec(body)
        value = inline ? inline[1] : ''
      } else if (/t="s"/.test(attrs)) {
        const raw = VALUE_RE.exec(body)
        const idx = raw ? Number(raw[1]) : NaN
        value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : ''
      } else {
        const raw = VALUE_RE.exec(body)
        value = raw ? raw[1] : ''
      }
    }
    out.set(column, cellText(value))
  }
  return out
}

/** Общие строки листа (`xl/sharedStrings.xml`). В выгрузке SEW их обычно нет,
 *  но пустой файл — не повод ломаться: разбор инлайновых строк его не требует. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si>([\s\S]*?)<\/si>/g
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
  for (let m = siRe.exec(xml); m; m = siRe.exec(xml)) {
    let text = ''
    for (let t = tRe.exec(m[1]); t; t = tRe.exec(m[1])) text += t[1]
    out.push(cellText(text))
  }
  return out
}

function readSharedStrings(index: Map<string, ZipEntry>, data: Buffer): string[] {
  if (!index.has('xl/sharedStrings.xml')) return []
  return parseSharedStrings(readZipText(data, index, 'xl/sharedStrings.xml'))
}

/**
 * Позиции остатков, отобранные по зоне и (если задан) списку SKU.
 * Бросает Error на негодном файле — вызывающий обязан показать это в панели,
 * а не вносить неполный состав.
 */
export function readStockBalance(data: Buffer, opts: StockBalanceOptions = {}): StockBalance {
  const index = readZipIndex(data)
  const sheetName = index.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : [...index.keys()].find((n) => n.startsWith('xl/worksheets/'))
  if (!sheetName) throw new Error('xlsx: в файле нет листа с остатками')
  const shared = readSharedStrings(index, data)
  const xml = readZipText(data, index, sheetName)

  const start = xml.indexOf('<sheetData')
  const body = start >= 0 ? xml.slice(start) : xml
  ROW_RE.lastIndex = 0
  const first = ROW_RE.exec(body)
  if (!first) throw new Error('xlsx: лист пустой')

  // Шапка: буква колонки → наше поле.
  const columns = new Map<string, Field>()
  const header = readCells(first[1] ?? '', shared)
  for (const [column, title] of header) {
    const key = fieldKey(title)
    for (const field of Object.keys(FIELDS) as Field[]) {
      if (FIELDS[field] === key && !columns.has(column)) columns.set(column, field)
    }
  }
  for (const field of REQUIRED) {
    if (![...columns.values()].includes(field)) {
      throw new Error('xlsx: в шапке нет колонки «' + (field === 'sku' ? 'Код товара' : 'Количество') + '»')
    }
  }

  const wantZone = opts.zone ? zoneKey(opts.zone) : ''
  const wantSkus = opts.skus && opts.skus.length > 0 ? new Set(opts.skus.map(skuKey)) : null
  const bySku = new Map<string, StockRow>()
  const zones: string[] = []
  const seenZones = new Set<string>()
  let totalRows = 0
  let matchedRows = 0

  ROW_RE.lastIndex = first.index + first[0].length
  for (let m = ROW_RE.exec(body); m; m = ROW_RE.exec(body)) {
    if (!m[1]) continue
    totalRows++
    const cells = readCells(m[1], shared)
    const values = new Map<Field, string>()
    for (const [column, field] of columns) values.set(field, cells.get(column) ?? '')
    const zone = values.get('zone') ?? ''
    if (zones.length < 50) {
      const key = zoneKey(zone)
      if (zone && !seenZones.has(key)) {
        seenZones.add(key)
        zones.push(zone)
      }
    }
    if (wantZone && zoneKey(zone) !== wantZone) continue
    const sku = values.get('sku') ?? ''
    if (!sku.trim()) continue
    if (wantSkus && !wantSkus.has(skuKey(sku))) continue
    const qty = parseQty(values.get('qty') ?? '')
    if (qty <= 0) continue
    matchedRows++
    const key = skuKey(sku)
    const row = bySku.get(key)
    if (row) {
      row.qty += qty
      row.cells++
      if (!row.name) row.name = values.get('name') ?? ''
      if (!row.barcode) row.barcode = values.get('barcode') ?? ''
      if (!row.cell) row.cell = values.get('cell') ?? ''
      if (!row.cellBarcode) row.cellBarcode = values.get('cellBarcode') ?? ''
    } else {
      bySku.set(key, {
        sku: sku.trim(),
        name: values.get('name') ?? '',
        qty,
        barcode: values.get('barcode') ?? '',
        zone: zone.trim(),
        cell: values.get('cell') ?? '',
        cellBarcode: values.get('cellBarcode') ?? '',
        cells: 1,
      })
    }
  }

  return { totalRows, matchedRows, rows: [...bySku.values()], zones }
}