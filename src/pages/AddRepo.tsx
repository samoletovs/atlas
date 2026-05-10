import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addRepo as addRepoApi } from '../lib/api';
import { useMe, useRepo } from '../App';

const VALID_URL_HINT = 'Example: https://github.com/samoletovs/atlas';

export function AddRepo() {
  const navigate = useNavigate();
  const { refreshMe } = useMe();
  const { setRepoId } = useRepo();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Paste a GitHub repo URL.');
      return;
    }
    setBusy(true);
    try {
      const result = await addRepoApi(trimmed);
      // Refresh allowedRepos so the new entry shows up everywhere.
      const me = await refreshMe();
      const newRepoId = result.repo.repoId;
      // Switch the active repo to the newly-added one if our refresh saw it.
      if (me?.allowedRepos.some((r) => r.repoId === newRepoId)) {
        setRepoId(newRepoId);
      }
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <h1>Add a GitHub repo</h1>
      <p className="muted">
        Paste the URL of any public GitHub repo. atlas will read its README, file tree,
        and recent commits, then generate lessons that explain how it works.
      </p>
      <form onSubmit={handleSubmit} className="add-repo-form">
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
          <span className="field-hint">{VALID_URL_HINT}</span>
        </label>
        {error && <div className="form-error">{error}</div>}
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
      <div className="muted small" style={{ marginTop: '2rem' }}>
        <strong>Note:</strong> private repos require an upgraded auth tier and aren't
        supported yet. If your repo is private, ask its owner to make it public or invite
        you to their atlas namespace.
      </div>
    </div>
  );
}
