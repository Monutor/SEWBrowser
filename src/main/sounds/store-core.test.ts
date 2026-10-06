import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slotFilesToRemove } from './store-core.ts'

describe('slotFilesToRemove', () => {
  it('при сохранении перемещения удаляет старый файл слота и legacy custom.*', () => {
    const files = ['custom-rel.mp3', 'custom-ho.mp3', 'custom.mp3', 'message-sound.mp3']
    assert.deepEqual(slotFilesToRemove(files, 'rel'), ['custom-rel.mp3', 'custom.mp3'])
  })

  it('при сохранении выдачи удаляет старый файл слота, но не трогает перемещение', () => {
    const files = ['custom-ho.wav', 'custom-rel.mp3', 'custom.mp3', 'message-sound.mp3']
    assert.deepEqual(slotFilesToRemove(files, 'ho'), ['custom-ho.wav'])
  })

  it('при смене расширения в слоте выдачи старый файл уходит', () => {
    // Раньше файл слота не затирался: в папке оставалось два custom-ho.*,
    // и findSlotFile мог вернуть не тот.
    const files = ['custom-ho.wav', 'custom-ho.mp3']
    assert.deepEqual(slotFilesToRemove(files, 'ho'), ['custom-ho.wav', 'custom-ho.mp3'])
  })

  it('legacy custom.* относится только к слоту перемещения', () => {
    // Для выдачи legacy-файл не её: он должен остаться звуком ЗНП.
    assert.deepEqual(slotFilesToRemove(['custom.mp3'], 'ho'), [])
    assert.deepEqual(slotFilesToRemove(['custom.mp3'], 'rel'), ['custom.mp3'])
  })

  it('посторонние файлы и похожие имена не трогаются', () => {
    const files = ['message-sound.mp3', 'custom-relations.mp3', 'notes.txt']
    assert.deepEqual(slotFilesToRemove(files, 'rel'), [])
    assert.deepEqual(slotFilesToRemove(files, 'ho'), [])
  })

  it('файл чужого слота не трогается даже с дополнительным суффиксом', () => {
    assert.deepEqual(slotFilesToRemove(['custom-ho.mp3.bak'], 'rel'), [])
    assert.deepEqual(slotFilesToRemove(['custom-rel.mp3.bak'], 'ho'), [])
  })

  it('пустой список даёт пустой результат', () => {
    assert.deepEqual(slotFilesToRemove([], 'rel'), [])
    assert.deepEqual(slotFilesToRemove([], 'ho'), [])
  })
})