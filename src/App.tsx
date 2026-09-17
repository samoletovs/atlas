import { Routes, Route, NavLink, Link, Navigate, useLocation, useNavigationType } from 'react-router-dom';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { LearnHome } from './pages/LearnHome';
import { LessonsList } from './pages/LessonsList';
import { LessonReader } from './pages/LessonReader';
import { About } from './pages/About';
import { Admin } from './pages/Admin';
import { AddRepo } from './pages/AddRepo';
import { Settings } from './pages/Settings';
import { TopicAtlas } from './pages/TopicAtlas';
import {
  fetchUser,
  fetchMe,
  updatePreferences,
  AllowedRepo,
  AtlasMe,
  AtlasQuota,
  AtlasRole,
  ClientPrincipal,
} from './lib/api';

type Lang = 'en' | 'ru';
type Theme = 'dark' | 'light';

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});
export function useLang() {
  return useContext(LangContext);
}

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'dark',
  toggle: () => {},
});
export function useTheme() {
  return useContext(ThemeContext);
}

function readSavedTheme(): Theme {
  const saved = localStorage.getItem('atlas-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readSavedLang(): Lang {
  const saved = localStorage.getItem('atlas-lang');
  return saved === 'ru' ? 'ru' : 'en';
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
  const { theme, toggle: toggleTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items?.length) {
      items[initialFocus.current === 'last' ? items.length - 1 : 0]?.focus();
    }
    function onDocClick(e: MouseEvent) {
      if (e.target instanceof Node && ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function handleMenuKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % items.length; break;
      case 'ArrowUp': next = (index - 1 + items.length) % items.length; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      case 'Tab':
        close(true);
        return;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="user-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? 'profile-menu' : undefined}
        onClick={() => {
          initialFocus.current = 'first';
          setOpen((o) => !o);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
          setOpen(true);
        }}
      >
        <span className="user-menu-name">{login}</span>
        <span className="user-menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div id="profile-menu" className="user-menu-popover" role="menu" aria-label="Account" onKeyDown={handleMenuKeys}>
          <NavLink to="/repos/new" role="menuitem" onClick={() => close()}>
            + Add repo
          </NavLink>
          <NavLink to="/settings" role="menuitem" onClick={() => close()}>
            Settings
          </NavLink>
          {isOwner && (
            <NavLink to="/admin" role="menuitem" onClick={() => close()}>
              Admin
            </NavLink>
          )}
          <NavLink to="/about" role="menuitem" onClick={() => close()}>
            About
          </NavLink>
          <div className="user-menu-sep" role="separator" />
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
            <span className="user-menu-value">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
          <div className="user-menu-sep" role="separator" />
          <a role="menuitem" href="/.auth/logout">
            Sign out
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub-style brand path: `atlas / {currentRepo}`. The first segment is
 * always a link home; the second segment shows the current repo (plain
 * text with one repo, a small inline <select> with multiple repos, hidden
 * entirely when no repo is connected yet).
 */
function BrandPath() {
  const { repoId, setRepoId, allowedRepos } = useRepo();
  const current = allowedRepos.find((r) => r.repoId === repoId) ?? allowedRepos[0];

  return (
    <div className="brand">
      <Link to="/" className="brand-name" aria-label="Atlas home">
        <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 19 19 5M7 5h12v12" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        Atlas
      </Link>
      {current && (
        <>
          <span className="brand-sep" aria-hidden>
            /
          </span>
          {allowedRepos.length === 1 ? (
            <span className="brand-repo" title={current.repoId}>
              {current.name}
            </span>
          ) : (
            <select
              className="brand-repo brand-repo-select"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              aria-label="Switch repo"
              title="Switch repo"
            >
              {allowedRepos.map((r) => (
                <option key={r.repoId} value={r.repoId}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
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
  const [lang, setLangState] = useState<Lang>(readSavedLang);
  const [theme, setThemeState] = useState<Theme>(readSavedTheme);
  const [repoId, setRepoId] = useState<string>(() => {
    return localStorage.getItem('atlas-repo') || 'samoletovs__nauroLabs';
  });

  // Tracks whether the server has been told about the latest local choice,
  // so we don't PATCH on every render — only when the user actually toggles.
  const serverPrefsRef = useRef<{ theme?: Theme; lang?: Lang }>({});
  const meRefreshVersion = useRef(0);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    // Fire-and-forget — failure just means cross-device sync skipped this turn.
    if (serverPrefsRef.current.lang !== next) {
      serverPrefsRef.current.lang = next;
      updatePreferences({ lang: next }).catch((err) => {
        console.warn('preferences sync (lang) failed', err);
      });
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      if (serverPrefsRef.current.theme !== next) {
        serverPrefsRef.current.theme = next;
        updatePreferences({ theme: next }).catch((err) => {
          console.warn('preferences sync (theme) failed', err);
        });
      }
      return next;
    });
  }, []);

  // Apply theme to the document on every change and persist locally for
  // first-paint on the next visit. The inline script in index.html reads
  // this same key before React mounts.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#111722' : '#f5f6f8');
    localStorage.setItem('atlas-theme', theme);
  }, [theme]);

  const refreshMe = useCallback(async () => {
    const version = ++meRefreshVersion.current;
    const me = await fetchMe();
    if (!me) return null;
    if (version === meRefreshVersion.current) {
      setState((prev) =>
        prev.kind === 'ready' ? { ...prev, me } : prev,
      );
    }
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
        // Apply server-synced preferences (theme/lang). The server is the
        // source of truth once it has a value — local toggles afterwards
        // re-PATCH back to the server.
        const prefs = me.preferences ?? {};
        if (prefs.theme && prefs.theme !== theme) {
          setThemeState(prefs.theme);
        }
        if (prefs.lang && prefs.lang !== lang) {
          setLangState(prefs.lang);
        }
        serverPrefsRef.current = { theme: prefs.theme, lang: prefs.lang };

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
    // We deliberately ignore repoId/theme/lang here; this effect runs once at mount.
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

  const themeCtxValue = { theme, toggle: toggleTheme };

  return (
    <ThemeContext.Provider value={themeCtxValue}>
      <AuthenticatedShell
        me={state.me}
        lang={lang}
        setLang={setLang}
        repoId={repoId}
        setRepoId={setRepoId}
        refreshMe={refreshMe}
      />
    </ThemeContext.Provider>
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
  const location = useLocation();
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  const isReading = location.pathname.startsWith('/lesson/');

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      mainRef.current?.focus({ preventScroll: true });
      if (navigationType !== 'POP') window.scrollTo({ top: 0, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, navigationType]);

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
          <div className={`app-shell${isReading ? ' app-shell--reading' : ''}`}>
            <a className="skip-link" href="#main-content">Skip to content</a>
            <header className="topbar">
              <BrandPath />
              <nav aria-label="Main navigation">
                <NavLink to="/" end>
                  Learn
                </NavLink>
                {hasAnyRepo && <NavLink to="/atlas">Topics</NavLink>}
                <NavLink to="/saved">Saved</NavLink>
                <NavLink to="/read">History</NavLink>
              </nav>
              <div className="topbar-right">
                <QuotaBadge quota={me.quota} />
                <UserMenu
                  login={me.githubLogin}
                  isOwner={currentRole === 'owner'}
                />
              </div>
            </header>
            <main id="main-content" ref={mainRef} tabIndex={-1}>
              <Routes>
                <Route
                  path="/"
                  element={
                    hasAnyRepo ? <LearnHome /> : <NoRepoLanding />
                  }
                />
                <Route path="/saved" element={hasAnyRepo ? <LessonsList status="saved" /> : <NoRepoLanding />} />
                <Route path="/read" element={hasAnyRepo ? <LessonsList status="read" /> : <NoRepoLanding />} />
                <Route path="/for-you" element={<Navigate to={{ pathname: '/', search: location.search, hash: location.hash }} replace />} />
                <Route path="/atlas" element={hasAnyRepo ? <TopicAtlas /> : <NoRepoLanding />} />
                <Route path="/lesson/:id" element={<LessonReader />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/repos/new" element={<AddRepo />} />
                <Route path="/settings" element={<Settings />} />
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
        Connect your GitHub account to pick repos you want atlas to learn from — or
        paste a public repo URL to try it out without signing in further.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <NavLink to="/settings" className="btn-primary">
          Connect GitHub
        </NavLink>
        <NavLink to="/repos/new" className="btn-secondary">
          + Add a public repo
        </NavLink>
      </div>
    </div>
  );
}
