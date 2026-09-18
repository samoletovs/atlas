const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const baselineRoot = process.env.ATLAS_RECOMMENDATIONS_SOURCE_ROOT;
if (baselineRoot && process.env.CI) throw new Error('Baseline source overrides are not permitted in CI.');

function load(relative, dependencies = {}) {
  const file = baselineRoot && relative.startsWith('../src/')
    ? path.resolve(baselineRoot, relative.slice('../src/'.length))
    : path.resolve(__dirname, relative);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Error, URLSearchParams,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return exports;
}

function endpoints({ forbidden = false, readAll = false, savedUnread = false } = {}) {
  const registrations = new Map();
  const queries = [];
  const itemReads = [];
  const authRequests = [];
  const lessons = [
    { id: 'intro', topic: 'deployment', depth: 'intro', created_at: '2026-01-01' },
    { id: 'next', topic: 'deployment', depth: 'intermediate', created_at: '2026-01-02' },
    { id: 'deep', topic: 'deployment', depth: 'deep', created_at: '2026-01-03' },
    { id: 'recommended-lesson', topic: 'storage', depth: 'intermediate', created_at: '2026-01-04' },
  ].map(lesson => ({
    ...lesson, repoId: 'example-repo', ownerId: 'example-owner', language: 'en',
    title: `Example ${lesson.id}`, status: 'published', body: 'Synthetic lesson.',
    citations: [], suggested_next: [], read_minutes: 4,
  }));
  const progress = (savedUnread ? [lessons[2]] : readAll ? lessons : [lessons[0]]).map(lesson => ({
    id: `example-reader_${lesson.id}`, userId: 'example-reader', repoId: 'example-repo',
    lessonId: lesson.id, status: savedUnread ? 'unread' : 'read', saved: savedUnread,
    readAt: savedUnread ? null : '2026-01-05',
  }));
  const container = (kind, records) => ({
    items: {
      query(query, options) {
        queries.push({ kind, query, options });
        const parameters = new Map(query.parameters.map(parameter => [parameter.name, parameter.value]));
        return { fetchAll: async () => ({ resources: records.filter(record =>
          record.repoId === parameters.get('@rid')
          && (kind === 'progress'
            ? record.userId === parameters.get('@uid')
            : record.language === parameters.get('@lang') && record.status === 'published')) }) };
      },
    },
    item(id, partitionKey) {
      itemReads.push({ kind, id, partitionKey });
      return { read: async () => ({ resource: records.find(record => record.id === id) }) };
    },
  });
  const dependencies = {
    '@azure/functions': { app: { http(name, config) { registrations.set(name, config); } } },
    '../shared/cosmos.js': {
      lessonsV2Container: () => container('lessons', lessons),
      lessonProgressContainer: () => container('progress', progress),
    },
    '../shared/auth.js': {
      resolveRequest: async request => {
        authRequests.push(request);
        return forbidden
          ? { status: 403, jsonBody: { error: 'Forbidden' } }
          : { userId: 'example-reader', repoId: 'example-repo' };
      },
      isHttpResponse: value => typeof value.status === 'number',
    },
    '../shared/adaptiveScoring.js': load('../src/shared/adaptiveScoring.ts'),
  };
  const recommendations = load('../src/functions/getRecommendations.ts', dependencies);
  const lesson = load('../src/functions/getLesson.ts', {
    ...dependencies, './getRecommendations.js': recommendations,
  });
  const context = { log() {}, error() {} };
  const request = (id, lang = 'en') => ({
    params: id ? { id } : {},
    query: new URLSearchParams({ repoId: 'example-repo', lang }),
  });
  return { registrations, queries, itemReads, authRequests, recommendations, lesson, context, request };
}

test('the canonical client URL and registered collection route cannot be mistaken for a lesson id', () => {
  const api = endpoints();
  const client = load('../../src/lib/apiRoutes.ts');
  const route = api.registrations.get('getRecommendations');
  assert.equal(route.route, 'recommendations');
  assert.equal(client.RECOMMENDATIONS_PATH, `/api/${route.route}`);
  assert.equal(api.registrations.get('getLesson').route, 'lessons/{id}');
  assert.deepEqual(JSON.parse(JSON.stringify(route.methods)), ['GET']);
});

test('recommendations return the existing ranking contract, scoped to the reader and repository', async () => {
  const api = endpoints();
  const response = await api.recommendations.getRecommendations(api.request(), api.context);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.lessons[0].id, 'next');
  assert.equal(response.jsonBody.lessons.length, 3);
  assert.ok(response.jsonBody.lessons.every(lesson => lesson.id !== 'intro'));
  assert.equal(typeof response.jsonBody.lessons[0].recommendation_reason, 'string');
  assert.equal(response.jsonBody.lessons[0].recommendation_score, 5);
  assert.equal(api.queries[0].options.partitionKey, 'example-reader');
  assert.equal(api.queries[1].options.partitionKey, 'example-repo');
  assert.equal(api.authRequests.length, 1);
});

test('unread saved lessons boost their topic without implying that its depth was read', async () => {
  const api = endpoints({ savedUnread: true });
  const response = await api.recommendations.getRecommendations(api.request(), api.context);
  const [first] = response.jsonBody.lessons;
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.lessons.length, 4);
  assert.equal(first.id, 'intro');
  assert.equal(first.recommendation_score, 7);
  assert.equal(first.recommendation_reason, 'Saved interest: new topic — great starting point');
  assert.ok(response.jsonBody.lessons.every(lesson => lesson.status === 'published'));
  assert.equal(response.jsonBody.lessons.find(lesson => lesson.id === 'deep').saved, true);
  assert.equal(response.jsonBody.lessons.find(lesson => lesson.id === 'deep').recommendation_score, 3);
});

for (const id of ['recommended', 'RECOMMENDED']) {
  test(`the legacy ${id} URL delegates before any lesson-id lookup`, async () => {
    const api = endpoints();
    const request = api.request(id);
    const response = await api.lesson.getLesson(request, api.context);
    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.lessons[0].id, 'next');
    assert.equal(api.itemReads.length, 0);
    assert.equal(api.authRequests.length, 1);
    assert.equal(api.authRequests[0], request);
  });
}

test('ordinary lesson identifiers still use the detail endpoint', async () => {
  const api = endpoints();
  const response = await api.lesson.getLesson(api.request('recommended-lesson'), api.context);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.id, 'recommended-lesson');
  assert.equal(api.itemReads[0].id, 'recommended-lesson');
  assert.equal(api.itemReads[0].partitionKey, 'example-repo');
  assert.equal(api.queries.length, 0);
});

test('canonical and legacy recommendation requests retain authorization checks', async () => {
  for (const legacy of [false, true]) {
    const api = endpoints({ forbidden: true });
    const response = legacy
      ? await api.lesson.getLesson(api.request('recommended'), api.context)
      : await api.recommendations.getRecommendations(api.request(), api.context);
    assert.equal(response.status, 403);
    assert.equal(api.queries.length, 0);
    assert.equal(api.itemReads.length, 0);
  }
});

test('an exhausted recommendation set is a successful empty collection, not a missing lesson', async () => {
  const api = endpoints({ readAll: true });
  const response = await api.lesson.getLesson(api.request('recommended'), api.context);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.lessons.length, 0);
});

test('the compatibility alias preserves the requested language', async () => {
  const api = endpoints();
  const response = await api.lesson.getLesson(api.request('recommended', 'ru'), api.context);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.lessons.length, 0);
  assert.equal(api.queries[1].query.parameters.find(parameter => parameter.name === '@lang').value, 'ru');
});
