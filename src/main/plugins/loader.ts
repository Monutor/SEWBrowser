import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SewConfig } from '../config'

export interface HotkeyAction {
  action: 'notify'
  title?: string
  body?: string
}

export interface PluginManifest {
  name: string
  version?: string
  description?: string
  /** Путь к JS-файлу, исполняемому в контексте страницы (относительно папки плагина).
   * Может быть массивом — файлы склеиваются в указанном порядке
   * (например, bridge.js + дословные исходники Chrome-расширения) */
  renderer?: string | string[]
  /** Путь к CSS-файлу плагина (вставляется в страницу через webview.insertCSS) */
  styles?: string
  /** JS-сниппет, выполняемый после кода плагина, если документ уже загружен
   * (например, ручной вызов инициализации, пропущенной из-за DOMContentLoaded) */
  init?: string
  /** Путь к JS options-страницы расширения (выполняется в shell-окне, не в странице) */
  options?: string
  /** Шорткаты main-процесса: комбинация -> действие */
  hotkeys?: Record<string, HotkeyAction>
  enabled?: boolean
}

export interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  code?: string
  styles?: string
  options?: string
}

/** features/ в dev — рядом с проектом; в prod — в resources/ (extraResources) */
export function getFeaturesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'features')
  // dev: __dirname = <proj>/out/main → два уровня вверх = корень проекта
  return join(__dirname, '..', '..', 'features')
}

export interface PluginState {
  name: string
  enabled: boolean
}

/** Все плагины из features/ с резолвом enabled (включая выключенные) — для настроек */
export function listAllPlugins(config: SewConfig): PluginState[] {
  const dir = getFeaturesDir()
  if (!existsSync(dir)) return []
  const result: PluginState[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
      if (!manifest || typeof manifest.name !== 'string' || !manifest.name) continue
      result.push({ name: manifest.name, enabled: config.plugins[manifest.name] ?? manifest.enabled ?? true })
    } catch {
      continue
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export function loadPlugins(config: SewConfig): LoadedPlugin[] {
  const dir = getFeaturesDir()
  if (!existsSync(dir)) {
    console.warn(`[plugins] features dir not found: ${dir}`)
    return []
  }
  const result: LoadedPlugin[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(dir, entry.name)
    const manifestPath = join(pluginDir, 'manifest.json')
    if (!existsSync(manifestPath)) continue

    let manifest: PluginManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
    } catch (err) {
      console.warn(`[plugins] invalid manifest in ${entry.name}:`, err)
      continue
    }

    const enabled = config.plugins[manifest.name] ?? manifest.enabled ?? true
    if (!enabled) continue

    const plugin: LoadedPlugin = { name: manifest.name, manifest }
    if (manifest.renderer) {
      const files = Array.isArray(manifest.renderer) ? manifest.renderer : [manifest.renderer]
      const parts: string[] = []
      for (const file of files) {
        try {
          parts.push(readFileSync(join(pluginDir, file), 'utf-8'))
        } catch (err) {
          console.warn(`[plugins] failed to read renderer for ${manifest.name} (${file}):`, err)
        }
      }
      if (parts.length > 0) plugin.code = parts.join('\n;\n')
    }
    if (manifest.styles) {
      try {
        plugin.styles = readFileSync(join(pluginDir, manifest.styles), 'utf-8')
      } catch (err) {
        console.warn(`[plugins] failed to read styles for ${manifest.name}:`, err)
      }
    }
    if (manifest.options) {
      try {
        plugin.options = readFileSync(join(pluginDir, manifest.options), 'utf-8')
      } catch (err) {
        console.warn(`[plugins] failed to read options for ${manifest.name}:`, err)
      }
    }
    result.push(plugin)
  }

  return result
}
