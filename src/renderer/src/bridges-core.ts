/**
 * Чистая часть мостов гостя — без DOM и без IPC, чтобы покрываться node:test.
 * Гость копит запросы в глобальных очередях плагинов, оболочка забирает их
 * одним executeJavaScript за тик (вместо трёх отдельных) и отвечает.
 * Всё, что зависит от гостя, живёт в bridges.ts.
 */

/** Канал моста = одна очередь гостя */
export type BridgeChannel = 'bff' | 'scans' | 'inv'

/** Глобаль гостя, в котором плагин кладёт запросы по каналу */
const QUEUE_GLOBALS: Record<BridgeChannel, string> = {
  bff: '__sewHelperBffReq',
  scans: '__sewScansReq',
  inv: '__sewInventoryReq',
}

/** Плагин, чьё включение в настройках разрешает опрашивать канал */
export const BRIDGE_PLUGIN: Record<BridgeChannel, string> = {
  bff: 'sew-helper',
  scans: 'scans-block',
  inv: 'sew-inventory',
}

export const BRIDGE_CHANNELS: BridgeChannel[] = ['bff', 'scans', 'inv']

/** Забранные очереди; отсутствующий или битый канал — пустой массив */
export interface TakenQueues {
  bff: unknown[]
  scans: unknown[]
  inv: unknown[]
}

/** Пустая разборка — безопасное состояние по умолчанию */
export function emptyQueues(): TakenQueues {
  return { bff: [], scans: [], inv: [] }
}

/**
 * Скрипт гостя: разом снимает (splice(0)) все перечисленные очереди и отдаёт их
 * одной JSON-строкой. Строка вместо объекта — результат executeJavaScript
 * обязан быть structured-cloneable, а IIFE обязана заканчиваться `})()`
 * (иначе GUEST_VIEW_MANAGER_CALL: An object could not be cloned).
 */
export function buildTakeScript(channels: readonly BridgeChannel[]): string {
  const parts: string[] = []
  for (const channel of channels) {
    const key = JSON.stringify(channel)
    const queue = QUEUE_GLOBALS[channel]
    parts.push(
      `try{var q=window.${queue};out[${key}]=Array.isArray(q)?q.splice(0):[]}` +
        `catch(e){out[${key}]=[]}`,
    )
  }
  return `(function(){var out={};${parts.join('')}return JSON.stringify(out)})()`
}

/** Разбор ответа гостя в очереди по каналам. Мусор не роняет мост. */
export function parseTakeResult(raw: unknown): TakenQueues {
  const out = emptyQueues()
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : '')
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  const src = parsed as Record<string, unknown>
  for (const channel of BRIDGE_CHANNELS) {
    const value = src[channel]
    out[channel] = Array.isArray(value) ? value : []
  }
  return out
}

/** Есть ли в разборе хоть один запрос — по этому держим быстрый интервал */
export function anyRequest(queues: TakenQueues): boolean {
  return queues.bff.length > 0 || queues.scans.length > 0 || queues.inv.length > 0
}

export interface BffRequest {
  id: string
  url: string
}

export interface ScansRequest {
  id: string
  type: string
  payload?: unknown
}

export interface InvRequest {
  id: string
  /** 'pick' — запрос выбора файла остатков с диска; пусто = обычный разбор по зоне */
  type?: string
  zone?: string
  skus?: string[]
  /** Ручной режим: путь к файлу остатков на диске вместо скачивания из SEW */
  manualPath?: string
}

/** Отсечь битые записи очереди: без id ответ не положить, url/zone приводим к строке */
export function asBffReqs(items: unknown[]): BffRequest[] {
  const out: BffRequest[] = []
  for (const item of items) {
    const rec = asRecord(item)
    if (!rec || typeof rec.id !== 'string' || typeof rec.url !== 'string') continue
    out.push({ id: rec.id, url: rec.url })
  }
  return out
}

export function asScansReqs(items: unknown[]): ScansRequest[] {
  const out: ScansRequest[] = []
  for (const item of items) {
    const rec = asRecord(item)
    if (!rec || typeof rec.id !== 'string' || typeof rec.type !== 'string') continue
    out.push({ id: rec.id, type: rec.type, payload: rec.payload })
  }
  return out
}

export function asInvReqs(items: unknown[]): InvRequest[] {
  const out: InvRequest[] = []
  for (const item of items) {
    const rec = asRecord(item)
    if (!rec || typeof rec.id !== 'string') continue
  out.push({
    id: rec.id,
    type: typeof rec.type === 'string' ? rec.type : undefined,
    zone: typeof rec.zone === 'string' ? rec.zone : undefined,
    skus: Array.isArray(rec.skus) ? rec.skus.filter((s): s is string => typeof s === 'string') : [],
    manualPath: typeof rec.manualPath === 'string' && rec.manualPath ? rec.manualPath : undefined,
  })
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export interface PollDelayOptions {
  /** Интервал при найденной работе */
  work: number
  /** Потолок интервала простоя */
  idleMax: number
  /** Насколько растёт интервал за тик простоя */
  step: number
}

/**
 * Адаптивный интервал: работа есть — быстро, простой — шаг за шагом до потолка.
 * Общий для три моста: забрали всё разом, значит и дышим одним таймером.
 */
export function nextPollDelay(prev: number, hadWork: boolean, opts: PollDelayOptions): number {
  if (hadWork) return opts.work
  return Math.min(opts.idleMax, prev + opts.step)
}