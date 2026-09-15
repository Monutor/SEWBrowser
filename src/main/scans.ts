import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** Минимальный маппинг расширения в MIME — достаточно для создания File в госте. */
function guessMime(ext: string): string {
  // extname отдаёт расширение С точкой ('.pdf') — точку срезаем.
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'pdf':
      return 'application/pdf'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'bmp':
      return 'image/bmp'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    default:
      return 'application/octet-stream'
  }
}

/** Запись об отсканированном файле в папке «Сканы» */
export interface ScanFile {
  /** Уникальный идентификатор — полный путь (стабилен пока файл на месте) */
  id: string
  name: string
  path: string
  bytes: number
  ext: string
  /** ISO-строка даты изменения */
  modifiedAt: string
}

/** Расширения, которые считаем результатом сканирования. */
const SCAN_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'])

/** Сортировка — новые в начале (по дате изменения, по убыванию). */
export function listScanFiles(folder: string): ScanFile[] {
  if (!existsSync(folder)) return []
  let entries: string[]
  try {
    entries = readdirSync(folder)
  } catch {
    return []
  }
  const files: ScanFile[] = []
  for (const entry of entries) {
    if (!SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) continue
    const full = join(folder, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    // Пропускаем «горящие» файлы: HP-софт пишет PDF не мгновенно,
    // иначе на секунду в списке появится нулевой файл.
    if (stats.size === 0) continue
    files.push({
      id: full,
      name: entry,
      path: full,
      bytes: stats.size,
      ext: extname(entry).slice(1).toLowerCase(),
      modifiedAt: stats.mtime.toISOString(),
    })
  }
  return files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
}

/** Удалить файл по пути. false — если файла нет или удаление упало. */
export function deleteScanFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/** Активные дочерние процессы — чтобы main не удержал event loop и мог почистить. */
const activeChildren = new Set<ChildProcess>()

/**
 * Разбор строки аргументов в массив для spawn: учитывает кавычки
 * ("C:\Program Files\..." и '...'), иначе — сплит по пробелам.
 * Нужно для софта типа HP G3110, который без ключа -mg3110 выдаёт ошибку.
 */
export function parseAppArgs(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  const src = (raw ?? '').trim()
  if (!src) return out
  while ((m = re.exec(src)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

/**
 * Запуск внешнего софта сканера (напр. HP). Возвращает true, если процесс
 * удалось запустить. Сам HP-софт показывает свой интерфейс (можно отсканировать
 * несколько листов) и сохраняет PDF в папку scanFolder — она задана заранее
 * в настройках самого софта.
 */
export function launchScannerApp(appPath: string, appArgs = ''): boolean {
  // Пользователи часто вставляют путь из свойств ярлыка вместе с кавычками —
  // existsSync/spawn их не понимают, поэтому срезаем окружающую пару кавычек.
  const cleanPath = (appPath ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  if (!cleanPath || !existsSync(cleanPath)) return false
  try {
    const child = spawn(cleanPath, parseAppArgs(appArgs), { stdio: ['ignore', 'ignore', 'ignore'] })
    activeChildren.add(child)
    child.on('exit', () => {
      activeChildren.delete(child)
    })
    // Процесс живёт сам по себе — main от него не зависит.
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Мониторинг папки сканов. HP-софт кладёт файл не мгновенно — поэтому на любое
 * событие (в т.ч. когда файл ещё пишется) ждём короткую паузу и перечитываем
 * папку целиком: так в списке появляется уже готовый, ненулевой файл.
 */
export function createScanWatcher(
  folder: string,
  onChange: (files: ScanFile[]) => void,
  onError?: (err: unknown) => void,
): FSWatcher | null {
  if (!folder || !existsSync(folder)) return null
  try {
    if (!statSync(folder).isDirectory()) return null
  } catch {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const notify = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => onChange(listScanFiles(folder)), 700)
  }
  let watcher: FSWatcher
  try {
    watcher = watch(folder, { persistent: true }, () => notify())
  } catch {
    return null
  }
  // Асинхронные ошибки вотчера (папку удалили, отвалилась сеть, антивирус/DLP
  // заблокировал ReadDirectoryChangesW) без слушателя 'error' превращаются
  // в uncaughtException в main-процессе («UNKNOWN: unknown error, watch»).
  watcher.on('error', (err: unknown) => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      watcher.close()
    } catch {}
    try {
      onError?.(err)
    } catch {}
  })
  // Первоначальный список — сразу, чтобы окно не ждалo первого события.
  onChange(listScanFiles(folder))
  return watcher
}

/** Результат чтения файла сканов как base64 — для предосмотра/переноса в страницу. */
export interface ScanFileContent {
  id: string
  name: string
  path: string
  bytes: number
  ext: string
  mime: string
  base64: string
}

/** Максимальный размер файла, который читаем в base64 (100 МБ). */
const SCAN_READ_MAX_BYTES = 100 * 1024 * 1024

/**
 * Прочитать файл из папки «Сканы» и вернуть его содержимое в base64.
 * Нужно гостевой странице, чтобы собрать из base64 реальный File для drag-n-drop
 * или предосмотра (в webview нет доступа к файловой системе напрямую).
 */
export function readScanFile(filePath: string): ScanFileContent | null {
  try {
    if (!existsSync(filePath)) return null
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size === 0) return null
    if (stats.size > SCAN_READ_MAX_BYTES) return null
    const buf = readFileSync(filePath)
    return {
      id: filePath,
      name: basename(filePath),
      path: filePath,
      bytes: stats.size,
      ext: extname(filePath).slice(1).toLowerCase(),
      mime: guessMime(extname(filePath)),
      base64: buf.toString('base64'),
    }
  } catch {
    return null
  }
}

/** Остановить мониторинг папки (вызвать при выходе). */
export function stopScanWatcher(watcher: FSWatcher | null): void {
  try {
    watcher?.close()
  } catch {}
}
