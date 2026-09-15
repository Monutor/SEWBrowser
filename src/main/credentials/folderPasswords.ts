import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Пароли к папкам вкладок. Хранятся ТОЛЬКО в шифрованном виде: safeStorage ОС
 * (DPAPI в Windows), base64-блоб в folder-passwords.json рядом с конфигом.
 * Открытым текстом — нигде. Связь с папкой через NavFolder.passwordId.
 */
interface StoredFolderPassword {
  id: string
  folderId: string
  passwordEnc: string
}

function file(): string {
  return join(app.getPath('userData'), 'folder-passwords.json')
}

function readAll(): StoredFolderPassword[] {
  const f = file()
  if (!existsSync(f)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is StoredFolderPassword =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as StoredFolderPassword).id === 'string' &&
        typeof (a as StoredFolderPassword).folderId === 'string' &&
        typeof (a as StoredFolderPassword).passwordEnc === 'string',
    )
  } catch {
    // повреждённый файл — начинаем с пустого списка
    return []
  }
}

function writeAll(all: StoredFolderPassword[]): void {
  const f = file()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(all, null, 2), 'utf-8')
}

export function isFolderPasswordEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Сохранить пароль папки (создание или замена существующего). Пустой пароль —
 * снимает защиту (удаление записи). Возвращает id записи (для NavFolder.passwordId)
 * или null, если пароль пустой или шифрохранилище недоступно.
 */
export function saveFolderPassword(folderId: string, password: string): string | null {
  const trimmed = (password ?? '').trim()
  if (!isFolderPasswordEncryptionAvailable()) return null
  if (!trimmed) {
    clearFolderPassword(folderId)
    return null
  }
  const all = readAll()
  const existing = all.find((a) => a.folderId === folderId)
  if (existing) {
    existing.passwordEnc = safeStorage.encryptString(trimmed).toString('base64')
  } else {
    all.push({ id: randomUUID(), folderId, passwordEnc: safeStorage.encryptString(trimmed).toString('base64') })
  }
  writeAll(all)
  return (existing ?? all.at(-1))?.id ?? null
}

/** Снять защиту папки (удалить запись с паролем). */
export function clearFolderPassword(folderId: string): void {
  const all = readAll()
  const next = all.filter((a) => a.folderId !== folderId)
  if (next.length === all.length) return
  writeAll(next)
}

/** Проверить введённый пароль папки. Ложь, если защита нет или шифрование недоступно. */
export function verifyFolderPassword(folderId: string, password: string): boolean {
  const found = readAll().find((a) => a.folderId === folderId)
  if (!found || !isFolderPasswordEncryptionAvailable()) return false
  try {
    const plain = safeStorage.decryptString(Buffer.from(found.passwordEnc, 'base64'))
    return plain === (password ?? '')
  } catch {
    return false
  }
}
