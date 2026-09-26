// Импорт от корня пакета: types резолвится через "types" в package.json
// (у build/pdf.mjs нет .d.mts рядом). На рантайме это тот же build/pdf.mjs
// из поля "main", так что Vite-путь до воркера ниже не меняется.
import * as pdfjs from 'pdfjs-dist'

// Воркер подключаем Vite-способом: статический new URL(..., import.meta.url)
// иначе electron-vite не переживёт путь к воркеру после сборки.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

/** Рендер одной страницы в data URL заданной ширины */
async function renderPage(doc: pdfjs.PDFDocumentProxy, pageNo: number, width: number): Promise<string> {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const scale = width / base.width
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas 2d недоступен')
  await page.render({ canvasContext: context, viewport, canvas }).promise
  return canvas.toDataURL('image/png')
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

/**
 * PDF → миниатюры страниц (data URL). pageCount всегда реальный, thumbs
 * ограничен limit: остальное дорисовывается по кнопке «Показать все».
 * Ошибки не бросает наружу — вызывающий покажет заглушку.
 */
export async function renderPdfThumbnails(
  bytes: Uint8Array,
  width: number,
  limit: number,
): Promise<{ pageCount: number; thumbs: string[] }> {
  // task вне try нельзя: getDocument бросает синхронно на мусорных параметрах,
  // а функция обязана вернуть заглушку, а не исключение.
  let task: pdfjs.PDFDocumentLoadingTask | null = null
  try {
    // isEvalSupported в pdf.js 6.x удалён вместе с веткой font→eval
    // (CVE-2024-4367), отдельный флаг больше не нужен.
    const loading = pdfjs.getDocument({ data: bytes })
    task = loading
    const doc = await loading.promise
    const pageCount = doc.numPages
    const wanted = Math.max(1, Math.min(limit, pageCount))
    const thumbs: string[] = []
    try {
      for (let i = 1; i <= wanted; i++) {
        if (i > 1) await nextFrame()
        thumbs.push(await renderPage(doc, i, width))
      }
    } catch (err) {
      // Битая страница не должна обнулять уже нарисованные миниатюры и реальное
      // число страниц: останавливаемся и отдаём что успели.
      console.warn('[print] не удалось отрисовать страницу:', err)
    }
    return { pageCount, thumbs }
  } catch (err) {
    console.warn('[print] не удалось разобрать PDF:', err)
    return { pageCount: 0, thumbs: [] }
  } finally {
    // Воркер держит живой порт; контроллер зовёт функцию на каждый пересчёт
    // превью, поэтому освобождаем явно. Ошибка освобождения не должна уронить
    // уже собранный результат — глотаем.
    if (task) {
      try {
        await task.destroy()
      } catch (err) {
        console.warn('[print] не удалось освободить воркер PDF:', err)
      }
    }
  }
}
