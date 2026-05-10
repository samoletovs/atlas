import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useRepo } from '../App';
import { addShare, listShares, revokeShare, RepoShare } from '../lib/api';

/**
 * /admin — owner-only.
 *
 * Lists `repoShares` rows for the currently selected repo. Owner can:
 *   - invite a GitHub user by login (creates a `member` share, idempotent)
 *   - revoke an active share (soft-delete, sets `revokedAt`)
 *
 * Members never see this route in the navbar; if they navigate here directly
 * we redirect them home. The backend also enforces owner-only on every call.
 */
export function Admin() {
  const { repoId, role, allowedRepos } = useRepo();
  const repo = allowedRepos.find((r) => r.repoId === repoId);

  const [shares, setShares] = useState<RepoShare[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteLogin, setInviteLogin] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busyLogin, setBusyLogin] = useState<string | null>(null);

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

  const active = shares?.filter((s) => !s.revokedAt) ?? [];
  const revoked = shares?.filter((s) => s.revokedAt) ?? [];

  return (
    <article className="admin">
      <h2>Admin · {repo?.name ?? repoId}</h2>
      <p className="muted">
        Invite collaborators by GitHub username. They’ll get read access to this
        repo’s lesson library and can track their own progress independently.
      </p>

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
