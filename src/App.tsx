import { Routes, Route, NavLink } from 'react-router-dom';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LessonsList } from './pages/LessonsList';
import { LessonReader } from './pages/LessonReader';
import { About } from './pages/About';
import { Admin } from './pages/Admin';
import { AddRepo } from './pages/AddRepo';
import {
  fetchUser,
  fetchMe,
  AllowedRepo,
  AtlasMe,
  AtlasQuota,
  AtlasRole,
  ClientPrincipal,
} from './lib/api';

type Lang = 'en' | 'ru';
const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});
export function useLang() {
  return useContext(LangContext);
}

interface RepoContextValue {
  repoId: string;
  setRepoId: (r: string) => void;
  allowedRepos: AllowedRepo[];
  /** Caller's role on the currently-selected repo, or null if unresolvable. */
  role: AtlasRole | null;
}
const RepoContext = createContext<RepoContextValue>({
  repoId: 'samoletovs__nauroLabs',
  setRepoId: () => {},
  allowedRepos: [],
  role: null,
});
export function useRepo() {
  return useContext(RepoContext);
}

interface MeContextValue {
  quota: AtlasQuota;
  refreshMe: () => Promise<AtlasMe | null>;
}
const MeContext = createContext<MeContextValue>({
  quota: { used: 0, limit: null, remaining: null, resetAt: '' },
  refreshMe: async () => null,
});
export function useMe() {
  return useContext(MeContext);
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('atlas-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('atlas-theme', dark ? 'dark' : 'light');
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

/**
 * Profile dropdown — shows the GitHub login as the trigger, opens a menu
 * with everything that doesn't need to be on the topbar all the time:
 * Add repo, Admin (owner only), About, language, theme, Sign out.
 *
 * Closes on outside click, Escape, or after navigating to a menu item.
 */
function UserMenu({ login, isOwner }: { login: string; isOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const { lang, setLang } = useLang();
  const { dark, toggle: toggleTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="user-menu-name">{login}</span>
        <span className="user-menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="user-menu-popover" role="menu">
          <NavLink to="/repos/new" role="menuitem" onClick={close}>
            + Add repo
          </NavLink>
          {isOwner && (
            <NavLink to="/admin" role="menuitem" onClick={close}>
              Admin
            </NavLink>
          )}
          <NavLink to="/about" role="menuitem" onClick={close}>
            About
          </NavLink>
          <div className="user-menu-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => setLang(lang === 'en' ? 'ru' : 'en')}
          >
            <span>Language</span>
            <span className="user-menu-value">{lang === 'en' ? 'EN' : 'RU'}</span>
          </button>
          <button type="button" role="menuitem" onClick={toggleTheme}>
            <span>Theme</span>
            <span className="user-menu-value">{dark ? 'Dark' : 'Light'}</span>
          </button>
          <div className="user-menu-sep" />
          <a role="menuitem" href="/.auth/logout">
            Sign out
          </a>
        </div>
      )}
    </div>
  );
}

function RepoPicker() {
  const { repoId, setRepoId, allowedRepos } = useRepo();
  // With one (or zero) repo there is no choice to make — hide the control entirely.
  // The dropdown reappears automatically as soon as a second repo is connected.
  if (allowedRepos.length <= 1) return null;
  return (
    <select
      className="repo-picker"
      value={repoId}
      onChange={(e) => setRepoId(e.target.value)}
      title="Switch repo"
    >
      {allowedRepos.map((r) => (
        <option key={r.repoId} value={r.repoId}>
          {r.ownerId}/{r.name}
        </option>
      ))}
    </select>
  );
}

function ForbiddenScreen({ login }: { login: string }) {
  return (
    <div className="signin">
      <h1>atlas</h1>
      <p className="muted">
        atlas is in private beta. Your GitHub account <strong>{login}</strong> isn’t on the
        access list yet.
      </p>
      <p className="muted">
        Reach out to{' '}
        <a href="https://github.com/samoletovs" target="_blank" rel="noreferrer">
          samoletovs
        </a>{' '}
        if you’d like to try it.
      </p>
      <a className="btn-secondary" href="/.auth/logout">
        Sign out
      </a>
    </div>
  );
}

type AppState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'forbidden'; login: string }
  | { kind: 'ready'; principal: ClientPrincipal; me: AtlasMe };

export function App() {
  const [state, setState] = useState<AppState>({ kind: 'loading' });
  const [lang, setLang] = useState<Lang>(() => {
    return (localStorage.getItem('atlas-lang') as Lang) || 'en';
  });
  const [repoId, setRepoId] = useState<string>(() => {
    return localStorage.getItem('atlas-repo') || 'samoletovs__nauroLabs';
  });

  const refreshMe = useCallback(async () => {
    const me = await fetchMe();
    if (!me) return null;
    setState((prev) =>
      prev.kind === 'ready' ? { ...prev, me } : prev,
    );
    return me;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const principal = await fetchUser();
      if (cancelled) return;
      if (!principal) {
        setState({ kind: 'anonymous' });
        return;
      }
      try {
        const me = await fetchMe();
        if (cancelled) return;
        if (!me) {
          setState({
            kind: 'forbidden',
            login: principal.userDetails || 'unknown',
          });
          return;
        }
        // Empty allowedRepos is no longer "forbidden" — they can add their
        // own repo via /repos/new. We still go to ready, RepoContext just
        // has an empty list and `role: null`.
        if (
          me.allowedRepos.length > 0 &&
          !me.allowedRepos.some((r) => r.repoId === repoId)
        ) {
          setRepoId(me.allowedRepos[0].repoId);
        }
        setState({ kind: 'ready', principal, me });
      } catch (err) {
        console.error('fetchMe failed', err);
        setState({ kind: 'forbidden', login: principal.userDetails || 'unknown' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately ignore repoId here; this effect runs once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('atlas-lang', lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem('atlas-repo', repoId);
  }, [repoId]);

  if (state.kind === 'loading') {
    return <div className="loading">Loading…</div>;
  }

  if (state.kind === 'anonymous') {
    return (
      <div className="signin">
        <h1>atlas</h1>
        <p className="muted">Personal lessons curated from what you build.</p>
        <a className="btn-primary" href="/.auth/login/github?post_login_redirect_uri=/">
          Sign in with GitHub
        </a>
      </div>
    );
  }

  if (state.kind === 'forbidden') {
    return <ForbiddenScreen login={state.login} />;
  }

  return (
    <AuthenticatedShell
      me={state.me}
      lang={lang}
      setLang={setLang}
      repoId={repoId}
      setRepoId={setRepoId}
      refreshMe={refreshMe}
    />
  );
}

interface AuthenticatedShellProps {
  me: AtlasMe;
  lang: Lang;
  setLang: (l: Lang) => void;
  repoId: string;
  setRepoId: (r: string) => void;
  refreshMe: () => Promise<AtlasMe | null>;
}

function AuthenticatedShell({
  me,
  lang,
  setLang,
  repoId,
  setRepoId,
  refreshMe,
}: AuthenticatedShellProps) {
  const currentRole: AtlasRole | null =
    me.allowedRepos.find((r) => r.repoId === repoId)?.role ?? null;

  const repoCtxValue = useMemo<RepoContextValue>(
    () => ({ repoId, setRepoId, allowedRepos: me.allowedRepos, role: currentRole }),
    [repoId, setRepoId, me.allowedRepos, currentRole],
  );
  const langCtxValue = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  const meCtxValue = useMemo<MeContextValue>(
    () => ({ quota: me.quota, refreshMe }),
    [me.quota, refreshMe],
  );

  const hasAnyRepo = me.allowedRepos.length > 0;

  return (
    <LangContext.Provider value={langCtxValue}>
      <RepoContext.Provider value={repoCtxValue}>
        <MeContext.Provider value={meCtxValue}>
          <div className="app-shell">
            <header className="topbar">
              <div className="brand">atlas</div>
              <nav>
                <NavLink to="/" end>
                  Next up
                </NavLink>
                <NavLink to="/saved">Saved</NavLink>
                <NavLink to="/read">Read</NavLink>
              </nav>
              <div className="topbar-right">
                {hasAnyRepo && <RepoPicker />}
                <QuotaBadge quota={me.quota} />
                <UserMenu
                  login={me.githubLogin}
                  isOwner={currentRole === 'owner'}
                />
              </div>
            </header>
            <main>
              <Routes>
                <Route
                  path="/"
                  element={
                    hasAnyRepo ? <LessonsList status="published" /> : <NoRepoLanding />
                  }
                />
                <Route path="/saved" element={<LessonsList status="saved" />} />
                <Route path="/read" element={<LessonsList status="read" />} />
                <Route path="/lesson/:id" element={<LessonReader />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/repos/new" element={<AddRepo />} />
                <Route path="/about" element={<About />} />
              </Routes>
            </main>
          </div>
        </MeContext.Provider>
      </RepoContext.Provider>
    </LangContext.Provider>
  );
}

function QuotaBadge({ quota }: { quota: AtlasQuota }) {
  if (quota.limit === null) return null;
  const remaining = quota.remaining ?? 0;
  const tone = remaining === 0 ? 'quota-badge danger' : remaining <= 1 ? 'quota-badge warn' : 'quota-badge';
  return (
    <span
      className={tone}
      title={`Daily lesson generation cap. Resets at ${new Date(quota.resetAt).toLocaleTimeString()}`}
    >
      {quota.used}/{quota.limit}
    </span>
  );
}

function NoRepoLanding() {
  return (
    <div className="empty-state">
      <h2>Welcome to atlas</h2>
      <p className="muted">
        atlas teaches you what's in a GitHub repo, one bite-sized lesson at a time.
      </p>
      <p className="muted">
        Add a public GitHub repo to get started — atlas will read its README, code, and
        recent activity to generate lessons tailored to it.
      </p>
      <NavLink to="/repos/new" className="btn-primary">
        + Add a GitHub repo
      </NavLink>
    </div>
  );
}
