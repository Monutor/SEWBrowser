import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exportableTabs, folderSectionState } from './folder-access-core.ts'

describe('folderSectionState', () => {
  // Регрессия: оверлей рисовал вкладки защищённой папки и по ним можно было
  // перейти без пароля. Пока пароль не введён — секция обязана быть закрытой.
  it('защищённая папка закрыта, пока пароль не введён', () => {
    assert.deepEqual(folderSectionState({ hasPassword: true, revealed: false, collapsed: false }), {
      locked: true,
      expanded: false,
    })
  })

  it('состояние свёртки не раскрывает защищённую папку', () => {
    assert.deepEqual(folderSectionState({ hasPassword: true, revealed: false, collapsed: false }).expanded, false)
    // Свёрнута и не свёрнута — результат один, покажется одинаково.
    assert.deepEqual(
      folderSectionState({ hasPassword: true, revealed: false, collapsed: true }),
      folderSectionState({ hasPassword: true, revealed: false, collapsed: false }),
    )
  })

  it('защищённая папка раскрыта после ввода пароля', () => {
    assert.deepEqual(folderSectionState({ hasPassword: true, revealed: true, collapsed: false }), {
      locked: false,
      expanded: true,
    })
  })

  it('незащищённая папка раскрыта, пока не свёрнута', () => {
    assert.deepEqual(folderSectionState({ hasPassword: false, revealed: false, collapsed: false }), {
      locked: false,
      expanded: true,
    })
  })

  it('незащищённая свёрнутая папка остаётся не заблокированной', () => {
    assert.deepEqual(folderSectionState({ hasPassword: false, revealed: false, collapsed: true }), {
      locked: false,
      expanded: false,
    })
  })
})

describe('exportableTabs', () => {
  const folders: NavFolder[] = [
    { id: 'f1', name: 'Открытая' },
    { id: 'f2', name: 'Закрытая', passwordId: 'p2' },
  ]
  const tabs: NavTab[] = [
    { id: 't1', name: 'Видна', url: 'https://a/1', folderId: 'f1' },
    { id: 't2', name: 'Секрет', url: 'https://a/2', folderId: 'f2' },
    { id: 't3', name: 'Без папки', url: 'https://a/3' },
  ]

  // Регрессия: экспорт .json выгружал содержимое защищённых папок, то есть пароль
  // обходился файлом — ссылку можно было открыть, не зная пароля.
  it('защищённая папка и её вкладки не попадают в экспорт', () => {
    const out = exportableTabs({ folders, tabs })
    assert.deepEqual(
      out.folders.map((f) => f.id),
      ['f1'],
    )
    assert.deepEqual(
      out.tabs.map((t) => t.id),
      ['t1', 't3'],
    )
  })

  it('вкладки без папки остаются в экспорте', () => {
    const out = exportableTabs({ folders, tabs: [{ id: 't4', name: 'Свободная', url: 'https://a/4' }] })
    assert.deepEqual(
      out.tabs.map((t) => t.id),
      ['t4'],
    )
  })

  it('пустая защищённая папка тоже исключается', () => {
    const out = exportableTabs({
      folders: [...folders, { id: 'f3', name: 'Пустая закрытая', passwordId: 'p3' }],
      tabs,
    })
    assert.deepEqual(
      out.folders.map((f) => f.id),
      ['f1'],
    )
  })

  it('без защищённых папок экспорт не меняется', () => {
    const out = exportableTabs({ folders: [folders[0]], tabs })
    assert.deepEqual(
      out.tabs.map((t) => t.id),
      ['t1', 't2', 't3'],
    )
  })
})
