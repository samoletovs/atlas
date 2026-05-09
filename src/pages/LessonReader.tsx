import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Lesson, getLesson, updateLessonState } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';

export function LessonReader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLesson(null);
    getLesson(id)
      .then(setLesson)
      .catch((e: Error) => setError(e.message));
  }, [id]);

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
          <ul>
            {lesson.suggested_next.map((s, i) => (
              <li key={i}>
                <strong>{s.title}</strong>
                <p className="muted">{s.rationale}</p>
              </li>
            ))}
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
