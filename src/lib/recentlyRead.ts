import { useCallback, useSyncExternalStore } from 'react';
import { notifyLessonProgress } from './lessonProgress';

interface ReadScope {
  ids: Set<string>;
  version: number;
  listeners: Set<() => void>;
}

// Confirmed writes survive reader navigation while the API's read-after-write catches up.
// Only IDs are retained, scoped to the repository, for this application session.
const scopes = new Map<string, ReadScope>();

function scopeFor(repoId: string): ReadScope {
  let scope = scopes.get(repoId);
  if (!scope) {
    scope = { ids: new Set(), version: 0, listeners: new Set() };
    scopes.set(repoId, scope);
  }
  return scope;
}

export function markRecentlyRead(id: string, repoId: string): void {
  const scope = scopeFor(repoId);
  scope.ids.add(id);
  scope.version += 1;
  for (const listener of [...scope.listeners]) listener();
  notifyLessonProgress(repoId);
}

export function isRecentlyRead(id: string, repoId: string): boolean {
  return scopeFor(repoId).ids.has(id);
}

export function getRecentlyReadVersion(repoId: string): number {
  return scopeFor(repoId).version;
}

export function subscribeRecentlyRead(repoId: string, listener: () => void): () => void {
  const listeners = scopeFor(repoId).listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const serverVersion = () => 0;

export function useRecentlyReadVersion(repoId: string): number {
  const subscribe = useCallback((listener: () => void) => subscribeRecentlyRead(repoId, listener), [repoId]);
  const snapshot = useCallback(() => getRecentlyReadVersion(repoId), [repoId]);
  return useSyncExternalStore(subscribe, snapshot, serverVersion);
}
