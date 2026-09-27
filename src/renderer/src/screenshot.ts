import { activeView } from './tabs'
import { createShotPreview, type ShotPreviewController } from './shot-preview'
import { setStatus } from './status-ui'

/** Превью снимка экрана; собирается в wireShotPreview */
let shotPreview: ShotPreviewController | null = null

/**
 * Закрыть превью снимка, если оно открыто. Для цепочки Esc: true означает,
 * что закрытие состоялось и вызывающему не нужно искать следующий оверлей.
 */
export function closeShotPreviewIfOpen(): boolean {
  if (!shotPreview?.isOpen()) return false
  shotPreview.close()
  return true
}

/** Снимок активной вкладки: PNG приходит в превью, на диск пишет сам пользователь */
export async function captureActiveTabScreenshot(): Promise<void> {
  const view = activeView()
  if (!view) {
    setStatus('нет активной вкладки')
    return
  }
  try {
    openShotPreview(await window.shell.captureScreenshot(view.getWebContentsId()))
  } catch {
    setStatus('снимок не удался')
  }
}

/**
 * Открывает превью снимка. main отдаёт PNG как data URL и имя файла по
 * умолчанию; на диск ничего не пишется, пока пользователь не нажмёт
 * «Сохранить как…» или «Копировать».
 */
export function openShotPreview(result: ScreenshotResult): void {
  if (!result || !result.ok || !result.dataUrl) {
    setStatus('снимок не удался')
    return
  }
  const guestId = activeView()?.getWebContentsId() ?? 0
  if (!guestId) {
    setStatus('нет активной вкладки')
    return
  }
  const shown = shotPreview?.open({
    dataUrl: result.dataUrl,
    name: result.name || 'снимок.png',
    guestId,
  })
  if (!shown) setStatus('снимок не удался')
}

/**
 * Характерный щелчок затвора при успешном снимке — два коротких щелчка
 * с интервалом, как у механического затвора. Синтезируем на месте (WebAudio),
 * чтобы не тащить звуковой файл в проект; по образцу playTnBeep.
 */
export function playShutterClick(): void {
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gain.gain.value = 0.22
    // Два щелчка: первый резкий, второй чуть тише и ниже — так узнаётся затвор
    for (const [delayMs, freq] of [[0, 1800], [70, 1250]] as const) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      // Быстрый спад: иначе щелчок превращается в квак
      env.gain.setValueAtTime(0, ctx.currentTime + delayMs / 1000)
      env.gain.linearRampToValueAtTime(1, ctx.currentTime + delayMs / 1000 + 0.002)
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delayMs / 1000 + 0.05)
      osc.connect(env)
      env.connect(gain)
      osc.start(ctx.currentTime + delayMs / 1000)
      osc.stop(ctx.currentTime + delayMs / 1000 + 0.06)
    }
    setTimeout(() => { ctx.close().catch(() => undefined) }, 500)
  } catch { /* звук не критичен для снимка */ }
}

/** Превью снимка экрана: картинка + «Сохранить как…» / «Копировать» */
export function wireShotPreview(): void {
  const overlay = document.getElementById('shot-overlay') as HTMLElement | null
  const image = document.getElementById('shot-image') as HTMLImageElement | null
  const caption = document.getElementById('shot-caption') as HTMLElement | null
  const save = document.getElementById('shot-save') as HTMLButtonElement | null
  const copy = document.getElementById('shot-copy') as HTMLButtonElement | null
  const closeX = document.getElementById('shot-close-x') as HTMLButtonElement | null
  if (!overlay || !image || !caption || !save || !copy || !closeX) return
  shotPreview = createShotPreview(
    { overlay, image, caption, save, copy, close: closeX },
    {
      onSave: (shot) => {
        void window.shell
          .saveScreenshotAs(shot.dataUrl, shot.guestId)
          .then((res) => {
            if (res && res.ok) setStatus('снимок сохранён')
            // false = пользователь отменил диалог — молчим, как и в печати
            else if (res) setStatus('не удалось сохранить снимок')
          })
          .catch(() => setStatus('не удалось сохранить снимок'))
      },
      onCopy: (shot) => {
        void window.shell
          .copyScreenshotImage(shot.dataUrl)
          .then((ok) => setStatus(ok ? 'снимок в буфере обмена' : 'не удалось скопировать'))
          .catch(() => setStatus('не удалось скопировать'))
      },
      onOpen: () => playShutterClick(),
    },
  )
}
