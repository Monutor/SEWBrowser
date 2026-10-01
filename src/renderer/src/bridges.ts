import { focusOrOpenTab, listTabs, primaryTab } from './tabs'
import { guestJS } from './guest'
import { formatTaskAlertText, getTaskAlertUrls, type TaskAlertController } from './task-alert'
import { setStatus } from './status-ui'
import { hostOf, normalizeUrl } from './util'

/**
 * Мосты гостевой страницы: BFF sew-helper, сканы HP и tasks-notify.
 * Все три опрашивают страницу адаптивным интервалом и пишут результат
 * в UI оболочки через deps.
 */
export interface BridgesDeps {
  config(): ShellConfig | null
  plugins(): PluginInfo[]
  taskAlert(): TaskAlertController | null
  tasksUrl(url: string): string
  isAllowed(url: string): boolean
}

let deps!: BridgesDeps

/** Передать зависимости оболочки. Обязательно до любого start*. */
export function initBridges(next: BridgesDeps): void {
  deps = next
}

/**
 * BFF-мост для sew-helper: гость складывает запросы в window.__sewHelperBffReq,
 * оболочка забирает их (splice — атомарно), ходит в main через netFetch
 * (net.fetch: без CORS, куки общие с webview через default session) и кладёт
 * ответы в window.__sewHelperBffRes[id]. Опрос каждые 500 мс, только если
 * плагин загружен.
 */
let sewHelperBridgeStarted = false
let bffTakeDiagged = false
/** Адаптивный опрос: 500мс при работе, до 2000мс в простое + пауза когда окно скрыто */
let bffDelay = 500
let bffBusy = false
export function startSewHelperBridge(): void {
  if (sewHelperBridgeStarted) return
  sewHelperBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      bffDelay = 2000
      setTimeout(tick, bffDelay)
      return
    }
    if (!bffBusy) {
      bffBusy = true
      void pumpSewHelperBff()
        .then((hadWork) => {
          bffDelay = hadWork ? 500 : Math.min(2000, bffDelay + 250)
        })
        .catch(() => {
          bffDelay = Math.min(2000, bffDelay + 250)
        })
        .finally(() => {
          bffBusy = false
        })
    }
    setTimeout(tick, bffDelay)
  }
  setTimeout(tick, 500)
}

export async function pumpSewHelperBff(): Promise<boolean> {
  try {
    if (!deps.plugins().some((p) => p.name === 'sew-helper')) return false
    // Обходим ВСЕ вкладки: BFF-запрос может прийти из любой, а в госте у него
    // 30-секундный таймаут ожидания ответа — не опросим вкладку, она зависнет.
    // hadWork: был ли хоть один запрос — по нему адаптивный таймер держит 500мс.
    let hadWork = false
    for (const tab of listTabs()) {
      // Ленивая (ещё не загруженная) вкладка гостя не имеет — опрашивать некого.
      if (!tab.loaded) continue
      // Гостевая часть — полностью неубиваемая (вложенные try/catch): reject
      // executeJavaScript Electron всегда дублирует внутренним логом
      // "GUEST_VIEW_MANAGER_CALL: ...", поэтому гость не должен кидать
      // в принципе.
      // take возвращает JSON-СТРОКУ (structured clone результата падает на
      // объектах только в экзотике, строка — всегда безопасна). КРИТИЧНО:
      // IIFE обязана заканчиваться `()()` — голая `(function(){...})` без вызова
      // возвращает сам объект функции, а он неклонируем:
      // "GUEST_VIEW_MANAGER_CALL: An object could not be cloned" (ловушка 17).
      let rawTake: string
      try {
        rawTake = await guestJS<string>(
          tab,
          'bff-take',
          '(function(){try{var q=window.__sewHelperBffReq;if(!Array.isArray(q))return "[]";' +
            'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
        )
      } catch (err) {
        // take возвращает строку во всех ветках — клон здесь ни при чём.
        // Фиксируем состояние ГЕСТА (синхронные хост-вызовы, без клона),
        // чтобы понять, в какой момент падает invoke. Однократно.
        if (!bffTakeDiagged) {
          bffTakeDiagged = true
          try {
            console.warn(
              `[guestjs:bff-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
            )
          } catch {
            // ignore
          }
        }
        continue
      }
      let reqs: Array<{ id: string; url: string }> = []
      try {
        const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
        if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; url: string }>
      } catch {
        reqs = []
      }
      for (const req of reqs) {
        if (!req || typeof req.id !== 'string' || typeof req.url !== 'string') continue
        hadWork = true
        let res: { ok: boolean; status: number; data: unknown }
        try {
          res = await window.shell.netFetch(req.url)
        } catch {
          res = { ok: false, status: 0, data: null }
        }
        try {
          await guestJS<boolean>(
            tab,
            'bff-write',
            '(function(id,payload){try{(window.__sewHelperBffRes = window.__sewHelperBffRes || {})[id]=payload;return true}catch(e){return false}})' +
              '(' +
              JSON.stringify(req.id) +
              ',' +
              JSON.stringify(res ?? { ok: false, status: 0, data: null }) +
              ')',
          )
        } catch {
          // вкладка могла закрыться между опросом и ответом — гость повторит запрос сам (retry)
        }
      }
    }
    return hadWork
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

/**
 * Мост для в-page блока «Сканы»: гость складывает запросы в
 * window.__sewScansReq, оболочка забирает их (splice — атомарно) и ходит в main
 * через window.shell.* (у гостя нет window.shell, поэтому мост — в renderer).
 * Ответи кладём в window.__sewScansRes[id] как JSON-СТРОКУ (structured clone
 * падает на объектах; строка безопасна). IIFE ОБЯЗАТНО заканчивается `()()`
 * (ловушка 17: голая `(function(){...})` без вызова не клонируется → GUEST_VIEW_MANAGER_CALL).
 */
let scansBridgeStarted = false
let scansTakeDiagged = false
/** Тот же адаптивный опрос, что у BFF-моста: быстро при работе, медленно в простое */
let scansDelay = 500
let scansBusy = false
export function startScansBridge(): void {
  if (scansBridgeStarted) return
  scansBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      scansDelay = 2000
      setTimeout(tick, scansDelay)
      return
    }
    if (!scansBusy) {
      scansBusy = true
      void pumpScansBridge()
        .then((hadWork) => {
          scansDelay = hadWork ? 500 : Math.min(2000, scansDelay + 250)
        })
        .catch(() => {
          scansDelay = Math.min(2000, scansDelay + 250)
        })
        .finally(() => {
          scansBusy = false
        })
    }
    setTimeout(tick, scansDelay)
  }
  setTimeout(tick, 500)
}

export async function pumpScansBridge(): Promise<boolean> {
  try {
    if (!deps.plugins().some((p) => p.name === 'scans-block')) return false
    // Как и BFF-мост: запрос «Сканы» может прийти из любой вкладки, а ответ
    // ждёт в госте с таймаутом — обходим все вкладки подряд.
    let hadWork = false
    for (const tab of listTabs()) {
      if (!tab.loaded) continue
      let rawTake: string
      try {
        rawTake = await guestJS<string>(
          tab,
          'scans-take',
          '(function(){try{var q=window.__sewScansReq;if(!Array.isArray(q))return "[]";' +
            'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
        )
      } catch (err) {
        if (!scansTakeDiagged) {
          scansTakeDiagged = true
          try {
            console.warn(
              `[guestjs:scans-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
            )
          } catch {
            // ignore
          }
        }
        continue
      }
      let reqs: Array<{ id: string; type: string; payload?: unknown }> = []
      try {
        const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
        if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; type: string; payload?: unknown }>
      } catch {
        reqs = []
      }
      for (const req of reqs) {
        if (!req || typeof req.id !== 'string' || typeof req.type !== 'string') continue
        hadWork = true
        let result: unknown
        try {
          switch (req.type) {
            case 'list':
              result = await window.shell.listScans()
              break
            case 'read':
              result = typeof req.payload === 'string' ? await window.shell.readScanFile(req.payload) : null
              break
            case 'launch':
              result = await window.shell.launchScannerApp()
              break
            case 'pick':
              result = await window.shell.pickScanFile()
              break
            case 'open':
              result = typeof req.payload === 'string' ? await window.shell.openScanFile(req.payload) : false
              break
            case 'show':
              result = typeof req.payload === 'string' ? await window.shell.showScanInFolder(req.payload) : false
              break
            case 'delete':
              result = typeof req.payload === 'string' ? await window.shell.deleteScan(req.payload) : []
              break
            default:
              result = { ok: false, error: 'unknown type' }
          }
        } catch (err) {
          console.warn(`[scans-bridge] ${req.type} failed:`, err)
          result = { ok: false, error: String((err as Error)?.message ?? err) }
        }
        try {
          await guestJS<boolean>(
            tab,
            'scans-write',
            '(function(id,payload){try{(window.__sewScansRes = window.__sewScansRes || {})[id]=payload;return true}catch(e){return false}})' +
              '(' +
              JSON.stringify(req.id) +
              ',' +
              JSON.stringify(result ?? null) +
              ')',
          )
        } catch {
          // вкладка могла закрыться между опросом и ответом — гость повторит запрос сам
        }
      }
    }
    return hadWork
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

/**
 * Мост остатков для плагина `sew-inventory`: гость (страница ЛП) кладёт запрос
 * в window.__sewInventoryReq, оболочка забирает его (splice — атомарно) и зовёт
 * window.shell.readStockForZone: в main файл скачивается тем же кодом, что и
 * кнопка «Остатки», и разбирается там же. Ответ кладём в
 * window.__sewInventoryRes[id] ОБЪЕКТОМ, как в BFF-мосте: JSON.stringify без
 * кавычек в коде гостя даёт литерал, поэтому «строковый» ответ пришлось бы
 * экранировать. IIFE ОБЯЗАТЕЛЬНО заканчивается `()()` (ловушка 17).
 */
let inventoryBridgeStarted = false
let inventoryTakeDiagged = false
let inventoryGatedLogged = false
let inventoryDelay = 500
let inventoryBusy = false
export function startInventoryBridge(): void {
  if (inventoryBridgeStarted) return
  inventoryBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      inventoryDelay = 2000
      setTimeout(tick, inventoryDelay)
      return
    }
    if (!inventoryBusy) {
      inventoryBusy = true
      void pumpInventoryBridge()
        .then((hadWork) => {
          inventoryDelay = hadWork ? 500 : Math.min(2000, inventoryDelay + 250)
        })
        .catch(() => {
          inventoryDelay = Math.min(2000, inventoryDelay + 250)
        })
        .finally(() => {
          inventoryBusy = false
        })
    }
    setTimeout(tick, inventoryDelay)
  }
  setTimeout(tick, 500)
}

export async function pumpInventoryBridge(): Promise<boolean> {
  try {
    if (!deps.plugins().some((p) => p.name === 'sew-inventory')) {
      if (!inventoryGatedLogged) {
        inventoryGatedLogged = true
        console.warn('[inventory-bridge] плагин sew-inventory выключен в настройках — мост молчит')
      }
      return false
    }
    let hadWork = false
    for (const tab of listTabs()) {
      if (!tab.loaded) continue
      let rawTake: string
      try {
        rawTake = await guestJS<string>(
          tab,
          'inventory-take',
          '(function(){try{var q=window.__sewInventoryReq;if(!Array.isArray(q))return "[]";' +
            'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
        )
      } catch (err) {
        if (!inventoryTakeDiagged) {
          inventoryTakeDiagged = true
          try {
            console.warn(
              `[guestjs:inventory-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
            )
          } catch {
            // ignore
          }
        }
        continue
      }
      let reqs: Array<{ id: string; zone?: string; skus?: string[] }> = []
      try {
        const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
        if (Array.isArray(parsed)) reqs = parsed as typeof reqs
      } catch {
        reqs = []
      }
      for (const req of reqs) {
        if (!req || typeof req.id !== 'string') continue
        hadWork = true
        let result: unknown
        try {
          result = await window.shell.readStockForZone(
            typeof req.zone === 'string' ? req.zone : '',
            Array.isArray(req.skus) ? req.skus.filter((s): s is string => typeof s === 'string') : [],
          )
        } catch (err) {
          console.warn('[inventory-bridge] readStockForZone failed:', err)
          result = { ok: false, error: String((err as Error)?.message ?? err) }
        }
        // По одному ответу на запрос — чтобы по консоли оболочки было видно, дошёл
        // ли запрос гостя и что вернул main.
        const summary = (result ?? null) as { ok?: boolean; rows?: unknown[]; error?: string } | null
        console.info(
          '[inventory-bridge] зона «' + (req.zone || '') + '»:',
          summary && summary.ok ? 'позиций ' + (summary.rows ? summary.rows.length : 0) : 'ошибка — ' + (summary && summary.error),
        )
        try {
          await guestJS<boolean>(
            tab,
            'inventory-write',
            '(function(id,payload){try{(window.__sewInventoryRes = window.__sewInventoryRes || {})[id]=payload;return true}catch(e){return false}})' +
              '(' +
              JSON.stringify(req.id) +
              ',' +
              JSON.stringify(result ?? null) +
              ')',
          )
        } catch {
          // вкладка могла закрыться между опросом и ответом — гость повторит запрос сам
        }
      }
    }
    return hadWork
  } catch {
    return false
  }
}

let tasksNotifyStarted = false
let tasksNotifyDiagged = false
let tasksNotifyDelay = 5000
let tasksNotifyBusy = false
/** Свой звук из настроек (soundFile/soundName — перемещение, soundFileHo/soundNameHo — выдача); '' — стандартный бип */
let tnSoundFileRel = ''
let tnSoundFileHo = ''
/** Кэш Audio своих звуков по слотам (ключ — soundFile); сбрасывается при смене/сбросе настройки */
const tnCustomAudio: Record<'rel' | 'ho', { audio: HTMLAudioElement | null; key: string }> = {
  rel: { audio: null, key: '' },
  ho: { audio: null, key: '' },
}

/** Стандартный бип 880 Гц (дефолт, когда своего файла нет или он битый) */
function playTnBeep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.frequency.value = 880; gain.gain.value = 0.15
    osc.onended = (): void => { ctx.close().catch(() => undefined) }
    osc.start(); osc.stop(ctx.currentTime + 0.25)
    setTimeout(() => { ctx.close().catch(() => undefined) }, 1000)
  } catch { /* без звука */ }
}

/** Свой файл слота — приоритет; любая неудача — молча стандартный бип */
export async function playTnSound(slot: 'rel' | 'ho'): Promise<void> {
  const file = slot === 'ho' ? tnSoundFileHo : tnSoundFileRel
  if (file) {
    try {
      const cached = tnCustomAudio[slot]
      if (!cached.audio || cached.key !== file) {
        const data = await window.shell.getSound(slot)
        if (!data) throw new Error('no custom sound')
        cached.audio = new Audio(`data:${data.mime};base64,${data.base64}`)
        cached.key = file
      } else {
        cached.audio.currentTime = 0
      }
      await cached.audio.play()
      return
    } catch { /* fallback ниже */ }
  }
  playTnBeep()
}
export function startTasksNotifyBridge(): void {
  if (tasksNotifyStarted) return
  tasksNotifyStarted = true
  const tick = (): void => {
    if (!tasksNotifyBusy) {
      tasksNotifyBusy = true
      void pumpTasksNotify()
        .then((hadWork) => { tasksNotifyDelay = hadWork ? 5000 : Math.min(15000, tasksNotifyDelay + 1000) })
        .catch(() => { tasksNotifyDelay = Math.min(15000, tasksNotifyDelay + 1000) })
        .finally(() => { tasksNotifyBusy = false })
    }
    setTimeout(tick, tasksNotifyDelay)
  }
  setTimeout(tick, 5000)
}

/** Дефолт времени показа уведомлений tasks-notify, сек (0 = не скрывать) */
export const TN_ALERT_TTL_DEFAULT_SEC = 60

/** Файлы звука заданы в настройках - оттуда и подхватывает playTnSound. */
export function setTnSoundFiles(rel: string, ho: string): void {
  tnSoundFileRel = rel
  tnSoundFileHo = ho
}

export function setTnSoundFile(slot: 'rel' | 'ho', value: string): void {
  if (slot === 'rel') tnSoundFileRel = value
  else tnSoundFileHo = value
}

export function tnSoundFile(slot: 'rel' | 'ho'): string {
  return slot === 'rel' ? tnSoundFileRel : tnSoundFileHo
}

export function resetTnCustomAudio(slot: 'rel' | 'ho'): void {
  tnCustomAudio[slot] = { audio: null, key: '' }
}

/** Нормализация «Времени показа уведомлений»: 0 = не скрывать, пустое/мусор → дефолт */
export function normalizeTnAlertTtl(raw: unknown): number {
  if (typeof raw === 'string' && !raw.trim()) return TN_ALERT_TTL_DEFAULT_SEC
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : TN_ALERT_TTL_DEFAULT_SEC
}

/**
 * «Время показа уведомлений» из настроек плагина. Читается в момент показа,
 * поэтому новое значение применяется без перезапуска гостя.
 */
export async function readTnAlertTtl(): Promise<number> {
  try {
    const data = await window.shell.pluginDataGet('tasks-notify', ['settings'])
    return normalizeTnAlertTtl((data.settings as { alertTtlSec?: unknown } | undefined)?.alertTtlSec)
  } catch {
    return TN_ALERT_TTL_DEFAULT_SEC
  }
}

async function pumpTasksNotify(): Promise<boolean> {
  try {
    if (!deps.plugins().some((p) => p.name === 'tasks-notify')) return false
    const tab = primaryTab()
    if (!tab) return false
    const rawTake = await guestJS<string>(
      tab,
      'tasks-take',
      // Здесь же поднимаем arm: если первая вкладка закрылась, primaryTab()
      // переехал на другую, а её __tnInit уже отработал и вышел (гость не был
      // хостом на момент загрузки) — код плагина повторно не инжектится, флаг
      // оболочка обновляет только на did-finish-load. Флаг ставим ДО arm'а.
      '(function(){try{window.__shellPollHost = true;' +
        'if (typeof window.__tnArmTasksNotify === "function") window.__tnArmTasksNotify();' +
        'var q=window.__tasksNotifyReq;if(!Array.isArray(q))return "[]";' +
        'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
    ).catch((err) => {
      if (!tasksNotifyDiagged) {
        tasksNotifyDiagged = true
        try {
          console.warn(`[guestjs:tasks-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`)
        } catch { /* ignore */ }
      }
      throw err
    })
    let reqs: Array<{ id: number; kind?: string; title: string; body: string; url: string; sound?: boolean }> = []
    try {
      const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
      if (Array.isArray(parsed)) reqs = parsed as typeof reqs
    } catch { reqs = [] }
    if (!Array.isArray(reqs) || reqs.length === 0) return false
    const valid = reqs.filter((r) => r && typeof r.id === 'number' && typeof r.title === 'string')
    if (valid.length === 0) return false
    try {
      await window.shell.notifyTasks(valid)
    } catch (err) {
      console.warn('[tasks-notify] notifyTasks failed:', err)
    }
    const first = valid[0]
    if (valid.some((r) => r.sound !== false)) {
      void playTnSound(first.kind === 'handover' ? 'ho' : 'rel')
    }
    const taskText = formatTaskAlertText(first)
    const toastText = valid.length > 1 ? `${taskText} (+${valid.length - 1})` : taskText
    const taskUrls = getTaskAlertUrls(first)
    const openUrl = deps.tasksUrl(taskUrls.open)
    const allUrl = taskUrls.all ? deps.tasksUrl(taskUrls.all) : undefined
    // Клик по баннеру открывает задание вкладкой, как и клик по OS-уведомлению
    // (ниже onTasksOpen): навигация в текущей вкладке уничтожила бы её работу.
    deps.taskAlert()?.show(toastText, () => {
      focusOrOpenTab(openUrl)
    }, allUrl ? () => {
      focusOrOpenTab(allUrl)
    } : undefined, await readTnAlertTtl())
    return true
  } catch {
    return false
  }
}
