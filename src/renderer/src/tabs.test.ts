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

/** Полоса последнего setup() — нужна кейсам перетаскивания, чтобы дотянуться до кнопок. */
let lastStrip: FakeEl | null = null

/** Кнопка вкладки по позиции на полосе (0 — самая левая). */
function tabButton(index: number): FakeEl {
  const button = lastStrip?.children[index]
  assert.ok(button, `нет кнопки вкладки на позиции ${index}`)
  return button
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
  blocked: string[]
  popupItems: Array<{ label: string; action: string }>
  /** Вкладки, у которых перестановка забрала статус опросного хоста */
  demoted: number[]
  /** Зарегистрированные обработчики onMenuAction — тест шлёт в них action вручную */
  menuActions: Array<(action: string) => void>
}

function setup(
  startUrl = 'https://sew.mvideoeldorado.ru/v2/',
  extra: { isAllowed?: (url: string) => boolean } = {},
): Harness {
  const container = mkEl('div')
  const strip = mkEl('div')
  const newTab = mkEl('button')
  const h: Harness = { container, strip, newTab, wired: [], activated: [], closed: [], blocked: [], popupItems: [], demoted: [], menuActions: [] }
  lastStrip = strip
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
    isAllowed: extra.isAllowed,
    onBlocked: (url) => {
      h.blocked.push(url)
    },
    hooks: {
      wire: (tab) => h.wired.push(tab.id),
      onActivated: (tab) => h.activated.push(tab.id),
      onClosed: (tab) => h.closed.push(tab.id),
      onPrimaryChanged: (tab) => h.demoted.push(tab.id),
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

  it('не создаёт вкладку для хоста вне allowlist и сообщает об отказе', () => {
    const h = setup('https://sew.mvideoeldorado.ru/v2/', {
      isAllowed: (url) => url.startsWith('https://sew.mvideoeldorado.ru/'),
    })
    assert.equal(tabsModule.openTab('https://evil.example.com/'), null)
    assert.deepEqual(h.blocked, ['https://evil.example.com/'])
    assert.deepEqual(tabsModule.listTabs(), [])
    assert.equal(h.container.children.length, 0)
    assert.deepEqual(h.wired, [])
    // Разрешённый хост по-прежнему открывается — гард не сломал обычный путь
    assert.ok(tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/relocation/tasks'))
    assert.equal(tabsModule.listTabs().length, 1)
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

describe('primaryTab', () => {
  it('primaryTab() всегда первая вкладка, даже если активна другая', async () => {
    const h = setup()
    tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/')
    tabsModule.openTab('https://sew.mvideoeldorado.ru/v2/relocation/tasks')
    assert.equal(tabsModule.listTabs().length, 2)
    assert.equal(tabsModule.primaryTab()?.isPrimary, true)
    assert.equal(tabsModule.primaryTab()?.url, 'https://sew.mvideoeldorado.ru/v2/')
    assert.equal(tabsModule.primaryView(), tabsModule.primaryTab()?.view)
    assert.notEqual(tabsModule.activeTab()?.id, tabsModule.primaryTab()?.id)
    h.newTab.remove()
  })
})

describe('moveTab', () => {
  it('переставляет вкладку в конец и не меняет активную', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b && c)
    tabsModule.activateTab(c)
    tabsModule.moveTab(a!.id, 2)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [b!.id, c!.id, a!.id])
    assert.equal(tabsModule.activeTab()?.id, c!.id)
    // Полоса перестроилась в новом порядке (подпись без заголовка — хост)
    assert.deepEqual(h.strip.children.map((el) => el.children[1].textContent), ['b.mvideoeldorado.ru', 'c.mvideoeldorado.ru', 'a.mvideoeldorado.ru'])
    assert.deepEqual(h.demoted, [a!.id])
  })

  it('переставляет в начало и двигает статус опросного хоста', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b && c)
    tabsModule.moveTab(c!.id, 0)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [c!.id, a!.id, b!.id])
    assert.equal(c!.isPrimary, true)
    assert.equal(a!.isPrimary, false)
    assert.equal(tabsModule.primaryTab()?.id, c!.id)
    // Прежний хост один раз сообщил, что опрос надо гасить
    assert.deepEqual(h.demoted, [a!.id])
  })

  it('перестановка внутри позиции хозяина не трогает статус хоста', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    assert.ok(a && b && c)
    tabsModule.moveTab(b!.id, 2)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a!.id, c!.id, b!.id])
    assert.equal(a!.isPrimary, true)
    assert.deepEqual(h.demoted, [])
  })

  it('перенос в ту же позицию и несуществующую вкладку игнорирует, индексы за границами зажимает', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    assert.ok(a && b)
    // Та же позиция — ничего не делаем
    tabsModule.moveTab(a!.id, 0)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a!.id, b!.id])
    // Несуществующая вкладка — ничего не делаем
    tabsModule.moveTab(4242, 0)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a!.id, b!.id])
    // Индексы за границами зажимаются: 99 — это конец, -5 — это начало
    tabsModule.moveTab(a!.id, 99)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [b!.id, a!.id])
    tabsModule.moveTab(a!.id, -5)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a!.id, b!.id])
    // Первая вкладка вернулась на первое место и снова стала хостом
    assert.equal(a!.isPrimary, true)
    assert.equal(tabsModule.primaryTab()?.id, a!.id)
  })

  it('броск вправо ставит вкладку после цели, влево — перед ней', () => {
    setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    const b = tabsModule.openTab('https://b.mvideoeldorado.ru/')
    const c = tabsModule.openTab('https://c.mvideoeldorado.ru/')
    const d = tabsModule.openTab('https://d.mvideoeldorado.ru/')
    assert.ok(a && b && c && d)
    // Тянем первую вкладку на третью: вправо — встаём после неё
    fire(tabButton(0), 'dragstart')
    fire(tabButton(2), 'dragover')
    assert.ok(tabButton(2).className.includes('drop-after'))
    fire(tabButton(2), 'drop')
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [b!.id, c!.id, d!.id, a!.id])
    // Тянем последнюю на первую: влево — встаём перед ней
    fire(tabButton(3), 'dragstart')
    fire(tabButton(0), 'dragover')
    assert.ok(tabButton(0).className.includes('drop-before'))
    fire(tabButton(0), 'drop')
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [a!.id, b!.id, c!.id, d!.id])
    // Маркер снят, перетаскиваемая вкладка не осталась призрачной
    assert.equal(tabButton(0).className.includes('drop-'), false)
    assert.equal(tabButton(0).className.includes('dragging'), false)
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
    assert.equal(button.children[1].textContent, 'Задания на перемещение')
  })

  it('подпись без заголовка страницы равна хосту', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/v2/')
    assert.ok(a)
    tabsModule.setTabTitle(a, '   ')
    assert.equal(a.title, 'a.mvideoeldorado.ru')
    assert.equal(h.strip.children[0].children[1].textContent, 'a.mvideoeldorado.ru')
  })

  it('фавиконка — буква хоста с цветом, меняется вместе с адресом', () => {
    const h = setup()
    const a = tabsModule.openTab('https://a.mvideoeldorado.ru/')
    assert.ok(a)
    const fav = h.strip.children[0].children[0]
    assert.equal(fav.className, 'tab-btn-fav')
    assert.equal(fav.textContent, 'A')
    const first = fav.getAttribute('style')
    assert.ok(first && first.includes('hsl('))
    tabsModule.setTabUrl(a, 'https://b.mvideoeldorado.ru/v2/')
    const moved = h.strip.children[0].children[0]
    assert.equal(moved.textContent, 'B')
    assert.notEqual(moved.getAttribute('style'), first)
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
    assert.equal(h.strip.children[1].children[2].className, 'tab-btn-close')
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
    fire(h.strip.children[0].children[2], 'click', stop)
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

describe('split view', () => {
  it('разделение при двух вкладках: левая опрашивает, порядок массива = порядок панелей', () => {
    const h = setup()
    const first = tabsModule.openTab('https://a.ru/1')!
    const second = tabsModule.openTab('https://b.ru/2')!
    assert.equal(tabsModule.splitView(), true)
    assert.equal(tabsModule.isSplit(), true)
    // массив остаётся в порядке панелей: [левая, правая]
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [first.id, second.id])
    // опросный хост — левая панель
    assert.equal(first.isPrimary, true)
    assert.equal(second.isPrimary, false)
    assert.equal(tabsModule.splitPaneOf(first), 'left')
    assert.equal(tabsModule.splitPaneOf(second), 'right')
    // обе панели видимы, фокус на левой
    assert.equal(first.view.getAttribute('data-hidden'), null)
    assert.equal(second.view.getAttribute('data-hidden'), null)
    assert.equal(tabsModule.activeTab()!.id, first.id)
    assert.equal(h.container.getAttribute('data-split'), '')
  })

  it('разделение недоступно при одной вкладке, при трёх и повторно', () => {
    setup()
    // вкладок нет
    assert.equal(tabsModule.splitView(), false)
    assert.equal(tabsModule.isSplit(), false)
    // одна вкладка
    tabsModule.openTab('https://a.ru/1')
    assert.equal(tabsModule.splitView(), false)
    // две вкладки — можно
    tabsModule.openTab('https://b.ru/2')
    assert.equal(tabsModule.splitView(), true)
    // повторно — no-op
    assert.equal(tabsModule.splitView(), false)
    assert.equal(tabsModule.isSplit(), true)
    // третья вкладка закрывает разделение (в split их может быть только две)
    tabsModule.unsplit()
    tabsModule.openTab('https://c.ru/3')
    assert.equal(tabsModule.splitView(), false)
    assert.equal(tabsModule.isSplit(), false)
  })

  it('свертывание оставляет активной вкладку фокусной панели', () => {
    setup()
    const first = tabsModule.openTab('https://a.ru/1')!
    const second = tabsModule.openTab('https://b.ru/2')!
    tabsModule.splitView()
    tabsModule.setSplitFocus('right')
    assert.equal(tabsModule.activeTab()!.id, second.id)
    tabsModule.unsplit()
    assert.equal(tabsModule.isSplit(), false)
    // вторая вкладка занимает всё окно
    assert.equal(tabsModule.activeTab()!.id, second.id)
    assert.equal(first.view.getAttribute('data-hidden'), '')
  })

  it('setSplitFocus меняет активную вкладку, вне разделения — no-op', () => {
    setup()
    const first = tabsModule.openTab('https://a.ru/1')!
    const second = tabsModule.openTab('https://b.ru/2')!
    tabsModule.setSplitFocus('right')
    assert.equal(tabsModule.isSplit(), false)
    assert.equal(tabsModule.activeTab()!.id, second.id)
    tabsModule.splitView()
    tabsModule.setSplitFocus('right')
    assert.equal(tabsModule.activeTab()!.id, second.id)
    assert.equal(tabsModule.isActiveTab(second), true)
    assert.equal(tabsModule.isActiveTab(first), false)
  })

  it('новая вкладка в разделении заменяет вкладку активной панели, вторая не тронута', () => {
    setup()
    const left = tabsModule.openTab('https://a.ru/1')!
    const right = tabsModule.openTab('https://b.ru/2')!
    tabsModule.splitView()
    tabsModule.setSplitFocus('right')
    const fresh = tabsModule.openTab('https://c.ru/3')!
    assert.equal(tabsModule.isSplit(), true)
    assert.equal(tabsModule.listTabs().length, 2)
    // порядок панелей сохранён: слева старая левая, справа новая
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [left.id, fresh.id])
    assert.equal(right.view.getAttribute('data-hidden'), null)
    // опросный хост по-прежнему левая панель
    assert.equal(left.isPrimary, true)
    assert.equal(fresh.isPrimary, false)
    assert.equal(tabsModule.activeTab()!.id, fresh.id)
  })

  it('замена вкладки левой панели сохраняет порядок [левая, правая]', () => {
    setup()
    const left = tabsModule.openTab('https://a.ru/1')!
    const right = tabsModule.openTab('https://b.ru/2')!
    tabsModule.splitView()
    const fresh = tabsModule.openTab('https://c.ru/3')!
    assert.equal(tabsModule.isSplit(), true)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [fresh.id, right.id])
    assert.equal(fresh.isPrimary, true)
    assert.equal(tabsModule.splitPaneOf(fresh), 'left')
    assert.equal(tabsModule.splitPaneOf(right), 'right')
  })

  it('закрытие вкладки в разделении сворачивает его', () => {
    setup()
    const left = tabsModule.openTab('https://a.ru/1')!
    const right = tabsModule.openTab('https://b.ru/2')!
    tabsModule.splitView()
    tabsModule.closeTab(right.id)
    assert.equal(tabsModule.isSplit(), false)
    assert.equal(tabsModule.listTabs().length, 1)
    assert.equal(tabsModule.activeTab()!.id, left.id)
  })

  it('перетаскивание в разделении не меняет порядок панелей', () => {
    setup()
    const left = tabsModule.openTab('https://a.ru/1')!
    const right = tabsModule.openTab('https://b.ru/2')!
    tabsModule.splitView()
    tabsModule.moveTab(left.id, 1)
    assert.deepEqual(tabsModule.listTabs().map((t) => t.id), [left.id, right.id])
    assert.equal(tabsModule.splitPaneOf(left), 'left')
  })

  it('меню: вне разделения при двух вкладках есть «Разделить окно»', () => {
    const h = setup()
    const first = tabsModule.openTab('https://a.ru/1')!
    tabsModule.openTab('https://b.ru/2')
    fire(tabButton(0), 'contextmenu')
    const labels = h.popupItems.map((i) => i.label)
    assert.ok(labels.includes('Разделить окно'))
    assert.ok(labels.includes('Закрыть вкладку'))
  })

  it('меню: при одной вкладке «Разделить окно» не предлагается', () => {
    const h = setup()
    tabsModule.openTab('https://a.ru/1')
    fire(tabButton(0), 'contextmenu')
    const labels = h.popupItems.map((i) => i.label)
    assert.equal(labels.includes('Разделить окно'), false)
  })

  it('меню: в разделении есть «Свернуть окно» и нет «закрыть другие/справа»', () => {
    const h = setup()
    tabsModule.openTab('https://a.ru/1')
    tabsModule.openTab('https://b.ru/2')
    tabsModule.splitView()
    fire(tabButton(0), 'contextmenu')
    const labels = h.popupItems.map((i) => i.label)
    assert.ok(labels.includes('Свернуть окно'))
    assert.equal(labels.includes('Разделить окно'), false)
    assert.equal(labels.includes('Закрыть другие вкладки'), false)
    assert.equal(labels.includes('Закрыть вкладки справа'), false)
  })

  it('меню: «Свернуть окно» сворачивает разделение', () => {
    const h = setup()
    tabsModule.openTab('https://a.ru/1')
    tabsModule.openTab('https://b.ru/2')
    tabsModule.splitView()
    fire(tabButton(0), 'contextmenu')
    for (const cb of h.menuActions) cb('unsplit')
    assert.equal(tabsModule.isSplit(), false)
  })
})