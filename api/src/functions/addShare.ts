/**
 * POST /api/admin/shares?repoId=<repoId>
 * Body: { githubLogin: string }
 *
 * Owner-only. Upserts a `repoShares` row granting `member` access to the
 * given GitHub login on the given repo. Idempotent — re-inviting an
 * already-active member is a no-op. Re-inviting a revoked member clears
 * `revokedAt` and refreshes `invitedAt`.
 *
 * GitHub login validation matches the GitHub username rules:
 *   - 1-39 chars, alphanumeric or hyphen
 *   - cannot start or end with a hyphen
 *   - no consecutive hyphens
 *
 * Returns 200 with the upserted RepoShare doc.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { repoSharesContainer, RepoShare } from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse, requireOwner } from '../shared/auth.js';

const GITHUB_LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export async function addShare(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const ownerCheck = requireOwner(r);
  if (isHttpResponse(ownerCheck)) return ownerCheck;
  const { repoId, userId: ownerUserId } = r;

  let body: { githubLogin?: string };
  try {
    body = (await req.json()) as { githubLogin?: string };
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const rawLogin = (body.githubLogin ?? '').trim();
  if (!rawLogin) {
    return { status: 400, jsonBody: { error: 'githubLogin is required' } };
  }
  if (!GITHUB_LOGIN_RE.test(rawLogin)) {
    return { status: 400, jsonBody: { error: 'Invalid GitHub login format' } };
  }
  const githubLogin = rawLogin.toLowerCase();

  // Don't let the owner invite themselves — they already have full access.
  if (githubLogin === ownerUserId) {
    return { status: 400, jsonBody: { error: 'Owner already has access' } };
  }

  const shares = repoSharesContainer();
  const id = `${repoId}_${githubLogin}`;

  // Try to read existing — re-inviting a revoked share should clear revokedAt.
  let existing: RepoShare | undefined;
  try {
    const { resource } = await shares.item(id, repoId).read<RepoShare>();
    existing = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  const now = new Date().toISOString();
  const doc: RepoShare = existing
    ? {
        ...existing,
        revokedAt: null,
        // Refresh invitedBy/createdAt only if it's a revoked re-invite.
        invitedBy: ownerUserId,
        createdAt: existing.revokedAt ? now : existing.createdAt,
      }
    : {
        id,
        repoId,
        githubLogin,
        role: 'member',
        invitedBy: ownerUserId,
        createdAt: now,
        revokedAt: null,
      };

  const { resource } = await shares.items.upsert(doc);
  ctx.log(`addShare: ${repoId} +${githubLogin} by ${ownerUserId}`);
  return { status: 200, jsonBody: { share: resource } };
}

app.http('addShare', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'admin/shares',
  handler: addShare,
});
