/**
 * Имя файла скриншота вкладки. Только чистые данные (без Electron),
 * чтобы логику можно было гонять через node --test без сборки.
 */
export function screenshotFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `sew-shot-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.png`
  )
}
