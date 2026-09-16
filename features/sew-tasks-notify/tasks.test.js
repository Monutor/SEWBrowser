// Тесты чистой логики sew-tasks-notify (node:test, без зависимостей).
// tasks.js грузится и в node (экспорт через module.exports), и в гостя как текст.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sewTasksExtractIds, sewTasksDiffKnown } = require('./tasks.js');

test('extractIds: плоский массив объектов с id', () => {
  assert.deepEqual(sewTasksExtractIds([{ id: 'a' }, { id: 'b' }]), ['a', 'b']);
});

test('extractIds: обёртка { items: [...] } и поле taskId', () => {
  assert.deepEqual(sewTasksExtractIds({ items: [{ taskId: 7 }, { taskId: 9 }] }), ['7', '9']);
});

test('extractIds: мусор возвращает пустой массив', () => {
  assert.deepEqual(sewTasksExtractIds(null), []);
  assert.deepEqual(sewTasksExtractIds({ foo: 1 }), []);
  assert.deepEqual(sewTasksExtractIds('str'), []);
});

test('diffKnown: первый вызов — тихий базовый набор, новинок нет', () => {
  const known = new Set();
  assert.deepEqual(sewTasksDiffKnown(known, ['a', 'b']), []);
  assert.ok(known.has('a') && known.has('b'));
});

test('diffKnown: второй вызов возвращает только новые id', () => {
  const known = new Set(['a', 'b']);
  assert.deepEqual(sewTasksDiffKnown(known, ['a', 'b', 'c']), ['c']);
  assert.deepEqual(sewTasksDiffKnown(known, ['a', 'b', 'c']), []);
});
