/** Ширина панели меню адреса — из styles.css (#address-menu) */
const MENU_WIDTH = 260
/** Отступы панели от края окна, когда кнопка близко к границе */
const EDGE = 8
/** Зазор между адресной строкой и панелью */
const GAP = 6

export interface AddressMenuElements {
  button: HTMLElement
  popup: HTMLElement
  zoomOut: HTMLElement
  zoomValue: HTMLElement
  zoomIn: HTMLElement
  find: HTMLElement
  copy: HTMLElement
  print: HTMLElement
  input: HTMLElement
}

export interface AddressMenuHooks {
  onZoom: (dir: 1 | -1 | 'reset') => void
  onFind: () => void
  onCopy: () => void
  onPrint: () => void
}

export interface AddressMenuController {
  toggle: () => void
  open: () => void
  close: () => void
  isOpen: () => boolean
  syncZoom: (factor: number) => void
}

/** Фактор масштаба → подпись вида «125%» */
export function zoomPercent(factor: number): string {
  return `${Math.round((Number.isFinite(factor) ? factor : 1) * 100)}%`
}

function viewportWidth(): number {
  try {
    return typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
  } catch {
    return 0
  }
}

/**
 * Меню «⋮» в конце адресной строки: масштаб, поиск по странице,
 * копирование адреса и печать. Закрывается по клику вне, по вводу
 * в адрес и по Escape (вызов close() добавляется в цепочку escape).
 */
export function createAddressMenu(elements: AddressMenuElements, hooks: AddressMenuHooks): AddressMenuController {
  let open = false

  const position = (): void => {
    try {
      const rect = elements.button.getBoundingClientRect()
      const width = viewportWidth()
      let left = rect.right - MENU_WIDTH
      if (width > 0 && left + MENU_WIDTH > width - EDGE) left = width - MENU_WIDTH - EDGE
      if (left < EDGE) left = EDGE
      elements.popup.setAttribute('style', `left:${Math.round(left)}px; top:${Math.round(rect.bottom + GAP)}px`)
    } catch {
      /* геометрия недоступна — панель останется там, где её поставит CSS */
    }
  }

  const close = (): void => {
    if (!open) return
    open = false
    elements.popup.hidden = true
    elements.button.setAttribute('aria-expanded', 'false')
  }

  const show = (): void => {
    if (open) return
    open = true
    elements.popup.hidden = false
    elements.button.setAttribute('aria-expanded', 'true')
    position()
  }

  const toggle = (): void => {
    if (open) close()
    else show()
  }

  // Кнопка: переключение. Панель: сброс по клику на процент, остальное — по хукам.
  elements.button.addEventListener('click', (event) => {
    ;(event as Event).stopPropagation?.()
    toggle()
  })
  elements.zoomOut.addEventListener('click', () => {
    close()
    hooks.onZoom(-1)
  })
  elements.zoomIn.addEventListener('click', () => {
    close()
    hooks.onZoom(1)
  })
  elements.zoomValue.addEventListener('click', () => {
    close()
    hooks.onZoom('reset')
  })
  elements.find.addEventListener('click', () => {
    close()
    hooks.onFind()
  })
  elements.copy.addEventListener('click', () => {
    close()
    hooks.onCopy()
  })
  elements.print.addEventListener('click', () => {
    close()
    hooks.onPrint()
  })
  // Ввод в адресную строку означает «меню больше не нужно».
  elements.input.addEventListener('input', close)
  // Клик по самой панели не должен её закрывать (обработчик на документе).
  elements.popup.addEventListener('click', (event) => {
    ;(event as Event).stopPropagation?.()
  })

  const doc = typeof document !== 'undefined' ? document : null
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('click', (event) => {
      const target = (event as Event).target as unknown
      if (!open) return
      if (target === elements.button || elements.popup.contains(target as Node)) return
      close()
    })
  }

  elements.popup.hidden = true
  elements.button.setAttribute('aria-expanded', 'false')
  elements.zoomValue.textContent = zoomPercent(1)

  return {
    toggle,
    open: show,
    close,
    isOpen: () => open,
    syncZoom: (factor: number) => {
      elements.zoomValue.textContent = zoomPercent(factor)
    },
  }
}
