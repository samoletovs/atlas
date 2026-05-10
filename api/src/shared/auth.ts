/**
 * Auth helper — read the SWA-injected x-ms-client-principal header.
 *
 * P1: GitHub-only. Single allowlist. Free-tier SWA so we can't use a
 * `rolesSource` Function — gating happens here. P2 will replace the allowlist
 * with a `repoShares` lookup (and either move to Standard tier with a real
 * `getRoles` Function, or keep it server-side here).
 *
 * Locally (no SWA header), pretend the request is from `samoletovs` so the
 * dev loop works against the new schema.
 */
import { HttpRequest, HttpResponseInit } from '@azure/functions';

export interface ClientPrincipal {
  userId: string;
  userDetails: string;       // for github: the lowercase login
  identityProvider: string;  // 'github' in P1
  userRoles: string[];
  claims?: { typ: string; val: string }[];
}

/**
 * GitHub logins allowed to use atlas in P1. Case-insensitive comparison.
 * P2 will replace this with a `repoShares` lookup keyed on the requested repo.
 */
export const ALLOWED_GITHUB_LOGINS = ['samoletovs'] as const;

/** Default repo for P1. Matches what the migration wrote into Cosmos. */
export const DEFAULT_REPO_ID = 'samoletovs__nauroLabs';
export const DEFAULT_OWNER_LOGIN = 'samoletovs';

export interface ResolvedRequest {
  principal: ClientPrincipal;
  /** GitHub login, lowercased — used as the partition key on `lessonProgress`. */
  userId: string;
  /** The `<owner>__<repo>` id used as the partition key on `lessons_v2`. */
  repoId: string;
  /** Owner login (partition key on `repos`). */
  ownerLogin: string;
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
 * True when the principal is a signed-in GitHub user whose login is in the
 * allowlist. We only accept the `github` provider — anything else (legacy
 * `aad` cookies, other providers) is rejected.
 */
export function isAuthorized(p: ClientPrincipal | null): boolean {
  if (!p) return false;
  if (!Array.isArray(p.userRoles) || !p.userRoles.includes('authenticated')) {
    return false;
  }
  if (p.identityProvider !== 'github' && p.identityProvider !== 'local') {
    return false;
  }
  const login = (p.userDetails ?? '').toLowerCase();
  return (ALLOWED_GITHUB_LOGINS as readonly string[]).includes(login);
}

/**
 * Resolve the request into (principal, userId, repoId) for the route handler.
 * Returns either a ResolvedRequest or an HttpResponseInit short-circuit
 * (401 if not signed in, 403 if signed in but not allowlisted).
 *
 * Routes use this as their first line:
 *   const r = resolveRequest(req);
 *   if (isHttpResponse(r)) return r;
 *   const { userId, repoId } = r;
 */
export function resolveRequest(req: HttpRequest): ResolvedRequest | HttpResponseInit {
  const principal = getPrincipal(req);
  if (!principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  if (!isAuthorized(principal)) {
    return { status: 403, jsonBody: { error: 'Forbidden' } };
  }
  // P1: every signed-in (allowlisted) user gets the default repo.
  // P2 will let the client pass `?repoId=` and check `repoShares`.
  const requested = req.query.get('repoId');
  const repoId = requested && /^[a-z0-9_]+__[a-z0-9_-]+$/i.test(requested)
    ? requested
    : DEFAULT_REPO_ID;
  return {
    principal,
    userId: principal.userDetails.toLowerCase(),
    repoId,
    ownerLogin: repoId.split('__', 2)[0],
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

