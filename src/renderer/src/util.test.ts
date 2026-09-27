import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  errText,
  formatBytes,
  formatDateTime,
  formatSize,
  hostOf,
  isAllowed,
  normalizeUrl,
  resolveTasksUrl,
} from './util.ts'

describe('normalizeUrl', () => {
  it('добавляет https, если схемы нет', () => {
    assert.equal(normalizeUrl('sew.mvideoeldorado.ru/v2/'), 'https://sew.mvideoeldorado.ru/v2/')
  })

  it('не трогает готовый http(s)-URL', () => {
    assert.equal(normalizeUrl('http://localhost:5173/'), 'http://localhost:5173/')
  })

  it('режет пробелы и отдаёт пустую строку на пустом вводе', () => {
    assert.equal(normalizeUrl('  https://a.ru  '), 'https://a.ru')
    assert.equal(normalizeUrl('   '), '')
  })
})

describe('hostOf', () => {
  it('достаёт host в нижнем регистре', () => {
    assert.equal(hostOf('https://SEW.mvideoeldorado.ru/v2/'), 'sew.mvideoeldorado.ru')
  })

  it('пустая строка на не-URL', () => {
    assert.equal(hostOf('не url'), '')
  })
})

describe('isAllowed', () => {
  const list = ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru']

  it('выключенная проверка пропускает всё', () => {
    assert.equal(isAllowed('https://example.com/', list, false), true)
  })

  it('без списка при включённой проверке ничего не пускает', () => {
    assert.equal(isAllowed('https://sew.mvideoeldorado.ru/v2/', undefined, true), false)
  })

  it('*. покрывает и сам домен, и поддомены', () => {
    assert.equal(isAllowed('https://sew.mvideoeldorado.ru/v2/', list, true), true)
    assert.equal(isAllowed('https://a.b.mvideoeldorado.ru/v2/', list, true), true)
  })

  it('*. не покрывает соседний домен', () => {
    assert.equal(isAllowed('https://notmvideoeldorado.ru/', list, true), false)
  })

  it('точный домен совпадает сам с собой', () => {
    assert.equal(isAllowed('https://kc.tech.mvideo.ru/auth', list, true), true)
    assert.equal(isAllowed('https://other.tech.mvideo.ru/auth', list, true), false)
  })

  it('мусорный URL отклоняется', () => {
    assert.equal(isAllowed('не url', list, true), false)
  })
})

describe('resolveTasksUrl', () => {
  it('абсолютный URL возвращается как есть', () => {
    assert.equal(
      resolveTasksUrl('https://sew.mvideoeldorado.ru/v2/relocation/tasks', 'https://x.ru/', 'https://y.ru/'),
      'https://sew.mvideoeldorado.ru/v2/relocation/tasks',
    )
  })

  it('относительный путь резолвится против base', () => {
    assert.equal(
      resolveTasksUrl('/v2/relocation/tasks', 'https://sew.mvideoeldorado.ru/v2/', 'https://y.ru/'),
      'https://sew.mvideoeldorado.ru/v2/relocation/tasks',
    )
  })

  it('пустая строка берёт путь заданий по умолчанию', () => {
    assert.equal(
      resolveTasksUrl('', 'https://sew.mvideoeldorado.ru/v2/', 'https://y.ru/'),
      'https://sew.mvideoeldorado.ru/v2/relocation/tasks',
    )
  })

  it('при битом base откатывается на fallback', () => {
    assert.equal(
      resolveTasksUrl('/v2/relocation/tasks', 'мусор', 'https://sew.mvideoeldorado.ru/v2/'),
      'https://sew.mvideoeldorado.ru/v2/relocation/tasks',
    )
  })

  it('при битых base и fallback склеивает вручную', () => {
    assert.equal(
      resolveTasksUrl('/v2/relocation/tasks', 'мусор', 'тоже мусор'),
      'тоже мусор/v2/relocation/tasks',
    )
  })
})

describe('formatBytes / formatSize', () => {
  it('форматирует байты, килобайты и мегабайты', () => {
    assert.equal(formatBytes(512), '512 Б')
    assert.equal(formatBytes(2048), '2.0 КБ')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 МБ')
  })

  it('ноль и отрицательные дают пустую строку', () => {
    assert.equal(formatBytes(0), '')
    assert.equal(formatBytes(-1), '')
  })

  it('formatSize на нуле показывает «0 Б», а не пустую строку', () => {
    assert.equal(formatSize(0), '0 Б')
    assert.equal(formatSize(-5), '0 Б')
    assert.equal(formatSize(2048), '2.0 КБ')
  })
})

describe('errText', () => {
  it('Error отдаёт message, остальное — строкой', () => {
    assert.equal(errText(new Error('таймаут чтения cookies')), 'таймаут чтения cookies')
    assert.equal(errText('строка'), 'строка')
    assert.equal(errText(undefined), 'undefined')
  })
})

describe('formatDateTime', () => {
  it('битая дата даёт пустую строку', () => {
    assert.equal(formatDateTime('не дата'), '')
  })

  it('валидная дата непустая', () => {
    assert.notEqual(formatDateTime('2026-09-27T10:15:00Z'), '')
  })
})
