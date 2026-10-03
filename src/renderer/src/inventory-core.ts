/**
 * Чистая логика кнопки-тумблера панели «Автоподсчёт ЛП»: разбор ответа гостя
 * и подпись кнопки. DOM и executeJavaScript — в inventory-panel.ts.
 */

/**
 * Ответ гостя о видимости панели — строка '1'/'0' (executeJavaScript клонирует
 * значение, поэтому отдаём строку, а не boolean). '?' и любой мусор означают,
 * что плагина в госте нет (выключен в настройках или ещё не инжектился).
 */
export function parseGuestFlag(raw: unknown): boolean | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '1') return true
  if (text === '0') return false
  return null
}

/** Подпись тумблера: что сделает следующий клик. */
export function toggleTitle(on: boolean): string {
  return on ? 'Скрыть панель «Автоподсчёт ЛП»' : 'Показать панель «Автоподсчёт ЛП»'
}