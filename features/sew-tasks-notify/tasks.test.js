// Тесты чистой логики sew-tasks-notify (node:test, без зависимостей).
// tasks.js грузится и в node (экспорт через module.exports), и в гостя как текст.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sewTasksExtractIds, sewTasksDiffKnown, sewTasksMergeEndpoints, sewTasksPrepareSave, sewTasksAuthNote, sewTasksShouldLearn, sewTasksAuthBody, sewTasksExtractAuth, sewTasksPollHeaders, sewTasksIsRelocationSearch, sewTasksNormalizeSearchBody, sewTasksMergeSearch, sewTasksIsTokenUrl, sewTasksExtractToken } = require('./tasks.js');

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

test('authNote: первый 401 в эпизоде — уведомить, повторы — молчать', () => {
  const state = {};
  assert.equal(sewTasksAuthNote(state, 'handover', 401), true);
  assert.equal(sewTasksAuthNote(state, 'handover', 401), false);
  assert.equal(sewTasksAuthNote(state, 'handover', 403), false);
});

test('authNote: успех сбрасывает эпизод, следующий 401 снова уведомляет', () => {
  const state = {};
  assert.equal(sewTasksAuthNote(state, 'relocation', 401), true);
  assert.equal(sewTasksAuthNote(state, 'relocation', 200), false);
  assert.equal(sewTasksAuthNote(state, 'relocation', 401), true);
});

test('authNote: не-auth ошибки (500, 0) не уведомляют', () => {
  const state = {};
  assert.equal(sewTasksAuthNote(state, 'handover', 500), false);
  assert.equal(sewTasksAuthNote(state, 'handover', 0), false);
  assert.deepEqual(state, {});
});

test('shouldLearn: app-config и не-списки не учим', () => {
  assert.equal(sewTasksShouldLearn('/api/io-handover-v2-bff/app-config'), false);
  assert.equal(sewTasksShouldLearn('/api/io-handover-v2-bff/task?objectId=S187&status=CREATED'), true);
  assert.equal(sewTasksShouldLearn(null), false);
});

test('shouldLearn: sentry-envelope не учим', () => {
  assert.equal(sewTasksShouldLearn('https://sew.mvideoeldorado.ru/api/errors/api/5/envelope/?sentry_version=7&sentry_key=abc'), false);
  assert.equal(sewTasksShouldLearn('/api/errors/api/5/envelope/?sentry_version=7'), false);
});

test('mergeEndpoints: сохранённый sentry-мусор вычищается', () => {
  assert.deepEqual(
    sewTasksMergeEndpoints({ handover: ['/api/errors/api/5/envelope/?sentry_version=7', '/a'] }, {}),
    { handover: ['/a'] },
  );
});

test('authBody: страница сама 200, а наш опрос 401 — так и пишем', () => {
  const body = sewTasksAuthBody(401, 200);
  assert.match(body, /страниц/i);
  assert.match(body, /200/);
  assert.match(body, /401/);
});

test('authBody: страница тоже 401 — просим войти заново', () => {
  assert.match(sewTasksAuthBody(401, 401), /тоже/i);
});

test('authBody: статусов страницы нет — старый текст с кликом', () => {
  assert.match(sewTasksAuthBody(401, null), /нажмите/i);
});

test('extractAuth: plain-объект с Authorization', () => {
  assert.equal(sewTasksExtractAuth({ Authorization: 'Bearer abc' }), 'Bearer abc');
});

test('extractAuth: ключ в нижнем регистре', () => {
  assert.equal(sewTasksExtractAuth({ authorization: 'Bearer xyz' }), 'Bearer xyz');
});

test('extractAuth: массив пар', () => {
  assert.equal(sewTasksExtractAuth([['Content-Type', 'application/json'], ['Authorization', 'Bearer t']]), 'Bearer t');
});

test('extractAuth: Headers-like через .get', () => {
  assert.equal(sewTasksExtractAuth({ get: (n) => (String(n).toLowerCase() === 'authorization' ? 'Bearer h' : null) }), 'Bearer h');
});

test('extractAuth: мусор даёт пустую строку', () => {
  assert.equal(sewTasksExtractAuth(null), '');
  assert.equal(sewTasksExtractAuth(undefined), '');
  assert.equal(sewTasksExtractAuth({}), '');
  assert.equal(sewTasksExtractAuth('Bearer x'), '');
});

test('pollHeaders: с токеном — Accept + Authorization', () => {
  assert.deepEqual(sewTasksPollHeaders('Bearer abc'), { Accept: 'application/json', Authorization: 'Bearer abc' });
});

test('pollHeaders: без токена — только Accept', () => {
  assert.deepEqual(sewTasksPollHeaders(''), { Accept: 'application/json' });
  assert.deepEqual(sewTasksPollHeaders(null), { Accept: 'application/json' });
  assert.deepEqual(sewTasksPollHeaders(undefined), { Accept: 'application/json' });
});

test('extractIds: ответ relocation/search (responseBody.relocations + relocationId)', () => {
  const data = { responseHeader: {}, responseBody: { relocations: [{ relocationId: 1498300 }, { relocationId: 1498280 }] } };
  assert.deepEqual(sewTasksExtractIds(data), ['1498300', '1498280']);
});

test('shouldLearn: деталку /relocation/<id> не учим (не список)', () => {
  assert.equal(sewTasksShouldLearn('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/1498280?objectId=S187'), false);
  assert.equal(sewTasksShouldLearn('/v2/api/io-relocation-bff/relocation/1498280'), false);
});

test('shouldLearn: GET на search-URL не учим как список (он опрашивается POST)', () => {
  assert.equal(sewTasksShouldLearn('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/search'), false);
});

test('isRelocationSearch: абсолютный и относительный URL детектит, остальное — нет', () => {
  assert.equal(sewTasksIsRelocationSearch('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/search'), true);
  assert.equal(sewTasksIsRelocationSearch('/v2/api/io-relocation-bff/relocation/search'), true);
  assert.equal(sewTasksIsRelocationSearch('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/1498280?objectId=S187'), false);
  assert.equal(sewTasksIsRelocationSearch('/api/io-handover-v2-bff/task?objectId=S187'), false);
  assert.equal(sewTasksIsRelocationSearch(null), false);
});

test('normalizeSearchBody: валидное тело с objectId — канонический JSON', () => {
  const body = { objectId: ['S187'], status: ['CREATED', 'IN_PROGRESS'], processCode: [], srcStock: [], dstStock: [], salesChannel: [], createTimeFrom: '', createTimeTo: '' };
  const norm = sewTasksNormalizeSearchBody(JSON.stringify(body));
  assert.equal(JSON.parse(norm).objectId[0], 'S187');
  assert.equal(sewTasksNormalizeSearchBody(body), norm);
});

test('normalizeSearchBody: мусор — null', () => {
  assert.equal(sewTasksNormalizeSearchBody(null), null);
  assert.equal(sewTasksNormalizeSearchBody('not-json'), null);
  assert.equal(sewTasksNormalizeSearchBody(JSON.stringify({ status: ['CREATED'] })), null);
  assert.equal(sewTasksNormalizeSearchBody(JSON.stringify({ objectId: [] })), null);
  assert.equal(sewTasksNormalizeSearchBody('x'.repeat(3000)), null);
});

test('normalizeSearchBody: вложенные фильтры в requestBody — валидны, структура сохраняется', () => {
  const body = { requestBody: { objectId: ['S187'], status: ['CREATED', 'IN_PROGRESS'], processCode: [], srcStock: [], dstStock: [], salesChannel: [], createTimeFrom: '', createTimeTo: '' } };
  const norm = sewTasksNormalizeSearchBody(JSON.stringify(body));
  assert.equal(JSON.parse(norm).requestBody.objectId[0], 'S187');
  assert.equal(sewTasksNormalizeSearchBody(body), norm);
});

test('normalizeSearchBody: пустой requestBody без objectId — null', () => {
  assert.equal(sewTasksNormalizeSearchBody(JSON.stringify({ requestBody: { status: ['CREATED'] } })), null);
  assert.equal(sewTasksNormalizeSearchBody(JSON.stringify({ requestBody: 'str' })), null);
});

test('mergeSearch: вложенный спек проходит валидацию спека', () => {
  const spec = { url: '/v2/api/io-relocation-bff/relocation/search', body: JSON.stringify({ requestBody: { objectId: ['S187'] } }) };
  assert.deepEqual(sewTasksMergeSearch(null, spec), { url: spec.url, body: JSON.stringify({ requestBody: { objectId: ['S187'] } }) });
});

test('mergeSearch: выученный спек бьёт сохранённый, мусор — откат к сохранённому', () => {
  const learned = { url: '/v2/api/io-relocation-bff/relocation/search', body: JSON.stringify({ objectId: ['S187'] }) };
  const persisted = { url: '/v2/api/io-relocation-bff/relocation/search', body: JSON.stringify({ objectId: ['S100'] }) };
  assert.deepEqual(sewTasksMergeSearch(persisted, learned), learned);
  assert.deepEqual(sewTasksMergeSearch(persisted, null), persisted);
  assert.equal(sewTasksMergeSearch(null, { url: '/x', body: '{}' }), null);
});

test('prepareSave: со спеком search кладёт его рядом с endpoints', () => {
  const spec = { url: '/v2/api/io-relocation-bff/relocation/search', body: JSON.stringify({ objectId: ['S187'] }) };
  const save = sewTasksPrepareSave({ handover: ['/a'] }, spec);
  assert.deepEqual(save, { endpoints: { handover: ['/a'] }, search: { relocation: spec } });
  assert.deepEqual(JSON.parse(JSON.stringify(save)), save);
});

test('pollHeaders: для POST добавляет Content-Type, по умолчанию — нет', () => {
  assert.deepEqual(
    sewTasksPollHeaders('Bearer abc', true),
    { Accept: 'application/json', Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
  );
  assert.deepEqual(sewTasksPollHeaders('Bearer abc'), { Accept: 'application/json', Authorization: 'Bearer abc' });
});

test('isTokenUrl: детектит openid-connect/token, остальное — нет', () => {
  assert.equal(sewTasksIsTokenUrl('https://sew.mvideoeldorado.ru/api/auth/v1/api/v1/auth/realms/master/openid-connect/token'), true);
  assert.equal(sewTasksIsTokenUrl('/api/auth/realms/master/openid-connect/token?x=1'), true);
  assert.equal(sewTasksIsTokenUrl('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/search'), false);
  assert.equal(sewTasksIsTokenUrl('https://sew.mvideoeldorado.ru/v2/api/io-relocation-bff/relocation/1498280'), false);
  assert.equal(sewTasksIsTokenUrl(null), false);
});

test('extractToken: accessToken/access_token из плоского JSON', () => {
  assert.equal(sewTasksExtractToken({ accessToken: 'jwt123', refreshToken: 'r', expiresIn: 7200 }), 'jwt123');
  assert.equal(sewTasksExtractToken({ access_token: 'abc' }), 'abc');
});

test('extractToken: мусор даёт пустую строку', () => {
  assert.equal(sewTasksExtractToken(null), '');
  assert.equal(sewTasksExtractToken('jwt'), '');
  assert.equal(sewTasksExtractToken([]), '');
  assert.equal(sewTasksExtractToken({}), '');
  assert.equal(sewTasksExtractToken({ accessToken: 42 }), '');
});
