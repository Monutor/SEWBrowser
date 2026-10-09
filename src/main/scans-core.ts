import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Чистая логика проверки путей для фичи «Сканы». Без DOM и без electron —
 * поэтому тестируется обычным node --test.
 *
 * Зачем: id файла скана — это полный путь на диске, и он приходит в main
 * ОТ ГОСТЕВОЙ СТРАНИЦЫ (недоверенный SPA seт.mvideoeldorado.ru) через
 * window.__sewScansReq. Без проверки пути страница читала/удаляла/открывала
 * любой файл на диске (base64 возвращался ей обратно).
 */

/** Префикс, которым main помечает файл, выбранный пользователем в диалоге. */
const PICKED_PREFIX = 'picked::'

/** Папка сканов из конфига: интересует только path, остальные поля — мимо. */
export type ScanFolderLike = { path?: unknown }

/** Привести путь к канону для сравнения: абсолютный, без '..', регистр по ФС. */
export function normalizeScanPath(filePath: string): string {
  const abs = resolve(filePath ?? '')
  // На Windows/NTFS регистр не значим; на posix — значим.
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** Путь лежит строго ВНУТРИ папки (включая подпапки). */
export function isWithinFolder(filePath: string, folder: string): boolean {
  if (!filePath || !folder) return false
  const rel = relative(normalizeScanPath(folder), normalizeScanPath(filePath))
  if (!rel) return false // это сама папка, а не файл в ней
  // relative возвращает '..' или '../x', когда цель вне папки; на разных
  // дисках/UNC — абсолютный путь (isAbsolute).
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false
  return true
}

export function isWithinScanFolders<T extends ScanFolderLike>(
  filePath: string,
  folders: readonly T[] | null | undefined,
): boolean {
  if (!Array.isArray(folders) || !folders.length) return false
  return folders.some((folder) => {
    if (!folder || typeof folder.path !== 'string' || !folder.path) return false
    return isWithinFolder(filePath, folder.path)
  })
}

export function isPickedScanId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(PICKED_PREFIX)
}

export function pickedScanPath(id: string): string {
  return isPickedScanId(id) ? id.slice(PICKED_PREFIX.length) : id
}

/**
 * Главный предохранитель: путь из гостя можно трогать только если он лежит
 * в настроенной папке сканов ИЛИ файл реально выбрал пользователь в диалоге
 * scans:pick (тогда путь лежит в реестре picked).
 */
export function isAllowedScanTarget<T extends ScanFolderLike>(
  id: unknown,
  folders: readonly T[] | null | undefined,
  picked: ReadonlySet<string>,
): boolean {
  if (typeof id !== 'string' || !id) return false
  if (isPickedScanId(id)) {
    const path = pickedScanPath(id)
    if (!path) return false
    return picked.has(normalizeScanPath(path))
  }
  return isWithinScanFolders(id, folders)
}