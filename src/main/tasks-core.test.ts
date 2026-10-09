import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BODY_MAX,
  TASKS_DEFAULT_PATH,
  TITLE_MAX,
  isAllowedNotifyUrl,
  sanitizeTaskNotifications,
} from './tasks-core.ts'

const seW = (url: string): boolean => /^https:\/\/[a-z.]*mvideoeldorado\.ru\//i.test(url)

test('мусор и не-массив отбрасываются', () => {
  assert.deepEqual(sanitizeTaskNotifications(null, seW), [])
  assert.deepEqual(sanitizeTaskNotifications('abc', seW), [])
  assert.deepEqual(sanitizeTaskNotifications([null, 1, 'x'], seW), [])
})

test('элемент без числового id или без title отбрасывается', () => {
  const out = sanitizeTaskNotifications(
    [{ title: 'ok' }, { id: '1', title: 'ok' }, { id: NaN, title: 'ok' }, { id: 1, title: '' }, { id: 1, title: 5 }],
    seW,
  )
  assert.deepEqual(out, [])
})

test('нормальный элемент проходит без изменений', () => {
  const out = sanitizeTaskNotifications(
    [{ id: 7, title: 'ЗП С187', body: 'Линия 3', url: 'https://sew.mvideoeldorado.ru/v2/task/1' }],
    seW,
  )
  assert.deepEqual(out, [
    { id: 7, title: 'ЗП С187', body: 'Линия 3', url: 'https://sew.mvideoeldorado.ru/v2/task/1' },
  ])
})

test('url вне allowlist заменяется на заглушку заданий', () => {
  const out = sanitizeTaskNotifications(
    [{ id: 1, title: 'сессия истекла', body: 'войдите на https://evil.example', url: 'https://evil.example/login' }],
    seW,
  )
  assert.equal(out[0].url, TASKS_DEFAULT_PATH)
})

test('url с чужой схемой заменяется на заглушку', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/x.html', 'data:text/html,x', 'sew://x']) {
    const out = sanitizeTaskNotifications([{ id: 1, title: 't', url }], seW)
    assert.equal(out[0].url, TASKS_DEFAULT_PATH, url)
  }
})

test('url из разрешённого поддомена остаётся', () => {
  const out = sanitizeTaskNotifications(
    [{ id: 1, title: 't', url: 'https://sew.mvideoeldorado.ru/v2/task/9' }],
    seW,
  )
  assert.equal(out[0].url, 'https://sew.mvideoeldorado.ru/v2/task/9')
})

test('длинные title и body режутся до лимита', () => {
  const out = sanitizeTaskNotifications([{ id: 1, title: 'я'.repeat(500), body: 'б'.repeat(900) }], seW)
  assert.equal(out[0].title.length, TITLE_MAX)
  assert.equal(out[0].body.length, BODY_MAX)
})

test('слишком длинный url режется и не проходит allowlist', () => {
  const long = 'https://sew.mvideoeldorado.ru/' + 'x'.repeat(900)
  const out = sanitizeTaskNotifications([{ id: 1, title: 't', url: long }], seW)
  assert.equal(out[0].url, TASKS_DEFAULT_PATH)
})

test('обрезка не разрывает суррогатную пару', () => {
  const emoji = '\u{1F600}'
  const out = sanitizeTaskNotifications([{ id: 1, title: emoji.repeat(TITLE_MAX) }], seW)
  const last = out[0].title.charCodeAt(out[0].title.length - 1)
  assert.ok(out[0].title.length <= TITLE_MAX)
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'хвост не должен быть суррогатным')
})

test('body и url не-строки заменяются безопасными значениями', () => {
  const out = sanitizeTaskNotifications([{ id: 1, title: 't', body: 42, url: 7 }], seW)
  assert.equal(out[0].body, '')
  assert.equal(out[0].url, TASKS_DEFAULT_PATH)
})

test('isAllowedNotifyUrl: пустая строка допустима, мусор — нет', () => {
  assert.equal(isAllowedNotifyUrl('', seW), true)
  assert.equal(isAllowedNotifyUrl('javascript:x', seW), false)
  assert.equal(isAllowedNotifyUrl('https://evil.example', seW), false)
})
