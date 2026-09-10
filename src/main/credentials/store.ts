import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Аккаунты SEW (табельный номер + пароль + ФИО-подпись).
 * Пароль хранится ТОЛЬКО в шифрованном виде: safeStorage ОС (DPAPI в Windows),
 * base64-блоб в credentials.json рядом с конфигом. Открытым текстом — нигде.
 */
export interface AccountPublic {
  id: string
  fio: string
  tabNum: string
  updatedAt: number
}

interface StoredAccount extends AccountPublic {
  passwordEnc: string
}

function credentialsFile(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function readAll(): StoredAccount[] {
  const file = credentialsFile()
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is StoredAccount =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as StoredAccount).id === 'string' &&
        typeof (a as StoredAccount).tabNum === 'string' &&
        typeof (a as StoredAccount).passwordEnc === 'string',
    )
  } catch {
    // повреждённый файл — начинаем с пустого списка
    return []
  }
}

function writeAll(accounts: StoredAccount[]): void {
  const file = credentialsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(accounts, null, 2), 'utf-8')
}

function toPublic(a: StoredAccount): AccountPublic {
  return { id: a.id, fio: a.fio, tabNum: a.tabNum, updatedAt: a.updatedAt }
}

export function isCredentialsEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function listAccounts(): AccountPublic[] {
  return readAll().map(toPublic)
}

export interface SaveAccountInput {
  id?: string
  fio: string
  tabNum: string
  /** Пустой пароль при обновлении (id задан) = оставить прежний; при создании — обязателен */
  password: string
}

export function saveAccount(input: SaveAccountInput): AccountPublic {
  if (!isCredentialsEncryptionAvailable()) {
    throw new Error('Шифрохранилище ОС недоступно — сохранить пароль нельзя')
  }
  const fio = input.fio.trim()
  const tabNum = input.tabNum.trim()
  if (!tabNum) throw new Error('Табельный номер обязателен')
  const all = readAll()
  if (input.id) {
    const existing = all.find((a) => a.id === input.id)
    if (!existing) throw new Error('Аккаунт не найден')
    existing.fio = fio
    existing.tabNum = tabNum
    existing.updatedAt = Date.now()
    if (input.password) {
      existing.passwordEnc = safeStorage.encryptString(input.password).toString('base64')
    }
    writeAll(all)
    return toPublic(existing)
  }
  if (!input.password) throw new Error('Пароль обязателен')
  const created: StoredAccount = {
    id: randomUUID(),
    fio,
    tabNum,
    passwordEnc: safeStorage.encryptString(input.password).toString('base64'),
    updatedAt: Date.now(),
  }
  all.push(created)
  writeAll(all)
  return toPublic(created)
}

export function removeAccount(id: string): boolean {
  const all = readAll()
  const next = all.filter((a) => a.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  if (getLastUsedAccountId() === id) setLastUsedAccountId(null)
  return true
}

function lastAccountFile(): string {
  return join(app.getPath('userData'), 'last-account.json')
}

/**
 * Кого последним использовали для автовхода (окно «Аккаунты SEW»).
 * Нужно для атрибуции загрузок: кто скачал файл.
 */
export function getLastUsedAccountId(): string | null {
  try {
    if (!existsSync(lastAccountFile())) return null
    const parsed: unknown = JSON.parse(readFileSync(lastAccountFile(), 'utf-8'))
    const id = (parsed as { accountId?: unknown } | null)?.accountId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

export function setLastUsedAccountId(id: string | null): void {
  try {
    mkdirSync(dirname(lastAccountFile()), { recursive: true })
    writeFileSync(lastAccountFile(), JSON.stringify({ accountId: id ?? null }), 'utf-8')
  } catch (err) {
    console.warn('[credentials] failed to write last account:', err)
  }
}

/** Расшифрованные секреты — выдаются только для автозаполнения формы входа */
export function getAccountSecrets(id: string): { tabNum: string; password: string } | null {
  const found = readAll().find((a) => a.id === id)
  if (!found) return null
  try {
    return {
      tabNum: found.tabNum,
      password: safeStorage.decryptString(Buffer.from(found.passwordEnc, 'base64')),
    }
  } catch {
    return null
  }
}
