import { Routes, Route, NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LessonsList } from './pages/LessonsList';
import { LessonReader } from './pages/LessonReader';
import { About } from './pages/About';
import { fetchUser } from './lib/api';

export function App() {
  const [user, setUser] = useState<{ userDetails: string } | null | undefined>(undefined);

  useEffect(() => {
    fetchUser().then(setUser);
  }, []);

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
        <p className="hint">Single-user app. Works with personal Microsoft accounts.</p>
      </div>
    );
  }

  return (
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
        <a className="signout" href="/.auth/logout" title={user.userDetails}>
          Sign out
        </a>
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
  );
}
