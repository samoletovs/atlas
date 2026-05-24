import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Lesson,
  getLesson,
  listLessons,
  generateLessonNow,
  updateLessonState,
  askLesson,
  AskChatTurn,
} from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { useLang, useRepo } from '../App';

type SuggestionState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'error'; message: string };

/** Escape a string for safe insertion into an HTML attribute value. */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

export function LessonReader() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { lang } = useLang();
  const { repoId, role } = useRepo();
  const isOwner = role === 'owner';
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<Lesson[]>([]);
  const [suggestionStates, setSuggestionStates] = useState<Record<number, SuggestionState>>({});

  // Ask-more chat: stateless across reloads (history kept only in React state).
  const [chatTurns, setChatTurns] = useState<AskChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    setLesson(null);
    setSuggestionStates({});
    setChatTurns([]);
    setChatDraft('');
    setChatError(null);
    getLesson(id, repoId)
      .then(setLesson)
      .catch((e: Error) => setError(e.message));
  }, [id, repoId]);

  // Fetch library (in current language) for cross-linking suggested_next.
  // Use 'all' so already-read lessons are still linkable.
  useEffect(() => {
    if (!lesson) return;
    const lessonLang = lesson.language ?? lang;
    listLessons('all', lessonLang, repoId)
      .then(setLibrary)
      .catch(() => setLibrary([]));
  }, [lesson, lang, repoId]);

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

  // Render the lesson body once, resolving inline [term](topic:slug) links
  // against the current library. Existing topics → real <a> link. Missing
  // topics → a small button that triggers inline generation on click.
  const bodyHtml = useMemo(() => {
    if (!lesson) return '';
    return renderMarkdown(lesson.body, {
      resolveTopicLink: (slug, label) => {
        const match = topicIndex.get(slug);
        if (match && match.status !== 'queued') {
          return `<a class="topic-link" href="/lesson/${match.id}" data-internal="1">${label}</a>`;
        }
        if (match && match.status === 'queued') {
          // Queued (from --pending or batch) — visible but not clickable yet.
          return `<span class="topic-link topic-link-queued" title="Coming soon">${label}</span>`;
        }
        // Not yet in library. Owners get a generate-on-demand button;
        // members see plain text (they can't generate).
        if (!isOwner) {
          return `<span class="topic-link topic-link-unavailable" title="Not yet in this library">${label}</span>`;
        }
        return (
          `<button type="button" class="topic-link-missing"` +
          ` data-topic-generate="${escAttr(slug)}"` +
          ` data-topic-title="${escAttr(label)}">${label}</button>`
        );
      },
    });
  }, [lesson, topicIndex, isOwner]);

  function handleBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;

    // Internal wiki-link → use react-router (let modifier-clicks open new tab).
    const link = t.closest('a.topic-link[data-internal="1"]') as HTMLAnchorElement | null;
    if (link && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href) navigate(href);
      return;
    }

    // Missing-topic generate button → inline generation, navigate on success.
    const btn = t.closest('button.topic-link-missing') as HTMLButtonElement | null;
    if (btn && !btn.disabled) {
      e.preventDefault();
      const slug = btn.getAttribute('data-topic-generate');
      const titleAttr = btn.getAttribute('data-topic-title');
      if (!slug || !titleAttr || !lesson) return;
      const original = btn.textContent ?? titleAttr;
      btn.disabled = true;
      btn.textContent = 'Generating…';
      generateLessonNow({
        title: titleAttr,
        topic: slug,
        language: lesson.language ?? lang,
        rationale: `Cross-link from "${lesson.title}"`,
        source_lesson_id: lesson.id,
      }, repoId)
        .then((generated) => navigate(`/lesson/${generated.id}`))
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = original;
          const msg = err instanceof Error ? err.message : String(err);
          // Inline generation from body is a bonus path — fall back to alert
          // rather than mutate the body DOM further.
          window.alert(`Couldn’t generate “${titleAttr}”: ${msg}`);
        });
    }
  }

  async function handleMarkRead() {
    if (!lesson) return;
    await updateLessonState(lesson.id, 'mark_read', repoId);
    navigate('/');
  }

  async function handleSaveToggle() {
    if (!lesson) return;
    const updated = await updateLessonState(
      lesson.id,
      lesson.saved ? 'unsave' : 'save',
      repoId
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
      }, repoId);
      // Navigate straight to the new lesson — the body is already populated.
      navigate(`/lesson/${generated.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSuggestionStates((s) => ({ ...s, [idx]: { kind: 'error', message: msg } }));
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!lesson) return;
    const question = chatDraft.trim();
    if (!question || chatBusy) return;

    setChatError(null);
    setChatBusy(true);
    const optimistic: AskChatTurn[] = [...chatTurns, { role: 'user', content: question }];
    setChatTurns(optimistic);
    setChatDraft('');

    try {
      // Send the history WITHOUT the just-appended question — the API
      // appends it itself on top of the system prompt + history.
      const result = await askLesson(lesson.id, question, chatTurns, repoId);
      setChatTurns([...optimistic, { role: 'assistant', content: result.answer }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setChatError(msg);
      // Roll back the optimistic user message so the user can retry / edit.
      setChatTurns(chatTurns);
      setChatDraft(question);
    } finally {
      setChatBusy(false);
    }
  }

  // Keep the latest answer in view when new messages arrive.
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [chatTurns, chatBusy]);

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
        onClick={handleBodyClick}
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
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

              // 3. Not in library — owners can generate; members just see the suggestion.
              if (!isOwner) {
                return (
                  <li key={i} className="next-item next-item-info">
                    <span className="next-title">{s.title}</span>
                    <p className="muted">{s.rationale}</p>
                  </li>
                );
              }
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

      <section className="ask-more">
        <div className="ask-more-head">
          <h4>Ask atlas</h4>
        </div>
        <p className="muted small ask-more-hint">
          Grounded in this lesson. Keep it short — answers stay under 200 words.
        </p>
        <div className="ask-more-log" aria-live="polite">
          {chatTurns.length === 0 && !chatBusy && (
            <p className="muted small ask-more-empty">
              Ask anything that wasn’t clear, or push deeper on a point.
            </p>
          )}
          {chatTurns.map((t, i) => (
            <div key={i} className={`ask-bubble ask-bubble-${t.role}`}>
              {t.content.split('\n').map((line, j) => (
                <p key={j}>{line || '\u00a0'}</p>
              ))}
            </div>
          ))}
          {chatBusy && (
            <div className="ask-bubble ask-bubble-assistant ask-bubble-pending">
              <span className="spinner" aria-hidden="true" /> thinking…
            </div>
          )}
          <div ref={chatBottomRef} />
        </div>
        {chatError && <div className="form-error">{chatError}</div>}
        <form onSubmit={handleAsk} className="ask-more-form">
          <textarea
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleAsk(e as unknown as React.FormEvent);
              }
            }}
            placeholder="What would you like to clarify?"
            rows={2}
            maxLength={1000}
            disabled={chatBusy}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={chatBusy || chatDraft.trim().length === 0}
          >
            {chatBusy ? 'Asking…' : 'Ask'}
          </button>
        </form>
      </section>

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
