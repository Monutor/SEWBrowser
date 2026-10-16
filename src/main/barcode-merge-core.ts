/** Приложение своих позиций к локальной базе штрихов: разбор файла
 *  пользователя в позиции и слияние с уже приложенными.
 *
 *  Модуль чистый: без electron и без файловой системы, всё тестируется в
 *  node:test. Кто выбирает файл (диалог), читает его с диска и пишет
 *  `%APPDATA%/SEWBrowser/barcode-db/extra.json` — src/main/barcode-db.ts.
 *
 *  Зачем вообще приложение, если db.json едет с обновлением: база SEW
 *  обновляется магазином раз в месяц, а новые позиции нужны в день их
 *  появления. Пользователь кладёт рядом свой файл (xlsx с артикулами и ШК или
 *  чужой db.json), позиции ложатся в отдельный файл поверх индекса — и печать
 *  находит их сразу, без пересборки 116 МБ и без новой версии приложения.
 */
import { buildBarcode } from '../shared/barcode-core.ts'
import { parseIndexLine, type DbRow } from '../shared/barcode-print-core.ts'

/** Сколько позиций держим приложенными. Это дополнение к базе, а не её
 *  замена: база — 272 тыс. строк, а дописывают десятки. Большой файл значит,
 *  что пользователь приложил не дополнение, а чужую базу целиком. */
export const EXTRA_LIMIT = 20_000

/** Претензионное имя файла приложенной базы: `extra.json` рядом с индексом. */
export const EXTRA_VERSION = 1

export interface MergeOutcome {
  /** Позиции после слияния, в порядке: прежние, потом новые. */
  rows: DbRow[]
  /** Добавлено позиций, которых в приложенных не было. */
  added: number
  /** Перекрыто позиций с уже приложенным артикулом (файл пользователя — его воля). */
  updated: number
  /** Строки файла, в которые нечего положить: без кода товара или с непечатным ШК. */
  skipped: number
}

export interface ExtraPayload {
  updatedAt: number
  /** Имя файла-источника: показать пользователю, откуда взяты позиции. */
  source: string
  rows: DbRow[]
}

/** Табы и переводы строк в строке индекса ломают разбор: наименование может
 *  содержать что угодно, и одна такая позиция сдвинет все следующие. */
function oneLine(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim()
}

/** Код товара: те же правила, что у списка артикулов в оверлее — только
 *  непустая строка, в которой есть цифра. Всё остальное (заголовок колонки,
 *  номер телефона из соседней ячейки) в базу не пускаем: иначе пользователь
 *  получит «не найдено» на каждый случайный набор цифр из файла. */
function normalizeSku(raw: unknown): string {
  const value = oneLine(raw)
  if (!value || value.length > 32) return ''
  return /^[\w-]*\d[\w-]*$/.test(value) ? value : ''
}

/** Штрих-код: только цифры, не длиннее 40 знаков, и только тот, который
 *  вообще кодируется.
 *
 *  Цифры — потому что весь ШК в db.json цифровой (проверено на живом файле:
 *  272 392 значения, ни одного нецифрового), а буквы в штрих-коде из чужого
 *  файла — это почти всегда номер артикула или мусор из соседней ячейки.
 *  buildBarcode такие коды нарисовал бы (Code 128 кодирует и буквы), и
 *  пользователь получил бы на этикетке не штрих, а номер.
 *
 *  Длина — из той же логики: самый длинный код в базе это 18 знаков, а полоса
 *  из 50 цифр на этикетке 95 мм не помещается и печатается в кашу. */
function normalizeBarcode(raw: unknown): string {
  const value = oneLine(raw)
  if (!/^\d{1,40}$/.test(value)) return ''
  return buildBarcode(value) ? value : ''
}

/** Строка файла → позиция; `null`, если печатать её нечем. */
export function normalizeRow(raw: unknown): DbRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const sku = normalizeSku(row['sku'])
  if (!sku) return null
  const barcode = normalizeBarcode(row['barcode'])
  if (!barcode) return null
  return { sku, barcode, name: oneLine(row['name']) }
}

/** Латиница → кириллические «двойники». Файлы SEW смешивают алфавиты в одной
 *  шапке («Код EAN/UPC»), а русские колонки названы по-русски («ШК товара»).
 *  Сведение к одному алфавиту позволяет держать список заголовков в том виде,
 *  в каком их пишет человек, и не дублировать его в обоих написаниях. */
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  k: 'к',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'р',
  s: 'с',
  t: 'т',
  y: 'у',
  x: 'х',
}

/** Заголовок колонки → ключ поиска: нижний регистр, один алфавит, без пробелов,
 *  «ё» и пунктуации. «Код EAN/UPC» и «Код товара» после этого сравнимы
 *  построчно с тем, как заголовок написан в файле. */
function headerKey(title: unknown): string {
  return oneLine(title)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[acekmnopstyx]/g, (char) => HOMOGLYPHS[char])
    .replace(/[\s\-_.,()«»№]+/g, '')
}

/** Заголовки, которые понимаем как код товара. «Номер товара Эльдорадо» сюда
 *  намеренно НЕ входит: в базе SEW ключ — «Код товара», а эльдорадовский
 *  номер в ней не встречается ни разу (проверено на живом db.json). */
const SKU_HEADERS = ['Материал', 'Код товара', 'Артикул', 'SKU'].map(headerKey)
/** Заголовки штрих-кода товара. */
const BARCODE_HEADERS = ['Код EAN/UPC', 'EAN', 'EAN/UPC', 'UPC', 'ШК товара', 'Штрих товара', 'Штрих-код', 'ШК'].map(headerKey)
/** Заголовки наименования. Без него позиция приложится, но на этикетке будет
 *  только артикул. */
const NAME_HEADERS = ['Номер материала', 'Наименование', 'Наименование товара', 'Название', 'Описание', 'Name'].map(headerKey)

function emptyOutcome(): MergeOutcome {
  return { rows: [], added: 0, updated: 0, skipped: 0 }
}

function missingColumnsError(header: readonly unknown[], skuCol: number, bcCol: number): Error {
  const need = [
    skuCol < 0 ? 'с кодом товара («Материал» или «Код товара»)' : '',
    bcCol < 0 ? 'со штрих-кодом («Код EAN/UPC» или «ШК товара»)' : '',
  ].filter(Boolean).join(' и ')
  const titles = header.map((value) => oneLine(value)).filter(Boolean)
  return new Error(
    `xlsx: в шапке нет колонки ${need}. В файле: ${titles.slice(0, 8).join(', ') || 'ничего не прочитано'}`,
  )
}

/** Позиции листа: какая колонка за что отвечает. */
function detectColumns(row: readonly unknown[]): { sku: number; barcode: number; name: number } {
  const keys = row.map((title) => headerKey(title))
  return {
    sku: keys.findIndex((key) => SKU_HEADERS.includes(key)),
    barcode: keys.findIndex((key) => BARCODE_HEADERS.includes(key)),
    name: keys.findIndex((key) => NAME_HEADERS.includes(key)),
  }
}

/**
 * Лист xlsx (строки и колонки как есть) → позиции.
 *
 *  Колонки берём по ЗАГОЛОВКАМ, а не по буквам: файл мог выгрузить кто угодно, а
 *  порядок колонок меняется от выгрузки к выгрузке. Шапка ищется по первой
 *  строке, где есть обе нужные колонки, а не по первой непустой: сверху часто
 *  лежит строка-титул («Отчёт по штрихам»), и читать её за шапку нельзя.
 *
 *  Один артикул может идти в файле дважды с разными ШК (у МП-товаров это
 *  обычное дело: одна модель — два цвета). Индекс хранит один ШК на артикул,
 *  поэтому берём ПОСЛЕДНЕЕ вхождение — так же ведёт себя поиск по базе.
 */
export function rowsFromSheet(rows: readonly (readonly unknown[])[]): MergeOutcome {
  const sheet = Array.isArray(rows) ? rows : []
  let headerIndex = -1
  let columns = { sku: -1, barcode: -1, name: -1 }
  let fallbackIndex = -1
  for (let i = 0; i < sheet.length; i += 1) {
    const row = sheet[i]
    if (!Array.isArray(row) || !row.some((cell) => oneLine(cell))) continue
    if (fallbackIndex < 0) fallbackIndex = i
    const found = detectColumns(row)
    // Шапка — строка с ОБЕИМИ нужными колонками. Имя товара опционально.
    if (found.sku >= 0 && found.barcode >= 0) {
      headerIndex = i
      columns = found
      break
    }
  }
  if (headerIndex < 0) {
    if (fallbackIndex < 0) throw new Error('xlsx: лист пустой — читать нечего')
    throw missingColumnsError(sheet[fallbackIndex] ?? [], -1, -1)
  }

  const outcome = emptyOutcome()
  const bySku = new Map<string, DbRow>()
  for (let i = headerIndex + 1; i < sheet.length; i += 1) {
    const row = sheet[i] ?? []
    const item = normalizeRow({
      sku: row[columns.sku],
      barcode: row[columns.barcode],
      name: columns.name >= 0 ? row[columns.name] : '',
    })
    if (!item) {
      outcome.skipped += 1
      continue
    }
    bySku.set(item.sku, item)
  }
  outcome.rows = [...bySku.values()]
  return outcome
}

/**
 * Чужой db.json → позиции. На вход — строки индекса `SKU⇥ШК⇥Наименование`,
 * их собирает main (тем же кусковым разбором, что и для основной базы: полный
 * JSON.parse файла на 116 МБ поднимает RSS процесса до 559 МБ).
 */
export function rowsFromIndexText(text: string): MergeOutcome {
  const outcome = emptyOutcome()
  const bySku = new Map<string, DbRow>()
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    const item = normalizeRow(parseIndexLine(line))
    if (!item) {
      outcome.skipped += 1
      continue
    }
    bySku.set(item.sku, item)
  }
  outcome.rows = [...bySku.values()]
  return outcome
}

/**
 * Слияние с уже приложенными позициями: прежние не трогаем, новые дописываем
 * в конец (порядок базы пользователю не важен, а переписывание файла целиком
 * при каждом импорте лишнее), существующий артикул перекрываем — файл
 * пользователя и есть источник правды о его штрихах.
 */
export function mergeRows(current: readonly DbRow[], incoming: readonly DbRow[]): MergeOutcome {
  const outcome = emptyOutcome()
  const at = new Map<string, number>()
  for (const raw of current) {
    const item = normalizeRow(raw)
    // Дубль в самом файле приложенных — оставляем первый: перезапись задним
    // числом сделала бы файл зависимым от порядка строк.
    if (!item || at.has(item.sku)) continue
    at.set(item.sku, outcome.rows.length)
    outcome.rows.push(item)
  }
  for (const raw of incoming) {
    const item = normalizeRow(raw)
    if (!item) {
      outcome.skipped += 1
      continue
    }
    const pos = at.get(item.sku)
    if (pos === undefined) {
      at.set(item.sku, outcome.rows.length)
      outcome.rows.push(item)
      outcome.added += 1
      continue
    }
    outcome.rows[pos] = item
    outcome.updated += 1
  }
  return outcome
}

/** Разбор позиций файла по базе: что имеет смысл хранить, а что уже есть. */
export interface BasePartition {
  /** Позиции файла, которые надо положить в extra.json: новые и те, чей штрих
   *  в файле отличается от базового. */
  store: DbRow[]
  /** Артикулы позиций, что база знает с ТЕМ ЖЕ штрихом: хранить нечего, поиск
   *  отдаст то же значение из индекса, а оверлею такие позиции не надо
   *  показывать как требующие добавления. */
  same: string[]
  /** Артикулы позиций, что в базе есть, но с ДРУГИМ штрихом: их хранить
   *  обязательно — файл пользователя главнее базы. */
  different: string[]
}

/**
 * Что из файла класть в extra.json, а что уже покрыто базой.
 *
 * Без этого отчёт об остатках магазина (7 тысяч позиций, у которых штрих
 * совпадает с базовым) ложился в extra.json целиком: файл раздувался, а
 * `extra` в статусе показывал чужие дубли базы как «свои позиции».
 *
 * `base` — штрих базы по артикулу и только для позиций файла: его собирает
 * main одним проходом по индексу. Штрихи сравниваются строго, как строки: и
 * база, и файл приводят код к цифрам, но `0461…` и `461…` — это разные
 * значения, и молча приравнять их нельзя.
 */
export function partitionAgainstBase(
  rows: readonly DbRow[],
  base: ReadonlyMap<string, string>,
): BasePartition {
  const part: BasePartition = { store: [], same: [], different: [] }
  for (const raw of rows) {
    const item = normalizeRow(raw)
    if (!item) continue
    const known = base.get(item.sku)
    if (known === undefined) {
      part.store.push(item)
    } else if (known === item.barcode) {
      part.same.push(item.sku)
    } else {
      part.different.push(item.sku)
      part.store.push(item)
    }
  }
  return part
}

/**
 * Файл приложенных позиций. Любой мусор (битый JSON, объект вместо массива,
 * не-строки внутри) даёт пустой список: приложенное — дополнение, потеря
 * которого не должна ломать печать по основной базе.
 */
export function parseExtraJson(text: string): ExtraPayload {
  const empty: ExtraPayload = { updatedAt: 0, source: '', rows: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object') return empty
  const payload = parsed as { updatedAt?: unknown; source?: unknown; rows?: unknown }
  const rows: DbRow[] = []
  if (Array.isArray(payload.rows)) {
    for (const raw of payload.rows) {
      const item = normalizeRow(raw)
      if (item) rows.push(item)
    }
  }
  return {
    updatedAt: typeof payload.updatedAt === 'number' && Number.isFinite(payload.updatedAt) ? payload.updatedAt : 0,
    source: typeof payload.source === 'string' ? payload.source.slice(0, 200) : '',
    rows,
  }
}