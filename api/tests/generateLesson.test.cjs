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
const askSource = path.resolve(__dirname, '../src/functions/askLesson.ts');
const askCompiled = ts.transpileModule(readFileSync(askSource, 'utf8'), {
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

function loadShared(name, env, dependencies = {}) {
  const filename = path.resolve(__dirname, '../src/shared', name);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports, Buffer, Error, process: { env },
    require: key => {
      assert.ok(Object.hasOwn(dependencies, key), `Unexpected dependency: ${key}`);
      return dependencies[key];
    },
  }, { filename });
  return exports;
}

function endpoint(content, existing = [], options = {}) {
  const writes = [];
  let calls = 0;
  const requests = [];
  const env = { FOUNDRY_AOAI_ENDPOINT: 'https://synthetic.invalid', ...options.env };
  const budget = loadShared('budget.ts', env);
  const openai = loadShared('openaiClient.ts', env, {
    '@azure/identity': { DefaultAzureCredential: class {}, getBearerTokenProvider: () => async () => 'synthetic' },
    openai: { AzureOpenAI: class {
      constructor(configuration) {
        assert.equal(configuration.deployment, undefined, 'client must not pin the routine deployment');
        assert.equal(configuration.maxRetries, 0, 'hidden retries bypass the reservation');
        this.chat = { completions: { create: async request => {
          requests.push(request);
          calls++;
          return { choices: [{ finish_reason: options.finish ?? 'stop',
            message: { content, refusal: options.refusal ?? null } }] };
        } } };
      }
    } },
  });
  const exports = {};
  const dependencies = {
    '@azure/functions': { app: { http() {} } },
    '../shared/cosmos.js': {
      lessonsV2Container: () => ({
        item: () => ({ read: async () => ({ resource: lesson() }) }),
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
    '../shared/quota.js': {
      checkQuota: async () => ({ exceeded: false }),
      consumeAskTurn: async () => ({ exceeded: false }),
    },
    '../shared/budget.js': budget,
    '../shared/openaiClient.js': openai,
  };
  vm.runInNewContext(options.ask ? askCompiled : compiled, {
    exports, Error,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected external dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: sourcePath });
  return {
    writes, requests, budget, calls: () => calls,
    run: (body = {}) => (options.ask ? exports.askLesson : exports.generateLesson)(
      { params: { id: 'synthetic' }, json: async () => ({
        title: 'A synthetic lesson', topic: 'synthetic', question: 'Explain the trade-off', ...body,
      }) },
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

test('only deep lessons select Sol with low reasoning and a finite completion ceiling', async () => {
  const api = endpoint(JSON.stringify(lesson()));
  assert.equal((await api.run()).status, 201);
  assert.equal((await api.run({ depth: 'intermediate' })).status, 201);
  assert.equal((await api.run({ depth: 'deep' })).status, 201);
  assert.deepEqual(api.requests.map(r => r.model), ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-sol']);
  assert.deepEqual(api.requests.map(r => r.reasoning_effort), ['none', 'none', 'low']);
  assert.deepEqual(api.requests.map(r => r.max_completion_tokens), [1024, 1024, 4096]);
  assert.ok(api.requests.every(r => r.max_tokens === undefined && r.temperature === undefined));
});

test('a priced actual model can use an explicit deployment alias', async () => {
  const api = endpoint(JSON.stringify(lesson()), [], { env: {
    FOUNDRY_LESSON_DEPLOYMENT: 'approved-sol', FOUNDRY_LESSON_MODEL: 'gpt-6-sol',
  } });
  assert.equal((await api.run({ depth: 'deep' })).status, 201);
  assert.equal(api.requests[0].model, 'approved-sol');
  assert.equal(api.requests[0].reasoning_effort, 'low');
  assert.ok(api.budget.getBudgetStats().spentUsd > 0.04096, 'uncached input must also be reserved');
});

for (const model of ['gpt-4.1', 'gpt-4o-mini']) {
  test(`${model} remains callable for both tiers`, async () => {
    const api = endpoint(JSON.stringify(lesson()), [], { env: {
      FOUNDRY_DEPLOYMENT: model, FOUNDRY_LESSON_DEPLOYMENT: model,
    } });
    assert.equal((await api.run()).status, 201);
    assert.equal((await api.run({ depth: 'deep' })).status, 201);
    assert.ok(api.requests.every(r => r.model === model && r.temperature === 0.4));
    assert.deepEqual(api.requests.map(r => r.max_tokens), [1024, 4096]);
    assert.ok(api.requests.every(r => r.max_completion_tokens === undefined && r.reasoning_effort === undefined));
  });
}

test('a budget too small for the whole request refuses inference and publication', async () => {
  const api = endpoint(JSON.stringify(lesson()), [], { env: { ATLAS_DAILY_BUDGET_USD: '0.0001' } });
  assert.equal((await api.run({ depth: 'deep' })).status, 429);
  assert.equal(api.calls(), 0);
  assert.equal(api.writes.length, 0);
  assert.equal(api.budget.getBudgetStats().spentUsd, 0);
});

for (const options of [{ finish: 'length' }, { refusal: 'Refused' },
  { env: { FOUNDRY_MODEL: 'unknown' } }]) {
  test(`does not publish unsafe output/configuration: ${JSON.stringify(options)}`, async () => {
    const api = endpoint(JSON.stringify(lesson()), [], options);
    assert.equal((await api.run()).status, 502);
    assert.equal(api.writes.length, 0);
  });
}

test('oversized input cannot consume inference or overflow the short-context estimate', async () => {
  const api = endpoint(JSON.stringify(lesson()));
  assert.equal((await api.run({ rationale: 'x'.repeat(24_000) })).status, 502);
  assert.equal(api.calls(), 0);
});

test('budget reservation charges uncached input and reasoning output without overshoot', () => {
  const budget = loadShared('budget.ts', { ATLAS_DAILY_BUDGET_USD: '0.02' });
  budget.recordEstimatedCost('gpt-6-sol', 1000, 1000);
  assert.equal(budget.getBudgetStats().spentUsd, 0.012);
  assert.throws(() => budget.recordEstimatedCost('gpt-6-sol', 1000, 1000), budget.BudgetReservationError);
  assert.equal(budget.getBudgetStats().spentUsd, 0.012);
  assert.throws(() => budget.recordEstimatedCost('unknown', 1000, 1000), /No price/);
  assert.equal(budget.MODEL_PRICES['gpt-6-luna'].cachedInput, 0.01);
  assert.equal(budget.MODEL_PRICES['gpt-6-sol'].cachedInput, 0.20);
});

test('invalid configured budgets fail closed rather than silently granting five dollars', () => {
  for (const raw of ['invalid', '1junk', '0', '-1']) {
    assert.throws(() => loadShared('budget.ts', { ATLAS_DAILY_BUDGET_USD: raw }).checkBudget(), /positive number/);
  }
});

test('follow-up chat never selects the deep-lesson model', async () => {
  const api = endpoint('Synthetic answer', [], { ask: true });
  assert.equal((await api.run()).status, 200);
  assert.equal(api.requests[0].model, 'gpt-6-luna');
  assert.equal(api.requests[0].max_completion_tokens, 600);
  assert.equal(api.requests[0].reasoning_effort, 'none');
  assert.ok(api.budget.getBudgetStats().spentUsd > 0);
});

test('follow-up chat refuses an unaffordable request before inference', async () => {
  const api = endpoint('Synthetic answer', [], { ask: true, env: { ATLAS_DAILY_BUDGET_USD: '0.00001' } });
  assert.equal((await api.run()).status, 429);
  assert.equal(api.calls(), 0);
});

test('follow-up chat cannot return a truncated but otherwise plausible answer', async () => {
  const api = endpoint('Incomplete answer', [], { ask: true, finish: 'length' });
  assert.equal((await api.run()).status, 502);
});
