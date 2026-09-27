import { activeView, type ShellTab } from './tabs'
import { hideToast, setStatus } from './status-ui'
import {
  bytesToBase64,
  createPrintDialog,
  normalizePrintSettings,
  PRINT_PAPER_NAMES,
  printOptions,
  printToPdfOptions,
  suggestedPdfName,
  type PrintDialogController,
  type PrintDialogElements,
  type PrintDialogHooks,
} from './print-dialog'

/**
 * Мост печати: держит состояние диалога (таймер обновления превью, список
 * принтеров, зафиксированную целевую вкладку) и связывает UI печати с
 * оболочкой через deps.
 */
export interface PrintBridgeDeps {
  config(): ShellConfig | null
  savePrintConfig(print: ShellConfig['print']): Promise<void>
  currentViewUrl(): string
}

let deps!: PrintBridgeDeps
let printDialog: PrintDialogController | null = null

/** Передать зависимости оболочки. Обязательно до первого openPrintDialog. */
export function initPrintBridge(next: PrintBridgeDeps): void {
  deps = next
}


let printRefreshTimer: number | null = null
/** Последний список принтеров от main — нужен строке «Принтер» диалога */
let printPrinters: ShellPrinter[] = []
/** Синхронизация нашей части диалога (строка принтера + список бумаги).
 *  Замыкание из wirePrintDialog: контроллер эти куски не ведёт, а держит
 *  только скрытость строки, поэтому звать его приходится из openPrintDialog */
let printPanelSync: (() => void) | null = null
/** Вкладка, снятая при открытии диалога. Хоткеи висят на window, поэтому
 *  Ctrl+Tab/Ctrl+3 переводит активную вкладку, пока печать открыта: без
 *  фиксации цели превью, системная печать и имя PDF уехали бы на чужой документ */
let printTargetView: SewWebViewElement | null = null
const titlebarTitle = document.getElementById('titlebar-title') as HTMLElement | null

/** Ширина миниатюры превью печати, CSS-px. Должна совпадать с .print-thumb в styles.css. */
const PRINT_THUMB_WIDTH = 210
/** z-index оверлея печати на время показа: поднимаем выше карточки задачи
 *  (#task-alert, 100), иначе она ложится прямо на панель печати */
const PRINT_OVERLAY_Z = 200

export function printElements(): PrintDialogElements | null {
  const get = (id: string): HTMLElement | null => document.getElementById(id)
  const ids: Record<keyof PrintDialogElements, string> = {
    overlay: 'print-overlay',
    title: 'print-title',
    destination: 'print-destination',
    printerRow: 'print-printer-row',
    rangeMode: 'print-range-mode',
    rangeCustom: 'print-range-custom',
    rangeFrom: 'print-range-from',
    rangeTo: 'print-range-to',
    copies: 'print-copies',
    landscape: 'print-landscape',
    pageSize: 'print-page-size',
    marginTop: 'print-margin-top',
    marginBottom: 'print-margin-bottom',
    marginLeft: 'print-margin-left',
    marginRight: 'print-margin-right',
    noMargins: 'print-no-margins',
    scale: 'print-scale',
    printBackground: 'print-background',
    displayHeaderFooter: 'print-header-footer',
    thumbs: 'print-thumbs',
    thumbsNote: 'print-thumbs-note',
    showAll: 'print-show-all',
    pageCounter: 'print-page-counter',
    status: 'print-status',
    cancel: 'print-cancel',
    savePdf: 'print-save',
    print: 'print-go',
    settings: 'print-settings',
  }
  const out = {} as Record<keyof PrintDialogElements, HTMLElement>
  for (const key of Object.keys(ids) as Array<keyof PrintDialogElements>) {
    const el = get(ids[key])
    if (!el) return null
    out[key] = el
  }
  return out as PrintDialogElements
}

/** Снять отложенный пересчёт превью: перед новым таймером и перед «Показать все».
 *  Возвращает true, если таймер ДЕЙСТВИТЕЛЬНО был запланирован и его сняли, —
 *  вызывающему нужно знать это, чтобы перевзводить пересчёт только тогда,
 *  когда есть что пересчитывать (см. клик по «Показать все»). */
export function cancelScheduledPrintRefresh(): boolean {
  if (printRefreshTimer === null) return false
  window.clearTimeout(printRefreshTimer)
  printRefreshTimer = null
  return true
}

/** Пересчёт превью с debounce: поля меняются мышью, PDF печатать не каждый раз */
export function schedulePrintRefresh(): void {
  cancelScheduledPrintRefresh()
  printRefreshTimer = window.setTimeout(() => {
    printRefreshTimer = null
    // Пока идёт печать/сохранение/«Показать все», refresh() нельзя: он сбрасывает
    // busy в своём finally и вернул бы кнопки под системным диалогом (или
    // перебил renderAllThumbs по generation и сбросил showAll). Поэтому не
    // пропускаем пересчёт, а перевзводим таймер — окно занятости узкое.
    if (printDialog?.isBusy()) {
      schedulePrintRefresh()
      return
    }
    void printDialog?.refresh()
  }, 250)
}

/**
 * Единственная точка входа в диалог печати: Ctrl+P, пункт меню адреса
 * и «Печать…» из контекстного меню гостя.
 */
export async function openPrintDialog(tab: ShellTab | null): Promise<void> {
  if (!tab) {
    setStatus('нет активной вкладки')
    return
  }
  if (!printDialog) {
    setStatus('диалог печати недоступен')
    return
  }
  if (printDialog.isOpen()) return
  // Цель печати фиксируем здесь и навсегда: хоткеи слушаются на window, оверлей их
  // не перехватывает, поэтому Ctrl+Tab/Ctrl+3 во время печати сделал бы активной
  // другую вкладку — и превью, печать и имя PDF поехали бы на чужой документ
  printTargetView = tab.view ?? activeView()
  await printDialog.open(normalizePrintSettings(deps.config()?.print))
  // Контроллер пересобрал «Назначение» и заполнил поля — досинхронизируем нашу
  // часть (строка принтера, список бумаги) под фактический выбор
  printPanelSync?.()
}

/** Заголовок документа для шапки диалога и имени PDF — всегда у зафиксированной
 *  цели печати, иначе Ctrl+Tab переименовал бы сохраняемый файл */
export function titleForPrint(): string {
  try {
    return (printTargetView ?? activeView())?.getTitle() ?? ''
  } catch {
    return ''
  }
}

export function wirePrintDialog(): void {
  const elements = printElements()
  if (!elements) return
  // Цель, снятая при открытии диалога; activeView() — запасной путь, если
  // openPrintDialog цели не зафиксировал (например, гость не дал view)
  const view = (): SewWebViewElement | null => printTargetView ?? activeView()

  // Строка «Принтер» в разметке пустая: контроллер умеет только скрывать её,
  // содержимое собираем здесь через DOM API (без innerHTML — текст небезопасен)
  const printerCaption = document.createElement('span')
  printerCaption.className = 'print-label'
  printerCaption.textContent = 'Принтер'
  const printerInfo = document.createElement('span')
  printerInfo.className = 'print-label'
  printerInfo.style.color = 'var(--text-2)'
  elements.printerRow.replaceChildren(printerCaption, printerInfo)

  const destinationSelect = elements.destination as HTMLSelectElement
  const paperSelect = elements.pageSize as HTMLSelectElement

  /** Принтер, выбранный в «Назначении»; null — PDF или принтер исчез из списка */
  const selectedPrinter = (): ShellPrinter | null =>
    printPrinters.find((p) => p.name === destinationSelect.value) ?? null

  /**
   * Список бумаги. В режиме принтера A6 убираем: webview.print его не понимает,
   * и printOptions тогда молча ставит usePrinterDefaultPageSize — пользователь
   * получил бы бумагу принтера по умолчанию вместо выбранной. Для PDF A6 доступен.
   */
  const paperNames = (forPrinter: boolean): PrintPageSizeName[] => {
    // A4 первым (самый частый), остальные в порядке PRINT_PAPER_NAMES
    const base: PrintPaperName[] = ['A4', ...PRINT_PAPER_NAMES.filter((name) => name !== 'A4')]
    return forPrinter ? base : [...base, 'A6']
  }

  const repaintPaper = (forPrinter: boolean): void => {
    const names = paperNames(forPrinter)
    const previous = paperSelect.value
    paperSelect.replaceChildren(
      ...names.map((name) => {
        const option = document.createElement('option')
        option.value = name
        option.textContent = name
        return option
      }),
    )
    // Значение могло остаться от режима PDF (A6) или от прежнего списка: пустой
    // select выглядит как поломка, поэтому откатываемся на первый размер
    paperSelect.value = (names as readonly string[]).includes(previous) ? previous : names[0]
  }

  const repaintPrinterRow = (): void => {
    const printer = selectedPrinter()
    printerInfo.textContent = printer
      ? `${printer.displayName || printer.name}${printer.description ? ` — ${printer.description}` : ''}`
      : 'Файл PDF, принтер не используется'
  }

  const syncPrintPanel = (): void => {
    const forPrinter = selectedPrinter() !== null
    repaintPaper(forPrinter)
    repaintPrinterRow()
  }
  printPanelSync = syncPrintPanel

  // Слои и срок жизни цели: тост (#toast, 50) во время печати только шумит под
  // затемнением, а карточка задачи (#task-alert, 100) легла бы прямо на панель.
  // Поэтому на время показа поднимаем оверлей над обоими, тост гасим вместе с
  // таймером, а по закрытию забываем цель печати.
  const watchPrintOverlay = (): void => {
    const apply = (): void => {
      const visible = !elements.overlay.hidden
      elements.overlay.style.zIndex = visible ? String(PRINT_OVERLAY_Z) : ''
      // Диалог закрыт (любой путь: Отмена, крестик, Escape, клик по фону,
      // closeNow после печати) — цель больше не нужна
      if (!visible) printTargetView = null
      if (!visible) return
      hideToast()
    }
    apply()
    // Наблюдатель, а не вызовы в точках закрытия: контроллер закрывает оверлей
    // сам (после печати/сохранения) и отдельного хука не даёт
    new MutationObserver(apply).observe(elements.overlay, {
      attributes: true,
      attributeFilter: ['hidden'],
    })
  }

  const hooks: PrintDialogHooks = {
    listPrinters: async () => {
      const list = await window.shell.listPrinters()
      // description в ShellPrinter обязателен, а из main может прийти пустым
      printPrinters = (Array.isArray(list) ? list : []).map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || p.displayName || p.name,
      }))
      return printPrinters
    },
    buildPdf: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      return target.printToPDF(printToPdfOptions(settings))
    },
    // pdf.js весит около мегабайта, а печатает пользователь далеко не всегда —
    // тянем модуль лениво, при первом открытии диалога.
    renderThumbs: async (data, limit) => {
      const { renderPdfThumbnails } = await import('./print-preview')
      return renderPdfThumbnails(data, PRINT_THUMB_WIDTH, limit)
    },

    doPrint: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      const pageCount = printDialog?.pageCount() ?? 0
      const current = printDialog?.currentPage() ?? 1
      await target.print(printOptions(settings, settings.deviceName, pageCount, current))
    },
    doSavePdf: async (_settings, bytes) => {
      const name = suggestedPdfName(titleForPrint())
      return window.shell.savePdf(bytesToBase64(bytes), name)
    },
    documentTitle: () => titleForPrint(),
    persist: async (settings) => {
      await deps.savePrintConfig(settings)
    },
  }
  printDialog = createPrintDialog(elements, hooks)
  // Любое изменение настроек пересчитывает превью
  elements.settings.addEventListener('change', schedulePrintRefresh)
  elements.settings.addEventListener('input', schedulePrintRefresh)
  // Смена назначения меняет и список бумаги, и строку принтера. Слушатель висит
  // на самом select: он сработает раньше контейнера #print-settings, значит
  // refresh() уже прочитает исправленные значения
  elements.destination.addEventListener('change', syncPrintPanel)
  // «Поля: нет» проставляет значения через fill(): ни input, ни change оно не
  // порождает, а клик по <button> их тоже не даёт — превью без пересчёта
  // осталось бы старым. Идём через schedulePrintRefresh: refresh() напрямую
  // сбросил бы busy, если клик пришёлся на печать/сохранение (их кнопки
  // блокируются, а поля полей — нет)
  elements.noMargins.addEventListener('click', schedulePrintRefresh)
  // «Показать все» — самое свежее намерение пользователя, поэтому отложенный
  // пересчёт снимаем: иначе он отработал бы сразу после runAction и опять
  // показал только первые 10 миниатюр (refresh обнуляет showAll). Но снимать его
  // «насовсем» тоже нельзя: правка поля, сделанная в предшествующие 250 мс, молча
  // выпала бы из превью. Поэтому таймер перевзводим ТОЛЬКО если он реально был
  // запланирован: иначе (обычный клик, без свежих правок) мы бы через 250 мс
  // вызвали refresh(), который детерминированно сбросил бы showAll и вернул ленту
  // к первым 10 миниатюрам — «Показать все» стал бы недостижимым на документах
  // длиннее 10 страниц. schedulePrintRefresh сам переждёт конца runAction
  // (isBusy) и дольёт превью по актуальным полям.
  elements.showAll.addEventListener('click', () => {
    if (cancelScheduledPrintRefresh()) schedulePrintRefresh()
  })
  // Клик по фону оверлея закрывает диалог
  elements.overlay.addEventListener('click', (event) => {
    if (event.target === elements.overlay) printDialog?.close()
  })
  document.getElementById('print-cancel-x')?.addEventListener('click', () => printDialog?.close())
  watchPrintOverlay()
  syncPrintPanel()
}

/**
 * Закрывает диалог печати, если он открыт. Для цепочки Esc в оболочке:
 * возвращает true, если закрытие произошло (вызывающий прерывает цепочку).
 */
export function closePrintDialogIfOpen(): boolean {
  if (!printDialog?.isOpen()) return false
  printDialog.close()
  return true
}
