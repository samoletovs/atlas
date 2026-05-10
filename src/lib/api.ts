/**
 * Lightweight API client. SWA forwards browser cookies; auth is automatic.
 */

export interface ClientPrincipal {
  userId: string;
  userDetails: string;
  identityProvider: string;
  userRoles: string[];
}

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
      userId: 'sam',
      userDetails: 'sam@local',
      identityProvider: 'local',
      userRoles: ['authenticated'],
    };
  }
  const res = await fetch('/.auth/me');
  if (!res.ok) return null;
  const data = (await res.json()) as { clientPrincipal: ClientPrincipal | null };
  return data.clientPrincipal;
}

export async function listLessons(status: string, lang: string = 'en'): Promise<Lesson[]> {
  const res = await fetch(`/api/lessons?status=${encodeURIComponent(status)}&lang=${encodeURIComponent(lang)}`);
  if (!res.ok) throw new Error(`listLessons failed: ${res.status}`);
  const data = (await res.json()) as { lessons: Lesson[] };
  return data.lessons;
}

export async function getLesson(id: string): Promise<Lesson> {
  const res = await fetch(`/api/lessons/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getLesson failed: ${res.status}`);
  return (await res.json()) as Lesson;
}

export async function updateLessonState(
  id: string,
  action: 'mark_read' | 'save' | 'unsave'
): Promise<Lesson> {
  const res = await fetch(`/api/lessons/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`updateLessonState failed: ${res.status}`);
  return (await res.json()) as Lesson;
}
