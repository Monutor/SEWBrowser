/** Дефолты настроек печати: A4, книжная, поля как в Windows (20/20/10/10 мм) */
const DEFAULTS: PrintSettings = {
  destination: 'pdf',
  deviceName: '',
  rangeMode: 'all',
  rangeFrom: 1,
  rangeTo: 1,
  copies: 1,
  landscape: false,
  pageSize: 'A4',
  marginTop: 20,
  marginBottom: 20,
  marginLeft: 10,
  marginRight: 10,
  scale: 100,
  printBackground: false,
  displayHeaderFooter: false,
}

/** Размеры бумаги, которые понимает webview.print: A6 в списке принтера отсутствует */
export const PRINT_PAPER_NAMES: readonly PrintPaperName[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid']

/** Все размеры бумаги, которые хранить можно: список принтера плюс A6,
 *  который понимает только printToPDF. Список один — чтобы A6 не «потерялся» */
const PAGE_SIZES: readonly PrintPageSizeName[] = [...PRINT_PAPER_NAMES, 'A6']

/** Число ли значение по сути. Числа и числовые строки берём как есть, остальное
 *  (null, '', '  ', false, [], {}) — в NaN. Иначе Number() молча превратит мусор
 *  в 0, а 0 проходит проверку диапазона полей (0..50 мм) и вместо дефолта
 *  в настройки попадёт поле 0 мм. */
function toNumber(x: unknown): number {
  if (typeof x === 'number') return x
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** Привести любой мусор из config.json к валидным настройкам */
export function normalizePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  const v = raw as Record<string, unknown>
  const int = (x: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.floor(toNumber(x))
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const mm = (x: unknown, fallback: number): number => {
    const n = Math.round(toNumber(x) * 100) / 100
    return Number.isFinite(n) && n >= 0 && n <= 50 ? n : fallback
  }
  const size = typeof v.pageSize === 'string' && PAGE_SIZES.includes(v.pageSize as PrintPageSizeName) ? (v.pageSize as PrintPageSizeName) : DEFAULTS.pageSize
  return {
    destination: v.destination === 'printer' ? 'printer' : DEFAULTS.destination,
    deviceName: typeof v.deviceName === 'string' ? v.deviceName : DEFAULTS.deviceName,
    rangeMode: v.rangeMode === 'current' || v.rangeMode === 'custom' ? v.rangeMode : DEFAULTS.rangeMode,
    rangeFrom: int(v.rangeFrom, 1, 100000, DEFAULTS.rangeFrom),
    rangeTo: int(v.rangeTo, 1, 100000, DEFAULTS.rangeTo),
    copies: int(v.copies, 1, 99, DEFAULTS.copies),
    landscape: v.landscape === true,
    pageSize: size,
    marginTop: mm(v.marginTop, DEFAULTS.marginTop),
    marginBottom: mm(v.marginBottom, DEFAULTS.marginBottom),
    marginLeft: mm(v.marginLeft, DEFAULTS.marginLeft),
    marginRight: mm(v.marginRight, DEFAULTS.marginRight),
    scale: int(v.scale, 10, 200, DEFAULTS.scale),
    printBackground: v.printBackground === true,
    displayHeaderFooter: v.displayHeaderFooter === true,
  }
}

/** Миллиметры → дюймы (единица полей printToPDF), округление до 4 знаков */
export function mmToInches(mm: number): number {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return Math.round((n / 25.4) * 10000) / 10000
}

/** Миллиметры → пиксели при 96 dpi (единица полей webview.print), округление до целого */
export function mmToPixels(mm: number): number {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return Math.round((n * 96) / 25.4)
}

/** Поля для printToPDF — в дюймах */
export function printMarginsInches(s: PrintSettings): PrintPdfMargins {
  return {
    top: mmToInches(s.marginTop),
    bottom: mmToInches(s.marginBottom),
    left: mmToInches(s.marginLeft),
    right: mmToInches(s.marginRight),
  }
}

/** Поля для webview.print — в пикселях. Свои поля Electron принимает
 *  ТОЛЬКО при marginType: 'custom', поэтому все четыре стороны обязательны. */
export function printMarginsPx(s: PrintSettings): PrintMarginsPx {
  return {
    marginType: 'custom',
    top: mmToPixels(s.marginTop),
    bottom: mmToPixels(s.marginBottom),
    left: mmToPixels(s.marginLeft),
    right: mmToPixels(s.marginRight),
  }
}

/** Аргументы printToPDF. pageRanges здесь НЕ применяем: сохраняем весь документ. */
export function printToPdfOptions(s: PrintSettings): PrintToPdfOptionsLike {
  return {
    landscape: s.landscape,
    printBackground: s.printBackground,
    scale: s.scale / 100,
    displayHeaderFooter: s.displayHeaderFooter,
    pageSize: s.pageSize,
    margins: printMarginsInches(s),
  }
}

function clampPage(n: number, pageCount: number): number {
  if (!Number.isFinite(n)) return 1
  // pageCount округляем вниз: иначе при нецелом числе страниц (например, из-за
  // дробной оценки вёрстки) индекс диапазона вышел бы нецелым и не прошёл бы
  // structured clone в guest webContents
  const max = Math.max(1, Math.floor(pageCount))
  return Math.min(Math.max(1, Math.floor(n)), max)
}

function isPaperName(v: PrintPageSizeName): v is PrintPaperName {
  return (PRINT_PAPER_NAMES as readonly string[]).includes(v)
}

/** Диапазон страниц для webview.print: индексы 0-based, to включительно.
 *  Пустой массив = печатать всё (поле pageRanges тогда не передаём). */
export function printPageRangesFor(s: PrintSettings, pageCount: number, currentPage: number): PrintPageRange[] {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return []
  if (s.rangeMode === 'current') {
    const p = clampPage(currentPage, pageCount) - 1
    return [{ from: p, to: p }]
  }
  if (s.rangeMode === 'custom') {
    const from = clampPage(s.rangeFrom, pageCount) - 1
    const to = Math.max(from, clampPage(s.rangeTo, pageCount) - 1)
    return [{ from, to }]
  }
  return []
}

/** Аргументы системной печати: silent всегда false — показываем диалог Windows (R4) */
export function printOptions(
  s: PrintSettings,
  deviceName: string,
  pageCount: number,
  currentPage: number,
): PrintOptionsLike {
  const ranges = printPageRangesFor(s, pageCount, currentPage)
  const opts: PrintOptionsLike = {
    silent: false,
    deviceName,
    printBackground: s.printBackground,
    landscape: s.landscape,
    copies: s.copies,
    margins: printMarginsPx(s),
    scaleFactor: s.scale / 100,
  }
  if (ranges.length) opts.pageRanges = ranges
  if (isPaperName(s.pageSize)) {
    opts.pageSize = s.pageSize
  } else {
    // A6 в списке WebviewTagPrintOptions отсутствует, а свой размер в микронах мы
    // не храним. Молчать нельзя: по документации Electron, если валидный pageSize не
    // передан и usePrinterDefaultPageSize === false, печать падает с ошибкой, поэтому
    // флаг обязателен. Он взаимоисключающе с pageSize, поэтому ставим именно его.
    opts.usePrinterDefaultPageSize = true
  }
  return opts
}

/** Uint8Array → base64 (для существующего window.shell.savePdf) */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 32768
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Имя файла для сохранения PDF: без расширения → с .pdf, без путей */
export function suggestedPdfName(title: string): string {
  const cleaned = (typeof title === 'string' ? title : '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  if (!cleaned) return 'document.pdf'
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`
}

export interface PrintDialogElements {
  /** Контейнер всех полей настроек. Слушатель с debounce на него вешает
   *  вызывающий код (main.ts) и зовёт refresh() — в контроллере таймеров нет */
  settings: HTMLElement
  overlay: HTMLElement
  title: HTMLElement
  destination: HTMLElement
  printerRow: HTMLElement
  rangeMode: HTMLElement
  rangeCustom: HTMLElement
  rangeFrom: HTMLElement
  rangeTo: HTMLElement
  copies: HTMLElement
  landscape: HTMLElement
  pageSize: HTMLElement
  marginTop: HTMLElement
  marginBottom: HTMLElement
  marginLeft: HTMLElement
  marginRight: HTMLElement
  noMargins: HTMLElement
  scale: HTMLElement
  printBackground: HTMLElement
  displayHeaderFooter: HTMLElement
  thumbs: HTMLElement
  thumbsNote: HTMLElement
  showAll: HTMLElement
  pageCounter: HTMLElement
  status: HTMLElement
  cancel: HTMLElement
  savePdf: HTMLElement
  print: HTMLElement
}

export interface PrintDialogHooks {
  listPrinters: () => Promise<ShellPrinter[]>
  /** Собрать PDF: view.printToPDF(printToPdfOptions(settings)) */
  buildPdf: (settings: PrintSettings) => Promise<Uint8Array>
  /** PDF → миниатюры. limit — сколько страниц нужно отрисовать: 10 при первом
   *  рендере и pageCount по кнопке «Показать все». pageCount — настоящее число
   *  страниц из pdf.js, thumbs при этом может быть короче limit. Хук вправе
   *  вернуть все уже нарисованные страницы (накопление) — берём ответ как есть. */
  renderThumbs: (bytes: Uint8Array, limit: number) => Promise<{ pageCount: number; thumbs: string[] }>
  /** Системная печать: view.print(printOptions(settings, …)) */
  doPrint: (settings: PrintSettings) => Promise<void>
  /** window.shell.savePdf(bytesToBase64(bytes), suggestedPdfName(title)) */
  doSavePdf: (settings: PrintSettings, bytes: Uint8Array) => Promise<boolean>
  documentTitle: () => string
  /** Запись config.print — только при успешной печати/сохранении */
  persist: (settings: PrintSettings) => Promise<void>
}

export interface PrintDialogController {
  open: (settings: PrintSettings) => Promise<void>
  /** Закрытие с проверкой busy: во время печати/сбора превью не закрывает */
  close: () => void
  isOpen: () => boolean
  /** true — идёт печать, сохранение или сборка превью */
  isBusy: () => boolean
  refresh: () => Promise<void>
  currentSettings: () => PrintSettings
  currentPage: () => number
  /** Настоящее число страниц; никогда не 0 — иначе printPageRangesFor отдаст
   *  пустой pageRanges, а это в webview.print означает «печатать весь документ» */
  pageCount: () => number
  previewBytes: () => Uint8Array | null
}

/** Миниатюр показываем по 10; остальное — по кнопке «Показать все» */
const THUMB_LIMIT = 10
const PDF_OPTION = 'pdf'

/** Ответ хука миниатюр: pageCount — из pdf.js, thumbs может быть пустым */
interface ThumbsPainted {
  pageCount: number
  thumbs: string[]
  /** Хук упал: pageCount/thumbs недостоверны, состояние не обновляем */
  failed: boolean
}

/**
 * Контроллер диалога печати. Не знает ни про Electron, ни про webview —
 * всё через хуки, поэтому тестируется под node --test с FakeEl.
 * Таймеров нет: debounce пересчёта превью живёт в вызывающем коде (main.ts).
 */
export function createPrintDialog(elements: PrintDialogElements, hooks: PrintDialogHooks): PrintDialogController {
  let open = false
  let printers: ShellPrinter[] = []
  let bytes: Uint8Array | null = null
  let thumbs: string[] = []
  let currentPage = 1
  let showAll = false
  let busy = false
  /** Настоящее число страниц по последнему успешному рендеру; 0 = неизвестно */
  let pageCount = 0
  /** Растёт на каждый refresh: результат устаревшей сборки игнорируется */
  let generation = 0
  /** Сообщение о принтерах: показывается один раз поверх успешного превью,
   *  иначе refresh() затирал бы его пустым статусом */
  let notice = ''

  const input = (el: HTMLElement): HTMLInputElement => el as HTMLInputElement
  const readValue = (el: HTMLElement): string => input(el).value ?? ''
  const readChecked = (el: HTMLElement): boolean => input(el).checked === true
  const toInt = (el: HTMLElement, fallback: number): number => {
    const n = Math.floor(Number(readValue(el)))
    return Number.isFinite(n) ? n : fallback
  }
  const toFloat = (el: HTMLElement, fallback: number): number => {
    const n = Number(readValue(el))
    return Number.isFinite(n) ? n : fallback
  }
  const fill = (el: HTMLElement, value: string | number | boolean): void => {
    input(el).value = String(value)
  }
  const setStatus = (text: string): void => {
    elements.status.textContent = text
  }

  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  const currentDeviceName = (): string => {
    const value = readValue(elements.destination)
    return printers.some((p) => p.name === value) ? value : ''
  }

  const currentSettings = (): PrintSettings =>
    normalizePrintSettings({
      destination: currentDeviceName() ? 'printer' : PDF_OPTION,
      deviceName: currentDeviceName(),
      rangeMode: readValue(elements.rangeMode),
      rangeFrom: toInt(elements.rangeFrom, DEFAULTS.rangeFrom),
      rangeTo: toInt(elements.rangeTo, DEFAULTS.rangeTo),
      copies: toInt(elements.copies, DEFAULTS.copies),
      landscape: readValue(elements.landscape) === 'landscape',
      pageSize: readValue(elements.pageSize),
      marginTop: toFloat(elements.marginTop, DEFAULTS.marginTop),
      marginBottom: toFloat(elements.marginBottom, DEFAULTS.marginBottom),
      marginLeft: toFloat(elements.marginLeft, DEFAULTS.marginLeft),
      marginRight: toFloat(elements.marginRight, DEFAULTS.marginRight),
      scale: toInt(elements.scale, DEFAULTS.scale),
      printBackground: readChecked(elements.printBackground),
      displayHeaderFooter: readChecked(elements.displayHeaderFooter),
    })

  const fillSettings = (s: PrintSettings): void => {
    elements.title.textContent = hooks.documentTitle() || 'Документ'
    fill(elements.rangeMode, s.rangeMode)
    fill(elements.rangeFrom, s.rangeFrom)
    fill(elements.rangeTo, s.rangeTo)
    fill(elements.copies, s.copies)
    fill(elements.landscape, s.landscape ? 'landscape' : 'portrait')
    fill(elements.pageSize, s.pageSize)
    fill(elements.marginTop, s.marginTop)
    fill(elements.marginBottom, s.marginBottom)
    fill(elements.marginLeft, s.marginLeft)
    fill(elements.marginRight, s.marginRight)
    fill(elements.scale, s.scale)
    input(elements.printBackground).checked = s.printBackground
    input(elements.displayHeaderFooter).checked = s.displayHeaderFooter
    elements.rangeCustom.hidden = s.rangeMode !== 'custom'
  }

  const buildDestination = (selected: string): void => {
    const options: Array<{ value: string; label: string }> = [
      { value: PDF_OPTION, label: 'Сохранить как PDF' },
    ]
    for (const p of printers) options.push({ value: p.name, label: p.displayName || p.name })
    elements.destination.replaceChildren(
      ...options.map((o) => {
        const option = document.createElement('option')
        option.value = o.value
        option.textContent = o.label
        return option
      }),
    )
    fill(elements.destination, options.some((o) => o.value === selected) ? selected : PDF_OPTION)
  }

  const syncButtons = (): void => {
    const s = currentSettings()
    const hasPrinter = printers.length > 0 && printers.some((p) => p.name === s.deviceName)
    const broken = bytes === null
    // disabled есть только у HTMLInputElement/HTMLButtonElement, поэтому через input()
    input(elements.print).disabled = busy || broken || s.destination !== 'printer' || !hasPrinter
    input(elements.savePdf).disabled = busy || broken
    input(elements.cancel).disabled = busy
  }

  const paintThumbs = (): void => {
    const shown = showAll
      ? Math.min(pageCount, thumbs.length)
      : Math.min(THUMB_LIMIT, pageCount, thumbs.length)
    const nodes: HTMLElement[] = []
    for (let i = 0; i < shown; i++) {
      const page = i + 1
      const img = document.createElement('img')
      img.src = thumbs[i] ?? ''
      img.alt = `Страница ${page}`
      img.className = page === currentPage ? 'print-thumb current' : 'print-thumb'
      // Слушатель на самой миниатюре, а не на контейнере: контейнер целиком
      // перерисовывается через replaceChildren, а fire() в тест-дубле не
      // эмулирует всплытие, поэтому делегирование по контейнеру тестом не
      // проверялось бы. В живом DOM клик по <img> доходит до обоих.
      img.addEventListener('click', () => {
        currentPage = page
        paintThumbs()
      })
      nodes.push(img)
    }
    elements.thumbs.replaceChildren(...nodes)
    // Подсказка и счётчик считаются от настоящего pageCount, а не от длины
    // массива миниатюр: pdf.js знает число страниц даже когда нарисованы не все
    if (thumbs.length > 0 && pageCount > shown) {
      elements.thumbsNote.textContent = `Показаны первые ${shown} из ${pageCount}`
      elements.showAll.hidden = false
    } else {
      elements.thumbsNote.textContent = ''
      elements.showAll.hidden = true
    }
    elements.pageCounter.textContent =
      thumbs.length > 0 && pageCount > 0 ? `Страница ${Math.min(currentPage, pageCount)} из ${pageCount}` : ''
  }

  /** Миниатюры из уже собранного PDF. null — ответ устарел, состояние не трогаем */
  const renderThumbsFor = async (
    data: Uint8Array,
    my: number,
    limit: number,
  ): Promise<ThumbsPainted | null> => {
    try {
      const out = await hooks.renderThumbs(data, limit)
      if (my !== generation || !open) return null
      const n = Number(out?.pageCount)
      const list = out?.thumbs
      return {
        failed: false,
        pageCount: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0,
        thumbs: Array.isArray(list) ? list : [],
      }
    } catch (err) {
      // Провал рендера миниатюр НЕ ломает печать: PDF уже есть, показываем
      // заглушку и оставляем кнопки рабочими (спека §9).
      console.warn('[print] не удалось построить миниатюры:', err)
      return { failed: true, pageCount: 0, thumbs: [] }
    }
  }

  const takePainted = (painted: ThumbsPainted): void => {
    // При упавшем рендере pageCount оставляем прежним: число страниц нужно для
    // печати по диапазону, и 0 там опаснее, чем слегка устаревшее значение
    if (!painted.failed) pageCount = painted.pageCount
    thumbs = painted.thumbs
    if (pageCount > 0 && currentPage > pageCount) currentPage = pageCount
    paintThumbs()
  }

  const refresh = async (): Promise<void> => {
    if (!open) return
    const my = ++generation
    // Новый пересчёт — снова показываем первые 10 миниатюр
    showAll = false
    elements.rangeCustom.hidden = readValue(elements.rangeMode) !== 'custom'
    const settings = currentSettings()
    busy = true
    syncButtons()
    setStatus('Готовим предпросмотр…')
    try {
      const built = await hooks.buildPdf(settings)
      if (my !== generation || !open) return
      const painted = await renderThumbsFor(built, my, THUMB_LIMIT)
      if (painted === null) return
      bytes = built
      takePainted(painted)
      // Сообщение о принтере («больше не доступен — печатаем в PDF») — единственный
      // сигнал о том, что назначение молча сменилось, поэтому при упавшем рендере
      // показываем его ВМЕСТЕ с ошибкой превью, а не вместо неё
      const parts: string[] = []
      if (thumbs.length === 0) parts.push('Не удалось построить предпросмотр')
      if (notice) parts.push(notice)
      setStatus(parts.join('. '))
      notice = ''
    } catch (err) {
      if (my !== generation || !open) return
      bytes = null
      thumbs = []
      paintThumbs()
      setStatus(`Не удалось построить предпросмотр: ${errText(err)}`)
      notice = ''
    } finally {
      // Пока пересчёт не наш, busy держит уже следующий вызов
      if (my === generation) {
        busy = false
        syncButtons()
      }
    }
  }

  /** «Показать все»: PDF не пересобираем, только дорисовываем миниатюры до pageCount.
   *  busy здесь не трогаем — он уже поднят вызывающим runAction. */
  const renderAllThumbs = async (): Promise<void> => {
    if (!open || bytes === null || pageCount <= 0) return
    const my = ++generation
    const painted = await renderThumbsFor(bytes, my, pageCount)
    if (painted === null) return
    takePainted(painted)
  }

  const closeNow = (): void => {
    if (!open) return
    open = false
    generation++
    busy = false
    notice = ''
    elements.overlay.hidden = true
  }

  /** Публичное закрытие (Escape, клик по фону, «Отмена»): во время печати или
   *  сборки превью не закрываем — сначала дождаться (спека §6) */
  const close = (): void => {
    if (busy) return
    closeNow()
  }

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    syncButtons()
    try {
      await action()
    } catch (err) {
      setStatus(errText(err))
    } finally {
      busy = false
      syncButtons()
    }
  }

  elements.cancel.addEventListener('click', close)
  elements.showAll.addEventListener('click', () => {
    void runAction(async () => {
      showAll = true
      await renderAllThumbs()
    })
  })
  elements.noMargins.addEventListener('click', () => {
    fill(elements.marginTop, 0)
    fill(elements.marginBottom, 0)
    fill(elements.marginLeft, 0)
    fill(elements.marginRight, 0)
  })
  elements.print.addEventListener('click', () => {
    void runAction(async () => {
      const settings = currentSettings()
      try {
        await hooks.doPrint(settings)
      } catch (err) {
        throw new Error(`Печать не удалась: ${errText(err)}`)
      }
      await hooks.persist(settings)
      // closeNow, а не close: мы внутри runAction, busy ещё true, а закрыть надо
      closeNow()
    })
  })
  elements.savePdf.addEventListener('click', () => {
    void runAction(async () => {
      const settings = currentSettings()
      let data = bytes
      if (!data) {
        try {
          data = await hooks.buildPdf(settings)
        } catch (err) {
          throw new Error(`Не удалось сохранить PDF: ${errText(err)}`)
        }
        bytes = data
      }
      try {
        await hooks.doSavePdf(settings, data)
      } catch (err) {
        throw new Error(`Не удалось сохранить PDF: ${errText(err)}`)
      }
      await hooks.persist(settings)
      closeNow()
    })
  })

  elements.overlay.hidden = true

  const openDialog = async (settings: PrintSettings): Promise<void> => {
    if (open) return
    open = true
    bytes = null
    thumbs = []
    pageCount = 0
    currentPage = 1
    showAll = false
    busy = false
    notice = ''
    elements.overlay.hidden = false
    setStatus('Загружаем список принтеров…')
    let list: ShellPrinter[] = []
    let printersFailed = false
    try {
      list = await hooks.listPrinters()
    } catch (err) {
      console.warn('[print] список принтеров недоступен:', err)
      printersFailed = true
    }
    if (!open) return
    printers = Array.isArray(list) ? list : []
    const known = printers.some((p) => p.name === settings.deviceName)
    buildDestination(settings.destination === 'printer' && known ? settings.deviceName : PDF_OPTION)
    fillSettings(settings)
    if (printers.length === 0) {
      elements.printerRow.hidden = true
      notice = printersFailed ? 'Не удалось получить список принтеров' : 'Принтеры не найдены — доступно сохранение в PDF'
    } else {
      elements.printerRow.hidden = false
      if (settings.destination === 'printer' && !known) {
        notice = `Принтер «${settings.deviceName}» больше не доступен — печатаем в PDF`
      }
    }
    // Текст notice показывает refresh() поверх результата превью (при сбое рендера —
    // вместе с ошибкой), а не затирает
    syncButtons()
    await refresh()
  }

  return {
    open: openDialog,
    close,
    isOpen: () => open,
    isBusy: () => busy,
    refresh,
    currentSettings,
    currentPage: () => currentPage,
    pageCount: () => Math.max(1, pageCount),
    previewBytes: () => bytes,
  }
}
