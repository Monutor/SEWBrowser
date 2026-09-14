import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface NavTab {
  id: string;
  name: string;
  url: string;
}

export interface SewConfig {
  startUrl: string;
  debug: boolean;
  allowlistEnabled: boolean;
  allowlist: string[];
  plugins: Record<string, boolean>;
  /** Запомненный зум страниц: host -> zoom factor (1 = 100%) */
  zoom: Record<string, number>;
  /** Автоочистка при выходе: 'none' | 'cache' (только HTTP-кэш) | 'all' (кэш + все хранилища) */
  clearOnExit: 'none' | 'cache' | 'all';
  tabs: NavTab[];
  /** Путь до внешнего софта сканера (напр. HP) — запускается по кнопке «Сканы» */
  scannerAppPath: string;
  /** Аргументы запуска софта сканера (напр. HP G3110 требует -mg3110) */
  scannerAppArgs: string;
  /** Папка, куда HP-софт сохраняет отсканированные файлы — мониторится на новые файлы */
  scanFolder: string;
}

const DEFAULTS: SewConfig = {
  startUrl: 'https://sew.mvideoeldorado.ru/v2/',
  debug: false,
  allowlistEnabled: true,
  // kc.tech.mvideo.ru — SSO (Keycloak), без него не пройти логин в SEW.
  // *.mvideo.ru — визит для cookie-consent + прогрев кук: BFF-мост sew-helper
  // (net:fetch, default session) без MVID-кук отдаёт пусто, принять куки можно
  // только зайдя на www.mvideo.ru прямо из приложения.
   // monutor.github.io — встроенные инструменты в тулбаре (Генератор ШК / База товаров).
   allowlist: ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru', '*.mvideo.ru', '*.monutor.github.io'],
  plugins: {},
  zoom: {},
   clearOnExit: 'none',
   tabs: [],
   scannerAppPath: '',
   scannerAppArgs: '',
   scanFolder: '',
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
  // Dev (npm run dev/dev:watch, app не упакован): дебаг всегда включён.
  // Релиз (app.isPackaged): дебаг выключен, включается только флагом --debug.
  // Поле config.debug больше не читаем, чтобы случайно сохранённый в dev
  // debug:true не протекал в релиз (у dev и релиза общий userData/config.json).
  if (process.argv.includes('--debug')) return true
  return !app.isPackaged
}
