/**
 * PATCH /api/me/preferences
 * Body: { theme?: 'dark'|'light', lang?: 'en'|'ru' }
 *
 * Persists per-user UI preferences (theme, language) on the user doc so
 * they follow the reader across devices and the PWA. Both fields are
 * optional; only the keys present in the body are updated.
 *
 * Returns the merged `preferences` object after the write.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { usersContainer, AtlasUser, AtlasUserPreferences } from '../shared/cosmos.js';
import { getPrincipal, isAuthenticated } from '../shared/auth.js';

interface PreferencesBody {
  theme?: 'dark' | 'light';
  lang?: 'en' | 'ru';
}

function sanitize(body: PreferencesBody): AtlasUserPreferences {
  const out: AtlasUserPreferences = {};
  if (body.theme === 'dark' || body.theme === 'light') {
    out.theme = body.theme;
  }
  if (body.lang === 'en' || body.lang === 'ru') {
    out.lang = body.lang;
  }
  return out;
}

export async function updateMePreferences(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthenticated(principal) || !principal) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }
  const userId = principal.userDetails.toLowerCase();

  let body: PreferencesBody;
  try {
    body = (await req.json()) as PreferencesBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  const patch = sanitize(body);
  if (Object.keys(patch).length === 0) {
    return {
      status: 400,
      jsonBody: { error: 'No valid preference fields provided' },
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

  // First call after sign-in may race with getMe upserting the user doc.
  // Don't recreate it here — bail with 404 so the client retries after /me.
  if (!user) {
    return {
      status: 404,
      jsonBody: { error: 'User doc not initialized; call GET /api/me first' },
    };
  }

  const merged: AtlasUserPreferences = {
    ...(user.preferences ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  user.preferences = merged;
  await users.items.upsert(user);
  ctx.log(`updateMePreferences: ${userId} -> ${JSON.stringify(patch)}`);

  return { status: 200, jsonBody: { preferences: merged } };
}

app.http('updateMePreferences', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'me/preferences',
  handler: updateMePreferences,
});
