/**
 * GitHub-token endpoints — store/refresh/clear the user's encrypted PAT.
 *
 *   PUT    /api/me/github-token   body: { token: string }
 *   DELETE /api/me/github-token
 *
 * The plaintext PAT is never persisted; we encrypt with AES-256-GCM using
 * the master key in `ATLAS_GITHUB_TOKEN_MASTER_KEY`. The token MUST belong
 * to the same GitHub user that's signed in to atlas — we verify by calling
 * `GET /user` and comparing the login. This stops a user from pasting
 * someone else's leaked token to silently elevate themselves.
 *
 * We do not require any specific scopes — the user is free to upload a
 * read-only or org-scoped token; the worst that happens is `addRepo` returns
 * 404 for repos the token can't see. We surface the reported scopes so the
 * UI can warn ("this token has no repo access").
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { usersContainer, AtlasUser } from '../shared/cosmos.js';
import { getPrincipal, isAuthenticated } from '../shared/auth.js';
import { encryptSecret, isCryptoConfigured } from '../shared/crypto.js';
import { verifyUserToken } from '../shared/github.js';

const MAX_TOKEN_CHARS = 255;
// GitHub PATs look like: classic `ghp_*`, fine-grained `github_pat_*`,
// OAuth user token `gho_*`, server-to-server `ghs_*`, refresh `ghr_*`.
const TOKEN_RE = /^(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}$/;

interface TokenBody {
  token?: string;
}

interface TokenPublicShape {
  scopes: string[];
  addedAt: string;
  lastUsedAt?: string;
}

function toPublic(u: AtlasUser): TokenPublicShape | null {
  if (!u.githubToken) return null;
  return {
    scopes: u.githubToken.scopes,
    addedAt: u.githubToken.addedAt,
    lastUsedAt: u.githubToken.lastUsedAt,
  };
}

async function putGithubToken(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const userId = principal.userDetails.toLowerCase();

  if (!isCryptoConfigured()) {
    return {
      status: 503,
      jsonBody: {
        error:
          'GitHub token storage is not configured on this deployment. Ask the operator to set ATLAS_GITHUB_TOKEN_MASTER_KEY.',
      },
    };
  }

  let body: TokenBody;
  try {
    body = (await req.json()) as TokenBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }
  const token = (body.token ?? '').trim();
  if (!token) {
    return { status: 400, jsonBody: { error: 'token is required' } };
  }
  if (token.length > MAX_TOKEN_CHARS) {
    return { status: 400, jsonBody: { error: `token too long (>${MAX_TOKEN_CHARS} chars)` } };
  }
  if (!TOKEN_RE.test(token)) {
    return {
      status: 400,
      jsonBody: {
        error: "That doesn't look like a GitHub token. Expected a value starting with 'ghp_', 'github_pat_', or 'gho_'.",
      },
    };
  }

  // Verify the token belongs to the same GitHub user signed in to atlas.
  const viewer = await verifyUserToken(token);
  if (!viewer) {
    return {
      status: 400,
      jsonBody: { error: 'GitHub rejected this token (401/403). Generate a fresh one and try again.' },
    };
  }
  if (viewer.login.toLowerCase() !== userId) {
    return {
      status: 400,
      jsonBody: {
        error: `This token belongs to GitHub user '${viewer.login}', but you're signed in as '${userId}'.`,
      },
    };
  }

  const users = usersContainer();
  let user: AtlasUser | undefined;
  try {
    const { resource } = await users.item(userId, userId).read<AtlasUser>();
    user = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }
  if (!user) {
    return {
      status: 404,
      jsonBody: { error: 'User doc not initialized; call GET /api/me first' },
    };
  }

  user.githubToken = {
    cipher: encryptSecret(token),
    scopes: viewer.scopes,
    addedAt: new Date().toISOString(),
  };
  await users.items.upsert(user);
  ctx.log(
    `putGithubToken: ${userId} stored token (scopes=${viewer.scopes.join('|') || 'fine-grained'})`,
  );

  return {
    status: 200,
    jsonBody: { githubToken: toPublic(user) },
  };
}

async function deleteGithubToken(
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
  if (!user) {
    return { status: 204 };
  }
  if (!user.githubToken) {
    return { status: 204 };
  }
  delete user.githubToken;
  await users.items.upsert(user);
  ctx.log(`deleteGithubToken: ${userId} cleared token`);
  return { status: 204 };
}

app.http('putGithubToken', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'me/github-token',
  handler: putGithubToken,
});

app.http('deleteGithubToken', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'me/github-token',
  handler: deleteGithubToken,
});
