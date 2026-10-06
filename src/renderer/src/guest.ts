// Скрипты, инжектимые в страницу гостя, и обёртка executeJavaScript.
// Ссылки на DOM берутся лениво (внутри функций), а не на верхнем уровне.

import { listTabs, type ShellTab } from './tabs'
import {
  buildInjectScript,
  parseInjectResult,
  selectInjectable,
  type InjectablePlugin,
} from './guest-core.ts'



/**
 * Минимальный window.chrome для перенесённых content-скриптов Chrome-расширений.
 * storage.local — из снапшота window.__shellPluginStores, который оболочка пушит
 * в страницу при инжекте и обновляет при изменениях: у <webview> НЕТ preload,
 * поэтому window.shell в гостевой странице отсутствует и IPC оттуда недоступен
 * (данные плагинов — шаблоны и т.п., несекретные; credentials/куки/конфиг таким
 * путём не отдаются вообще). Запись — в снапшот + оппортунистически в IPC.
 * Сообщения от оболочки — через window.__chromeShimReceive (fan-out по onMessage).
 * Имя текущего плагина loader кладёт в window.__shellPluginName перед его кодом.
 */
import { CHROME_SHIM } from '../../shared/chrome-shim'

// Перехват Ctrl+клика и средней кнопки в гостевой странице. Идемпотентно:
// повторная инъекция в ту же вкладку ничего не делает.
export const LINK_HOOK = `(function(){
  try {
    if (window.__shellLinkHook) return;
    window.__shellLinkHook = true;
    window.__shellNewTabReq = window.__shellNewTabReq || [];
    var push = function (ev) {
      try {
        if (ev.type === 'auxclick' && ev.button !== 1) return;
        if (ev.type === 'click' && !(ev.ctrlKey || ev.metaKey)) return;
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        window.__shellNewTabReq.push({ url: new URL(href, document.baseURI).href });
      } catch (e) {}
    };
    document.addEventListener('click', push, true);
    document.addEventListener('auxclick', push, true);
  } catch (e) {}
})()`

// Забор очереди ссылок из активной вкладки. Возвращает всегда строку —
// результат executeJavaScript обязан быть structured-cloneable.
export const LINK_TAKE = '(function(){try{var q=window.__shellNewTabReq;if(!Array.isArray(q))return "[]";try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()'

/**
 * Инжект всех плагинов в гостевую страницу ОДНИМ executeJavaScript.
 *
 * Раньше на каждую загрузку вкладки уходило ~26 последовательных вызовов
 * (снапшот, poll-host, и на каждый плагин — шим, код, чтение ошибки), и шим
 * инжектился по разу на каждый плагин. Теперь всё склеено в один IIFE:
 * снапшот данных → флаг опросного хоста → шим (один раз) → код плагинов (у
 * каждого свой IIFE с гостевым try/catch и личным `chrome`) → init → сброс
 * имени. Ошибки возвращаются одной JSON-строкой и печатаются в консоль
 * оболочки поимённо — иначе Electron пишет лишь безликое
 * "GUEST_VIEW_MANAGER_CALL: Script failed to execute".
 *
 * Плагин с битым синтаксисом выпадает ДО сборки скрипта: executeJavaScript
 * парсит его целиком, и гостевой try/catch SyntaxError не спасает — упал бы
 * весь батч. Раньше каждый плагин шёл отдельным вызовом и падал сам по себе.
 */
export async function injectPlugins(tab: ShellTab, plugins: PluginInfo[]): Promise<void> {
  const { ok, problems } = selectInjectable(plugins as InjectablePlugin[])
  for (const problem of problems) {
    console.warn(`[plugins:${problem.name}] синтаксическая ошибка, плагин пропущен:`, problem.error)
  }
  if (ok.length === 0) return

  // Стили — до кода плагинов, в порядке плагинов (иначе каскад поменяется).
  for (const plugin of ok) {
    if (!plugin.styles) continue
    try {
      await tab.view.insertCSS(plugin.styles)
    } catch (err) {
      console.warn(`[plugins:${plugin.name}] insertCSS failed:`, err)
    }
  }

  // Снапшот данных плагинов нужен только этой вкладке: остальные получили
  // свой при первой загрузке и обновляются через onPluginDataChanged.
  // Читает шим вместо IPC — см. комментарий к CHROME_SHIM.
  let stores: Record<string, Record<string, unknown>> = {}
  try {
    stores = await window.shell.getAllPluginData()
  } catch (err) {
    console.warn('[shell] getAllPluginData failed:', err)
  }

  const script = buildInjectScript({
    stores,
    // Хост опроса: только первая вкладка забирает очередь заданий
    // (tasks-notify), иначе при N вкладках придёт N одинаковых уведомлений.
    pollHost: tab.isPrimary,
    shim: CHROME_SHIM,
    plugins: ok,
  })
  try {
    const errors = parseInjectResult(await guestJS<string>(tab, 'inject-all', script))
    for (const [name, message] of Object.entries(errors)) {
      console.warn(`[plugins:${name}] guest error:`, message)
    }
  } catch (err) {
    console.warn('[plugins] injection failed:', err)
  }
}


/** Забрать снапшот данных всех плагинов из main и положить в гостевую страницу */
export async function pushPluginStores(): Promise<void> {
  let snapshot: Record<string, Record<string, unknown>> = {}
  try {
    snapshot = await window.shell.getAllPluginData()
  } catch (err) {
    console.warn('[shell] getAllPluginData failed:', err)
  }
  for (const tab of listTabs()) {
    // Незагруженная (ленивая) вкладка гостя не имеет — снапшот долетит при
    // её первой загрузке, из injectPlugins.
    if (!tab.loaded) continue
    try {
      await guestJS<void>(tab, 'push-stores', 'window.__shellPluginStores = ' + JSON.stringify(snapshot) + ';')
    } catch {
      // вкладка могла закрыться между listTabs() и вызовом — пропускаем
    }
  }
}


export const lastGuestErr: Record<string, string> = {}

/** Именованный вызов гостя: при reject пишет КАКОЙ вызов упал и с чем.
 *  Без этого безликий "GUEST_VIEW_MANAGER_CALL: ..." не даёт понять виновника.
 *  Повторы с тем же текстом глушим (дедуп по ключу `${'$'}{tab.id}:{label}`),
 *  исключение пробрасываем. */
export async function guestJS<T>(tab: ShellTab, label: string, code: string): Promise<T> {
  // Выгрузка по бюджету разорвала webview: гостя за вкладкой физически нет, и
  // executeJavaScript упал бы с GUEST_VIEW_MANAGER_CALL. Это штатное состояние,
  // а не ошибка, — отдаём пустой результат, чтобы фоновый опрос молчал.
  if (!tab.loaded) return null as T
  const key = `${tab.id}:${label}`
  try {
    return (await tab.view.executeJavaScript(code)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (lastGuestErr[key] !== msg) {
      lastGuestErr[key] = msg
      console.warn(`[guestjs:${key}] failed:`, msg)
    }
    throw err
  }
}

export function isExternalProtocol(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol !== 'http:' && protocol !== 'https:'
  } catch {
    return false
  }
}

