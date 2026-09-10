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
  /** Путь к JS-файлу, исполняемому в контексте страницы (относительно папки плагина) */
  renderer?: string
  /** Шорткаты main-процесса: комбинация -> действие */
  hotkeys?: Record<string, HotkeyAction>
  enabled?: boolean
}

export interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  code?: string
}

/** features/ в dev — рядом с проектом; в prod — в resources/ (extraResources) */
export function getFeaturesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'features')
  // dev: __dirname = <proj>/out/main → два уровня вверх = корень проекта
  return join(__dirname, '..', '..', 'features')
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
      try {
        plugin.code = readFileSync(join(pluginDir, manifest.renderer), 'utf-8')
      } catch (err) {
        console.warn(`[plugins] failed to read renderer for ${manifest.name}:`, err)
      }
    }
    result.push(plugin)
  }

  return result
}
