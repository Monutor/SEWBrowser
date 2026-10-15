/** Локальная база штрих-кодов для печати: чтение db.json с диска, сборка
 *  построчного индекса и поиск позиций по SKU.
 *
 *  Зачем в main, а не в плагине гостя: страница SEW может не открыться вовсе
 *  (гость не нужен для печати штрихов), а вместе с ней и плагин sew-helper с
 *  загруженной базой — а лист печатать надо. Да и сам db.json весит 11 МБ в
 *  gzip и 116 МБ в развёрнутом виде: держать его в гостях ради одного поля
 *  «ШК по артикулу» незачем.
 *
 *  Формат индекса на диске — построчный `SKU⇥ШК⇥Наименование` (15 МБ против
 *  116 МБ у db.json). Разбор построчный: обрезанный при аварийном выключении
 *  файл стоит одну позицию, а не весь лист. */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { barcodeItem, parseIndexLine, type BarcodeItem } from '../shared/barcode-print-core'
import { buildIndexText, parseDbJsonText, unpackDbJson } from './barcode-db-core'
import { getDatabaseFile } from './database-paths'

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
}

export interface BarcodeDbLookup {
  /** Позиции в порядке запрошенных SKU, без повторов. */
  items: BarcodeItem[]
  /** SKU, которых в базе нет. */
  missing: string[]
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
}

interface DbMeta {
  builtAt: number
  items: number
  sourceBytes: number
  /** mtime db.json на момент сборки — по нему решаем, устарел ли индекс. */
  sourceMtime: number
}

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

  /** Статус по файлам на диске — вызывается до любой сборки, поэтому
   *  переживает перезапуск приложения без поднятия базы заново. */
  function readStatusFromDisk(): BarcodeDbStatus {
    if (!existsSync(indexFile)) return { state: 'empty' }
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
        status = { state: 'ready', items: fresh.items, updatedAt: fresh.builtAt, sourceBytes: fresh.sourceBytes }
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
      status = { state: 'ready', items: meta.items, updatedAt: meta.builtAt, sourceBytes: meta.sourceBytes }
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
    if (!existsSync(indexFile)) return { items: [], missing: [...wanted] }

    const need = new Set(wanted)
    const found = new Map<string, BarcodeItem>()
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
      console.warn('[barcode-db] индекс не прочитан:', err)
      return { items: [], missing: [...wanted] }
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

  // Статус на старте — с диска, чтобы оверлей сразу показал «272 392 позиции,
  // обновлено вчера», а не пустоту до первого запроса.
  status = readStatusFromDisk()

  return { status: () => status, ensure, reload, lookup }
}