import { Lesson } from './api';

const REVIEW_INTERVALS_HOURS = [24, 72, 168, 336] as const;
const ONE_HOUR_MS = 60 * 60 * 1000;

interface ReviewState {
  step: number;
  dueAt: string;
  updatedAt: string;
}

interface ReviewCard {
  lesson: Lesson;
  step: number;
  dueAt: string;
}

function storageKey(repoId: string): string {
  return `atlas-spaced-review:${repoId}`;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function clampStep(step: number): number {
  return Math.max(0, Math.min(step, REVIEW_INTERVALS_HOURS.length - 1));
}

function readState(repoId: string): Record<string, ReviewState> {
  const raw = localStorage.getItem(storageKey(repoId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ReviewState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(repoId: string, state: Record<string, ReviewState>): void {
  localStorage.setItem(storageKey(repoId), JSON.stringify(state));
}

function initialDueAt(lesson: Lesson): number | null {
  const readAt = parseIso(lesson.read_at ?? null);
  const createdAt = parseIso(lesson.created_at);
  const base = readAt ?? createdAt;
  if (base === null) return null;
  return base + REVIEW_INTERVALS_HOURS[0] * ONE_HOUR_MS;
}

export function listDueReviewCards(repoId: string, readLessons: Lesson[]): ReviewCard[] {
  const now = Date.now();
  const state = readState(repoId);
  const due: ReviewCard[] = [];

  for (const lesson of readLessons) {
    const saved = state[lesson.id];
    const savedDueTs = parseIso(saved?.dueAt ?? null);
    const fallbackDueTs = initialDueAt(lesson);
    const dueTs = savedDueTs ?? fallbackDueTs;
    if (dueTs === null || dueTs > now) continue;

    due.push({
      lesson,
      step: clampStep(saved?.step ?? 0),
      dueAt: new Date(dueTs).toISOString(),
    });
  }

  due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  return due;
}

export function markReviewDone(repoId: string, lessonId: string): void {
  const state = readState(repoId);
  const current = state[lessonId];
  const currentStep = clampStep(current?.step ?? 0);
  const nextStep = clampStep(currentStep + 1);
  const now = Date.now();
  const nextDue = now + REVIEW_INTERVALS_HOURS[nextStep] * ONE_HOUR_MS;
  state[lessonId] = {
    step: nextStep,
    dueAt: new Date(nextDue).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  writeState(repoId, state);
}

export function reviewStepLabel(step: number): string {
  const idx = clampStep(step);
  const hours = REVIEW_INTERVALS_HOURS[idx];
  if (hours % 24 === 0) return `${hours / 24}d cadence`;
  return `${hours}h cadence`;
}
