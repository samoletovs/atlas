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

export interface AllowedRepo {
  repoId: string;
  name: string;
  ownerId: string;
  githubUrl: string;
  visibility: 'private' | 'unlisted' | 'public';
  /** P2: caller's role on this repo. Owners see admin/generate UI. */
  role: AtlasRole;
}

export interface AtlasQuota {
  used: number;
  /** null == uncapped */
  limit: number | null;
  remaining: number | null;
  resetAt: string;
}

export interface AtlasMe {
  userId: string;
  githubLogin: string;
  githubId: number | null;
  createdAt: string;
  allowedRepos: AllowedRepo[];
  quota: AtlasQuota;
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
  const res = await fetch(withRepoId('/api/admin/shares', repoId));
  if (!res.ok) throw new Error(`listShares failed: ${res.status}`);
  const data = (await res.json()) as { shares: RepoShare[] };
  return data.shares;
}

export async function addShare(repoId: string, githubLogin: string): Promise<RepoShare> {
  const res = await fetch(withRepoId('/api/admin/shares', repoId), {
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
    withRepoId(`/api/admin/shares/${encodeURIComponent(githubLogin)}`, repoId),
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
