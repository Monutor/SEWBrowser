/** Минимальная форма KeyboardEvent, нужная разбору хоткея. */
export interface ShortcutKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Буквы — по event.code (не зависит от раскладки клавиатуры) */
export function shortcutFromEvent(event: ShortcutKeyEvent): ShortcutName | null {
  const mod = event.ctrlKey || event.metaKey
  const { key, code } = event
  // Хоткеи вкладок — перед F5/templates, чтобы Ctrl+Shift+T остался шаблонами.
  if (mod && !event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) {
    return `tab-${event.code.slice(5)}` as 'tab-1'
  }
  if (mod && !event.shiftKey && !event.altKey && (event.code === 'KeyT' || event.key === 't')) return 'new-tab'
  if (mod && !event.shiftKey && !event.altKey && (event.code === 'KeyW' || event.key === 'w')) return 'close-tab'
  if (mod && (event.code === 'Tab' || event.key === 'Tab')) return event.shiftKey ? 'prev-tab' : 'next-tab'
  if (key === 'F5') return mod ? 'hard-reload' : 'reload'
  if (mod && code === 'KeyR') return 'reload'
  if (mod && event.shiftKey && code === 'KeyL') return 'accounts'
  if (mod && event.shiftKey && code === 'KeyT') return 'templates'
  if (mod && event.shiftKey && code === 'KeyP') return 'pricetags'
  if (mod && code === 'KeyL') return 'focus-address'
  if (mod && code === 'KeyF') return 'find'
  if (mod && code === 'KeyP') return 'print'
  if (mod && event.shiftKey && code === 'KeyS') return 'screenshot'
  // Numpad: DOM-key зависит от NumLock/раскладки, поэтому ловим и по code
  // (паритет с guestShortcutName в main, где numpad маппится явно).
  if (mod && (key === '=' || key === '+' || code === 'NumpadAdd')) return 'zoom-in'
  if (mod && (key === '-' || key === '_' || code === 'NumpadSubtract')) return 'zoom-out'
  if (mod && (key === '0' || code === 'Numpad0')) return 'zoom-reset'
  if (mod && code === 'Comma') return 'settings'
  if (event.altKey && key === 'ArrowLeft') return 'back'
  if (event.altKey && key === 'ArrowRight') return 'forward'
  if (key === 'F11') return 'fullscreen'
  if (key === 'F1' && !mod) return 'help'
  if (key === 'Escape') return 'escape'
  return null
}
