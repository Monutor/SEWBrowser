import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Хук, вызываемый после записи во временный файл и ДО rename. Оставлен не для
 * тестов как таковых, а как явное имя для точки отказа: это ровно тот момент,
 * когда процесс может умереть (питание, OOM, kill), и именно его надо уметь
 * пережить. Тесты пользуются тем же хуком, чтобы не гадать о порядке.
 */
export type BeforeCommit = () => void

/**
 * Атомарная запись JSON-файла: пишем во временный файл рядом с целью и
 * переименовываем его на место.
 *
 * Зачем. Все JSON-хранилища приложения (config.json, plugin-data/*, downloads,
 * credentials, folder-passwords, last-account) раньше писались обычным
 * writeFileSync, то есть обрезали старый файл и писали новое содержимое прямо в
 * него. Любой обрыв — питание, OOM, краш main, EBUSY от антивируса — оставлял
 * обрезанный файл, а читатели глотали это в `catch { return {} }`. Итог
 * выглядел как «настроек нет»: пустые вкладки, пустые папки, пустые аккаунты.
 * Худший случай — config.json: следующий же config:set затирал его дефолтами
 * навсегда, и вкладки с папками было уже не вернуть.
 *
 * Почему temp+rename достаточно. rename в пределах одной файловой системы
 * атомарен (на Windows это MoveFileEx с MOVEFILE_REPLACE_EXISTING): читатель
 * видит либо старый файл целиком, либо новый целиком, но не половину. Именно
 * поэтому временный файл обязан лежать в ТОМ ЖЕ каталоге, что и цель: rename
 * через границу томов не атомарен, и тогда весь смысл теряется.
 *
 * Порядок шагов важен: сначала сериализация, потом каталоги, потом запись.
 * JSON.stringify падает на циклических объектах и BigInt; если бы он шёл после
 * открытия файла, портился бы уже сам целевой файл.
 */
export function writeJsonAtomic(filePath: string, data: unknown, beforeCommit?: BeforeCommit): void {
  const text = `${JSON.stringify(data, null, 2)}\n`
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  // Имя temp-файла уникально на вызов: два соседних вызова на одну цель не
  // должны переименовать чужой файл и потерять одну из записей.
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${nextSuffix()}.tmp`)
  let handle: number | null = null
  try {
    handle = openSync(tempPath, 'wx')
    writeFileSync(handle, text, 'utf-8')
    // Сбрасываем буферы ОС на диск ДО rename: иначе переименованный файл может
    // оказаться пустым после сбоя питания. Атомарность переименования тут не
    // спасёт — данные-то ещё не дошли до носителя.
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    beforeCommit?.()
    renameSync(tempPath, filePath)
  } catch (err) {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        // дескриптор мог закрыться сам при ошибке записи
      }
    }
    // Временный файл — мусор: без уборки он копился бы в plugin-data после
    // каждой неудачной записи.
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // файла нет или он занят — уборка не должна замаскировать исходную ошибку
    }
    throw err
  }
}

/** Счётчик для имени temp-файла: Date.now() в пределах мс совпадает. */
let tempCounter = 0

function nextSuffix(): string {
  tempCounter = (tempCounter + 1) % 1_000_000
  return tempCounter.toString(36)
}
