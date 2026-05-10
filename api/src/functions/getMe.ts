/**
 * GET /api/me
 *
 * Returns the resolved Atlas user for the current SWA principal. On first
 * call after sign-in, upserts a `users` doc in Cosmos with the GitHub login,
 * numeric id (resolved via the public GitHub API), and createdAt.
 *
 * P2: `allowedRepos` is the union of:
 *   - repos the user owns (`repos WHERE ownerId = @userId`)
 *   - repos shared with them (`repoShares WHERE userId = @userId AND !revokedAt`)
 *
 * Each entry includes a `role` field so the client can hide owner-only UI.
 *
 * If the user is signed in but has access to nothing, we still return the
 * user doc with an empty `allowedRepos` — the client renders the Forbidden
 * screen in that case.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  usersContainer,
  reposContainer,
  repoSharesContainer,
  AtlasUser,
  Repo,
  RepoShare,
} from '../shared/cosmos.js';
import { getPrincipal, isAuthenticated, AtlasRole } from '../shared/auth.js';
import { getQuotaState, QuotaState } from '../shared/quota.js';

interface AllowedRepoEntry {
  repoId: string;
  name: string;
  ownerId: string;
  visibility: Repo['visibility'];
  githubUrl: string;
  role: AtlasRole;
}

interface MeResponse {
  userId: string;
  githubLogin: string;
  githubId: number | null;
  createdAt: string;
  allowedRepos: AllowedRepoEntry[];
  /** P3: today's generation usage. null limit == uncapped. */
  quota: QuotaState;
}

/** Fetch a GitHub user's numeric id via the unauthenticated public API. */
async function fetchGithubId(login: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { 'User-Agent': 'atlas-naurolabs', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    return typeof data.id === 'number' ? data.id : null;
  } catch {
    return null;
  }
}

export async function getMe(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const userId = principal.userDetails.toLowerCase();

  // 1. Read or create the user doc.
  const users = usersContainer();
  let user: AtlasUser | undefined;
  try {
    const { resource } = await users.item(userId, userId).read<AtlasUser>();
    user = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  if (!user) {
    const githubId = await fetchGithubId(principal.userDetails);
    user = {
      id: userId,
      userId,
      githubLogin: principal.userDetails,
      githubId: githubId ?? undefined,
      createdAt: new Date().toISOString(),
    };
    await users.items.upsert(user);
    ctx.log(`getMe: created user ${userId} githubId=${user.githubId ?? 'null'}`);
  } else if (user.githubId === undefined) {
    const githubId = await fetchGithubId(principal.userDetails);
    if (githubId) {
      user.githubId = githubId;
      await users.items.upsert(user);
      ctx.log(`getMe: backfilled githubId=${githubId} for ${userId}`);
    }
  }

  // 2. Repos this user owns.
  const repos = reposContainer();
  const { resources: ownedRepos } = await repos.items
    .query<Repo>(
      {
        query: 'SELECT * FROM c WHERE c.ownerId = @login',
        parameters: [{ name: '@login', value: userId }],
      },
      { partitionKey: userId },
    )
    .fetchAll();

  // 3. Repos shared with this user (cross-partition since we don't know the repoIds yet).
  // `repoShares.id = ${repoId}_${githubLogin}` and partitions on repoId, but we
  // need to find rows by githubLogin. With no row count this is a small scan.
  const shares = repoSharesContainer();
  const { resources: shareRows } = await shares.items
    .query<RepoShare>({
      query:
        'SELECT * FROM c WHERE c.githubLogin = @login AND (NOT IS_DEFINED(c.revokedAt) OR IS_NULL(c.revokedAt))',
      parameters: [{ name: '@login', value: userId }],
    })
    .fetchAll();

  // Resolve each share row to its repo doc.
  const sharedRepos: Array<{ repo: Repo; role: AtlasRole }> = [];
  for (const share of shareRows) {
    const ownerLogin = share.repoId.split('__', 2)[0];
    try {
      const { resource } = await repos.item(share.repoId, ownerLogin).read<Repo>();
      if (resource) {
        sharedRepos.push({ repo: resource, role: 'member' });
      }
    } catch (e: unknown) {
      if (e instanceof Error && (e as { code?: number }).code === 404) continue;
      throw e;
    }
  }

  const allowedRepos: AllowedRepoEntry[] = [
    ...ownedRepos.map((rp) => ({
      repoId: rp.repoId,
      name: rp.name,
      ownerId: rp.ownerId,
      visibility: rp.visibility,
      githubUrl: rp.githubUrl,
      role: 'owner' as AtlasRole,
    })),
    ...sharedRepos.map(({ repo: rp, role }) => ({
      repoId: rp.repoId,
      name: rp.name,
      ownerId: rp.ownerId,
      visibility: rp.visibility,
      githubUrl: rp.githubUrl,
      role,
    })),
  ];

  const response: MeResponse = {
    userId: user.userId,
    githubLogin: user.githubLogin,
    githubId: user.githubId ?? null,
    createdAt: user.createdAt,
    allowedRepos,
    quota: await getQuotaState(userId),
  };

  return { status: 200, jsonBody: response };
}

app.http('getMe', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: getMe,
});
