export type SoundSlot = 'rel' | 'ho'

function slotPrefix(slot: SoundSlot): string {
  return `custom-${slot}.`
}

/**
 * Файлы, которые удаляются при сохранении нового звука слота: старый файл этого
 * слота и legacy custom.<ext> (до слотов он был «перемещением»). Файлы чужого
 * слота не трогаем — иначе смена расширения оставляла в папке два custom-ho.*
 * и чтение могло вернуть не тот.
 */
export function slotFilesToRemove(files: string[], slot: SoundSlot): string[] {
  const own = slotPrefix(slot)
  const foreign = slotPrefix(slot === 'rel' ? 'ho' : 'rel')
  const out: string[] = []
  for (const f of files) {
    if (f.startsWith(foreign)) continue
    if (f.startsWith(own) || (slot === 'rel' && f.startsWith('custom.'))) out.push(f)
  }
  return out
}