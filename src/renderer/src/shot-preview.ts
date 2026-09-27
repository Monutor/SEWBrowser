export interface ShotPreviewElements {
  /** Корневой оверлей — по нему же ловим клик по фону */
  overlay: Pick<HTMLElement, 'hidden' | 'onclick'>
  /** <img> с картинкой снимка */
  image: Pick<HTMLImageElement, 'src'>
  /** Имя файла по умолчанию и подсказка */
  caption: Pick<HTMLElement, 'textContent'>
  /** Кнопка «Сохранить как…» */
  save: Pick<HTMLButtonElement, 'onclick'>
  /** Кнопка «Копировать» */
  copy: Pick<HTMLButtonElement, 'onclick'>
  /** Кнопка «×» */
  close: Pick<HTMLButtonElement, 'onclick'>
}

export interface ShotPreviewShot {
  /** PNG в виде data URL */
  dataUrl: string
  /** Имя файла по умолчанию (подпись и подсказка) */
  name: string
  /** Гостевой webContents — нужен main для атрибуции при сохранении */
  guestId: number
}

export interface ShotPreviewHooks {
  onSave: (shot: ShotPreviewShot) => void
  onCopy: (shot: ShotPreviewShot) => void
  /** Щелчок затвора при открытии превью */
  onOpen?: () => void
}

export interface ShotPreviewController {
  open: (shot: ShotPreviewShot) => boolean
  close: () => void
  isOpen: () => boolean
  current: () => ShotPreviewShot | null
}

function isShot(shot: ShotPreviewShot | null | undefined): shot is ShotPreviewShot {
  return !!shot && typeof shot.dataUrl === 'string' && !!shot.dataUrl && typeof shot.guestId === 'number'
}

/**
 * Оверлей превью снимка экрана: картинка + «Сохранить как…» / «Копировать» / «×».
 * Закрывается крестиком, кликом по фону оверлея и Escape (вызывающий код).
 * Снимок наружу не отдаётся целиком — наружу есть current() для проверок.
 */
export function createShotPreview(
  elements: ShotPreviewElements,
  hooks: ShotPreviewHooks,
): ShotPreviewController {
  let shot: ShotPreviewShot | null = null

  const close = (): void => {
    shot = null
    elements.overlay.hidden = true
    elements.save.onclick = null
    elements.copy.onclick = null
    elements.close.onclick = null
    elements.overlay.onclick = null
    // Сбрасываем src, чтобы браузер не держал в памяти картинку прошлого снимка
    elements.image.src = ''
  }

  const open = (next: ShotPreviewShot): boolean => {
    if (!isShot(next)) return false
    shot = next
    elements.image.src = next.dataUrl
    elements.caption.textContent = next.name
    elements.overlay.hidden = false
    // Клик по затемнению закрывает; клик по панели всплывает сюда же,
    // поэтому сравниваем цель — иначе закрылось бы и по нажатию кнопки.
    elements.overlay.onclick = (event: { target?: unknown }): void => {
      if (event.target === elements.overlay) close()
    }
    elements.save.onclick = (): void => { if (shot) hooks.onSave(shot) }
    elements.copy.onclick = (): void => { if (shot) hooks.onCopy(shot) }
    elements.close.onclick = (): void => { if (!elements.overlay.hidden) close() }
    hooks.onOpen?.()
    return true
  }

  return { open, close, isOpen: () => shot !== null, current: () => shot }
}
