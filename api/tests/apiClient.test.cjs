const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../../src/lib/api.ts');
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadApi({ hostname = 'example.com', fetch = async () => response() } = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    window: { location: { hostname } },
    fetch,
    require(name) {
      if (name === './apiRoutes') return { RECOMMENDATIONS_PATH: '/api/recommendations' };
      if (name === '../../api/src/shared/lessonSuggestions') {
        return { recoverLessonSuggestions: lesson => lesson };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: sourcePath });
  return exports;
}

function response(body = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fetchRecorder(result = response()) {
  const calls = [];
  return {
    calls,
    fetch: async (...args) => {
      calls.push(args);
      return result;
    },
  };
}

const lesson = { id: 'lesson/1', title: 'A lesson', suggested_next: [] };

test('fetchUser returns the local development principal without fetching', async () => {
  const recorder = fetchRecorder();
  const api = loadApi({ hostname: 'localhost', fetch: recorder.fetch });

  assert.deepEqual(JSON.parse(JSON.stringify(await api.fetchUser())), {
    userId: 'samoletovs-local',
    userDetails: 'samoletovs',
    identityProvider: 'github',
    userRoles: ['authenticated'],
  });
  assert.equal(recorder.calls.length, 0);
});

test('fetchUser reads the authenticated principal', async () => {
  const principal = { userId: 'sam', userDetails: 'sam', userRoles: ['authenticated'] };
  const recorder = fetchRecorder(response({ clientPrincipal: principal }));
  const result = await loadApi({ fetch: recorder.fetch }).fetchUser();

  assert.deepEqual({ ...result }, principal);
  assert.equal(recorder.calls[0][0], '/.auth/me');
});

test('fetchUser returns null when authentication lookup fails', async () => {
  const api = loadApi({ fetch: async () => response({}, 503) });
  assert.equal(await api.fetchUser(), null);
});

test('fetchMe returns the backend user on success', async () => {
  const me = { userId: 'sam', preferences: { lang: 'en' } };
  const recorder = fetchRecorder(response(me));
  assert.deepEqual({ ...await loadApi({ fetch: recorder.fetch }).fetchMe() }, me);
  assert.equal(recorder.calls[0][0], '/api/me');
});

for (const status of [401, 403]) {
  test(`fetchMe returns null for ${status}`, async () => {
    assert.equal(await loadApi({ fetch: async () => response({}, status) }).fetchMe(), null);
  });
}

test('fetchMe throws for unexpected HTTP failures', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 500) }).fetchMe(),
    /fetchMe failed: 500/,
  );
});

test('listLessons encodes filters and recovers lesson suggestions', async () => {
  const recorder = fetchRecorder(response({ lessons: [lesson] }));
  const result = await loadApi({ fetch: recorder.fetch }).listLessons('unread & new', 'ru/RU', 'owner__repo');

  assert.equal(result[0].id, lesson.id);
  assert.equal(
    recorder.calls[0][0],
    '/api/lessons?status=unread%20%26%20new&lang=ru%2FRU&repoId=owner__repo',
  );
});

test('listLessons throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 503) }).listLessons('unread'),
    /listLessons failed: 503/,
  );
});

test('getLesson encodes the ID and repo ID', async () => {
  const recorder = fetchRecorder(response(lesson));
  const result = await loadApi({ fetch: recorder.fetch }).getLesson('a/b', 'owner/repo');

  assert.equal(result.id, lesson.id);
  assert.equal(recorder.calls[0][0], '/api/lessons/a%2Fb?repoId=owner%2Frepo');
});

test('getLesson throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 404) }).getLesson('missing'),
    /getLesson failed: 404/,
  );
});

test('updateLessonState posts action and payload and includes API error detail', async () => {
  const recorder = fetchRecorder(response(lesson));
  const api = loadApi({ fetch: recorder.fetch });
  assert.equal((await api.updateLessonState('id/1', 'set_rating', 'repo', { rating: 5 })).id, lesson.id);
  assert.equal(recorder.calls[0][0], '/api/lessons/id%2F1/state?repoId=repo');
  assert.equal(recorder.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { action: 'set_rating', rating: 5 });
});

test('updateLessonState preserves server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Not allowed' }, 403) })
      .updateLessonState('id', 'save'),
    /updateLessonState failed: 403: Not allowed/,
  );
});

test('updateLessonState handles non-JSON error responses', async () => {
  const failed = { ok: false, status: 502, json: async () => { throw new Error('invalid JSON'); } };
  await assert.rejects(
    loadApi({ fetch: async () => failed }).updateLessonState('id', 'save'),
    /updateLessonState failed: 502$/,
  );
});

test('rateLesson delegates to state update with the rating', async () => {
  const recorder = fetchRecorder(response(lesson));
  await loadApi({ fetch: recorder.fetch }).rateLesson('id', null, 'repo');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { action: 'set_rating', rating: null });
});

test('commentLesson delegates to state update with the comment', async () => {
  const recorder = fetchRecorder(response(lesson));
  await loadApi({ fetch: recorder.fetch }).commentLesson('id', 'Useful', 'repo');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { action: 'set_comment', comment: 'Useful' });
});

test('queueLesson posts lesson input with repo ID', async () => {
  const recorder = fetchRecorder(response(lesson));
  const input = { title: 'Title', topic: 'topic', language: 'en' };
  assert.equal((await loadApi({ fetch: recorder.fetch }).queueLesson(input, 'repo')).id, lesson.id);
  assert.equal(recorder.calls[0][0], '/api/lessons/queue?repoId=repo');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), input);
});

test('queueLesson throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 429) }).queueLesson({}),
    /queueLesson failed: 429/,
  );
});

test('generateLessonNow posts input and returns a lesson', async () => {
  const recorder = fetchRecorder(response(lesson));
  const input = { title: 'Title', topic: 'topic', language: 'ru' };
  assert.equal((await loadApi({ fetch: recorder.fetch }).generateLessonNow(input, 'repo')).id, lesson.id);
  assert.equal(recorder.calls[0][0], '/api/lessons/generate?repoId=repo');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), input);
});

test('generateLessonNow includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Quota exceeded' }, 429) })
      .generateLessonNow({}),
    /generateLessonNow failed: 429: Quota exceeded/,
  );
});

test('listShares returns shares for the requested repo', async () => {
  const shares = [{ id: 'share', githubLogin: 'member' }];
  const recorder = fetchRecorder(response({ shares }));
  assert.deepEqual(await loadApi({ fetch: recorder.fetch }).listShares('repo/1'), shares);
  assert.equal(recorder.calls[0][0], '/api/shares?repoId=repo%2F1');
});

test('listShares throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 403) }).listShares('repo'),
    /listShares failed: 403/,
  );
});

test('addShare posts a GitHub login and returns the created share', async () => {
  const share = { id: 'share', githubLogin: 'member' };
  const recorder = fetchRecorder(response({ share }));
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).addShare('repo', 'member') },
    share,
  );
  assert.equal(recorder.calls[0][0], '/api/shares/invite?repoId=repo');
  assert.equal(recorder.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { githubLogin: 'member' });
});

test('addShare includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Already invited' }, 409) })
      .addShare('repo', 'member'),
    /addShare failed: 409: Already invited/,
  );
});

test('revokeShare encodes the login and returns the revoked share', async () => {
  const share = { id: 'share', githubLogin: 'some/user' };
  const recorder = fetchRecorder(response({ share }));
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).revokeShare('repo', 'some/user') },
    share,
  );
  assert.equal(recorder.calls[0][0], '/api/shares/some%2Fuser?repoId=repo');
  assert.equal(recorder.calls[0][1].method, 'DELETE');
});

test('revokeShare throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 404) }).revokeShare('repo', 'member'),
    /revokeShare failed: 404/,
  );
});

test('addRepo posts the GitHub URL and returns the result', async () => {
  const result = { repo: { repoId: 'owner__repo' }, starterLesson: null };
  const recorder = fetchRecorder(response(result));
  assert.deepEqual({ ...await loadApi({ fetch: recorder.fetch }).addRepo('https://github.com/owner/repo') }, result);
  assert.equal(recorder.calls[0][0], '/api/repos');
  assert.equal(recorder.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { githubUrl: 'https://github.com/owner/repo' });
});

test('addRepo includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Invalid repository' }, 400) })
      .addRepo('invalid'),
    /addRepo failed: 400: Invalid repository/,
  );
});

test('updateRepoSettings patches settings for the selected repo', async () => {
  const result = { repo: { repoId: 'owner__repo', autoGenerate: true } };
  const recorder = fetchRecorder(response(result));
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).updateRepoSettings('owner__repo', { autoGenerate: true }) },
    result,
  );
  assert.equal(recorder.calls[0][0], '/api/repos/settings?repoId=owner__repo');
  assert.equal(recorder.calls[0][1].method, 'PATCH');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { autoGenerate: true });
});

test('updateRepoSettings includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Owners only' }, 403) })
      .updateRepoSettings('repo', {}),
    /updateRepoSettings failed: 403: Owners only/,
  );
});

test('updatePreferences patches and returns synchronized preferences', async () => {
  const preferences = { theme: 'dark', lang: 'ru', updatedAt: 'now' };
  const recorder = fetchRecorder(response({ preferences }));
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).updatePreferences({ theme: 'dark', lang: 'ru' }) },
    preferences,
  );
  assert.equal(recorder.calls[0][0], '/api/me/preferences');
  assert.equal(recorder.calls[0][1].method, 'PATCH');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { theme: 'dark', lang: 'ru' });
});

test('updatePreferences throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 401) }).updatePreferences({ lang: 'en' }),
    /updatePreferences failed: 401/,
  );
});

test('askLesson posts question, history and repo ID', async () => {
  const result = { answer: 'An answer', lessonId: 'lesson' };
  const recorder = fetchRecorder(response(result));
  const history = [{ role: 'user', content: 'Earlier question' }];
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).askLesson('lesson/1', 'Why?', history, 'repo') },
    result,
  );
  assert.equal(recorder.calls[0][0], '/api/lessons/lesson%2F1/ask?repoId=repo');
  assert.equal(recorder.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { question: 'Why?', history });
});

test('askLesson includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Unavailable' }, 503) })
      .askLesson('lesson', 'Why?', []),
    /askLesson failed: 503: Unavailable/,
  );
});

test('getRecommendations encodes language and repo filters', async () => {
  const recorder = fetchRecorder(response({ lessons: [lesson] }));
  const result = await loadApi({ fetch: recorder.fetch }).getRecommendations('ru/RU', 'owner/repo');
  assert.equal(result[0].id, lesson.id);
  assert.equal(recorder.calls[0][0], '/api/recommendations?lang=ru%2FRU&repoId=owner%2Frepo');
});

test('getRecommendations throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 503) }).getRecommendations(),
    /getRecommendations failed: 503/,
  );
});

test('putGithubToken uploads the token and returns only token metadata', async () => {
  const githubToken = { scopes: ['repo'], addedAt: 'now' };
  const recorder = fetchRecorder(response({ githubToken }));
  assert.deepEqual(
    { ...await loadApi({ fetch: recorder.fetch }).putGithubToken('test-token') },
    githubToken,
  );
  assert.equal(recorder.calls[0][0], '/api/me/github-token');
  assert.equal(recorder.calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(recorder.calls[0][1].body), { token: 'test-token' });
});

test('putGithubToken includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'Token rejected' }, 400) })
      .putGithubToken('invalid'),
    /putGithubToken failed: 400: Token rejected/,
  );
});

test('deleteGithubToken accepts both successful and no-content responses', async () => {
  for (const status of [200, 204]) {
    const recorder = fetchRecorder(response({}, status));
    assert.equal(await loadApi({ fetch: recorder.fetch }).deleteGithubToken(), true);
    assert.equal(recorder.calls[0][0], '/api/me/github-token');
    assert.equal(recorder.calls[0][1].method, 'DELETE');
  }
});

test('deleteGithubToken throws on failed responses', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({}, 500) }).deleteGithubToken(),
    /deleteGithubToken failed: 500/,
  );
});

test('listMyGithubRepos returns null when no GitHub token is stored', async () => {
  assert.equal(
    await loadApi({ fetch: async () => response({}, 412) }).listMyGithubRepos(),
    null,
  );
});

test('listMyGithubRepos returns available repositories', async () => {
  const repos = [{ fullName: 'owner/repo', inAtlas: false }];
  const recorder = fetchRecorder(response({ repos }));
  assert.deepEqual(await loadApi({ fetch: recorder.fetch }).listMyGithubRepos(), repos);
  assert.equal(recorder.calls[0][0], '/api/github/repos');
});

test('listMyGithubRepos includes server error detail', async () => {
  await assert.rejects(
    loadApi({ fetch: async () => response({ error: 'GitHub unavailable' }, 502) })
      .listMyGithubRepos(),
    /listMyGithubRepos failed: 502: GitHub unavailable/,
  );
});
