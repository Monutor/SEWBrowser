/** Локальная база штрихов для печати: чтение db.json с диска, сборка
 *  построчного индекса, поиск позиций по SKU и приложение своих позиций из
 *  файла пользователя.
 *
 * Зачем в main, а не в плагине гостя: страница SEW может не открыться вовсе
 * (гость не нужен для печати штрихов), а вместе с ней и плагин sew-helper с
 * загруженной базой — а лист печатать надо. Да и сам db.json весит 11 МБ в
 * gzip и 116 МБ в развёрнутом виде: держать его в гостях ради одного поля
 * «ШК по артикулу» незачем.
 *
 * Формат индекса на диске — построчный `SKU⇥ШК⇥Наименование` (15 МБ против
 * 116 МБ у db.json). Разбор построчный: обрезанный при аварийном выключении
 * файл стоит одну позицию, а не весь лист.
 *
 * Поверх индекса лежит `extra.json` — позиции, приложенные пользователем из
 * своего файла (xlsx с артикулами и ШК либо чужой db.json). Они перекрывают
 * базу и живут отдельным файлом: новая позиция не должна стоить новой версии
 * приложения и пересборки 116 МБ. Разбор файла пользователя —
 * src/main/barcode-merge-core.ts, а файл выбирает оверлей «Штрихи». */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  barcodeItem,
  INDEX_FIELD_SEP,
  parseIndexLine,
  type BarcodeItem,
  type DbRow,
} from '../shared/barcode-print-core'
import { buildIndexText, parseDbJsonText, unpackDbJson } from './barcode-db-core'
import {
  EXTRA_LIMIT,
  EXTRA_VERSION,
  mergeRows,
  parseExtraJson,
  partitionAgainstBase,
  rowsFromIndexText,
  rowsFromSheet,
  type ExtraPayload,
  type MergeOutcome,
} from './barcode-merge-core'
import { readSheetRows } from './inventory/xlsx-core'
import { getDatabaseFile } from './database-paths'
import { writeJsonAtomic } from './json-file'

export interface BarcodeDbStatus {
  /** empty — индекса ещё нет; building — идёт сборка; ready — можно печатать;
   *  error — собрать не вышло и печатать нечем. */
  state: 'empty' | 'building' | 'ready' | 'error'
  /** Что именно сейчас делает сборка — для текста в оверлее. */
  stage?: 'read' | 'index'
  /** Сколько позиций в индексе. */
  items?: number
  /** Когда индекс построен (мс, 0 — неизвестно). */
  updatedAt?: number
  /** Размер прочитанного db.json в байтах. */
  sourceBytes?: number
  error?: string
  /** Исходный db.json новее индекса, но печатать можно. Печать важнее свежести. */
  stale?: boolean
  /** Сколько позиций приложил пользователь из своих файлов. */
  extra?: number
  /** Когда приложили последний раз (мс, 0 — не приложения не было). */
  extraUpdatedAt?: number
  /** Имя последнего приложенного файла: откуда взяты свои позиции. */
  extraSource?: string
}

export interface BarcodeDbLookup {
  /** Позиции в порядке запрошенных SKU, без повторов. */
  items: BarcodeItem[]
  /** SKU, которых в базе нет. */
  missing: string[]
}

/** Результат приложения файла пользователя — по нему оверлей пишет, что
 *  именно произошло: сколько позиций добавилось, сколько перекрыло записи
 *  базы, а сколько строк файла печатать нельзя. */
export interface BarcodeImportResult {
  ok: boolean
  /** Новых позиций (такого артикула не было в приложенных). */
  added: number
  /** Перекрыто позиций с уже приложенным артикулом. */
  updated: number
  /** Сколько позиций файла в базе db.json есть, но с ДРУГИМ штрихом: их
   *  штрих приложенный файл перекрывает, поэтому они в extra.json лежат. */
  inBase: number
  /** Строки файла, в которые нечего положить. */
  skipped: number
  /** Всего позиций приложено пользователем (файл extra.json). */
  total: number
  /** Имя файла-источника. */
  source: string
  /** Позиции, которые принёс файл, — оверлей показывает их списком и печатает
   *  сразу, не заставляя вбивать артикулы руками. При отказе пустой список. */
  items: BarcodeItem[]
  /** Артикулы позиций файла, что база уже знает с тем же штрихом: в extra.json
   *  они не лежат (поиск найдёт их по индексу), а оверлей гасит в списке —
   *  добавлять их в лист печати не нужно. */
  baseSkus: string[]
  error?: string
  status: BarcodeDbStatus
}

export interface BarcodeDbService {
  status(): BarcodeDbStatus
  /** Собрать индекс, если его нет или он старше db.json. Из статуса `error`
   *  вызывать смысла нет — есть `reload()`. */
  ensure(): Promise<BarcodeDbStatus>
  /** Обновить по кнопке «Обновить базу». */
  reload(): Promise<BarcodeDbStatus>
  /** Позиции по списку SKU. */
  lookup(skus: readonly string[]): BarcodeDbLookup
  /** Приложить позиции из файла пользователя (xlsx или db.json). */
  importFile(filePath: string): BarcodeImportResult
}

interface DbMeta {
  builtAt: number
  items: number
  sourceBytes: number
  /** mtime db.json на момент сборки — по нему решаем, устарел ли индекс. */
  sourceMtime: number
}

/** Больше 200 МБ приложить нельзя: это заведомо не дополнение, а чужой
 *  db.json целиком, и разбирать его в main смысла нет — своя база уже есть. */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export function createBarcodeDb(): BarcodeDbService {
  const dir = join(app.getPath('userData'), 'barcode-db')
  const indexFile = join(dir, 'index.txt')
  const metaFile = join(dir, 'meta.json')
  // Позиции, приложенные пользователем из своих файлов: дополнение к базе,
  // а не её замена. Живут рядом с индексом и переживают обновление
  // приложения — в отличие от db.json, который каждый раз приезжает свой.
  const extraFile = join(dir, 'extra.json')
  // База едет с приложением (electron-builder: src/database -> resources/database).
  const sourceFile = getDatabaseFile('db.json')

  let status: BarcodeDbStatus = { state: 'empty' }
  let running: Promise<BarcodeDbStatus> | null = null

  function readMeta(): DbMeta | null {
    try {
      const raw = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (!isRecord(raw)) return null
      return {
        builtAt: typeof raw.builtAt === 'number' ? raw.builtAt : 0,
        items: typeof raw.items === 'number' ? raw.items : 0,
        sourceBytes: typeof raw.sourceBytes === 'number' ? raw.sourceBytes : 0,
        sourceMtime: typeof raw.sourceMtime === 'number' ? raw.sourceMtime : 0,
      }
    } catch {
      return null
    }
  }

  /** Приложенные позиции. Файла нет — это обычное состояние (никто ничего
   *  не приложил), а битый файл — повод молчать и печатать по базе. */
  function readExtra(): ExtraPayload {
    try {
      if (!existsSync(extraFile)) return { updatedAt: 0, source: '', rows: [] }
      return parseExtraJson(readFileSync(extraFile, 'utf8'))
    } catch (err) {
      console.warn('[barcode-db] приложенные позиции не прочитаны:', err)
      return { updatedAt: 0, source: '', rows: [] }
    }
  }

  /** Поля статуса от приложенных позиций. Отдельный файл, поэтому состояние
   *  индекса от них не зависит. */
  function extraStatus(): Pick<BarcodeDbStatus, 'extra' | 'extraUpdatedAt' | 'extraSource'> {
    const payload = readExtra()
    if (payload.rows.length === 0) return {}
    return { extra: payload.rows.length, extraUpdatedAt: payload.updatedAt, extraSource: payload.source }
  }

  /** Статус по файлам на диске — вызывается до любой сборки, поэтому
   *  переживает перезапуск приложения без поднятия базы заново. */
  function readStatusFromDisk(): BarcodeDbStatus {
    if (!existsSync(indexFile)) return { state: 'empty', ...extraStatus() }
    const meta = readMeta()
    const items = meta?.items ?? 0
    const updatedAt = meta?.builtAt ?? 0
    // Устарел индекс ровно тогда, когда db.json на диске новее индекса: база
    // приезжает с обновлением приложения, и пересобрать её надо один раз.
    // Прежний TTL в 12 часов здесь был нужен только чтобы не качать 11 МБ
    // при каждом запуске — качать больше нечего.
    const sourceMtime = mtimeOf(sourceFile)
    const stale = sourceMtime > 0 && sourceMtime > mtimeOf(indexFile)
    return {
      state: 'ready',
      items,
      updatedAt,
      sourceBytes: meta?.sourceBytes,
      ...(stale ? { stale: true } : {}),
      ...extraStatus(),
    }
  }

  /** Русский текст ошибки чтения файла: у fs сообщения технические, а «ENOENT»
   *  в оверлее пользователю ничего не объясняет. */
  function readMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    if (/ENOENT/i.test(message)) return `файл базы не найден: ${sourceFile}`
    if (/EACCES|EPERM/i.test(message)) return 'нет прав на чтение файла базы'
    return `не удалось прочитать базу штрихов: ${message}`
  }

  /** Пересобрать индекс из локального db.json. `force` собирает заново, даже
   *  если файл с прошлой сборки не менялся. */
  async function update(force: boolean): Promise<BarcodeDbStatus> {
    const previous = readMeta()
    status = { state: 'building', stage: 'read' }
    try {
      if (!existsSync(sourceFile)) throw new Error(`файл базы не найден: ${sourceFile}`)
      const currentMtime = mtimeOf(sourceFile)
      if (!force && previous && currentMtime > 0 && currentMtime <= previous.sourceMtime) {
        // Файл с прошлой сборки — тот же самый: только освежаем метку времени,
        // чтобы не гонять разбор 116 МБ впустую по кнопке «Обновить базу».
        const fresh = writeMeta({ ...previous, builtAt: Date.now() })
        console.log('[barcode-db] база не менялась, индекс прежний')
        status = { state: 'ready', items: fresh.items, updatedAt: fresh.builtAt, sourceBytes: fresh.sourceBytes, ...extraStatus() }
        return status
      }

      const bytes: Uint8Array = readFileSync(sourceFile)
      status = { state: 'building', stage: 'index' }
      // db.json — одна строка на 116 МБ без переводов строк, поэтому строчный
      // разбор невозможен, а полный JSON.parse поднимает RSS process'а до 559 МБ
      // (замерено на живом файле: 272 392 позиции). Режем файл объектами и
      // разбираем кусками — выходит 491 МБ, минус 68 МБ. Больше съедает сама
      // строка (116 МБ в UTF-16 = 232 МБ), а не объекты: снять это можно
      // только разбором потоком с диска. Куски не разошлись => откат на
      // JSON.parse: печатать половину базы молча нельзя.
      const unpacked = unpackDbJson(bytes)
      const built = parseDbJsonText(unpacked) ?? buildIndexText(JSON.parse(unpacked))

      mkdirSync(dir, { recursive: true })
      // Пишем во временный файл и переименовываем: прерванная сборка
      // иначе оставила бы после себя обрезанный index.txt, и вся следующая
      // печать молча потеряла бы позиции после точки обрыва.
      const tmp = `${indexFile}.tmp`
      writeFileSync(tmp, built.text, 'utf8')
      renameSync(tmp, indexFile)
      const meta = writeMeta({
        builtAt: Date.now(),
        items: built.items,
        sourceBytes: bytes.byteLength,
        sourceMtime: currentMtime,
      })
      console.log(
        `[barcode-db] индекс готов: ${built.items} позиций, пропущено ${built.skipped}, ` +
          `db.json ${bytes.byteLength} байт`,
      )
      status = { state: 'ready', items: meta.items, updatedAt: meta.builtAt, sourceBytes: meta.sourceBytes, ...extraStatus() }
      return status
    } catch (err) {
      const error = readMessage(err)
      console.warn('[barcode-db] собрать базу не удалось:', err)
      // Прежний индекс лучше, чем ничего: печать продолжится по нему, а
      // оверлей покажет, что база не самая свежая.
      const onDisk = readStatusFromDisk()
      if (onDisk.state === 'ready') {
        status = { ...onDisk, stale: true, error }
        return status
      }
      status = { state: 'error', error }
      return status
    } finally {
      try {
        if (existsSync(`${indexFile}.tmp`)) unlinkSync(`${indexFile}.tmp`)
      } catch {
        // временный файл мог убрать следующая сборка
      }
    }
  }

  function writeMeta(meta: DbMeta): DbMeta {
    mkdirSync(dir, { recursive: true })
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
    return meta
  }

  async function run(force: boolean): Promise<BarcodeDbStatus> {
    // Двойной клик «Обновить» не должен запускать вторую сборку: обе
    // писали бы в один и тот же index.tmp.
    if (running) return running
    running = update(force).finally(() => {
      running = null
    })
    return running
  }

  async function ensure(): Promise<BarcodeDbStatus> {
    const onDisk = readStatusFromDisk()
    if (onDisk.state === 'ready' && !onDisk.stale) return onDisk
    return run(false)
  }

  async function reload(): Promise<BarcodeDbStatus> {
    // Файл базы не меняется сам собой, поэтому «обновить» = пересобрать, если
    // он новее индекса (или индекса нет); сборка того же самого файла впустую
    // стоила бы десятков секунд разбора 116 МБ.
    return run(false)
  }

  function lookup(skus: readonly string[]): BarcodeDbLookup {
    const wanted = (Array.isArray(skus) ? skus : []).map((sku) => String(sku).trim()).filter(Boolean)
    if (wanted.length === 0) return { items: [], missing: [] }

    const need = new Set(wanted)
    const found = new Map<string, BarcodeItem>()
    if (existsSync(indexFile)) {
      try {
        // Файл целиком: 15 МБ читается за десятки миллисекунд, и постоянно
        // держать его в памяти ради одного поиска смысла нет.
        const text = readFileSync(indexFile, 'utf8')
        for (const line of text.split('\n')) {
          if (!line) continue
          const row = parseIndexLine(line)
          if (!row || !need.has(row.sku)) continue
          const item = barcodeItem(row)
          if (item) found.set(row.sku, item)
        }
      } catch (err) {
        // База может быть ещё не собрана — тогда найдут приложенные позиции.
        console.warn('[barcode-db] индекс не прочитан:', err)
      }
    }
    // Приложенные позиции перекрывают базу: файл, который пользователь сам
    // принёс приложить, — это его источник правды о своих штрихах.
    for (const row of readExtra().rows) {
      if (!need.has(row.sku)) continue
      const item = barcodeItem(row)
      if (item) found.set(row.sku, item)
    }

    const items: BarcodeItem[] = []
    const missing: string[] = []
    for (const sku of wanted) {
      const item = found.get(sku)
      if (item) items.push(item)
      else missing.push(sku)
    }
    return { items, missing }
  }

  /** Штрих базы по позициям файла: `артикул → штрих из индекса`, и только по
   *  тем артикулам, что есть в файле. Один проход по индексу (~50 мс): важен
   *  не сам факт «есть ли позиция в базе», а какой в ней штрих — одинаковый
   *  хранить второй раз незачем, а другой надо хранить, иначе файл
   *  пользователя перестанет быть источником правды о своих штрихах. */
  function baseBarcodes(rows: readonly DbRow[]): Map<string, string> {
    const found = new Map<string, string>()
    if (!existsSync(indexFile) || rows.length === 0) return found
    const need = new Set(rows.map((row) => row.sku))
    try {
      for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
        if (!line) continue
        const end = line.indexOf(INDEX_FIELD_SEP)
        if (end <= 0) continue
        const sku = line.slice(0, end)
        if (!need.has(sku) || found.has(sku)) continue
        const barcode = line.slice(end + 1).split(INDEX_FIELD_SEP)[0].trim()
        if (barcode) found.set(sku, barcode)
      }
    } catch (err) {
      console.warn('[barcode-db] индекс не прочитан при приложении файла:', err)
      return found
    }
    return found
  }

  /** Файл пользователя → позиции. Формат определяем по сигнатуре: xlsx —
   *  zip (PK), db.json — gzip (1F 8B) либо JSON-массив с «Код товара». */
  function readImportRows(data: Buffer): MergeOutcome {
    const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b
    if (isZip) return rowsFromSheet(readSheetRows(data))
    // Тот же разбор, что у основной базы: чужой db.json на 116 МБ полным
    // JSON.parse поднял бы RSS процесса до 559 МБ.
    const text = unpackDbJson(new Uint8Array(data))
    if (!text.trimStart().startsWith('[')) {
      throw new Error('файл не похож ни на таблицу xlsx, ни на базу db.json (ожидался список позиций)')
    }
    const built = parseDbJsonText(text) ?? buildIndexText(JSON.parse(text))
    return rowsFromIndexText(built.text)
  }

  /** Приложить позиции из файла пользователя.
   *
   *  Индекс базы при этом НЕ пересобирается: приложенные позиции лежат
   *  отдельным файлом и накладываются на индекс при поиске. Поэтому импорт
   *  занимает миллисекунды, а не десятки секунд разбора 116 МБ, и новые
   *  позиции находятся сразу — и в оверлее, и в «ШК по артикулу» гостя. */
  function importFile(filePath: string): BarcodeImportResult {
    const path = typeof filePath === 'string' ? filePath.trim() : ''
    const source = path ? basename(path) : ''
    const fail = (error: string): BarcodeImportResult => {
      const payload = readExtra()
      return {
        ok: false,
        added: 0,
        updated: 0,
        inBase: 0,
        skipped: 0,
        total: payload.rows.length,
        source,
        items: [],
        baseSkus: [],
        error,
        status: status.state === 'building' ? status : readStatusFromDisk(),
      }
    }
    if (!path) return fail('файл не выбран')

    let data: Buffer
    try {
      data = readFileSync(path)
    } catch (err) {
      // Свои сообщения, а не readMessage(): тот при ENOENT подставил бы путь
      // к db.json приложения, а пропавший здесь файл — это файл пользователя.
      const message = err instanceof Error ? err.message : String(err)
      if (/ENOENT/i.test(message)) return fail('файл не найден — он мог быть перемещён или удалён после выбора')
      if (/EACCES|EPERM/i.test(message)) return fail('нет прав на чтение файла')
      return fail(`не удалось прочитать файл: ${message}`)
    }
    if (data.length === 0) return fail('файл пустой')
    if (data.length > MAX_IMPORT_BYTES) {
      return fail(`файл ${Math.round(data.length / 1024 / 1024)} МБ — это не дополнение, приложите только новые позиции`)
    }

    let incoming: MergeOutcome
    try {
      incoming = readImportRows(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail(message)
    }
    if (incoming.rows.length === 0) {
      return fail(
        incoming.skipped > 0
          ? `в файле нет ни одной позиции с кодом товара и печатным штрих-кодом (строк пропущено: ${incoming.skipped})`
          : 'в файле нет ни одной позиции с кодом товара и печатным штрих-кодом',
      )
    }
    if (incoming.rows.length > EXTRA_LIMIT) {
      return fail(`в файле ${incoming.rows.length} позиций — это чужая база целиком, приложите только новые`)
    }

    const current = readExtra()
    // Что база уже знает о позициях файла — по строкам ФАЙЛА, а не по всему
    // накопленному: оверлей показывает «уже есть в базе», и «они» — это позиции,
    // которые принёс файл. Иначе повторное приложение того же файла показывало бы
    // всё приложенное за всю историю, и цифра пугала бы без причины.
    const base = partitionAgainstBase(incoming.rows, baseBarcodes(incoming.rows))
    // Позиции, что база уже знает с тем же штрихом, в extra.json не кладём:
    // поиск отдаст из индекса ровно то же значение. С ДРУГИМ штрихом — кладём,
    // там файл пользователя главнее базы.
    const merged = mergeRows(current.rows, base.store)
    // Пишем атомарно (temp+rename): прерванная запись иначе оставила бы
    // обрезанный extra.json и молча уронила бы все приложенные позиции.
    writeJsonAtomic(extraFile, {
      version: EXTRA_VERSION,
      updatedAt: Date.now(),
      source,
      rows: merged.rows,
    })
    status = readStatusFromDisk()
    console.log(
      `[barcode-db] приложено из «${source}»: +${merged.added}, перекрыто ${merged.updated}, ` +
        `совпало с базой ${base.same.length}, штрих перекрыл базу ${base.different.length}, ` +
        `всего своих ${merged.rows.length}, позиций файла ${incoming.rows.length}, ` +
        `пропущено строк ${incoming.skipped + merged.skipped}`,
    )
    // Позиции из файла отдаём списком: оверлей покажет их в блоке и напечатает
    // без вбивания артикулов. Ровно те, что принёс файл, а не всё накопленное,
    // — иначе повторное приложение того же файла снова рисовало бы всю историю.
    const items: BarcodeItem[] = []
    for (const row of incoming.rows) {
      const item = barcodeItem(row)
      if (item) items.push(item)
    }
    return {
      ok: true,
      added: merged.added,
      updated: merged.updated,
      inBase: base.different.length,
      baseSkus: base.same,
      skipped: incoming.skipped + merged.skipped,
      total: merged.rows.length,
      source,
      items,
      status,
    }
  }

  // Статус на старте — с диска, чтобы оверлей сразу показал «272 392 позиции,
  // обновлено вчера», а не пустоту до первого запроса.
  status = readStatusFromDisk()

  return { status: () => status, ensure, reload, lookup, importFile }
}