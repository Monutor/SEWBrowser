import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Результат сканирования: при ok — buffer + определённый формат; иначе — причина в error */
export interface ScanResult {
  ok: boolean
  error?: string
  buffer?: Buffer
  mime?: string
  ext?: string
}

/** magic-байты → расширение и MIME. Порядок важен (PNG длиннее JPEG). */
const MAGIC_FORMATS: Array<{ sig: number[]; ext: string; mime: string }> = [
  { sig: [0x89, 0x50, 0x4e, 0x47], ext: 'png', mime: 'image/png' },
  { sig: [0xff, 0xd8, 0xff], ext: 'jpg', mime: 'image/jpeg' },
  { sig: [0x47, 0x49, 0x46, 0x38], ext: 'gif', mime: 'image/gif' },
  { sig: [0x42, 0x4d], ext: 'bmp', mime: 'image/bmp' },
]

function detectFormat(buffer: Buffer): { ext: string; mime: string } | null {
  for (const fmt of MAGIC_FORMATS) {
    let match = true
    for (let i = 0; i < fmt.sig.length; i++) {
      if (buffer[i] !== fmt.sig[i]) {
        match = false
        break
      }
    }
    if (match) return { ext: fmt.ext, mime: fmt.mime }
  }
  return null
}

/**
 * Скрипт WIA: показывает штатный диалог выбора сканера Windows и сохраняет
 * результат в переданный путь. Коды выхода: 0 — ок, 2 — отменено, иначе — ошибка.
 */
const WIA_SCRIPT = `
$ErrorActionPreference = 'Stop'
$outPath = $args[0]
try {
    $wia = New-Object -ComObject WIA.CommonDialog
    $img = $wia.ShowAcquisition()
    if ($null -eq $img) { exit 2 }
    $img.FileData.BinaryData.SaveAsFile($outPath)
    if (-not (Test-Path -LiteralPath $outPath)) { exit 3 }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`

/**
 * Сканирование через встроенную в Windows WIA (COM). Запускает child-process
 * PowerShell с диалогом выбора сканера, ждёт результат и читает байты.
 * Таймаут по умолчанию — 15 минут (ручное сканирование не мгновенное).
 */
export async function scanViaWia(timeoutMs = 15 * 60 * 1000): Promise<ScanResult> {
  const scriptPath = join(tmpdir(), 'sew-browser-wia-scan.ps1')
  if (!existsSync(scriptPath)) {
    try {
      writeFileSync(scriptPath, WIA_SCRIPT)
    } catch (err) {
      return { ok: false, error: `не удалось записать скрипт сканера: ${String(err)}` }
    }
  }

  const outPath = join(tmpdir(), `sew-scan-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`)

  // WIA COM работает только в классическом PowerShell 5.1 (не pwsh Core).
  const psExecutable = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell'

  return new Promise<ScanResult>((resolve) => {
    let settled = false
    const finish = (result: ScanResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Чистим временные файлы независимо от результата
      try {
        if (existsSync(outPath)) unlinkSync(outPath)
      } catch {}
      try {
        if (existsSync(scriptPath)) unlinkSync(scriptPath)
      } catch {}
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ ok: false, error: 'таймаут сканирования' }),
      timeoutMs,
    )

    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(
        psExecutable,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      finish({ ok: false, error: `не удалось запустить PowerShell: ${String(err)}` })
      return
    }

    let stderr = ''
    // WIA не пишет в stdout — глушим, чтобы буфер не забился
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => finish({ ok: false, error: `ошибка запуска сканера: ${err.message}` }))
    child.on('exit', (code) => {
      if (code === 0) {
        try {
          const buffer = readFileSync(outPath)
          if (!buffer.length) return finish({ ok: false, error: 'отсканированный файл пуст' })
          const fmt = detectFormat(buffer)
          return finish({ ok: true, buffer, mime: fmt?.mime ?? 'image/jpeg', ext: fmt?.ext })
        } catch (err) {
          return finish({ ok: false, error: `не прочитать результат сканера: ${String(err)}` })
        }
      }
      if (code === 2) return finish({ ok: false, error: 'отменено' })
      const msg = stderr.trim() || `код выхода ${code}`
      return finish({ ok: false, error: msg })
    })
  })
}

/** Результат проверки подключённых WIA-устройств */
export interface DeviceListResult {
  ok: boolean
  error?: string
  /** Дружественные имена найденных устройств (пусто, если ни одного) */
  devices?: string[]
}

/**
 * Скрипт перечисления WIA-устройств через DeviceManager. Пишет в stdout строки
 * «DEVICE:<имя>» по каждому устройству и финальное «COUNT:<n>». Коды выхода:
 * 0 — ок (даже при нуле устройств), иначе — ошибка.
 */
const DEVICE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
    $dm = New-Object -ComObject WIA.DeviceManager
    $devices = $dm.Devices
    if ($null -eq $devices) { "COUNT:0"; exit 0 }
    $count = 0
    foreach ($d in $devices) {
        try {
            $name = [string]$d.Info.FriendlyName
            "DEVICE:" + $name
            $count++
        } catch {}
    }
    "COUNT:$count"
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
`

/**
 * Проверяет, какие WIA-устройства доступны сейчас (без запуска сканирования).
 * Нужен для кнопки «Определить сканер» — сразу видно, видит ли Windows устройство.
 */
export async function detectWiaDevices(timeoutMs = 20000): Promise<DeviceListResult> {
  const scriptPath = join(tmpdir(), 'sew-browser-wia-detect.ps1')
  if (!existsSync(scriptPath)) {
    try {
      writeFileSync(scriptPath, DEVICE_SCRIPT)
    } catch (err) {
      return { ok: false, error: `не удалось записать скрипт определения сканеров: ${String(err)}` }
    }
  }

  return new Promise<DeviceListResult>((resolve) => {
    let settled = false
    const finish = (result: DeviceListResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (existsSync(scriptPath)) unlinkSync(scriptPath)
      } catch {}
      resolve(result)
    }

    const timer = setTimeout(
      () => finish({ ok: false, error: 'таймаут проверки сканеров' }),
      timeoutMs,
    )

    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(
        process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      return finish({ ok: false, error: `не удалось запустить PowerShell: ${String(err)}` })
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => finish({ ok: false, error: `ошибка запуска сканера: ${err.message}` }))
    child.on('exit', (code) => {
      if (code !== 0) {
        const msg = stderr.trim() || `код выхода ${code}`
        return finish({ ok: false, error: msg })
      }
      const devices: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^DEVICE:(.*)$/.exec(line)
        if (m && m[1].trim()) devices.push(m[1].trim())
      }
      return finish({ ok: true, devices })
    })
  })
}
