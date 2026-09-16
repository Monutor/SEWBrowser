// Тесты чистой логики sew-tasks-notify (node:test, без зависимостей).
// tasks.js грузится и в node (экспорт через module.exports), и в гостя как текст.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sewTasksExtractIds, sewTasksDiffKnown, sewTasksMergeEndpoints, sewTasksPrepareSave } = require('./tasks.js');

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

test('mergeEndpoints: объединение сохранённых и выученных без дублей', () => {
  assert.deepEqual(
    sewTasksMergeEndpoints({ handover: ['/a'] }, { handover: ['/a', '/b'], relocation: ['/c'] }),
    { handover: ['/a', '/b'], relocation: ['/c'] },
  );
});

test('mergeEndpoints: мусор и чужие фиды отбрасываются, кап 5 на фид', () => {
  const persisted = { handover: 'x', relocation: ['/c'], other: ['/z'], __proto__: ['/p'] };
  const learned = { handover: ['/1', '/2', '/3', '/4', '/5', '/6', '/7'] };
  const merged = sewTasksMergeEndpoints(persisted, learned);
  assert.deepEqual(merged.relocation, ['/c']);
  assert.deepEqual(merged.handover, ['/1', '/2', '/3', '/4', '/5']);
  assert.ok(!('other' in merged));
});

test('mergeEndpoints: null/не-объекты дают пустой результат', () => {
  assert.deepEqual(sewTasksMergeEndpoints(null, undefined), {});
  assert.deepEqual(sewTasksMergeEndpoints('str', 42), {});
});

test('prepareSave: готовит JSON-чистый объект для plugin-data', () => {
  const save = sewTasksPrepareSave({ handover: ['/a', '/b'], relocation: [] });
  assert.deepEqual(save, { endpoints: { handover: ['/a', '/b'] } });
  assert.deepEqual(JSON.parse(JSON.stringify(save)), save);
});
