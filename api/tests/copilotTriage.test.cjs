const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const workflow = readFileSync(path.resolve(__dirname, '../../.github/workflows/copilot-triage.yml'), 'utf8');
const script = workflow.split('          script: |')[1].split('\n')
  .map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');

async function triage(deployment, finish = 'stop') {
  const requests = [];
  const labels = [];
  const issues = {
    listForRepo: async () => ({ data: [] }),
    addLabels: async value => labels.push(...value.labels),
    createComment: async () => {},
    update: async () => { throw new Error('Unexpected issue close'); },
    addAssignees: async () => { throw new Error('Unexpected assignment'); },
  };
  await new vm.Script(`(async () => {${script}\n})()`).runInNewContext({
    context: { repo: { owner: 'example', repo: 'synthetic' },
      payload: { issue: { number: 1, title: 'Synthetic', body: 'Fixture', labels: [{ name: 'bug' }] } } },
    github: { rest: { issues } },
    process: { env: { AZURE_OPENAI_ENDPOINT: 'https://synthetic.invalid',
      AZURE_OPENAI_KEY: 'synthetic', TRIAGE_DEPLOYMENT: deployment } },
    require: name => {
      assert.equal(name, 'fs');
      return { existsSync: () => false };
    },
    console: { log() {} },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ choices: [{
        finish_reason: finish, message: { content: JSON.stringify({
          decision: finish === 'length' ? 'APPROVED' : 'NEEDS_INFO', confidence: 10,
        }) },
      }] }) };
    },
  });
  return { requests, labels };
}

test('Luna triage keeps the 300-token ceiling without legacy parameters', async () => {
  const { requests, labels } = await triage('gpt-6-luna');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /deployments\/gpt-6-luna\/chat\/completions/);
  assert.equal(requests[0].body.max_completion_tokens, 300);
  assert.equal(requests[0].body.reasoning_effort, 'none');
  assert.equal(requests[0].body.max_tokens, undefined);
  assert.equal(requests[0].body.temperature, undefined);
  assert.deepEqual(labels, ['needs-info']);
});

for (const model of ['gpt-4.1', 'gpt-4o-mini']) {
  test(`${model} rollback retains compatible parameters`, async () => {
    const { requests } = await triage(model);
    assert.equal(requests[0].body.max_tokens, 300);
    assert.equal(requests[0].body.temperature, 0.1);
    assert.equal(requests[0].body.max_completion_tokens, undefined);
    assert.equal(requests[0].body.reasoning_effort, undefined);
  });
}

test('a truncated but parseable approval cannot assign paid work', async () => {
  assert.deepEqual((await triage('gpt-6-luna', 'length')).labels, ['needs-review']);
});

for (const model of ['unknown-alias', 'gpt-4.1-nano']) {
  test(`${model} is not an allowed triage deployment or rollback`, async () => {
    await assert.rejects(triage(model), /supported actual model/);
  });
}
