import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Lesson, getLesson, listLessons, generateLessonNow, updateLessonState } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { useLang } from '../App';

type SuggestionState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'error'; message: string };

export function LessonReader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { lang } = useLang();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<Lesson[]>([]);
  const [suggestionStates, setSuggestionStates] = useState<Record<number, SuggestionState>>({});

  useEffect(() => {
    if (!id) return;
    setLesson(null);
    setSuggestionStates({});
    getLesson(id)
      .then(setLesson)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Fetch library (in current language) for cross-linking suggested_next.
  // Use 'all' so already-read lessons are still linkable.
  useEffect(() => {
    if (!lesson) return;
    const lessonLang = lesson.language ?? lang;
    listLessons('all', lessonLang)
      .then(setLibrary)
      .catch(() => setLibrary([]));
  }, [lesson, lang]);

  const topicIndex = useMemo(() => {
    const map = new Map<string, Lesson>();
    for (const l of library) {
      if (l.status === 'archived' || l.status === 'drafting') continue;
      // Prefer non-queued (published/read) over queued for the same topic.
      const existing = map.get(l.topic);
      if (!existing || (existing.status === 'queued' && l.status !== 'queued')) {
        map.set(l.topic, l);
      }
    }
    return map;
  }, [library]);

  async function handleMarkRead() {
    if (!lesson) return;
    await updateLessonState(lesson.id, 'mark_read');
    navigate('/');
  }

  async function handleSaveToggle() {
    if (!lesson) return;
    const updated = await updateLessonState(
      lesson.id,
      lesson.saved ? 'unsave' : 'save'
    );
    setLesson(updated);
  }

  async function handleQueue(idx: number, suggestion: Lesson['suggested_next'][number]) {
    if (!lesson) return;
    setSuggestionStates((s) => ({ ...s, [idx]: { kind: 'generating' } }));
    try {
      const generated = await generateLessonNow({
        title: suggestion.title,
        topic: suggestion.topic,
        language: lesson.language ?? lang,
        rationale: suggestion.rationale,
        source_lesson_id: lesson.id,
      });
      // Navigate straight to the new lesson — the body is already populated.
      navigate(`/lesson/${generated.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSuggestionStates((s) => ({ ...s, [idx]: { kind: 'error', message: msg } }));
    }
  }

  if (error) return <div className="error">Couldn’t load lesson: {error}</div>;
  if (!lesson) return <div className="loading">Loading…</div>;

  return (
    <article className="reader">
      <header className="reader-header">
        <button className="back" onClick={() => navigate(-1)}>
          ← back
        </button>
        <div className="reader-meta">
          <span className="topic">{lesson.topic}</span>
          <span className="depth">· {lesson.depth}</span>
          <span className="read-min">· {lesson.read_minutes} min</span>
        </div>
      </header>

      <h1>{lesson.title}</h1>

      {lesson.source_event?.summary && (
        <p className="source-event">
          <strong>From your work:</strong> {lesson.source_event.summary}
          {lesson.source_event.ref && (
            <span className="source-ref"> — {lesson.source_event.ref}</span>
          )}
        </p>
      )}

      <div
        className="body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(lesson.body) }}
      />

      {lesson.citations.length > 0 && (
        <section className="citations">
          <h4>Sources</h4>
          <ul>
            {lesson.citations.map((c, i) => (
              <li key={i}>
                <a href={c} target="_blank" rel="noopener noreferrer">
                  {c}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {lesson.suggested_next.length > 0 && (
        <section className="next">
          <h4>What to learn next</h4>
          <ul className="next-list">
            {lesson.suggested_next.map((s, i) => {
              const match = topicIndex.get(s.topic);
              const state = suggestionStates[i] ?? { kind: 'idle' };

              // 1. Already exists (published or read) — render as link.
              if (match && match.status !== 'queued') {
                return (
                  <li key={i} className="next-item next-item-link">
                    <Link to={`/lesson/${match.id}`} className="next-link">
                      <span className="next-title">{s.title}</span>
                      <span className="next-arrow" aria-hidden="true">→</span>
                    </Link>
                    <p className="muted">{s.rationale}</p>
                  </li>
                );
              }

              // 2. Already queued (from the manual queue path) — surface as "Coming soon".
              if (match && match.status === 'queued') {
                return (
                  <li key={i} className="next-item next-item-queued">
                    <div className="next-row">
                      <span className="next-title">{s.title}</span>
                      <span className="next-badge">Queued ✓</span>
                    </div>
                    <p className="muted">{s.rationale}</p>
                  </li>
                );
              }

              // 3. Not in library — offer to generate inline (~10s).
              return (
                <li key={i} className="next-item next-item-generate">
                  <div className="next-row">
                    <span className="next-title">{s.title}</span>
                    <button
                      className="btn-link next-generate"
                      onClick={() => handleQueue(i, s)}
                      disabled={state.kind === 'generating'}
                    >
                      {state.kind === 'generating' ? (
                        <>
                          <span className="spinner" aria-hidden="true" />
                          Generating… (~10s)
                        </>
                      ) : (
                        <>Generate this →</>
                      )}
                    </button>
                  </div>
                  <p className="muted">{s.rationale}</p>
                  {state.kind === 'error' && (
                    <p className="error-inline">Couldn’t generate: {state.message}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="reader-actions">
        <button className="btn-primary" onClick={handleMarkRead}>
          Mark read
        </button>
        <button className="btn-secondary" onClick={handleSaveToggle}>
          {lesson.saved ? 'Saved ✓' : 'Save'}
        </button>
      </footer>
    </article>
  );
}

