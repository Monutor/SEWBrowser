import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createShotPreview, type ShotPreviewShot } from './shot-preview.ts'

// Мини-дубль DOM: контроллер не ходит в document/window — элементы передаются
// явно, поэтому достаточно этих четырёх полей.
interface FakeEl {
  hidden: boolean
  src: string
  textContent: string
  onclick: ((event?: unknown) => void) | null
}

function mkEl(): FakeEl {
  return { hidden: true, src: '', textContent: '', onclick: null }
}

interface Harness {
  c: ReturnType<typeof createShotPreview>
  el: { overlay: FakeEl; image: FakeEl; caption: FakeEl; save: FakeEl; copy: FakeEl; close: FakeEl }
  saved: ShotPreviewShot[]
  copied: ShotPreviewShot[]
  shutterClicks: number
}

function setup(): Harness {
  const el = { overlay: mkEl(), image: mkEl(), caption: mkEl(), save: mkEl(), copy: mkEl(), close: mkEl() }
  const saved: ShotPreviewShot[] = []
  const copied: ShotPreviewShot[] = []
  const h = { saved, copied, shutterClicks: 0 } as Harness
  h.c = createShotPreview(el as never, {
    onSave: (s) => { h.saved.push(s) },
    onCopy: (s) => { h.copied.push(s) },
    onOpen: () => { h.shutterClicks += 1 },
  })
  h.el = el
  return h
}

const shot = (over: Partial<ShotPreviewShot> = {}): ShotPreviewShot => ({
  dataUrl: 'data:image/png;base64,AAAA',
  name: 'screenshot-2026-09-27-12-00-00.png',
  guestId: 7,
  ...over,
})

describe('shot-preview', () => {
  it('open кладёт картинку и подпись и показывает оверлей', () => {
    const h = setup()
    assert.equal(h.c.open(shot()), true)
    assert.equal(h.el.overlay.hidden, false)
    assert.equal(h.el.image.src, 'data:image/png;base64,AAAA')
    assert.equal(h.el.caption.textContent, 'screenshot-2026-09-27-12-00-00.png')
    assert.equal(h.c.isOpen(), true)
  })

  it('open отказывает на пустой картинке и не показывает оверлей', () => {
    const h = setup()
    assert.equal(h.c.open(shot({ dataUrl: '' })), false)
    assert.equal(h.el.overlay.hidden, true)
    assert.equal(h.c.isOpen(), false)
  })

  it('кнопки зовут хуки с текущим снимком', () => {
    const h = setup()
    h.c.open(shot({ guestId: 21 }))
    h.el.save.onclick?.()
    h.el.copy.onclick?.()
    assert.equal(h.saved.length, 1)
    assert.equal(h.copied.length, 1)
    assert.equal(h.saved[0].guestId, 21)
    assert.equal(h.copied[0].guestId, 21)
  })

  it('после close кнопки не срабатывают (обработчики сняты)', () => {
    const h = setup()
    h.c.open(shot())
    h.c.close()
    h.el.save.onclick?.()
    assert.equal(h.saved.length, 0)
    assert.equal(h.c.isOpen(), false)
  })

  it('клик по затемнению закрывает, клик по панели — нет, крестик закрывает', () => {
    const h = setup()
    h.c.open(shot())
    h.el.overlay.onclick?.({ target: h.el.overlay })
    assert.equal(h.c.isOpen(), false)

    h.c.open(shot())
    h.el.overlay.onclick?.({ target: { tag: 'panel' } })
    assert.equal(h.c.isOpen(), true)

    h.el.close.onclick?.()
    assert.equal(h.c.isOpen(), false)
  })

  it('close чистит src картинки и прячет оверлей', () => {
    const h = setup()
    h.c.open(shot())
    h.c.close()
    assert.equal(h.el.overlay.hidden, true)
    assert.equal(h.el.image.src, '')
  })

  it('onOpen зовётся при каждом показе (щелчок затвора)', () => {
    const h = setup()
    h.c.open(shot())
    h.c.open(shot())
    assert.equal(h.shutterClicks, 2)
  })

  it('повторный open заменяет снимок, а не добавляет', () => {
    const h = setup()
    h.c.open(shot({ name: 'первый.png' }))
    h.c.open(shot({ name: 'второй.png' }))
    assert.equal(h.el.caption.textContent, 'второй.png')
    assert.equal(h.c.current()?.name, 'второй.png')
  })
})
