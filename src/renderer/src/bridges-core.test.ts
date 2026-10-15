import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anyRequest,
  asBarcodeReqs,
  asBffReqs,
  asInvReqs,
  asScansReqs,
  buildTakeScript,
  emptyQueues,
  enabledChannels,
  isInteractiveRequest,
  nextPollDelay,
  parseTakeResult,
} from './bridges-core.ts'

describe('buildTakeScript', () => {
  it('скрипт — вызванная IIFE (иначе результат не клонируется)', () => {
    const script = buildTakeScript(['bff'])
    assert.ok(script.startsWith('(function()'), 'скрипт обязан быть IIFE')
    assert.ok(script.endsWith('})()'), 'IIFE обязана быть вызвана')
  })
  it('берёт все очереди одним скриптом', () => {
    const script = buildTakeScript(['bff', 'scans', 'inv', 'barcode'])
    assert.match(script, /__sewHelperBffReq/)
    assert.match(script, /__sewScansReq/)
    assert.match(script, /__sewInventoryReq/)
    assert.match(script, /__sewHelperBarcodeReq/)
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
      { id: 'a', type: undefined, zone: 'z', skus: ['1'], manualPath: undefined },
    ])
  })
  it('переносит type для pick-запроса', () => {
    assert.deepEqual(asInvReqs([{ id: 'a', type: 'pick' }]), [
      { id: 'a', type: 'pick', zone: undefined, skus: [], manualPath: undefined },
    ])
  })
  it('переносит manualPath — ручной режим читает файл с диска', () => {
    assert.deepEqual(asInvReqs([{ id: 'a', zone: 'z', skus: [], manualPath: 'C:\\ost.xlsx' }]), [
      { id: 'a', type: undefined, zone: 'z', skus: [], manualPath: 'C:\\ost.xlsx' },
    ])
  })
  it('пустой manualPath = авто-режим (качаем из SEW)', () => {
    const [req] = asInvReqs([{ id: 'a', manualPath: '' }])
    assert.equal(req.manualPath, undefined)
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

describe('asBarcodeReqs — канал базы штрихов', () => {
  it('lookup несёт код товара, status и reload — без него', () => {
    assert.deepEqual(asBarcodeReqs([{ id: 'a', type: 'lookup', sku: ' 1234 ' }]), [
      { id: 'a', type: 'lookup', sku: '1234' },
    ])
    assert.deepEqual(asBarcodeReqs([{ id: 'b', type: 'status' }]), [{ id: 'b', type: 'status', sku: undefined }])
    assert.deepEqual(asBarcodeReqs([{ id: 'c', type: 'reload' }]), [{ id: 'c', type: 'reload', sku: undefined }])
  })
  it('lookup без кода режется: в базе искать нечего', () => {
    assert.deepEqual(asBarcodeReqs([{ id: 'a', type: 'lookup' }]), [])
    assert.deepEqual(asBarcodeReqs([{ id: 'a', type: 'lookup', sku: '' }]), [])
    assert.deepEqual(asBarcodeReqs([{ id: 'a', type: 'lookup', sku: 7 }]), [])
  })
  it('неизвестный тип и запись без id отбрасываются', () => {
    assert.deepEqual(asBarcodeReqs([{ id: 'a', type: 'drop', sku: '1' }]), [])
    assert.deepEqual(asBarcodeReqs([{ type: 'status' }]), [])
    assert.deepEqual(asBarcodeReqs(['мусор', null, 42]), [])
  })
  it('запрос барится в общую очередь оболочки', () => {
    assert.match(buildTakeScript(['barcode']), /__sewHelperBarcodeReq/)
    assert.equal(anyRequest({ ...emptyQueues(), barcode: [{ id: 'a', type: 'status' }] }), true)
  })
})

describe('isInteractiveRequest', () => {
  it('выбор файла сканов — интерактивный: ждёт модальный диалог', () => {
    assert.equal(isInteractiveRequest('scans', { type: 'pick' }), true)
  })
  it('выбор файла остатков — интерактивный', () => {
    assert.equal(isInteractiveRequest('inv', { type: 'pick' }), true)
  })
  it('чтение/удаление/список сканов ждут ответа мгновенно — не интерактивные', () => {
    assert.equal(isInteractiveRequest('scans', { type: 'read' }), false)
    assert.equal(isInteractiveRequest('scans', { type: 'delete' }), false)
    assert.equal(isInteractiveRequest('scans', { type: 'list' }), false)
    assert.equal(isInteractiveRequest('scans', { type: 'launch' }), false)
    assert.equal(isInteractiveRequest('scans', { type: 'open' }), false)
    assert.equal(isInteractiveRequest('scans', { type: 'show' }), false)
  })
  it('разбор остатков по зоне без диалога — не интерактивный', () => {
    assert.equal(isInteractiveRequest('inv', { type: undefined }), false)
    assert.equal(isInteractiveRequest('inv', { type: 'read' }), false)
  })
  it('BFF-запросы не интерактивные ни при каком type', () => {
    assert.equal(isInteractiveRequest('bff', { type: 'pick' }), false)
    assert.equal(isInteractiveRequest('bff', { type: undefined }), false)
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

describe('канал store — запись chrome.storage.local из гостя', () => {
  it(' очередь записи входит в общий take', () => {
    assert.match(buildTakeScript(['store']), /__shellStoreReq/)
  })

  it('очередь записи разбирается вместе с остальными', () => {
    const parsed = parseTakeResult(
      JSON.stringify({ bff: [], scans: [], inv: [], store: [{ plugin: 'a', op: 'set', data: {} }] }),
    )
    assert.equal(parsed.store.length, 1)
  })

  it('запись в очереди хранилища считается работой — держим быстрый интервал', () => {
    assert.equal(anyRequest({ ...emptyQueues(), store: [{ plugin: 'a', op: 'set', data: {} }] }), true)
  })

  it('канал включается, когда включён хоть один плагин', () => {
    // ни один из «мостовых» плагинов не включён, но tasks-notify пишет seen
    assert.deepEqual(enabledChannels(['tasks-notify']), ['store'])
  })

  it('выключенный плагин не тянет свой канал', () => {
    assert.deepEqual(enabledChannels(['identity']), ['store'])
    assert.deepEqual(enabledChannels(['sew-helper']), ['bff', 'store', 'barcode'])
    assert.deepEqual(enabledChannels(['scans-block', 'sew-inventory']), ['scans', 'inv', 'store'])
  })

  it('без включённых плагинов каналов нет — опрос не крутится вхолостую', () => {
    assert.deepEqual(enabledChannels([]), [])
  })

  it('дубль имени плагина не дублирует канал', () => {
    assert.deepEqual(enabledChannels(['sew-helper', 'sew-helper']), ['bff', 'store', 'barcode'])
  })
})