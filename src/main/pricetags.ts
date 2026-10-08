/** Оркестрация фичи «Ценники» в main: профиль магазина, поиск позиций,
 *  задание печати SEW, ожидание HTML рендера и превращение его в PDF.
 *  Сеть SEW — через общий клиент sew-api, окно просмотра и печать приходят
 *  инъекцией; единственная прямая зависимость от Electron — системный диалог
 *  сохранения PDF. */
import { unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
  sewContentError,
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

export interface PricetagsDeps {
  api: SewApi
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
  disposePdf(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Итог опроса рендера: либо готовое HTML, либо причина, по которой не дождались.
 *  Ошибка приходит именно «ответом», а не исключением: SEW отдаёт JSON-конверт с
 *  HTTP 200, и бросать его мимо `describeError` нельзя — тот без `status`
 *  объявил бы сеть недоступной. */
type ContentOutcome = { ok: true; html: string } | { ok: false; error: string }

function statusOf(err: unknown): number {
  const status = isRecord(err) ? err.status : undefined
  return typeof status === 'number' ? status : 0
}

/** Текст ошибки наружу: 401/403 — по-русски из общего словаря, сеть — её текст. */
function describeError(err: unknown, subject: string): string {
  const message = isRecord(err) && typeof err.message === 'string' ? err.message : ''
  if (message.startsWith('вкладка SEW не найдена')) return message
  if (message.startsWith('рендер HTML в PDF не успел')) return 'Рендер HTML в PDF не успел'
  if (message.startsWith('страница не загрузилась')) return `Рендер ценников не удался: ${message}`
  const status = statusOf(err)
  // Тело отказа, если клиент его сохранил: показываем текст SEW, а не догадку.
  const body = isRecord(err) && typeof err.body === 'string' ? err.body : undefined
  if (status) return sewErrorMessage(status, subject, body)
  return `SEW недоступен: ${message || String(err)}`
}

export function createPricetags(deps: PricetagsDeps): PricetagsService {
  /** Последний собранный PDF: файл нужен «Сохранить»/«Печать» и после закрытия
   *  оверлея, поэтому он не привязан к окну просмотрщика. */
  let lastPdf: { path: string; title: string } | null = null

  /** Магазин, под который последний раз искали позиции. Цена в PrepareItem
   *  зафиксирована на момент поиска, поэтому «Собрать PDF» обязано печатать их
   *  в том же магазине — иначе ценники магазина A ушли бы в печать под B. */
  let preparedShop = ''

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
      // Привязываем позиции к магазину только на успехе: после неудачного поиска
      // в оверлее остаются прежние позиции, и они остаются привязаны к прежнему
      // магазину — build() не должен рубить сборку.
      preparedShop = shop
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: describeError(err, 'ценники') }
    }
  }

  /** Отменяет задание: при сбое или таймауте «напечатано» засчитывать нельзя. */
  async function cancelTask(printTaskId: string): Promise<void> {
    try {
      await deps.api.post(`${TASK_PATH}/cancel/${printTaskId}`, {})
    } catch {
      // задание могло закрыться само — исход не меняет
    }
  }

  /** Закрывает задание как «напечатано». Отказ не фатален: PDF к этому моменту
   *  уже у пользователя, а задание без finish просто остаётся открытым в SEW. */
  async function finishTask(printTaskId: string): Promise<void> {
    try {
      await deps.api.post(`${FINISH_PATH}/${printTaskId}`, {})
    } catch (err) {
      console.warn('[pricetags] SEW не принял закрытие задания печати:', err)
    }
  }

  /** Забирает HTML ценников: рендер в SEW асинхронный, поэтому опрашиваем с
   *  растущей паузой до RENDER_TIMEOUT_MS. */
  async function fetchContent(printTaskId: string): Promise<ContentOutcome> {
    const deadline = Date.now() + RENDER_TIMEOUT_MS
    let attempt = 0
    let html = ''
    while (Date.now() < deadline) {
      await delay(RENDER_BACKOFF_MS[Math.min(attempt, RENDER_BACKOFF_MS.length - 1)])
      attempt += 1
      try {
        html = await deps.api.text(`${CONTENT_PATH}/${printTaskId}?type=`)
      } catch (err) {
        // 401/403 посреди опроса — протухшая сессия или нет прав, а не «рендер не
        // готов»: молчаливый retry довёл бы опрос до 60 с и отдал бы
        // пользователю неверный текст вместо русского объяснения.
        const status = statusOf(err)
        if (status === 401 || status === 403) throw err
        html = ''
      }
      if (html.includes('price-tag')) return { ok: true, html }
      // Отказ SEW приходит JSON-конвертом с HTTP 200: он не бросается и не
      // содержит 'price-tag', поэтому раньше опрос молчал до таймаута, и
      // пользователь получал «Рендер ценников не успел» вместо причины.
      const sewError = sewContentError(html)
      if (sewError) return { ok: false, error: `SEW не отдал ценники: ${sewError}` }
    }
    return { ok: false, error: 'Рендер ценников не успел — попробуйте ещё раз' }
  }

  async function build(raw: {
    objectId: unknown
    items: PrepareItem[]
    templateId: number
    paperColorId: number
    copies: number
  }): Promise<PricetagBuildResult> {
    const shop = pickObjectId(raw.objectId)
    // Позиции и их цены принадлежат магазину, под которым их искали. Молча
    // подставлять конфиг здесь нельзя: смена магазина в оверлее между «Найти» и
    // «Собрать PDF» напечатала бы цены чужого магазина.
    if (preparedShop && preparedShop !== shop) {
      return { ok: false, error: 'позиции найдены для другого магазина — нажмите «Найти» ещё раз' }
    }
    const items = (Array.isArray(raw.items) ? raw.items : []).filter(
      (item): item is PrepareItem => isRecord(item) && typeof item.sku === 'string' && item.sku.length > 0,
    )
    if (items.length === 0) return { ok: false, error: 'нет позиций для печати — нажмите «Найти»' }
    if (!isValidTemplateId(raw.templateId)) return { ok: false, error: 'выберите шаблон печати' }
    if (!isValidPaperColorId(raw.paperColorId)) return { ok: false, error: 'выберите цвет бумаги' }
    // Копии вне диапазона — явная ошибка, а не тихая подстановка единицы:
    // пользователь, попросивший 1000 копий, получил бы один ценник и ok:true.
    if (!isValidCopies(raw.copies)) return { ok: false, error: 'сколько копий — от 1 до 999' }

    const input: BuildInput = {
      objectId: shop,
      items,
      templateId: raw.templateId,
      paperColorId: raw.paperColorId,
      copies: raw.copies,
    }

    let printTaskId: string | null = null
    try {
      const created = await deps.api.json(TASK_PATH, { method: 'POST', body: buildPrintTaskBody(input) })
      // Номер задания лежит в конверте SEW (`responseBody`), а не на верхнем
      // уровне: без разворачивания конверта build() всегда падал бы с «не вернул
      // номер», а созданное задание оставалось бы висеть в очереди — отменять
      // его нечем. Верхний уровень оставлен запасным путём на случай смены
      // контракта.
      const createdBody = isRecord(created) && isRecord(created.responseBody) ? created.responseBody : created
      const taskId = isRecord(createdBody) ? createdBody.printTaskId : undefined
      if (typeof taskId !== 'number' && typeof taskId !== 'string') {
        // Номера нет — отменять нечем, задание SEW зависнет в своей очереди.
        return { ok: false, error: 'SEW не вернул номер задания печати' }
      }
      printTaskId = String(taskId)

      const content = await fetchContent(printTaskId)
      if (!content.ok) {
        // Задание закрываем отменой, а не finish: PDF не напечатан, и оставить
        // задание в очереди SEW — значит забыть о нём навсегда.
        await cancelTask(printTaskId)
        printTaskId = null
        return { ok: false, error: content.error }
      }
      const html = content.html

      const pdf = await htmlToPdf(html)
      const name = pricetagFileName(shop, new Date())
      const path = join(tempWorkDir(), name)
      // Старый PDF сносим до записи нового: имя у него точностью до минуты,
      // и повторная сборка в ту же минуту получила бы тот же путь — unlink
      // после записи удалил бы только что созданный файл, и «Сохранить»/«Печать»
      // падали бы с ENOENT.
      disposePdf()
      writeFileSync(path, pdf)
      const title = `Ценники ${shop}`
      lastPdf = { path, title }
      deps.openPdfViewer(pdf, title)
      // Задание закрываем последним шагом: PDF у пользователя уже на экране, и
      // неудача finish не должна ни отбирать результат сборки, ни уводить нас в
      // catch с отменой уже показанного PDF. finishTask не бросает, а номер
      // обнуляется сразу после неё — двойного закрытия не выйдет.
      await finishTask(printTaskId)
      printTaskId = null
      return { ok: true, pdfName: basename(path) }
    } catch (err) {
      if (printTaskId) await cancelTask(printTaskId)
      return { ok: false, error: describeError(err, 'ценники') }
    }
  }

  return { stores, prepare, build, disposePdf }
}