import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPrintTaskBody,
  buildSearchBody,
  isValidBarcodeWidth,
  isValidCopies,
  isValidPaperColorId,
  isValidTemplateId,
  normalizeSearchResponse,
  parseSkuInput,
  pricetagFileName,
  sewContentError,
  sewErrorMessage,
} from './pricetags-core.ts'

test('parseSkuInput: переводы строк, запятые, точки с запятой', () => {
  assert.deepEqual(parseSkuInput('4258653\n4258654; 4258655,\n4258656\t4258657'), [
    '4258653', '4258654', '4258655', '4258656', '4258657',
  ])
})

test('parseSkuInput: дубли игнорируются, порядок сохраняется', () => {
  assert.deepEqual(parseSkuInput('111\n222\n111\n333'), ['111', '222', '333'])
})

test('parseSkuInput: мусор отбрасывается, пустое даёт пустой массив', () => {
  assert.deepEqual(parseSkuInput('  \n ; \n , \n'), [])
  assert.deepEqual(parseSkuInput('abc 123'), ['123'])
  assert.deepEqual(parseSkuInput('S-187_1'), ['S-187_1'])
})

test('normalizeSearchResponse: позиции в порядке ввода, штрихов нет', () => {
  const json = {
    responseHeader: { responseDate: '2026-10-07T05:20:11' },
    responseBody: [
      { materialId: '4258653', materialName: '(А)TV Toshiba 55M450RE RU', price: 39999, objectId: 'S187',
        templates: [{ id: 89, name: 'А6 ПРОМО', width: 148, height: 105 }], totalCopies: 1, paperColorId: 1 },
    ],
  }
  const got = normalizeSearchResponse(json, ['4258653'])
  assert.deepEqual(got.items, [{ sku: '4258653', name: '(А)TV Toshiba 55M450RE RU', price: 39999 }])
  assert.deepEqual(got.missing, [])
  assert.deepEqual(got.templates, [{ id: 89, name: 'А6 ПРОМО', width: 148, height: 105 }])
  assert.equal(got.warning, undefined)
})

test('normalizeSearchResponse: переупорядочивает по списку ввода', () => {
  const json = {
    responseHeader: {},
    responseBody: [
      { materialId: 'B', materialName: 'b', price: 1, templates: [{ id: 89, name: 't' }] },
      { materialId: 'A', materialName: 'a', price: 2, templates: [] },
    ],
  }
  const got = normalizeSearchResponse(json, ['A', 'B'])
  assert.deepEqual(got.items.map((i) => i.sku), ['A', 'B'])
  assert.deepEqual(got.templates, [{ id: 89, name: 't' }])
})

test('normalizeSearchResponse: ошибка 1001 уходит в missing', () => {
  const json = {
    responseHeader: { errors: [{ level: 'WARNING', code: 1001, message: 'Информация по товарам 400353555 не найдена' }] },
    responseBody: [],
  }
  const got = normalizeSearchResponse(json, ['400353555'])
  assert.deepEqual(got.items, [])
  assert.deepEqual(got.missing, ['400353555'])
  assert.equal(got.warning, 'Информация по товарам 400353555 не найдена')
})

test('normalizeSearchResponse: мусор в ответе не роняет разбор', () => {
  assert.deepEqual(normalizeSearchResponse(null, ['1']).items, [])
  assert.deepEqual(normalizeSearchResponse({ responseBody: 'нет' }, ['1']).items, [])
  const got = normalizeSearchResponse({ responseBody: [{ materialName: 'без sku' }] }, ['1'])
  assert.deepEqual(got.items, [])
  assert.deepEqual(got.missing, ['1'])
})

test('normalizeSearchResponse: шаблоны без id/name отбрасываются', () => {
  const json = {
    responseHeader: {},
    responseBody: [{ materialId: '1', materialName: 'n', price: 1, templates: [{ id: 'x' }, { name: 'y' }, { id: 96, name: 'ШТРИХ-КОД 24' }] }],
  }
  assert.deepEqual(normalizeSearchResponse(json, ['1']).templates, [{ id: 96, name: 'ШТРИХ-КОД 24' }])
})

test('buildSearchBody: контракт из HAR', () => {
  assert.deepEqual(buildSearchBody('S187', ['4258653']), {
    requestHeader: { headerParams: [] },
    requestBody: {
      objectId: 'S187',
      barCodes: [],
      matNames: [],
      zcodes: [],
      matNos: ['4258653'],
      goodsGroups: [],
      brands: [],
      dynamicAttrs: {},
      requestOnlineSources: true,
      promo: [],
      onStock: true,
      onlyMarkdown: false,
    },
  })
})

test('buildPrintTaskBody: контракт из HAR', () => {
  const body = buildPrintTaskBody({
    objectId: 'S187',
    items: [{ sku: '4258653', name: '(А)TV Toshiba 55M450RE RU', price: 39999 }],
    templateId: 89,
    paperColorId: 1,
    copies: 1,
  })
  assert.deepEqual(body, {
    requestBody: {
      objectId: 'S187',
      forChanges: false,
      priceTags: [{
        materialId: '4258653',
        materialName: '(А)TV Toshiba 55M450RE RU',
        price: 39999,
        objectId: 'S187',
        paperColorId: 1,
        templateId: 89,
        totalCopies: 1,
        zCoupon: null,
      }],
      printMode: 'M',
      isOnline: true,
    },
  })
})

test('buildPrintTaskBody: копии и несколько позиций', () => {
  const body = buildPrintTaskBody({
    objectId: 'S187',
    items: [{ sku: '1', name: 'a', price: 10 }, { sku: '2', name: 'b', price: 20 }],
    templateId: 96,
    paperColorId: 2,
    copies: 3,
  })
  const tags = (body.requestBody as { priceTags: Array<{ materialId: string; totalCopies: number }> }).priceTags
  assert.deepEqual(tags.map((t) => t.materialId), ['1', '2'])
  assert.ok(tags.every((t) => t.totalCopies === 3))
})

test('buildPrintTaskBody: битые копии заменяются единицей', () => {
  const body = buildPrintTaskBody({
    objectId: 'S187',
    items: [{ sku: '1', name: 'a', price: 10 }],
    templateId: 89,
    paperColorId: 1,
    copies: 0,
  })
  const tags = (body.requestBody as { priceTags: Array<{ totalCopies: number }> }).priceTags
  assert.equal(tags[0].totalCopies, 1)
})

test('sewErrorMessage: 401, 403 и прочие', () => {
  assert.equal(sewErrorMessage(401, 'ценники'), 'сессия SEW протухла — обновите страницу SEW')
  assert.equal(sewErrorMessage(403, 'ценники'), 'нет прав на ценники по магазину')
  assert.equal(sewErrorMessage(500, 'ценники'), 'SEW ответил HTTP 500 (ценники)')
})

test('валидаторы конфига', () => {
  assert.equal(isValidTemplateId(96), true)
  assert.equal(isValidTemplateId(0), false)
  assert.equal(isValidTemplateId('96'), false)
  assert.equal(isValidPaperColorId(1), true)
  assert.equal(isValidPaperColorId(3), true)
  assert.equal(isValidPaperColorId(4), false)
  assert.equal(isValidCopies(1), true)
  assert.equal(isValidCopies(999), true)
  assert.equal(isValidCopies(0), false)
  assert.equal(isValidCopies(1000), false)
  assert.equal(isValidCopies(1.5), false)
  assert.equal(isValidBarcodeWidth(100), true)
  assert.equal(isValidBarcodeWidth(1), true)
  assert.equal(isValidBarcodeWidth(999), true)
  assert.equal(isValidBarcodeWidth(0), false)
  assert.equal(isValidBarcodeWidth(1000), false)
  assert.equal(isValidBarcodeWidth(1.5), false)
  assert.equal(isValidBarcodeWidth('100'), false)
  assert.equal(isValidBarcodeWidth(null), false)
})

test('pricetagFileName: магазин и дата', () => {
  assert.equal(
    pricetagFileName('S187', new Date(2026, 9, 7, 15, 4, 5)),
    'Ценники S187 2026-10-07-1504.pdf',
  )
  assert.ok(pricetagFileName('S/187', new Date(2026, 9, 7)).endsWith('.pdf'))
})

test('sewContentError: конверт SEW с errors[].message', () => {
  // Форма конверта та же, что у search: responseHeader.errors[].message.
  assert.equal(
    sewContentError('{"responseHeader":{"errors":[{"message":"Нет прав на магазин"}]}}'),
    'Нет прав на магазин',
  )
  assert.equal(sewContentError('{"errors":[{"message":"отказ"}]}'), 'отказ')
  // Конверт без текста ошибки — это не ошибка: так выглядит «задание ещё в работе».
  assert.equal(sewContentError('{"responseHeader":{"errors":[]}}'), null)
  assert.equal(sewContentError('{"responseHeader":{}}'), null)
})

test('sewContentError: голые поля ошибки и вложенный error.message', () => {
  assert.equal(sewContentError('{"message":"Шаблон не найден"}'), 'Шаблон не найден')
  assert.equal(sewContentError('{"error":"Нет шаблона"}'), 'Нет шаблона')
  assert.equal(sewContentError('{"error":{"message":"Вложенная"}}'), 'Вложенная')
  assert.equal(sewContentError('{"error_description":"invalid_client"}'), 'invalid_client')
  assert.equal(sewContentError('{"detail":"нет прав"}'), 'нет прав')
})

test('sewContentError: пустое, HTML и мусор — это «ещё рендерится», а не ошибка', () => {
  // Пустое тело при HTTP 200 — как отдаёт SEW, пока рендер идёт (проверено по HAR).
  assert.equal(sewContentError(''), null)
  assert.equal(sewContentError('   \n '), null)
  // Частично отрисованный HTML JSON не разбирается — продолжаем опрос.
  assert.equal(sewContentError('<!DOCTYPE html><html><body>частично'), null)
  assert.equal(sewContentError('{}'), null)
  assert.equal(sewContentError('[]'), null)
  assert.equal(sewContentError('{"message":"   "}'), null)
})
