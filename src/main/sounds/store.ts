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

/** Файлы слотов: custom-rel.<ext> / custom-ho.<ext>.
 *  Старый custom.<ext> (до слотов) читается как 'rel' — обратная совместимость. */
function slotPrefix(slot: 'rel' | 'ho'): string {
  return `custom-${slot}.`
}

function findSlotFile(dir: string, slot: 'rel' | 'ho'): string | null {
  const prefix = slotPrefix(slot)
  const direct = readdirSync(dir).find((f) => f.startsWith(prefix))
  if (direct) return direct
  if (slot === 'rel') {
    const legacy = readdirSync(dir).find((f) => f.startsWith('custom.') && !f.startsWith('custom-rel.') && !f.startsWith('custom-ho.'))
    if (legacy) return legacy
  }
  return null
}

/** Сохранить звук слота (старый файл слота и legacy затираются) */
export function saveSoundFile(bytes: Buffer, ext: string, slot: 'rel' | 'ho'): string {
  const dir = soundsDir()
  for (const f of readdirSync(dir)) {
    if (f.startsWith(slotPrefix(slot)) || (slot === 'rel' && f.startsWith('custom.'))) {
      if (f.startsWith('custom-ho.')) continue
      rmSync(join(dir, f), { force: true })
    }
  }
  const file = `custom-${slot}.${ext}`
  writeFileSync(join(dir, file), bytes)
  return file
}

/** Прочитать звук слота ({file, ext, base64}) или null */
export function readSoundFile(slot: 'rel' | 'ho'): { file: string; ext: string; base64: string } | null {
  const dir = soundsDir()
  if (!existsSync(dir)) return null
  const found = findSlotFile(dir, slot)
  if (!found) return null
  const ext = found.slice(found.lastIndexOf('.') + 1)
  if (!MIME_BY_EXT[ext]) return null
  return { file: found, ext, base64: readFileSync(join(dir, found)).toString('base64') }
}

/** Удалить звук слота */
export function clearSoundFile(slot: 'rel' | 'ho'): void {
  const dir = soundsDir()
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    if (f.startsWith(slotPrefix(slot))) rmSync(join(dir, f), { force: true })
  }
}
