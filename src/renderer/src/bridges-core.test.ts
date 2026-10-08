import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anyRequest,
  asBffReqs,
  asInvReqs,
  asScansReqs,
  buildTakeScript,
  emptyQueues,
  nextPollDelay,
  parseTakeResult,
} from './bridges-core.ts'

describe('buildTakeScript', () => {
  it('скрипт — вызванная IIFE (иначе результат не клонируется)', () => {
    const script = buildTakeScript(['bff'])
    assert.ok(script.startsWith('(function()'), 'скрипт обязан быть IIFE')
    assert.ok(script.endsWith('})()'), 'IIFE обязана быть вызвана')
  })
  it('берёт все три очереди одним скриптом', () => {
    const script = buildTakeScript(['bff', 'scans', 'inv'])
    assert.match(script, /__sewHelperBffReq/)
    assert.match(script, /__sewScansReq/)
    assert.match(script, /__sewInventoryReq/)
  })

  it('пустой список каналов даёт скрипт без обращений к очередям', () => {
    const script = buildTakeScript([])
    assert.doesNotMatch(script, /__sew/)
  })

  it('один канал — в скрипте только его очередь', () => {
    const script = buildTakeScript(['scans'])
    assert.match(script, /__sewScansReq/)
    assert.doesNotMatch(script, /__sewHelperBffReq/)
  })

  it('забирает очередь через splice(0), чтобы забрать всё разом', () => {
    assert.match(buildTakeScript(['bff']), /splice\(0\)/)
  })
})

describe('parseTakeResult', () => {
  it('разбирает все три очереди', () => {
    const parsed = parseTakeResult(
      JSON.stringify({ bff: [{ id: '1' }], scans: [{ id: '2' }], inv: [{ id: '3' }] }),
    )
    assert.equal(parsed.bff.length, 1)
    assert.equal(parsed.scans.length, 1)
    assert.equal(parsed.inv.length, 1)
  })

  it('битый JSON не роняет мост — пустые очереди', () => {
    assert.deepEqual(parseTakeResult('{oops'), emptyQueues())
  })

  it('не строка и не массив — пустые очереди', () => {
    assert.deepEqual(parseTakeResult(null), emptyQueues())
    assert.deepEqual(parseTakeResult('[1,2]'), emptyQueues())
  })

  it('отсутствующий канал — пустой массив, а не undefined', () => {
    const parsed = parseTakeResult(JSON.stringify({ bff: [{ id: '1' }] }))
    assert.deepEqual(parsed.scans, [])
    assert.deepEqual(parsed.inv, [])
  })

  it('канал не массив — пустой массив', () => {
    const parsed = parseTakeResult(JSON.stringify({ bff: { nope: 1 } }))
    assert.deepEqual(parsed.bff, [])
  })
})

describe('anyRequest', () => {
  it('три пустые очереди — работы нет', () => {
    assert.equal(anyRequest(emptyQueues()), false)
  })
  it('работа в любом канале считается работой', () => {
    assert.equal(anyRequest({ ...emptyQueues(), inv: [{ id: '1' }] }), true)
    assert.equal(anyRequest({ ...emptyQueues(), scans: [{ id: '1' }] }), true)
    assert.equal(anyRequest({ ...emptyQueues(), bff: [{ id: '1' }] }), true)
  })
})

describe('asBffReqs', () => {
  it('оставляет корректные записи', () => {
    assert.deepEqual(asBffReqs([{ id: 'a', url: 'https://x/1' }]), [{ id: 'a', url: 'https://x/1' }])
  })
  it('режет записи без id или без url', () => {
    assert.deepEqual(asBffReqs([{ url: 'https://x/1' }, { id: 'a' }, 5, null, ['a']]), [])
  })
})

describe('asScansReqs', () => {
  it('сохраняет payload как есть', () => {
    assert.deepEqual(asScansReqs([{ id: 'a', type: 'read', payload: 'C:\\x.png' }]), [
      { id: 'a', type: 'read', payload: 'C:\\x.png' },
    ])
  })
  it('режет записи без type', () => {
    assert.deepEqual(asScansReqs([{ id: 'a' }]), [])
  })
})

describe('asInvReqs', () => {
  it('чистит skus до строк', () => {
    assert.deepEqual(asInvReqs([{ id: 'a', zone: 'z', skus: ['1', 2, null] }]), [
      { id: 'a', type: undefined, zone: 'z', skus: ['1'] },
    ])
  })
  it('переносит type для pick-запроса', () => {
    assert.deepEqual(asInvReqs([{ id: 'a', type: 'pick' }]), [
      { id: 'a', type: 'pick', zone: undefined, skus: [] },
    ])
  })
  it('мусор в zone даёт undefined, а не мусор', () => {
    const [req] = asInvReqs([{ id: 'a', zone: 7 }])
    assert.equal(req.zone, undefined)
    assert.deepEqual(req.skus, [])
  })
  it('режет записи без id', () => {
    assert.deepEqual(asInvReqs([{ zone: 'z' }]), [])
  })
})

describe('nextPollDelay', () => {
  const opts = { work: 500, idleMax: 4000, step: 250 }
  it('при работе возвращаем быстрый интервал', () => {
    assert.equal(nextPollDelay(3000, true, opts), 500)
  })
  it('в простое растёт на step', () => {
    assert.equal(nextPollDelay(500, false, opts), 750)
  })
  it('в простое не превышает потолок', () => {
    assert.equal(nextPollDelay(4000, false, opts), 4000)
    assert.equal(nextPollDelay(3900, false, opts), 4000)
  })
})