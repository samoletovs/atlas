const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function backend() {
  const repos = [];
  const shares = [];
  const reads = [];
  const cache = new Map();
  const container = (kind, rows, partitionField) => ({
    item(id, partition) {
      reads.push({ kind, id, partition });
      return { read: async () => ({ resource: rows.find(row => row.id === id && row[partitionField] === partition) }) };
    },
    items: {
      create: async row => { rows.push(row); return { resource: row }; },
      upsert: async row => {
        const index = rows.findIndex(old => old.id === row.id && old[partitionField] === row[partitionField]);
        if (index < 0) rows.push(row); else rows[index] = row;
        return { resource: row };
      },
      query(query) {
        const params = new Map(query.parameters.map(p => [p.name, p.value]));
        let result = rows;
        if (params.has('@repoId')) result = result.filter(row => row.repoId === params.get('@repoId'));
        if (params.has('@login')) result = result.filter(row =>
          (kind === 'repos' ? row.ownerId : row.githubLogin) === params.get('@login'));
        if (kind === 'shares') result = result.filter(row => !row.revokedAt);
        if (query.query.includes('TOP 2')) result = result.slice(0, 2);
        return { fetchAll: async () => ({ resources: result }) };
      },
    },
  });
  const repoContainer = container('repos', repos, 'ownerId');
  const cosmos = {
    reposContainer: () => repoContainer,
    repoSharesContainer: () => container('shares', shares, 'repoId'),
    usersContainer: () => ({
      item: id => ({ read: async () => ({ resource: {
        id, userId: id, githubLogin: id, githubId: 123, createdAt: '2026-01-01',
      } }) }),
    }),
    lessonsV2Container: () => ({ items: { create: async row => ({ resource: row }) } }),
    AUTO_GEN_DEFAULTS: { autoGenerate: false, intervalHours: 24, unreadTarget: 20 },
  };
  const stubs = {
    'shared/cosmos.ts': cosmos,
    'shared/crypto.ts': { decryptSecret() { throw new Error('Unexpected token access'); } },
    'shared/quota.ts': { getQuotaState: async () => ({ used: 0, limit: null, remaining: null, resetAt: '2026-09-19' }) },
  };
  function load(relative) {
    const key = relative.replaceAll('\\', '/');
    if (stubs[key]) return stubs[key];
    if (cache.has(key)) return cache.get(key);
    const filename = path.resolve(__dirname, '../src', relative);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    cache.set(key, exports);
    vm.runInNewContext(compiled, {
      exports, Error, Buffer, URLSearchParams, process: { env: { NODE_ENV: 'production' } },
      require(name) {
        if (name === '@azure/functions') return { app: { http() {} } };
        assert.ok(name.startsWith('.'), `Unexpected dependency ${name}`);
        return load(path.relative(path.resolve(__dirname, '../src'),
          path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))));
      },
    }, { filename });
    return exports;
  }
  const github = load('shared/github.ts');
  stubs['shared/github.ts'] = {
    ...github,
    getGithubTokenFromRequest: () => null,
    fetchRepoMetadata: async (owner, repo) => ({
      ok: true,
      meta: { owner, repo, name: repo, htmlUrl: `https://github.com/${owner}/${repo}`, isPrivate: false },
    }),
  };
  const auth = load('shared/auth.ts');
  const request = (login, repoId, body = {}) => ({
    headers: new Map([['x-ms-client-principal', Buffer.from(JSON.stringify({
      userId: login, userDetails: login, identityProvider: 'github', userRoles: ['authenticated'],
    })).toString('base64')]]),
    query: new URLSearchParams(repoId === undefined ? {} : { repoId }),
    json: async () => body,
  });
  const ctx = { log() {}, error() {} };
  const add = (login, url) => load('functions/addRepo.ts').addRepo(request(login, undefined, { githubUrl: url }), ctx);
  return { repos, shares, reads, auth, request, ctx, add, load };
}

test('third-party repositories resolve the stored owner partition and preserve owner/member permissions', async () => {
  const api = backend();
  const created = await api.add('reader', 'https://github.com/upstream/project');
  assert.equal(created.status, 201);
  const owner = await api.auth.resolveRequest(api.request('reader', 'upstream__project'));
  assert.equal(owner.role, 'owner');
  assert.equal(owner.ownerLogin, 'reader');
  const invite = await api.load('functions/addShare.ts').addShare(
    api.request('reader', 'upstream__project', { githubLogin: 'member' }), api.ctx);
  assert.equal(invite.status, 200);
  const member = await api.auth.resolveRequest(api.request('member', 'upstream__project'));
  assert.equal(member.role, 'member');
  assert.equal(api.auth.requireOwner(member).status, 403);
  assert.equal((await api.auth.resolveRequest(api.request('outsider', 'upstream__project'))).status, 403);
  const me = await api.load('functions/getMe.ts').getMe(api.request('member'), api.ctx);
  assert.equal(me.jsonBody.allowedRepos[0].repoId, 'upstream__project');
  const settings = await api.load('functions/updateRepoSettings.ts').updateRepoSettings(
    api.request('reader', 'upstream__project', { autoGenerate: true }), api.ctx);
  assert.equal(settings.status, 200);
  assert.equal(api.reads.at(-1).partition, 'reader');
});

test('re-adding a third-party repository is idempotent and another user needs an invite', async () => {
  const api = backend();
  await api.add('reader', 'https://github.com/upstream/project');
  const existing = await api.add('reader', 'https://github.com/upstream/project');
  assert.equal(existing.status, 200);
  assert.equal(existing.jsonBody.alreadyExisted, true);
  assert.equal((await api.add('another', 'https://github.com/upstream/project')).status, 409);
  assert.equal(api.repos.length, 1);
});

for (const [owner, repo] of [['reader-name', 'project'], ['reader', 'project.docs']]) {
  test(`valid GitHub identifier ${owner}__${repo} is preserved`, async () => {
    const api = backend();
    await api.add(owner, `https://github.com/${owner}/${repo}`);
    const resolved = await api.auth.resolveRequest(api.request(owner, `${owner}__${repo}`));
    assert.equal(resolved.repoId, `${owner}__${repo}`);
    assert.equal(resolved.role, 'owner');
  });
}

test('malformed explicit repo IDs fail instead of falling through to the default', async () => {
  const api = backend();
  api.repos.push({ id: api.auth.DEFAULT_REPO_ID, repoId: api.auth.DEFAULT_REPO_ID, ownerId: 'reader' });
  for (const id of ['', 'bad', '-owner__repo', 'reader__a/b', 'reader__repo/', 'reader__repo ', 'reader__']) {
    assert.equal((await api.auth.resolveRequest(api.request('reader', id))).status, 400, id);
  }
  assert.equal((await api.auth.resolveRequest(api.request('reader'))).repoId, api.auth.DEFAULT_REPO_ID);
});

test('ambiguous repository partitions fail closed for owners, members, account listing and additions', async () => {
  const api = backend();
  const repoId = 'upstream__project';
  api.repos.push(...['reader', 'other'].map(ownerId => ({ id: repoId, repoId, ownerId })));
  api.shares.push({ id: `${repoId}_member`, repoId, githubLogin: 'member', role: 'member' });
  for (const login of ['reader', 'member']) {
    const access = await api.auth.resolveRequest(api.request(login, repoId));
    assert.equal(access.status, 409);
    assert.match(access.jsonBody.error, /ambiguous/i);
    const me = await api.load('functions/getMe.ts').getMe(api.request(login), api.ctx);
    assert.equal(me.status, 409);
  }
  assert.equal((await api.add('reader', 'https://github.com/upstream/project')).status, 409);
  assert.equal(api.repos.length, 2);
});

test('adding a repository queues a starter and leaves scheduling off', async () => {
  const api = backend();
  const result = await api.add('reader', 'https://github.com/reader/project');
  assert.equal(result.jsonBody.starterLesson.status, 'queued');
  assert.equal(result.jsonBody.starterLesson.body, '');
  assert.equal(result.jsonBody.repo.autoGenerate, false);
});
