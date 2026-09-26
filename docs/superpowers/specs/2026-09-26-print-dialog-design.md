# Диалог печати в стиле Chrome — дизайн

Дата: 2026-09-26 · Статус: утверждён пользователем · Автор: brainstorming (архитектурный путь)

## 1. Цель

Сейчас печать из оболочки уходит в системный вызов: `Ctrl+P` и пункт «Печать» в меню адреса вызывают `view.print()` — пользователь сразу оказывается в диалоге Windows, без превью, без настроек страницы и без выбора, что именно печатать.

Цель — **свой диалог печати в оболочке**, визуально и по возможностям близкий к Chrome: выбор назначения (принтер или «Сохранить как PDF»), настройки страницы, живое превью страниц, счётчик «Страница 1 из N». Диалог — надстройка над существующими API Electron, а не замена им: системный диалог Windows всё ещё появится после нажатия «Печать».

## 2. Решения, зафиксированные с пользователем

| # | Решение |
|---|---|
| R1 | Уровень детализации — **с живым превью страниц**, как в Chrome (значит нужен рендер PDF в миниатюры). |
| R2 | Настройки печати **запоминаются между запусками**, рядом с существующим `config.zoom`. |
| R3 | Точки входа в диалог: **`Ctrl+P`**, пункт **«Печать» в меню адреса**, **«Печать» в контекстном меню гостя (ПКМ)**. |
| R4 | Кнопка «Печать» в нашем диалоге открывает **системный диалог Windows** (`silent: false`) с уже выбранным принтером. Не отправляет на принтер молча. |

## 3. Проверенные факты об API (Electron 44.4.5, `node_modules/electron/electron.d.ts`)

- `<webview>` умеет печатать сам: `print(options?: WebviewTagPrintOptions): Promise<void>` (стр. 20393) и `printToPDF(options?: PrintToPDFOptions): Promise<Uint8Array>` (стр. 20399) — обе «Same as `webContents.print*`», то есть печатают **main frame** (для нашей задачи правильно).
- `WebviewTagPrintOptions`: `silent`, `printBackground`, `deviceName` (системное имя, не «дружественное»), `margins` (`{marginType?, top?, bottom?, left?, right?}`), `landscape`, `pageSize` (`A3|A4|A5|Legal|Letter|Tabloid` или `{width,height}`), `copies`, `pageRanges`, `duplexMode`.
- `PrintToPDFOptions`: `landscape`, `margins` (`PrintToPDFMargins`), `pageSize` (`A0..A6|Legal|Letter|Tabloid|Ledger` или `{width,height}`), `printBackground`, `scale` (0.1..2), `displayHeaderFooter`, `headerTemplate`/`footerTemplate`, `generateDocumentOutline`, `generateTaggedPDF`, `pageRanges`.
- Список принтеров — **только из main**: `webContents.getPrintersAsync(): Promise<Electron.PrinterInfo[]>` (стр. 18276). `PrinterInfo` = `{ description, displayName, name, options }`; в UI показываем `displayName`, в `deviceName` передаём `name`.
- В renderer нет PDF-плеера (`<webview>` не поддерживает атрибут `plugins`), `capturePage` не даёт разбивки на страницы и не учитывает `@media print` ⇒ единственный прямой путь к превью — **`pdfjs-dist@6.3.289`** (`dist.unpackedSize` 34,8 МБ; в бандл уходит только `pdf.mjs` + `pdf.worker.mjs`, ~400 КБ).

## 4. Отвергнутые альтернативы

- **B. Скриншоты страниц через `capturePage`** — не даёт разбивки на страницы и рисует «как на экране»: превью врало бы относительно `@media print`. Отклонено.
- **C. Скрытое BrowserWindow с PDF-плеером Chromium** — требует `plugins: true`, скриншотит окно, хрупко, лишнее окно в процессе. Отклонено.
- **D. Только системный диалог, без своего UI** — текущее поведение, R1 его отвергает.

## 5. Архитектура

```
Ctrl+P ─┐
меню адреса ─┼─► openPrintDialog(tab) ─► print-dialog.ts (контроллер, чистый)
ПКМ гостя ─┘        │                        │
                    │                        ├─ settings-модель (SewConfig.print)
                    │                        ├─► print-preview.ts ─► pdf.js ─► canvas-миниатюры
                    │                        └─► window.shell.listPrinters()  (IPC → main)
                    │
                    ├─ «Сохранить как PDF» ─► view.printToPDF(opts) ─► window.shell.savePdf(...) (IPC → main)
                    └─ «Печать» ────────────► view.print({ silent: false, deviceName, … })
```

Единственная точка входа — `openPrintDialog(tab)`. Все три точки входа (R3) вызывают её; контекстное меню гостя живёт в main, поэтому оно шлёт канал `shell:open-print`, а renderer на него подписывается.

### 5.1 Новые модули

| Файл | Ответственность |
|---|---|
| `src/renderer/src/print-dialog.ts` | Контроллер диалога: модель настроек, валидация, сборка аргументов `printToPDF`/`print`, открытие/закрытие, busy-состояние, ошибки. DOM не создаёт — элементы передаются явно (образец: `address-menu.ts`), поэтому тестируется под `node --test` с `FakeEl`. |
| `src/renderer/src/print-dialog.test.ts` | Юнит-тесты чистых частей (модель, валидация, сборка аргументов, вкл/выкл кнопок). |
| `src/renderer/src/print-preview.ts` | Обёртка над pdf.js: `renderPdfThumbnails(bytes: Uint8Array, width: number, pageLimit: number): Promise<{ pageCount: number; thumbs: string[] }>`. Ловит свои ошибки и отдаёт их вызывающему. Воркер подключается Vite-способом: `new Worker(new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url), { type: 'module' })` — иначе сборка не переживёт путь к воркеру. Импортируем только `pdfjs-dist/build/pdf.mjs`, версию worker'а передаём через `GlobalWorkerOptions.workerSrc`. |

### 5.2 Изменяемые файлы

| Файл | Что меняется |
|---|---|
| `src/renderer/index.html` | Оверлей `#print-overlay` (hidden): шапка, `#print-settings` (левая панель), `#print-thumbs` (галерея), низ с кнопками. Плюс поля ввода. |
| `src/renderer/src/styles.css` | Стили оверлея и его элементов; палитра — только существующие переменные (`--surface`, `--chrome`, `--text`, `--text-2`, `--text-3`, `--border`, `--accent`, `--accent-soft`, `--danger`, `--shadow-sm`). Новых переменных не заводим. |
| `src/renderer/src/main.ts` | `openPrintDialog(tab)` + `wirePrintDialog()`; `handleShortcut('print')` и хук `onPrint` в `wireAddressMenu` → `openPrintDialog`; подписка `shell:open-print`; первое звено в цепочке `case 'escape'` (после меню адреса); чтение/запись `config.print`. |
| `src/renderer/src/shell-api.d.ts` | **Ambient, объявления без `export`**: в `SewWebViewElement` добавить `print(options?: PrintOptionsLike): Promise<void>` и `printToPDF(options?: PrintToPDFOptionsLike): Promise<Uint8Array>`; в `ShellApi` — `listPrinters(): Promise<ShellPrinter[]>` и `savePdf(suggestedName: string, bytes: Uint8Array): Promise<string | null>`. Локальные типы-синонимы печати объявляются в этом же файле. |
| `src/preload/index.ts` | Реализации `listPrinters` и `savePdf` по образцу существующих `popupMenu` / `copyText`. |
| `src/main/index.ts` | `ipcMain.handle('printers:list')` (`mainWindow.webContents.getPrintersAsync()` — список системных принтеров одинаков для любого webContents, поэтому гость не нужен) + маппинг в `{ name, displayName, description }`; `ipcMain.handle('printers:save-pdf')` (`dialog.showSaveDialog` → `writeFile`); канал `shell:open-print` в контекстном меню гостя (пункт «Печать» рядом с «Сохранить изображение как…»). |
| `src/main/config.ts` | Тип `PrintSettings` и новое поле `print?: PrintSettings` в `SewConfig` (по умолчанию `undefined`, дефолты применяет renderer). |
| `package.json` | Новая зависимость `pdfjs-dist@^6.3.289`. |

`src/renderer/src/main.ts` неимпортируем под `node --test` (верхнеуровневые `import './styles.css'`, `document`, `void init()`), поэтому для него юнит-тесты не пишем — тестируется чистая логика из `print-dialog.ts`/`print-preview.ts`.

## 6. Диалог: компоновка и поведение

Компоновка как в Chrome: **шапка** (заголовок документа) → **двухпанельная область** (слева настройки, справа галерея миниатюр) → **низ** (кнопки).

- **Назначение**: `select` — «Сохранить как PDF» + принтеры из `listPrinters()`. Если принтеров нет, остаётся только «Сохранить как PDF», а блок выбора принтера скрывается.
- **Диапазон**: «Все страницы» / «Текущая» / «1–N» (два числа). По умолчанию «Все».
- **Копии**: число, 1..99.
- **Ориентация**: книжная / альбомная.
- **Размер бумаги**: A4 / A3 / A5 / Letter / Legal / Tabloid / A6.
- **Поля**: четыре числа в мм (верх/низ/лево/право), счётчик «Нет» как в Chrome при нулевом поле. Значения 0..50.
- **Масштаб**: проценты 10..200, шаг 5.
- **«Печатать фон»**: чекбокс.
- **«Колонтитулы (номера и дата)»**: чекбокс → `displayHeaderFooter`.
- **Превью**: миниатюры слева направо/сверху вниз, текущая страница выделена акцентной рамкой, клик по миниатюре листает «текущую страницу»; счётчик «Страница 1 из N» по реальному `numPages`; при числе страниц больше `pageLimit` (10) показываем «Показаны первые 10 из N» и кнопку «Показать все» (снимает лимит, рендерит лениво по мере прокрутки).
- **Превью пересчитывается** при изменении настроек, влияющих на вёрстку (ориентация, бумага, поля, масштаб, фон, колонтитулы, диапазон), с debounce 250 мс; во время пересчёта — галочка «Готовим предпросмотр…».
- **Кнопки**: «Отмена» (курсив/вторичная), «Сохранить как PDF» (видна, когда назначение — PDF, и всегда доступна как запасной путь), «Печать» (primary, при назначении — принтер).

Поведение кнопок:
- **«Печать»** → `view.print({ silent: false, deviceName, pageRanges, copies, landscape, pageSize, margins, printBackground, duplexMode: undefined })` — системный диалог Windows с уже выбранным принтером (R4).
- **«Сохранить как PDF»** → `view.printToPDF({ … })` → `window.shell.savePdf(имя, bytes)`; расширение `.pdf` добавляется, если его нет; имя по умолчанию — заголовок документа или `document.pdf`. `pageRanges` в PDF **не применяем**: сохраняется весь документ (диапазон относится к печати), это же поведение обсуждено с пользователем.
- Во время печати/сохранения кнопки блокируются (busy), повторное нажатие игнорируется.
- Закрытие: «Отмена», `Escape`, клик по фону оверлея. Прерывание закрытия во время печати запрещено — сначала дождаться.

## 7. Модель настроек и её сохранение

`SewConfig.print` (в `%APPDATA%/SEWBrowser/config.json`, тем же путём, что `zoom`):

```ts
interface PrintSettings {
  destination: 'pdf' | 'printer'   // куда печатаем по умолчанию
  deviceName: string                // системное имя принтера, '' = не выбран
  rangeMode: 'all' | 'current' | 'custom'
  rangeFrom: number
  rangeTo: number
  copies: number
  landscape: boolean
  pageSize: 'A3' | 'A4' | 'A5' | 'A6' | 'Letter' | 'Legal' | 'Tabloid'
  marginTop: number                 // мм
  marginBottom: number
  marginLeft: number
  marginRight: number
  scale: number                     // %
  printBackground: boolean
  displayHeaderFooter: boolean
}
```

- Читаем при старте (рядом с `loadTnSettings`/`config`), дефолты — A4, книжная, поля 10/10/10/10 мм (для A4 — верх 20, низ 20, лево 10, право 10, как в Windows), масштаб 100, фон выкл, колонтитулы выкл, копии 1, диапазон «все», назначение «Сохранить как PDF».
- Пишем через существующий `window.shell.setConfig` — **только при нажатии «Печать» или «Сохранить как PDF»**, чтобы превращение кнопки в диалог и «покрутить масштаб и посмотреть» не затирали сохранённое (R2). Закрытие без печати — без записи.
- Значение `deviceName` проверяется при открытии: если принтера с таким именем больше нет в списке — молча переключаем назначение на «Сохранить как PDF» и показываем подсказку «Принтер X больше не доступен».
- Значения вне диапазонов (из ручного редактирования config) нормализуем при чтении — та же дисциплина, что у `normalizeTnAlertTtl`.

## 8. Точки входа

| Точка | Было | Стало |
|---|---|---|
| `Ctrl+P` | `handleShortcut` кейс `print` → `view.print()` | `openPrintDialog(activeTab())` |
| Меню адреса, пункт «Печать» | хук `onPrint` → `view.print()` | `openPrintDialog(activeTab())` |
| ПКМ по странице | пункта не было | новый пункт «Печать» в `guest.on('context-menu')` (`src/main/index.ts`) → `mainWindow.webContents.send('shell:open-print')` → `openPrintDialog(activeTab())` |

Кейс `print` в `handleShortcut` и в `guestShortcutName`/`shortcutFromEvent` остаётся (сам хоткей не меняется), меняется только его обработчик.

## 9. Края и отказоустойчивость

| Ситуация | Поведение |
|---|---|
| Принтеров в системе нет | В списке только «Сохранить как PDF», блок выбора принтера скрыт, кнопка «Печать» недоступна. |
| `printToPDF` бросил (страница без содержимого, загрузка не завершена) | В оверлее сообщение причины, кнопки «Печать»/«Сохранить» отключены, «Отмена» работает. |
| `listPrinters` бросил | Список назначения = только «Сохранить как PDF», подсказка «Не удалось получить список принтеров». |
| `savePdf` бросил / пользователь отменил диалог | Отмена — тишина; ошибка — сообщение в оверлее. |
| pdf.js не смог разобрать PDF | Превью показывает заглушку «Не удалось построить предпросмотр», печать и сохранение остаются доступными. |
| Документ больше 10 страниц | Миниатюры первых 10 + «Показаны первые 10 из N» + «Показать все» (ленивый рендер). |
| Очень большой документ (десятки страниц) | Рендер порционный, по одному кадру в `requestAnimationFrame`, UI не подвисает; busy-индикатор на время рендера. |
| `print()` бросил | Сообщение в оверлее, диалог остаётся открытым, кнопки разблокированы. |
| Нет активной вкладки | Диалог не открывается, `setStatus('нет активной вкладки')`. |

## 10. Тестирование

- `print-dialog.test.ts` (FakeEl, как в существующих `tabs.test.ts`/`address-menu.test.ts`): нормализация настроек, валидация полей (копии, масштаб, поля, диапазон), сборка аргументов `printToPDF` из настроек, сборка аргументов `print` из настроек (включая `deviceName`), вкл/выкл кнопок по назначению и наличию принтеров, отмена печати, блокировка при busy.
- `print-preview.ts` в юнит-тестах не тестируется (нужен настоящий PDF) — покрывается только отсутствие ошибок импорта; проверяется вживую.
- `npm run typecheck` (оба tsconfig) + `npm run test` (ожидается ≥ 59 тестов, ни один не падает) + `npm run build`.
- Живую оценку даёт пользователь в `npm run dev:watch`: открыть диалог по `Ctrl+P`, проверить превью, смену ориентации/бумаги/полей, сохранение в PDF, печать с системным диалогом, пункты «Печать» в меню адреса и в ПКМ, закрытие по `Escape`, сохранение настроек между запусками.

## 11. Что НЕ входит

- Двусторонняя печать (`duplexMode`), монохром, выбор страниц кликом по миниатюре, закладки/шаблоны настроек печати, очередь печати, история заданий.
- Плагины (`webview.plugins`) и просмотр PDF средствами оболочки.
- Настройки уровня Windows (порядок страниц, «цветная/ч/б»).

## 12. Карта правок

| Файл | Действие |
|---|---|
| `src/renderer/src/print-dialog.ts` | создать |
| `src/renderer/src/print-dialog.test.ts` | создать |
| `src/renderer/src/print-preview.ts` | создать |
| `src/renderer/index.html` | изменить (оверлей печати) |
| `src/renderer/src/styles.css` | изменить (стили оверлея) |
| `src/renderer/src/main.ts` | изменить (`openPrintDialog`, `wirePrintDialog`, 3 точки входа, `config.print`) |
| `src/renderer/src/shell-api.d.ts` | изменить (ambient, без `export`) |
| `src/preload/index.ts` | изменить (`listPrinters`, `savePdf`) |
| `src/main/index.ts` | изменить (`printers:list`, `printers:save-pdf`, пункт «Печать» в контекстном меню, канал `shell:open-print`) |
| `src/main/config.ts` | изменить (`PrintSettings`, `SewConfig.print`) |
| `package.json` | изменить (`pdfjs-dist`) |
