import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampTabIndex,
  cycleTabIndex,
  hostOfTabUrl,
  isOpenInWindowGesture,
  normalizeTabUrl,
  tabTitle,
  tabsToSuspend,
  type SuspendCandidate,
} from './tabs-core.ts'

describe('normalizeTabUrl', () => {
  it('добавляет https к голому хосту с путём', () => {
    assert.equal(normalizeTabUrl('sew.mvideoeldorado.ru/v2/'), 'https://sew.mvideoeldorado.ru/v2/')
  })
  it('оставляет абсолютный http(s) URL как есть', () => {
    assert.equal(normalizeTabUrl('http://kc.tech.mvideo.ru/auth'), 'http://kc.tech.mvideo.ru/auth')
  })
  it('режет пробелы', () => {
    assert.equal(normalizeTabUrl('  https://sew.mvideoeldorado.ru/v2/  '), 'https://sew.mvideoeldorado.ru/v2/')
  })
  it('возвращает пустую строку на пустом входе', () => {
    assert.equal(normalizeTabUrl('   '), '')
  })
  it('отбрасывает не-http схемы', () => {
    assert.equal(normalizeTabUrl('javascript:void(0)'), '')
    assert.equal(normalizeTabUrl('data:text/html,<b>x</b>'), '')
    assert.equal(normalizeTabUrl('mailto:a@b.ru'), '')
  })
  it('возвращает пустую строку на неразбираемом URL', () => {
    assert.equal(normalizeTabUrl('http://'), '')
  })

  // Кейсы ниже фиксируют url.href-нормализацию: результат НЕ равен вводу дословно.
  // tab.url в слое вкладок всегда равен результату normalizeTabUrl, и по нему идёт
  // дедупликация URL по строке в focusOrOpenTab — без этих тестов рефакторинг
  // regex'ов тихо научился бы ломать дедупликацию (один и тот же адрес из двух
  // форм ввода перестал бы совпадать). Ожидания зафиксированы фактическим
  // запуском node, а не выведены умозрительно.
  it('приводит хост к нижнему регистру через url.href', () => {
    assert.equal(
      normalizeTabUrl('https://SEW.MVIDEOELDORADO.RU/v2/'),
      'https://sew.mvideoeldorado.ru/v2/',
    )
  })
  it('дописывает / к пустому пути через url.href', () => {
    assert.equal(normalizeTabUrl('https://A.RU'), 'https://a.ru/')
  })
  it('percent-encoding не-ASCII и пробелов через url.href', () => {
    assert.equal(
      normalizeTabUrl('https://a.ru/путь?q=значение'),
      'https://a.ru/%D0%BF%D1%83%D1%82%D1%8C?q=%D0%B7%D0%BD%D0%B0%D1%87%D0%B5%D0%BD%D0%B8%D0%B5',
    )
    assert.equal(normalizeTabUrl('https://a.ru/my path'), 'https://a.ru/my%20path')
  })
})

describe('hostOfTabUrl', () => {
  it('возвращает хост в нижнем регистре', () => {
    assert.equal(hostOfTabUrl('https://SEW.mvideoeldorado.ru/v2/'), 'sew.mvideoeldorado.ru')
  })
  it('возвращает пустую строку на мусоре', () => {
    assert.equal(hostOfTabUrl('не url'), '')
  })
})

describe('tabTitle', () => {
  it('берёт заголовок страницы', () => {
    assert.equal(tabTitle('Задания на перемещение', 'https://sew.mvideoeldorado.ru/v2/'), 'Задания на перемещение')
  })
  it('обрезает пробелы в заголовке', () => {
    assert.equal(tabTitle('  Задания  ', 'https://sew.mvideoeldorado.ru/v2/'), 'Задания')
  })
  it('падает на хост, если заголовка нет', () => {
    assert.equal(tabTitle('   ', 'https://sew.mvideoeldorado.ru/v2/'), 'sew.mvideoeldorado.ru')
  })
  it('падает на SEW, если заголовка и хоста нет', () => {
    assert.equal(tabTitle('', 'не url'), 'SEW')
  })
})

describe('cycleTabIndex', () => {
  it('ходит по кругу вперёд', () => {
    assert.equal(cycleTabIndex(3, 0, 1), 1)
    assert.equal(cycleTabIndex(3, 2, 1), 0)
  })
  it('ходит по кругу назад', () => {
    assert.equal(cycleTabIndex(3, 0, -1), 2)
  })
  it('возвращает -1 при пустом списке', () => {
    assert.equal(cycleTabIndex(0, 0, 1), -1)
  })
})

describe('clampTabIndex', () => {
  it('переводит номер вкладки 1..9 в индекс', () => {
    assert.equal(clampTabIndex(3, 1), 0)
    assert.equal(clampTabIndex(3, 3), 2)
  })
  it('возвращает -1 за пределами диапазона', () => {
    assert.equal(clampTabIndex(3, 4), -1)
    assert.equal(clampTabIndex(3, 0), -1)
  })
  it('возвращает -1 при пустом списке', () => {
    assert.equal(clampTabIndex(0, 1), -1)
  })
})

describe('extractNewTabUrls', () => {
  it('extractNewTabUrls отбрасывает мусор и не-http схемы', async () => {
    const { extractNewTabUrls } = await import('./tabs-core.ts')
    assert.deepEqual(
      extractNewTabUrls('[{"url":"https://sew.mvideoeldorado.ru/v2/relocation/tasks/1"},{"url":"javascript:alert(1)"},{"nope":1},{"url":""}]'),
      ['https://sew.mvideoeldorado.ru/v2/relocation/tasks/1'],
    )
    assert.deepEqual(extractNewTabUrls('[]'), [])
    assert.deepEqual(extractNewTabUrls(null), [])
    assert.deepEqual(extractNewTabUrls('не json'), [])
  })
})

describe('tabFavicon', () => {
  it('буква — первая буква хоста, цвет детерминирован', async () => {
    const { tabFavicon } = await import('./tabs-core.ts')
    const fav = tabFavicon('https://sew.mvideoeldorado.ru/v2/')
    assert.equal(fav.letter, 'S')
    // Один и тот же хост — один и тот же цвет при каждом запуске
    assert.equal(fav.color, tabFavicon('https://sew.mvideoeldorado.ru/other').color)
    assert.match(fav.color, /^hsl\(\d{1,3}, 55%, 45%\)$/)
  })
  it('разные хосты — разные цвета', async () => {
    const { tabFavicon } = await import('./tabs-core.ts')
    assert.notEqual(
      tabFavicon('https://sew.mvideoeldorado.ru/').color,
      tabFavicon('https://www.mvideo.ru/').color,
    )
  })
  it('хост не разобрать — заглушка', async () => {
    const { tabFavicon } = await import('./tabs-core.ts')
    assert.equal(tabFavicon('мусор').letter, '?')
  })
})

describe('isOpenInWindowGesture', () => {
  it('Ctrl+ЛКМ и Cmd+ЛКМ открывают вкладку в новом окне', () => {
    assert.equal(isOpenInWindowGesture({ button: 0, ctrlKey: true }), true)
    assert.equal(isOpenInWindowGesture({ button: 0, metaKey: true }), true)
  })
  it('обычный клик по вкладке ничего не открывает', () => {
    assert.equal(isOpenInWindowGesture({ button: 0 }), false)
    assert.equal(isOpenInWindowGesture({ button: 0, ctrlKey: false, metaKey: false }), false)
  })
  it('средняя кнопка остаётся за закрытием вкладки', () => {
    assert.equal(isOpenInWindowGesture({ button: 1, ctrlKey: true }), false)
  })
  it('ПКМ не считается', () => {
    assert.equal(isOpenInWindowGesture({ button: 2, ctrlKey: true }), false)
  })
})

describe('normalizeFaviconUrl', () => {
  const page = 'https://sew.mvideoeldorado.ru/v2/relocation/tasks'
  it('абсолютный http(s) href остаётся как есть', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    assert.equal(
      normalizeFaviconUrl('https://cdn.site.ru/favicon.png', page),
      'https://cdn.site.ru/favicon.png',
    )
  })
  it('относительный href резолвится против адреса страницы', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    assert.equal(normalizeFaviconUrl('/favicon.ico', page), 'https://sew.mvideoeldorado.ru/favicon.ico')
    assert.equal(normalizeFaviconUrl('assets/i.png', page), 'https://sew.mvideoeldorado.ru/v2/relocation/assets/i.png')
  })
  it('data:-иконка сайта проходит без изменений', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    const data = 'data:image/png;base64,iVBORw0KGgo='
    assert.equal(normalizeFaviconUrl(data, page), data)
  })
  it('слишком длинная data:-иконка отбрасывается', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    assert.equal(normalizeFaviconUrl(huge, page), '')
  })
  it('не-base64 data:-иконка отбрасывается (кавычки сломали бы style)', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    assert.equal(normalizeFaviconUrl('data:image/svg+xml,<svg fill="red"></svg>', page), '')
    assert.equal(normalizeFaviconUrl('data:text/html,<b>x</b>', page), '')
  })
  it('не-http схемы и мусор отбрасываются', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    assert.equal(normalizeFaviconUrl('javascript:alert(1)', page), '')
    assert.equal(normalizeFaviconUrl('blob:https://site.ru/abc', page), '')
    assert.equal(normalizeFaviconUrl('', page), '')
    assert.equal(normalizeFaviconUrl('   ', page), '')
    assert.equal(normalizeFaviconUrl(null, page), '')
    assert.equal(normalizeFaviconUrl(undefined, page), '')
  })
  it('некорректный адрес страницы не роняет функцию, а даёт пусто', async () => {
    const { normalizeFaviconUrl } = await import('./tabs-core.ts')
    // new URL требует валидный base, поэтому даже абсолютный href без него не резолвится
    assert.equal(normalizeFaviconUrl('/favicon.ico', 'не-url'), '')
    assert.equal(normalizeFaviconUrl('https://site.ru/i.png', 'не-url'), '')
  })
})

/** Заготовка вкладки для планировщика выгрузки: важны только id и признаки. */
function tab(
  id: number,
  opts: { loaded?: boolean; isPrimary?: boolean; lastUsed?: number } = {},
): SuspendCandidate {
  return {
    id,
    loaded: opts.loaded ?? true,
    isPrimary: opts.isPrimary ?? false,
    lastUsed: opts.lastUsed ?? id,
  }
}

describe('tabsToSuspend', () => {
  it('в разделении не выгружает ничего: обе панели на виду', () => {
    const ids = tabsToSuspend([tab(1), tab(2), tab(3), tab(4), tab(5)], {
      budget: 2,
      activeId: 5,
      isSplit: true,
    })
    assert.deepEqual(ids, [])
  })

  it('не выгружает ничего, пока живых вкладок не больше бюджета', () => {
    const ids = tabsToSuspend([tab(1, { isPrimary: true }), tab(2), tab(3)], {
      budget: 3,
      activeId: 3,
      isSplit: false,
    })
    assert.deepEqual(ids, [])
  })

  it('выгружает самую давно использованную, когда вкладок больше бюджета', () => {
    const ids = tabsToSuspend(
      [tab(1, { isPrimary: true, lastUsed: 1 }), tab(2, { lastUsed: 2 }), tab(3, { lastUsed: 3 })],
      { budget: 2, activeId: 3, isSplit: false },
    )
    assert.deepEqual(ids, [2])
  })

  it('первая вкладка (опросный хост) не выгружается, даже когда она самая старая', () => {
    const ids = tabsToSuspend(
      [tab(1, { isPrimary: true, lastUsed: 1 }), tab(2, { lastUsed: 5 }), tab(3, { lastUsed: 4 })],
      { budget: 2, activeId: 3, isSplit: false },
    )
    assert.deepEqual(ids, [2])
  })

  it('активная вкладка не выгружается, даже когда она самая старая', () => {
    const ids = tabsToSuspend([tab(1, { isPrimary: true, lastUsed: 9 }), tab(2, { lastUsed: 1 })], {
      budget: 1,
      activeId: 2,
      isSplit: false,
    })
    assert.deepEqual(ids, [])
  })

  it('бюджет меньше числа защищённых вкладок — выгружает всех остальных', () => {
    // Активная и опросная вместе уже съедают бюджет 1: они неприкосновенны,
    // поэтому план превышает бюджет — это лучше, чем убить опросный хост.
    const ids = tabsToSuspend(
      [tab(1, { isPrimary: true, lastUsed: 9 }), tab(2, { lastUsed: 8 }), tab(3, { lastUsed: 7 })],
      { budget: 1, activeId: 1, isSplit: false },
    )
    // lastUsed: 8 у второй, 7 у третьей → выгружается третья (старее) первой.
    assert.deepEqual(ids, [3, 2])
  })

  it('выгружает от самой старой к самой свежей', () => {
    const ids = tabsToSuspend(
      [tab(1, { isPrimary: true, lastUsed: 5 }), tab(2, { lastUsed: 4 }), tab(3, { lastUsed: 9 }), tab(4, { lastUsed: 2 }), tab(5, { lastUsed: 8 })],
      { budget: 3, activeId: 5, isSplit: false },
    )
    // Защищены 1 (опросный хост) и 5 (активная), остаётся место 3 только на одну.
    assert.deepEqual(ids, [4, 2])
  })

  it('уже выгруженные вкладки в план не попадают', () => {
    const ids = tabsToSuspend(
      [tab(1, { isPrimary: true, lastUsed: 1 }), tab(2, { lastUsed: 2 }), tab(3, { lastUsed: 3, loaded: false })],
      { budget: 1, activeId: 1, isSplit: false },
    )
    assert.deepEqual(ids, [2])
  })

  it('бюджет 0 или отрицательный — выгружать нечего (панель управления спасена)', () => {
    const ids = tabsToSuspend([tab(1, { isPrimary: true }), tab(2)], {
      budget: 0,
      activeId: 2,
      isSplit: false,
    })
    assert.deepEqual(ids, [])
  })

  it('пустой список вкладок даёт пустой план', () => {
    assert.deepEqual(tabsToSuspend([], { budget: 4, activeId: 0, isSplit: false }), [])
  })
})