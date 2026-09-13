const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/functions/generateLesson.ts');
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function lesson(overrides = {}) {
  return {
    title: 'A synthetic lesson', topic: 'synthetic', depth: 'intro',
    read_minutes: 3, body: 'A useful concept explained clearly.',
    citations: ['https://example.invalid/source'],
    suggested_next: [{ title: 'Another concept', topic: 'next', rationale: 'Build on this.' }],
    ...overrides,
  };
}

function endpoint(content, existing = []) {
  const writes = [];
  let calls = 0;
  const exports = {};
  const dependencies = {
    '@azure/functions': { app: { http() {} } },
    '../shared/cosmos.js': {
      lessonsV2Container: () => ({
        items: {
          query: () => ({ fetchAll: async () => ({ resources: existing }) }),
          create: async (document) => { writes.push(document); return { resource: document }; },
        },
      }),
    },
    '../shared/auth.js': {
      resolveRequest: async () => ({ userId: 'test', repoId: 'test', ownerLogin: 'test' }),
      isHttpResponse: () => false, requireOwner: () => undefined,
    },
    '../shared/quota.js': { checkQuota: async () => ({ exceeded: false }) },
    '../shared/budget.js': {
      checkBudget: () => ({ exceeded: false }), recordEstimatedCost() {},
    },
    '../shared/openaiClient.js': {
      getOpenAIClientForUser: async () => ({
        deployment: 'synthetic',
        client: { chat: { completions: { create: async () => {
          calls++;
          return { choices: [{ finish_reason: 'stop', message: { content } }] };
        } } } },
      }),
    },
  };
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected external dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: sourcePath });
  return {
    writes, calls: () => calls,
    run: () => exports.generateLesson(
      { json: async () => ({ title: 'A synthetic lesson', topic: 'synthetic' }) },
      { log() {}, error() {} },
    ),
  };
}

test('publishes valid model output exactly once', async () => {
  const input = lesson();
  const handler = endpoint(JSON.stringify(input));
  const response = await handler.run();
  assert.equal(response.status, 201);
  assert.equal(handler.writes.length, 1);
  assert.equal(handler.writes[0].body, input.body);
  assert.equal(handler.writes[0].status, 'published');
});

for (const heading of ['## Sources', '**REFERENCES**', 'Next steps:']) {
  test(`removes ${heading} without losing valid prose or structured metadata`, async () => {
    const input = lesson({ body: `Keep this explanation.\n\n${heading}\nhttps://example.invalid/extra` });
    const handler = endpoint(JSON.stringify(input));
    const response = await handler.run();
    assert.equal(response.status, 201);
    assert.equal(handler.writes[0].body, 'Keep this explanation.');
    assert.deepEqual(JSON.parse(JSON.stringify(handler.writes[0].citations)), input.citations);
    assert.deepEqual(JSON.parse(JSON.stringify(handler.writes[0].suggested_next)), input.suggested_next);
  });
}

test('salvages citations when a removable section is their only source', async () => {
  const handler = endpoint(JSON.stringify(lesson({
    citations: [], body: 'Keep the concept.\n\n## Sources\nhttps://example.invalid/source',
  })));
  assert.equal((await handler.run()).status, 201);
  assert.equal(handler.writes[0].citations[0], 'https://example.invalid/source');
});

for (const [name, content] of [
  ['empty response', ''],
  ['invalid JSON', '{broken'],
  ['missing body', JSON.stringify({ title: 'Title' })],
  ['blank body', JSON.stringify(lesson({ body: ' ' }))],
  ['non-string body', JSON.stringify(lesson({ body: {} }))],
  ['non-string title', JSON.stringify(lesson({ title: {} }))],
  ['only a prohibited section', JSON.stringify(lesson({ body: '## Sources\nhttps://example.invalid' }))],
]) {
  test(`rejects ${name} without publishing`, async () => {
    const handler = endpoint(content);
    assert.equal((await handler.run()).status, 502);
    assert.equal(handler.writes.length, 0);
  });
}

test('reuses an existing lesson without another model call or write', async () => {
  const existing = lesson({ id: 'existing', status: 'published' });
  const handler = endpoint('', [existing]);
  const response = await handler.run();
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.id, 'existing');
  assert.equal(handler.calls(), 0);
  assert.equal(handler.writes.length, 0);
});
