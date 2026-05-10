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
import { lessonsV2Container } from './cosmos.js';

export const DEFAULT_CAP = 5;

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
