import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deleteGithubToken,
  fetchMe,
  GithubTokenInfo,
  putGithubToken,
} from '../lib/api';
import { useMe } from '../App';

const FINE_GRAINED_NEW_URL =
  'https://github.com/settings/personal-access-tokens/new?name=atlas&description=Atlas%20PWA%20at%20naurolabs.com';

const HELP_TEXT = `Generate a fine-grained personal access token on GitHub. Pick "Only select
repositories" and tick the ones you want atlas to see. Required permissions:
"Contents: Read-only" and "Metadata: Read-only". atlas never writes — read-only
is the right scope.`;

/**
 * Settings page — currently a single section for GitHub access.
 * Future tabs (cost preferences, language, account deletion) live here too.
 */
export function Settings() {
  const { refreshMe } = useMe();
  const [tokenInfo, setTokenInfo] = useState<GithubTokenInfo | null | undefined>(undefined);
  const [pasteValue, setPasteValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      setTokenInfo(me?.githubToken ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMessage(null);
    const trimmed = pasteValue.trim();
    if (!trimmed) {
      setError('Paste a token before saving.');
      return;
    }
    setBusy(true);
    try {
      const info = await putGithubToken(trimmed);
      setTokenInfo(info);
      setPasteValue('');
      setOkMessage('Token saved. You can now browse private repos.');
      await refreshMe();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Strip the leading "putGithubToken failed: <status>:" so the user sees
      // just the server's explanation.
      setError(msg.replace(/^putGithubToken failed:\s*\d+\s*:?\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (!confirm('Forget the stored GitHub token? You can paste a new one any time.')) {
      return;
    }
    setBusy(true);
    setError(null);
    setOkMessage(null);
    try {
      await deleteGithubToken();
      setTokenInfo(null);
      setOkMessage('Token cleared.');
      await refreshMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const loading = tokenInfo === undefined;

  return (
    <div className="page page-narrow">
      <h1>Settings</h1>

      <section className="settings-section">
        <header className="settings-section-head">
          <h2>GitHub access</h2>
          <p className="muted">
            Atlas reads the README, file tree, and recent commits of repos you connect.
            To include <strong>private</strong> repos, paste a fine-grained personal
            access token below. Public repos work without one.
          </p>
        </header>

        {loading ? (
          <p className="muted small">Loading…</p>
        ) : tokenInfo ? (
          <div className="settings-token-card">
            <div className="settings-token-status">
              <span className="status-dot status-ok" aria-hidden />
              <div>
                <strong>Connected.</strong>{' '}
                <span className="muted small">
                  Added {new Date(tokenInfo.addedAt).toLocaleDateString()}
                  {tokenInfo.lastUsedAt &&
                    ` · last used ${new Date(tokenInfo.lastUsedAt).toLocaleDateString()}`}
                </span>
              </div>
            </div>
            {tokenInfo.scopes.length > 0 && (
              <div className="settings-token-scopes muted small">
                Scopes: {tokenInfo.scopes.join(', ')}
              </div>
            )}
            <p className="muted small">
              Now go to <Link to="/repos/new">Add repo</Link> and click "Browse my
              repos" to pick which ones atlas should learn from.
            </p>
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={handleClear} disabled={busy}>
                Forget token
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSave} className="settings-token-form">
            <p className="muted small">{HELP_TEXT}</p>
            <p>
              <a
                href={FINE_GRAINED_NEW_URL}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                Open GitHub to generate a token →
              </a>
            </p>
            <label className="field">
              <span className="field-label">Paste the token</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                placeholder="github_pat_..."
                disabled={busy}
              />
              <span className="field-hint">
                Stored encrypted (AES-256-GCM). Never logged, never returned to your
                browser again. Revoke at any time from GitHub.
              </span>
            </label>
            {error && <div className="form-error">{error}</div>}
            {okMessage && <div className="form-ok">{okMessage}</div>}
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={busy || !pasteValue.trim()}>
                {busy ? 'Saving…' : 'Save token'}
              </button>
            </div>
          </form>
        )}
        {error && tokenInfo && <div className="form-error">{error}</div>}
        {okMessage && tokenInfo && <div className="form-ok">{okMessage}</div>}
      </section>

      <section className="settings-section">
        <header className="settings-section-head">
          <h2>What's coming next</h2>
          <p className="muted">
            One-click GitHub sign-in that grants atlas read access to repos you pick —
            without pasting a token. Tracked on the <Link to="/about">About page</Link>.
          </p>
        </header>
      </section>
    </div>
  );
}
