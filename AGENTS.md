# SEWBrowser — AI Context

> Общий промпт для любого ИИ-агента, работающего с проектом. Прочитать целиком
> перед началом работы. README в репозитории **нет** — этот файл главный источник.

## Что это за проект

Выделенная десктопная браузерная оболочка под ОДНО стороннее веб-приложение:
`https://sew.mvideoeldorado.ru/v2/` (внутренняя система SEW, SPA).
Открывает только его страницу + инжектит собственные фичи (как расширения
браузера): оверлеи, перехват данных страницы, хоткеи, уведомления.

- Только Windows, установщик NSIS (electron-builder).
- Общение с пользователем и в коде UI — **русский**.
- Репозиторий: `https://github.com/Monutor/SEWBrowser.git`, ветка `main`.

## Стек

Electron 44.4 + TypeScript 7 + electron-vite 5 (Vite 7) + electron-builder 26 +
electron-updater 6 + pdfjs-dist 6.
Пакет апдейтера — **`electron-updater`** (НЕ `@electron/updater` — такого нет, 404).

## Структура

```
src/main/index.ts       — main: окно, webview, хоткеи, IPC, autoUpdater, BFF-мост, allowlist
src/main/config.ts      — SewConfig: startUrl, debug, allowlist, downloadsDir, звуки
src/main/plugins/       — loader.ts (читает features/*), store.ts (plugin-data на диске)
src/main/{scans,screenshot,downloads,credentials,sounds}/ — фичи main-процесса
src/preload/index.ts    — contextBridge: window.shell (getConfig/getPlugins/getAllPlugins,
                          pickDownloadsDir, сканы, звук, окно, …)
src/renderer/index.html — вся разметка оболочки: тулбар, tabstrip, лента ссылок,
                          и ВСЕ оверлеи (settings/downloads/accounts/templates/print/
                          shot/help/password-prompt) — каждый `<div hidden>` + карточка
src/renderer/src/main.ts       — ТОЛЬКО сборка: DOM-ссылки, состояние config/plugins,
                              обёртки (isAllowed/tasksUrl/prompt*), wireAddressMenu,
                              wireOverlayDismiss, applyAppVersion и init() (~380 строк)
src/renderer/src/<name>.ts     — модули оболочки, каждый владеет своим DOM и состоянием.
                              Правило: модули НЕ импортируют друг друга, только через
                              deps-объект, переданный из main.ts (иначе циклический импорт).
                              Слои:
                                низ:      util, status-ui, guest, tabs-core, tabs,
                                          tabs-file, findbar, updatebar, folder-prompt
                                DOM-фичи: screenshot, print-bridge, toolbar, address-bar,
                                          tab-events, bridges, shortcuts(-core),
                                          nav-store, link-strip, tabs-overlay
                                оверлеи:  settings-overlay, downloads-overlay,
                                          accounts-overlay, templates-overlay, help-overlay
                                фабрики:  address-menu, print-dialog, print-preview,
                                          shot-preview, task-alert
src/renderer/src/shell-api.d.ts — ambient-типы (НЕ модуль: без export!)
features/<name>/       — плагины: manifest.json {name,version,description,renderer:[…]} + JS,
                          инжектится в страницу гостя (identity, scans-block, sew-helper,
                          sew-pattern, tasks-notify)
electron-builder.yml   — NSIS, publish github owner=Monutor repo=SEWBrowser
docs/                  — планы/спеки superpowers, в .gitignore (не коммитить)
```

## Команды

- `npm run dev:watch` — разработка. **Всегда он, не `dev`**: main/preload без watch
  остаются старыми → `No handler registered for ...`. Renderer через HMR свежий.
- `npm run typecheck` — оба tsconfig (node + web).
- `npm run test` — `node --test "src/**/*.test.ts"`, 186 тестов.
- `npm run build` — сборка в `out/`.
- `npm run package` — build + electron-builder → `release/`. **Только по явной просьбе.**
- Ручной рестарт нужен только после `npm install` или правок `electron.vite.config.ts`.
- Линтера и форматтера в проекте **нет** — не искать, не предлагать.
- CI нет.

### Тесты

- `node:test` + `node:assert/strict`, без vitest/jest, без сборки.
- Импорт в **тесте и внутри тестируемого модуля** — с явным `.ts`:
  `from './tabs-core.ts'` (иначе не работает type stripping, а
  `allowImportingTsExtensions` это требует). Остальные импорты рендерера идут
  **без** расширения (`'./tabs'`, `'./util'`) — их резолвит Vite.
- Один файл: `node --test src/renderer/src/tabs-core.test.ts`.
- Тесты только на чистой логике → выносить в `*-core.ts` / отдельный модуль, иначе
  не тестируется (DOM в node недоступен).
- `scripts/*.mjs` — ручные стенды для фич (звук, task-alert, tasks-notify), в npm
  не входят, запускаются вручную `node scripts/<файл>`.

## Конфиг пользователя

`%APPDATA%/SEWBrowser/config.json` мержится поверх дефолтов из `src/main/config.ts`.
Allowlist по умолчанию: `*.mvideoeldorado.ru` + `kc.tech.mvideo.ru` (Keycloak SSO —
БЕЗ него редирект-логин зацикливается).

## Ловушки (не наступать повторно)

### Хоткеи и оверлеи
1. **Хоткей регистрируется в ТРЁХ местах**, иначе работает наполовину:
   `guestShortcutName` (src/main/index.ts — для страницы гостя), `shortcutFromEvent`
   (src/renderer/src/shortcuts-core.ts — чистая функция, покрыта тестом) и union
   `ShortcutName` (src/renderer/src/shell-api.d.ts). Плюс `case` в `handleShortcut`
   (приватная функция в src/renderer/src/shortcuts.ts).
2. **Новый оверлей обязан закрываться по `Esc`** — это цепочка `case 'escape'` в
   `handleShortcut` (src/renderer/src/shortcuts.ts): добавить своё звено в начало.
   Иначе оверлей не закроется.
3. Порядок в распознавателях важен: `Ctrl+1…9` перехватывает оболочку, поэтому
   в текстовом поле гостя цифры ломаются — это ожидаемо, а не баг.

### `<webview>` и гость
4. **`<webview>` ≠ webContents.** События ТОЛЬКО через `addEventListener` (метода
   `.on` нет). `getURL()` (не `getCurrentURL()`), событие `did-finish-load`,
   навигация кодом — `loadURL()`, стартовая — атрибут `src`. Событий `new-window`
   у тега нет, попапы заблокированы по умолчанию.
5. **`will-navigate.preventDefault()` — документированный NO-OP.** Allowlist
   enforced через bounce-back: в `did-navigate` на запрещённый URL →
   `loadURL(lastAllowedUrl)`.
6. `webview` официально в архитектурном churn'е Electron — кандидат на миграцию
   в `WebContentsView`. Не переписывать на `<webview>`-специфичных API без нужды.
7. **`executeJavaScript` клонирует completion value**: результат обязан быть
   structured-cloneable. Голая `(function(){…})` БЕЗ `()` вернёт сам объект
   функции → `GUEST_VIEW_MANAGER_CALL: An object could not be cloned`. IIFE
   всегда заканчивать `})()`.
8. **will-download слеп к `window.open(blob:/data:)`** — сгенерированные страницей
   файлы не вызывают will-download и молча режутся setWindowOpenHandler'ом. Такие
   вытягиваем через `guest.executeJavaScript(fetch → base64)` и пишем из main
   (`src/main/downloads/history.ts` + `downloadGuestUrl`).
9. **`session.clearStorageData()` НЕ чистит HTTP-кэш** — для кэша `clearCache()`
   (размер — `getCacheSize()`). Значения куки нельзя отдавать в renderer:
   `cookies:list` возвращает только метаданные.
10. **BFF mvideo отдаёт `ACAO: https://www.mvideo.ru`** → из страницы SEW запрос
    режется CORS, идти через мост `net:fetch` (main, куки общие через default
    session, URL строго по `BFF_URL_RE`) + polling `window.__sewHelperBffReq/Res`.
    Кэш картинок `mvideo:v2:*` — только в памяти геста (bridge.js), НЕ в
    plugin-data (иначе 8 МБ раздувают JSON на диске). Chrome-шим геста НЕ даёт
    `sendMessage` / `storage.session` / `cookies` — их доопределяет bridge плагина.
11. `features/` в dev — `join(__dirname, '..', '..', 'features')`, в packaged —
    `resourcesPath/features`; всегда guard через `existsSync`.
12. Ошибка консоли `-3 (ERR_ABORTED, GUEST_VIEW_MANAGER_CALL)` на SSO-редиректе
    безвредна (прерванная загрузка).

### Сборка и dev-сервер
13. **electron-vite v5:** пустой `defineConfig({})` ничего не собирает — нужны
    явные секции `main: {}`, `preload: {}`, `renderer: {}`.
14. **Dev URL — переменная `ELECTRON_RENDERER_URL`, НЕ `VITE_DEV_SERVER_URL`**
    (такой нет — dev молча грузит stale-билд из `out/` без HMR и зря дёргает
    апдейтер). В `index.ts` это константа `devServerUrl`, она же гард апдейтера.
15. **Vite dev только на IPv4:** в `electron.vite.config.ts` у renderer задано
    `server: { host: '127.0.0.1', port: 5173 }`. `localhost` резолвится в `::1`,
    а IPv6-loopback на части машин отрезан (EACCES от VPN/файрвола) → белый экран
    + `ERR_CONNECTION_REFUSED`. В браузере открывать dev-страницу по
    `http://127.0.0.1:5173`.
16. **electron-updater:** в `electron-builder.yml` ключ `repo`, НЕ `repository`
    (иначе schema validation падает).
17. **Пробелы в имени NSIS-артефакта ломают autoUpdater:** дефолтное
    `SEWBrowser Setup X.Y.Z.exe` пишется в `latest.yml` через дефисы, а GitHub
    переименовывает файл через точки → 404. Явный
    `nsis.artifactName: "${productName}-Setup-${version}.${ext}"` — не убирать.
18. **`latest.yml` НЕ заливается сам.** `npm run package` кладёт его локально, но
    без `--publish always` заливки нет. Без `latest.yml` в артефактах апдейтер
    падает с `Cannot find latest.yml in the latest release artifacts`.

### TypeScript
19. `moduleResolution: "bundler"` (node10 удалён в TS7) +
    `allowImportingTsExtensions: true` — отсюда импорты с `.ts` и запрет на
    emit без tsconfig-обёртки.
20. `declare module '*.css'` живёт в `src/renderer/src/shell-api.d.ts`; файл
    ambient (скрипт, **без `export`**). Добавив `export` — сломаешь все
    глобальные объявления разом.

### Окружение
21. **AdGuard (и любой локальный фильтр) ломает запуск.** Он отдаёт
    `local.adguard.org` вместо любых заблокированных доменов, соединение упирается
    в таймаут → белый экран по 20+ с и `net::ERR_CONNECTION_TIMED_OUT` в консоли.
    Лечится исключением `node.exe`/`electron.exe` (и браузера) в AdGuard. Симптом
    выглядит как наш баг, но кода AdGuard в проекте нет — проверять сначала
    `ping`/выключенный фильтр.

### Память и CPU
22. **Фоновые вкладки грузятся лениво.** `openTab(..., { activate: false })` НЕ
    вставляет `<webview>` в DOM и не ставит `src` — гостя за вкладкой нет вообще
    (иначе каждая вкладка — отдельный процесс Chromium с полным SPA SEW; это и
    есть главный расход памяти). Догрузка — `ensureTabLoaded` (src/renderer/src/tabs.ts),
    зовётся из `activateTab`, смены опросного хоста (`closeTab`/`moveTab`) и
    `splitView`. **Любой новый код, который дёргает `tab.view` по всем вкладкам
    (мосты, pushPluginStores, reload в настройках, рассылка сканов), обязан
    пропускать `!tab.loaded`** — иначе executeJavaScript по несуществующему гостю.
23. **Троттлинг фоновых гостей включён, кроме опросного хоста.** main снимает
    троттлинг только тому гостю, чей id прислал renderer через
    `guest:poll-host` (`setGuestPollHost`, вызывается из `setTabGuestId` и при
    смене `isPrimary`). Это первая вкладка: на ней висит tasks-notify, и Chromium
    ужимает setInterval в скрытой вкладке — уведомления молчно пропадают. Порядок
    в tab-events.ts важен: `setTabGuestId` (шлёт poll-host) ДОЛЖЕН идти раньше
    `attachGuest`, иначе attach применит троттлинг к ещё не объявленному хосту.

## Правила работы

- Отвечать пользователю по-русски. Не рефакторить соседний код без просьбы.
- Коммитить осмысленными кусками в `main` локально. Пушить (`git push`) ТОЛЬКО по
  явной просьбе. Исключение: если просят сделать релиз — пуш разрешён.
- Перед «готово» — `typecheck` + `test`, при правках сборки — `build`.
- Не коммитить посторонние untracked-файлы (например `design-mockup.html`) и
  `docs/` (в .gitignore). Перед `git add -A` проверять `git status`.
- `git` ругается на `LF will be replaced by CRLF` — это норма на Windows, не
  чинить.

## Релизы (СТРОГО)

Когда пользователь просит «сделай релиз»:

### Схема версий

Текущая версия — `0.12.5`. Релизы идут как `0.X.Y`: фичи поднимают minor
(`0.11.0` → `0.12.0`), починки — patch (`0.12.0` → `0.12.5`). Короткая форма
(`0.13`) — только для людей; в коде и в тегах всегда `X.Y.Z`.
**Перед релизом уточнить у пользователя, какой бамп нужен** (patch / minor) —
не выводить из даты или вида изменений.

### Шаги релиза

1. Уточнить бамп версии (patch / minor) и новую версию.
2. Проставить версию в `package.json`, прогнать `typecheck` + `test` + `package`,
   убедиться что `release/` собрался.
3. Коммит бампа версии → тег `vX.Y.Z` → `git push origin main --tags`.
4. Собрать changelog по `git log <prev-tag>..HEAD` (учитывать merge-коммиты и
   feat/fix по сообщениям).
5. Создать релиз: `gh release create vX.Y.Z release/* --title "<версия>" --notes "<changelog>"`.
6. **ОБЯЗАТЕЛЬНО** в описании релиза — раздел «Что сделано» со списком изменений.
   Релиз без changelog ЗАПРЕЩЁН.
7. Кратко доложить: версия, что внутри, ссылка на Release.

Отдельно: старый установщик в `release/` может быть свежей версии недели назад —
прежде чем предлагать его поставить, проверить дату сборки (`Get-Item`) и
предупредить пользователя, что текущие правки в него не входят.
