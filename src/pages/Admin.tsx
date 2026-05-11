import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe, useRepo } from '../App';
import {
  addShare,
  listShares,
  revokeShare,
  updateRepoSettings,
  AutoGenInterval,
  RepoShare,
} from '../lib/api';

const INTERVAL_OPTIONS: AutoGenInterval[] = [4, 8, 12, 24];

/**
 * /admin — owner-only.
 *
 * Lists `repoShares` rows for the currently selected repo. Owner can:
 *   - configure autonomous lesson generation (P4)
 *   - invite a GitHub user by login (creates a `member` share, idempotent)
 *   - revoke an active share (soft-delete, sets `revokedAt`)
 *
 * Members never see this route in the navbar; if they navigate here directly
 * we redirect them home. The backend also enforces owner-only on every call.
 */
export function Admin() {
  const { repoId, role, allowedRepos } = useRepo();
  const { refreshMe } = useMe();
  const repo = allowedRepos.find((r) => r.repoId === repoId);

  const [shares, setShares] = useState<RepoShare[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteLogin, setInviteLogin] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busyLogin, setBusyLogin] = useState<string | null>(null);

  // P4: autonomous-generation settings. Initialised from the repo entry on
  // `/api/me`; fall back to platform defaults if absent.
  const initialAutoGenerate = repo?.autoGenerate ?? false;
  const initialInterval = (repo?.intervalHours ?? 24) as AutoGenInterval;
  const initialUnreadTarget = repo?.unreadTarget ?? 20;
  const [autoGenerate, setAutoGenerate] = useState<boolean>(initialAutoGenerate);
  const [intervalHours, setIntervalHours] =
    useState<AutoGenInterval>(initialInterval);
  const [unreadTarget, setUnreadTarget] = useState<number>(initialUnreadTarget);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAt, setSettingsSavedAt] = useState<number | null>(null);
  const lastRunAt = repo?.lastRunAt ?? null;

  // When the user switches to a different repo, reset the form to that
  // repo's current settings rather than keeping the previous one's.
  useEffect(() => {
    setAutoGenerate(repo?.autoGenerate ?? false);
    setIntervalHours((repo?.intervalHours ?? 24) as AutoGenInterval);
    setUnreadTarget(repo?.unreadTarget ?? 20);
    setSettingsError(null);
    setSettingsSavedAt(null);
  }, [repo?.repoId, repo?.autoGenerate, repo?.intervalHours, repo?.unreadTarget]);

  const settingsDirty = useMemo(
    () =>
      autoGenerate !== initialAutoGenerate ||
      intervalHours !== initialInterval ||
      unreadTarget !== initialUnreadTarget,
    [
      autoGenerate,
      intervalHours,
      unreadTarget,
      initialAutoGenerate,
      initialInterval,
      initialUnreadTarget,
    ],
  );

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await listShares(repoId);
      setShares(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [repoId]);

  useEffect(() => {
    if (role === 'owner') void refresh();
  }, [refresh, role]);

  if (role !== 'owner') {
    return <Navigate to="/" replace />;
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const login = inviteLogin.trim().toLowerCase();
    if (!login) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      await addShare(repoId, login);
      setInviteLogin('');
      await refresh();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRevoke(login: string) {
    if (!confirm(`Revoke ${login}'s access to ${repo?.name ?? repoId}?`)) return;
    setBusyLogin(login);
    try {
      await revokeShare(repoId, login);
      await refresh();
    } catch (err) {
      alert(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyLogin(null);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await updateRepoSettings(repoId, {
        autoGenerate,
        intervalHours,
        unreadTarget,
      });
      // Refresh /api/me so the updated values land in the AllowedRepo
      // context everywhere (UserMenu, repo switcher, etc.).
      await refreshMe();
      setSettingsSavedAt(Date.now());
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  const active = shares?.filter((s) => !s.revokedAt) ?? [];
  const revoked = shares?.filter((s) => s.revokedAt) ?? [];

  return (
    <article className="admin">
      <h2>Admin · {repo?.name ?? repoId}</h2>
      <p className="muted">
        Invite collaborators by GitHub username. They’ll get read access to this
        repo’s lesson library and can track their own progress independently.
      </p>

      <section className="admin-autogen">
        <h3>Auto-generate lessons</h3>
        <p className="muted">
          When enabled, atlas keeps your unread queue topped up by analysing
          recent commits on this repo and proposing new lessons on a schedule.
          Generation runs server-side; you only see it as fresh items in
          “Next up”.
        </p>
        <form onSubmit={handleSaveSettings} className="admin-autogen-form">
          <label className="admin-autogen-toggle">
            <input
              type="checkbox"
              checked={autoGenerate}
              onChange={(e) => setAutoGenerate(e.target.checked)}
              disabled={settingsBusy}
            />
            <span>Enable autonomous generation</span>
          </label>

          <label htmlFor="autogen-interval">Run every</label>
          <select
            id="autogen-interval"
            value={intervalHours}
            onChange={(e) =>
              setIntervalHours(Number(e.target.value) as AutoGenInterval)
            }
            disabled={settingsBusy || !autoGenerate}
          >
            {INTERVAL_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </select>

          <label htmlFor="autogen-target">Target unread lessons</label>
          <input
            id="autogen-target"
            type="number"
            min={1}
            max={100}
            step={1}
            value={unreadTarget}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setUnreadTarget(Math.round(n));
            }}
            disabled={settingsBusy || !autoGenerate}
          />

          <button
            type="submit"
            className="btn-primary"
            disabled={settingsBusy || !settingsDirty}
          >
            {settingsBusy ? 'Saving…' : 'Save settings'}
          </button>
        </form>
        {settingsError && <p className="error">{settingsError}</p>}
        {settingsSavedAt && !settingsError && !settingsDirty && (
          <p className="muted">Saved.</p>
        )}
        {lastRunAt && (
          <p className="muted">
            Last auto-run: {new Date(lastRunAt).toLocaleString()}
          </p>
        )}
      </section>

      <section className="admin-invite">
        <h3>Invite</h3>
        <form onSubmit={handleInvite}>
          <label htmlFor="invite-login">GitHub username</label>
          <input
            id="invite-login"
            type="text"
            placeholder="e.g. octocat"
            value={inviteLogin}
            onChange={(e) => setInviteLogin(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={inviteBusy}
            maxLength={39}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={inviteBusy || !inviteLogin.trim()}
          >
            {inviteBusy ? 'Inviting…' : 'Invite'}
          </button>
        </form>
        {inviteError && <p className="error">{inviteError}</p>}
      </section>

      <section className="admin-shares">
        <h3>Active shares ({active.length})</h3>
        {loadError && <p className="error">Failed to load: {loadError}</p>}
        {shares === null && !loadError && <p className="muted">Loading…</p>}
        {shares !== null && active.length === 0 && (
          <p className="muted">No collaborators yet — only you have access.</p>
        )}
        {active.length > 0 && (
          <ul className="share-list">
            {active.map((s) => (
              <li key={s.id} className="share-row">
                <a
                  href={`https://github.com/${s.githubLogin}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.githubLogin}
                </a>
                <span className="muted">
                  invited {new Date(s.createdAt).toLocaleDateString()}
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => void handleRevoke(s.githubLogin)}
                  disabled={busyLogin === s.githubLogin}
                >
                  {busyLogin === s.githubLogin ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {revoked.length > 0 && (
          <details className="admin-revoked">
            <summary>Revoked ({revoked.length})</summary>
            <ul className="share-list share-list-revoked">
              {revoked.map((s) => (
                <li key={s.id} className="share-row">
                  <span className="muted">{s.githubLogin}</span>
                  <span className="muted">
                    revoked{' '}
                    {s.revokedAt
                      ? new Date(s.revokedAt).toLocaleDateString()
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </article>
  );
}
