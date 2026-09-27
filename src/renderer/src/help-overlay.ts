/**
 * Справочник: оверлей-карточка с клавишами и возможностями оболочки.
 * Содержимое статичное и живёт в разметке (index.html, #help-overlay) —
 * здесь только показ/скрытие и кнопки. Открывается по F1 и по кнопке «?»
 * в тулбаре, закрывается по Esc, по ✕ и по клику на затемнение.
 */
const overlayEl = (): HTMLElement | null => document.getElementById('help-overlay') as HTMLElement | null

export function isHelpOpen(): boolean {
  return Boolean(overlayEl() && !overlayEl()?.hidden)
}

export function openHelp(): void {
  const el = overlayEl()
  if (!el) return
  el.hidden = false
}

export function closeHelp(): void {
  const el = overlayEl()
  if (!el) return
  el.hidden = true
}

export function toggleHelp(): void {
  if (isHelpOpen()) closeHelp()
  else openHelp()
}

export function wireHelp(): void {
  const el = overlayEl()
  document.getElementById('btn-help')?.addEventListener('click', toggleHelp)
  document.getElementById('help-close-x')?.addEventListener('click', closeHelp)
  el?.addEventListener('click', (event) => {
    if (event.target === el) closeHelp()
  })
}
