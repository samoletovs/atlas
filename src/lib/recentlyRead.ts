/**
 * Client-side "recently read" tracking.
 *
 * The "Next up" list hides read lessons by joining each lesson with its
 * per-user `lessonProgress` row server-side. Right after marking a lesson
 * read, the immediate re-fetch can observe a stale `lessonProgress` state
 * (Cosmos session consistency isn't guaranteed across separate Function
 * invocations), so the just-read lesson sometimes reappears once.
 *
 * To make the UI deterministic, we remember locally which lessons were
 * marked read this session and filter them out of the "Next up" list,
 * regardless of how quickly the backend catches up. Read state is durable
 * server-side, so over-filtering here is harmless — a genuinely read lesson
 * never belongs in "Next up" anyway.
 */
const readIds = new Set<string>();

/** Record that a lesson was just marked read. */
export function markRecentlyRead(id: string): void {
  readIds.add(id);
}

/** Whether a lesson was marked read this session. */
export function isRecentlyRead(id: string): boolean {
  return readIds.has(id);
}
