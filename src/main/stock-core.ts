import { extname } from 'node:path'
import { normalizeScanPath } from './scans-core.ts'

/**
 * Чистая логика допуска пути к файлу остатков для плагина sew-inventory.
 *
 * Зачем: manualPath приходит в main ОТ ГОСТЕВОЙ СТРАНИЦЫ (недоверенный SPA
 * seт.mvideoeldorado.ru) через window.__sewInventoryReq. Без проверки пути
 * страница читала произвольный файл с диска (разбор уходил обратно в неё).
 *
 * Два пути, оба легальны:
 *  1) файл реально выбрал пользователь в диалоге stock:pick-file — тогда путь
 *     лежит в реестре picked (расширение может быть каким угодно);
 *  2) ручной ввод пути в панели плагина — штатная фича UI, но ограничиваемся
 *     расширением xlsx/xls: содержимое такого файла всё равно уходит в main
 *     на разбор, а не «как есть» в страницу.
 */

const STOCK_EXTS = new Set(['.xlsx', '.xls'])

export function isAllowedStockTarget(
  manualPath: unknown,
  picked: ReadonlySet<string>,
): boolean {
  if (typeof manualPath !== 'string') return false
  const trimmed = manualPath.trim()
  if (!trimmed) return false
  if (picked.has(normalizeScanPath(trimmed))) return true
  return STOCK_EXTS.has(extname(trimmed).toLowerCase())
}
