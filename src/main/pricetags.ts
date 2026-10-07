/** Оркестрация фичи «Ценники» в main: профиль магазина, поиск позиций,
 *  задание печати SEW, ожидание HTML рендера и превращение его в PDF.
 *  Сеть SEW — через общий клиент sew-api, окно просмотра и печать приходят
 *  инъекцией; единственная прямая зависимость от Electron — системный диалог
 *  сохранения PDF. */
import { dialog } from 'electron'
import { copyFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { htmlToPdf, tempWorkDir } from './html-pdf'
import { isValidObjectId } from './downloads/stockReport'
import type { SewApi } from './sew-api'
import {
  RENDER_BACKOFF_MS,
  RENDER_TIMEOUT_MS,
  buildPrintTaskBody,
  buildSearchBody,
  isValidCopies,
  isValidPaperColorId,
  isValidTemplateId,
  normalizeSearchResponse,
  pricetagFileName,
  sewErrorMessage,
  type BuildInput,
  type PrepareItem,
  type PrepareResult,
  type SewStore,
} from '../shared/pricetags-core'

const SEARCH_PATH = '/api/pricetags-print-tasks/sew/pricetag/search'
const TASK_PATH = '/api/pricetags-print-tasks/sew/print-task'
const FINISH_PATH = '/api/pricetags-print-tasks/sew/print-task/finish'
const CONTENT_PATH = '/api/pricetags-rendering/sew/pricetag-content'
const PROFILE_PATH = '/v2/api/sew/v1/profile'

/** Профиль SEW: магазин по умолчанию плюс номера из `login`. */
interface SewProfile {
  defaultObject?: string
  additionalShopNumbers?: string[]
  displayName?: string
}

export interface PricetagStoresResult {
  ok: boolean
  stores: SewStore[]
  current?: string
  error?: string
}

export interface PricetagPrepareResult {
  ok: boolean
  result?: PrepareResult
  error?: string
}

export interface PricetagBuildResult {
  ok: boolean
  pdfName?: string
  error?: string
}

export interface PricetagSaveResult {
  ok: boolean
  path?: string
  error?: string
}

export interface PricetagPrintResult {
  ok: boolean
  error?: string
}

export interface PricetagsDeps {
  api: SewApi
  /** Сигнатура ровно как в src/main/index.ts:1292 — синхронная, печать уходит
   *  в системный диалог и результата не ждёт. */
  printPdfDocument(fileUrl: string, title: string): void
  openPdfViewer(pdf: Buffer, title: string): void
  fallbackObjectId(): string
}

export interface PricetagsService {
  stores(): Promise<PricetagStoresResult>
  prepare(objectId: unknown, skus: readonly string[]): Promise<PricetagPrepareResult>
  build(input: {
    objectId: unknown
    items: PrepareItem[]
    templateId: number
    paperColorId: number
    copies: number
  }): Promise<PricetagBuildResult>
  save(): Promise<PricetagSaveResult>
  print(): PricetagPrintResult
  disposePdf(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function statusOf(err: unknown): number {
  const status = isRecord(err) ? err.status : undefined
  return typeof status === 'number' ? status : 0
}

/** Текст ошибки наружу: 401/403 — по-русски из общего словаря, сеть — её текст. */
function describeError(err: unknown, subject: string): string {
  const message = isRecord(err) && typeof err.message === 'string' ? err.message : ''
  if (message.startsWith('Bearer SEW не найден')) return message
  if (message.startsWith('рендер HTML в PDF не успел')) return 'Рендер HTML в PDF не успел'
  if (message.startsWith('страница не загрузилась')) return `Рендер ценников не удался: ${message}`
  const status = statusOf(err)
  if (status) return sewErrorMessage(status, subject)
  return `SEW недоступен: ${message || String(err)}`
}

export function createPricetags(deps: PricetagsDeps): PricetagsService {
  /** Последний собранный PDF: файл нужен «Сохранить»/«Печать» и после закрытия
   *  оверлея, поэтому он не привязан к окну просмотрщика. */
  let lastPdf: { path: string; title: string } | null = null

  function disposePdf(): void {
    if (!lastPdf) return
    try {
      unlinkSync(lastPdf.path)
    } catch {
      // уже удалён
    }
    lastPdf = null
  }

  function pickObjectId(value: unknown): string {
    return isValidObjectId(value) ? value : deps.fallbackObjectId()
  }

  async function stores(): Promise<PricetagStoresResult> {
    try {
      const json = await deps.api.json(PROFILE_PATH)
      const profile: SewProfile = isRecord(json) ? json : {}
      const raw = [profile.defaultObject, ...(Array.isArray(profile.additionalShopNumbers) ? profile.additionalShopNumbers : [])]
      const list: SewStore[] = []
      const seen = new Set<string>()
      for (const value of raw) {
        const id = typeof value === 'string' ? value.trim() : ''
        if (!isValidObjectId(id) || seen.has(id)) continue
        seen.add(id)
        list.push({ id, name: id })
      }
      if (list.length === 0) return { ok: false, stores: [], error: 'у сотрудника нет доступных магазинов' }
      return { ok: true, stores: list, current: list[0].id }
    } catch (err) {
      return { ok: false, stores: [], error: describeError(err, 'список магазинов') }
    }
  }

  async function prepare(objectId: unknown, skus: readonly string[]): Promise<PricetagPrepareResult> {
    const shop = pickObjectId(objectId)
    const wanted = (Array.isArray(skus) ? skus : []).map((s) => String(s).trim()).filter(Boolean)
    if (wanted.length === 0) return { ok: false, error: 'введите хотя бы один артикул' }
    try {
      const json = await deps.api.json(SEARCH_PATH, { method: 'POST', body: buildSearchBody(shop, wanted) })
      const result: PrepareResult = normalizeSearchResponse(json, wanted)
      if (result.items.length === 0) {
        return { ok: false, error: result.warning ?? `ни один артикул не найден в магазине ${shop}` }
      }
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: describeError(err, 'ценники') }
    }
  }

  /** Отменяет задание: при сбое или таймауте «напечатано» засчитывать нельзя. */
  async function cancelTask(printTaskId: string): Promise<void> {
    try {
      await deps.api.json(`${TASK_PATH}/cancel/${printTaskId}`, { method: 'POST' })
    } catch {
      // задание могло закрыться само — исход не меняет
    }
  }

  /** Забирает HTML ценников: рендер в SEW асинхронный, поэтому опрашиваем с
   *  растущей паузой до RENDER_TIMEOUT_MS. */
  async function fetchContent(printTaskId: string): Promise<string> {
    const deadline = Date.now() + RENDER_TIMEOUT_MS
    let attempt = 0
    let html = ''
    while (Date.now() < deadline) {
      await delay(RENDER_BACKOFF_MS[Math.min(attempt, RENDER_BACKOFF_MS.length - 1)])
      attempt += 1
      try {
        html = await deps.api.text(`${CONTENT_PATH}/${printTaskId}?type=`)
      } catch {
        html = ''
      }
      if (html.includes('price-tag')) return html
    }
    return ''
  }

  async function build(raw: {
    objectId: unknown
    items: PrepareItem[]
    templateId: number
    paperColorId: number
    copies: number
  }): Promise<PricetagBuildResult> {
    const shop = pickObjectId(raw.objectId)
    const items = (Array.isArray(raw.items) ? raw.items : []).filter(
      (item): item is PrepareItem => isRecord(item) && typeof item.sku === 'string' && item.sku.length > 0,
    )
    if (items.length === 0) return { ok: false, error: 'нет позиций для печати — нажмите «Найти»' }
    if (!isValidTemplateId(raw.templateId)) return { ok: false, error: 'выберите шаблон печати' }
    if (!isValidPaperColorId(raw.paperColorId)) return { ok: false, error: 'выберите цвет бумаги' }

    const input: BuildInput = {
      objectId: shop,
      items,
      templateId: raw.templateId,
      paperColorId: raw.paperColorId,
      copies: isValidCopies(raw.copies) ? raw.copies : 1,
    }

    let printTaskId: string | null = null
    try {
      const created = await deps.api.json(TASK_PATH, { method: 'POST', body: buildPrintTaskBody(input) })
      const taskId = isRecord(created) ? created.printTaskId : undefined
      if (typeof taskId !== 'number' && typeof taskId !== 'string') {
        // Номера нет — отменять нечем, задание SEW зависнет в своей очереди.
        return { ok: false, error: 'SEW не вернул номер задания печати' }
      }
      printTaskId = String(taskId)

      const html = await fetchContent(printTaskId)
      if (!html) {
        await cancelTask(printTaskId)
        printTaskId = null
        return { ok: false, error: 'Рендер ценников не успел — попробуйте ещё раз' }
      }

      const pdf = await htmlToPdf(html)
      const name = pricetagFileName(shop, new Date())
      const path = join(tempWorkDir(), name)
      // Задание закрываем как «напечатано» (решение из спеки): пользователь
      // получил PDF и печатает его у себя.
      await deps.api.json(`${FINISH_PATH}/${printTaskId}`, { method: 'POST', body: {} })
      printTaskId = null

      // Старый PDF сносим до записи нового: имя у него точностью до минуты,
      // и повторная сборка в ту же минуту получила бы тот же путь — unlink
      // после записи удалил бы только что созданный файл, и «Сохранить»/«Печать»
      // падали бы с ENOENT.
      disposePdf()
      writeFileSync(path, pdf)
      const title = `Ценники ${shop}`
      lastPdf = { path, title }
      deps.openPdfViewer(pdf, title)
      return { ok: true, pdfName: basename(path) }
    } catch (err) {
      if (printTaskId) await cancelTask(printTaskId)
      return { ok: false, error: describeError(err, 'ценники') }
    }
  }

  async function save(): Promise<PricetagSaveResult> {
    if (!lastPdf) return { ok: false, error: 'сначала соберите PDF' }
    let filePath = ''
    try {
      // Диалог сам по себе может бросить (нет BrowserWindow, приложение
      // закрывается) — иначе отказ ушёл бы в renderer исключением, а не
      // русским текстом в error.
      const res = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', lastPdf.title + '.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      filePath = res.canceled ? '' : res.filePath ?? ''
    } catch (err) {
      return { ok: false, error: `не удалось открыть диалог сохранения: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!filePath) return { ok: false, error: 'сохранение отменено' }
    try {
      copyFileSync(lastPdf.path, filePath)
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: `не удалось сохранить: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  function print(): PricetagPrintResult {
    if (!lastPdf) return { ok: false, error: 'сначала соберите PDF' }
    try {
      // printPdfDocument ждёт file-URL (он же отсекает чужие did-finish-load по 'file:')
      // и возвращает void: печать уходит в системный диалог, результата не ждём.
      // Ссылку собирает pathToFileURL: в имени файла есть пробелы и кириллица,
      // и голая склейка отдала бы loadURL строку без экранирования.
      deps.printPdfDocument(pathToFileURL(lastPdf.path).toString(), lastPdf.title)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `не удалось напечатать: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { stores, prepare, build, save, print, disposePdf }
}