/** Валидация пользовательского звука tasks-notify. Чистый модуль без electron-зависимостей. */

/** Максимальный размер звукового файла — 2 МБ (бинарь лежит на диске, не в plugin-data) */
export const MAX_SOUND_BYTES = 2 * 1024 * 1024

const ALLOWED_EXTS = new Set(['mp3', 'wav', 'ogg'])

/** Расширение файла, если оно из разрешённых (в нижнем регистре), иначе null */
export function pickSoundExt(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0 || dot === fileName.length - 1) return null
  const ext = fileName.slice(dot + 1).toLowerCase()
  return ALLOWED_EXTS.has(ext) ? ext : null
}

/** Размер файла в допустимых пределах (0 байт — пустышка, отклоняем) */
export function isSoundSizeOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_SOUND_BYTES
}
