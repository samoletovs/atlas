/**
 * Lightweight API client. SWA forwards browser cookies; auth is automatic.
 */

export interface ClientPrincipal {
  userId: string;
  userDetails: string;
  identityProvider: string;
  userRoles: string[];
}

export type AtlasRole = 'owner' | 'member';

/** Allowed cadences (hours) for autonomous lesson generation. */
export type AutoGenInterval = 4 | 8 | 12 | 24;

export interface AllowedRepo {
  repoId: string;
  name: string;
  ownerId: string;
  githubUrl: string;
  visibility: 'private' | 'unlisted' | 'public';
  /** P2: caller's role on this repo. Owners see admin/generate UI. */
  role: AtlasRole;
  /** P4: autonomous-generation settings. Only sent for owners. */
  autoGenerate?: boolean;
  intervalHours?: AutoGenInterval;
  unreadTarget?: number;
  lastRunAt?: string | null;
}

export interface AtlasQuota {
  used: number;
  /** null == uncapped */
  limit: number | null;
  remaining: number | null;
  resetAt: string;
}

/**
 * Server-synced UI preferences. Empty object when never saved —
 * client falls back to localStorage / OS preference in that case.
 */
export interface AtlasPreferences {
  theme?: 'dark' | 'light';
  lang?: 'en' | 'ru';
  updatedAt?: string;
}

/**
 * Public-facing summary of the user's stored GitHub PAT. `null` when none
 * is on file. The plaintext token is never returned by the API.
 */
export interface GithubTokenInfo {
  scopes: string[];
  addedAt: string;
  lastUsedAt?: string;
}

export interface AtlasMe {
  userId: string;
  githubLogin: string;
  githubId: number | null;
  createdAt: string;
  allowedRepos: AllowedRepo[];
  quota: AtlasQuota;
  preferences: AtlasPreferences;
  githubToken: GithubTokenInfo | null;
}

export interface Lesson {
  id: string;
  // P1 v2 schema:
  repoId?: string;
  ownerId?: string;
  // legacy field for compatibility with cached responses:
  userId?: string;
  title: string;
  topic: string;
  depth: 'intro' | 'intermediate' | 'deep';
  read_minutes: number;
  body: string;
  body_original?: string;
  citations: string[];
  suggested_next: { title: string; topic: string; rationale: string }[];
  source_event?: { type: string; ref: string; summary: string } | null;
  status: 'queued' | 'drafting' | 'published' | 'read' | 'archived';
  language: 'en' | 'ru';
  created_at: string;
  read_at?: string | null;
  saved?: boolean;
}

/** A lesson enriched with adaptive-recommendation metadata. */
export interface LearningPathLesson extends Lesson {
  recommendation_reason: string;
  recommendation_score: number;
}

const isLocalDev = window.location.hostname === 'localhost';

export async function fetchUser(): Promise<ClientPrincipal | null> {
  // SWA exposes /.auth/me with the current principal (or {clientPrincipal: null})
  if (isLocalDev) {
    return {
      userId: 'samoletovs-local',
      userDetails: 'samoletovs',
      identityProvider: 'github',
      userRoles: ['authenticated'],
    };
  }
  const res = await fetch('/.auth/me');
  if (!res.ok) return null;
  const data = (await res.json()) as { clientPrincipal: ClientPrincipal | null };
  return data.clientPrincipal;
}

/**
 * Backend-resolved view of the current user. Triggers user-doc creation on
 * first sign-in. Returns null on 401 (not signed in) or 403 (not allowlisted).
 */
export async function fetchMe(): Promise<AtlasMe | null> {
  const res = await fetch('/api/me');
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`fetchMe failed: ${res.status}`);
  return (await res.json()) as AtlasMe;
}

function withRepoId(path: string, repoId?: string): string {
  if (!repoId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}repoId=${encodeURIComponent(repoId)}`;
}

export async function listLessons(
  status: string,
  lang: string = 'en',
  repoId?: string,
): Promise<Lesson[]> {
  const url = withRepoId(
    `/api/lessons?status=${encodeURIComponent(status)}&lang=${encodeURIComponent(lang)}`,
    repoId,
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`listLessons failed: ${res.status}`);
  const data = (await res.json()) as { lessons: Lesson[] };
  return data.lessons;
}

export async function getLesson(id: string, repoId?: string): Promise<Lesson> {
  const res = await fetch(withRepoId(`/api/lessons/${encodeURIComponent(id)}`, repoId));
  if (!res.ok) throw new Error(`getLesson failed: ${res.status}`);
  return (await res.json()) as Lesson;
}

export async function updateLessonState(
  id: string,
  action: 'mark_read' | 'save' | 'unsave',
  repoId?: string,
): Promise<Lesson> {
  const res = await fetch(
    withRepoId(`/api/lessons/${encodeURIComponent(id)}/state`, repoId),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) throw new Error(`updateLessonState failed: ${res.status}`);
  return (await res.json()) as Lesson;
}

export interface QueueLessonInput {
  title: string;
  topic: string;
  language: 'en' | 'ru';
  rationale?: string;
  source_lesson_id?: string;
  depth?: 'intro' | 'intermediate' | 'deep';
}

export async function queueLesson(input: QueueLessonInput, repoId?: string): Promise<Lesson> {
  const res = await fetch(withRepoId('/api/lessons/queue', repoId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`queueLesson failed: ${res.status}`);
  return (await res.json()) as Lesson;
}

/**
 * Synchronously generate a lesson body via Azure OpenAI. Takes 5–15s.
 * Returns a fully populated, published lesson.
 */
export async function generateLessonNow(
  input: QueueLessonInput,
  repoId?: string,
): Promise<Lesson> {
  const res = await fetch(withRepoId('/api/lessons/generate', repoId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`generateLessonNow failed: ${res.status}${detail}`);
  }
  return (await res.json()) as Lesson;
}

// ---------- Admin (P2): manage repoShares ----------

export interface RepoShare {
  id: string;
  repoId: string;
  githubLogin: string;
  role: 'member';
  invitedBy: string;
  createdAt: string;
  revokedAt?: string | null;
}

export async function listShares(repoId: string): Promise<RepoShare[]> {
  const res = await fetch(withRepoId('/api/shares', repoId));
  if (!res.ok) throw new Error(`listShares failed: ${res.status}`);
  const data = (await res.json()) as { shares: RepoShare[] };
  return data.shares;
}

export async function addShare(repoId: string, githubLogin: string): Promise<RepoShare> {
  const res = await fetch(withRepoId('/api/shares/invite', repoId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubLogin }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`addShare failed: ${res.status}${detail}`);
  }
  const data = (await res.json()) as { share: RepoShare };
  return data.share;
}

export async function revokeShare(repoId: string, githubLogin: string): Promise<RepoShare> {
  const res = await fetch(
    withRepoId(`/api/shares/${encodeURIComponent(githubLogin)}`, repoId),
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`revokeShare failed: ${res.status}`);
  const data = (await res.json()) as { share: RepoShare };
  return data.share;
}

// ---------- Repo creation (P3) ----------

export interface AddRepoResult {
  /** Cosmos `repos` doc shape (no `role` — caller is always the owner). */
  repo: {
    repoId: string;
    name: string;
    ownerId: string;
    githubUrl: string;
    visibility: 'private' | 'unlisted' | 'public';
    createdAt: string;
  };
  starterLesson: Lesson | null;
  alreadyExisted?: boolean;
}

export async function addRepo(githubUrl: string): Promise<AddRepoResult> {
  const res = await fetch('/api/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUrl }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`addRepo failed: ${res.status}${detail}`);
  }
  return (await res.json()) as AddRepoResult;
}

// ---------- Auto-generate settings (P4) ----------

export interface RepoSettingsPatch {
  autoGenerate?: boolean;
  intervalHours?: AutoGenInterval;
  unreadTarget?: number;
}

export interface RepoSettingsResult {
  /** Subset of the Repo doc that the UI cares about. */
  repo: {
    repoId: string;
    name: string;
    autoGenerate?: boolean;
    intervalHours?: AutoGenInterval;
    unreadTarget?: number;
    lastRunAt?: string | null;
  };
}

export async function updateRepoSettings(
  repoId: string,
  patch: RepoSettingsPatch,
): Promise<RepoSettingsResult> {
  const res = await fetch(withRepoId('/api/repos/settings', repoId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`updateRepoSettings failed: ${res.status}${detail}`);
  }
  return (await res.json()) as RepoSettingsResult;
}

// ---------- Preferences (P5: theme/lang sync across devices) ----------

export async function updatePreferences(
  patch: { theme?: 'dark' | 'light'; lang?: 'en' | 'ru' },
): Promise<AtlasPreferences> {
  const res = await fetch('/api/me/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updatePreferences failed: ${res.status}`);
  const data = (await res.json()) as { preferences: AtlasPreferences };
  return data.preferences;
}

// ---------- Ask-more chat (P5: follow-up Q&A on a lesson) ----------

export interface AskChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskResult {
  answer: string;
  lessonId: string;
}

export async function askLesson(
  lessonId: string,
  question: string,
  history: AskChatTurn[],
  repoId?: string,
): Promise<AskResult> {
  const res = await fetch(
    withRepoId(`/api/lessons/${encodeURIComponent(lessonId)}/ask`, repoId),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`askLesson failed: ${res.status}${detail}`);
  }
  return (await res.json()) as AskResult;
}

// ---------- Adaptive learning path (recommended lessons) ----------

/**
 * Returns unread published lessons sorted by adaptive relevance. Each lesson
 * includes `recommendation_reason` and `recommendation_score` metadata.
 */
export async function getRecommendations(
  lang: string = 'en',
  repoId?: string,
): Promise<LearningPathLesson[]> {
  const url = withRepoId(
    `/api/lessons/recommended?lang=${encodeURIComponent(lang)}`,
    repoId,
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`getRecommendations failed: ${res.status}`);
  const data = (await res.json()) as { lessons: LearningPathLesson[] };
  return data.lessons;
}

// ---------- GitHub PAT management (Settings page) ----------

/**
 * Upload a GitHub personal access token. Validated server-side (must belong
 * to the same GitHub user that's signed in). Plaintext stays in-memory only;
 * the server encrypts it before persisting.
 */
export async function putGithubToken(token: string): Promise<GithubTokenInfo> {
  const res = await fetch('/api/me/github-token', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`putGithubToken failed: ${res.status}${detail}`);
  }
  const data = (await res.json()) as { githubToken: GithubTokenInfo };
  return data.githubToken;
}

/** Forget the stored token. Returns true if a token was actually cleared. */
export async function deleteGithubToken(): Promise<boolean> {
  const res = await fetch('/api/me/github-token', { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`deleteGithubToken failed: ${res.status}`);
  }
  return true;
}

// ---------- Browse-and-pick repos (Settings → Add repos) ----------

export interface GithubRepoListItem {
  fullName: string;
  owner: string;
  repo: string;
  description: string | null;
  htmlUrl: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string;
  language: string | null;
  stargazersCount: number;
  pushedAt: string | null;
  /** True if this repo already exists in atlas under any owner. */
  inAtlas: boolean;
  /** True if it exists in atlas but is owned by someone else (you'd need an invite). */
  ownedByOther: boolean;
}

/**
 * List all repos the user can see on GitHub via their stored token. The
 * server merges in atlas-state so the UI can grey out already-added entries.
 * Returns null when the user has no token yet.
 */
export async function listMyGithubRepos(): Promise<GithubRepoListItem[] | null> {
  const res = await fetch('/api/github/repos');
  if (res.status === 412) return null;
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string };
      detail = data.error ? `: ${data.error}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`listMyGithubRepos failed: ${res.status}${detail}`);
  }
  const data = (await res.json()) as { repos: GithubRepoListItem[] };
  return data.repos;
}
