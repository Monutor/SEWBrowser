import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Мини-дом: своего jsdom в проекте нет, поэтому элементы адресного меню
// моделируются так же, как в tabs.test.ts.
interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  hidden: boolean
  attrs: Record<string, string>
  children: FakeEl[]
  parent: FakeEl | null
  listeners: Array<{ type: string; fn: (event: unknown) => void }>
  rect: { right: number; bottom: number }
  appendChild(node: FakeEl): FakeEl
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: (event: unknown) => void): void
  contains(node: FakeEl | null): boolean
  getBoundingClientRect(): { right: number; bottom: number }
}

function mkEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    attrs: {},
    children: [],
    parent: null,
    listeners: [],
    rect: { right: 1000, bottom: 126 },
    appendChild(node: FakeEl): FakeEl {
      node.parent = el
      el.children.push(node)
      return node
    },
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value
    },
    getAttribute(name: string): string | null {
      return name in el.attrs ? el.attrs[name] : null
    },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      el.listeners.push({ type, fn })
    },
    contains(node: FakeEl | null): boolean {
      if (!node) return false
      if (node === el) return true
      return el.children.some((child) => child.contains(node))
    },
    getBoundingClientRect(): { right: number; bottom: number } {
      return el.rect
    },
  }
  return el
}

function fire(el: FakeEl, type: string, event: unknown = { target: null }): void {
  for (const listener of el.listeners) {
    if (listener.type === type) listener.fn(event)
  }
}

const docListeners: Array<{ type: string; fn: (event: unknown) => void }> = []
const fakeDocument = {
  addEventListener(type: string, fn: (event: unknown) => void): void {
    docListeners.push({ type, fn })
  },
}
function fireDocument(type: string, event: unknown = { target: null }): void {
  for (const listener of docListeners) {
    if (listener.type === type) listener.fn(event)
  }
}

;(globalThis as unknown as { document: unknown }).document = fakeDocument
;(globalThis as unknown as { window: unknown }).window = { innerWidth: 1200 }

const addressMenu = await import('./address-menu.ts')

interface Harness {
  button: FakeEl
  popup: FakeEl
  zoomOut: FakeEl
  zoomValue: FakeEl
  zoomIn: FakeEl
  find: FakeEl
  copy: FakeEl
  print: FakeEl
  input: FakeEl
  zoomCalls: string[]
  actions: string[]
  menu: ReturnType<typeof addressMenu.createAddressMenu>
}

function setup(): Harness {
  docListeners.length = 0
  const h: Harness = {
    button: mkEl('button'),
    popup: mkEl('div'),
    zoomOut: mkEl('button'),
    zoomValue: mkEl('span'),
    zoomIn: mkEl('button'),
    find: mkEl('button'),
    copy: mkEl('button'),
    print: mkEl('button'),
    input: mkEl('input'),
    zoomCalls: [],
    actions: [],
    menu: null as unknown as ReturnType<typeof addressMenu.createAddressMenu>,
  }
  h.popup.hidden = true
  h.popup.appendChild(h.zoomOut)
  h.popup.appendChild(h.zoomValue)
  h.popup.appendChild(h.zoomIn)
  h.popup.appendChild(h.find)
  h.popup.appendChild(h.copy)
  h.popup.appendChild(h.print)
  h.menu = addressMenu.createAddressMenu(
    {
      button: h.button as unknown as HTMLElement,
      popup: h.popup as unknown as HTMLElement,
      zoomOut: h.zoomOut as unknown as HTMLElement,
      zoomValue: h.zoomValue as unknown as HTMLElement,
      zoomIn: h.zoomIn as unknown as HTMLElement,
      find: h.find as unknown as HTMLElement,
      copy: h.copy as unknown as HTMLElement,
      print: h.print as unknown as HTMLElement,
      input: h.input as unknown as HTMLElement,
    },
    {
      onZoom: (dir) => h.zoomCalls.push(String(dir)),
      onFind: () => h.actions.push('find'),
      onCopy: () => h.actions.push('copy'),
      onPrint: () => h.actions.push('print'),
    },
  )
  return h
}

describe('zoomPercent', () => {
  it('переводит фактор в проценты', () => {
    assert.equal(addressMenu.zoomPercent(1), '100%')
    assert.equal(addressMenu.zoomPercent(1.25), '125%')
    assert.equal(addressMenu.zoomPercent(0.67), '67%')
  })

  it('на мусоре отдаёт 100%', () => {
    assert.equal(addressMenu.zoomPercent(Number.NaN), '100%')
  })
})

describe('меню адреса', () => {
  it('переключается кнопкой и синхронно ставит aria-expanded', () => {
    const h = setup()
    assert.equal(h.menu.isOpen(), false)
    fire(h.button, 'click')
    assert.equal(h.menu.isOpen(), true)
    assert.equal(h.popup.hidden, false)
    assert.equal(h.button.getAttribute('aria-expanded'), 'true')
    fire(h.button, 'click')
    assert.equal(h.menu.isOpen(), false)
    assert.equal(h.button.getAttribute('aria-expanded'), 'false')
  })

  it('ставит позицию по кнопке при открытии', () => {
    const h = setup()
    h.menu.toggle()
    const style = h.popup.getAttribute('style') ?? ''
    assert.ok(style.includes('top:132px'), `style=${style}`)
    assert.ok(style.includes('left:'), `style=${style}`)
  })

  it('звёт хуки масштаба и закрывается по клику на процент', () => {
    const h = setup()
    fire(h.zoomIn, 'click')
    assert.deepEqual(h.zoomCalls, ['1'])
    h.menu.toggle()
    fire(h.zoomOut, 'click')
    assert.deepEqual(h.zoomCalls, ['1', '-1'])
    h.menu.toggle()
    fire(h.zoomValue, 'click')
    assert.deepEqual(h.zoomCalls, ['1', '-1', 'reset'])
    assert.equal(h.menu.isOpen(), false)
  })

  it('звёт хуки пунктов и закрывается', () => {
    const h = setup()
    h.menu.toggle()
    fire(h.find, 'click')
    assert.deepEqual(h.actions, ['find'])
    assert.equal(h.menu.isOpen(), false)
    h.menu.toggle()
    fire(h.copy, 'click')
    h.menu.toggle()
    fire(h.print, 'click')
    assert.deepEqual(h.actions, ['find', 'copy', 'print'])
  })

  it('закрывается по клику вне и по вводу в адрес, не реагирует на клик внутри', () => {
    const h = setup()
    const outside = mkEl('div')
    h.menu.toggle()
    fireDocument('click', { target: outside })
    assert.equal(h.menu.isOpen(), false)
    h.menu.toggle()
    fireDocument('click', { target: h.copy })
    assert.equal(h.menu.isOpen(), true)
    fire(h.input, 'input')
    assert.equal(h.menu.isOpen(), false)
  })

  it('syncZoom обновляет подпись в процентах', () => {
    const h = setup()
    h.menu.syncZoom(1.25)
    assert.equal(h.zoomValue.textContent, '125%')
  })
})
