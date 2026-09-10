import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SewConfig {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  /** Запомненный зум страниц: host -> zoom factor (1 = 100%) */
  zoom: Record<string, number>
  /** Автоочистка при выходе: 'none' | 'cache' (только HTTP-кэш) | 'all' (кэш + все хранилища) */
  clearOnExit: 'none' | 'cache' | 'all'
}

const DEFAULTS: SewConfig = {
  startUrl: 'https://sew.mvideoeldorado.ru/v2/',
  debug: false,
  allowlistEnabled: true,
  // kc.tech.mvideo.ru — SSO (Keycloak), без него не пройти логин в SEW
  allowlist: ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru'],
  plugins: {},
  zoom: {},
  clearOnExit: 'none',
}

function configFile(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readUserConfig(): Partial<SewConfig> {
  const file = configFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Partial<SewConfig>
  } catch {
    // повреждённый конфиг — используем дефолты
    return {}
  }
}

export function getConfig(): SewConfig {
  const user = readUserConfig()
  return {
    ...DEFAULTS,
    ...user,
    plugins: { ...DEFAULTS.plugins, ...user.plugins },
    zoom: { ...DEFAULTS.zoom, ...user.zoom },
  }
}

/** Частичное обновление пользовательского конфига с сохранением на диск */
export function saveConfig(partial: Partial<SewConfig>): SewConfig {
  const current = readUserConfig()
  const merged: Partial<SewConfig> = {
    ...current,
    ...partial,
    plugins: { ...current.plugins, ...partial.plugins },
    zoom: { ...current.zoom, ...partial.zoom },
  }
  try {
    writeFileSync(configFile(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[SEWBrowser] failed to write config:', err)
  }
  return getConfig()
}

export function isDebugMode(): boolean {
  return process.argv.includes('--debug') || getConfig().debug === true
}
