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

function premiumLedger() {
  const records = new Map();
  const operations = [];
  let revision = 0;
  const save = document => {
    const record = { ...document, _etag: String(++revision) };
    records.set(document.id, record);
    return { resource: { ...record } };
  };
  return {
    records,
    operations,
    items: { create: async document => {
      operations.push('create');
      if (records.has(document.id)) throw Object.assign(new Error('Conflict'), { code: 409 });
      return save(document);
    } },
    item(id, partition) {
      assert.equal(partition, '__atlas_sol_budget__');
      return {
        read: async () => {
          operations.push('read');
          if (!records.has(id)) throw Object.assign(new Error('Not found'), { code: 404 });
          return { resource: { ...records.get(id) } };
        },
        replace: async (document, options) => {
          operations.push('replace');
          assert.equal(options.accessCondition.type, 'IfMatch');
          if (options.accessCondition.condition !== records.get(id)?._etag) {
            throw Object.assign(new Error('Precondition failed'), { code: 412 });
          }
          return save(document);
        },
      };
    },
  };
}

function budgetModule(env = {}, ledger = premiumLedger()) {
  return loadShared('budget.ts', env, { './cosmos.js': { usersContainer: () => ledger } });
}

function endpoint(content, existing = [], options = {}) {
  const writes = [];
  let calls = 0;
  let askTurns = 0;
  let clients = 0;
  const requests = [];
  const env = { FOUNDRY_AOAI_ENDPOINT: 'https://synthetic.invalid', ...options.env };
  const budget = budgetModule(env, options.ledger);
  const openai = loadShared('openaiClient.ts', env, {
    '@azure/identity': { DefaultAzureCredential: class {}, getBearerTokenProvider: () => async () => 'synthetic' },
    openai: { AzureOpenAI: class {
      constructor(configuration) {
        clients++;
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
        item: () => ({ read: async () => ({ resource: options.storedLesson ?? lesson() }) }),
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
      consumeAskTurn: async () => { askTurns++; return { exceeded: false }; },
    },
    '../shared/budget.js': budget,
    '../shared/openaiClient.js': openai,
    '../shared/lessonSuggestions.js': loadShared('lessonSuggestions.ts', {}),
  };
  vm.runInNewContext(options.ask ? askCompiled : compiled, {
    exports, Error,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected external dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: sourcePath });
  return {
    writes, requests, budget, calls: () => calls, askTurns: () => askTurns, clients: () => clients,
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

test('keeps the requested hierarchical topic even when the model rewrites it', async () => {
  const handler = endpoint(JSON.stringify(lesson({ topic: 'azure-functions' })));
  assert.equal((await handler.run({ topic: 'agent-platforms/azure-functions' })).status, 201);
  assert.equal(handler.writes[0].topic, 'agent-platforms/azure-functions');
});

test('publishes Russian next-topic JSON as suggestions instead of inert body text', async () => {
  const next = [
    { title: 'Основы Azure Functions', topic: 'agent-platforms/azure-functions', rationale: 'Понимание серверлесс-вычислений поможет в разработке кастомных решений.' },
    { title: 'Интеграция с Azure Logic Apps', topic: 'agent-platforms/logic-apps', rationale: 'Автоматизация процессов может улучшить эффективность вашего решения.' },
  ];
  const handler = endpoint(JSON.stringify(lesson({
    suggested_next: [], body: `Содержание урока.\n\n## Что изучать дальше\n${next.map(item => JSON.stringify(item)).join(',\n')}`,
  })));
  assert.equal((await handler.run({ language: 'ru' })).status, 201);
  assert.equal(handler.writes[0].body, 'Содержание урока.');
  assert.deepEqual(JSON.parse(JSON.stringify(handler.writes[0].suggested_next)), next);
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

test('a matching explicit deployment and model uses the full Sol reservation', async () => {
  const api = endpoint(JSON.stringify(lesson()), [], { env: {
    FOUNDRY_LESSON_DEPLOYMENT: 'gpt-6-sol', FOUNDRY_LESSON_MODEL: 'gpt-6-sol',
  } });
  assert.equal((await api.run({ depth: 'deep' })).status, 201);
  assert.equal(api.requests[0].model, 'gpt-6-sol');
  assert.equal(api.requests[0].reasoning_effort, 'low');
  assert.ok(api.budget.getBudgetStats().spentUsd > 0.04096, 'uncached input must also be reserved');
});

for (const model of ['gpt-4.1', 'gpt-4o-mini']) {
  test(`${model} remains callable for both tiers`, async () => {
    const api = endpoint(JSON.stringify(lesson()), [], { env: {
      FOUNDRY_DEPLOYMENT: model, FOUNDRY_MODEL: model,
      FOUNDRY_LESSON_DEPLOYMENT: model, FOUNDRY_LESSON_MODEL: model,
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

test('oversized deep input cannot consume inference or overflow the Sol bound', async () => {
  const api = endpoint(JSON.stringify(lesson()));
  assert.equal((await api.run({ depth: 'deep', rationale: 'x'.repeat(24_000) })).status, 502);
  assert.equal(api.calls(), 0);
});

test('the exact deep input bound does not become a routine input bound', () => {
  const helpers = loadShared('openaiClient.ts', {}, { '@azure/identity': {}, openai: {} });
  const messages = [{ role: 'user', content: 'x'.repeat(23984) }];
  assert.equal(helpers.estimateInputTokens(messages, 'deep-lesson'), 24000);
  messages[0].content += 'x';
  assert.throws(() => helpers.estimateInputTokens(messages, 'deep-lesson'), /24000/);
  assert.equal(helpers.estimateInputTokens(messages, 'routine'), 24001);
});

test('budget reservation charges uncached input and reasoning output without overshoot', async () => {
  const budget = budgetModule({ ATLAS_DAILY_BUDGET_USD: '0.02' });
  await budget.recordEstimatedCost('gpt-6-sol', 1000, 1000);
  assert.equal(budget.getBudgetStats().spentUsd, 0.012);
  await assert.rejects(budget.recordEstimatedCost('gpt-6-sol', 1000, 1000), budget.BudgetReservationError);
  assert.equal(budget.getBudgetStats().spentUsd, 0.012);
  await assert.rejects(budget.recordEstimatedCost('unknown', 1000, 1000), /No price/);
  assert.equal(budget.MODEL_PRICES['gpt-6-luna'].cachedInput, 0.01);
  assert.equal(budget.MODEL_PRICES['gpt-6-sol'].cachedInput, 0.20);
});

test('invalid configured budgets fail closed rather than silently granting five dollars', () => {
  for (const raw of ['invalid', '1junk', '0', '-1']) {
    assert.throws(() => budgetModule({ ATLAS_DAILY_BUDGET_USD: raw }).checkBudget(), /positive number/);
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

test('independent workers cannot jointly reserve more than ten cents of Sol in a UTC day', async () => {
  const ledger = premiumLedger();
  const first = budgetModule({}, ledger);
  const second = budgetModule({}, ledger);
  const settled = await Promise.allSettled([
    first.recordEstimatedCost('gpt-6-sol', 4000, 10000),
    second.recordEstimatedCost('gpt-6-sol', 4000, 10000),
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  assert.equal([...ledger.records.values()][0].reservedMicroUsd, 60000);
  const restarted = budgetModule({}, ledger);
  await assert.rejects(restarted.recordEstimatedCost('gpt-6-sol', 4000, 10000), /Sol daily/);
  await restarted.recordEstimatedCost('gpt-6-sol', 4000, 0);
  assert.equal([...ledger.records.values()][0].reservedMicroUsd, 100000);
  await assert.rejects(restarted.recordEstimatedCost('gpt-6-sol', 1, 0), /Sol daily/);
});

test('every Sol route waits for durable admission before inference and publication', async () => {
  const unavailable = premiumLedger();
  unavailable.item = () => ({ read: async () => { throw new Error('Cosmos unavailable'); } });
  const api = endpoint(JSON.stringify(lesson()), [], { ledger: unavailable });
  assert.equal((await api.run({ depth: 'deep' })).status, 502);
  assert.equal(api.calls(), 0);
  assert.equal(api.writes.length, 0);
});

test('the Sol cap can be lowered or disabled, never raised beyond ten cents', async () => {
  for (const raw of ['0.100001', '5', 'garbage', '']) {
    await assert.rejects(
      budgetModule({ ATLAS_SOL_DAILY_BUDGET_USD: raw }).recordEstimatedCost('gpt-6-sol', 1, 0),
      /ATLAS_SOL_DAILY_BUDGET_USD/,
    );
  }
  await assert.rejects(
    budgetModule({ ATLAS_SOL_DAILY_BUDGET_USD: '0' }).recordEstimatedCost('gpt-6-sol', 1, 0),
    /Sol daily/,
  );
});

test('an unconfirmed durable reservation cannot start inference or get refunded', async () => {
  const ledger = premiumLedger();
  const create = ledger.items.create;
  ledger.items.create = async document => {
    await create(document);
    throw new Error('Response lost after write');
  };
  const api = endpoint(JSON.stringify(lesson()), [], { ledger });
  assert.equal((await api.run({ depth: 'deep' })).status, 502);
  assert.equal(api.calls(), 0);
  assert.ok([...ledger.records.values()][0].reservedMicroUsd > 0);
});

test('malformed durable budget state fails closed', async () => {
  const ledger = premiumLedger();
  const day = new Date().toISOString().slice(0, 10);
  ledger.records.set(`sol-budget-${day}`, {
    id: `sol-budget-${day}`, userId: '__atlas_sol_budget__', date: day,
    kind: 'model-budget', reservedMicroUsd: -1, _etag: 'invalid',
  });
  await assert.rejects(budgetModule({}, ledger).recordEstimatedCost('gpt-6-sol', 1, 0), /Invalid Sol budget/);
});

test('the routine configuration cannot turn every lesson or chat into Sol', async () => {
  const api = endpoint(JSON.stringify(lesson()), [], { env: { FOUNDRY_DEPLOYMENT: 'gpt-6-sol' } });
  assert.equal((await api.run()).status, 502);
  assert.equal(api.calls(), 0);
});

test('two real lesson handlers share the premium allowance before either publishes', async () => {
  const ledger = premiumLedger();
  const first = endpoint(JSON.stringify(lesson()), [], { ledger });
  const second = endpoint(JSON.stringify(lesson()), [], { ledger });
  const request = { depth: 'deep', rationale: 'x'.repeat(5000) };
  const statuses = await Promise.all([first.run(request), second.run(request)]);
  assert.deepEqual(statuses.map(result => result.status).sort(), [201, 429]);
  assert.equal(first.calls() + second.calls(), 1);
  assert.equal(first.writes.length + second.writes.length, 1);
});

for (const [deployment, model] of [
  ['gpt-6-sol', 'gpt-6-luna'],
  ['gpt-6-sol', 'gpt-4o-mini'],
  ['gpt-6-luna', 'gpt-6-sol'],
  ['unverified-sol-alias', 'gpt-6-luna'],
]) {
  for (const route of ['routine lesson', 'deep lesson', 'follow-up']) {
    test(`${route} rejects ${deployment}/${model} before budget storage or inference with Sol disabled`, async () => {
      const ledger = premiumLedger();
      const prefix = route === 'deep lesson' ? 'FOUNDRY_LESSON' : 'FOUNDRY';
      const api = endpoint(JSON.stringify(lesson()), [], {
        ledger, ask: route === 'follow-up',
        env: {
          [`${prefix}_DEPLOYMENT`]: deployment, [`${prefix}_MODEL`]: model,
          ATLAS_SOL_DAILY_BUDGET_USD: '0',
        },
      });
      const response = await api.run(route === 'deep lesson' ? { depth: 'deep' } : {});
      assert.equal(response.status, 502);
      assert.match(response.jsonBody.error, /deployment|model/i);
      assert.equal(api.calls(), 0);
      assert.equal(api.clients(), 0);
      assert.equal(api.askTurns(), 0);
      assert.equal(api.writes.length, 0);
      assert.deepEqual(ledger.operations, []);
    });
  }
}

for (const [historyChars, lessonChars] of [[10000, 3000], [12000, 6000]]) {
  test(`routine Russian chat preserves ${historyChars} history and ${lessonChars} lesson characters`, async () => {
    const api = endpoint('Synthetic answer', [], {
      ask: true, storedLesson: lesson({ body: '\u044f'.repeat(lessonChars), language: 'ru' }),
    });
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: '\u0436'.repeat(historyChars / 8),
    }));
    const response = await api.run({ history, question: '\u043a'.repeat(1000) });
    assert.equal(response.status, 200);
    assert.equal(api.askTurns(), 1);
    assert.equal(api.calls(), 1);
    assert.equal(api.requests[0].model, 'gpt-6-luna');
    assert.equal(api.requests[0].messages.length, 10);
    assert.deepEqual(JSON.parse(JSON.stringify(api.requests[0].messages.slice(1, -1))), history);
    assert.ok(api.requests[0].messages[0].content.includes('\u044f'.repeat(lessonChars)));
    assert.ok(api.budget.getBudgetStats().spentUsd > 0);
  });
}

for (const [name, body] of [
  ['oversized question', { question: 'x'.repeat(1001) }],
  ['oversized history', { history: Array.from({ length: 8 }, () => ({
    role: 'user', content: 'x'.repeat(2000),
  })) }],
]) {
  test(`${name} fails before consuming a follow-up quota turn`, async () => {
    const api = endpoint('Synthetic answer', [], { ask: true });
    assert.equal((await api.run(body)).status, 400);
    assert.equal(api.askTurns(), 0);
    assert.equal(api.calls(), 0);
  });
}
