/**
 * История введённых кодов товара на диске: `%APPDATA%/SEWBrowser/barcode-history.json`.
 *
 * Отдельный файл, а не поле в config.json: история растёт и переписывается на
 * каждом вводе, а конфиг — это настройки, их читают по живому пути. Пишем
 * атомарно (writeJsonAtomic), чтобы оборванная запись не оставила битый JSON.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './json-file'
import { mergeHistory, parseHistory } from './barcode-history-core'

export interface BarcodeHistory {
  /** Коды товара, новые сверху, без дублей */
  skus: string[]
  /** Когда история менялась последний раз (для отладки и «свежести» подсказки) */
  updatedAt: number
}

function file(): string {
  return join(app.getPath('userData'), 'barcode-history.json')
}

export function createBarcodeHistory(): {
  list(): BarcodeHistory
  add(skus: string[]): BarcodeHistory
  clear(): BarcodeHistory
} {
  /** Отдаём ровно файл истории: renderer ждёт объект с полем skus, а не голый
   *  массив. Раньше здесь возвращался массив, и оверлей тихо показывал «пусто»
   *  (saved.skus у массива — undefined). */
  function read(): BarcodeHistory {
    const path = file()
    if (!existsSync(path)) return { skus: [], updatedAt: 0 }
    try {
      const text = readFileSync(path, 'utf-8')
      const meta = JSON.parse(text) as { updatedAt?: unknown }
      return {
        skus: parseHistory(text),
        updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
      }
    } catch (err) {
      // Битый файл не должен ломать оверлей: молча начинаем с пустой истории,
      // следующая запись перезапишет файл нормальным содержимым.
      console.warn('[barcodes:history] файл истории не прочитан:', err)
      return { skus: [], updatedAt: 0 }
    }
  }

  function write(skus: string[]): BarcodeHistory {
    const payload: BarcodeHistory = { skus, updatedAt: Date.now() }
    try {
      writeJsonAtomic(file(), payload)
    } catch (err) {
      // История — подсказка удобства, а не данные: её потеря не должна мешать
      // печати, поэтому молча пишем в консоль и работаем дальше.
      console.warn('[barcodes:history] история не сохранена:', err)
    }
    return payload
  }

  return {
    list: () => read(),
    add: (skus: string[]) => write(mergeHistory(read().skus, Array.isArray(skus) ? skus : [])),
    clear: () => write([]),
  }
}