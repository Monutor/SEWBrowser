/**
 * Локальная база полок склада: чтение shelves.json с диска и выдача гостю.
 *
 * Файл едет с приложением (electron-builder: `src/database` -> resources/database),
 * в dev лежит в исходниках. Пользователь его не правит — обновление приходит
 * новой версией SEWBrowser. Путь даёт общий database-paths: базы полок и
 * штрихов лежат рядом и резолвятся одинаково.
 *
 * Файл читается ОДИН раз за жизнь процесса и держится в памяти: он весит
 * 1.3 МБ, а инжект с полками уходит в гостя на каждую загрузку вкладки.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseShelvesFile, type ShelvesPayload } from './shelves-core'
import { getDatabaseFile } from './database-paths'

/** shelves.json в dev — в src/ рядом с проектом; в prod — в resources/ */
export function getShelvesFilePath(): string {
  return getDatabaseFile('shelves.json')
}

export interface ShelvesService {
  /** Выдача для гостя; null — базы нет или она нечитаемая (полки будут пустыми) */
  payload(): ShelvesPayload | null
}

export function createShelves(): ShelvesService {
  let cached: ShelvesPayload | null = null
  let resolved = false

  function payload(): ShelvesPayload | null {
    if (resolved) return cached
    resolved = true
    const file = getShelvesFilePath()
    try {
      if (!existsSync(file)) throw new Error(`файл не найден: ${file}`)
      const parsed = parseShelvesFile(readFileSync(file, 'utf8'))
      cached = parsed.payload
      console.log(
        `[shelves] полок ${parsed.count} (выгрузка ${parsed.payload.version || 'без версии'}), ` +
          `повторов имён отброшено: ${parsed.duplicates}`,
      )
    } catch (err) {
      console.warn('[shelves] база полок не прочитана:', err)
      cached = null
    }
    return cached
  }

  return { payload }
}