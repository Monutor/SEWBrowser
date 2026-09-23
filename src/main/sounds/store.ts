import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
}

export function mimeForSoundExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function soundsDir(): string {
  const dir = join(app.getPath('userData'), 'sounds')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Сохранить пользовательский звук (имя фиксированное — custom.<ext>, без пользовательского имени в пути) */
export function saveSoundFile(bytes: Buffer, ext: string): string {
  const dir = soundsDir()
  for (const f of readdirSync(dir)) {
    if (f.startsWith('custom.')) rmSync(join(dir, f), { force: true })
  }
  const file = `custom.${ext}`
  writeFileSync(join(dir, file), bytes)
  return file
}

/** Прочитать сохранённый звук ({file, ext, base64}) или null */
export function readSoundFile(): { file: string; ext: string; base64: string } | null {
  const dir = soundsDir()
  if (!existsSync(dir)) return null
  const found = readdirSync(dir).find((f) => f.startsWith('custom.'))
  if (!found) return null
  const ext = found.slice('custom.'.length)
  if (!MIME_BY_EXT[ext]) return null
  return { file: found, ext, base64: readFileSync(join(dir, found)).toString('base64') }
}

/** Удалить сохранённый звук */
export function clearSoundFiles(): void {
  const dir = soundsDir()
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    if (f.startsWith('custom.')) rmSync(join(dir, f), { force: true })
  }
}
