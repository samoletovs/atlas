/**
 * POST /api/repos
 * Body: { githubUrl: string }
 *
 * Authenticated only. Any signed-in GitHub user can add a repo they have
 * access to (public always, private only if SWA is configured to expose
 * GitHub OAuth tokens to backend).
 *
 * Side effects:
 *   1. Validates the URL and resolves the repo via GitHub API.
 *   2. Computes `repoId = ${owner}__${repo}` (lowercased).
 *   3. Upserts a `repos` doc with `ownerId = caller`, `visibility = 'private'`.
 *      The caller is now the owner of this atlas namespace, regardless of
 *      who owns the upstream GitHub repo.
 *   4. Queues 1 starter lesson seeded from the README so the repo isn't empty.
 *      This queue does NOT count against the daily generation cap because
 *      it doesn't trigger an LLM call until the owner clicks "Generate".
 *
 * Returns: { repo, starterLesson }.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  reposContainer,
  lessonsV2Container,
  Repo,
  LessonV2,
} from '../shared/cosmos.js';
import { getPrincipal, isAuthenticated } from '../shared/auth.js';
import {
  parseGithubUrl,
  getGithubTokenFromRequest,
  fetchRepoMetadata,
} from '../shared/github.js';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export async function addRepo(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const userId = principal.userDetails.toLowerCase();

  let body: { githubUrl?: string };
  try {
    body = (await req.json()) as { githubUrl?: string };
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }
  const githubUrl = (body.githubUrl ?? '').trim();
  if (!githubUrl) {
    return { status: 400, jsonBody: { error: 'githubUrl is required' } };
  }

  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    return {
      status: 400,
      jsonBody: { error: 'Not a valid GitHub URL (expected https://github.com/<owner>/<repo>)' },
    };
  }
  const { owner: ghOwner, repo: ghRepo } = parsed;
  const repoId = `${ghOwner}__${ghRepo}`;

  // Reject duplicates regardless of who owns them — pick a different name first.
  const reposRef = reposContainer();
  let existing: Repo | undefined;
  try {
    const { resource } = await reposRef.item(repoId, ghOwner).read<Repo>();
    existing = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  // If the repo already exists in atlas:
  //   - belongs to the caller: return it (idempotent re-add).
  //   - belongs to someone else: 409 — they need to ask for an invite instead.
  if (existing) {
    if (existing.ownerId === userId) {
      return { status: 200, jsonBody: { repo: existing, alreadyExisted: true } };
    }
    return {
      status: 409,
      jsonBody: {
        error: `${ghOwner}/${ghRepo} is already in atlas. Ask its owner for an invite.`,
      },
    };
  }

  // Validate via GitHub API.
  const ghToken = getGithubTokenFromRequest(req);
  const metaRes = await fetchRepoMetadata(ghOwner, ghRepo, ghToken);
  if (!metaRes.ok) {
    if (metaRes.status === 404) {
      return {
        status: 404,
        jsonBody: {
          error: ghToken
            ? `${ghOwner}/${ghRepo} doesn't exist or you don't have access.`
            : `${ghOwner}/${ghRepo} not found. Private repos aren't supported on this tier yet.`,
        },
      };
    }
    if (metaRes.status === 403) {
      return {
        status: 502,
        jsonBody: { error: 'GitHub rate-limited the request. Try again in a few minutes.' },
      };
    }
    return {
      status: 502,
      jsonBody: { error: `GitHub API error (${metaRes.status})` },
    };
  }
  const meta = metaRes.meta;

  if (meta.isPrivate && !ghToken) {
    // Defense in depth — public-list filter should already block this, but
    // be explicit if GitHub returned a private repo with anon auth somehow.
    return {
      status: 403,
      jsonBody: { error: 'Private repos require an authenticated GitHub session.' },
    };
  }

  const now = new Date().toISOString();
  const newRepo: Repo = {
    id: repoId,
    repoId,
    ownerId: userId,
    name: meta.name,
    githubUrl: meta.htmlUrl,
    visibility: 'private',
    createdAt: now,
  };
  const { resource: createdRepo } = await reposRef.items.create(newRepo);
  ctx.log(`addRepo: created ${repoId} owned by ${userId}`);

  // Queue a starter "Welcome / Repo overview" lesson. The body stays empty
  // until the owner clicks Generate (or until a future scheduled job picks
  // it up). This is just to give the new repo something to look at in the
  // "Coming soon" section.
  let starterLesson: LessonV2 | null = null;
  try {
    const lessons = lessonsV2Container();
    const slug = slugify(meta.name) || 'overview';
    starterLesson = {
      id: `lesson-en-${slug}-overview-${Date.now().toString(36)}`,
      repoId,
      ownerId: userId,
      title: `Welcome to ${meta.name}`,
      topic: 'overview',
      depth: 'intro',
      read_minutes: 4,
      body: '',
      citations: [],
      suggested_next: [],
      source_event: meta.description
        ? { type: 'repo-meta', ref: meta.htmlUrl, summary: meta.description }
        : null,
      status: 'queued',
      language: 'en',
      created_at: now,
    };
    const { resource: createdLesson } = await lessons.items.create(starterLesson);
    starterLesson = (createdLesson as LessonV2 | undefined) ?? starterLesson;
  } catch (e) {
    // Don't fail the whole request if seeding the lesson fails — the repo is
    // already created and the owner can queue lessons themselves.
    ctx.log(`addRepo: starter lesson seed failed: ${e instanceof Error ? e.message : String(e)}`);
    starterLesson = null;
  }

  return {
    status: 201,
    jsonBody: { repo: createdRepo, starterLesson },
  };
}

app.http('addRepo', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'repos',
  handler: addRepo,
});
