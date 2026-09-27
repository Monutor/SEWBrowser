import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTabFile, TABS_FILE_FORMAT, TABS_FILE_VERSION } from './tabs-file.ts'

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: TABS_FILE_FORMAT, version: TABS_FILE_VERSION, ...over })
}

/** Детерминированные генераторы id — иначе тесты зависят от crypto.randomUUID. */
let seq = 0
const opts = {
  generateTabId: () => `tab${++seq}`,
  generateFolderId: () => `fld${++seq}`,
}

test('отказ: невалидный JSON', () => {
  assert.deepEqual(parseTabFile('{не json', opts), { ok: false, error: 'json' })
  assert.deepEqual(parseTabFile('', opts), { ok: false, error: 'json' })
  assert.deepEqual(parseTabFile('null', opts), { ok: false, error: 'format' })
})

test('отказ: чужой формат', () => {
  assert.deepEqual(parseTabFile(JSON.stringify({ format: 'other', tabs: [] }), opts), {
    ok: false,
    error: 'format',
  })
  assert.deepEqual(parseTabFile(payload({ tabs: 'не массив' })), { ok: false, error: 'format' })
  assert.deepEqual(parseTabFile(payload({ tabs: null })), { ok: false, error: 'format' })
})

test('отказ: нет валидных вкладок', () => {
  assert.deepEqual(parseTabFile(payload({ tabs: [] }), opts), { ok: false, error: 'empty' })
  assert.deepEqual(
    parseTabFile(payload({ tabs: [null, 42, { name: '  ', url: 'https://a' }, { name: 'x' }, { url: 'https://a' }] }), opts),
    { ok: false, error: 'empty' },
  )
})

test('импорт вкладок: id пересоздаются, url нормализуется, folderId сохраняется', () => {
  seq = 0
  const res = parseTabFile(
    payload({
      folders: [{ id: 'f1', name: 'Проверка' }],
      tabs: [
        { id: 'old1', name: '  Заказ 1  ', url: 'sew.mvideoeldorado.ru/v2/orders/1' },
        { id: 'old2', name: 'Заказ 2', url: 'https://sew.mvideoeldorado.ru/v2/orders/2', folderId: 'f1' },
        { id: 'old3', name: 'Без папки', url: 'https://sew.mvideoeldorado.ru/v2/x', folderId: 7 },
      ],
    }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.tabs.length, 3)
  assert.equal(res.tabs[0].id, 'tab1')
  assert.equal(res.tabs[0].name, 'Заказ 1')
  assert.equal(res.tabs[0].url, 'https://sew.mvideoeldorado.ru/v2/orders/1')
  assert.equal(res.tabs[0].folderId, undefined)
  assert.equal(res.tabs[1].folderId, 'f1')
  // Нестроковый folderId игнорируется — поле не добавляется.
  assert.ok(!('folderId' in res.tabs[2]))
})

test('импорт папок: обычный случай без коллизий', () => {
  seq = 0
  const res = parseTabFile(
    payload({ folders: [{ id: 'f1', name: 'Проверка' }, { id: 'f2', name: 'Отгрузка' }], tabs: [{ name: 'a', url: 'https://a.b' }] }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.folders, [
    { id: 'f1', name: 'Проверка' },
    { id: 'f2', name: 'Отгрузка' },
  ])
})

test('коллизия id папки с текущей структурой: новый id + ремаппинг вкладок', () => {
  seq = 0
  const res = parseTabFile(
    payload({ folders: [{ id: 'f1', name: 'Проверка' }], tabs: [{ name: 'a', url: 'https://a.b', folderId: 'f1' }] }),
    { ...opts, existingFolderIds: ['f1'] },
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.folders.length, 1)
  assert.notEqual(res.folders[0].id, 'f1')
  assert.equal(res.tabs[0].folderId, res.folders[0].id)
})

test('дубль id внутри файла: второй получает новый id без ремаппинга', () => {
  seq = 0
  const res = parseTabFile(
    payload({
      folders: [
        { id: 'f1', name: 'Первая' },
        { id: 'f1', name: 'Вторая' },
      ],
      tabs: [{ name: 'a', url: 'https://a.b', folderId: 'f1' }],
    }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.folders.length, 2)
  assert.equal(res.folders[0].id, 'f1')
  assert.notEqual(res.folders[1].id, 'f1')
  // Вкладка осталась у первой папки — ремаппинга не было.
  assert.equal(res.tabs[0].folderId, 'f1')
})

test('папки без имени или id отбрасываются', () => {
  seq = 0
  const res = parseTabFile(
    payload({ folders: [{ id: 'f1', name: '  ' }, { id: '', name: 'Пусто' }, { name: 'Без id' }], tabs: [{ name: 'a', url: 'https://a.b' }] }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.folders, [])
})

test('висячая ссылка на несуществующую папку обнуляется', () => {
  seq = 0
  const res = parseTabFile(
    payload({ folders: [{ id: 'f1', name: 'Проверка' }], tabs: [{ name: 'a', url: 'https://a.b', folderId: 'нет-такой' }] }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.tabs[0].folderId, undefined)
})

test('старый файл v1 без папок импортируется как «без папки»', () => {
  seq = 0
  const res = parseTabFile(
    JSON.stringify({ format: TABS_FILE_FORMAT, version: 1, tabs: [{ name: 'a', url: 'https://a.b', folderId: 'f1' }] }),
    opts,
  )
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.folders, [])
  assert.equal(res.tabs[0].folderId, undefined)
})
