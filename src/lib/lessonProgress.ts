import { useCallback, useSyncExternalStore } from 'react';

interface ProgressScope {
  version: number;
  listeners: Set<() => void>;
}

const scopes = new Map<string, ProgressScope>();

function scopeFor(repoId: string): ProgressScope {
  let scope = scopes.get(repoId);
  if (!scope) {
    scope = { version: 0, listeners: new Set() };
    scopes.set(repoId, scope);
  }
  return scope;
}

export function notifyLessonProgress(repoId: string): void {
  const scope = scopeFor(repoId);
  scope.version += 1;
  for (const listener of [...scope.listeners]) listener();
}

export function getLessonProgressVersion(repoId: string): number {
  return scopeFor(repoId).version;
}

export function subscribeLessonProgress(repoId: string, listener: () => void): () => void {
  const listeners = scopeFor(repoId).listeners;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const serverVersion = () => 0;

export function useLessonProgressVersion(repoId: string): number {
  const subscribe = useCallback((listener: () => void) => subscribeLessonProgress(repoId, listener), [repoId]);
  const snapshot = useCallback(() => getLessonProgressVersion(repoId), [repoId]);
  return useSyncExternalStore(subscribe, snapshot, serverVersion);
}
