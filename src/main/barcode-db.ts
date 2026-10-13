/** Локальная база штрих-кодов для печати: скачивание db.json, сборка
 *  построчного индекса и поиск позиций по SKU.
 *
 *  Зачем в main, а не в плагине гостя: штрихи печатаются, когда подсистема
 *  ценников SEW лежит (503), и страница SEW может не открыться вовсе — гостя
 *  за вкладкой не будет, а с ним и плагин sew-helper с загруженной базой.
 *
 *  Формат на диске — построчный `SKU⇥ШК⇥Наименование` (15 МБ против 179 МБ
 *  у db.json). Разбор построчный: обрезанный при аварийном выключении файл
 *  стоит одну позицию, а не весь лист. */
import { app, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { barcodeItem, parseIndexLine, type BarcodeItem } from '../shared/barcode-print-core'
import { buildIndexText, parseDbJsonText, unpackDbJson } from './barcode-db-core'

/** Тот же файл, что грузит плагин sew-helper в госте (db-loader.js). */
export const DB_URL = 'https://raw.githubusercontent.com/Monutor/DataBaseProducts/main/db.json'

/** Через сколько индекс считается устаревшим. Базу пользователь обновляет
 *  вручную (редко), но и 11 МБ качать при каждом запуске нельзя. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

const DOWNLOAD_TIMEOUT_MS = 120_000

export interface BarcodeDbStatus {
  /** empty — индекса ещё нет; building — идёт обновление; ready — можно печатать;
   *  error — обновиться не вышло и печатать нечем. */
  state: 'empty' | 'building' | 'ready' | 'error'
  /** Что именно сейчас делает обновление — для текста в оверлее. */
  stage?: 'download' | 'index'
  /** Сколько позиций в индексе. */
  items?: number
  /** Когда индекс построен (мс, 0 — неизвестно). */
  updatedAt?: number
  /** Размер скачанного db.json в байтах. */
  sourceBytes?: number
  error?: string
  /** Индекс старше TTL, но печатать можно. Печать важнее свежести. */
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
  /** Догрузить/обновить, если индекс пуст или протух. Из статуса `error`
   *  вызывать смысла нет — есть `reload()`. */
  ensure(): Promise<BarcodeDbStatus>
  /** Обновить принудительно (кнопка «Обновить базу»). */
  reload(): Promise<BarcodeDbStatus>
  /** Позиции по списку SKU. */
  lookup(skus: readonly string[]): BarcodeDbLookup
}

interface DbMeta {
  url: string
  etag: string
  builtAt: number
  items: number
  sourceBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createBarcodeDb(): BarcodeDbService {
  const dir = join(app.getPath('userData'), 'barcode-db')
  const indexFile = join(dir, 'index.txt')
  const metaFile = join(dir, 'meta.json')

  let status: BarcodeDbStatus = { state: 'empty' }
  let running: Promise<BarcodeDbStatus> | null = null

  function readMeta(): DbMeta | null {
    try {
      const raw = JSON.parse(readFileSync(metaFile, 'utf8'))
      if (!isRecord(raw)) return null
      return {
        url: typeof raw.url === 'string' ? raw.url : '',
        etag: typeof raw.etag === 'string' ? raw.etag : '',
        builtAt: typeof raw.builtAt === 'number' ? raw.builtAt : 0,
        items: typeof raw.items === 'number' ? raw.items : 0,
        sourceBytes: typeof raw.sourceBytes === 'number' ? raw.sourceBytes : 0,
      }
    } catch {
      return null
    }
  }

  /** Статус по файлам на диске — вызывается до любой загрузки, поэтому
   *  переживает перезапуск приложения без поднятия базы заново. */
  function readStatusFromDisk(): BarcodeDbStatus {
    if (!existsSync(indexFile)) return { state: 'empty' }
    const meta = readMeta()
    const items = meta?.items ?? 0
    const updatedAt = meta?.builtAt ?? 0
    const stale = updatedAt > 0 ? Date.now() - updatedAt > STALE_AFTER_MS : true
    return {
      state: 'ready',
      items,
      updatedAt,
      sourceBytes: meta?.sourceBytes,
      ...(stale ? { stale: true } : {}),
    }
  }

  /** Русский текст сети: у net.fetch нет внятных сообщений, а «Не удалось
   *  получить данные» в оверлее бесполезен. */
  function networkMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    if (/timeout|aborted/i.test(message)) return 'сервер не ответил — попробуйте позже'
    if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'нет связи с интернетом'
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(message)) return 'соединение с GitHub прервалось'
    return `не удалось скачать базу штрихов: ${message}`
  }

  /** Скачать db.json и пересобрать индекс. `force` игнорирует ETag. */
  async function update(force: boolean): Promise<BarcodeDbStatus> {
    const previous = readMeta()
    status = { state: 'building', stage: 'download' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      let bytes: Uint8Array
      let notModified = false
      try {
        const response = await net.fetch(DB_URL, {
          signal: controller.signal,
          headers: previous && !force && previous.etag ? { 'If-None-Match': previous.etag } : undefined,
        })
        if (response.status === 304 && previous) {
          notModified = true
          bytes = new Uint8Array(0)
        } else {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          bytes = new Uint8Array(await response.arrayBuffer())
        }
      } finally {
        clearTimeout(timer)
      }

      if (notModified && previous) {
        // Файл на диске прежний и он же последний на сервере: только
        // освежаем метку времени, чтобы индекс не считался протухшим.
        const fresh = writeMeta({ ...previous, builtAt: Date.now() })
        status = { state: 'ready', items: fresh.items, updatedAt: fresh.builtAt, sourceBytes: fresh.sourceBytes }
        return status
      }
      if (notModified) throw new Error('сервер ответил «не изменено», а индекса у нас нет')

      status = { state: 'building', stage: 'index' }
      // db.json — одна строка на 179 МБ без переводов строк, поэтому строчный
      // разбор невозможен, а полный JSON.parse поднимает RSS process'а до 559 МБ
      // (замерено на живом файле: 272 392 позиции). Режем файл объектами и
      // разбираем кусками — выходит 491 МБ, минус 68 МБ. Больше съедает сама
      // строка (179 МБ в UTF-16 = 358 МБ), а не объекты: снять это можно
      // только разбором потоком с диска. Куски не разошлись => откат на
      // JSON.parse: печатать половину базы молча нельзя.
      const unpacked = unpackDbJson(bytes)
      const built = parseDbJsonText(unpacked) ?? buildIndexText(JSON.parse(unpacked))

      mkdirSync(dir, { recursive: true })
      // Пишем во временный файл и переименовываем: прерванное обновление
      // иначе оставило бы после себя обрезанный index.txt, и вся следующая
      // печать молча потеряла бы позиции после точки обрыва.
      const tmp = `${indexFile}.tmp`
      writeFileSync(tmp, built.text, 'utf8')
      renameSync(tmp, indexFile)
      const meta = writeMeta({
        url: DB_URL,
        etag: '',
        builtAt: Date.now(),
        items: built.items,
        sourceBytes: bytes.byteLength,
      })
      console.log(`[barcode-db] индекс готов: ${built.items} позиций, пропущено ${built.skipped}, db.json ${bytes.byteLength} байт`)
      status = { state: 'ready', items: meta.items, updatedAt: meta.builtAt, sourceBytes: meta.sourceBytes }
      return status
    } catch (err) {
      const error = networkMessage(err)
      console.warn('[barcode-db] обновление не удалось:', err)
      // Устаревший индекс лучше, чем ничего: печать продолжится по нему, а
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
    // Двойной клик «Обновить» не должен запускать вторую загрузку: обе
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
    // Прежний ETag с If-None-Match — дешёвый путь: сервер ответит 304, если
    // база не менялась, и мы не будем качать 11 МБ и разбирать 179 МБ впустую.
    return run(true)
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