import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

interface FakeEl {
  tag: string
  className: string
  textContent: string
  title: string
  type: string
  attrs: Record<string, string>
  children: FakeEl[]
  parent: FakeEl | null
  removed: boolean
  listeners: Array<{ type: string; fn: (event: unknown) => void }>
  append(...nodes: FakeEl[]): void
  appendChild(node: FakeEl): FakeEl
  replaceChildren(...nodes: FakeEl[]): void
  remove(): void
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: (event: unknown) => void): void
}

function mkEl(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    className: '',
    textContent: '',
    title: '',
    type: '',
    attrs: {},
    children: [],
    parent: null,
    removed: false,
    listeners: [],
    append(...nodes: FakeEl[]): void {
      for (const node of nodes) {
        node.parent = el
        el.children.push(node)
      }
    },
    appendChild(node: FakeEl): FakeEl {
      el.append(node)
      return node
    },
    replaceChildren(...nodes: FakeEl[]): void {
      for (const child of el.children) child.parent = null
      el.children = []
      el.append(...nodes)
    },
    remove(): void {
      el.removed = true
      if (el.parent) el.parent.children = el.parent.children.filter((child) => child !== el)
      el.parent = null
    },
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value
    },
    removeAttribute(name: string): void {
      delete el.attrs[name]
    },
    getAttribute(name: string): string | null {
      return name in el.attrs ? el.attrs[name] : null
    },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      el.listeners.push({ type, fn })
    },
  }
  return el
}

function fire(el: FakeEl, type: string, event: unknown = { preventDefault(): void {} }): void {
  for (const listener of el.listeners) {
    if (listener.type === type) listener.fn(event)
  }
}

// Подмена document до импорта tabs.ts: модуль дёргает document только внутри функций
const fakeDocument = {
  createElement: (tag: string): FakeEl => mkEl(tag),
}
;(globalThis as unknown as { document: unknown }).document = fakeDocument

const tabsModule = await import('./tabs.ts')

interface Harness {
  container: FakeEl
  strip: FakeEl
  newTab: FakeEl
  wired: number[]
  activated: number[]
  closed: number[]
  popupItems: Array<{ label: string; action: string }>
  /** Зарегистрированные обработчики onMenuAction — тест шлёт в них action вручную */
  menuActions: Array<(action: string) => void>
}

function setup(startUrl = 'https://sew.mvideoeldorado.ru/v2/'): Harness {
  const container = mkEl('div')
  const strip = mkEl('div')
  const newTab = mkEl('button')
  const h: Harness = { container, strip, newTab, wired: [], activated: [], closed: [], popupItems: [], menuActions: [] }
  ;(globalThis as unknown as { window: unknown }).window = {
    shell: {
      popupMenu: (items: Array<{ label: string; action: string }>): Promise<boolean> => {
        h.popupItems = items
        return Promise.resolve(true)
      },
      onMenuAction: (cb: (action: string) => void): void => {
        h.menuActions.push(cb)
      },
    },
  }
  tabsModule.initTabs({
    container: container as unknown as HTMLElement,
    strip: strip as unknown as HTMLElement,
    newTabButton: newTab as unknown as HTMLButtonElement,
    startUrl,
    hooks: {
      wire: (tab) => h.wired.push(tab.id),
      onActivated: (tab) => h.activated.push(tab.id),
      onClosed: (tab) => h.closed.push(tab.id),
    },
  })
  return h
}

describe('openTab', () => {
  it('создаёт webview, вешает хуки и грузит URL через атрибут src', () => {
    const h = setup()
    const tab = tabsModule.openTab('sew.mvideoeldorado.ru/v2/relocation/tasks')
    assert.ok(tab)
    assert.equal(h.container.children.length, 1)
    assert.equal(tab.view.getAttribute('src'), 'https://sew.mvideoeldorado.ru/v2/relocation/tasks')
    assert.equal(tab.view.getAttribute('allowpopups'), '')
    assert.deepEqual(h.wired, [tab.id])
    assert.deepEqual(h.activated, [tab.id])
    assert.equal(tab.isPrimary, true)
  })

  it('не создаёт вкладку для пустого и не-http URL', () => {
    const h = setup()
    assert.equal(tabsModule.openTab('   '), null)
    assert.equal(tabsModule.openTab('javascript:void(0)'), null)
    assert.equal(h.container.children.length, 0)
  })

  it('первая вкладка — primary, вторая нет; неактивная скрыта', () => {
    const h = setup()
    const first = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/')
    const second = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/handover-v2/tasks')
    assert.ok(first && second)
    assert.equal(first.isPrimary, true)
    assert.equal(second.isPrimary, false)
    assert.equal(first.view.getAttribute('data-hidden'), '')
    assert.equal(second.view.getAttribute('data-hidden'), null)
    assert.equal(tabsModule.primaryView() === first.view, true)
  })

  it('при activate:false вкладка создаётся скрытой и не активируется', () => {
    const h = setup()
    const first = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/')
    const second = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/handover-v2/tasks', { activate: false })
    assert.ok(first && second)
    assert.equal(tabsModule.isActiveTab(first), true)
    assert.equal(second.view.getAttribute('data-hidden'), '')
    assert.deepEqual(h.activated, [first.id])
  })
})

describe('activateTab', () => {
  it('переключает data-hidden и сообщает хуку', () => {
    const h = setup()
    const first = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/')
    const second = tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/handover-v2/tasks')
    assert.ok(first && second)
    tabsModule.activateTab(first)
    assert.equal(second.view.getAttribute('data-hidden'), '')
    assert.equal(first.view.getAttribute('data-hidden'), null)
    // Оба openTab уже сообщили хуку об активации — здесь ещё и явный activateTab
    assert.deepEqual(h.activated, [first.id, second.id, first.id])
  })
})

describe('cycleTab и selectTabIndex', () => {
  it('cycleTab ходит по кругу', () => {
    setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b && c)
    tabsModule.cycleTab(1)
    assert.equal(tabsModule.isActiveTab(a), true)
    tabsModule.cycleTab(-1)
    assert.equal(tabsModule.isActiveTab(c), true)
  })

  it('selectTabIndex игнорирует номера вне списка', () => {
    setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a)
    // Активна вторая вкладка (её открыли последней) — возвращаем первую
    tabsModule.activateTab(a)
    tabsModule.selectTabIndex(9)
    assert.equal(tabsModule.isActiveTab(a), true)
    tabsModule.selectTabIndex(2)
    assert.equal(tabsModule.isActiveTab(a), false)
  })
})

describe('closeTab', () => {
  it('удаляет webview из контейнера и чинит активную вкладку', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b && c)
    tabsModule.closeTab(b.id)
    // removed есть только у FakeEl — на реальном <webview> элемент просто отвязан от DOM
    assert.equal((b.view as unknown as FakeEl).removed, true)
    assert.equal(tabsModule.listTabs().length, 2)
    assert.deepEqual(h.closed, [b.id])
    assert.equal(tabsModule.isActiveTab(c), true)
  })

  it('при закрытии последней вкладки открывает новую на стартовой странице', () => {
    const h = setup('https://sew.mvideoeldorado.ru/v2/')
    const only = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    assert.ok(only)
    tabsModule.closeTab(only.id)
    assert.equal(tabsModule.listTabs().length, 1)
    const fresh = tabsModule.listTabs()[0]
    assert.equal(fresh.view.getAttribute('src'), 'https://sew.mvideoeldorado.ru/v2/')
    assert.equal(tabsModule.isActiveTab(fresh), true)
    assert.equal(h.container.children.length, 1)
  })

  it('пересчитывает isPrimary первой вкладки после её закрытия', () => {
    setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a && b)
    assert.equal(a.isPrimary, true)
    assert.equal(b.isPrimary, false)
    tabsModule.closeTab(a.id)
    // Новой головой списка стала b — она и должна быть единственным опросным хостом
    assert.equal(b.isPrimary, true)
    assert.equal(tabsModule.primaryView() === b.view, true)
  })
})

describe('focusOrOpenTab', () => {
  it('переиспользует уже открытую вкладку с тем же URL', () => {
    setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a && b)
    tabsModule.focusOrOpenTab('https://a.mvideoeldorado.ru/')
    assert.equal(tabsModule.listTabs().length, 2)
    assert.equal(tabsModule.isActiveTab(a), true)
  })

  it('открывает новую вкладку для незнакомого URL', () => {
    setup()
    tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.focusOrOpenTab('https://c.mvideoeldorado.ru/')
    assert.equal(tabsModule.listTabs().length, 2)
  })
})

describe('setTabUrl и setTabTitle', () => {
  it('обновляет модель и подпись кнопки', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    assert.ok(a)
    tabsModule.setTabUrl(a, 'https://a.mvideoeldorado.ru/v2/relocation/tasks')
    tabsModule.setTabTitle(a, 'Задания на перемещение')
    assert.equal(a.url, 'https://a.mvideoeldorado.ru/v2/relocation/tasks')
    assert.equal(a.title, 'Задания на перемещение')
    const button = h.strip.children[0]
    assert.equal(button.children[0].textContent, 'Задания на перемещение')
  })

  it('подпись без заголовка страницы равна хосту', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/v2/')
    assert.ok(a)
    tabsModule.setTabTitle(a, '   ')
    assert.equal(a.title, 'a.mvideoeldorado.ru')
    assert.equal(h.strip.children[0].children[0].textContent, 'a.mvideoeldorado.ru')
  })
})

describe('полоса вкладок', () => {
  it('рисует по кнопке на вкладку, активная помечена, у кнопки есть крестик', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a)
    assert.equal(h.strip.children.length, 2)
    assert.ok(h.strip.children[1].className.includes('active'))
    assert.equal(h.strip.children[1].children[1].className, 'tab-btn-close')
  })

  it('клик по кнопке активирует вкладку', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a)
    fire(h.strip.children[0], 'click')
    assert.equal(tabsModule.isActiveTab(a), true)
  })

  it('крестик закрывает вкладку и не активирует её', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a)
    const stop = { stopPropagation(): void {} }
    fire(h.strip.children[0].children[1], 'click', stop)
    assert.equal(tabsModule.listTabs().length, 1)
    assert.equal(tabsModule.isActiveTab(a), false)
  })

  it('кнопка «+» открывает новую вкладку на стартовой странице', () => {
    const h = setup('https://sew.mvideoeldorado.ru/v2/')
    tabsModule.openTab('https://a.mvideoeldorado.ru/')
    fire(h.newTab, 'click')
    assert.equal(tabsModule.listTabs().length, 2)
    assert.equal(tabsModule.activeTab()?.url, 'https://sew.mvideoeldorado.ru/v2/')
  })

  it('ПКМ по вкладке предлагает закрыть / закрыть другие / закрыть справа', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    tabsModule.openTab('https://b.mvideoeldorado.ru/')
    tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a)
    fire(h.strip.children[0], 'contextmenu', { preventDefault(): void {}, clientX: 10, clientY: 20 })
    assert.deepEqual(
      h.popupItems.map((item) => item.action),
      ['close', 'close-others', 'close-right'],
    )
  })

  it('меню закрывает вкладку, остальные и справа', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b)
    fire(h.strip.children[1], 'contextmenu', { preventDefault(): void {}, clientX: 0, clientY: 0 })
    // Один зарегистрированный обработчик — шлём в него все три action подряд
    h.menuActions[0]('close-others')
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [b.id])
    h.menuActions[0]('close-right')
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [b.id])
    h.menuActions[0]('close')
    assert.equal(tabsModule.listTabs().length, 1)
    assert.equal(tabsModule.listTabs()[0].url, 'https://sew.mvideoeldorado.ru/v2/')
  })

  it('меню close-right закрывает всё справа от неактивной вкладки, слева выживают', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    const d = tabsModule.openTab('https://d.mvideoeldorado.ru/')
    assert.ok(a && b && c && d)
    // Активна d (открыта последней), а меню открываем ПКМ по b
    fire(h.strip.children[1], 'contextmenu', { preventDefault(): void {}, clientX: 0, clientY: 0 })
    h.menuActions[0]('close-right')
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a.id, b.id])
    assert.deepEqual(h.closed, [c.id, d.id])
    // Активной была d (закрыта) — ремонтируем на правого соседа
    assert.equal(tabsModule.isActiveTab(b), true)
  })
})
