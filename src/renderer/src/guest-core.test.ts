import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildInjectScript,
  checkPluginSyntax,
  parseInjectResult,
  selectInjectable,
  type InjectablePlugin,
} from './guest-core.ts'

function plugin(name: string, over: Partial<InjectablePlugin> = {}): InjectablePlugin {
  return { name, code: '', styles: '', init: '', ...over }
}

const SHIM = '(function(){ if(!window.__shellChromeShim){ window.__shellChromeShim = true; } })()'

test('buildInjectScript: начинается и заканчивается вызываемым IIFE', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('a', { code: 'var x = 1;' })],
  })
  // Ловушка 17: голая `(function(){…})` без вызова возвращает объект функции,
  // он неклонируем → GUEST_VIEW_MANAGER_CALL.
  assert.ok(script.startsWith('(function(){'))
  assert.ok(script.endsWith('})()'))
})

test('buildInjectScript: возвращает JSON-строку с ошибками', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('a', { code: 'var x = 1;' })],
  })
  assert.match(script, /return JSON\.stringify\(__errors\);/)
})

test('buildInjectScript: снапшот данных и poll-host ставятся до кода плагинов', () => {
  const script = buildInjectScript({
    stores: { 'tasks-notify': { settings: { intervalSec: 60 } } },
    pollHost: true,
    shim: SHIM,
    plugins: [plugin('a', { code: 'var x = 1;' })],
  })
  const storesAt = script.indexOf('window.__shellPluginStores')
  const pollAt = script.indexOf('window.__shellPollHost')
  const shimAt = script.indexOf('window.__shellChromeShim')
  const codeAt = script.indexOf('var x = 1;')
  assert.ok(storesAt >= 0 && pollAt > storesAt)
  assert.ok(shimAt > pollAt)
  assert.ok(codeAt > shimAt, 'шим должен идти до кода плагина')
})

test('buildInjectScript: pollHost true/false попадает в скрипт', () => {
  const yes = buildInjectScript({ stores: {}, pollHost: true, shim: SHIM, plugins: [] })
  const no = buildInjectScript({ stores: {}, pollHost: false, shim: SHIM, plugins: [] })
  assert.match(yes, /window\.__shellPollHost = true;/)
  assert.match(no, /window\.__shellPollHost = false;/)
})

test('buildInjectScript: шим вставляется ровно один раз на скрипт', () => {
  const shim = '(function(){ if(!window.__shellChromeShim){ window.__shellChromeShim = true; __SHIM_MARKER__ } })()'
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim,
    plugins: [plugin('a', { code: '1;' }), plugin('b', { code: '2;' }), plugin('c', { code: '3;' })],
  })
  assert.equal(script.split('__SHIM_MARKER__').length - 1, 1)
})

test('buildInjectScript: имя плагина ставится перед его кодом и сбрасывается в конце', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('alpha', { code: 'var a = 1;' })],
  })
  const nameAt = script.indexOf('window.__shellPluginName = "alpha"')
  const codeAt = script.indexOf('var a = 1;')
  assert.ok(nameAt >= 0 && codeAt > nameAt)
  assert.ok(script.trimEnd().endsWith('})()'))
  const resetAt = script.lastIndexOf('window.__shellPluginName = null;')
  assert.ok(resetAt > codeAt, 'сброс имени — после кода плагинов')
})

test('buildInjectScript: код обёрнут в IIFE с собственным chrome и try/catch', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('alpha', { code: 'var a = 1;' })],
  })
  assert.match(script, /const chrome = window\.__shellChromeFor\("alpha"\);/)
  assert.match(script, /window\.__shellPluginError\["alpha"\] = __msg;/)
  assert.match(script, /if \(!window\.__shellPlugins\["alpha"\]\)/)
})

test('buildInjectScript: init плагина выполняется и его ошибка помечена :init', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('alpha', { code: 'var a = 1;', init: 'window.__ready = 1;' })],
  })
  assert.match(script, /window\.__ready = 1;/)
  assert.match(script, /window\.__shellPluginError\["alpha:init"\] = __msg;/)
  assert.ok(
    script.indexOf('window.__ready = 1;') > script.indexOf('var a = 1;'),
    'init идёт после кода',
  )
})

test('buildInjectScript: каждый плагин без повторов, порядок сохраняется', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('a', { code: '1;' }), plugin('b', { code: '2;' }), plugin('c', { code: '3;' })],
  })
  assert.equal(script.split('window.__shellPluginName = "a"').length - 1, 1)
  assert.ok(
    script.indexOf('window.__shellPluginName = "a"') <
      script.indexOf('window.__shellPluginName = "b"'),
  )
})

test('buildInjectScript: кавычки в имени плагина не ломают скрипт', () => {
  const script = buildInjectScript({
    stores: {},
    pollHost: false,
    shim: SHIM,
    plugins: [plugin('we"ird\\name', { code: '1;' })],
  })
  assert.match(script, /window\.__shellPluginName = "we\\"ird\\\\name"/)
})

test('parseInjectResult: разбирает JSON-строку', () => {
  assert.deepEqual(parseInjectResult('{"a":"boom","b":"bang"}'), { a: 'boom', b: 'bang' })
})

test('parseInjectResult: мусор и не-строка дают пустой отчёт', () => {
  assert.deepEqual(parseInjectResult(null), {})
  assert.deepEqual(parseInjectResult(undefined), {})
  assert.deepEqual(parseInjectResult(42), {})
  assert.deepEqual(parseInjectResult(''), {})
  assert.deepEqual(parseInjectResult('{не json'), {})
  assert.deepEqual(parseInjectResult('[1,2]'), {})
  assert.deepEqual(parseInjectResult('null'), {})
  assert.deepEqual(parseInjectResult('42'), {})
})

test('parseInjectResult: нестроковые и пустые значения отбрасываются', () => {
  assert.deepEqual(parseInjectResult('{"a":"x","b":5,"c":"","d":null}'), { a: 'x' })
})

test('checkPluginSyntax: валидный код — без ошибки, пустой — тоже', () => {
  assert.equal(checkPluginSyntax('var a = 1;'), null)
  assert.equal(checkPluginSyntax(''), null)
  assert.equal(checkPluginSyntax('function f(){return 1}'), null)
})

test('checkPluginSyntax: битый код возвращает текст ошибки', () => {
  const err = checkPluginSyntax('function ( {')
  assert.equal(typeof err, 'string')
  assert.ok(err && err.length > 0)
})

test('selectInjectable: без кода и init плагин выпадает молча', () => {
  const res = selectInjectable([plugin('empty'), plugin('styled', { styles: 'a{}' })])
  assert.deepEqual(res.ok.map((p) => p.name), [])
  assert.deepEqual(res.problems, [])
})

test('selectInjectable: битый плагин выпадает с отчётом, остальные остаются', () => {
  const res = selectInjectable([
    plugin('good', { code: 'var a = 1;' }),
    plugin('bad', { code: 'function ( {' }),
    plugin('good2', { code: 'var b = 2;' }),
  ])
  assert.deepEqual(res.ok.map((p) => p.name), ['good', 'good2'])
  assert.equal(res.problems.length, 1)
  assert.equal(res.problems[0].name, 'bad')
})

test('selectInjectable: битый init тоже выбрасывает плагин', () => {
  const res = selectInjectable([plugin('x', { code: '1;', init: 'function ( {' })])
  assert.deepEqual(res.ok.map((p) => p.name), [])
  assert.equal(res.problems[0].name, 'x')
})

test('selectInjectable: плагин только с init остаётся', () => {
  const res = selectInjectable([plugin('only-init', { init: 'window.__ready = 1;' })])
  assert.deepEqual(res.ok.map((p) => p.name), ['only-init'])
  assert.deepEqual(res.problems, [])
})