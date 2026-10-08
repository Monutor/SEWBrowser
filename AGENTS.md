# SEWBrowser — AI Context

> Главный источник по проекту (README в репозитории **нет**). Прочитать до работы.

## Что это

Выделенная десктопная браузерная оболочка под ОДНО стороннее веб-приложение:
`https://sew.mvideoeldorado.ru/v2/` (внутренняя система SEW, SPA).
Открывает только его страницу + инжектит собственные фичи (как расширения
браузера): оверлеи, перехват данных страницы, хоткеи, уведомления.

- Только Windows, установщик NSIS (electron-builder).
- Общение с пользователем и весь UI — **по-русски**.
- Репозиторий: `https://github.com/Monutor/SEWBrowser.git`, ветка `main`.

## Стек

Electron 44.4 + TypeScript 7 + electron-vite 5 (Vite 7) + electron-builder 26 +
electron-updater 6 + pdfjs-dist 6.
Пакет апдейтера — **`electron-updater`** (НЕ `@electron/updater` — такого нет, 404).

## Структура

```
src/main/index.ts       — main: окно, webview, хоткеи, IPC, autoUpdater, BFF, allowlist
src/main/{bff,scans,pageWindow,screenshot}.ts — прочие фичи main
src/main/config.ts      — SewConfig + merge/pick пользовательского config.json
src/main/plugins/       — loader.ts (читает features/*), store.ts (plugin-data на диске)
src/main/{downloads,credentials,sounds,inventory}/ — фичи main
src/shared/chrome-shim.ts    — шим `window.chrome` для гостя (CHROME_SHIM), единый
                               для всех плагинов: sendMessage/storage.session/cookies
src/preload/index.ts    — contextBridge: window.shell (~160 ключей: getConfig/getPlugins,
                          plugin-data, сканы, звуки, окно, netFetch, attachGuest, …)
src/renderer/index.html — вся разметка оболочки: тулбар, tabstrip, лента ссылок,
                          и ВСЕ оверлеи (settings/downloads/accounts/templates/print/
                          shot/help/password-prompt) — каждый `<div hidden>` + карточка
src/renderer/src/main.ts       — ТОЛЬКО сборка: DOM-ссылки, состояние config/plugins,
                                deps-объекты, wire*, и init() — ~400 строк
src/renderer/src/<name>.ts     — модули оболочки, каждый владеет своим DOM и состоянием.
                                Правило: модули НЕ импортируют друг друга, только через
                                deps-объект из main.ts (иначе циклический импорт).
                                Слои:
                                  низ:      util, status-ui, guest, tabs-core, tabs,
                                            tabs-file, findbar, updatebar, folder-prompt
                                  DOM-фичи: screenshot, print-bridge, toolbar, address-bar,
                                            tab-events, bridges, shortcuts(-core),
                                            nav-store, link-strip, tabs-overlay,
                                            inventory-panel, scans-panel, stock-report
                                  оверлеи:  settings-overlay, downloads-overlay,
                                            accounts-overlay, templates-overlay, help-overlay
                                  фабрики:  address-menu, print-dialog, print-preview,
                                            shot-preview, task-alert
src/renderer/src/*-core.ts     — ЧИСТАЯ логика без DOM (тестируется): tabs-core,
                                bridges-core, guest-core, inventory-core, scans-core,
                                shortcuts-core, folder-access-core, shot-preview,
                                print-dialog, address-menu + src/main/{sounds/store-core,
                                inventory/xlsx-core}
src/renderer/src/shell-api.d.ts — ambient-типы (НЕ модуль: без export!)
features/<name>/       — плагины: manifest.json {name,version,description,renderer:[…]} + JS,
                          инжектится в страницу гостя. Сейчас 8: identity, scans-block,
                          sew-auth, sew-helper, sew-inventory, sew-pattern, sku-copy,
                          tasks-notify (278 КБ JS+CSS в 20 файлах)
electron-builder.yml   — NSIS, publish github owner=Monutor repo=SEWBrowser
docs/                  — планы/спеки superpowers, в .gitignore (не коммитить)
```

## Команды

- `npm run dev:watch` — разработка. **Всегда он, не `dev`**: main/preload без watch
  остаются старыми → `No handler registered for ...`. Renderer через HMR свежий.
- `npm run typecheck` — оба tsconfig (node + web), `tsc --noEmit`.
- `npm run test` — `node --test "src/**/*.test.ts"`, 320 тестов в 19 файлах.
- `npm run build` — сборка в `out/`.
- `npm run package` — build + electron-builder → `release/`. **Только по явной просьбе.**
- Ручной рестарт нужен только после `npm install` или правок `electron.vite.config.ts`.
- Линтера и форматтера в проекте **нет** — не искать, не предлагать. CI нет.

### Тесты

- `node:test` + `node:assert/strict`, без vitest/jest, без сборки.
- Импорт в **тесте и внутри тестируемого модуля** — с явным `.ts`:
  `from './tabs-core.ts'` (иначе не работает type stripping, а
  `allowImportingTsExtensions` это требует). Остальные импорты рендерера идут
  **без** расширения (`'./tabs'`, `'./util'`) — их резолвит Vite.
- Один файл: `node --test src/renderer/src/tabs-core.test.ts`.
- Тесты только на чистой логике → выносить в `*-core.ts`, иначе не тестируется
  (DOM в node недоступен).
- `scripts/*.mjs` — ручные стенды для фич (звук, task-alert, tasks-notify), в npm
  не входят, запускаются вручную `node scripts/<файл>`.

## Конфиг и данные пользователя

`%APPDATA%/SEWBrowser/config.json` мержится поверх дефолтов из `src/main/config.ts`.
Allowlist по умолчанию: `*.mvideoeldorado.ru`, `kc.tech.mvideo.ru`, `*.mvideo.ru`,
`*.monutor.github.io` (Keycloak SSO — БЕЗ `kc.tech.mvideo.ru` редирект-логин
зацикливается).

- `%APPDATA%/SEWBrowser/plugin-data/<plugin>.json` — состояние плагинов (звуки
  tasks-notify, настройки панелей и т.п.).
- `%APPDATA%/SEWBrowser/sounds/` — `custom-rel.<ext>` (ЗНП), `custom-ho.<ext>`
  (выдача); legacy `custom.<ext>` читается как `rel`.
- `%APPDATA%/SEWBrowser/folder-passwords.json` — пароли папок, шифр
  `safeStorage.encryptString` (восстановить забытый НЕЛЬЗЯ).

## Ловушки (не наступать повторно)

### Гость: `loaded` ≠ «готов»

1. **`tab.loaded` — только «webview в DOM и src задан».** `executeJavaScript`
   легален лишь после `dom-ready`; иначе
   `The WebView must be attached to the DOM and the dom-ready event emitted…`.
   Предикат готовности — `isGuestReady(view)` (src/renderer/src/tab-events.ts:293,
   WeakSet, сбрасывается в `resetViewFlags` при разрыве гостя). Дёргая гостя при
   активации вкладки (тумблеры панелей, dialogs) — **обязательно** проверять его
   (образец: inventory-panel.ts, scans-panel.ts, accounts-overlay.ts).
2. **`tab.loaded === false` бывает по двум причинам**: вкладка ещё ни разу не
   открыта (ленивая загрузка) ИЛИ была выгружена по бюджету. Оба раза гостя за
   ней нет — код, обходящий `listTabs()`, обязан пропускать `!tab.loaded`
   (мосты, pushPluginStores, reload в настройках, рассылка сканов).
3. **`guestJS` при `!tab.loaded` возвращает `null`, а не бросает.** Любой новый
   вызов обязан трактовать `null` как «нет гостя», а не как «гость ответил
   пустотой».
4. Кэшированные per-guest значения (`printTargetView` в print-bridge, кэш
   `lastGuestErr`, флаги тумблеров панелей) **не переживают разрыв гостя** —
   сбрасывать в `hooks.onSuspended` (см. main.ts:352).

### `<webview>` и Electron

5. **`<webview>` ≠ webContents.** События ТОЛЬКО через `addEventListener` (метода
   `.on` нет). `getURL()` (не `getCurrentURL()`), событие `did-finish-load`,
   навигация кодом — `loadURL()`, стартовая — атрибут `src`. Событий `new-window`
   у тега нет, попапы заблокированы по умолчанию.
6. **У `<webview>` НЕТ preload** (только у BrowserWindow оболочки и pageWindow) →
   у гостя нет `ipcRenderer`. Событийный канал гость→оболочка возможен только
   через `chrome.runtime.sendMessage`-шим, который доопределяет bridge плагина.
7. **`will-navigate.preventDefault()` — документированный NO-OP.** Allowlist
   enforced через bounce-back: в `did-navigate` на запрещённый URL →
   `loadURL(lastAllowedUrl)`.
8. `webview` официально в архитектурном churn'е Electron — кандидат на миграцию
   в `WebContentsView`. Не переписывать на `<webview>`-специфичных API без нужды.
9. **`executeJavaScript` клонирует completion value**: результат обязан быть
   structured-cloneable. Голая `(function(){…})` БЕЗ `()` вернёт сам объект
   функции → `GUEST_VIEW_MANAGER_CALL: An object could not be cloned`. IIFE
   всегда заканчивать `})()`, безопаснее — возвращать JSON-строку.
10. **will-download слеп к `window.open(blob:/data:)`** — сгенерированные страницей
    файлы не вызывают will-download и молча режутся setWindowOpenHandler'ом. Такие
    вытягиваем через `guest.executeJavaScript(fetch → base64)` и пишем из main
    (`src/main/downloads/history.ts` + `downloadGuestUrl`).
11. **`session.clearStorageData()` НЕ чистит HTTP-кэш** — для кэша `clearCache()`
    (размер — `getCacheSize()`). Значения куки нельзя отдавать в renderer:
    `cookies:list` возвращает только метаданные.
12. **BFF mvideo отдаёт `ACAO: https://www.mvideo.ru`** → из страницы SEW запрос
    режется CORS, идти через мост `net:fetch` (main, куки общие через default
    session, URL строго по `BFF_URL_RE`) + polling `window.__sewHelperBffReq/Res`.
    Кэш картинок `mvideo:v2:*` — только в памяти геста (bridge.js), НЕ в
    plugin-data (иначе 8 МБ раздувают JSON на диске). Таймаут ожидания ответа у
    геста 30 с — поэтому опрос нельзя делать реже, чем эти 30 с.
13. `features/` в dev — `join(__dirname, '..', '..', 'features')`, в packaged —
    `resourcesPath/features`; всегда guard через `existsSync`.
14. Ошибка консоли `-3 (ERR_ABORTED, GUEST_VIEW_MANAGER_CALL)` на SSO-редиректе
    безвредна (прерванная загрузка).

### Инжект и опрос гостя (инфраструктура)

15. **Инжект плагинов — ОДИН `executeJavaScript` на вкладку** (`guest-core.ts`
    `buildInjectScript` + `guestJS(tab,'inject-all',…)`): снапшот store, флаг
    poll-host, Chrome-шим, код и `init` всех плагинов; ошибки возвращаются
    строкой `JSON.stringify(__errors)`. Шим вставляется ровно один раз; шим
    самозащищён (`if (!window.__shellChromeShim)`).
16. **`executeJavaScript` парсит батч целиком** — `SyntaxError` внутри гостевого
    `try/catch` не спасает, битый плагин уронит весь батч. Поэтому перед сборкой
    зовётся `checkPluginSyntax(code)` (`new Function`, тело не выполняется), плохие
    плагины отсекаются в `selectInjectable`.
17. **Мосты BFF/сканов/остатков делят один таймер** (`startPollBridge` +
    `pumpPollBridge`): один `guestJS(tab,'poll-take',…)` за тик на вкладку, ответы
    (`*-write`) — только при непустой очереди. Не возвращать по отдельному мосту
    на вкладку — это возвращает поток IPC. `tasks-notify` живёт отдельным
    мостом (5–15 с, только `primaryTab()`).
18. Гость выставляет `window.__shellPollHost = true`, чтобы Chromium не ужимал его
    таймеры. main снимает троттлинг только этому гостю
    (`guest:poll-host` → `setGuestPollHost`). Порядок в tab-events.ts важен:
    `setTabGuestId` (шлёт poll-host) ДОЛЖЕН идти раньше `attachGuest`, иначе attach
    применит троттлинг к ещё не объявленному хосту.

### Память и CPU

19. **Фоновые вкладки выгружаются по бюджету `maxLiveTabs`** (конфиг, дефолт 4;
    `<= 0` или отсутствие ключа — выгрузка выключена). `enforceTabBudget` после
    open/activate/close зовёт `tabsToSuspend` (LRU по `lastUsed`, активная и
    `isPrimary` неприкосновенны, split → ничего не выгружаем) и `unloadTab`:
    разрыв webview, обнуление истории гостя. Вернуться → `ensureTabLoaded` +
    полная перезагрузка страницы (состояние страницы теряется — это осознанно).
    Скелетон со спиннером `.tab-skeleton` в `styles.css` — заглушка активной
    не-loaded вкладки.
20. **Открытие с `activate: false` экономит отдельный процесс Chromium на вкладку**
    (главный расход памяти). `openTab` при `activate: false` НЕ вставляет webview.
21. Прочие источники фоновой нагрузки (осознанные, не трогать без замера):
    `startStatusPolling` (status-ui.ts, 2 с, всегда), `startLinkIntake`
    (tab-events.ts, 400 мс в простое / 100 мс после работы), плагины — `identity`
    5 с + MutationObserver, `sew-inventory` 2 с, `tasks-notify` `__tnTrim`
    сортирует до 2000 ключей дважды за тик.

### Хоткеи и оверлеи

22. **Хоткей регистрируется в ТРЁХ местах**, иначе работает наполовину:
    `guestShortcutName` (src/main/index.ts — для страницы гостя), `shortcutFromEvent`
    (src/renderer/src/shortcuts-core.ts — чистая функция, покрыта тестом) и union
    `ShortcutName` (src/renderer/src/shell-api.d.ts). Плюс `case` в `handleShortcut`
    (приватная функция в src/renderer/src/shortcuts.ts).
23. **Новый оверлей обязан закрываться по `Esc`** — это цепочка `case 'escape'` в
    `handleShortcut` (src/renderer/src/shortcuts.ts): добавить своё звено в начало.
24. Порядок в распознавателях важен: `Ctrl+1…9` перехватывает оболочку, поэтому
    в текстовом поле гостя цифры ломаются — это ожидаемо, а не баг.

### Сборка и dev-сервер

25. **electron-vite v5:** пустой `defineConfig({})` ничего не собирает — нужны
    явные секции `main: {}`, `preload: {}`, `renderer: {}`.
26. **Dev URL — переменная `ELECTRON_RENDERER_URL`, НЕ `VITE_DEV_SERVER_URL`**
    (такой нет — dev молча грузит stale-билд из `out/` без HMR и зря дёргает
    апдейтер). В `index.ts` это константа `devServerUrl`, она же гард апдейтера.
27. **Vite dev только на IPv4:** в `electron.vite.config.ts` у renderer задано
    `server: { host: '127.0.0.1', port: 5173 }`. `localhost` резолвится в `::1`,
    а IPv6-loopback на части машин отрезан (EACCES от VPN/файрвола) → белый экран
    + `ERR_CONNECTION_REFUSED`. В браузере открывать dev-страницу по
    `http://127.0.0.1:5173`.
28. **electron-updater:** в `electron-builder.yml` ключ `repo`, НЕ `repository`
    (иначе schema validation падает).
29. **Пробелы в имени NSIS-артефакта ломают autoUpdater:** дефолтное
    `SEWBrowser Setup X.Y.Z.exe` пишется в `latest.yml` через дефисы, а GitHub
    переименовывает файл через точки → 404. Явный
    `nsis.artifactName: "${productName}-Setup-${version}.${ext}"` — не убирать.

### TypeScript

30. `moduleResolution: "bundler"` (node10 удалён в TS7) +
    `allowImportingTsExtensions: true` — отсюда импорты с `.ts` и запрет на
    emit без tsconfig-обёртки.
31. `declare module '*.css'` живёт в `src/renderer/src/shell-api.d.ts`; файл
    ambient (скрипт, **без `export`**). Добавив `export` — сломаешь все
    глобальные объявления разом.

### Окружение

32. **AdGuard (и любой локальный фильтр) ломает запуск.** Он отдаёт
    `local.adguard.org` вместо любых заблокированных доменов, соединение упирается
    в таймаут → белый экран по 20+ с и `net::ERR_CONNECTION_TIMED_OUT` в консоли.
    Лечится исключением `node.exe`/`electron.exe` (и браузера) в AdGuard. Симптом
    выглядит как наш баг, но кода AdGuard в проекте нет — проверять сначала
    `ping`/выключенный фильтр.
33. Приложение держит `config.json` в памяти main — правка файла на диске при
    запущенном SEWBrowser будет затёрта. Закрывать приложение перед ручной правкой.

## Правила работы

- Отвечать пользователю по-русски. Не рефакторить соседний код без просьбы.
- Коммитить осмысленными кусками в `main` локально. Пушить (`git push`) ТОЛЬКО по
  явной просьбе. Исключение: если просят сделать релиз — пуш разрешён.
- Перед «готово» — `typecheck` + `test`, при правках сборки — `build`.
- Не коммитить посторонние untracked-файлы (например `design-mockup.html`,
  `OPTIMIZATION.md`) и `docs/`. Перед `git add -A` проверять `git status`.
- `git` ругается на `LF will be replaced by CRLF` — это норма на Windows, не
  чинить.

## Релизы (СТРОГО)

Когда пользователь просит «сделай релиз»:

### Схема версий

Текущая версия — `1.7.0`. Схема `X.Y.Z`: фичи поднимают minor (`1.6.0` →
`1.7.0`), починки — patch (`1.7.0` → `1.7.5`). Короткая форма (`1.8`) — только
для людей; в коде и в тегах всегда `X.Y.Z`. **Перед релизом уточнить у
пользователя, какой бамп нужен** (patch / minor) — не выводить из даты или вида
изменений.

### Шаги релиза

1. Уточнить бамп версии (patch / minor) и новую версию.
2. Прогнать `typecheck` + `test` + `package`, убедиться что `release/` собрался.
   Бамп версии — **после** этого, одной командой
   `npm version X.Y.Z --no-git-tag-version`: она синхронно правит и `package.json`,
   и оба вхождения версии в `package-lock.json` (ручная правка рассинхронизирует
   их, как уже было с 1.2.0 → 1.6.0).
3. Коммит бампа версии → тег `vX.Y.Z` → `git push origin main --tags`.
4. Собрать changelog по `git log <prev-tag>..HEAD` (учитывать merge-коммиты и
   feat/fix по сообщениям). `chore: release` и синхронизация версии в перечень
   «что сделано» для пользователя не идут.
5. `gh release create vX.Y.Z <файлы>` — **перечислить файлы явно**:
   `release/SEWBrowser-Setup-X.Y.Z.exe`, его же `.blockmap` и `release/latest.yml`.
   `latest.yml` **не заливается сам** (без `--publish always`), а без него
   авдейтер падает с `Cannot find latest.yml in the latest release artifacts`.
   Маску `release/*` **не использовать**: там лежат установщики прошлых версий
   и `builder-debug.yml` — они уедут в релиз как лишние ассеты. Длинные заметки
   удобно передавать через `--notes-file <tmp>.md`.
6. **ОБЯЗАТЕЛЬНО** в описании релиза — раздел «Что сделано» со списком изменений.
   Релиз без changelog ЗАПРЕЩЁН.
7. Проверить результат: `gh release view vX.Y.Z --json url,assets` — все ассеты
   на месте, `isDraft: false`.
8. Кратко доложить: версия, что внутри, ссылка на Release.

Отдельно: старый установщик в `release/` может быть свежей версии недели назад —
прежде чем предлагать его поставить, проверить дату сборки (`Get-Item`) и
предупредить пользователя, что текущие правки в него не входят.