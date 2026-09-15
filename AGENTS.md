# SEWBrowser — AI Context

> Этот файл — общий промпт для любого ИИ-агента, работающего с проектом.
> Прочитай его целиком перед началом работы.

## Что это за проект

**SEWBrowser** — выделенная десктопная браузерная оболочка под ОДНО стороннее веб-приложение:
`https://sew.mvideoeldorado.ru/v2/` (внутренняя система SEW, SPA).
Открывает только его страницу + позволяет инжектить собственные фичи (как расширения браузера):
UI-оверлеи, перехват данных страницы, хоткеи/уведомления.

- Только Windows (установщик NSIS через electron-builder).
- Язык общения с пользователем: **русский**.
- Репозиторий: `https://github.com/Monutor/SEWBrowser.git` (ветка `main`).

## Стек

Electron 44 + TypeScript + electron-vite 5 (Vite 7) + electron-updater 6.
Пакет апдейтера называется **`electron-updater`** (НЕ `@electron/updater` — такого пакета нет, 404).

## Структура

```
src/main/            — main-процесс: окно, конфиг, загрузчик плагинов, хоткеи, autoUpdater
src/main/config.ts   — SewConfig: startUrl, debug, allowlistEnabled, allowlist[], plugins{}
src/main/plugins/loader.ts — читает features/<name>/manifest.json + renderer-код
src/preload/index.ts — contextBridge: window.shell { getConfig, getPlugins, windowMin/Max/Close }
src/renderer/        — хром оболочки: titlebar, toolbar (назад/вперёд/обновить, адресная строка), <webview>
features/<name>/    — плагины: manifest.json { name, renderer?, hotkeys? } + JS инжектится в страницу
electron-builder.yml — NSIS-сборка, publish provider=github owner=Monutor repo=SEWBrowser
scripts/gen-icon.js  — генерация resources/icon.png без зависимостей
```

## Команды

- `npm run dev:watch` — разработка (пересборка main/preload + рестарт при изменениях; renderer — Vite HMR без рестарта)
- `npm run dev` — то же, но БЕЗ watch (main/preload требуют ручного рестарта)
- `npm run typecheck` — оба tsconfig (node + web)
- `npm run build` — сборка в `out/`
- `npm run package` — build + electron-builder → `release/` (NSIS)
- Ручной рестарт нужен только после `npm install` или правок `electron.vite.config.ts`.

## Конфиг пользователя

`%APPDATA%/SEWBrowser/config.json` мержится поверх дефолтов из `src/main/config.ts`.
Allowlist по умолчанию: `*.mvideoeldorado.ru` + `kc.tech.mvideo.ru` (Keycloak SSO — БЕЗ него редирект-логин зацикливается).

## Ловушки (не наступать повторно)

1. **`<webview>` ≠ webContents.** События ТОЛЬКО через `addEventListener` (метода `.on` нет).
   `getURL()` (не `getCurrentURL()`), событие `did-finish-load` (не `did-finish`),
   навигация кодом — `loadURL()`, стартовая — через атрибут `src`.
   `will-navigate.preventDefault()` — документированный NO-OP; allowlist enforced через bounce-back
   (в `did-navigate` на запрещённый URL → `loadURL(lastAllowedUrl)`).
   События `new-window` у тега нет, попапы заблокированы по умолчанию.
2. **electron-vite v5:** пустой `defineConfig({})` ничего не собирает — нужны явные секции
   `main: {}, preload: {}, renderer: {}` (entry auto-detect работает).
3. **Electron 44:** `new Notification({ title, body })` — один объект опций, не `(title, options)`.
4. **TypeScript 7:** `moduleResolution` — `"bundler"`, не `"node"` (node10 удалён);
   для CSS-импортов нужен `declare module '*.css'`.
5. **loader.ts:** dev-путь к features — `join(__dirname, '..', '..', 'features')`
   (`out/main` → корень проекта), packaged — `resourcesPath/features`; всегда guard через `existsSync`.
6. Ошибка консоли `-3 (ERR_ABORTED, GUEST_VIEW_MANAGER_CALL)` при SSO-редиректе — безвредна (прерванная загрузка).
7. `webview` официально в архитектурном churn'е у Electron — кандидат на миграцию: `WebContentsView`.
8. **electron-builder publish.github:** ключ — `repo`, НЕ `repository` (иначе schema validation падает).
9. **gen-icon.js:** PNG-сигнатура строго `89 50 4E 47 0D 0A 1A 0A` — с битой libvips
   (icon-tool) падает с `VipsForeignLoad: buffer is not in a known format`, браузеры такое прощают.
   Ошибка `7z reported error but extracted files` при сборке NSIS — некритична, если файлы извлеклись.
10. **electron-vite dev URL:** переменная — `ELECTRON_RENDERER_URL`, НЕ `VITE_DEV_SERVER_URL`
    (такой нет — dev молча грузит stale-билд из `out/` без HMR и зря дёргает апдейтер).
    В `index.ts` — константа `devServerUrl`, используется и для loadURL, и для гарда апдейтера.
11. **HTTP-кэш ≠ clearStorageData:** `session.clearStorageData()` кэш НЕ чистит —
    для него отдельный `session.clearCache()` (а размер — `getCacheSize()`).
    Значения куки нельзя отдавать в renderer (`cookies:list` возвращает метаданные без `value`).
12. **Vite dev только на IPv4:** в `electron.vite.config.ts` у renderer задан
    `server: { host: '127.0.0.1', port: 5173 }` — дефолтный `localhost` резолвится
    в `::1`, а IPv6-loopback на части машин отрезан (EACCES от VPN/файрвола) →
    белый экран + `ERR_CONNECTION_REFUSED` в dev.
13. **Stale main в dev:** plain `npm run dev` main-процесс НЕ пересобирает —
    renderer через HMR свежий, а main старый → `No handler registered for ...`.
    Всегда `npm run dev:watch`; при такой ошибке — убить процессы и рестарт.
14. **will-download слеп к `window.open(blob:/data:)`:** сгенерированные страницей
    файлы через window.open НЕ вызывают will-download и молча режутся
    setWindowOpenHandler'ом — для `blob:`/`data:` контент вытягиваем через
    `guest.executeJavaScript(fetch → base64)` и пишем файл вручную из main
    (`src/main/downloads/history.ts` + `downloadGuestUrl` в `index.ts`).
15. **Пробелы в имени NSIS-артефакта ломают autoUpdater:** дефолтное имя
    `SEWBrowser Setup X.Y.Z.exe` в `latest.yml` пишется через дефисы, а GitHub
    при заливке переименовывает файл через точки → апдейтер получает 404.
    В `electron-builder.yml` задан явный
    `nsis.artifactName: "${productName}-Setup-${version}.${ext}"` — не убирать.
16. **Гостевой fetch под CORS, main — нет:** BFF mvideo отдаёт
    `ACAO: https://www.mvideo.ru`, из страницы SEW запрос режется CORS —
    такие вызовы идут через мост `net:fetch` (main, `net.fetch`, куки общие
    через default session; URL строго по `BFF_URL_RE`) + polling
    `window.__sewHelperBffReq/Res` в `main.ts`. GitHub raw отдаёт `ACAO: *` —
    его можно тянуть прямо из геста. Кэш картинок `mvideo:v2:*` — только
    в памяти геста (bridge.js), НЕ в plugin-data (иначе 8 МБ раздувают JSON
    на диске и снапшот целиком). Chrome-шим геста НЕ даёт `sendMessage` /
    `storage.session` / `cookies` — для слияния background+content в один
    контекст их доопределяет bridge плагина, не общий шим.
17. **executeJavaScript клонирует completion value:** результат скрипта обязан
    быть structured-cloneable. Голая `(function(){...})` БЕЗ вызывающих `()`
    возвращает сам объект функции → `GUEST_VIEW_MANAGER_CALL: An object could
    not be cloned` на КАЖДОМ тике. IIFE всегда заканчивать `})()`; для
    диагностики достаточно вернуть константу-строку (`'"[]"'`).

18. **`latest.yml` НЕ заливается в GitHub сам.** `npm run package` складывает
    `release/latest.yml` локально, но НЕ прикрепляет его к релизу (без
    `--publish always` заливки нет). Без `latest.yml` в артефактах апдейтер
    падает с `Cannot find latest.yml in the latest release artifacts` (404) →
    «проверка недоступна». После создания GitHub Release ОБЯЗАТЕЛЬНО прикрепить
    `release/latest.yml` к тегу: либо `npm run package -- --publish always`,
    либо вручную (`gh release upload vX.Y.Z release/latest.yml`).

## Правила работы

- Отвечать пользователю на русском. Не рефакторить соседний код без просьбы.
- Коммитить осмысленными кусками в `main` локально. Пушить (`git push`)
  ТОЛЬКО по явной просьбе пользователя («запуш», «сделай релиз» и т.п.).
  Исключение — шаги релиза ниже: раз пользователь попросил релиз, пуш разрешён.
- Перед «готово» — `typecheck`, при правках сборки — `build`.
- Демо-плагины (`overlay-demo`, `data-demo`, `hotkey-demo`) — заглушки; заменять настоящими по ТЗ пользователя.

## Релизы (СТРОГО)

Когда пользователь просит «сделай релиз»:

### Схема версий

- **Бета:** `0.1`, `0.2`, `0.3` … → в `package.json` полный semver: `0.1.0`, `0.2.0` …
- **Полный релиз:** `1.0`, `1.1`, `1.2` … → в `package.json`: `1.0.0`, `1.1.0` …
- Короткая форма (`0.2`) — только для людей; в коде/тегах всегда `X.Y.Z`.
- Бета инкрементирует minor нуля (`0.1.0` → `0.2.0`); стабильный — по semver-смыслу.
- Тип релиза (бета/полный) определяет пользователь; если не сказал — СПРОСИТЬ.

### Шаги релиза

1. Уточнить тип (бета/полный), если не указан.
2. Выставить версию в `package.json`, прогнать `typecheck` + `package`, убедиться что `release/` собрался.
3. Коммит бампа версии → тег `vX.Y.Z` → `git push origin main --tags`.
4. Собрать changelog: все значимые изменения со времён предыдущего тега (`git log <prev-tag>..HEAD`).
5. Создать GitHub Release: `gh release create vX.Y.Z release/* --title "<0.2 Beta | 1.0>" --notes "<changelog>"`.
6. **ОБЯЗАТЕЛЬНО:** в описании релиза — раздел «Что сделано» со списком изменений. Релиз без changelog ЗАПРЕЩЁН.
7. Кратко доложить пользователю: версия, что внутри, ссылка на Release.
