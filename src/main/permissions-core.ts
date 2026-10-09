/**
 * Политика синхронной проверки разрешений (`session.setPermissionCheckHandler`).
 *
 * Chromium различает два пути:
 *   1) `RequestPermission` — асинхронный, попадает в `setPermissionRequestHandler`,
 *      где мы показываем диалог пользователю (камера, микрофон, геолокация, буфер).
 *   2) `CheckPermission` — синхронный, вызывается ДО запроса. Если check-хендлер
 *      не установлен, Electron возвращает `granted` (в electron_permission_manager.cc:
 *      `if (check_handler_.is_null()) return true;`), и разрешение выдаётся молча —
 *      диалог не показывается, в лог ничего не пишется.
 *
 * Часть check-only разрешений (openExternal, local-network, window-management,
 * persistent-storage, midi, hid, serial, usb, …) запроса за собой не тянет вовсе,
 * поэтому без check-хендлера они выдаются гостю без спроса. Для гостя на
 * недоверенной странице это лишние возможности, которые никто не одобрял.
 *
 * Здесь allowlist: синхронно разрешаем только то, что гостю нужно и что не даёт
 * доступа к системе. Остальное → false, дальше разбирается request-хендлер
 * (диалог или отказ).
 */
// Имена приходят от Chromium в camelCase ('pointerLock'), а сравниваем мы в
// нижнем регистре — иначе регистр проверки обходится, а сам список перестаёт
// совпадать с прилетевшим именем.
export const SAFE_CHECK_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'fullscreen',
  'automatic-fullscreen',
  'pointerlock',
  // Запись в буфер: у Chromium это check-only, request не приходит. Нужна
  // плагину sku-copy (features/sku-copy/content.js — navigator.clipboard.writeText).
  'clipboard-sanitized-write',
])

/** Синхронная проверка разрешения: true — разрешить без вопроса. */
export function isPermissionCheckAllowed(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return SAFE_CHECK_PERMISSIONS.has(raw.toLowerCase())
}
