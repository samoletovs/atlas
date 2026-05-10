/**
 * GET /api/admin/shares?repoId=<repoId>
 *
 * Owner-only. Returns the list of `repoShares` rows for the given repo,
 * including revoked ones (so the owner can audit). Each row has:
 *   { id, repoId, githubLogin, role, invitedBy, createdAt, revokedAt }
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { repoSharesContainer, RepoShare } from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse, requireOwner } from '../shared/auth.js';

export async function listShares(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const ownerCheck = requireOwner(r);
  if (isHttpResponse(ownerCheck)) return ownerCheck;
  const { repoId } = r;

  const shares = repoSharesContainer();
  const { resources } = await shares.items
    .query<RepoShare>(
      { query: 'SELECT * FROM c WHERE c.repoId = @repoId', parameters: [{ name: '@repoId', value: repoId }] },
      { partitionKey: repoId },
    )
    .fetchAll();

  // Sort: active first (no revokedAt), newest first.
  resources.sort((a, b) => {
    const aActive = !a.revokedAt;
    const bActive = !b.revokedAt;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return { status: 200, jsonBody: { repoId, shares: resources } };
}

app.http('listShares', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'admin/shares',
  handler: listShares,
});
