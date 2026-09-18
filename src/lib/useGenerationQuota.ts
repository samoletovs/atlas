import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMe } from '../App';

export function useGenerationQuota(isOwner: boolean) {
  const { quota, refreshMe } = useMe();
  const active = useRef(false);
  const refreshAccount = useRef(refreshMe);
  const requestVersion = useRef(0);
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useLayoutEffect(() => { refreshAccount.current = refreshMe; }, [refreshMe]);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (active.current) {
      setNow(Date.now());
      setRefreshing(true);
      setError(null);
    }
    try {
      // Account state remains authoritative even if generation's page has departed.
      const me = await refreshAccount.current();
      if (!me) throw new Error('Account limits are unavailable. Please sign in again.');
    } catch (reason: unknown) {
      if (active.current && version === requestVersion.current) {
        setError(reason instanceof Error ? reason.message : 'An unexpected error occurred. Please try again.');
      } else if (!active.current) {
        console.warn('Daily quota refresh failed after navigation', reason);
      }
    } finally {
      if (active.current && version === requestVersion.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const expiresAt = Date.parse(quota.resetAt);
    if (!isOwner || quota.limit === null || !Number.isFinite(expiresAt)) return;
    let stopped = false;
    let timer = 0;
    const refreshIfExpired = () => {
      if (!stopped && active.current && !document.hidden && Date.now() >= expiresAt) {
        void refresh();
      }
    };
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (Date.now() < expiresAt) schedule();
        else refreshIfExpired();
      }, Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647)));
    };
    schedule();
    window.addEventListener('focus', refreshIfExpired);
    document.addEventListener('visibilitychange', refreshIfExpired);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshIfExpired);
      document.removeEventListener('visibilitychange', refreshIfExpired);
    };
  }, [quota.resetAt, quota.limit, isOwner, refresh]);

  return {
    reached: quota.limit === 0 || (quota.remaining === 0 && Date.parse(quota.resetAt) > now),
    refreshing,
    error,
    refresh,
  };
}
