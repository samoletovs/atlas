/**
 * DELETE /api/admin/shares/{githubLogin}?repoId=<repoId>
 *
 * Owner-only. Soft-revokes a share by setting `revokedAt = now`. We don't
 * hard-delete so the audit trail (who invited whom, when) is preserved.
 *
 * The route segment {githubLogin} is the lowercased GitHub login. The
 * underlying doc id is `${repoId}_${githubLogin}` and partitions on repoId.
 *
 * Returns 200 with the updated RepoShare, 404 if no such share exists.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { repoSharesContainer, RepoShare } from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse, requireOwner } from '../shared/auth.js';

export async function revokeShare(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const ownerCheck = requireOwner(r);
  if (isHttpResponse(ownerCheck)) return ownerCheck;
  const { repoId, userId: ownerUserId } = r;

  const githubLogin = (req.params.githubLogin ?? '').trim().toLowerCase();
  if (!githubLogin) {
    return { status: 400, jsonBody: { error: 'githubLogin path param is required' } };
  }

  const shares = repoSharesContainer();
  const id = `${repoId}_${githubLogin}`;

  let existing: RepoShare | undefined;
  try {
    const { resource } = await shares.item(id, repoId).read<RepoShare>();
    existing = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  if (!existing) {
    return { status: 404, jsonBody: { error: 'Share not found' } };
  }

  if (existing.revokedAt) {
    // Already revoked — return current state, idempotent.
    return { status: 200, jsonBody: { share: existing } };
  }

  const updated: RepoShare = {
    ...existing,
    revokedAt: new Date().toISOString(),
  };
  const { resource } = await shares.items.upsert(updated);
  ctx.log(`revokeShare: ${repoId} -${githubLogin} by ${ownerUserId}`);
  return { status: 200, jsonBody: { share: resource } };
}

app.http('revokeShare', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'admin/shares/{githubLogin}',
  handler: revokeShare,
});
