/**
 * Daily generation quota — limits LLM cost for users on the shared
 * subscription. Counts `lessons_v2` rows owned by the caller created since
 * UTC midnight. Sam is in the uncapped allowlist by default (he pays for
 * the subscription; everyone else gets the cap).
 *
 * Configuration via App Settings:
 *   ATLAS_DAILY_GENERATION_CAP   default 5
 *   ATLAS_UNCAPPED_USERS         comma-separated GitHub logins, default 'samoletovs'
 */
import { lessonsV2Container, usersContainer, AtlasUser } from './cosmos.js';

export const DEFAULT_CAP = 5;
export const DEFAULT_ASK_CAP = 30;

function uncappedUsers(): Set<string> {
  const raw = process.env.ATLAS_UNCAPPED_USERS ?? 'samoletovs';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getCapForUser(userId: string): number | null {
  if (uncappedUsers().has(userId.toLowerCase())) return null;
  const env = process.env.ATLAS_DAILY_GENERATION_CAP;
  const parsed = env ? Number.parseInt(env, 10) : DEFAULT_CAP;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CAP;
}

/** ISO timestamp at the start of today in UTC. */
export function todayUtcStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Count `lessons_v2` rows owned by `userId` created since UTC midnight.
 * Cross-partition; cheap until users have thousands of lessons (which is
 * far beyond any realistic daily ceiling).
 */
export async function getDailyGenerations(userId: string): Promise<number> {
  const cutoff = todayUtcStartIso();
  const { resources } = await lessonsV2Container().items
    .query<number>({
      query: 'SELECT VALUE COUNT(1) FROM c WHERE c.ownerId = @uid AND c.created_at >= @cutoff',
      parameters: [
        { name: '@uid', value: userId },
        { name: '@cutoff', value: cutoff },
      ],
    })
    .fetchAll();
  return resources[0] ?? 0;
}

export interface QuotaState {
  used: number;
  /** null == uncapped */
  limit: number | null;
  remaining: number | null;
  resetAt: string;
}

export async function getQuotaState(userId: string): Promise<QuotaState> {
  const limit = getCapForUser(userId);
  const used = await getDailyGenerations(userId);
  const remaining = limit === null ? null : Math.max(0, limit - used);
  // Reset at next UTC midnight.
  const d = new Date();
  const reset = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return { used, limit, remaining, resetAt: reset.toISOString() };
}

export interface QuotaExceeded {
  exceeded: true;
  state: QuotaState;
}
export interface QuotaOk {
  exceeded: false;
  state: QuotaState;
}

/**
 * Returns the current state plus whether the caller has already hit the cap.
 * Callers should bail with 429 + JSON body `{error, quota: state}` when
 * `exceeded` is true.
 */
export async function checkQuota(userId: string): Promise<QuotaExceeded | QuotaOk> {
  const state = await getQuotaState(userId);
  const exceeded = state.limit !== null && state.used >= state.limit;
  return exceeded ? { exceeded, state } : { exceeded: false, state };
}

// ---------------------------------------------------------------------------
// Follow-up chat ("ask") soft rate-limit.
//
// Unlike the lesson generation cap, asks don't create a Cosmos row we can
// count by query — so we increment a counter on the user doc itself. The
// counter resets every UTC day implicitly via a `date` key.
//
// This is best-effort (read-then-write race window of a few ms; concurrent
// asks can over-count or under-count by 1-2). That's fine for a soft cost
// guard. If we ever need hard accuracy we'd move to a dedicated container
// with a stored procedure or atomic patch.
// ---------------------------------------------------------------------------

function todayUtcKey(): string {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

function getAskCapForUser(userId: string): number | null {
  if (uncappedUsers().has(userId.toLowerCase())) return null;
  const env = process.env.ATLAS_DAILY_ASK_CAP;
  const parsed = env ? Number.parseInt(env, 10) : DEFAULT_ASK_CAP;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_CAP;
}

export interface AskQuotaExceeded {
  exceeded: true;
  used: number;
  limit: number;
  resetAt: string;
}
export interface AskQuotaOk {
  exceeded: false;
  used: number;
  limit: number | null;
}

/**
 * Atomically (best-effort) increment the per-user ask counter for today.
 * Returns `exceeded: true` and does NOT increment when the cap is already hit.
 * Returns `exceeded: false` and bumps the counter on the user doc otherwise.
 *
 * Caller must have a user doc already (created by GET /api/me on sign-in).
 * If the doc is missing we treat as exceeded=false and skip the write so a
 * race with first-time sign-in doesn't block the request.
 */
export async function consumeAskTurn(
  userId: string,
): Promise<AskQuotaExceeded | AskQuotaOk> {
  const limit = getAskCapForUser(userId);
  const todayKey = todayUtcKey();

  // Reset window: next UTC midnight.
  const d = new Date();
  const resetAt = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  ).toISOString();

  const users = usersContainer();
  let user: AtlasUser | undefined;
  try {
    const { resource } = await users.item(userId, userId).read<AtlasUser>();
    user = resource ?? undefined;
  } catch (e: unknown) {
    if (e instanceof Error && (e as { code?: number }).code !== 404) throw e;
  }

  if (!user) {
    // First-call race with /me — let it through this once.
    return { exceeded: false, used: 0, limit };
  }

  const usage = user.usage ?? {};
  const sameDay = usage.date === todayKey;
  const usedBefore = sameDay ? usage.asks ?? 0 : 0;

  if (limit !== null && usedBefore >= limit) {
    return { exceeded: true, used: usedBefore, limit, resetAt };
  }

  user.usage = { date: todayKey, asks: usedBefore + 1 };
  await users.items.upsert(user);
  return { exceeded: false, used: usedBefore + 1, limit };
}
