/**
 * GET /api/shares?repoId=<repoId>
 *
 * Owner-only. Returns the list of `repoShares` rows for the given repo,
 * including revoked ones (so the owner can audit). Each row has:
 *   { id, repoId, githubLogin, role, invitedBy, createdAt, revokedAt }
 *
 * NOTE: Originally this lived under `/api/admin/shares` but Azure Functions
 * v4 model couldn't dispatch GET vs POST when listShares and addShare both
 * registered the exact same route — every request returned 404. We split
 * the routes by giving addShare its own `/api/shares/invite` path. This
 * route stays singular and method-unique.
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
  route: 'shares',
  handler: listShares,
});
