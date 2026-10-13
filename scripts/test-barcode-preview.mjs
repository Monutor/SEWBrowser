// Стенд превью штрихов: берёт РЕАЛЬНЫЕ позиции из db.json и собирает лист
// с вариантами этикетки. Запуск: node scripts/test-barcode-preview.mjs
// Пишет HTML рядом (scripts/barcode-preview.html) и открывает его в браузере.
//
// db.json берётся из TEMP (путь аргументом) — в репозитории его нет, а качать
// каждый раз 11 МБ ради стенда незачем.
import { readFileSync, writeFileSync } from 'node:fs'
import { exec } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { buildBarcode, barcodeSvg, symbologyName } from '../src/shared/barcode-core.ts'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('Укажи путь к db.json: node scripts/test-barcode-preview.mjs <путь>')
  process.exit(1)
}

const raw = readFileSync(dbPath)
const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
const data = JSON.parse(text)
console.log('позиций в базе:', data.length)

// По одному примеру каждого формата, что реально встречается в базе.
const byLength = new Map()
for (const item of data) {
  const code = String(item['ШК товара'] ?? '').trim()
  if (!byLength.has(code.length)) byLength.set(code.length, item)
}
const picked = [...byLength.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([, item]) => item)

const label = (item) => {
  const barcode = buildBarcode(String(item['ШК товара'] ?? '').trim())
  const code = String(item['ШК товара'] ?? '').trim()
  return `${code} — ${symbologyName(barcode.symbology)}, ${barcode.modules.length} модулей, контрольный ${barcode.check}`
}

const cards = picked.map((item) => `
  <figure>
    <figcaption>${label(item)}</figcaption>
    ${barcodeSvg(String(item['ШК товара']).trim(), { moduleWidth: 2, height: 70 })}
    <div class="t">${item['Код товара']}</div>
    <div class="n">${String(item['Наименование'] ?? '')}</div>
  </figure>`).join('\n')

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>SEWBrowser — превью штрихов</title>
<style>
  body { font: 13px/1.4 "Segoe UI", system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 18px; }
  .grid { display: grid; grid-template-columns: repeat(4, 58mm); gap: 4mm; }
  figure { margin: 0; border: 1px dashed #bbb; padding: 2mm; text-align: center; break-inside: avoid; }
  figcaption { font-size: 9px; color: #666; margin-bottom: 1mm; }
  svg { max-width: 100%; height: auto; }
  .t { font: 700 11px/1.2 Consolas, monospace; margin-top: 1mm; }
  .n { font-size: 9px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @page { size: A4; margin: 8mm; }
</style></head>
<body>
<h1>Превью штрихов из db.json — ${picked.length} позиций</h1>
<p>Распечатайте на настоящем принтере и просканируйте телефоном: с телефона не читается — это не показатель.</p>
<div class="grid">
${cards}
</div>
</body></html>`

const out = new URL('./barcode-preview.html', import.meta.url)
writeFileSync(out, html, 'utf8')
console.log('готово:', out.pathname.slice(1))
exec(`start "" "${out.pathname}"`)