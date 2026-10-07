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
let items: Item[] = []
/** PDF собран в этой сессии: без него «Сохранить»/«Печать» бессмысленны. */
let hasPdf = false

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

/** Кнопки живут по состоянию, а не по флажкам. */
function refreshButtons(): void {
  const build = button('pricetags-build')
  const template = select('pricetags-template')
  if (build) build.disabled = items.length === 0 || !template?.value
  const save = button('pricetags-save')
  if (save) save.disabled = !hasPdf
  const print = button('pricetags-print')
  if (print) print.disabled = !hasPdf
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

function renderRows(missing: readonly string[], warning?: string): void {
  const box = el('pricetags-rows')
  if (box) {
    box.replaceChildren(
      ...items.map((item) => {
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
  if (warning) parts.push(warning)
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

async function loadStores(): Promise<void> {
  const store = select('pricetags-store')
  if (!store) return
  const res = await window.shell.pricetagsStores()
  if (!res.ok) {
    fillSelect(store, [{ value: '', label: '— магазины недоступны —' }], '')
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
  hasPdf = false
  renderChips()
  renderRows([])
  fillPaper()
  const copies = el('pricetags-copies') as HTMLInputElement | null
  if (copies) copies.value = String(deps.config()?.pricetagCopies ?? 1)
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
      hasPdf = false
      renderRows([], res.error)
      setStatus(res.error ?? 'SEW не ответил')
      return
    }
    items = res.result.items
    hasPdf = false
    const remembered = Number(deps.config()?.pricetagTemplateId ?? 0)
    fillSelect(
      select('pricetags-template'),
      res.result.templates.map((t) => ({ value: String(t.id), label: `${t.id}: ${t.name}` })),
      String(res.result.templates.some((t) => t.id === remembered) ? remembered : (res.result.templates[0]?.id ?? '')),
    )
    renderRows(res.result.missing, res.result.warning)
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
    items,
    templateId: Number(select('pricetags-template')?.value ?? '0'),
    paperColorId: Number(select('pricetags-paper')?.value ?? '1'),
    copies: Number((el('pricetags-copies') as HTMLInputElement | null)?.value ?? '1'),
  })
  hasPdf = res.ok
  setStatus(res.ok ? `PDF готов: ${res.pdfName}` : (res.error ?? 'PDF не собран'))
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
  el('pricetags-save')?.addEventListener('click', () => {
    void window.shell.pricetagsSave().then((res) =>
      setStatus(res.ok ? `сохранено: ${res.path}` : (res.error ?? 'не сохранено')),
    )
  })
  el('pricetags-print')?.addEventListener('click', () => {
    void window.shell.pricetagsPrint().then((res) =>
      setStatus(res.ok ? 'отправлено на принтер' : (res.error ?? 'не напечатано')),
    )
  })
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
    void persist({ pricetagTemplateId: Number((event.target as HTMLSelectElement).value) }, 'шаблон печати')
  })
}
