import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  addRepo as addRepoApi,
  fetchMe,
  GithubRepoListItem,
  listMyGithubRepos,
} from '../lib/api';
import { useMe, useRepo } from '../App';

type Mode = 'browse' | 'url';

export function AddRepo() {
  const navigate = useNavigate();
  const { refreshMe } = useMe();
  const { setRepoId } = useRepo();

  const [mode, setMode] = useState<Mode>('browse');
  const [hasToken, setHasToken] = useState<boolean | undefined>(undefined);

  // browse mode
  const [repos, setRepos] = useState<GithubRepoListItem[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // url mode
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setHasToken(!!me?.githubToken);
      // If user has no token, default to URL mode (works for public repos).
      if (!me?.githubToken) setMode('url');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        setRepos(list ?? []);
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
  }, [mode, hasToken, repos]);

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

  async function handleAddSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setBrowseError(null);
    let lastSuccessRepoId: string | null = null;
    let failed = 0;
    let i = 0;
    for (const key of selected) {
      i++;
      setProgress(`Adding ${i} of ${selected.size}…`);
      const repoEntry = repos?.find((r) => `${r.owner}/${r.repo}` === key);
      const urlToAdd = repoEntry?.htmlUrl ?? `https://github.com/${key}`;
      try {
        const result = await addRepoApi(urlToAdd);
        lastSuccessRepoId = result.repo.repoId;
      } catch (err) {
        failed++;
        console.warn('addRepo failed for', key, err);
      }
    }
    setProgress(null);
    const me = await refreshMe();
    if (lastSuccessRepoId && me?.allowedRepos.some((r) => r.repoId === lastSuccessRepoId)) {
      setRepoId(lastSuccessRepoId);
    }
    setBusy(false);
    if (failed === 0) {
      navigate('/');
    } else {
      setBrowseError(
        `${failed} of ${selected.size} repos failed to add. The rest were added — switch repos in the header to find them.`,
      );
      setSelected(new Set());
    }
  }

  async function handleAddByUrl(e: React.FormEvent) {
    e.preventDefault();
    setUrlError(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('Paste a GitHub repo URL.');
      return;
    }
    setBusy(true);
    try {
      const result = await addRepoApi(trimmed);
      const me = await refreshMe();
      if (me?.allowedRepos.some((r) => r.repoId === result.repo.repoId)) {
        setRepoId(result.repo.repoId);
      }
      navigate('/');
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <h1>Add a GitHub repo</h1>

      <div className="add-repo-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'browse'}
          className={`add-repo-tab ${mode === 'browse' ? 'active' : ''}`}
          onClick={() => setMode('browse')}
        >
          Browse my repos
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'url'}
          className={`add-repo-tab ${mode === 'url' ? 'active' : ''}`}
          onClick={() => setMode('url')}
        >
          Paste URL
        </button>
      </div>

      {mode === 'browse' && (
        <div className="add-repo-browse">
          {hasToken === undefined ? (
            <p className="muted">Loading…</p>
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
            <p className="muted">Loading your repos…</p>
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
                          disabled={disabled || busy}
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
              {browseError && <div className="form-error">{browseError}</div>}
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || selected.size === 0}
                  onClick={handleAddSelected}
                >
                  {busy
                    ? progress ?? 'Adding…'
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
              disabled={busy}
              required
              autoFocus
            />
            <span className="field-hint">
              Example: https://github.com/samoletovs/atlas
            </span>
          </label>
          {urlError && <div className="form-error">{urlError}</div>}
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add repo'}
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
