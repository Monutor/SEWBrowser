import { setStatus } from './status-ui'
import { guestJS } from './guest'
import { activeTab } from './tabs'

/** Шаблоны SEW: порт UI расширения SEW-Pattern в оболочку. */

function overlayEl(): HTMLElement {
  return document.getElementById('templates-overlay') as HTMLElement
}

function listEl(): HTMLElement {
  return document.getElementById('templates-list') as HTMLElement
}

function manageOverlayEl(): HTMLElement {
  return document.getElementById('templates-manage-overlay') as HTMLElement
}

let templatesOpen = false
let templatesManageOpen = false

export function isTemplatesOpen(): boolean {
  return templatesOpen
}

export function isTemplatesManageOpen(): boolean {
  return templatesManageOpen
}

export function templatesOverlayEl(): HTMLElement {
  return overlayEl()
}

export function templatesManageOverlayEl(): HTMLElement {
  return manageOverlayEl()
}

export interface TemplatesDeps {
  plugins(): PluginInfo[]
}

let deps!: TemplatesDeps

export function wireTemplates(d: TemplatesDeps): void {
  deps = d
  document.getElementById('btn-templates')?.addEventListener('click', () => void openTemplates())
  document.getElementById('templates-manage')?.addEventListener('click', () => {
    closeTemplates()
    openTemplatesManage()
  })
  document.getElementById('templates-close')?.addEventListener('click', closeTemplates)
  document.getElementById('manageCloseBtn')?.addEventListener('click', closeTemplatesManage)
  // options.js расширения — дословно, с shell-прослойкой вместо chrome.*
  // Нюанс: options.js ждёт DOMContentLoaded, но документ оболочки к этому
  // моменту давно загружен — подписку перехватываем и вызываем колбэк сразу.
  const pattern = deps.plugins().find((p) => p.name === TEMPLATES_PLUGIN)
  if (pattern?.options) {
    const pendingDcl: Array<(event: Event) => void> = []
    const origAddEventListener = document.addEventListener.bind(document)
    function patchedAddEventListener(type: string, listener: unknown, options?: unknown): void {
      if (type === 'DOMContentLoaded' && typeof listener === 'function' && document.readyState !== 'loading') {
        pendingDcl.push(listener as (event: Event) => void)
        return
      }
      ;(origAddEventListener as (...args: unknown[]) => void)(type, listener, options)
    }
    document.addEventListener = patchedAddEventListener as typeof document.addEventListener
    try {
      const runOptions = new Function('chrome', pattern.options) as (chrome: unknown) => void
      runOptions(makeShellChrome(TEMPLATES_PLUGIN))
    } catch (err) {
      console.warn('[templates] options init failed:', err)
    } finally {
      document.addEventListener = origAddEventListener
    }
    for (const cb of pendingDcl) {
      try {
        cb(new Event('DOMContentLoaded'))
      } catch (err) {
        console.warn('[templates] options DCL callback failed:', err)
      }
    }
  }
  // Список применения — живой: обновляем при изменении шаблонов
  window.shell.onPluginDataChanged(({ plugin }) => {
    if (plugin === TEMPLATES_PLUGIN && templatesOpen) void refreshTemplatesList()
  })
}
// ---------- Шаблоны SEW (порт расширения SEW-Pattern) ----------
const TEMPLATES_PLUGIN = 'sew-pattern'

interface TemplateItem {
  id: string
  name?: string
  preset?: string
  fields?: Record<string, string>
}

async function loadTemplateItems(): Promise<TemplateItem[]> {
  try {
    const data = await window.shell.pluginDataGet(TEMPLATES_PLUGIN, ['sew_templates'])
    return Array.isArray(data.sew_templates) ? (data.sew_templates as TemplateItem[]) : []
  } catch (err) {
    console.warn('[templates] load failed:', err)
    return []
  }
}

/** chrome-совместимая прослойка для options.js расширения (выполняется в shell-окне) */
function makeShellChrome(pluginName: string): unknown {
  // Отписки onChanged: без карты removeListener не мог снять конкретный обработчик.
  const changedUnsubs = new Map<(changes: Record<string, { newValue: unknown }>, area: string) => void, () => void>()
  const pickGet = (
    keys: unknown,
    cb?: (res: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | undefined => {
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : undefined
    const p = window.shell.pluginDataGet(pluginName, list).then((all) => {
      if (keys === undefined || keys === null) return all
      if (typeof keys === 'string') return all[keys] !== undefined ? { [keys]: all[keys] } : {}
      if (typeof keys === 'object' && !Array.isArray(keys)) {
        // Форма { key: defaultValue }: отсутствующие ключи подменяются дефолтами (семантика Chrome).
        const defaults = keys as Record<string, unknown>
        const withDefaults: Record<string, unknown> = {}
        for (const k of Object.keys(defaults)) withDefaults[k] = all[k] !== undefined ? all[k] : defaults[k]
        return withDefaults
      }
      const out: Record<string, unknown> = {}
      for (const k of list ?? []) out[k] = all[k]
      return out
    })
    if (typeof cb === 'function') {
      p.then(cb)
      return undefined
    }
    return p
  }
  return {
    storage: {
      local: {
        get: pickGet,
        set: (obj: Record<string, unknown>, cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataSet(pluginName, obj)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
        remove: (keys: string[], cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataRemove(pluginName, keys)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue: unknown }>, area: string) => void): void => {
          if (changedUnsubs.has(fn)) return // повторный add того же fn — не дублируем
          const unsub = window.shell.onPluginDataChanged(({ plugin }) => {
            if (plugin !== pluginName) return
            try {
              fn({ sew_templates: { newValue: true } }, 'local')
            } catch {
              // игнорируем
            }
          })
          changedUnsubs.set(fn, unsub)
        },
        removeListener: (fn: (changes: Record<string, { newValue: unknown }>, area: string) => void): void => {
          changedUnsubs.get(fn)?.()
          changedUnsubs.delete(fn)
        },
      },
    },
    runtime: { lastError: undefined as undefined },
  }
}

let templatesRefreshCall = 0

async function refreshTemplatesList(): Promise<void> {
  if (!listEl()) return
  const myCall = ++templatesRefreshCall
  listEl().innerHTML = ''
  const templates = await loadTemplateItems()
  // Пока грузили, мог прийти более свежий вызов (двойной клик, хоткей + кнопка) —
  // устаревший результат не рисуем, иначе строки задвоятся.
  if (myCall !== templatesRefreshCall) return
  if (templates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'settings-row'
    empty.textContent = 'Нет шаблонов. Откройте «Управление шаблонами» и создайте первый.'
    listEl().append(empty)
    return
  }
  for (const tpl of templates) {
    const fieldCount = tpl.fields ? Object.keys(tpl.fields).length : 0
    const presetName = tpl.preset === 'trn' ? 'ТрН' : tpl.preset || 'ТрН'
    const row = document.createElement('div')
    row.className = 'templates-row'
    const name = document.createElement('span')
    name.className = 'tpl-name'
    name.textContent = tpl.name || 'Без имени'
    const meta = document.createElement('span')
    meta.className = 'tpl-meta'
    meta.textContent = `${presetName} · ${fieldCount} полей`
    row.append(name, meta)
    row.addEventListener('click', () => void applyTemplateFromShell(tpl.id))
    listEl().append(row)
  }
}

export async function openTemplates(): Promise<void> {
  if (!overlayEl()) return
  await refreshTemplatesList()
  overlayEl().hidden = false
  templatesOpen = true
}

export function closeTemplates(): void {
  if (!overlayEl()) return
  overlayEl().hidden = true
  templatesOpen = false
}

/** Применить шаблон к открытой форме SEW — через onMessage-подписку content-скрипта */
async function applyTemplateFromShell(id: string): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  try {
    const delivered = await guestJS<boolean>(
      tab,
      'apply-template',
      `typeof window.__chromeShimReceive === 'function'` +
        ` ? (window.__chromeShimReceive({action:'applyTemplate',templateId:${JSON.stringify(id)}}), true)` +
        ` : false`,
    )
    closeTemplates()
    setStatus(delivered ? 'шаблон применён' : 'откройте форму в SEW и повторите')
  } catch (err) {
    console.warn('[templates] apply failed:', err)
    setStatus('не удалось применить шаблон')
  }
}

export function openTemplatesManage(): void {
  if (!manageOverlayEl()) return
  manageOverlayEl().hidden = false
  templatesManageOpen = true
}

export function closeTemplatesManage(): void {
  if (!manageOverlayEl()) return
  manageOverlayEl().hidden = true
  templatesManageOpen = false
}

