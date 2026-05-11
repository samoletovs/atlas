/**
 * Cosmos client + helpers — one container client per request.
 *
 * Auth strategy:
 *   - If COSMOS_CONNECTION_STRING is set (production / SWA Free tier), use it
 *   - Otherwise use DefaultAzureCredential (local dev with `az login`,
 *     or future SWA Standard tier with managed identity)
 */
import { CosmosClient, Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const endpoint = process.env.COSMOS_ENDPOINT;
const connectionString = process.env.COSMOS_CONNECTION_STRING;
const databaseName = process.env.COSMOS_DATABASE ?? 'atlas';

if (!endpoint && !connectionString) {
  throw new Error('Either COSMOS_ENDPOINT or COSMOS_CONNECTION_STRING must be set');
}

let _client: CosmosClient | null = null;

export function cosmosClient(): CosmosClient {
  if (!_client) {
    if (connectionString) {
      _client = new CosmosClient(connectionString);
    } else {
      _client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
    }
  }
  return _client;
}

export function lessonsContainer(): Container {
  return cosmosClient().database(databaseName).container('lessons');
}

export function topicsContainer(): Container {
  return cosmosClient().database(databaseName).container('topics');
}

// ---------------------------------------------------------------------------
// Multi-repo schema (P1) — new containers, not yet wired into routes.
// See atlas/docs/MULTI-USER-PLAN.md.
// ---------------------------------------------------------------------------

export function reposContainer(): Container {
  return cosmosClient().database(databaseName).container('repos');
}

export function lessonsV2Container(): Container {
  return cosmosClient().database(databaseName).container('lessons_v2');
}

export function lessonProgressContainer(): Container {
  return cosmosClient().database(databaseName).container('lessonProgress');
}

export function repoSharesContainer(): Container {
  return cosmosClient().database(databaseName).container('repoShares');
}

export function usersContainer(): Container {
  return cosmosClient().database(databaseName).container('users');
}

export const ATLAS_USER_ID = process.env.ATLAS_USER_ID ?? 'sam';

export type LessonStatus = 'queued' | 'drafting' | 'published' | 'read' | 'archived';

export interface Lesson {
  id: string;
  userId: string;
  title: string;
  topic: string;
  depth: 'intro' | 'intermediate' | 'deep';
  read_minutes: number;
  body: string;
  citations: string[];
  suggested_next: { title: string; topic: string; rationale: string }[];
  source_event?: { type: string; ref: string; summary: string } | null;
  status: LessonStatus;
  language: 'en' | 'ru';
  created_at: string;
  read_at?: string | null;
  saved?: boolean;
}

// ---------------------------------------------------------------------------
// Multi-repo doc shapes (P1).
// `LessonV2` keeps the same content fields as `Lesson` but adds repo/owner
// keys and drops per-user state (status, read_at, saved → moved to LessonProgress).
// ---------------------------------------------------------------------------

export type RepoVisibility = 'private' | 'unlisted' | 'public';

/** Allowed cadences for autonomous lesson generation, in hours. */
export type AutoGenInterval = 4 | 8 | 12 | 24;

export interface Repo {
  id: string;            // same as repoId, e.g. 'samoletovs/nauroLabs'
  repoId: string;
  ownerId: string;       // partition key, GitHub login of the owner
  name: string;          // display name, defaults to the repo half of repoId
  githubUrl: string;
  visibility: RepoVisibility;
  createdAt: string;

  // ---------------------------------------------------------------------
  // P4: autonomous lesson generation. All optional so existing repo docs
  // remain valid; defaults are applied at read-time and in the Python
  // script.
  //   autoGenerate       — opt-in toggle. Default off.
  //   intervalHours      — how often to consider this repo (4/8/12/24).
  //   unreadTarget       — replenish until owner has at least N unread.
  //   lastRunAt          — ISO timestamp of the last auto-gen attempt.
  //   lastSeenCommitSha  — newest commit sha we've already digested.
  // ---------------------------------------------------------------------
  autoGenerate?: boolean;
  intervalHours?: AutoGenInterval;
  unreadTarget?: number;
  lastRunAt?: string | null;
  lastSeenCommitSha?: string | null;
}

/** Server-side defaults applied when a setting is missing on a Repo doc. */
export const AUTO_GEN_DEFAULTS = {
  autoGenerate: false,
  intervalHours: 24 as AutoGenInterval,
  unreadTarget: 20,
} as const;

export interface LessonV2 {
  id: string;
  repoId: string;        // partition key
  ownerId: string;       // denormalized for ACL checks
  title: string;
  topic: string;
  depth: 'intro' | 'intermediate' | 'deep';
  read_minutes: number;
  body: string;
  body_original?: string;
  citations: string[];
  suggested_next: { title: string; topic: string; rationale: string }[];
  source_event?: { type: string; ref: string; summary: string } | null;
  status: 'queued' | 'drafting' | 'published' | 'archived'; // per-reader 'read' moves to LessonProgress
  language: 'en' | 'ru';
  created_at: string;
}

export interface LessonProgress {
  id: string;            // `${userId}_${lessonId}`
  userId: string;        // partition key, GitHub login of the reader
  repoId: string;        // for cheap filtering
  lessonId: string;
  status: 'unread' | 'read';
  readAt?: string | null;
  saved?: boolean;
}

export interface RepoShare {
  id: string;            // `${repoId}_${githubLogin}`
  repoId: string;        // partition key
  githubLogin: string;   // invitee
  role: 'member';
  invitedBy: string;     // owner login
  createdAt: string;
  revokedAt?: string | null;
}

/**
 * Per-user UI preferences synced across devices. All optional — clients
 * fall back to localStorage / OS preference when a field is missing.
 */
export interface AtlasUserPreferences {
  theme?: 'dark' | 'light';
  lang?: 'en' | 'ru';
  updatedAt?: string;
}

/**
 * Best-effort per-day usage counters tracked directly on the user doc.
 * Cheaper than a dedicated container for low-cardinality counters like
 * follow-up chat turns. `date` is the UTC YYYY-MM-DD key — when it rolls
 * over the counter resets implicitly.
 */
export interface AtlasUserUsage {
  /** UTC YYYY-MM-DD the current counters apply to. */
  date?: string;
  /** Number of /api/lessons/{id}/ask turns spent today. */
  asks?: number;
}

export interface AtlasUser {
  id: string;            // same as userId (GitHub login for now)
  userId: string;        // partition key
  githubLogin: string;
  githubId?: number;     // numeric GitHub user id, filled at first sign-in
  byok?: {
    endpoint: string;
    deployment: string;
    keyCipher: string;   // AES-256-GCM ciphertext, master key in App Settings (P4)
    addedAt: string;
  };
  /**
   * GitHub PAT for accessing the user's repos (including private). The
   * plaintext token is never logged or returned to clients; only `addedAt`
   * and `scopes` are surfaced via GET /api/me.
   */
  githubToken?: {
    /** AES-256-GCM ciphertext of the PAT. See shared/crypto.ts. */
    cipher: string;
    /** Scopes/permissions GitHub reported on the token at upload time. */
    scopes: string[];
    /** When the user pasted the token (ISO 8601). */
    addedAt: string;
    /** Last time we used it successfully (ISO 8601). */
    lastUsedAt?: string;
  };
  /** P5: cross-device theme/lang sync. */
  preferences?: AtlasUserPreferences;
  /** Per-day soft-quota counters (asks, etc.). */
  usage?: AtlasUserUsage;
  createdAt: string;
}
