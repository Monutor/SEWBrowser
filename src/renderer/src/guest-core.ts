// Сборка батч-скрипта инжекта плагинов в гостевую страницу.
//
// Раньше на каждую загрузку вкладки оболочка делала ~26 последовательных
// executeJavaScript: снапшот данных, poll-host, и на каждый плагин — шим,
// код, отдельное чтение ошибки. Здесь всё склеивается в ОДИН IIFE: данные
// плагинов, флаг опросного хоста, шим (один раз), код всех плагинов, init и
// сброс имени. Ошибки плагинов собираются в объект и возвращаются одной
// JSON-строкой — executeJavaScript клонирует результат, строка безопасна.
//
// Модуль чистый: никаких DOM/webview, всё тестируется в node:test.

/** Минимальный срез PluginInfo, нужный для сборки скрипта */
export interface InjectablePlugin {
  name: string
  code: string
  styles: string
  init: string
}

export interface InjectScriptOptions {
  /** Снапшот данных плагинов — кладётся в window.__shellPluginStores ДО кода */
  stores: Record<string, Record<string, unknown>>
  /** Только первая вкладка забирает очередь заданий (tasks-notify) */
  pollHost: boolean
  /** Исходник window.chrome-шима (chrome-shim.ts), самозащищён от повтора */
  shim: string
  /** Уже отфильтрованные плагины (см. selectInjectable) */
  plugins: InjectablePlugin[]
}

/** Имя плагина -> текст ошибки гостя */
export type InjectErrors = Record<string, string>

function json(value: unknown): string {
  // JSON.stringify может вернуть undefined для undefined/функций — подстрахуемся
  const out = JSON.stringify(value)
  return typeof out === 'string' ? out : 'null'
}

/** Обёртка гостевого try/catch: пишет ошибку и в отчёт, и в консоль гостя */
function guard(name: string, body: string): string {
  return (
    `try {\n${body}\n} catch (e) {\n` +
    `var __msg = String((e && e.stack) || e);\n` +
    `window.__shellPluginError[${json(name)}] = __msg;\n` +
    `__errors[${json(name)}] = __msg;\n` +
    `console.error('[shell-plugin:' + ${json(name)} + ']', e);\n` +
    `}`
  )
}

/**
 * Скрипт инжекта для одной вкладки. Возвращает JSON-строку с ошибками
 * плагинов (см. parseInjectResult). ОБЯЗАТЕЛЬНО заканчивается `})()`:
 * голая `(function(){...})` без вызова возвращает сам объект функции, а он
 * неклонируем — «GUEST_VIEW_MANAGER_CALL: An object could not be cloned».
 */
export function buildInjectScript(opts: InjectScriptOptions): string {
  const head =
    `(function(){\n` +
    `var __errors = {};\n` +
    // Данные плагинов — до кода, чтобы первые чтения в плагинах видели данные.
    `try {\nwindow.__shellPluginStores = ${json(opts.stores)};\n} catch (e) { __errors['__stores'] = String((e && e.stack) || e); }\n` +
    // Хост опроса: только первая вкладка забирает очередь заданий
    // (tasks-notify), иначе при N вкладках придёт N одинаковых уведомлений.
    // Ставим ДО кода плагинов — tasks-notify читает флаг на старте.
    `try {\nwindow.__shellPollHost = ${opts.pollHost ? 'true' : 'false'};\n} catch (e) { __errors['__pollHost'] = String((e && e.stack) || e); }\n` +
    opts.shim +
    '\n' +
    `try {\n` +
    `window.__shellPlugins = window.__shellPlugins || {};\n` +
    `window.__shellPluginError = window.__shellPluginError || {};\n` +
    `} catch (e) { __errors['__globals'] = String((e && e.stack) || e); }\n`

  const parts: string[] = []
  for (const plugin of opts.plugins) {
    const key = json(plugin.name)
    const code = typeof plugin.code === 'string' ? plugin.code : ''
    const init = typeof plugin.init === 'string' ? plugin.init : ''
    // Имя текущего плагина: шим берёт его для выбора стора. Сбрасывается в
    // null в самом конце скрипта, чтобы отложенные вызовы не писали в чужое
    // хранилище.
    parts.push(`window.__shellPluginName = ${key};\n`)
    if (code) {
      parts.push(
        `if (!window.__shellPlugins[${key}]) {\n` +
          `window.__shellPlugins[${key}] = 1;\n` +
          // Код выполняется в IIFE с собственным `chrome`, привязанным к стору
          // этого плагина: отложенные вызовы (наблюдатели, обработчики) видят
          // свои данные, а не 'default' (имя в __shellPluginName уже сброшено).
          `(() => {\nconst chrome = window.__shellChromeFor(${key});\n` +
          guard(
            plugin.name,
            `${code}\n`,
          ) +
          `\n})();\n` +
          `}\n`,
      )
    }
    if (init) {
      parts.push(guard(`${plugin.name}:init`, `${init}\n`))
    }
  }

  const tail = `window.__shellPluginName = null;\n` + `return JSON.stringify(__errors);\n` + `})()`

  return head + parts.join('') + tail
}

/** Разбор ответа гостя: строка -> {плагин: ошибка}. Всё мусорное -> пусто. */
export function parseInjectResult(raw: unknown): InjectErrors {
  if (typeof raw !== 'string') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: InjectErrors = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

/**
 * Синтаксическая проверка кода плагина. Нужна, потому что в батче один битый
 * плагин уронил бы весь скрипт: executeJavaScript парсит его целиком, и
 * try/catch внутри не спасает от SyntaxError. Раньше каждый плагин шёл
 * отдельным вызовом, поэтому падал только он.
 * Тело функции парсится тем же движком и в тех же условиях (без strict, без
 * модуля), что и IIFE гостя, — оценка совпадает с реальным инжектом.
 */
export function checkPluginSyntax(code: string): string | null {
  if (typeof code !== 'string' || !code) return null
  try {
    // eslint-disable-next-line no-new-func -- только парсинг, тело не выполняется
    new Function(code)
    return null
  } catch (err) {
    return String((err as Error)?.message ?? err)
  }
}

export interface PluginSyntaxProblem {
  name: string
  error: string
}

/**
 * Отбор плагинов для батча: без кода и без init плагину в батче нечего
 * делать; с битым синтаксисом — выпадает с отчётом, остальные грузятся.
 */
export function selectInjectable(plugins: InjectablePlugin[]): {
  ok: InjectablePlugin[]
  problems: PluginSyntaxProblem[]
} {
  const ok: InjectablePlugin[] = []
  const problems: PluginSyntaxProblem[] = []
  for (const plugin of plugins) {
    const code = typeof plugin.code === 'string' ? plugin.code : ''
    const init = typeof plugin.init === 'string' ? plugin.init : ''
    if (!code && !init) continue
    const err = checkPluginSyntax(code) ?? checkPluginSyntax(init)
    if (err) {
      problems.push({ name: plugin.name, error: err })
      continue
    }
    ok.push(plugin)
  }
  return { ok, problems }
}