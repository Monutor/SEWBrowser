/**
 * Временная разблокировка защищённой папки вкладок («запомнить пароль»):
 * после верного ввода пароль не спрашивается заново, пока не выйдет срок.
 *
 * Только в памяти и без таймеров: на диск не пишем, протухшие записи вычищаем
 * лениво при проверке. Перезапуск приложения всё забывает — пароль спрашивается
 * снова. Модуль чистый (без Electron), чтобы гонять через node --test.
 */
export interface FolderUnlockStore {
  /** Запомнить пароль папки на minutes. Нечисло/≤0 — без запоминания. */
  unlock(folderId: string, minutes: number): void
  /** Разрешена ли папка прямо сейчас; попутно чистит протухшие записи. */
  isUnlocked(folderId: string): boolean
  /** Снять разблокировку (пароль сменили/сняли либо вход без «запомнить»). */
  lock(folderId: string): void
  /** Снять все разблокировки. */
  clear(): void
}

/**
 * Срок «запомнить пароль» из настроек: целые минуты 1..1440 (сутки), мусор и
 * нечисло — fallback (дефолт 5). Меньше минуты держать бессмысленно, а 0 («не
 * запоминать») делает галку в диалоге бессмысленной — не поддерживаем.
 */
export function normalizeRememberMinutes(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  if (n < 1) return 1
  return Math.min(n, 1440)
}

export function createFolderUnlockStore(now: () => number = Date.now): FolderUnlockStore {
  /** folderId -> метка времени, до которой папка открыта. */
  const grants = new Map<string, number>()

  function isUnlocked(folderId: string): boolean {
    const until = grants.get(folderId)
    if (until === undefined) return false
    if (until <= now()) {
      grants.delete(folderId)
      return false
    }
    return true
  }

  return {
    unlock(folderId: string, minutes: number): void {
      const span = Math.floor(Number(minutes))
      if (!folderId || !Number.isFinite(span) || span <= 0) {
        grants.delete(folderId)
        return
      }
      grants.set(folderId, now() + span * 60_000)
    },
    isUnlocked,
    lock(folderId: string): void {
      grants.delete(folderId)
    },
    clear(): void {
      grants.clear()
    },
  }
}
