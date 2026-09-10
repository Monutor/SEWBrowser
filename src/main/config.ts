import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SewConfig {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
}

const DEFAULTS: SewConfig = {
  startUrl: 'https://sew.mvideoeldorado.ru/v2/',
  debug: false,
  allowlistEnabled: true,
  // kc.tech.mvideo.ru — SSO (Keycloak), без него не пройти логин в SEW
  allowlist: ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru'],
  plugins: {},
}

export function getConfig(): SewConfig {
  const file = join(app.getPath('userData'), 'config.json')
  let user: Partial<SewConfig> = {}
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SewConfig>
    } catch {
      // повреждённый конфиг — используем дефолты
    }
  }
  return { ...DEFAULTS, ...user, plugins: { ...DEFAULTS.plugins, ...user.plugins } }
}

export function isDebugMode(): boolean {
  return process.argv.includes('--debug') || getConfig().debug === true
}
