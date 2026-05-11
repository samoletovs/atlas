/**
 * PATCH /api/repos/settings?repoId=<repoId>
 * Body: { autoGenerate?: boolean, intervalHours?: 4|8|12|24, unreadTarget?: number }
 *
 * Owner-only. Updates the autonomous-generation knobs on a Repo doc.
 * All three fields are optional in the body — only the keys provided are
 * touched. Returns the full updated `Repo` doc.
 *
 * Defaults (applied when the field has never been set on the doc) live in
 * `AUTO_GEN_DEFAULTS` in shared/cosmos.ts.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  reposContainer,
  Repo,
  AutoGenInterval,
} from '../shared/cosmos.js';
import { resolveRequest, isHttpResponse, requireOwner } from '../shared/auth.js';

interface UpdateSettingsBody {
  autoGenerate?: boolean;
  intervalHours?: number;
  unreadTarget?: number;
}

const ALLOWED_INTERVALS: ReadonlyArray<AutoGenInterval> = [4, 8, 12, 24];
const MIN_UNREAD_TARGET = 1;
const MAX_UNREAD_TARGET = 100;

export async function updateRepoSettings(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const r = await resolveRequest(req);
  if (isHttpResponse(r)) return r;
  const ownerCheck = requireOwner(r);
  if (isHttpResponse(ownerCheck)) return ownerCheck;
  const { userId, repoId, ownerLogin, repo } = r;

  let body: UpdateSettingsBody;
  try {
    body = (await req.json()) as UpdateSettingsBody;
  } catch {
    return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
  }

  // Validate each provided field. Reject unknown shapes early.
  if (
    body.autoGenerate !== undefined &&
    typeof body.autoGenerate !== 'boolean'
  ) {
    return { status: 400, jsonBody: { error: 'autoGenerate must be a boolean' } };
  }
  if (body.intervalHours !== undefined) {
    if (
      typeof body.intervalHours !== 'number' ||
      !ALLOWED_INTERVALS.includes(body.intervalHours as AutoGenInterval)
    ) {
      return {
        status: 400,
        jsonBody: {
          error: `intervalHours must be one of ${ALLOWED_INTERVALS.join(', ')}`,
        },
      };
    }
  }
  if (body.unreadTarget !== undefined) {
    if (
      typeof body.unreadTarget !== 'number' ||
      !Number.isInteger(body.unreadTarget) ||
      body.unreadTarget < MIN_UNREAD_TARGET ||
      body.unreadTarget > MAX_UNREAD_TARGET
    ) {
      return {
        status: 400,
        jsonBody: {
          error: `unreadTarget must be an integer between ${MIN_UNREAD_TARGET} and ${MAX_UNREAD_TARGET}`,
        },
      };
    }
  }

  if (
    body.autoGenerate === undefined &&
    body.intervalHours === undefined &&
    body.unreadTarget === undefined
  ) {
    return {
      status: 400,
      jsonBody: { error: 'At least one of autoGenerate, intervalHours, unreadTarget is required' },
    };
  }

  // Re-read the doc so we never PATCH stale state — the resolveRequest
  // cached copy was loaded from a different container client.
  const repos = reposContainer();
  const { resource: latest } = await repos.item(repoId, ownerLogin).read<Repo>();
  if (!latest) {
    return { status: 404, jsonBody: { error: 'Repo not found' } };
  }

  const updated: Repo = {
    ...latest,
    ...(body.autoGenerate !== undefined && { autoGenerate: body.autoGenerate }),
    ...(body.intervalHours !== undefined && {
      intervalHours: body.intervalHours as AutoGenInterval,
    }),
    ...(body.unreadTarget !== undefined && { unreadTarget: body.unreadTarget }),
  };

  const { resource: saved } = await repos.items.upsert<Repo>(updated);
  ctx.log(
    `updateRepoSettings: ${repoId} by ${userId} (autoGenerate=${updated.autoGenerate}, ` +
      `intervalHours=${updated.intervalHours}, unreadTarget=${updated.unreadTarget})`,
  );

  // Suppress unused-import lint for repo (ResolvedRequest has it but we re-fetch).
  void repo;

  return { status: 200, jsonBody: { repo: saved ?? updated } };
}

app.http('updateRepoSettings', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'repos/settings',
  handler: updateRepoSettings,
});
