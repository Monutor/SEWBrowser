import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAllowedScanTarget,
  isPickedScanId,
  isWithinFolder,
  isWithinScanFolders,
  normalizeScanPath,
  pickedScanPath,
} from './scans-core.ts'

const WIN = process.platform === 'win32'
const ROOT = WIN ? 'C:\\Scans' : '/opt/scans'

test('файл прямо в папке сканов разрешён', () => {
  assert.equal(isWithinFolder(`${ROOT}\\scan.pdf`, ROOT), true)
  assert.equal(isWithinFolder(`${ROOT}/scan.pdf`, ROOT), true)
})

test('файл во вложенной подпапке разрешён', () => {
  assert.equal(isWithinFolder(`${ROOT}\\sub\\dir\\scan.pdf`, ROOT), true)
  assert.equal(isWithinFolder(`${ROOT}/sub/dir/scan.pdf`, ROOT), true)
})

test('соседняя папка с тем же префиксом НЕ разрешена', () => {
  // Граница компонента: 'C:\ScansOld\x.pdf' не лежит внутри 'C:\Scans'.
  assert.equal(isWithinFolder(`${ROOT}Old\\x.pdf`, ROOT), false)
})

test('обход через .. выходит наружу и отклоняется', () => {
  assert.equal(isWithinFolder(`${ROOT}\\..\\..\\secret.txt`, ROOT), false)
  assert.equal(isWithinFolder(`${ROOT}/../../secret.txt`, ROOT), false)
})

test('папка-корень сама по себе не является файлом', () => {
  assert.equal(isWithinFolder(ROOT, ROOT), false)
})

test('пустые аргументы отклоняются, а не бросают', () => {
  assert.equal(isWithinFolder('', ROOT), false)
  assert.equal(isWithinFolder(`${ROOT}\\x.pdf`, ''), false)
})

test('регистр сравнивается только на case-insensitive ФС', () => {
  const upper = ROOT.toUpperCase()
  assert.equal(isWithinFolder(`${upper}\\scan.pdf`, ROOT), WIN)
})

test('isWithinScanFolders: попадание в любую из папок', () => {
  const folders = [{ id: 'a', path: `${ROOT}\\one` }, { id: 'b', path: `${ROOT}\\two` }]
  assert.equal(isWithinScanFolders(`${ROOT}\\two\\x.pdf`, folders), true)
  assert.equal(isWithinScanFolders(`${ROOT}\\three\\x.pdf`, folders), false)
})

test('isWithinScanFolders: мусор во входных данных не роняет', () => {
  assert.equal(isWithinScanFolders(`${ROOT}\\x.pdf`, []), false)
  assert.equal(isWithinScanFolders(`${ROOT}\\x.pdf`, null), false)
  assert.equal(isWithinScanFolders(`${ROOT}\\x.pdf`, undefined), false)
  assert.equal(isWithinScanFolders(`${ROOT}\\x.pdf`, [null as never, { id: 'a', path: ROOT }]), true)
})

test('префикс picked:: распознаётся и отделяется от пути', () => {
  assert.equal(isPickedScanId('picked::D:\\docs\\a.pdf'), true)
  assert.equal(isPickedScanId('D:\\docs\\a.pdf'), false)
  assert.equal(pickedScanPath('picked::D:\\docs\\a.pdf'), 'D:\\docs\\a.pdf')
  assert.equal(pickedScanPath('D:\\docs\\a.pdf'), 'D:\\docs\\a.pdf')
})

test('путь из папки сканов разрешён для всех файловых операций', () => {
  const picked = new Set<string>()
  assert.equal(isAllowedScanTarget(`${ROOT}\\a.pdf`, [{ id: 'a', path: ROOT }], picked), true)
})

test('произвольный путь вне папок сканов отклоняется', () => {
  const picked = new Set<string>()
  const folders = [{ id: 'a', path: ROOT }]
  // Именно этот вектор был Critical: гость шлёт путь к чему угодно.
  assert.equal(isAllowedScanTarget('C:\\Users\\me\\.ssh\\id_rsa', folders, picked), false)
  assert.equal(isAllowedScanTarget('C:\\Windows\\System32\\config\\SAM', folders, picked), false)
  assert.equal(isAllowedScanTarget('', folders, picked), false)
})

test('picked:: пропускается только если файл реально выбирал пользователь', () => {
  const picked = new Set<string>([normalizeScanPath('D:\\docs\\picked.pdf')])
  assert.equal(isAllowedScanTarget('picked::D:\\docs\\picked.pdf', [], picked), true)
  // Тот же префикс, но файл через диалог не выбирали — подделка гостя.
  assert.equal(isAllowedScanTarget('picked::D:\\docs\\secret.pdf', [], picked), false)
  assert.equal(isAllowedScanTarget('picked::C:\\Users\\me\\.ssh\\id_rsa', [], picked), false)
})

test('picked:: работает и при пустом списке папок', () => {
  const picked = new Set<string>([normalizeScanPath('D:\\docs\\picked.pdf')])
  assert.equal(isAllowedScanTarget('picked::D:\\docs\\picked.pdf', null, picked), true)
})

test('непустой picked:id без суффикса-пути отклоняется', () => {
  assert.equal(isAllowedScanTarget('picked::', [], new Set<string>()), false)
})

test('normalizeScanPath даёт стабильный ключ для реестра picked', () => {
  assert.equal(
    normalizeScanPath('D:\\docs\\a.pdf'),
    normalizeScanPath('D:\\docs\\.\\a.pdf'),
  )
})