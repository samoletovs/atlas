import { Routes, Route, NavLink } from 'react-router-dom';
import { createContext, useContext, useEffect, useState } from 'react';
import { LessonsList } from './pages/LessonsList';
import { LessonReader } from './pages/LessonReader';
import { About } from './pages/About';
import { fetchUser } from './lib/api';

type Lang = 'en' | 'ru';
const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});
export function useLang() {
  return useContext(LangContext);
}

function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <button
      className="lang-toggle"
      onClick={() => setLang(lang === 'en' ? 'ru' : 'en')}
      title={lang === 'en' ? 'Переключить на русский' : 'Switch to English'}
    >
      {lang === 'en' ? 'RU' : 'EN'}
    </button>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('atlas-theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('atlas-theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <button
      className="theme-toggle"
      onClick={() => setDark((d) => !d)}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

export function App() {
  const [user, setUser] = useState<{ userDetails: string } | null | undefined>(undefined);
  const [lang, setLang] = useState<Lang>(() => {
    return (localStorage.getItem('atlas-lang') as Lang) || 'en';
  });

  useEffect(() => {
    fetchUser().then(setUser);
  }, []);

  useEffect(() => {
    localStorage.setItem('atlas-lang', lang);
  }, [lang]);

  if (user === undefined) {
    return <div className="loading">Loading…</div>;
  }

  if (user === null) {
    return (
      <div className="signin">
        <h1>atlas</h1>
        <p className="muted">Personal lessons curated from what you build.</p>
        <a className="btn-primary" href="/.auth/login/aad?post_login_redirect_uri=/">
          Sign in with Microsoft
        </a>
      </div>
    );
  }

  return (
    <LangContext.Provider value={{ lang, setLang }}>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">atlas</div>
        <nav>
          <NavLink to="/" end>
            Next up
          </NavLink>
          <NavLink to="/saved">Saved</NavLink>
          <NavLink to="/read">Read</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
        <div className="topbar-right">
          <span className="user-info" title={user.userDetails}>
            {user.userDetails}
          </span>
          <LangToggle />
          <ThemeToggle />
          <a className="signout" href="/.auth/logout">
            Sign out
          </a>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<LessonsList status="published" />} />
          <Route path="/saved" element={<LessonsList status="saved" />} />
          <Route path="/read" element={<LessonsList status="read" />} />
          <Route path="/lesson/:id" element={<LessonReader />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
    </div>
    </LangContext.Provider>
  );
}
