import { parseSkuInput, symbologyName } from '../../shared/barcode-core'
import { setStatus } from './status-ui'

/**
 * Оверлей печати штрихов. Печать ценников через SEW снята — остался один путь:
 * локальная база db.json (см. src/main/barcode-db.ts) и лист штрихов из неё.
 * Идентификаторы оверлея остались прежними (pricetags-*), чтобы не трогать
 * разметку, стили и горячую клавишу: переименование — отдельная история.
 */
export interface PricetagsOverlayDeps {
  config(): ShellConfig | null
  savePricetagsConfig(patch: Partial<ShellConfig>): Promise<ShellConfig>
}

let deps!: PricetagsOverlayDeps
/** Коды товара живут только внутри сессии окна — намеренно не сохраняем. */
let skus: string[] = []
/** Позиции, найденные в локальной базе штрихов (у них нет цены). */
let barcodeItems: BarcodeItem[] = []

function el(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function overlay(): HTMLElement | null {
  return el('pricetags-overlay')
}

function button(id: string): HTMLButtonElement | null {
  return el(id) as HTMLButtonElement | null
}

export function pricetagsOverlayEl(): HTMLElement | null {
  return overlay()
}

export function isPricetagsOpen(): boolean {
  const node = overlay()
  return !!node && !node.hidden
}

export function closePricetags(): void {
  const node = overlay()
  if (node) node.hidden = true
}

/** Позиции, которые сейчас видны: результат поиска, суженный набором чипов. */
function visibleBarcodeItems(): BarcodeItem[] {
  return barcodeItems.filter((item) => skus.includes(item.sku))
}

/** Человекочитаемое состояние базы штрихов для строки в оверлее. */
function renderDbStatus(status?: BarcodeDbStatus): void {
  const box = el('barcodes-db-status')
  if (!box) return
  if (!status) {
    box.textContent = '—'
    return
  }
  if (status.state === 'building') {
    box.textContent = status.stage === 'index' ? 'разбираем базу…' : 'читаем базу…'
    return
  }
  if (status.state === 'error') {
    box.textContent = `недоступна: ${status.error ?? 'причина неизвестна'}`
    return
  }
  if (status.state === 'empty') {
    box.textContent = 'не собрана — нажмите «Обновить базу»'
    return
  }
  const count = status.items ? `позиций: ${new Intl.NumberFormat('ru-RU').format(status.items)}` : ''
  const when = status.updatedAt ? `обновлена ${new Date(status.updatedAt).toLocaleString('ru-RU')}` : ''
  box.textContent = [count, when, status.stale ? 'устарела' : ''].filter(Boolean).join(' · ')
}

/** Рисуем строки и «не найдены» по текущему набору чипов. Повторный запрос к
 *  базе не нужен: данные по оставшимся кодам товара уже в `barcodeItems`,
 *  поэтому убранный артикул исчезает сразу. */
function renderResult(): void {
  renderBarcodeRows(
    visibleBarcodeItems(),
    skus.filter((sku) => !barcodeItems.some((item) => item.sku === sku)),
  )
  refreshButtons()
}

/** Кнопки живут по состоянию, а не по флажкам. */
function refreshButtons(): void {
  const build = button('pricetags-build')
  if (build) build.disabled = visibleBarcodeItems().length === 0
}

function renderChips(): void {
  const box = el('pricetags-chips')
  if (!box) return
  box.replaceChildren(
    ...skus.map((sku) => {
      const chip = document.createElement('span')
      chip.className = 'pricetags-chip'
      const label = document.createElement('span')
      label.textContent = sku
      const drop = document.createElement('button')
      drop.type = 'button'
      drop.textContent = '✕'
      drop.title = 'Убрать артикул'
      drop.addEventListener('click', () => {
        skus = skus.filter((value) => value !== sku)
        renderChips()
        // Список позиций сужаем сразу — раньше убранный артикул оставался
        // видимым до следующего «Найти», и в PDF ушёл бы как лишний.
        renderResult()
      })
      chip.append(label, drop)
      return chip
    }),
  )
}

/**
 * История кодов товара, по которым штрих реально печатали. Хранится main'ом в
 * barcode-history.json и переживает перезапуск: список листа набирают заново
 * каждый день, а повторно вбитые коды — уже не набор, а ошибка.
 *
 * В историю попадают только коды, НАЙДЕННЫЕ в локальной базе (запись идёт после
 * поиска). Код, которого в базе нет, штриха всё равно не напечатать — держать
 * его в истории незачем, и через месяц такой список становится свалкой из
 * опечаток. В историю пишется только код: штрих и наименование дозапрашиваются
 * из базы, дублировать их в файле нечего.
 */
let history: string[] = []

/**
 * Полоса истории: клик по коду возвращает его в текущий список. Сама история не
 * меняется от просмотра — иначе простое открытие оверлея переставляло бы её.
 */
function renderHistory(): void {
  const box = el('pricetags-history')
  if (!box) return
  const clear = button('pricetags-history-clear')
  if (clear) clear.disabled = history.length === 0
  if (history.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'pricetags-history-empty'
    empty.textContent = 'пусто'
    box.replaceChildren(empty)
    return
  }
  box.replaceChildren(
    ...history.map((sku) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'pricetags-history-item'
      item.textContent = sku
      item.title = 'Добавить код в список'
      item.addEventListener('click', () => addSkus([sku]))
      return item
    }),
  )
}

/** Дописать найденные в базе коды в историю (вызывает поиск). Отказ хранилища
 *  не должен ломать лист. */
async function rememberSkus(values: readonly string[]): Promise<void> {
  if (values.length === 0) return
  try {
    const saved = await window.shell.barcodesHistoryAdd([...values])
    if (saved && Array.isArray(saved.skus)) history = saved.skus
    renderHistory()
  } catch (err) {
    console.warn('[pricetags] история не сохранена:', err)
  }
}

/** Очистка истории по кнопке — без подтверждения: восстановить её нечем, но и
 *  терять нечего, коды берутся из базы заново. */
async function clearHistory(): Promise<void> {
  try {
    const saved = await window.shell.barcodesHistoryClear()
    history = saved && Array.isArray(saved.skus) ? saved.skus : []
  } catch (err) {
    console.warn('[pricetags] история не очищена:', err)
  }
  renderHistory()
}

function addSkus(values: readonly string[]): void {
  let added = false
  for (const value of values) {
    if (skus.includes(value)) continue
    skus.push(value)
    added = true
  }
  if (!added) return
  renderChips()
  setStatus(`артикулов в списке: ${skus.length}`)
  // Историю здесь НЕ трогаем: код ещё не проверен базой, в историю идёт то, что
  // поиск нашёл (см. findBarcodeItems).
}

function addFromInput(input: HTMLInputElement): void {
  addSkus(parseSkuInput(input.value))
  input.value = ''
}

/**
 * Строки результата поиска. Показываем сам штрих-код и чем он нарисован: у
 * 13-значных кодов это EAN-13, у остальных (в базе их ~142 тыс., длиной 2…18
 * знаков) — Code 128. Пользователь видит, что именно уйдёт на бумагу, ещё до
 * печати.
 */
function renderBarcodeRows(rows: readonly BarcodeItem[], missing: readonly string[]): void {
  const box = el('pricetags-rows')
  if (box) {
    box.replaceChildren(
      ...rows.map((item) => {
        const row = document.createElement('div')
        row.className = 'pricetags-row'
        const sku = document.createElement('span')
        sku.className = 'sku'
        sku.textContent = item.sku
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = item.name
        name.title = item.name
        const code = document.createElement('span')
        code.className = 'price'
        code.textContent = `${item.barcode} · ${symbologyName(item.symbology)}`
        row.append(sku, name, code)
        return row
      }),
    )
  }
  const miss = el('pricetags-missing')
  if (!miss) return
  miss.textContent = missing.length > 0 ? `не найдены в базе: ${missing.join(', ')}` : ''
  miss.hidden = missing.length === 0
}

/** Ключ конфига → поле оверлея. Нужно для точечного отката: показываем в
 *  поле то, что реально записано в конфиг, а не то, что main отверг. */
const PATCH_FIELDS: Partial<Record<keyof ShellConfig, string>> = {
  pricetagCopies: 'barcodes-copies',
}

/** Откат поля, если main не принял значение — образец `saveStockObjectId`
 *  в src/renderer/src/stock-report.ts.
 *
 *  Отказ откатываем ТОЧЕЧНО, в само поле. Раньше здесь звался openPricetags(),
 *  и вместе с полем стирались введённые артикулы и найденные позиции — опечатка
 *  стоила пользователю всей работы. */
async function persist(patch: Partial<ShellConfig>, label: string): Promise<void> {
  const next = await deps.savePricetagsConfig(patch)
  const rejectedKeys = (Object.keys(patch) as Array<keyof ShellConfig>).filter(
    (key) => String(next[key]) !== String(patch[key]),
  )
  if (rejectedKeys.length > 0) {
    for (const key of rejectedKeys) {
      const fieldId = PATCH_FIELDS[key]
      if (!fieldId) continue
      const field = el(fieldId) as HTMLInputElement | HTMLSelectElement | null
      if (field) field.value = String(next[key])
    }
    setStatus(`${label} не принят настройками — значение откачено`)
    return
  }
  setStatus(`${label} сохранён`)
}

export async function openPricetags(): Promise<void> {
  const node = overlay()
  if (!node) return
  node.hidden = false
  // Текущий список каждый раз с нуля, история — нет: она и нужна, чтобы не
  // вбивать одни и те же коды второй день подряд.
  skus = []
  barcodeItems = []
  renderChips()
  renderResult()
  const copies = el('barcodes-copies') as HTMLInputElement | null
  if (copies) copies.value = String(deps.config()?.pricetagCopies ?? 1)
  renderDbStatus(await window.shell.barcodesStatus())
  await loadHistory()
  el('pricetags-sku')?.focus()
}

/** Загрузка истории из файла. Пока она едет, в блоке остаётся прошлое содержимое. */
async function loadHistory(): Promise<void> {
  try {
    const saved = await window.shell.barcodesHistory()
    history = saved && Array.isArray(saved.skus) ? saved.skus : []
  } catch (err) {
    console.warn('[pricetags] история не загружена:', err)
  }
  renderHistory()
}

/** Поиск в локальной базе штрихов. База обновляется при первом обращении —
 *  пустой индекс иначе выглядел бы как «ничего не найдено». */
async function findBarcodeItems(): Promise<void> {
  const input = el('pricetags-sku') as HTMLInputElement | null
  if (input) addFromInput(input)
  if (skus.length === 0) {
    setStatus('введите хотя бы один код товара')
    return
  }
  const find = button('pricetags-find')
  if (find) find.disabled = true
  const known = await window.shell.barcodesStatus()
  renderDbStatus(known)
  if (known.state !== 'ready' || known.stale) setStatus('обновляем базу штрихов, это до минуты…')
  else setStatus('ищу в локальной базе…')
  try {
    const res = await window.shell.barcodesLookup(skus)
    renderDbStatus(res.status)
    if (!res.ok || !res.items) {
      barcodeItems = []
      renderResult()
      setStatus(res.error ?? 'база штрихов не ответила')
      return
    }
    barcodeItems = res.items
    renderResult()
    const lost = res.missing && res.missing.length > 0 ? `, не найдено: ${res.missing.length}` : ''
    setStatus(`найдено позиций: ${barcodeItems.length}${lost}`)
    // В историю — только то, что реально нашлось в базе. Уже известные коды не
    // трогаем: повторный поиск не должен переписывать файл и переставлять её.
    void rememberSkus(barcodeItems.map((item) => item.sku).filter((sku) => !history.includes(sku)))
  } finally {
    if (find) find.disabled = false
    refreshButtons()
  }
}

/** Лист штрихов: позиции и копии — всё, что нужно. */
async function buildBarcodePdf(): Promise<void> {
  const build = button('pricetags-build')
  if (build) build.disabled = true
  const itemsToPrint = visibleBarcodeItems()
  if (itemsToPrint.length === 0) {
    setStatus('сначала найдите позиции')
    refreshButtons()
    return
  }
  const copiesRaw = (el('barcodes-copies') as HTMLInputElement | null)?.value ?? '1'
  const copies = Number(copiesRaw)
  if (!Number.isInteger(copies) || copies < 1) {
    setStatus('сколько копий — целое число от 1')
    refreshButtons()
    return
  }
  setStatus(`собираю лист: ${itemsToPrint.length} позиций × ${copies}…`)
  try {
    const res = await window.shell.barcodesBuild(
      itemsToPrint.map((item) => item.sku),
      copies,
    )
    setStatus(
      res.ok
        ? 'PDF готов — он открыт в отдельном окне, там можно сохранить и напечатать'
        : (res.error ?? 'PDF не собран'),
    )
  } finally {
    refreshButtons()
  }
}

/** Обновление базы: db.json едет с обновлением приложения, поэтому кнопка
 *  пересобирает индекс, если файл новее прежнего (иначе — ничего не делает). */
async function refreshDb(): Promise<void> {
  const refresh = button('barcodes-refresh')
  if (refresh) refresh.disabled = true
  renderDbStatus({ state: 'building', stage: 'read' })
  setStatus('собираю базу штрихов…')
  try {
    const status = await window.shell.barcodesReload()
    renderDbStatus(status)
    // Результаты старого поиска после обновления могут быть неполны: индекс
    // мог обновиться новыми позициями. Сбрасываем строки, чтобы в PDF не ушёл
    // список по базе вчерашней.
    barcodeItems = []
    renderResult()
    setStatus(
      status.state === 'ready'
        ? `база обновлена: ${new Intl.NumberFormat('ru-RU').format(status.items ?? 0)} позиций`
        : (status.error ?? 'база не обновилась'),
    )
  } finally {
    if (refresh) refresh.disabled = false
  }
}

export function wirePricetags(next: PricetagsOverlayDeps): void {
  deps = next
  el('barcodes-refresh')?.addEventListener('click', () => void refreshDb())
  el('pricetags-history-clear')?.addEventListener('click', () => void clearHistory())
  const sku = el('pricetags-sku') as HTMLInputElement | null
  // Enter — добавить артикул и сразу найти позиции
  sku?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void findBarcodeItems()
  })
  // Список из буфера ловим на paste: иначе многострочный текст попадёт в
  // однострочное поле и потеряется.
  sku?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (!/[\n,;\t]/.test(text)) return
    event.preventDefault()
    addSkus(parseSkuInput(text))
  })
  el('pricetags-find')?.addEventListener('click', () => void findBarcodeItems())
  el('pricetags-build')?.addEventListener('click', () => void buildBarcodePdf())
  el('pricetags-close')?.addEventListener('click', closePricetags)
  el('barcodes-copies')?.addEventListener('change', (event) => {
    void persist({ pricetagCopies: Number((event.target as HTMLInputElement).value) }, 'число копий')
  })
}