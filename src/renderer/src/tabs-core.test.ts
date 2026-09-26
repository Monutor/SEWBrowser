import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampTabIndex,
  cycleTabIndex,
  hostOfTabUrl,
  normalizeTabUrl,
  tabTitle,
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
