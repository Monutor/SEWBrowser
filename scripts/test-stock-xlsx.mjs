// Стенд фичи: разбор реальной выгрузки остатков (xlsx) из src/main/inventory/xlsx-core.ts.
// Запуск: node scripts/test-stock-xlsx.mjs ["<путь к .xlsx>"]
// Без аргумента берёт последний «Остатки *.xlsx» из системных загрузок.
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const { readStockBalance } = await import('../src/main/inventory/xlsx-core.ts')

function latestXlsx() {
  const dir = join(homedir(), 'Downloads')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.xlsx') && f.includes('Остатки'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (files.length === 0) throw new Error('в загрузках нет «Остатки *.xlsx»')
  return files[0]
}

// Аргументы: [путь к .xlsx] [зона] — любой можно не передавать, первый
// аргумент без расширения .xlsx считается зоной.
const first = process.argv[2] || ''
const path = /\.xlsx$/i.test(first) ? first : latestXlsx()
const zoneArg = /\.xlsx$/i.test(first) ? process.argv[3] : first
const data = readFileSync(path)
console.log(`файл: ${path} (${(data.length / 1024 / 1024).toFixed(2)} МБ)`)

const started = Date.now()
const all = readStockBalance(data)
console.log(`весь файл: строк ${all.totalRows}, позиций ${all.rows.length}, зон ${all.zones.length} [${all.zones.join(', ')}] — ${Date.now() - started} мс`)

const zone = zoneArg || all.zones[0]
const skus = all.rows.slice(0, 3).map((r) => r.sku)
const filtered = readStockBalance(data, { zone, skus })
console.log(`зона «${zone}» + ${skus.length} SKU: строк ${filtered.matchedRows}, позиций ${filtered.rows.length}`)
for (const row of filtered.rows) {
  console.log(`  ${row.sku}  ×${row.qty}  ячеек ${row.cells}  ${row.barcode || 'без ШК'}  ${row.cell || '—'}  ШК ячейки ${row.cellBarcode || '—'}  ${row.name.slice(0, 40)}`)
}

const zero = filtered.rows.filter((r) => r.qty <= 0).length
console.log(`нулевых количеств: ${zero}`)