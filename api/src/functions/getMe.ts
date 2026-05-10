/**
 * GET /api/me
 *
 * Returns the resolved Atlas user for the current SWA principal. On first
 * call after sign-in, upserts a `users` doc in Cosmos with the GitHub login,
 * numeric id (resolved via the public GitHub API), and createdAt.
 *
 * P1: only allowlisted logins reach this code (resolveRequest gates).
 * P3+: this is also where BYOK metadata will be returned alongside the user.
 *
 * Response shape:
 *   {
 *     userId: 'samoletovs',
 *     githubLogin: 'samoletovs',
 *     githubId: 12345,            // numeric id, or null if lookup failed
 *     createdAt: '...',
 *     allowedRepos: [{ repoId, name, ownerId, visibility }]
 *   }
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  usersContainer,
  reposContainer,
  AtlasUser,
  Repo,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse, DEFAULT_REPO_ID } from '../shared/auth.js';

interface MeResponse {
  userId: string;
  githubLogin: string;
  githubId: number | null;
  createdAt: string;
  allowedRepos: Array<Pick<Repo, 'repoId' | 'name' | 'ownerId' | 'visibility' | 'githubUrl'>>;
}

/** Fetch a GitHub user's numeric id via the unauthenticated public API. */
async function fetchGithubId(login: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { 'User-Agent': 'atlas-naurolabs', Accept: 'application/vnd.github+json' },
      // node 20+ has a default timeout; nothing to set.
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
  const r = resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const { userId, principal } = r;

  // Read or create the user doc.
  const users = usersContainer();
  let user: AtlasUser | undefined;
  try {
    const { resource } = await users.item(userId, userId).read<AtlasUser>();
    user = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  if (!user) {
    // First sign-in for this login — resolve numeric id and persist.
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
    // Backfill numeric id if missing (migration created the doc without it).
    const githubId = await fetchGithubId(principal.userDetails);
    if (githubId) {
      user.githubId = githubId;
      await users.items.upsert(user);
      ctx.log(`getMe: backfilled githubId=${githubId} for ${userId}`);
    }
  }

  // Repos this user can use. P1: just the default repo (the migration
  // created it). P2 will UNION this with `repoShares.role='member'`.
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

  // If the user has nothing yet (rare — migration covers samoletovs), surface
  // the default repo entry so the UI has something to show.
  const allowedRepos = ownedRepos.length
    ? ownedRepos
    : [
        {
          id: DEFAULT_REPO_ID,
          repoId: DEFAULT_REPO_ID,
          ownerId: userId,
          name: DEFAULT_REPO_ID.split('__', 2)[1] ?? DEFAULT_REPO_ID,
          githubUrl: `https://github.com/${userId}`,
          visibility: 'private' as const,
          createdAt: new Date().toISOString(),
        },
      ];

  const response: MeResponse = {
    userId: user.userId,
    githubLogin: user.githubLogin,
    githubId: user.githubId ?? null,
    createdAt: user.createdAt,
    allowedRepos: allowedRepos.map((rp) => ({
      repoId: rp.repoId,
      name: rp.name,
      ownerId: rp.ownerId,
      visibility: rp.visibility,
      githubUrl: rp.githubUrl,
    })),
  };

  return { status: 200, jsonBody: response };
}

app.http('getMe', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: getMe,
});
