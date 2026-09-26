# Print Dialog (Chrome-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Диалог печати в оболочке с живым превью страниц (как в Chrome): настройки слева, миниатюры справа, сохранение в PDF и печать через системный диалог Windows; настройки запоминаются между запусками.

**Architecture:** Чистый контроллер `print-dialog.ts` (все элементы передаются явно, DOM не создаётся) + чистые функции сборки аргументов; рендер превью изолирован в `print-preview.ts` (pdf.js) и внедряется в контроллер хуком `hooks.buildPdf`, поэтому контроллер не знает ни про Electron, ни про webview. Единственная точка входа — `openPrintDialog(tab)` в `main.ts`; три точки входа (Ctrl+P, меню адреса, ПКМ гостя) вызывают её. Настройки живут в `SewConfig.print` и пишутся только при печати/сохранении.

**Tech Stack:** Electron 44.4.5, `<webview>` (НЕ `WebContentsView`), TypeScript 7, electron-vite 5 (Vite 7), `pdfjs-dist@^6.3.289`, `node:test` (Node 24), без новых зависимостей кроме pdf.js.

**Spec:** `docs/superpowers/specs/2026-09-26-print-dialog-design.md` — план аргументирует из спеки, спека едет вместе с планом.

## Global Constraints

- Только Windows, Electron **44.4.5** (зафиксировано в `package.json` + `package-lock.json`), `<webview>` — миграция на `WebContentsView` отложена.
- **Переиспользуем существующие API, дублирование запрещено:** сохранение PDF идёт через уже существующий `window.shell.savePdf(base64: string, name: string): Promise<boolean>` (`src/preload/index.ts:167` → `ipcMain.handle('pdf-viewer:save')`, `src/main/index.ts:607`: декод base64, проверка `%PDF`, `sanitizeFileName`, `dialog.showSaveDialogSync`, запись, `appendDownloadRecord`). **Новый IPC для сохранения PDF не создаём** — вместо этого конвертируем `Uint8Array` в base64 в renderer.
- `src/renderer/src/shell-api.d.ts` — **ambient-файл, не модуль**: все объявления **БЕЗ `export`** (добавление `export` тихо ломает весь файл).
- Стиль: 2 пробела, русские комментарии и русские тексты в UI. `var`/`function` вместо `const`/`let` на верхнем уровне — ТОЛЬКО внутри `features/*.js` (в `src/**` обычные `const`).
- Палитра `styles.css` — только существующие переменные: `--bg`, `--chrome`, `--chrome-2`, `--surface`, `--content`, `--text`, `--text-2`, `--text-3`, `--border`, `--border-strong`, `--accent`, `--accent-2`, `--accent-soft`, `--danger`, `--shadow-sm` (+ алиасы `--chrome-bg`, `--text-dim`). **Новых CSS-переменных не заводим.**
- Ловушки Electron: у `<webview>` события только через `addEventListener`; `executeJavaScript` клонирует completion value (IIFE оканчивать `})()`, возвращать строку); `main.ts` неимпортируем под `node --test` — для него юнит-тесты не пишем.
- Проверка после каждой задачи: `npm run typecheck` и `npm run test` (ожидается ≥ 59 тестов, 0 падений); `npm run build` — в задачах 1, 4, 5, 6, 7.
- `npm run test` печатает косметический warning `MODULE_TYPELESS_PACKAGE_JSON` — это не ошибка.
- Коммиты локальные — **разрешены**; `git push` — **запрещён** (без отдельного разрешения пользователя).
- Файл `design-mockup.html` в корне репозитория — чужой, untracked, **не коммитить и не удалять**.

### Отклонения от спеки, принятые при написании плана (выполнены по DRY/YAGNI)

1. **Сохранение PDF — через существующий `savePdf(base64, name)`**, а не через новый `savePdf(name, bytes)`. Спека §5.2 описывала новый метод, но он бы дублировал уже готовую, покрытую проверкой `%PDF` логику. Компромисс: в renderer нужен `bytesToBase64` (чистая функция, покрыта тестами в задаче 2). Побочный эффект: `savePdf` возвращает `boolean` и не различает «отмена» и «ошибка» ⇒ при `false` молчим (не показываем ошибку), это же отражено в §9 спеки («Отмена — тишина»).
2. **Пункт «Печать…» в контекстном меню гостя уже существует** (`src/main/index.ts:1007`, `guest.print({})` — сразу системный диалог). Задача 1 переключает его на канал `shell:open-print`, новый пункт не добавляется.
3. **Debounce 250 мс живёт в `main.ts`, а не в контроллере** — чтобы контроллер остался без таймеров и тестировался детерминированно. Спека §6 требует debounce, он реализован, просто в вызывающем коде.
4. **Диапазон «Текущая» = страница, выбранная в превью** (клик по миниатюре), а не страница под вьюпортом: определить реальную страницу прокрутки можно только хрупкими эвристиками в госте. Согласуется со словами спеки §6 («клик по миниатюре листает текущую страницу»).

---

### Карта файлов

| Файл | Ответственность | Задача |
|---|---|---|
| `src/renderer/src/shell-api.d.ts` | ambient-типы печати: `PrintOptionsLike`, `PrintToPdfOptionsLike`, `ShellPrinter`, `PrintSettings`; методы `print`/`printToPDF` на `SewWebViewElement`; `print?: PrintSettings` в `ShellConfig`; `listPrinters()`, `onOpenPrint(cb)` в `ShellApi` | 1 |
| `src/preload/index.ts` | `listPrinters`, `onOpenPrint`, `print?: PrintSettingsLike` в `ShellConfigLike` | 1 |
| `src/main/index.ts` | `ipcMain.handle('printers:list')`; пункт «Печать…» → `shell:open-print` | 1 |
| `src/main/config.ts` | `PrintSettings`, `SewConfig.print`, санитайзер `pickPrint` | 1 |
| `src/renderer/src/print-dialog.ts` | чистые функции (нормализация, аргументы, base64) + контроллер диалога | 2, 3 |
| `src/renderer/src/print-dialog.test.ts` | юнит-тесты чистых функций и контроллера (свой `FakeEl`) | 2, 3 |
| `src/renderer/src/print-preview.ts` | обёртка pdf.js: рендер миниатюр + порционный рендер «показать все» | 4 |
| `package.json` / `package-lock.json` | зависимость `pdfjs-dist@^6.3.289` | 4 |
| `src/renderer/index.html` | оверлей `#print-overlay` | 5 |
| `src/renderer/src/styles.css` | стили оверлея печати | 5 |
| `src/renderer/src/main.ts` | `openPrintDialog`, `wirePrintDialog`, 3 точки входа, debounce, запись `config.print`, Escape | 6 |

---

### Task 1: Типы, IPC и конфиг печати

**Files:**
- Modify: `src/renderer/src/shell-api.d.ts` (после строки 28 — `print()`; после строки 79 — `print?` в `ShellConfig`; после строки 319 — `listPrinters`/`onOpenPrint`)
- Modify: `src/preload/index.ts` (строки 9–19 — `ShellConfigLike`; рядом с `copyText` на строке 283)
- Modify: `src/main/index.ts` (рядом с `notify:tasks`; строка 1007 — пункт «Печать…»)
- Modify: `src/main/config.ts` (интерфейс `SewConfig` строка 39–60; `DEFAULTS` строка 62–80; `sanitizeConfig` строка 103–196)

**Interfaces:**
- Consumes: ничего (первая задача).
- Produces:
  - `interface PrintOptionsLike { silent?: boolean; printBackground?: boolean; deviceName?: string; landscape?: boolean; pageSize?: PrintPageSizeName | { width: number; height: number }; copies?: number; pageRanges?: string; margins?: { top?: number; bottom?: number; left?: number; right?: number } }`
  - `type PrintPageSizeName = 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid'`
  - `interface PrintToPdfOptionsLike { landscape?: boolean; printBackground?: boolean; scale?: number; displayHeaderFooter?: boolean; pageSize?: PrintPageSizeName | { width: number; height: number }; margins?: { top?: number; bottom?: number; left?: number; right?: number } }`
  - `interface ShellPrinter { name: string; displayName: string; description: string }`
  - `interface PrintSettings { destination: 'pdf' | 'printer'; deviceName: string; rangeMode: 'all' | 'current' | 'custom'; rangeFrom: number; rangeTo: number; copies: number; landscape: boolean; pageSize: PrintPageSizeName; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; scale: number; printBackground: boolean; displayHeaderFooter: boolean }`
  - `SewWebViewElement.print(options?: PrintOptionsLike): Promise<void>` (заменяет текущее `print(): Promise<void>` на строке 28), `SewWebViewElement.printToPDF(options?: PrintToPdfOptionsLike): Promise<Uint8Array>`
  - `ShellApi.listPrinters(): Promise<ShellPrinter[]>` (IPC `printers:list`), `ShellApi.onOpenPrint(cb: () => void): void` (канал `shell:open-print`)
  - `ShellConfig.print?: PrintSettings`, `SewConfig.print?: PrintSettings`

- [ ] **Step 1: Типы печати в `shell-api.d.ts`**

Заменить строку 28 (`  print(): Promise<void>`) на:

```ts
  print(options?: PrintOptionsLike): Promise<void>
  printToPDF(options?: PrintToPdfOptionsLike): Promise<Uint8Array>
```

И вставить перед `interface SewWebViewElement` (после строки 9, перед `/**\n * Подмножество реального API...`):

```ts
/** Размер бумаги, поддерживаемый и webContents.print, и printToPDF */
type PrintPageSizeName = 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid'

/** Поля в дюймах (так их ждёт Electron) */
interface PrintMarginsLike {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

interface PrintOptionsLike {
  silent?: boolean
  printBackground?: boolean
  /** Системное имя принтера из списка (не displayName!) */
  deviceName?: string
  landscape?: boolean
  pageSize?: PrintPageSizeName | { width: number; height: number }
  copies?: number
  /** '1-3' — диапазон; пустая строка/отсутствие = все страницы */
  pageRanges?: string
  margins?: PrintMarginsLike
}

interface PrintToPdfOptionsLike {
  landscape?: boolean
  printBackground?: boolean
  /** 0.1..2; настройка хранится в процентах, здесь доля */
  scale?: number
  displayHeaderFooter?: boolean
  pageSize?: PrintPageSizeName | { width: number; height: number }
  margins?: PrintMarginsLike
}

/** Принтер системы: name идёт в deviceName, displayName — в UI */
interface ShellPrinter {
  name: string
  displayName: string
  description: string
}

/** Настройки диалога печати; пишутся в config.json при печати/сохранении */
interface PrintSettings {
  destination: 'pdf' | 'printer'
  deviceName: string
  rangeMode: 'all' | 'current' | 'custom'
  rangeFrom: number
  rangeTo: number
  copies: number
  landscape: boolean
  pageSize: PrintPageSizeName
  /** Поля в миллиметрах */
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
  /** Проценты, 10..200 */
  scale: number
  printBackground: boolean
  displayHeaderFooter: boolean
}
```

В `ShellConfig` (после строки 72 `zoom: Record<string, number>`) добавить строку:

```ts
  print?: PrintSettings
```

В `ShellApi` после строки 319 (`copyText`) добавить:

```ts
  /** Принтеры системы (список одинаков для всех webContents) */
  listPrinters(): Promise<ShellPrinter[]>
  /** ПКМ по странице → «Печать…»: main шлёт 'shell:open-print' */
  onOpenPrint(cb: () => void): void
```

- [ ] **Step 2: Типы в `preload/index.ts`**

После строки 8 (`}` интерфейса `NavTabLike`, перед `interface ShellConfigLike`) вставить:

```ts
/** Поля печати в том же виде, что в конфиге (см. shell-api.d.ts) */
interface PrintSettingsLike {
  destination: 'pdf' | 'printer'
  deviceName: string
  rangeMode: 'all' | 'current' | 'custom'
  rangeFrom: number
  rangeTo: number
  copies: number
  landscape: boolean
  pageSize: 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid'
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
  scale: number
  printBackground: boolean
  displayHeaderFooter: boolean
}

/** Принтер системы для диалога печати */
interface ShellPrinterLike {
  name: string
  displayName: string
  description: string
}
```

В `ShellConfigLike` после строки 15 (`zoom: Record<string, number>`) добавить:

```ts
  print?: PrintSettingsLike
```

Рядом с `copyText` (после строки 283) добавить:

```ts
  listPrinters: (): Promise<ShellPrinterLike[]> => ipcRenderer.invoke('printers:list'),
  onOpenPrint: (cb: () => void): void => {
    ipcRenderer.on('shell:open-print', () => cb())
  },
```

- [ ] **Step 3: IPC `printers:list` в `src/main/index.ts`**

Найти обработчик `notify:tasks` (комментарий `// Уведомления tasks-notify: пачка за тик → одно OS-уведомление`). Вставить **перед** ним:

```ts
  // Список системных принтеров для диалога печати. Список одинаков для любого
  // webContents, поэтому гость не нужен — берём у webContents главного окна.
  ipcMain.handle('printers:list', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return []
    try {
      const printers = await mainWindow.webContents.getPrintersAsync()
      return printers.map((p) => ({ name: p.name, displayName: p.displayName, description: p.description }))
    } catch (err) {
      console.warn('[shell] getPrintersAsync failed:', err)
      throw err
    }
  })
```

- [ ] **Step 4: Пункт «Печать…» → канал в `src/main/index.ts`**

В контекстном меню гостя заменить строку 1007:

```ts
        { label: 'Печать…', click: () => { if (!guest.isDestroyed()) void guest.print({}) } },
```

на:

```ts
        {
          // Свой диалог печати живёт в renderer; системный — вызовется из него.
          label: 'Печать…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shell:open-print')
          },
        },
```

- [ ] **Step 5: `PrintSettings` в `src/main/config.ts`**

После строки 37 (`}` интерфейса `ScanFolder`) вставить:

```ts
/** Настройки диалога печати (renderer, src/renderer/src/print-dialog.ts) */
export interface PrintSettings {
  destination: 'pdf' | 'printer';
  deviceName: string;
  rangeMode: 'all' | 'current' | 'custom';
  rangeFrom: number;
  rangeTo: number;
  copies: number;
  landscape: boolean;
  pageSize: 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid';
  /** Поля в миллиметрах */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** Проценты, 10..200 */
  scale: number;
  printBackground: boolean;
  displayHeaderFooter: boolean;
}
```

В `SewConfig` после строки 46 (`zoom: Record<string, number>;`) добавить:

```ts
  /** Настройки диалога печати; undefined — ещё не печатали (renderer ставит дефолты) */
  print?: PrintSettings;
```

- [ ] **Step 6: Санитайзер `pickPrint` в `sanitizeConfig`**

В `src/main/config.ts` внутрь `sanitizeConfig` после `pickScanFolders` (закрывающая скобка на строке 176) вставить:

```ts
  // Настройки печати: неверный тип/значение -> дефолт. absent/undefined
  // остаётся undefined — renderer применит свои дефолты (A4, книжная, 20/20/10/10).
  const pickPrint = (v: unknown): PrintSettings | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const raw = v as Record<string, unknown>
    const sizes = ['A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid'] as const
    const int = (x: unknown, min: number, max: number, fallback: number): number => {
      const n = Math.floor(Number(x))
      return Number.isFinite(n) && n >= min && n <= max ? n : fallback
    }
    const mm = (x: unknown, fallback: number): number => {
      const n = Math.round(Number(x) * 100) / 100
      return Number.isFinite(n) && n >= 0 && n <= 50 ? n : fallback
    }
    return {
      destination: raw.destination === 'printer' ? 'printer' : 'pdf',
      deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
      rangeMode: raw.rangeMode === 'current' || raw.rangeMode === 'custom' ? raw.rangeMode : 'all',
      rangeFrom: int(raw.rangeFrom, 1, 100000, 1),
      rangeTo: int(raw.rangeTo, 1, 100000, 1),
      copies: int(raw.copies, 1, 99, 1),
      landscape: raw.landscape === true,
      pageSize: sizes.includes(raw.pageSize as (typeof sizes)[number]) ? (raw.pageSize as PrintSettings['pageSize']) : 'A4',
      marginTop: mm(raw.marginTop, 20),
      marginBottom: mm(raw.marginBottom, 20),
      marginLeft: mm(raw.marginLeft, 10),
      marginRight: mm(raw.marginRight, 10),
      scale: int(raw.scale, 10, 200, 100),
      printBackground: raw.printBackground === true,
      displayHeaderFooter: raw.displayHeaderFooter === true,
    }
  }
```

И в возвращаемом объекте `sanitizeConfig` после строки 188 (`zoom: { ...DEFAULTS.zoom, ...pickZoom(user.zoom) },`) добавить:

```ts
    print: pickPrint(user.print),
```

- [ ] **Step 7: Проверка**

Run: `npm run typecheck`
Expected: exit 0, обе конфигурации без ошибок.

Run: `npm run test`
Expected: `tests 59`, `pass 59`, `fail 0` (сумма не должна уменьшиться).

Run: `npm run build`
Expected: сборка `out/main`, `out/preload`, `out/renderer` без ошибок.

- [ ] **Step 8: Коммит**

```bash
git add src/renderer/src/shell-api.d.ts src/preload/index.ts src/main/index.ts src/main/config.ts
git commit -m "feat(print): types, printers IPC and print settings in config"
```

---

### Task 2: Чистые функции диалога печати

**Files:**
- Create: `src/renderer/src/print-dialog.ts`
- Test: `src/renderer/src/print-dialog.test.ts`

**Interfaces:**
- Consumes: ambient-типы из задачи 1 — `PrintSettings`, `PrintOptionsLike`, `PrintToPdfOptionsLike`.
- Produces (экспорты `print-dialog.ts`, все без `export {}`-обёртки — просто экспортируемые функции):
  - `normalizePrintSettings(raw: unknown): PrintSettings` — мусор/неверные типы → дефолты; дефолты: `destination:'pdf'`, `deviceName:''`, `rangeMode:'all'`, `rangeFrom:1`, `rangeTo:1`, `copies:1`, `landscape:false`, `pageSize:'A4'`, `marginTop:20`, `marginBottom:20`, `marginLeft:10`, `marginRight:10`, `scale:100`, `printBackground:false`, `displayHeaderFooter:false`.
  - `mmToInches(mm: number): number` — миллиметры → дюймы, округление до 4 знаков.
  - `printMarginsInches(s: PrintSettings): PrintMarginsLike`
  - `printToPdfOptions(s: PrintSettings): PrintToPdfOptionsLike` — **без `pageRanges`** (диапазон относится к печати, PDF сохраняется целиком).
  - `pageRangesFor(s: PrintSettings, pageCount: number, currentPage: number): string` — `''` для `all` и когда `pageCount <= 0`; для `current` — номер выбранной страницы (clamp в `1..pageCount`); для `custom` — `"from-to"` с clamp обеих границ в `1..pageCount` и `to >= from` (иначе `from`).
  - `printOptions(s: PrintSettings, deviceName: string, pageCount: number, currentPage: number): PrintOptionsLike` — `silent:false`, `deviceName`, `printBackground`, `landscape`, `pageSize`, `copies`, `margins`, `pageRanges` (только если строка непустая).
  - `bytesToBase64(bytes: Uint8Array): string` — чанками по 32768 байт через `String.fromCharCode` + `btoa`.
  - `suggestedPdfName(title: string): string` — обрезает пробелы, добавляет `.pdf` если нет расширения, пустое → `'document.pdf'`, убирает слэши и двоеточия.

- [ ] **Step 1: Написать падающий тест**

Создать `src/renderer/src/print-dialog.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  bytesToBase64,
  mmToInches,
  normalizePrintSettings,
  pageRangesFor,
  printMarginsInches,
  printOptions,
  printToPdfOptions,
  suggestedPdfName,
} from './print-dialog.ts'

const base = normalizePrintSettings(undefined)

describe('normalizePrintSettings', () => {
  it('на мусоре отдаёт дефолты', () => {
    assert.deepEqual(base, {
      destination: 'pdf',
      deviceName: '',
      rangeMode: 'all',
      rangeFrom: 1,
      rangeTo: 1,
      copies: 1,
      landscape: false,
      pageSize: 'A4',
      marginTop: 20,
      marginBottom: 20,
      marginLeft: 10,
      marginRight: 10,
      scale: 100,
      printBackground: false,
      displayHeaderFooter: false,
    })
  })

  it('достаёт валидные значения', () => {
    const s = normalizePrintSettings({
      destination: 'printer',
      deviceName: 'HP LaserJet',
      rangeMode: 'custom',
      rangeFrom: 2,
      rangeTo: 5,
      copies: 3,
      landscape: true,
      pageSize: 'A3',
      marginTop: 5,
      marginBottom: 6,
      marginLeft: 7,
      marginRight: 8,
      scale: 150,
      printBackground: true,
      displayHeaderFooter: true,
    })
    assert.equal(s.destination, 'printer')
    assert.equal(s.deviceName, 'HP LaserJet')
    assert.equal(s.rangeMode, 'custom')
    assert.equal(s.copies, 3)
    assert.equal(s.pageSize, 'A3')
    assert.equal(s.scale, 150)
    assert.equal(s.printBackground, true)
    assert.equal(s.displayHeaderFooter, true)
  })

  it('чинит значения вне диапазонов', () => {
    const s = normalizePrintSettings({
      copies: 0,
      scale: 500,
      marginTop: 90,
      pageSize: 'А4',
      rangeFrom: -3,
      landscape: 'да',
    })
    assert.equal(s.copies, 1)
    assert.equal(s.scale, 100)
    assert.equal(s.marginTop, 20)
    assert.equal(s.pageSize, 'A4')
    assert.equal(s.rangeFrom, 1)
    assert.equal(s.landscape, false)
  })
})

describe('mmToInches', () => {
  it('переводит миллиметры в дюймы', () => {
    assert.equal(mmToInches(25.4), 1)
    assert.equal(mmToInches(10), 0.3937)
    assert.equal(mmToInches(0), 0)
  })
})

describe('printMarginsInches', () => {
  it('переводит все четыре поля', () => {
    assert.deepEqual(printMarginsInches(base), {
      top: 0.7874,
      bottom: 0.7874,
      left: 0.3937,
      right: 0.3937,
    })
  })
})

describe('printToPdfOptions', () => {
  it('собирает аргументы и не добавляет pageRanges', () => {
    const opts = printToPdfOptions(normalizePrintSettings({ landscape: true, scale: 150, printBackground: true }))
    assert.equal(opts.landscape, true)
    assert.equal(opts.scale, 1.5)
    assert.equal(opts.printBackground, true)
    assert.equal(opts.displayHeaderFooter, false)
    assert.equal(opts.pageSize, 'A4')
    assert.ok(!('pageRanges' in opts))
  })
})

describe('pageRangesFor', () => {
  it('для «всех страниц» диапазона нет', () => {
    assert.equal(pageRangesFor(base, 10, 3), '')
  })

  it('для «текущей» берёт выбранную страницу с clamp', () => {
    const s = normalizePrintSettings({ rangeMode: 'current' })
    assert.equal(pageRangesFor(s, 10, 4), '4')
    assert.equal(pageRangesFor(s, 10, 99), '10')
    assert.equal(pageRangesFor(s, 10, 0), '1')
  })

  it('для произвольного диапазона клампит границы к числу страниц', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 2, rangeTo: 4 })
    assert.equal(pageRangesFor(s, 10, 1), '2-4')
    assert.equal(pageRangesFor(s, 3, 1), '2-3')
    assert.equal(pageRangesFor(s, 1, 1), '1')
  })

  it('при пустом числе страниц диапазона нет', () => {
    const s = normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 })
    assert.equal(pageRangesFor(s, 0, 1), '')
  })
})

describe('printOptions', () => {
  it('собирает аргументы системной печати с deviceName', () => {
    const opts = printOptions(
      normalizePrintSettings({ copies: 2, landscape: true, printBackground: true }),
      'HP LaserJet',
      10,
      1,
    )
    assert.equal(opts.silent, false)
    assert.equal(opts.deviceName, 'HP LaserJet')
    assert.equal(opts.copies, 2)
    assert.equal(opts.landscape, true)
    assert.equal(opts.printBackground, true)
    assert.equal(opts.pageSize, 'A4')
    assert.equal(opts.pageRanges, undefined)
    assert.deepEqual(opts.margins, { top: 0.7874, bottom: 0.7874, left: 0.3937, right: 0.3937 })
  })

  it('подставляет диапазон, когда он есть', () => {
    const opts = printOptions(normalizePrintSettings({ rangeMode: 'custom', rangeFrom: 1, rangeTo: 2 }), 'XPS', 5, 1)
    assert.equal(opts.pageRanges, '1-2')
  })
})

describe('bytesToBase64', () => {
  it('кодирует байты в base64', () => {
    assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=')
    assert.equal(bytesToBase64(new Uint8Array(0)), '')
  })

  it('переживает больше одного чанка', () => {
    const big = new Uint8Array(70000).fill(65)
    const encoded = bytesToBase64(big)
    assert.equal(encoded.length, Math.ceil(70000 / 3) * 4)
    assert.equal(encoded.slice(0, 4), 'QUFB')
  })
})

describe('suggestedPdfName', () => {
  it('достраивает расширение и чистит пути', () => {
    assert.equal(suggestedPdfName('Отчёт за март'), 'Отчёт за март.pdf')
    assert.equal(suggestedPdfName('Отчёт.pdf'), 'Отчёт.pdf')
    assert.equal(suggestedPdfName('  '), 'document.pdf')
    assert.equal(suggestedPdfName('a/b:c'), 'ab c.pdf')
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm run test`
Expected: FAIL с `ERR_MODULE_NOT_FOUND` на `print-dialog.ts` (файла ещё нет).

- [ ] **Step 3: Реализация**

Создать `src/renderer/src/print-dialog.ts`:

```ts
/** Дефолты настроек печати: A4, книжная, поля как в Windows (20/20/10/10 мм) */
const DEFAULTS: PrintSettings = {
  destination: 'pdf',
  deviceName: '',
  rangeMode: 'all',
  rangeFrom: 1,
  rangeTo: 1,
  copies: 1,
  landscape: false,
  pageSize: 'A4',
  marginTop: 20,
  marginBottom: 20,
  marginLeft: 10,
  marginRight: 10,
  scale: 100,
  printBackground: false,
  displayHeaderFooter: false,
}

const PAGE_SIZES: readonly PrintPageSizeName[] = ['A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid']

/** Привести любой мусор из config.json к валидным настройкам */
export function normalizePrintSettings(raw: unknown): PrintSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  const v = raw as Record<string, unknown>
  const int = (x: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.floor(Number(x))
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  const mm = (x: unknown, fallback: number): number => {
    const n = Math.round(Number(x) * 100) / 100
    return Number.isFinite(n) && n >= 0 && n <= 50 ? n : fallback
  }
  const size = typeof v.pageSize === 'string' && PAGE_SIZES.includes(v.pageSize as PrintPageSizeName) ? (v.pageSize as PrintPageSizeName) : DEFAULTS.pageSize
  return {
    destination: v.destination === 'printer' ? 'printer' : DEFAULTS.destination,
    deviceName: typeof v.deviceName === 'string' ? v.deviceName : DEFAULTS.deviceName,
    rangeMode: v.rangeMode === 'current' || v.rangeMode === 'custom' ? v.rangeMode : DEFAULTS.rangeMode,
    rangeFrom: int(v.rangeFrom, 1, 100000, DEFAULTS.rangeFrom),
    rangeTo: int(v.rangeTo, 1, 100000, DEFAULTS.rangeTo),
    copies: int(v.copies, 1, 99, DEFAULTS.copies),
    landscape: v.landscape === true,
    pageSize: size,
    marginTop: mm(v.marginTop, DEFAULTS.marginTop),
    marginBottom: mm(v.marginBottom, DEFAULTS.marginBottom),
    marginLeft: mm(v.marginLeft, DEFAULTS.marginLeft),
    marginRight: mm(v.marginRight, DEFAULTS.marginRight),
    scale: int(v.scale, 10, 200, DEFAULTS.scale),
    printBackground: v.printBackground === true,
    displayHeaderFooter: v.displayHeaderFooter === true,
  }
}

/** Миллиметры → дюймы (единица Electron), округление до 4 знаков */
export function mmToInches(mm: number): number {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return Math.round((n / 25.4) * 10000) / 10000
}

export function printMarginsInches(s: PrintSettings): PrintMarginsLike {
  return {
    top: mmToInches(s.marginTop),
    bottom: mmToInches(s.marginBottom),
    left: mmToInches(s.marginLeft),
    right: mmToInches(s.marginRight),
  }
}

/** Аргументы printToPDF. pageRanges здесь НЕ применяем: сохраняем весь документ. */
export function printToPdfOptions(s: PrintSettings): PrintToPdfOptionsLike {
  return {
    landscape: s.landscape,
    printBackground: s.printBackground,
    scale: s.scale / 100,
    displayHeaderFooter: s.displayHeaderFooter,
    pageSize: s.pageSize,
    margins: printMarginsInches(s),
  }
}

function clampPage(n: number, pageCount: number): number {
  if (!Number.isFinite(n)) return 1
  const max = Math.max(1, pageCount)
  return Math.min(Math.max(1, Math.floor(n)), max)
}

/** Диапазон страниц для системной печати; '' = печатать всё */
export function pageRangesFor(s: PrintSettings, pageCount: number, currentPage: number): string {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return ''
  if (s.rangeMode === 'current') return String(clampPage(currentPage, pageCount))
  if (s.rangeMode === 'custom') {
    const from = clampPage(s.rangeFrom, pageCount)
    const to = Math.max(from, clampPage(s.rangeTo, pageCount))
    return from === to ? String(from) : `${from}-${to}`
  }
  return ''
}

/** Аргументы системной печати: silent всегда false — показываем диалог Windows (R4) */
export function printOptions(
  s: PrintSettings,
  deviceName: string,
  pageCount: number,
  currentPage: number,
): PrintOptionsLike {
  const ranges = pageRangesFor(s, pageCount, currentPage)
  const opts: PrintOptionsLike = {
    silent: false,
    deviceName,
    printBackground: s.printBackground,
    landscape: s.landscape,
    pageSize: s.pageSize,
    copies: s.copies,
    margins: printMarginsInches(s),
  }
  if (ranges) opts.pageRanges = ranges
  return opts
}

/** Uint8Array → base64 (для существующего window.shell.savePdf) */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 32768
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Имя файла для сохранения PDF: без расширения → с .pdf, без путей */
export function suggestedPdfName(title: string): string {
  const cleaned = (typeof title === 'string' ? title : '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  if (!cleaned) return 'document.pdf'
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npm run test`
Expected: `tests 74`, `pass 74`, `fail 0` (59 + 15 новых `it`).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer/src/print-dialog.ts src/renderer/src/print-dialog.test.ts
git commit -m "feat(print): pure print settings helpers"
```

---

### Task 3: Контроллер диалога печати

**Files:**
- Modify: `src/renderer/src/print-dialog.ts` (дописать в конец файла)
- Modify: `src/renderer/src/print-dialog.test.ts` (дописать в конец файла)

**Interfaces:**
- Consumes: `normalizePrintSettings`, `printOptions`, `printToPdfOptions` из задачи 2; ambient-типы `PrintSettings`, `PrintOptionsLike`, `ShellPrinter`.
- Produces:
  - `interface PrintDialogElements` — все поля `HTMLElement`: `settings` (контейнер всех полей — на него вешается пересчёт превью), `overlay`, `title`, `destination`, `printerRow`, `rangeMode`, `rangeCustom`, `rangeFrom`, `rangeTo`, `copies`, `landscape`, `pageSize`, `marginTop`, `marginBottom`, `marginLeft`, `marginRight`, `noMargins`, `scale`, `printBackground`, `displayHeaderFooter`, `thumbs`, `thumbsNote`, `showAll`, `pageCounter`, `status`, `cancel`, `savePdf`, `print`.
  - `interface PrintDialogHooks { listPrinters: () => Promise<ShellPrinter[]>; buildPdf: (settings: PrintSettings) => Promise<Uint8Array>; renderThumbs: (bytes: Uint8Array, limit: number) => Promise<string[]>; doPrint: (settings: PrintSettings) => Promise<void>; doSavePdf: (settings: PrintSettings, bytes: Uint8Array) => Promise<boolean>; documentTitle: () => string; persist: (settings: PrintSettings) => Promise<void> }`
  - `interface PrintDialogController { open: (settings: PrintSettings) => Promise<void>; close: () => void; isOpen: () => boolean; refresh: () => Promise<void>; currentSettings: () => PrintSettings; currentPage: () => number; pageCount: () => number; previewBytes: () => Uint8Array | null }`
  - `renderThumbs` хук вызывается **после** успешной `buildPdf`; его `limit` — сколько миниатюр нужно сейчас (10 или все), `pageCount` берётся из длины результата. Ошибка `renderThumbs` не должна ломать печать: превью показывает заглушку, кнопки остаются рабочими.
  - Контроллер **без таймеров** (debounce пересчёта — в `main.ts`, задача 6), поэтому тестируется детерминированно.
  - Порядок кнопки «Печать»: `doPrint(settings)` → при успехе `persist(settings)` → `close()`. Порядок «Сохранить как PDF»: взять кэш байтов, при отсутствии — `buildPdf(settings)`, затем `doSavePdf(settings, bytes)` → `persist(settings)` → `close()`. При любой ошибке — текст в `status`, кнопки разблокированы, диалог **не** закрывается, `persist` **не** вызывается.

- [ ] **Step 1: Написать падающий тест (дополнить `print-dialog.test.ts`)**

В начало `print-dialog.test.ts`, после строки с импортом `} from './print-dialog.ts'`, вставить импорт контроллера:

```ts
import { createPrintDialog, type PrintDialogController, type PrintDialogElements, type PrintDialogHooks } from './print-dialog.ts'
```

В конец файла добавить мини-дом и кейсы:

```ts
// Мини-дом для контроллера: своего jsdom в проекте нет (как в address-menu.test.ts)
interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  src: string
  hidden: boolean
  value: string
  checked: boolean
  disabled: boolean
  dataset: Record<string, string>
  attrs: Record<string, string>
  children: FakeEl[]
  parent: FakeEl | null
  listeners: Array<{ type: string; fn: (event: unknown) => void }>
  appendChild(node: FakeEl): FakeEl
  replaceChildren(...nodes: FakeEl[]): void
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: (event: unknown) => void): void
}

function mkEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    src: '',
    hidden: false,
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    attrs: {},
    children: [],
    parent: null,
    listeners: [],
    appendChild(node: FakeEl): FakeEl {
      node.parent = el
      el.children.push(node)
      return node
    },
    replaceChildren(...nodes: FakeEl[]): void {
      for (const n of nodes) n.parent = el
      el.children = nodes
    },
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value
    },
    getAttribute(name: string): string | null {
      return name in el.attrs ? el.attrs[name] : null
    },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      el.listeners.push({ type, fn })
    },
  }
  return el
}

function fire(el: FakeEl, type: string, event: unknown = { target: null }): void {
  for (const listener of [...el.listeners]) {
    if (listener.type === type) listener.fn(event)
  }
}

// Контроллер создаёт <option> через document.createElement
;(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => mkEl(tag),
}

const ELEMENT_KEYS: Array<keyof PrintDialogElements> = [
  'settings', 'overlay', 'title', 'destination', 'printerRow', 'rangeMode', 'rangeCustom',
  'rangeFrom', 'rangeTo', 'copies', 'landscape', 'pageSize', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'noMargins', 'scale', 'printBackground', 'displayHeaderFooter',
  'thumbs', 'thumbsNote', 'showAll', 'pageCounter', 'status', 'cancel', 'savePdf', 'print',
]

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]) // '%PDF'

interface Harness {
  el: Record<keyof PrintDialogElements, FakeEl>
  dialog: PrintDialogController
  printers: ShellPrinter[]
  printersFail: Error | null
  pages: number
  buildCalls: PrintSettings[]
  printCalls: PrintSettings[]
  saveCalls: Array<{ settings: PrintSettings; bytes: Uint8Array }>
  persisted: PrintSettings[]
  buildFail: Error | null
  renderFail: Error | null
  printFail: Error | null
}

function setup(partial: Partial<Harness> = {}): Harness {
  const el = {} as Record<keyof PrintDialogElements, FakeEl>
  for (const key of ELEMENT_KEYS) el[key] = mkEl(key === 'thumbs' ? 'div' : 'input')
  el.overlay.hidden = true
  const h: Harness = {
    el,
    dialog: null as unknown as PrintDialogController,
    printers: [{ name: 'HP', displayName: 'HP LaserJet', description: '' }],
    printersFail: null,
    pages: 3,
    buildCalls: [],
    printCalls: [],
    saveCalls: [],
    persisted: [],
    buildFail: null,
    renderFail: null,
    printFail: null,
    ...partial,
  }
  const elements = {} as Record<keyof PrintDialogElements, HTMLElement>
  for (const key of ELEMENT_KEYS) elements[key] = el[key] as unknown as HTMLElement
  const hooks: PrintDialogHooks = {
    listPrinters: async () => {
      if (h.printersFail) throw h.printersFail
      return h.printers
    },
    buildPdf: async (settings) => {
      h.buildCalls.push(settings)
      if (h.buildFail) throw h.buildFail
      return PDF_BYTES
    },
    renderThumbs: async (_bytes, limit) => {
      if (h.renderFail) throw h.renderFail
      return Array.from({ length: Math.max(0, Math.min(limit, h.pages)) }, () => 'data:image/png;base64,AAA')
    },
    doPrint: async (settings) => {
      if (h.printFail) throw h.printFail
      h.printCalls.push(settings)
    },
    doSavePdf: async (settings, bytes) => {
      h.saveCalls.push({ settings, bytes })
      return true
    },
    documentTitle: () => 'Документ',
    persist: async (settings) => {
      h.persisted.push(settings)
    },
  }
  h.dialog = createPrintDialog(elements as PrintDialogElements, hooks)
  return h
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('диалог печати', () => {
  it('открывается, наполняет поля и показывает превью со счётчиком', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ deviceName: 'HP', landscape: true, copies: 2 }))
    assert.equal(h.dialog.isOpen(), true)
    assert.equal(h.el.overlay.hidden, false)
    assert.equal(h.el.title.textContent, 'Документ')
    assert.equal(h.el.rangeMode.value, 'all')
    assert.equal(h.el.copies.value, '2')
    assert.equal(h.el.landscape.value, 'landscape')
    assert.equal(h.el.pageSize.value, 'A4')
    assert.equal(h.el.marginTop.value, '20')
    assert.equal(h.el.scale.value, '100')
    assert.equal(h.el.pageCounter.textContent, 'Страница 1 из 3')
    assert.equal(h.el.thumbs.children.length, 3)
    assert.equal(h.buildCalls.length, 1)
  })

  it('второй open() пока открытого диалога игнорирует', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    await h.dialog.open(normalizePrintSettings({ copies: 5 }))
    assert.equal(h.el.copies.value, '1')
  })

  it('прячет блок принтера и блокирует «Печать», когда принтеров нет', async () => {
    const h = setup({ printers: [] })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.printerRow.hidden, true)
    assert.equal(h.el.print.disabled, true)
    assert.equal(h.el.savePdf.disabled, false)
    assert.equal(h.el.status.textContent, 'Принтеры не найдены — доступно сохранение в PDF')
  })

  it('при сбое списка принтеров остаётся только PDF и показывается подсказка', async () => {
    const h = setup({ printersFail: new Error('WMI сломан') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.destination.children.length, 1)
    assert.equal(h.el.printerRow.hidden, true)
    assert.equal(h.el.status.textContent, 'Не удалось получить список принтеров')
  })

  it('недоступный принтер из конфига переключает назначение на PDF с подсказкой', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'Нет такого' }))
    assert.equal(h.dialog.currentSettings().destination, 'pdf')
    assert.equal(h.el.status.textContent, 'Принтер «Нет такого» больше не доступен — печатаем в PDF')
  })

  it('refresh пересчитывает превью с новыми полями', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    h.el.scale.value = '150'
    await h.dialog.refresh()
    assert.equal(h.buildCalls.length, 2)
    assert.equal(h.buildCalls[1].scale, 150)
  })

  it('клик по миниатюре выбирает текущую страницу', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.thumbs.children[2], 'click', { target: h.el.thumbs.children[2] })
    assert.equal(h.dialog.currentPage(), 3)
    assert.equal(h.el.pageCounter.textContent, 'Страница 3 из 3')
    assert.equal(h.el.thumbs.children[2].className, 'print-thumb current')
  })

  it('«Показать все» снимает лимит в 10 миниатюр', async () => {
    const h = setup({ pages: 12 })
    await h.dialog.open(normalizePrintSettings({}))
    assert.equal(h.el.thumbs.children.length, 10)
    assert.equal(h.el.thumbsNote.textContent, 'Показаны первые 10 из 12')
    assert.equal(h.el.showAll.hidden, false)
    fire(h.el.showAll, 'click')
    await flush()
    assert.equal(h.el.thumbs.children.length, 12)
    assert.equal(h.el.thumbsNote.textContent, '')
    assert.equal(h.el.showAll.hidden, true)
  })

  it('«Сохранить как PDF» отдаёт байты, сохраняет настройки и закрывает', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.savePdf, 'click')
    await flush()
    assert.equal(h.saveCalls.length, 1)
    assert.deepEqual(Array.from(h.saveCalls[0].bytes), Array.from(PDF_BYTES))
    assert.equal(h.persisted.length, 1)
    assert.equal(h.el.overlay.hidden, true)
  })

  it('«Печать» зовёт doPrint, persist и закрывает', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.printCalls.length, 1)
    assert.equal(h.persisted.length, 1)
    assert.equal(h.el.overlay.hidden, true)
  })

  it('при сбое buildPdf показывает ошибку и блокирует кнопки', async () => {
    const h = setup({ buildFail: new Error('нет содержимого') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.status.textContent, 'Не удалось построить предпросмотр: нет содержимого')
    assert.equal(h.el.print.disabled, true)
    assert.equal(h.el.savePdf.disabled, true)
    assert.equal(h.el.overlay.hidden, false)
  })

  it('падение рендера миниатюр не блокирует печать и сохранение (спека §9)', async () => {
    const h = setup({ renderFail: new Error('битый PDF') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    assert.equal(h.el.status.textContent, 'Не удалось построить предпросмотр')
    assert.equal(h.el.print.disabled, false)
    assert.equal(h.el.savePdf.disabled, false)
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.printCalls.length, 1)
  })

  it('при сбое doPrint показывает ошибку, разблокирует кнопки, не закрывает и не сохраняет', async () => {
    const h = setup({ printFail: new Error('диалог не открылся') })
    await h.dialog.open(normalizePrintSettings({ destination: 'printer', deviceName: 'HP' }))
    fire(h.el.print, 'click')
    await flush()
    assert.equal(h.el.status.textContent, 'Печать не удалась: диалог не открылся')
    assert.equal(h.el.print.disabled, false)
    assert.equal(h.el.overlay.hidden, false)
    assert.equal(h.persisted.length, 0)
  })

  it('«Отмена» закрывает диалог и ничего не сохраняет', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.cancel, 'click')
    assert.equal(h.dialog.isOpen(), false)
    assert.equal(h.persisted.length, 0)
  })

  it('кнопка «Поля: нет» обнуляет все четыре поля', async () => {
    const h = setup()
    await h.dialog.open(normalizePrintSettings({}))
    fire(h.el.noMargins, 'click')
    assert.equal(h.el.marginTop.value, '0')
    assert.equal(h.el.marginBottom.value, '0')
    assert.equal(h.el.marginLeft.value, '0')
    assert.equal(h.el.marginRight.value, '0')
  })
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npm run test`
Expected: FAIL — `createPrintDialog is not a function` (экспорта ещё нет).

- [ ] **Step 3: Реализация контроллера**

Дописать в конец `src/renderer/src/print-dialog.ts`:

```ts
export interface PrintDialogElements {
  /** Контейнер всех полей настроек — на него вешается пересчёт превью */
  settings: HTMLElement
  overlay: HTMLElement
  title: HTMLElement
  destination: HTMLElement
  printerRow: HTMLElement
  rangeMode: HTMLElement
  rangeCustom: HTMLElement
  rangeFrom: HTMLElement
  rangeTo: HTMLElement
  copies: HTMLElement
  landscape: HTMLElement
  pageSize: HTMLElement
  marginTop: HTMLElement
  marginBottom: HTMLElement
  marginLeft: HTMLElement
  marginRight: HTMLElement
  noMargins: HTMLElement
  scale: HTMLElement
  printBackground: HTMLElement
  displayHeaderFooter: HTMLElement
  thumbs: HTMLElement
  thumbsNote: HTMLElement
  showAll: HTMLElement
  pageCounter: HTMLElement
  status: HTMLElement
  cancel: HTMLElement
  savePdf: HTMLElement
  print: HTMLElement
}

export interface PrintDialogHooks {
  listPrinters: () => Promise<ShellPrinter[]>
  /** Собрать PDF: view.printToPDF(printToPdfOptions(settings)) */
  buildPdf: (settings: PrintSettings) => Promise<Uint8Array>
  /** PDF → data URL миниатюр; limit — сколько нужно сейчас (10 или все) */
  renderThumbs: (bytes: Uint8Array, limit: number) => Promise<string[]>
  /** Системная печать: view.print(printOptions(settings, …)) */
  doPrint: (settings: PrintSettings) => Promise<void>
  /** window.shell.savePdf(bytesToBase64(bytes), suggestedPdfName(title)) */
  doSavePdf: (settings: PrintSettings, bytes: Uint8Array) => Promise<boolean>
  documentTitle: () => string
  /** Запись config.print — только при успешной печати/сохранении */
  persist: (settings: PrintSettings) => Promise<void>
}

export interface PrintDialogController {
  open: (settings: PrintSettings) => Promise<void>
  close: () => void
  isOpen: () => boolean
  refresh: () => Promise<void>
  currentSettings: () => PrintSettings
  currentPage: () => number
  pageCount: () => number
  previewBytes: () => Uint8Array | null
}

/** Миниатюр показываем по 10; остальное — по кнопке «Показать все» */
const THUMB_LIMIT = 10
const PDF_OPTION = 'pdf'

/**
 * Контроллер диалога печати. Не знает ни про Electron, ни про webview —
 * всё через хуки, поэтому тестируется под node --test с FakeEl.
 * Таймеров нет: debounce пересчёта превью живёт в вызывающем коде (main.ts).
 */
export function createPrintDialog(elements: PrintDialogElements, hooks: PrintDialogHooks): PrintDialogController {
  let open = false
  let printers: ShellPrinter[] = []
  let bytes: Uint8Array | null = null
  let thumbs: string[] = []
  let currentPage = 1
  let showAll = false
  let busy = false
  /** Растёт на каждый refresh: результат устаревшей сборки игнорируется */
  let generation = 0

  const input = (el: HTMLElement): HTMLInputElement => el as HTMLInputElement
  const readValue = (el: HTMLElement): string => input(el).value ?? ''
  const readChecked = (el: HTMLElement): boolean => input(el).checked === true
  const toInt = (el: HTMLElement, fallback: number): number => {
    const n = Math.floor(Number(readValue(el)))
    return Number.isFinite(n) ? n : fallback
  }
  const toFloat = (el: HTMLElement, fallback: number): number => {
    const n = Number(readValue(el))
    return Number.isFinite(n) ? n : fallback
  }
  const fill = (el: HTMLElement, value: string | number | boolean): void => {
    input(el).value = String(value)
  }
  const setStatus = (text: string): void => {
    elements.status.textContent = text
  }

  const currentDeviceName = (): string => {
    const value = readValue(elements.destination)
    return printers.some((p) => p.name === value) ? value : ''
  }

  const currentSettings = (): PrintSettings =>
    normalizePrintSettings({
      destination: currentDeviceName() ? 'printer' : PDF_OPTION,
      deviceName: currentDeviceName(),
      rangeMode: readValue(elements.rangeMode),
      rangeFrom: toInt(elements.rangeFrom, DEFAULTS.rangeFrom),
      rangeTo: toInt(elements.rangeTo, DEFAULTS.rangeTo),
      copies: toInt(elements.copies, DEFAULTS.copies),
      landscape: readValue(elements.landscape) === 'landscape',
      pageSize: readValue(elements.pageSize),
      marginTop: toFloat(elements.marginTop, DEFAULTS.marginTop),
      marginBottom: toFloat(elements.marginBottom, DEFAULTS.marginBottom),
      marginLeft: toFloat(elements.marginLeft, DEFAULTS.marginLeft),
      marginRight: toFloat(elements.marginRight, DEFAULTS.marginRight),
      scale: toInt(elements.scale, DEFAULTS.scale),
      printBackground: readChecked(elements.printBackground),
      displayHeaderFooter: readChecked(elements.displayHeaderFooter),
    })

  const fillSettings = (s: PrintSettings): void => {
    elements.title.textContent = hooks.documentTitle() || 'Документ'
    fill(elements.rangeMode, s.rangeMode)
    fill(elements.rangeFrom, s.rangeFrom)
    fill(elements.rangeTo, s.rangeTo)
    fill(elements.copies, s.copies)
    fill(elements.landscape, s.landscape ? 'landscape' : 'portrait')
    fill(elements.pageSize, s.pageSize)
    fill(elements.marginTop, s.marginTop)
    fill(elements.marginBottom, s.marginBottom)
    fill(elements.marginLeft, s.marginLeft)
    fill(elements.marginRight, s.marginRight)
    fill(elements.scale, s.scale)
    input(elements.printBackground).checked = s.printBackground
    input(elements.displayHeaderFooter).checked = s.displayHeaderFooter
    elements.rangeCustom.hidden = s.rangeMode !== 'custom'
  }

  const buildDestination = (selected: string): void => {
    const options: Array<{ value: string; label: string }> = [
      { value: PDF_OPTION, label: 'Сохранить как PDF' },
    ]
    for (const p of printers) options.push({ value: p.name, label: p.displayName || p.name })
    elements.destination.replaceChildren(
      ...options.map((o) => {
        const option = document.createElement('option')
        option.value = o.value
        option.textContent = o.label
        return option
      }),
    )
    fill(elements.destination, options.some((o) => o.value === selected) ? selected : PDF_OPTION)
  }

  const syncButtons = (): void => {
    const s = currentSettings()
    const hasPrinter = printers.length > 0 && printers.some((p) => p.name === s.deviceName)
    const broken = bytes === null
    elements.print.disabled = busy || broken || s.destination !== 'printer' || !hasPrinter
    elements.savePdf.disabled = busy || broken
    elements.cancel.disabled = busy
  }

  const paintThumbs = (): void => {
    const limit = showAll ? thumbs.length : Math.min(THUMB_LIMIT, thumbs.length)
    const nodes: HTMLElement[] = []
    for (let i = 0; i < limit; i++) {
      const img = document.createElement('img')
      img.src = thumbs[i] ?? ''
      img.alt = `Страница ${i + 1}`
      img.dataset.page = String(i + 1)
      img.className = i + 1 === currentPage ? 'print-thumb current' : 'print-thumb'
      nodes.push(img)
    }
    elements.thumbs.replaceChildren(...nodes)
    if (thumbs.length > THUMB_LIMIT && !showAll) {
      elements.thumbsNote.textContent = `Показаны первые ${THUMB_LIMIT} из ${thumbs.length}`
      elements.showAll.hidden = false
    } else {
      elements.thumbsNote.textContent = ''
      elements.showAll.hidden = true
    }
    const total = Math.max(1, thumbs.length)
    elements.pageCounter.textContent = `Страница ${Math.min(currentPage, total)} из ${thumbs.length}`
  }

  const refresh = async (): Promise<void> => {
    if (!open) return
    const my = ++generation
    const settings = currentSettings()
    setStatus('Готовим предпросмотр…')
    try {
      const built = await hooks.buildPdf(settings)
      if (my !== generation || !open) return
      const limit = showAll ? Number.MAX_SAFE_INTEGER : THUMB_LIMIT
      // Провал рендера миниатюр НЕ ломает печать: PDF уже есть, показываем
      // заглушку и оставляем кнопки рабочими (спека §9).
      let painted: string[] = []
      try {
        const out = await hooks.renderThumbs(built, limit)
        painted = Array.isArray(out) ? out : []
      } catch (renderErr) {
        console.warn('[print] не удалось построить миниатюры:', renderErr)
      }
      if (my !== generation || !open) return
      bytes = built
      thumbs = painted
      if (currentPage > thumbs.length) currentPage = Math.max(1, thumbs.length)
      paintThumbs()
      setStatus(painted.length > 0 ? '' : 'Не удалось построить предпросмотр')
    } catch (err) {
      if (my !== generation || !open) return
      bytes = null
      thumbs = []
      paintThumbs()
      setStatus(`Не удалось построить предпросмотр: ${err instanceof Error ? err.message : String(err)}`)
    }
    syncButtons()
  }

  const close = (): void => {
    if (!open) return
    open = false
    generation++
    elements.overlay.hidden = true
  }

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    syncButtons()
    try {
      await action()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      busy = false
      syncButtons()
    }
  }

  elements.cancel.addEventListener('click', close)
  elements.showAll.addEventListener('click', () => {
    showAll = true
    void refresh()
  })
  elements.noMargins.addEventListener('click', () => {
    fill(elements.marginTop, 0)
    fill(elements.marginBottom, 0)
    fill(elements.marginLeft, 0)
    fill(elements.marginRight, 0)
  })
  elements.print.addEventListener('click', () => {
    void runAction(async () => {
      const settings = currentSettings()
      await hooks.doPrint(settings)
      await hooks.persist(settings)
      close()
    })
  })
  elements.savePdf.addEventListener('click', () => {
    void runAction(async () => {
      const settings = currentSettings()
      const data = bytes ?? (await hooks.buildPdf(settings))
      bytes = data
      await hooks.doSavePdf(settings, data)
      await hooks.persist(settings)
      close()
    })
  })
  elements.thumbs.addEventListener('click', (event) => {
    const target = event && typeof event === 'object' ? (event as { target?: { dataset?: { page?: string } } }).target : null
    const page = Number(target?.dataset?.page)
    if (!Number.isFinite(page) || page < 1) return
    currentPage = page
    paintThumbs()
  })

  elements.overlay.hidden = true

  const openDialog = async (settings: PrintSettings): Promise<void> => {
    if (open) return
    open = true
    bytes = null
    thumbs = []
    currentPage = 1
    showAll = false
    elements.overlay.hidden = false
    setStatus('Загружаем список принтеров…')
    let list: ShellPrinter[] = []
    let printersFailed = false
    try {
      list = await hooks.listPrinters()
    } catch (err) {
      console.warn('[print] список принтеров недоступен:', err)
      printersFailed = true
    }
    if (!open) return
    printers = Array.isArray(list) ? list : []
    const known = printers.some((p) => p.name === settings.deviceName)
    buildDestination(settings.destination === 'printer' && known ? settings.deviceName : PDF_OPTION)
    fillSettings(settings)
    if (printers.length === 0) {
      elements.printerRow.hidden = true
      setStatus(printersFailed ? 'Не удалось получить список принтеров' : 'Принтеры не найдены — доступно сохранение в PDF')
    } else {
      elements.printerRow.hidden = false
      if (settings.destination === 'printer' && !known) {
        setStatus(`Принтер «${settings.deviceName}» больше не доступен — печатаем в PDF`)
      }
    }
    syncButtons()
    await refresh()
  }

  return {
    open: openDialog,
    close,
    isOpen: () => open,
    refresh,
    currentSettings,
    currentPage: () => currentPage,
    pageCount: () => thumbs.length,
    previewBytes: () => bytes,
  }
}
```

- [ ] **Step 4: Проверка**

Run: `npm run test`
Expected: `fail 0`, число тестов выросло на 14 кейсов контроллера (итого 88).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Коммит**

```bash
git add src/renderer/src/print-dialog.ts src/renderer/src/print-dialog.test.ts
git commit -m "feat(print): print dialog controller"
```

### Task 4: Зависимость pdf.js и рендер миниатюр

**Files:**
- Modify: `package.json`, `package-lock.json` (установка зависимости)
- Create: `src/renderer/src/print-preview.ts`

**Interfaces:**
- Consumes: ничего из задач 1–3 (модуль самодостаточен, подключит его задача 6).
- Produces: `renderPdfThumbnails(bytes: Uint8Array, width: number, limit: number): Promise<{ pageCount: number; thumbs: string[] }>` — data URL миниатюр, `limit` ограничивает количество (но `pageCount` всегда реальный), при превышении лимита рендерит порционно по `requestAnimationFrame`; при ошибке — `{ pageCount: 0, thumbs: [] }` и `console.warn` (исключение наружу не бросает, чтобы оверлей показал заглушку сам).

- [ ] **Step 1: Установить зависимость**

Run: `npm install --save-exact pdfjs-dist@6.3.289`
Expected: `added/changed … packages`, 0 vulnerabilities. Если версия 6.3.289 недоступна — выполнить `npm view pdfjs-dist versions --json`, взять последнюю 6.3.x и записать её в отчёт о задаче.

- [ ] **Step 2: Создать `print-preview.ts`**

```ts
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs'

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
  try {
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false })
    const doc = await task.promise
    const pageCount = doc.numPages
    const wanted = Math.max(1, Math.min(limit, pageCount))
    const thumbs: string[] = []
    for (let i = 1; i <= wanted; i++) {
      if (i > 1) await nextFrame()
      thumbs.push(await renderPage(doc, i, width))
    }
    return { pageCount, thumbs }
  } catch (err) {
    console.warn('[print] не удалось разобрать PDF:', err)
    return { pageCount: 0, thumbs: [] }
  }
}
```

- [ ] **Step 3: Проверка**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: сборка успешна; в `out/renderer/assets/*.js` присутствует `pdf.worker` (воркер попал в бандл как отдельный asset) — проверить: `Get-ChildItem out/renderer/assets | Select-String pdf` даёт непустой результат либо в бандле есть строка `pdf.worker`.

Run: `npm run test`
Expected: `fail 0` (число тестов не изменилось).

- [ ] **Step 4: Коммит**

```bash
git add package.json package-lock.json src/renderer/src/print-preview.ts
git commit -m "feat(print): pdf.js thumbnail renderer"
```

---

### Task 5: Разметка оверлея и стили

**Files:**
- Modify: `src/renderer/index.html` (после блока `#error-overlay`, который заканчивается на строке 201)
- Modify: `src/renderer/src/styles.css` (после блока `#error-overlay` / `.error-card button:hover`, то есть после строки 1063)

**Interfaces:**
- Consumes: id и классы, которые ожидает `print-dialog.ts` из задачи 3 (список — в Step 1).
- Produces: DOM-контракт оверлея печати.

- [ ] **Step 1: Разметка в `index.html`**

Вставить после строки 201 (`  </div>` — закрытие `#error-overlay`):

```html
  <div id="print-overlay" hidden>
    <div class="print-panel">
      <div class="print-head">
        <span class="print-title" id="print-title">Документ</span>
        <button id="print-cancel-x" class="print-x" title="Закрыть" aria-label="Закрыть">&times;</button>
      </div>
      <div class="print-body">
        <div class="print-settings" id="print-settings">
          <label class="print-field">
            <span class="print-label">Назначение</span>
            <select id="print-destination"></select>
          </label>
          <label class="print-field" id="print-printer-row">
            <span class="print-label">Принтер</span>
            <select id="print-printer"></select>
          </label>
          <label class="print-field">
            <span class="print-label">Диапазон</span>
            <select id="print-range-mode">
              <option value="all">Все страницы</option>
              <option value="current">Текущая</option>
              <option value="custom">Страницы…</option>
            </select>
          </label>
          <div class="print-range-custom" id="print-range-custom" hidden>
            <input id="print-range-from" type="number" min="1" step="1" aria-label="С первой страницы" />
            <span class="print-dash">–</span>
            <input id="print-range-to" type="number" min="1" step="1" aria-label="По последнюю страницу" />
            <button type="button" id="print-no-margins" class="print-link">Поля: нет</button>
          </div>
          <label class="print-field">
            <span class="print-label">Копии</span>
            <input id="print-copies" type="number" min="1" max="99" step="1" />
          </label>
          <label class="print-field">
            <span class="print-label">Ориентация</span>
            <select id="print-landscape">
              <option value="portrait">Книжная</option>
              <option value="landscape">Альбомная</option>
            </select>
          </label>
          <label class="print-field">
            <span class="print-label">Бумага</span>
            <select id="print-page-size">
              <option value="A4">A4</option>
              <option value="A3">A3</option>
              <option value="A5">A5</option>
              <option value="A6">A6</option>
              <option value="Letter">Letter</option>
              <option value="Legal">Legal</option>
              <option value="Tabloid">Tabloid</option>
            </select>
          </label>
          <div class="print-margins">
            <span class="print-label">Поля, мм</span>
            <label>верх <input id="print-margin-top" type="number" min="0" max="50" step="1" /></label>
            <label>низ <input id="print-margin-bottom" type="number" min="0" max="50" step="1" /></label>
            <label>лево <input id="print-margin-left" type="number" min="0" max="50" step="1" /></label>
            <label>право <input id="print-margin-right" type="number" min="0" max="50" step="1" /></label>
          </div>
          <label class="print-field">
            <span class="print-label">Масштаб, %</span>
            <input id="print-scale" type="number" min="10" max="200" step="5" />
          </label>
          <label class="print-check">
            <input id="print-background" type="checkbox" />
            Печатать фон
          </label>
          <label class="print-check">
            <input id="print-header-footer" type="checkbox" />
            Колонтитулы (номера и дата)
          </label>
        </div>
        <div class="print-preview">
          <div class="print-preview-head">
            <span id="print-page-counter">Страница 1 из 1</span>
            <span id="print-status" class="print-status"></span>
          </div>
          <div class="print-thumbs" id="print-thumbs"></div>
          <div class="print-thumbs-foot">
            <span id="print-thumbs-note"></span>
            <button type="button" id="print-show-all" hidden>Показать все</button>
          </div>
        </div>
      </div>
      <div class="print-foot">
        <button type="button" id="print-cancel" class="print-btn">Отмена</button>
        <span class="print-foot-spacer"></span>
        <button type="button" id="print-save" class="print-btn">Сохранить как PDF</button>
        <button type="button" id="print-go" class="print-btn primary">Печать</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Стили в `styles.css`**

Вставить после строки 1063 (`.error-card button:hover { … }`):

```css
/* Диалог печати: слева настройки, справа превью страниц (как в Chrome) */
#print-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(9, 10, 14, 0.6);
}

#print-overlay[hidden] {
  display: none;
}

.print-panel {
  display: flex;
  flex-direction: column;
  width: min(980px, calc(100% - 48px));
  height: min(720px, calc(100% - 48px));
  background: var(--chrome);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.print-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.print-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.print-x {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  font-size: 16px;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: default;
}

.print-x:hover {
  color: var(--text);
  background: var(--accent-soft);
}

.print-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.print-settings {
  width: 280px;
  flex: none;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.print-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.print-label {
  font-size: 11.5px;
  color: var(--text-3);
}

.print-settings select,
.print-settings input[type='number'] {
  height: 30px;
  padding: 0 8px;
  color: var(--text);
  background: var(--content);
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 13px;
  outline: none;
}

.print-settings select:focus,
.print-settings input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.print-range-custom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.print-range-custom[hidden] {
  display: none;
}

.print-range-custom input {
  width: 64px;
}

.print-dash {
  color: var(--text-3);
}

.print-link {
  margin-left: auto;
  padding: 0;
  font-size: 11.5px;
  color: var(--text-2);
  background: transparent;
  border: none;
  cursor: default;
  text-decoration: underline;
}

.print-link:hover {
  color: var(--text);
}

.print-margins {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
}

.print-margins .print-label {
  grid-column: 1 / -1;
}

.print-margins label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.print-margins input {
  width: 100%;
}

.print-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}

.print-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.print-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
}

.print-status {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.print-thumbs {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 12px;
}

.print-thumb {
  width: 132px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: default;
}

.print-thumb.current {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.print-thumbs-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-3);
  border-top: 1px solid var(--border);
}

.print-thumbs-foot button {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--chrome-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: default;
}

.print-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.print-foot-spacer {
  flex: 1;
}

.print-btn {
  height: 32px;
  padding: 0 16px;
  font-size: 13px;
  color: var(--text);
  background: var(--chrome-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: default;
}

.print-btn:hover:not(:disabled) {
  background: var(--surface);
}

.print-btn:disabled {
  opacity: 0.45;
}

.print-btn.primary {
  color: #fff;
  background: var(--accent);
  border-color: transparent;
}

.print-btn.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
```

- [ ] **Step 3: Проверка**

Run: `npm run build`
Expected: успешно; в `out/renderer/index.html` есть `id="print-overlay"` и `id="print-go"`.

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run test`
Expected: `fail 0`.

- [ ] **Step 4: Коммит**

```bash
git add src/renderer/index.html src/renderer/src/styles.css
git commit -m "feat(print): dialog markup and styles"
```

---

### Task 6: Интеграция в оболочку

**Files:**
- Modify: `src/renderer/src/main.ts`

**Interfaces:**
- Consumes: `createPrintDialog`, `normalizePrintSettings`, `printToPdfOptions`, `printOptions`, `bytesToBase64`, `suggestedPdfName` из `print-dialog.ts`; `renderPdfThumbnails` из `print-preview.ts`; типы `PrintDialogController`, `PrintDialogElements`, `PrintDialogHooks`; `ShellApi.listPrinters` / `onOpenPrint` из задачи 1; поле `config.print`.
- Produces: `openPrintDialog(tab: ShellTab | null): Promise<void>` — единственная точка входа; три вызова из `handleShortcut('print')`, хука `onPrint` меню адреса и подписки `shell:open-print`.

- [ ] **Step 1: Импорты**

Рядом с импортом меню адреса (строка 3) добавить:

```ts
import {
  bytesToBase64,
  createPrintDialog,
  normalizePrintSettings,
  printOptions,
  printToPdfOptions,
  suggestedPdfName,
  type PrintDialogController,
  type PrintDialogElements,
  type PrintDialogHooks,
} from './print-dialog'
import { renderPdfThumbnails } from './print-preview'
```

- [ ] **Step 2: Модульные переменные и сбор элементов**

Рядом с `let addressMenu: AddressMenuController | null = null` (около строки 30) добавить:

```ts
/** Диалог печати; собирается в wirePrintDialog */
let printDialog: PrintDialogController | null = null
/** Debounce пересчёта превью печати (250 мс) */
let printRefreshTimer: number | null = null
```

- [ ] **Step 3: `openPrintDialog` и `wirePrintDialog`**

Вставить перед `function wireToolbar()` (строка 2293):

```ts
/** Ширина миниатюры превью печати, px */
const PRINT_THUMB_WIDTH = 132

function printElements(): PrintDialogElements | null {
  const get = (id: string): HTMLElement | null => document.getElementById(id)
  const ids: Record<keyof PrintDialogElements, string> = {
    overlay: 'print-overlay',
    title: 'print-title',
    destination: 'print-destination',
    printerRow: 'print-printer-row',
    rangeMode: 'print-range-mode',
    rangeCustom: 'print-range-custom',
    rangeFrom: 'print-range-from',
    rangeTo: 'print-range-to',
    copies: 'print-copies',
    landscape: 'print-landscape',
    pageSize: 'print-page-size',
    marginTop: 'print-margin-top',
    marginBottom: 'print-margin-bottom',
    marginLeft: 'print-margin-left',
    marginRight: 'print-margin-right',
    noMargins: 'print-no-margins',
    scale: 'print-scale',
    printBackground: 'print-background',
    displayHeaderFooter: 'print-header-footer',
    thumbs: 'print-thumbs',
    thumbsNote: 'print-thumbs-note',
    showAll: 'print-show-all',
    pageCounter: 'print-page-counter',
    status: 'print-status',
    cancel: 'print-cancel',
    savePdf: 'print-save',
    print: 'print-go',
    settings: 'print-settings',
  }
  const out = {} as Record<keyof PrintDialogElements, HTMLElement>
  for (const key of Object.keys(ids) as Array<keyof PrintDialogElements>) {
    const el = get(ids[key])
    if (!el) return null
    out[key] = el
  }
  return out as PrintDialogElements
}

/** Пересчёт превью с debounce: поля меняются мышью, PDF печатать не каждый раз */
function schedulePrintRefresh(): void {
  if (printRefreshTimer !== null) window.clearTimeout(printRefreshTimer)
  printRefreshTimer = window.setTimeout(() => {
    printRefreshTimer = null
    void printDialog?.refresh()
  }, 250)
}

/**
 * Единственная точка входа в диалог печати: Ctrl+P, пункт меню адреса
 * и «Печать…» из контекстного меню гостя.
 */
async function openPrintDialog(tab: ShellTab | null): Promise<void> {
  if (!tab) {
    setStatus('нет активной вкладки')
    return
  }
  if (!printDialog) {
    setStatus('диалог печати недоступен')
    return
  }
  if (printDialog.isOpen()) return
  await printDialog.open(normalizePrintSettings(config?.print))
}

function wirePrintDialog(): void {
  const elements = printElements()
  if (!elements) return
  const view = () => activeView()
  const hooks: PrintDialogHooks = {
    listPrinters: () => window.shell.listPrinters(),
    buildPdf: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      return target.printToPDF(printToPdfOptions(settings))
    },
    renderThumbs: (data, limit) => renderPdfThumbnails(data, PRINT_THUMB_WIDTH, limit),

    doPrint: async (settings) => {
      const target = view()
      if (!target) throw new Error('нет активной вкладки')
      const pageCount = printDialog?.pageCount() ?? 0
      const current = printDialog?.currentPage() ?? 1
      await target.print(printOptions(settings, settings.deviceName, pageCount, current))
    },
    doSavePdf: async (_settings, bytes) => {
      const name = suggestedPdfName(titleForPrint())
      return window.shell.savePdf(bytesToBase64(bytes), name)
    },
    documentTitle: () => titleForPrint(),
    persist: async (settings) => {
      config = await window.shell.setConfig({ print: settings })
    },
  }
  printDialog = createPrintDialog(elements, hooks)
  // Любое изменение настроек пересчитывает превью
  elements.settings.addEventListener('change', schedulePrintRefresh)
  elements.settings.addEventListener('input', schedulePrintRefresh)
  // Клик по фону оверлея закрывает диалог
  elements.overlay.addEventListener('click', (event) => {
    if (event.target === elements.overlay) printDialog?.close()
  })
  document.getElementById('print-cancel-x')?.addEventListener('click', () => printDialog?.close())
}

/** Заголовок документа для шапки диалога и имени PDF */
function titleForPrint(): string {
  try {
    return activeView()?.getTitle() ?? ''
  } catch {
    return ''
  }
}
```

**Важно:** поле `settings: HTMLElement` уже объявлено в `PrintDialogElements` в задаче 3, а `#print-settings` есть в разметке задачи 5 — поэтому в `printElements()` (Step 3) в карте `ids` обязательно присутствует строка `settings: 'print-settings'`, иначе `wirePrintDialog` вернётся на `if (!elements) return` и диалог не оживёт.

- [ ] **Step 4: Точки входа**

Заменить кейс `print` в `handleShortcut` (строки 2112–2120) на:

```ts
    case 'print':
      void openPrintDialog(activeTab())
      break
```

Заменить хук `onPrint` в `wireAddressMenu` (строки 2278–2282) на:

```ts
      onPrint: () => {
        void openPrintDialog(activeTab())
      },
```

В `handleShortcut`, цепочку `case 'escape'`, после блока `addressMenu` (строки 2141–2144) вставить:

```ts
      if (printDialog?.isOpen()) {
        printDialog.close()
        break
      }
```

В `init()`, рядом с прочими подписками (например после `window.shell.onOpenNewTab(...)`) добавить:

```ts
  window.shell.onOpenPrint(() => {
    void openPrintDialog(activeTab())
  })
```

И в `init()` рядом с `wireAddressMenu()` — то есть в `wireToolbar()` первой строкой после `wireAddressMenu()` — добавить `wirePrintDialog()`:

```ts
function wireToolbar(): void {
  wireAddressMenu()
  wirePrintDialog()
```

- [ ] **Step 6: Проверка**

Run: `npm run typecheck`
Expected: exit 0. Если ругается на `printDialog.ts` — чаще всего забыт `settings` в `PrintDialogElements` (Шаг 4).

Run: `npm run test`
Expected: `fail 0`.

Run: `npm run build`
Expected: успешно; в бандле renderer есть `print-overlay`, `printers:list`, `renderPdfThumbnails`.

- [ ] **Step 7: Коммит**

```bash
git add src/renderer/src/main.ts src/renderer/src/print-dialog.ts src/renderer/src/print-dialog.test.ts
git commit -m "feat(print): wire print dialog into the shell"
```

---

### Task 7: Финальные проверки

**Files:**
- Проверка: весь проект; правок не предполагается, при падениях — чинить в задаче, где возникло.

**Interfaces:**
- Consumes: всё из задач 1–6.
- Produces: подтверждение, что сборка целая; инструкция ручной проверки для пользователя.

- [ ] **Step 1: Полные проверки**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run test`
Expected: `fail 0`, число тестов 88.

Run: `npm run build`
Expected: успешно; `out/main`, `out/preload`, `out/renderer` собраны, в `out/renderer/assets` есть файл воркера pdf.js либо бандл содержит `pdf.worker`.

- [ ] **Step 2: Проверить границы рабочего дерева**

Run: `git status --porcelain`
Expected: пусто либо только `?? design-mockup.html` (чужой файл, не коммитить).

- [ ] **Step 3: Сообщить пользователю чек-лист живой проверки**

Передать пользователю (GUI в сессии недоступен):

1. `npm run dev:watch` → `Ctrl+P` — открывается диалог, видны миниатюры и счётчик «Страница 1 из N».
2. Смена ориентации/бумаги/полей/масштаба пересчитывает превью (через ~0,3 с), счётчик страниц меняется.
3. Пункт «Печать» в меню адреса (⋮) открывает тот же диалог; «Печать…» в ПКМ по странице — тоже.
4. «Печать» открывает системный диалог Windows с выбранным принтером; после печати настройки сохранены (проверить: закрыть приложение, открыть снова — поля/ориентация/принтер те же).
5. «Сохранить как PDF» — файл сохраняется, попадает в «Загрузки», открывается.
6. `Escape` и клик по фону закрывают диалог; во время печати закрытие не срабатывает.
7. Если принтеров в системе нет — в списке только «Сохранить как PDF», кнопка «Печать» недоступна.
8. Документ >10 страниц: «Показаны первые 10 из N» + «Показать все».

---

## Что НЕ входит в план

- Двусторонняя печать (`duplexMode`), монохром, закладки/шаблоны настроек, очередь и история печати.
- Просмотр PDF средствами оболочки, плагины `webview`.
- Настройки уровня Windows (порядок страниц, цветная/ч-б).
- Тема/раскладка диалога под светлую тему (тема только тёмная, как в макете).
