import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedStockTarget } from './stock-core.ts'
import { normalizeScanPath } from './scans-core.ts'

const picked = new Set<string>()

test('не-строки и пустая строка отклоняются', () => {
  assert.equal(isAllowedStockTarget(undefined, picked), false)
  assert.equal(isAllowedStockTarget(null, picked), false)
  assert.equal(isAllowedStockTarget(42, picked), false)
  assert.equal(isAllowedStockTarget('', picked), false)
  assert.equal(isAllowedStockTarget('   ', picked), false)
})

test('ручной ввод с расширением xlsx разрешён', () => {
  assert.equal(isAllowedStockTarget('C:\\Остатки\\S187.xlsx', picked), true)
  assert.equal(isAllowedStockTarget('C:\\Остатки\\S187.XLSX', picked), true)
  assert.equal(isAllowedStockTarget('C:\\Остатки\\S187.xls', picked), true)
})

test('ручной ввод с другим расширением отклоняется', () => {
  assert.equal(isAllowedStockTarget('C:\\Users\\me\\.ssh\\id_rsa', picked), false)
  assert.equal(isAllowedStockTarget('C:\\Users\\me\\passwd.txt', picked), false)
  assert.equal(isAllowedStockTarget('C:\\tmp\\xlsx.zip', picked), false)
})

test('расширение проверяется по границе имени, а не по подстроке', () => {
  assert.equal(isAllowedStockTarget('C:\\tmp\\a.xlsxX', picked), false)
  assert.equal(isAllowedStockTarget('C:\\tmp\\xlsx', picked), false)
})

test('путь, выбранный через диалог, разрешён независимо от расширения', () => {
  const registry = new Set<string>()
  registry.add(normalizeScanPath('C:\\tmp\\выбранный.dat'))
  assert.equal(isAllowedStockTarget('C:\\tmp\\выбранный.dat', registry), true)
})

test('путь не из реестра остаётся отклонённым даже при похожем имени', () => {
  const registry = new Set<string>()
  registry.add(normalizeScanPath('C:\\tmp\\остатки.xlsx'))
  assert.equal(isAllowedStockTarget('C:\\tmp\\остатки2.xlsx.bak', registry), false)
})
