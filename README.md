# SEWBrowser

Специализированная оболочка браузера под одно веб-приложение: `https://sew.mvideoeldorado.ru/v2/`.

Окно без хрома ОС-браузера (свой title bar + адресная строка), плагины для внедрения своих фич.

## Стек

Electron + TypeScript, Windows-only, сборка NSIS через electron-builder. Обновления — GitHub Releases + electron-updater.

## Запуск в dev

```bash
npm install
npm run dev            # окно с HMR shell-UI
npm run dev -- --debug # debug-режим (DevTools webview по Ctrl+Shift+I)
```

## Сборка и упаковка

```bash
npm run typecheck      # проверка типов
npm run build          # сборка в out/
npm run package        # NSIS-инсталлятор в release/
```

## Конфиг

`%APPDATA%/SEWBrowser/config.json` (создаётся при первом запуске, значения по умолчанию):

| Поле | Описание |
| --- | --- |
| `startUrl` | Стартовый URL |
| `debug` | Debug-режим (DevTools webview) |
| `allowlistEnabled` | Вкл/выкл проверку доменов |
| `allowlist` | Список доменов, например `["*.mvideoeldorado.ru"]` |
| `plugins` | Включение/выключение плагинов по имени |

## Плагины

Каждый плагин — папка в `features/<name>/`:

- `manifest.json` — имя, описание, опционально:
  - `renderer` — путь к JS, исполняемому в контексте страницы (включая оверлеи и перехват данных);
  - `hotkeys` — шорткаты main-процесса (`"Ctrl+Shift+S": { "action": "notify", ... }`).

Встроенные демо:

| Плагин | Тип | Что делает |
| --- | --- | --- |
| `overlay-demo` | renderer | Плавающая панель в углу страницы (shadow DOM) |
| `data-demo` | renderer | Перехват fetch-запросов, счётчик в статус-баре |
| `hotkey-demo` | main | Ctrl+Shift+S → toast-уведомление |

## Обновления

NSIS публикуется как GitHub Release; приложение само проверяет обновления (`@electron/updater`). Заполните блок `publish` в `electron-builder.yml` после создания репозитория.
