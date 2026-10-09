/**
 * Разбор запросов записи chrome.storage.local, пришедших из гостевой страницы.
 *
 * У <webview> нет preload, поэтому window.shell в госте отсутствует и IPC оттуда
 * недоступен (см. шапку src/shared/chrome-shim.ts). Шим складывает записи в
 * очередь window.__shellStoreReq, оболочка забирает её общим опросом мостов и
 * вызывает plugin-data:set / plugin-data:remove от себя.
 *
 * Гость — недоверенная страница SEW, поэтому вход проверяется здесь: имя плагина
 * обязано быть безопасным именем файла (та же регулярка, что у fileOf в
 * src/main/plugins/store.ts — иначе запись уехала бы за пределы каталога
 * plugin-data), а размер значения ограничен, чтобы страница не забила диск.
 */

/** Имя плагина -> безопасное имя файла. Дублирует fileOf() из plugins/store.ts. */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i

/**
 * Потолок на JSON-значение одной записи. Выше потолка кэша barcodeDbIndex
 * (features/sew-helper/db-loader.js, DB_INDEX_BUDGET_BYTES = 4 МБ), иначе
 * оптимизация «не качать db.json заново» перестала бы работать.
 */
export const STORE_VALUE_MAX = 8 * 1024 * 1024

export type StoreOp = 'set' | 'remove'

export interface StoreSetReq {
  plugin: string
  op: 'set'
  data: Record<string, unknown>
}

export interface StoreRemoveReq {
  plugin: string
  op: 'remove'
  keys: string[]
}

export type StoreRequest = StoreSetReq | StoreRemoveReq

/**
 * Отсечь битые записи очереди. Мусор и слишком крупные значения молча теряются:
 * очередь приходит из гостя, ронять из-за неё опрос мостов нельзя.
 */
export function asStoreReqs(items: unknown[]): StoreRequest[] {
  const out: StoreRequest[] = []
  for (const item of items) {
    const rec = asRecord(item)
    if (!rec) continue
    const plugin = rec.plugin
    if (typeof plugin !== 'string' || !PLUGIN_NAME_RE.test(plugin)) continue
    if (rec.op === 'set') {
      const data = asRecord(rec.data)
      if (!data) continue
      if (jsonSize(data) > STORE_VALUE_MAX) continue
      out.push({ plugin, op: 'set', data })
    } else if (rec.op === 'remove') {
      if (!Array.isArray(rec.keys)) continue
      const keys = rec.keys.filter((k): k is string => typeof k === 'string')
      if (keys.length === 0) continue
      out.push({ plugin, op: 'remove', keys })
    }
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Размер значения в байтах UTF-16 (JSON.stringify падает на цикле — считаем 0) */
function jsonSize(data: Record<string, unknown>): number {
  try {
    return JSON.stringify(data).length
  } catch {
    return 0
  }
}