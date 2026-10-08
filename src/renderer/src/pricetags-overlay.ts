import { PAPER_COLORS, parseSkuInput } from '../../shared/pricetags-core'
import { setStatus } from './status-ui'

export interface PricetagsOverlayDeps {
  config(): ShellConfig | null
  savePricetagsConfig(patch: Partial<ShellConfig>): Promise<ShellConfig>
}

interface Item {
  sku: string
  name: string
  price: number
}

let deps!: PricetagsOverlayDeps
/** Артикулы живут только внутри сессии окна — намеренно не сохраняем. */
let skus: string[] = []
/** Полный результат последнего поиска: по нему мы сужаем список чипами. */
let items: Item[] = []
/** Предупреждение SEW из последнего поиска — оно про поиск, а не про чипы,
 *  поэтому при сужении списка сохраняется. */
let warning: string | undefined

function el(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function overlay(): HTMLElement | null {
  return el('pricetags-overlay')
}

function select(id: string): HTMLSelectElement | null {
  return el(id) as HTMLSelectElement | null
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
function visibleItems(): Item[] {
  return items.filter((item) => skus.includes(item.sku))
}

/** Рисуем строки и «не найдены» по текущему набору чипов. Запрос в SEW не нужен:
 *  данные по оставшимся артикулам уже в `items`, поэтому убранный артикул
 *  исчезает сразу, без повторного нажатия «Найти». */
function renderResult(): void {
  renderRows(visibleItems(), skus.filter((sku) => !items.some((item) => item.sku === sku)), warning)
  refreshButtons()
}

/** Кнопки живут по состоянию, а не по флажкам. */
function refreshButtons(): void {
  const build = button('pricetags-build')
  const template = select('pricetags-template')
  if (build) build.disabled = visibleItems().length === 0 || !template?.value
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

function addSkus(values: readonly string[]): void {
  let added = 0
  for (const value of values) {
    if (skus.includes(value)) continue
    skus.push(value)
    added += 1
  }
  if (added === 0) return
  renderChips()
  setStatus(`артикулов в списке: ${skus.length}`)
}

function addFromInput(input: HTMLInputElement): void {
  addSkus(parseSkuInput(input.value))
  input.value = ''
}

const formatPrice = (value: number): string => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`

function renderRows(rows: readonly Item[], missing: readonly string[], warningText?: string): void {
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
        name.textContent = item.name
        const price = document.createElement('span')
        price.className = 'price'
        price.textContent = formatPrice(item.price)
        row.append(sku, name, price)
        return row
      }),
    )
  }
  const miss = el('pricetags-missing')
  if (!miss) return
  const parts: string[] = []
  if (missing.length > 0) parts.push(`не найдены: ${missing.join(', ')}`)
  if (warningText) parts.push(warningText)
  miss.textContent = parts.join(' · ')
  miss.hidden = parts.length === 0
}

function fillSelect(
  target: HTMLSelectElement | null,
  options: Array<{ value: string; label: string }>,
  selected?: string,
): void {
  if (!target) return
  target.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement('option')
      node.value = option.value
      node.textContent = option.label
      return node
    }),
  )
  if (selected && options.some((option) => option.value === selected)) target.value = selected
}

function fillPaper(): void {
  const paper = select('pricetags-paper')
  if (!paper) return
  fillSelect(
    paper,
    PAPER_COLORS.map((color) => ({ value: String(color.id), label: color.name })),
    paper.value || '1',
  )
}

/** Логин, под кем открыта сессия SEW, — из перехвата x-username у живой SPA.
 *  Подсистема ценников работает от него, и при входе под другим сотрудником
 *  SEW отвечает «Access Denied» без всяких подробностей. Поэтому несовпадение
 *  показываем сами, до первой попытки собрать PDF. */
let sessionUsername = ''

function renderLoginHint(live?: string): void {
  const box = el('pricetags-login-hint')
  const text = el('pricetags-login-hint-text')
  sessionUsername = typeof live === 'string' ? live.trim() : ''
  if (!box || !text) return
  if (!sessionUsername) {
    box.hidden = true
    return
  }
  const configured = (el('pricetags-username') as HTMLInputElement | null)?.value.trim() ?? ''
  if (configured && configured !== sessionUsername) {
    text.textContent = `сессия SEW открыта под ${sessionUsername}, в поле ${configured} — SEW откажет в доступе`
  } else if (!configured) {
    text.textContent = `сессия SEW открыта под ${sessionUsername}`
  } else {
    // Логины совпали — предупреждать не о чем.
    box.hidden = true
    return
  }
  box.hidden = false
}

async function loadStores(): Promise<void> {
  const store = select('pricetags-store')
  if (!store) return
  const res = await window.shell.pricetagsStores()
  renderLoginHint(res.sessionUsername)
  if (!res.ok) {
    // Причину дублируем в подписи селекта, а не только в статус: статус общий
    // на весь оверлей и следующим кликом («Найти») перезаписывается ошибкой
    // поиска — из-за этого сбой списка магазинов был не виден вовсе.
    const why = res.error ? `: ${res.error}` : ''
    fillSelect(store, [{ value: '', label: `— магазины недоступны${why} —` }], '')
    setStatus(res.error ?? 'не удалось получить список магазинов')
    return
  }
  const cfg = deps.config()
  const remembered = cfg?.pricetagObjectId
  const preferred =
    typeof remembered === 'string' && res.stores.some((s) => s.id === remembered)
      ? remembered
      : (res.current ?? res.stores[0].id)
  fillSelect(
    store,
    res.stores.map((s) => ({ value: s.id, label: s.name })),
    preferred,
  )
}

/** Откат поля, если main не принял значение — образец `saveStockObjectId`
 *  в src/renderer/src/stock-report.ts. */
async function persist(patch: Partial<ShellConfig>, label: string): Promise<void> {
  const next = await deps.savePricetagsConfig(patch)
  const keys = Object.keys(patch) as Array<keyof ShellConfig>
  const rejected = keys.some((key) => String(next[key]) !== String(patch[key]))
  if (rejected) {
    setStatus(`${label} не принят настройками — значение откачено`)
    await openPricetags()
    return
  }
  setStatus(`${label} сохранён`)
}

export async function openPricetags(): Promise<void> {
  const node = overlay()
  if (!node) return
  node.hidden = false
  skus = []
  items = []
  warning = undefined
  renderChips()
  renderResult()
  fillPaper()
  const copies = el('pricetags-copies') as HTMLInputElement | null
  if (copies) copies.value = String(deps.config()?.pricetagCopies ?? 1)
  const username = el('pricetags-username') as HTMLInputElement | null
  if (username) username.value = deps.config()?.sewUsername ?? ''
  fillSelect(select('pricetags-template'), [], '')
  refreshButtons()
  await loadStores()
  el('pricetags-sku')?.focus()
}

async function findItems(): Promise<void> {
  const input = el('pricetags-sku') as HTMLInputElement | null
  if (input) addFromInput(input)
  if (skus.length === 0) {
    setStatus('введите хотя бы один артикул')
    return
  }
  const find = button('pricetags-find')
  if (find) find.disabled = true
  setStatus('ищу позиции в SEW…')
  try {
    const res = await window.shell.pricetagsPrepare(select('pricetags-store')?.value ?? '', skus)
    if (!res.ok || !res.result) {
      items = []
      renderRows([], [], res.error)
      setStatus(res.error ?? 'SEW не ответил')
      return
    }
    items = res.result.items
    warning = res.result.warning
    const remembered = Number(deps.config()?.pricetagTemplateId ?? 0)
    fillSelect(
      select('pricetags-template'),
      res.result.templates.map((t) => ({ value: String(t.id), label: `${t.id}: ${t.name}` })),
      String(res.result.templates.some((t) => t.id === remembered) ? remembered : (res.result.templates[0]?.id ?? '')),
    )
    renderResult()
    const lost = res.result.missing.length > 0 ? `, не найдено: ${res.result.missing.length}` : ''
    setStatus(`найдено позиций: ${items.length}${lost}`)
  } finally {
    if (find) find.disabled = false
    refreshButtons()
  }
}

async function buildPdf(): Promise<void> {
  const build = button('pricetags-build')
  if (build) build.disabled = true
  setStatus('SEW рендерит ценники, это до минуты…')
  const res = await window.shell.pricetagsBuild({
    objectId: select('pricetags-store')?.value ?? '',
    items: visibleItems(),
    templateId: Number(select('pricetags-template')?.value ?? '0'),
    paperColorId: Number(select('pricetags-paper')?.value ?? '1'),
    copies: Number((el('pricetags-copies') as HTMLInputElement | null)?.value ?? '1'),
  })
  // Собранный PDF открывается отдельным окном просмотра: сохранить его и
// отправить на принтер можно там. Своего сообщения с именем файла в статусе
// оставлять незачем — имя видно в заголовке окна.
setStatus(res.ok ? 'PDF готов — он открыт в отдельном окне, там можно сохранить и напечатать' : (res.error ?? 'PDF не собран'))
  refreshButtons()
}

export function wirePricetags(next: PricetagsOverlayDeps): void {
  deps = next
  const sku = el('pricetags-sku') as HTMLInputElement | null
  // Enter — добавить артикул и сразу найти позиции
  sku?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void findItems()
  })
  // Список из буфера ловим на paste: иначе многострочный текст попадёт в
  // однострочное поле и потеряется.
  sku?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (!/[\n,;\t]/.test(text)) return
    event.preventDefault()
    addSkus(parseSkuInput(text))
  })
  el('pricetags-find')?.addEventListener('click', () => void findItems())
el('pricetags-build')?.addEventListener('click', () => void buildPdf())
el('pricetags-close')?.addEventListener('click', closePricetags)
  el('pricetags-store')?.addEventListener('change', (event) => {
    void persist({ pricetagObjectId: (event.target as HTMLSelectElement).value }, 'код магазина')
  })
  el('pricetags-paper')?.addEventListener('change', (event) => {
    void persist({ pricetagPaperColorId: Number((event.target as HTMLSelectElement).value) }, 'цвет бумаги')
  })
  el('pricetags-copies')?.addEventListener('change', (event) => {
    void persist({ pricetagCopies: Number((event.target as HTMLInputElement).value) }, 'число копий')
  })
el('pricetags-template')?.addEventListener('change', (event) => {
    void persist({ pricetagTemplateId: Number((event.target as HTMLSelectElement).value) }, 'шаблон ценника')
  })
  // Логин сохраняем по blur, а не по каждому нажатию: он уходит в заголовок
  // x-username, и persist() перерисовывает оверлей при отказе — на полувведённом
  // номере это мешало бы. Пустая строка допустима («не отправлять»), поэтому
  // чистим value, иначе пробелы превратились бы в молча отброшенный патч.
  el('pricetags-username')?.addEventListener('blur', (event) => {
    const input = event.target as HTMLInputElement
    const value = input.value.trim()
    if (input.value !== value) input.value = value
    void persist({ sewUsername: value }, 'логин SEW')
  })
  // Подставить логин живой сессии: после правки поля подсказка обязана уйти,
  // иначе она продолжала бы требовать то, что уже сделано.
  el('pricetags-login-fix')?.addEventListener('click', () => {
    if (!sessionUsername) return
    const input = el('pricetags-username') as HTMLInputElement | null
    if (input) input.value = sessionUsername
    void persist({ sewUsername: sessionUsername }, 'логин SEW')
    renderLoginHint(sessionUsername)
  })
}
