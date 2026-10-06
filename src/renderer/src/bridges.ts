import { focusOrOpenTab, listTabs, primaryTab, type ShellTab } from './tabs'
import { guestJS } from './guest'
import { formatTaskAlertText, getTaskAlertUrls, type TaskAlertController } from './task-alert'
import { setStatus } from './status-ui'
import { hostOf, normalizeUrl } from './util'
import {
  asBffReqs,
  asInvReqs,
  asScansReqs,
  anyRequest,
  BRIDGE_CHANNELS,
  BRIDGE_PLUGIN,
  buildTakeScript,
  nextPollDelay,
  parseTakeResult,
  type BridgeChannel,
  type ScansRequest,
} from './bridges-core.ts'

/**
 * Мосты гостевой страницы: BFF sew-helper, сканы HP, остатки и tasks-notify.
 * Первые три делят один опрос и один адаптивный таймер (см. startPollBridge).
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
 * Общий опрос гостя: одним executeJavaScript забираем сразу BFF-запросы, «Сканы»
 * и «Остатки», отвечаем по каждому каналу. Раньше на канал был свой таймер, то
 * есть на каждую вкладку уходило до трёх вызовов executeJavaScript за тик —
 * основной фоновый поток IPC оболочки. Теперь вызов один, а простой растянут
 * до 4 секунд (таймауты гостя — 30–120 секунд, запас большой).
 *
 * tasks-notify сюда НЕ входит: он работает только с опросным хостом (первой
 * вкладкой) и с ��акими интервалами 5–15 секунд.
 */
let pollBridgeStarted = false
let takeDiagged = false
let pollDelay = 500
let pollBusy = false
/** Интервалы общего опроса: работа / потолок простоя / шаг разгона */
const POLL_DELAY_OPTS = { work: 500, idleMax: 4000, step: 250 }

export function startPollBridge(): void {
  if (pollBridgeStarted) return
  pollBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      pollDelay = POLL_DELAY_OPTS.idleMax
      setTimeout(tick, pollDelay)
      return
    }
    if (!pollBusy) {
      pollBusy = true
      void pumpPollBridge()
        .then((hadWork) => {
          pollDelay = nextPollDelay(pollDelay, hadWork, POLL_DELAY_OPTS)
        })
        .catch(() => {
          pollDelay = nextPollDelay(pollDelay, false, POLL_DELAY_OPTS)
        })
        .finally(() => {
          pollBusy = false
        })
    }
    setTimeout(tick, pollDelay)
  }
  setTimeout(tick, POLL_DELAY_OPTS.work)
}

/** Каналы, чей плагин включён в настройках и чью очередь есть смысла опрашивать. */
function enabledChannels(): BridgeChannel[] {
  const names = deps.plugins().map((p) => p.name)
  return BRIDGE_CHANNELS.filter((channel) => names.includes(BRIDGE_PLUGIN[channel]))
}

/**
 * Один обход вкладок и один take на вкладку. Возвращает, была ли хоть где-нибудь
 * работа: по этому адаптивный таймер держит быстрый интервал.
 */
export async function pumpPollBridge(): Promise<boolean> {
  const channels = enabledChannels()
  if (channels.length === 0) return false
  let hadWork = false
  const takeScript = buildTakeScript(channels)
  for (const tab of listTabs()) {
    // Ленивая (ещё не загруженная) вкладка гостя не имеет — опрашивать некого.
    if (!tab.loaded) continue
    let rawTake: string
    try {
      rawTake = await guestJS<string>(tab, 'poll-take', takeScript)
    } catch {
      // Фиксируем состояние ГЕСТА (синхронные хост-вызовы, без клона), чтобы
      // понять, в какой момент падает invoke. Однократно.
      if (!takeDiagged) {
        takeDiagged = true
        try {
          console.warn(
            `[guestjs:poll-take] guest state: url=${tab.view.getURL()} loading=${tab.view.isLoading()} crashed=${tab.view.isCrashed()}`,
          )
        } catch {
          // ignore
        }
      }
      continue
    }
    const queues = parseTakeResult(rawTake)
    if (!anyRequest(queues)) continue
    hadWork = true
    for (const req of asBffReqs(queues.bff)) await answerBff(tab, req)
    for (const req of asScansReqs(queues.scans)) await answerScans(tab, req)
    for (const req of asInvReqs(queues.inv)) await answerInventory(tab, req)
  }
  return hadWork
}

/**
 * BFF-мост для sew-helper: гость складывает запросы в window.__sewHelperBffReq,
 * оболочка ходит в main через netFetch (net.fetch: без CORS, куки общие с webview
 * через default session) и кладёт ответ в window.__sewHelperBffRes[id].
 */
async function answerBff(tab: ShellTab, req: { id: string; url: string }): Promise<void> {
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

/**
 * Мост для in-page блока «Сканы»: у гостя нет window.shell, поэтому ходим через
 * window.shell.* отсюда. Ответ кладём в window.__sewScansRes[id].
 */
async function answerScans(tab: ShellTab, req: ScansRequest): Promise<void> {
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

/**
 * Мост остатков для плагина `sew-inventory`: зовём window.shell.readStockForZone,
 * в main файл скачивается тем же кодом, что и кнопка «Остатки». Ответ кладём в
 * window.__sewInventoryRes[id].
 */
async function answerInventory(
  tab: ShellTab,
  req: { id: string; zone?: string; skus?: string[] },
): Promise<void> {
  let result: unknown
  try {
    result = await window.shell.readStockForZone(req.zone ?? '', req.skus ?? [])
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

/**
 * Подхватывает свои звуки уведомлений при старте приложения.
 * Иначе tnSoundFileRel/tnSoundFileHo пусты до первого открытия панели настроек
 * (их заполняла только она), и playTnSound уходил в стандартный бип —
 * после перезапуска/обновления звуки «слетали» на дефолтный.
 */
export async function initTnSounds(): Promise<void> {
  try {
    const data = await window.shell.pluginDataGet('tasks-notify', ['settings'])
    const s = data.settings as { soundFile?: unknown; soundFileHo?: unknown } | undefined
    setTnSoundFiles(
      typeof s?.soundFile === 'string' ? s.soundFile : '',
      typeof s?.soundFileHo === 'string' ? s.soundFileHo : '',
    )
    resetTnCustomAudio('rel')
    resetTnCustomAudio('ho')
  } catch (err) {
    console.warn('[shell] failed to init tasks-notify sounds:', err)
  }
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
