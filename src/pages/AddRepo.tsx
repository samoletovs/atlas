import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  addRepo as addRepoApi,
  fetchMe,
  GithubRepoListItem,
  listMyGithubRepos,
} from '../lib/api';
import { useMe, useRepo } from '../App';

type Mode = 'browse' | 'url';
interface AddedRepos {
  repoIds: string[];
  failures: string[];
}

export function AddRepo() {
  const navigate = useNavigate();
  const { refreshMe } = useMe();
  const { setRepoId } = useRepo();

  const [mode, setMode] = useState<Mode>('browse');
  const [hasToken, setHasToken] = useState<boolean | undefined>(undefined);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenAttempt, setTokenAttempt] = useState(0);

  // browse mode
  const [repos, setRepos] = useState<GithubRepoListItem[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [browseAttempt, setBrowseAttempt] = useState(0);

  // url mode
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pendingAddition, setPendingAddition] = useState<AddedRepos | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTokenError(null);
    (async () => {
      try {
        const me = await fetchMe();
        if (!me) throw new Error('Your session has expired. Sign in again.');
        if (cancelled) return;
        setHasToken(!!me.githubToken);
        if (!me.githubToken) setMode('url');
      } catch (err) {
        if (!cancelled) setTokenError(`Could not load GitHub access. ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenAttempt]);

  // Load repos when entering browse mode and token is known to exist.
  useEffect(() => {
    if (mode !== 'browse' || !hasToken || repos !== null) return;
    let cancelled = false;
    setLoadingRepos(true);
    setBrowseError(null);
    (async () => {
      try {
        const list = await listMyGithubRepos();
        if (cancelled) return;
        if (list === null) setHasToken(false);
        else setRepos(list);
      } catch (err) {
        if (cancelled) return;
        setBrowseError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, hasToken, repos, browseAttempt]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [repos, filter]);

  function toggle(repoKey: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(repoKey)) next.delete(repoKey);
      else next.add(repoKey);
      return next;
    });
  }

  async function refreshAddedRepos(added: AddedRepos) {
    setBusy(true);
    setRefreshError(null);
    try {
      const me = await refreshMe();
      if (!mounted.current) return;
      const lastRepoId = added.repoIds.at(-1);
      if (!me || !lastRepoId || !me.allowedRepos.some(repo => repo.repoId === lastRepoId)) {
        throw new Error('The updated repository list is not available yet.');
      }
      setRepoId(lastRepoId);
      setPendingAddition(null);
      if (added.failures.length === 0) navigate('/');
      else setBrowseError(`${added.repoIds.length} added. Could not add: ${added.failures.join('; ')}`);
    } catch (err) {
      if (mounted.current) setRefreshError(
        `Repositories added, but account details could not refresh. Retry without adding them again. ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function handleAddSelected() {
    if (selected.size === 0 || busy || pendingAddition) return;
    setBusy(true);
    setBrowseError(null);
    const added: AddedRepos = { repoIds: [], failures: [] };
    const failedKeys = new Set<string>();
    const succeededKeys = new Set<string>();
    const keys = [...selected];
    for (const [index, key] of keys.entries()) {
      setProgress(`Adding ${index + 1} of ${keys.length}…`);
      const repoEntry = repos?.find(repo => `${repo.owner}/${repo.repo}` === key);
      try {
        const result = await addRepoApi(repoEntry?.htmlUrl ?? `https://github.com/${key}`);
        added.repoIds.push(result.repo.repoId);
        succeededKeys.add(key);
      } catch (err) {
        added.failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        failedKeys.add(key);
      }
      if (!mounted.current) return;
    }
    setProgress(null);
    setSelected(failedKeys);
    setRepos(current => current?.map(repo => succeededKeys.has(`${repo.owner}/${repo.repo}`)
      ? { ...repo, inAtlas: true, ownedByOther: false } : repo) ?? null);
    if (added.repoIds.length > 0) {
      setPendingAddition(added);
      await refreshAddedRepos(added);
    } else {
      setBrowseError(`Could not add: ${added.failures.join('; ')}`);
      setBusy(false);
    }
  }

  async function handleAddByUrl(e: React.FormEvent) {
    e.preventDefault();
    if (busy || pendingAddition) return;
    setUrlError(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('Paste a GitHub repo URL.');
      return;
    }
    setBusy(true);
    try {
      const result = await addRepoApi(trimmed);
      if (!mounted.current) return;
      const added: AddedRepos = { repoIds: [result.repo.repoId], failures: [] };
      setPendingAddition(added);
      await refreshAddedRepos(added);
    } catch (err) {
      if (mounted.current) setUrlError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <h1>Add a GitHub repo</h1>

      <div className="add-repo-tabs" role="group" aria-label="Add repository method">
        <button
          type="button"
          aria-pressed={mode === 'browse'}
          disabled={busy || pendingAddition !== null}
          className={`add-repo-tab ${mode === 'browse' ? 'active' : ''}`}
          onClick={() => setMode('browse')}
        >
          Browse my repos
        </button>
        <button
          type="button"
          aria-pressed={mode === 'url'}
          disabled={busy || pendingAddition !== null}
          className={`add-repo-tab ${mode === 'url' ? 'active' : ''}`}
          onClick={() => setMode('url')}
        >
          Paste URL
        </button>
      </div>

      {tokenError && (
        <div>
          <p className="form-error" role="alert">{tokenError}</p>
          <button type="button" className="btn-secondary" onClick={() => setTokenAttempt(attempt => attempt + 1)}>
            Retry GitHub access
          </button>
        </div>
      )}
      {refreshError && pendingAddition && (
        <div>
          <p className="form-error" role="alert">{refreshError}</p>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void refreshAddedRepos(pendingAddition)}>
            {busy ? 'Refreshing…' : 'Retry account refresh'}
          </button>
        </div>
      )}
      {mode === 'browse' && (
        <div className="add-repo-browse">
          {hasToken === undefined ? (
            !tokenError && <p className="muted" role="status">Loading…</p>
          ) : !hasToken ? (
            <div className="empty-state">
              <p className="muted">
                Connect your GitHub account first to browse your repos (including
                private ones). It takes about a minute.
              </p>
              <Link to="/settings" className="btn-primary">
                Connect GitHub →
              </Link>
              <p className="muted small" style={{ marginTop: '1rem' }}>
                Prefer not to? Switch to{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setMode('url')}
                >
                  Paste URL
                </button>{' '}
                for any public repo.
              </p>
            </div>
          ) : loadingRepos ? (
            <p className="muted" role="status">Loading your repos…</p>
          ) : browseError && repos === null ? (
            <div>
              <p className="form-error" role="alert">{browseError}</p>
              <button type="button" className="btn-secondary" onClick={() => setBrowseAttempt(attempt => attempt + 1)}>
                Retry repository list
              </button>
            </div>
          ) : repos === null || repos.length === 0 ? (
            <p className="muted">
              No repos found via your token.{' '}
              <Link to="/settings">Check your token in Settings</Link>.
            </p>
          ) : (
            <>
              <div className="add-repo-filter">
                <input
                  type="search"
                  aria-label="Filter repositories"
                  placeholder={`Filter ${repos.length} repos…`}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <span className="muted small">
                  {selected.size > 0 && `${selected.size} selected · `}
                  {filtered.length} shown
                </span>
              </div>
              <ul className="repo-list">
                {filtered.map((r) => {
                  const key = `${r.owner}/${r.repo}`;
                  const isSelected = selected.has(key);
                  const disabled = r.inAtlas;
                  return (
                    <li
                      key={key}
                      className={`repo-list-item ${disabled ? 'disabled' : ''} ${
                        isSelected ? 'selected' : ''
                      }`}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={disabled || busy || pendingAddition !== null}
                          onChange={() => toggle(key)}
                        />
                        <div className="repo-list-meta">
                          <div className="repo-list-name">
                            {r.fullName}
                            {r.isPrivate && <span className="badge badge-private">private</span>}
                            {r.isArchived && <span className="badge">archived</span>}
                            {r.isFork && <span className="badge">fork</span>}
                            {r.inAtlas && !r.ownedByOther && (
                              <span className="badge badge-ok">already added</span>
                            )}
                            {r.ownedByOther && (
                              <span className="badge badge-warn">taken — request invite</span>
                            )}
                          </div>
                          {r.description && (
                            <div className="repo-list-desc muted small">{r.description}</div>
                          )}
                          <div className="repo-list-stats muted small">
                            {r.language && <span>{r.language}</span>}
                            {r.stargazersCount > 0 && <span>★ {r.stargazersCount}</span>}
                            {r.pushedAt && (
                              <span>updated {new Date(r.pushedAt).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {browseError && <div className="form-error" role="alert">{browseError}</div>}
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || pendingAddition !== null || selected.size === 0}
                  onClick={handleAddSelected}
                >
                  {busy
                    ? progress ?? 'Refreshing…'
                    : selected.size > 0
                      ? `Add ${selected.size} repo${selected.size > 1 ? 's' : ''}`
                      : 'Pick at least one repo'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigate('/')}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {mode === 'url' && (
        <form onSubmit={handleAddByUrl} className="add-repo-form">
          <p className="muted">
            Paste any GitHub repo URL. Public repos work without a token; for private
            repos, <Link to="/settings">connect your GitHub account</Link> first.
          </p>
          <label className="field">
            <span className="field-label">GitHub repo URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              disabled={busy || pendingAddition !== null}
              required
              autoFocus
            />
            <span className="field-hint">
              Example: https://github.com/samoletovs/atlas
            </span>
          </label>
          {urlError && <div className="form-error" role="alert">{urlError}</div>}
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy || pendingAddition !== null}>
              {busy ? (pendingAddition ? 'Refreshing…' : 'Adding…') : 'Add repo'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/')}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
