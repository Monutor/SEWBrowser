import { activeView } from './tabs'

const findbar = (): HTMLElement | null => document.getElementById('findbar')
const findInput = (): HTMLInputElement | null => document.getElementById('find-input') as HTMLInputElement | null
const findCount = (): HTMLElement | null => document.getElementById('find-count')

let findActive = false

export function isFindActive(): boolean {
  return findActive
}

/** Счётчик совпадений в findbar; вызывается из обработчика found-in-page. */
export function renderFindCount(matches: number, activeMatchOrdinal: number): void {
  const count = findCount()
  if (!count) return
  count.textContent = matches === 0 ? '0' : `${activeMatchOrdinal}/${matches}`
}

/** true, если событие пришло из поля поиска (используется в Esc-цепочке). */
export function isFindInput(target: EventTarget | null): boolean {
  return !!findInput() && target === findInput()
}

export function openFind(): void {
  const bar = findbar()
  const input = findInput()
  if (!bar || !input) return
  bar.hidden = false
  findActive = true
  input.focus()
  input.select()
  if (input.value) doFind(true, false)
}

export function closeFind(): void {
  if (!findActive) return
  findActive = false
  if (findbar()) findbar()!.hidden = true
  if (findCount()) findCount()!.textContent = ''
  const view = activeView()
  if (!view) return
  try {
    view.stopFindInPage('clearSelection')
  } catch {
    // игнорируем
  }
}

function doFind(forward: boolean, findNext = true): void {
  const text = findInput()?.value ?? ''
  if (!text) {
    if (findCount()) findCount()!.textContent = ''
    return
  }
  const view = activeView()
  if (!view) return
  try {
    view.findInPage(text, { forward, findNext })
  } catch {
    // страница не готова — игнорируем
  }
}

export function wireFindbar(): void {
  findInput()?.addEventListener('input', () => doFind(true, false))
  findInput()?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      doFind(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
    }
  })
  document.getElementById('find-prev')?.addEventListener('click', () => doFind(false))
  document.getElementById('find-next')?.addEventListener('click', () => doFind(true))
  document.getElementById('find-close')?.addEventListener('click', closeFind)
}
