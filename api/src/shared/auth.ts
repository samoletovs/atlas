/**
 * Auth helper — read the SWA-injected x-ms-client-principal header.
 *
 * P2: GitHub-only. Authorisation is now driven by Cosmos:
 *   - role = 'owner' if the caller's GitHub login matches `repos.ownerId`
 *     for the requested `repoId`.
 *   - role = 'member' if a `repoShares` row exists with no `revokedAt`.
 *   - otherwise 403.
 *
 * Locally (no SWA header), pretend the request is from `samoletovs` so the
 * dev loop works against the new schema.
 */
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { repoSharesContainer, Repo, RepoShare } from './cosmos.js';
import { parseGithubUrl } from './github.js';
import { AmbiguousRepoError, findRepoById } from './repos.js';

export interface ClientPrincipal {
  userId: string;
  userDetails: string;       // for github: the lowercase login
  identityProvider: string;  // 'github' in P2
  userRoles: string[];
  claims?: { typ: string; val: string }[];
}

/** Default repo for direct-link routes that don't pass `?repoId=`. */
export const DEFAULT_REPO_ID = 'samoletovs__nauroLabs';
export const DEFAULT_OWNER_LOGIN = 'samoletovs';

export type AtlasRole = 'owner' | 'member';

export interface ResolvedRequest {
  principal: ClientPrincipal;
  /** GitHub login, lowercased — used as the partition key on `lessonProgress`. */
  userId: string;
  /** The `<owner>__<repo>` id used as the partition key on `lessons_v2`. */
  repoId: string;
  /** Atlas owner login (partition key on `repos`), from the stored doc. */
  ownerLogin: string;
  /** 'owner' if userId === repos.ownerId, else 'member'. */
  role: AtlasRole;
  /** The Repo doc, fetched as a side-effect of the role check. */
  repo: Repo;
}

export function getPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) {
    // Local dev: pretend it's samoletovs so the new schema is reachable.
    if (process.env.NODE_ENV !== 'production') {
      return {
        userId: 'samoletovs-local',
        userDetails: 'samoletovs',
        identityProvider: 'github',
        userRoles: ['authenticated'],
      };
    }
    return null;
  }
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(decoded) as ClientPrincipal;
  } catch {
    return null;
  }
}

/**
 * True when the principal is a signed-in GitHub user. We accept the `github`
 * provider (and `local` for dev). Beyond this, ACL is per-repo.
 */
export function isAuthenticated(p: ClientPrincipal | null): boolean {
  if (!p) return false;
  if (!Array.isArray(p.userRoles) || !p.userRoles.includes('authenticated')) {
    return false;
  }
  return p.identityProvider === 'github' || p.identityProvider === 'local';
}

function parseRepoIdParam(req: HttpRequest): string | null {
  const requested = req.query.get('repoId');
  if (requested === null) return DEFAULT_REPO_ID;
  const separator = requested.indexOf('__');
  if (separator < 1) return null;
  const owner = requested.slice(0, separator);
  const repo = requested.slice(separator + 2);
  // URL parsing also accepts a trailing slash/space, which an ID must not contain.
  if (!/^[a-z0-9._-]{1,100}$/i.test(repo)) return null;
  return parseGithubUrl(`https://github.com/${owner}/${repo}`) ? requested : null;
}

/**
 * Look up the caller's role for a given repo, or `null` if they have no
 * access. Used by `resolveRequest` and by `/api/me` when listing repos.
 */
export async function getRoleForRepo(
  userId: string,
  repoId: string,
): Promise<{ role: AtlasRole; repo: Repo } | null> {
  const repo = await findRepoById(repoId);
  if (!repo) return null;

  if (repo.ownerId === userId) {
    return { role: 'owner', repo };
  }

  const shares = repoSharesContainer();
  let share: RepoShare | undefined;
  try {
    const { resource } = await shares
      .item(`${repoId}_${userId}`, repoId)
      .read<RepoShare>();
    share = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }
  if (share && !share.revokedAt) {
    return { role: 'member', repo };
  }
  return null;
}

/**
 * Resolve the request into (principal, userId, repoId, role) for a route handler.
 * Returns either a ResolvedRequest or an HttpResponseInit short-circuit
 * (401 if not signed in, 403 if signed in but no role on the requested repo).
 */
export async function resolveRequest(
  req: HttpRequest,
): Promise<ResolvedRequest | HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }

  const repoId = parseRepoIdParam(req);
  if (repoId === null) {
    return { status: 400, jsonBody: { error: 'Invalid repoId (expected owner__repository)' } };
  }
  const userId = principal.userDetails.toLowerCase();

  let access: Awaited<ReturnType<typeof getRoleForRepo>>;
  try {
    access = await getRoleForRepo(userId, repoId);
  } catch (error) {
    if (error instanceof AmbiguousRepoError) {
      return { status: 409, jsonBody: { error: error.message } };
    }
    throw error;
  }
  if (!access) {
    return { status: 403, jsonBody: { error: 'Forbidden' } };
  }

  return {
    principal,
    userId,
    repoId,
    ownerLogin: access.repo.ownerId,
    role: access.role,
    repo: access.repo,
  };
}

/**
 * Type guard for the `resolveRequest` discriminated union. We can't use
 * `'status' in r` to narrow because HttpResponseInit.status is optional —
 * `principal` is required on ResolvedRequest, so checking for it works.
 */
export function isHttpResponse(
  r: ResolvedRequest | HttpResponseInit,
): r is HttpResponseInit {
  return !('principal' in r);
}

/**
 * Convenience for routes that require owner role (catalog writes, admin).
 * Returns the ResolvedRequest if owner, else a 403 short-circuit.
 */
export function requireOwner(
  r: ResolvedRequest,
): ResolvedRequest | HttpResponseInit {
  if (r.role !== 'owner') {
    return {
      status: 403,
      jsonBody: { error: 'Owner-only action' },
    };
  }
  return r;
}
