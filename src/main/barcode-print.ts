/** Печать штрихов локально: позиции по SKU из базы db.json → лист A4 → PDF.
 *
 *  SEW здесь не участвует вовсе: единственная внешняя зависимость от Electron —
 *  окно просмотра готового PDF. Это единственный путь печати штрихов после
 *  снятия подсистемы ценников SEW. */
import { unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { htmlToPdf, tempWorkDir } from './html-pdf'
import type { BarcodeDbService, BarcodeDbStatus, BarcodeImportResult } from './barcode-db'
import { barcodeFileName, expandCopies, renderBarcodeSheet, type BarcodeItem } from '../shared/barcode-print-core'

export interface BarcodeLookupResult {
  ok: boolean
  items?: BarcodeItem[]
  missing?: string[]
  status?: BarcodeDbStatus
  error?: string
}

export interface BarcodeBuildResult {
  ok: boolean
  pdfName?: string
  error?: string
}

export interface BarcodePrintDeps {
  db: BarcodeDbService
  openPdfViewer(pdf: Buffer, title: string): void
}

export interface BarcodePrintService {
  status(): BarcodeDbStatus
  ensure(): Promise<BarcodeDbStatus>
  reload(): Promise<BarcodeDbStatus>
  /** Приложить позиции из файла пользователя (xlsx или чужой db.json) к базе. */
  importFile(filePath: string): BarcodeImportResult
  lookup(skus: readonly string[]): Promise<BarcodeLookupResult>
  build(input: { skus: readonly string[]; copies: number }): Promise<BarcodeBuildResult>
  disposePdf(): void
}

function cleanSkus(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const value = String(raw ?? '').trim()
    // SKU SEW — цифры с буквами и дефисом, мусор из соседнего текста в базу
    // не пускаем: иначе пользователь получит «не найдено» на каждый
    // случайный слово из буфера обмена.
    if (!value || !/^[\w-]*\d[\w-]*$/.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function createBarcodePrint(deps: BarcodePrintDeps): BarcodePrintService {
  let lastPdf: string | null = null

  function disposePdf(): void {
    if (!lastPdf) return
    try {
      unlinkSync(lastPdf)
    } catch {
      // уже удалён
    }
    lastPdf = null
  }

  async function ensure(): Promise<BarcodeDbStatus> {
    const status = await deps.db.ensure()
    return status
  }

  async function lookup(input: unknown): Promise<BarcodeLookupResult> {
    const skus = cleanSkus(input)
    if (skus.length === 0) return { ok: false, error: 'введите хотя бы один код товара' }
    const status = await deps.db.ensure()
    if (status.state !== 'ready') {
      return { ok: false, error: status.error ?? 'база штрихов недоступна', status }
    }
    const found = deps.db.lookup(skus)
    if (found.items.length === 0) {
      return { ok: false, error: 'ни один код не найден в базе штрихов', status }
    }
    return { ok: true, items: found.items, missing: found.missing, status }
  }

  async function build(input: { skus: readonly string[]; copies: number }): Promise<BarcodeBuildResult> {
    const skus = cleanSkus(input?.skus)
    if (skus.length === 0) return { ok: false, error: 'введите хотя бы один код товара' }
    const copies = input?.copies
    const status = await deps.db.ensure()
    if (status.state !== 'ready') {
      return { ok: false, error: status.error ?? 'база штрихов недоступна' }
    }

    const found = deps.db.lookup(skus)
    if (found.items.length === 0) return { ok: false, error: 'ни один код не найден в базе штрихов' }
    const expanded = expandCopies(found.items, copies)
    if (!expanded) {
      const total = found.items.length * (typeof copies === 'number' && Number.isInteger(copies) ? copies : 0)
      return {
        ok: false,
        error: total > 0 ? `слишком много этикеток: ${total}` : 'сколько копий — целое число от 1',
      }
    }

    try {
      const html = renderBarcodeSheet(expanded, { title: `Штрихи: ${expanded.length} шт.` })
      const pdf = await htmlToPdf(html)
      const path = join(tempWorkDir(), barcodeFileName(new Date()))
      // Старый PDF сносим ДО записи нового: имя у него точностью до минуты,
      // и повторная печать в ту же минуту получила бы тот же путь — unlink
      // после записи удалил бы только что созданный файл.
      disposePdf()
      writeFileSync(path, pdf)
      lastPdf = path
      deps.openPdfViewer(pdf, 'Штрихи')
      return { ok: true, pdfName: basename(path) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('рендер HTML в PDF не успел')) return { ok: false, error: 'рендер листа в PDF не успел' }
      if (message.startsWith('страница не загрузилась')) return { ok: false, error: `рендер листа не удался: ${message}` }
      console.warn('[barcodes] печать не удалась:', err)
      return { ok: false, error: `не удалось собрать PDF: ${message}` }
    }
  }

  return {
    status: () => deps.db.status(),
    ensure,
    reload: () => deps.db.reload(),
    importFile: (filePath) => deps.db.importFile(filePath),
    lookup,
    build,
    disposePdf,
  }
}