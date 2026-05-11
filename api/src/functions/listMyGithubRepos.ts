/**
 * GET /api/github/repos
 *
 * Lists repos visible to the signed-in user via their stored PAT. Used by
 * the "Browse repos" picker in the Add-Repo flow — the user ticks one or
 * more entries and the client posts each to POST /api/repos.
 *
 * Returns 412 (Precondition Failed) if the user hasn't uploaded a token
 * yet — the client redirects them to /settings.
 *
 * Each entry includes `inAtlas: boolean` so the picker can grey out repos
 * the user has already added (or that someone else owns in atlas).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { usersContainer, reposContainer, AtlasUser, Repo } from '../shared/cosmos.js';
import { getPrincipal, isAuthenticated } from '../shared/auth.js';
import { decryptSecret } from '../shared/crypto.js';
import { fetchAccessibleRepos, GithubRepoListEntry } from '../shared/github.js';

interface GithubReposResponse {
  repos: Array<GithubRepoListEntry & { inAtlas: boolean; ownedByOther: boolean }>;
}

async function listMyGithubRepos(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const userId = principal.userDetails.toLowerCase();

  const users = usersContainer();
  let user: AtlasUser | undefined;
  try {
    const { resource } = await users.item(userId, userId).read<AtlasUser>();
    user = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }
  if (!user?.githubToken) {
    return {
      status: 412,
      jsonBody: {
        error: 'No GitHub token on file. Add one in Settings to browse your repos.',
      },
    };
  }

  let token: string;
  try {
    token = decryptSecret(user.githubToken.cipher);
  } catch (e) {
    ctx.error('listMyGithubRepos decrypt failed', e);
    return {
      status: 500,
      jsonBody: {
        error: 'Failed to decrypt your GitHub token. Re-paste it in Settings.',
      },
    };
  }

  const repos = await fetchAccessibleRepos(token);
  if (repos === null) {
    return {
      status: 502,
      jsonBody: {
        error: 'GitHub rejected the request. Your token may have been revoked — re-paste it in Settings.',
      },
    };
  }

  // Mark which ones are already in atlas. Single cross-partition query
  // gathers all repo IDs the caller currently sees as owner or member would
  // be more accurate, but for the picker UX it's enough to scan repos owned
  // by anyone whose id matches one of our entries — small set.
  const atlasRepos = reposContainer();
  const repoIds = repos.map((r) => `${r.owner}__${r.repo}`);
  let atlasRows: Repo[] = [];
  if (repoIds.length > 0) {
    const placeholders = repoIds.map((_, i) => `@id${i}`).join(', ');
    const parameters = repoIds.map((id, i) => ({ name: `@id${i}`, value: id }));
    const { resources } = await atlasRepos.items
      .query<Repo>({
        query: `SELECT c.repoId, c.ownerId FROM c WHERE c.repoId IN (${placeholders})`,
        parameters,
      })
      .fetchAll();
    atlasRows = resources;
  }
  const atlasByRepoId = new Map(atlasRows.map((r) => [r.repoId, r]));

  const out: GithubReposResponse = {
    repos: repos.map((r) => {
      const repoId = `${r.owner}__${r.repo}`;
      const inAtlas = atlasByRepoId.has(repoId);
      const ownedByOther =
        inAtlas && atlasByRepoId.get(repoId)!.ownerId !== userId;
      return { ...r, inAtlas, ownedByOther };
    }),
  };

  // Refresh lastUsedAt (best-effort; ignore write failures).
  try {
    user.githubToken.lastUsedAt = new Date().toISOString();
    await users.items.upsert(user);
  } catch {
    /* no-op */
  }

  ctx.log(`listMyGithubRepos: ${userId} -> ${out.repos.length} repos`);
  return { status: 200, jsonBody: out };
}

app.http('listMyGithubRepos', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'github/repos',
  handler: listMyGithubRepos,
});
