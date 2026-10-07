import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Скрытые окна держим в Set — иначе GC electron их приберёт и `printToPDF`
 *  начнёт падать на живом, но уже недостижимом webContents. */
const htmlPdfWindows = new Set<BrowserWindow>()

/** Общая папка для временных артефактов ценников. */
export function tempWorkDir(): string {
  const base = join(tmpdir(), 'sewbrowser-pricetags')
  mkdirSync(base, { recursive: true })
  return base
}

/**
 * HTML → PDF через скрытое окно. Образец — `printPdfDocument`
 * (src/main/index.ts:1292). Шрифты ценников приезжают инлайном (@font-face с
 * data-URI), поэтому перед снимком дожидаемся `document.fonts.ready`: иначе
 * `printToPDF` рисует fallback-гарнитуры.
 *
 * Окно без nodeIntegration, с запретом навигации и открытия окон: HTML приходит
 * из сети, доверять ему нельзя даже в скрытом окне.
 */
export async function htmlToPdf(html: string, timeoutMs = 45_000): Promise<Buffer> {
  const file = join(tempWorkDir(), `${randomUUID()}.html`)
  // Запись и создание окна — внутри try: частично записанный .html (место на
  // диске кончилось) и исключение конструктора иначе оставили бы файл в temp.
  // Наружу `created` нужен только ради destroy.
  let created: BrowserWindow | null = null
  try {
    writeFileSync(file, html, 'utf-8')
    created = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    })
    const win = created
    htmlPdfWindows.add(win)
    // HTML ценников приходит из сети (сервер SEW), а дефолт Electron разрешает
    // и `window.open`/`target="_blank"` (из скрытого окна вылезет видимое окно с
    // дефолтными prefs), и самонавигацию через `location.href`/`<meta refresh>`.
    // Без этих двух строк не-`file:` навигацию проглатывал бы guard в onLoaded,
    // и вместо ошибки пользователь получал висок до таймаута.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = (): void => {
        // Геттер webContents уничтоженного окна бросает «Object has been
        // destroyed» (ср. index.ts:1380) — сюда попадает хвостовой .catch после
        // выигрыша таймера, когда finally уже погасил окно.
        if (win.isDestroyed()) return
        clearTimeout(timer)
        win.webContents.removeListener('did-finish-load', onLoaded)
        win.webContents.removeListener('did-fail-load', onFailed)
      }
      const onFailed = (_event: unknown, code: number, desc: string, _url: string, isMainFrame: boolean): void => {
        // Провал загрузки картинки/фрейма внутри страницы конвертацию не
        // отменяет — отвергаем только провал главного документа.
        if (!isMainFrame) return
        cleanup()
        reject(new Error(`страница не загрузилась: ${code} ${desc}`))
      }
      const onLoaded = (): void => {
        // Отсекаем чужие finish — стартовая пустая страница тоже докладывает
        // did-finish-load. Снимок берём только когда в окне наш .html.
        let url = ''
        try {
          url = win.webContents.getURL()
        } catch {
          return
        }
        if (!url.startsWith('file:')) return
        void win.webContents
          .executeJavaScript('document.fonts.ready.then(function () { return true })', true)
          .then(() => win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }))
          .then((data) => {
            cleanup()
            resolve(Buffer.from(data))
          })
          .catch((err: unknown) => {
            cleanup()
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('рендер HTML в PDF не успел'))
      }, timeoutMs)
      // on, а не once: с отсечкой по URL лишний finish обязан дождаться
      // настоящей загрузки, а не съесть единственную подписку.
      win.webContents.on('did-finish-load', onLoaded)
      win.webContents.on('did-fail-load', onFailed)
      win.loadURL(pathToFileURL(file).toString()).catch((err: unknown) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
    return pdf
  } finally {
    if (created) {
      htmlPdfWindows.delete(created)
      if (!created.isDestroyed()) created.destroy()
    }
    try {
      unlinkSync(file)
    } catch {
      // файл могли убрать — нечего чинить
    }
  }
}
