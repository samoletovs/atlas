import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Lesson,
  getLesson,
  listLessons,
  generateLessonNow,
  updateLessonState,
  rateLesson,
  commentLesson,
  askLesson,
  AskChatTurn,
  FEEDBACK_COMMENT_MAX,
  LessonStateAction,
} from '../lib/api';
import { LessonMeta } from '../components/LessonMeta';
import { renderMarkdown } from '../lib/markdown';
import { findRelatedTopics } from '../lib/relatedTopics';
import { markRecentlyRead } from '../lib/recentlyRead';
import { useLang, useRepo } from '../App';
import './LessonReader.css';

type SuggestionState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'error'; message: string };

type ReaderAction = 'save' | 'read' | 'feedback';

/** Escape a string for safe insertion into an HTML attribute value. */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

export function LessonReader() {
  const { id } = useParams();
  const { lang } = useLang();
  const { repoId, role } = useRepo();

  // Each reading context owns its drafts, disclosures, and pending requests.
  return (
    <LessonReaderContent
      key={JSON.stringify([repoId, lang, id])}
      id={id}
      repoId={repoId}
      lang={lang}
      isOwner={role === 'owner'}
    />
  );
}

function LessonReaderContent({
  id,
  repoId,
  lang,
  isOwner,
}: {
  id?: string;
  repoId: string;
  lang: 'en' | 'ru';
  isOwner: boolean;
}) {
  const navigate = useNavigate();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [library, setLibrary] = useState<Lesson[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryAttempt, setLibraryAttempt] = useState(0);
  const [suggestionStates, setSuggestionStates] = useState<Record<number, SuggestionState>>({});
  const [actionBusy, setActionBusy] = useState<ReaderAction | null>(null);
  const [actionError, setActionError] = useState<{ kind: ReaderAction; message: string } | null>(null);
  const [saveNotice, setSaveNotice] = useState('');
  const activeRef = useRef(false);
  const mutationBusyRef = useRef(false);
  const generatingTopicsRef = useRef(new Set<string>());

  // Ask-more chat: stateless across reloads (history kept only in React state).
  const [chatTurns, setChatTurns] = useState<AskChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatRequestRef = useRef(false);

  // Interactive feedback: 1-5 stars + an optional free-text comment.
  const [commentDraft, setCommentDraft] = useState('');
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const mutationBusy = actionBusy !== null || feedbackBusy;

  // Invalidate actions during unmount, before passive effect cleanup runs.
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLesson(null);
    setError(null);
    if (!id) {
      setError('No lesson was selected.');
      return;
    }
    getLesson(id, repoId)
      .then((loaded) => {
        if (!active || !activeRef.current) return;
        setLesson(loaded);
        setCommentDraft(loaded.feedback_comment ?? '');
      })
      .catch((e: unknown) => {
        if (active && activeRef.current) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [id, repoId, loadAttempt]);

  // Fetch library (in current language) for cross-linking suggested_next.
  // Use 'all' so already-read lessons are still linkable.
  const lessonId = lesson?.id;
  const lessonLang = lesson?.language ?? lang;
  useEffect(() => {
    if (!lessonId) return;
    let active = true;
    setLibraryReady(false);
    setLibraryError(null);
    setLibrary([]);
    listLessons('all', lessonLang, repoId)
      .then((loaded) => {
        if (!active || !activeRef.current) return;
        setLibrary(loaded);
        setLibraryReady(true);
      })
      .catch((e: unknown) => {
        if (active && activeRef.current) setLibraryError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [lessonId, lessonLang, repoId, libraryAttempt]);

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

  // Related topics already in the library — instant exploration, no generation.
  // Topics already surfaced by "What to learn next" are excluded to avoid dupes.
  const relatedTopics = useMemo(() => {
    if (!lesson) return [];
    return findRelatedTopics(lesson, library, {
      excludeTopics: lesson.suggested_next.map((s) => s.topic),
    });
  }, [lesson, library]);

  // Render the lesson body once, resolving inline [term](topic:slug) links
  // against the current library. Existing topics → real <a> link. Missing
  // topics → a small button that triggers inline generation on click.
  const lessonBody = lesson?.body;
  const bodyHtml = useMemo(() => {
    if (!lessonBody) return '';
    return renderMarkdown(lessonBody, {
      resolveTopicLink: (slug, label) => {
        if (!libraryReady) {
          const title = libraryError ? 'Linked lessons are unavailable' : 'Checking linked lessons';
          return `<span class="topic-link topic-link-unavailable" title="${title}">${label}</span>`;
        }
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
          ` aria-label="Generate lesson about ${escAttr(label)}"` +
          ` data-topic-generate="${escAttr(slug)}"` +
          ` data-topic-title="${escAttr(label)}">${label}</button>`
        );
      },
    });
  }, [lessonBody, topicIndex, isOwner, libraryReady, libraryError]);

  function handleBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target;
    if (!(t instanceof Element)) return;

    // Internal wiki-link → use react-router (let modifier-clicks open new tab).
    const link = t.closest<HTMLAnchorElement>('a.topic-link[data-internal="1"]');
    if (link && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (href) navigate(href);
      return;
    }

    // Missing-topic generate button → inline generation, navigate on success.
    const btn = t.closest<HTMLButtonElement>('button.topic-link-missing');
    if (btn && !btn.disabled && isOwner && libraryReady) {
      e.preventDefault();
      const slug = btn.getAttribute('data-topic-generate');
      const titleAttr = btn.getAttribute('data-topic-title');
      if (!slug || !titleAttr || !lesson || generatingTopicsRef.current.has(slug)) return;
      generatingTopicsRef.current.add(slug);
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
        .then((generated) => {
          if (activeRef.current) navigate(`/lesson/${generated.id}`);
        })
        .catch((err) => {
          if (!activeRef.current) return;
          btn.disabled = false;
          btn.textContent = original;
          const msg = err instanceof Error ? err.message : String(err);
          // Inline generation from body is a bonus path — fall back to alert
          // rather than mutate the body DOM further.
          window.alert(`Couldn’t generate “${titleAttr}”: ${msg}`);
        })
        .finally(() => {
          generatingTopicsRef.current.delete(slug);
        });
    }
  }

  async function handleStateAction(action: LessonStateAction, kind: ReaderAction) {
    if (!lesson || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setActionBusy(kind);
    setActionError(null);
    setSaveNotice('');
    try {
      const updated = await updateLessonState(lesson.id, action, repoId);
      if (action === 'mark_read') {
        markRecentlyRead(lesson.id, repoId);
      }
      if (!activeRef.current) return;
      if (action === 'mark_read') {
        navigate('/', { state: { justRead: lesson.id } });
      } else {
        setLesson(updated);
        if (kind === 'save') {
          setSaveNotice(updated.saved ? 'Lesson saved.' : 'Lesson removed from Saved.');
        }
      }
    } catch (e) {
      if (activeRef.current) {
        setActionError({ kind, message: e instanceof Error ? e.message : String(e) });
      } else {
        console.warn('Lesson state update failed after navigation', e);
      }
    } finally {
      mutationBusyRef.current = false;
      if (activeRef.current) setActionBusy(null);
    }
  }

  function handleMarkRead() {
    void handleStateAction('mark_read', 'read');
  }

  function handleSaveToggle() {
    if (!lesson) return;
    void handleStateAction(lesson.saved ? 'unsave' : 'save', 'save');
  }

  function handleFeedback(kind: 'up' | 'down') {
    if (!lesson) return;
    const action =
      lesson.feedback === kind ? 'feedback_clear' : kind === 'up' ? 'feedback_up' : 'feedback_down';
    void handleStateAction(action, 'feedback');
  }

  async function handleRate(value: number) {
    if (!lesson || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    const next = lesson.rating === value ? null : value;
    setFeedbackBusy(true);
    setFeedbackError(null);
    setFeedbackSaved(false);
    try {
      const updated = await rateLesson(lesson.id, next, repoId);
      if (!activeRef.current) return;
      setLesson(updated);
      setFeedbackSaved(true);
    } catch (e) {
      if (activeRef.current) setFeedbackError(e instanceof Error ? e.message : String(e));
    } finally {
      mutationBusyRef.current = false;
      if (activeRef.current) setFeedbackBusy(false);
    }
  }

  async function handleCommentSave(e: React.FormEvent) {
    e.preventDefault();
    if (!lesson || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setFeedbackBusy(true);
    setFeedbackError(null);
    setFeedbackSaved(false);
    try {
      const updated = await commentLesson(lesson.id, commentDraft.trim(), repoId);
      if (!activeRef.current) return;
      setLesson(updated);
      setCommentDraft(updated.feedback_comment ?? '');
      setFeedbackSaved(true);
    } catch (e) {
      if (activeRef.current) setFeedbackError(e instanceof Error ? e.message : String(e));
    } finally {
      mutationBusyRef.current = false;
      if (activeRef.current) setFeedbackBusy(false);
    }
  }

  async function handleQueue(idx: number, suggestion: Lesson['suggested_next'][number]) {
    if (!lesson || !isOwner || !libraryReady || generatingTopicsRef.current.has(suggestion.topic)) return;
    generatingTopicsRef.current.add(suggestion.topic);
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
      if (activeRef.current) navigate(`/lesson/${generated.id}`);
    } catch (e) {
      if (!activeRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setSuggestionStates((s) => ({ ...s, [idx]: { kind: 'error', message: msg } }));
    } finally {
      generatingTopicsRef.current.delete(suggestion.topic);
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!lesson) return;
    const question = chatDraft.trim();
    if (!question || chatRequestRef.current) return;

    chatRequestRef.current = true;
    setChatError(null);
    setChatBusy(true);
    const optimistic: AskChatTurn[] = [...chatTurns, { role: 'user', content: question }];
    setChatTurns(optimistic);
    setChatDraft('');

    try {
      // Send the history WITHOUT the just-appended question — the API
      // appends it itself on top of the system prompt + history.
      const result = await askLesson(lesson.id, question, chatTurns, repoId);
      if (!activeRef.current) return;
      setChatTurns([...optimistic, { role: 'assistant', content: result.answer }]);
    } catch (err) {
      if (!activeRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setChatError(msg);
      // Roll back the optimistic user message so the user can retry / edit.
      setChatTurns(chatTurns);
      setChatDraft(question);
    } finally {
      chatRequestRef.current = false;
      if (activeRef.current) setChatBusy(false);
    }
  }

  // Scroll only the conversation, never the article or its disclosure trigger.
  useEffect(() => {
    const log = chatLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chatTurns, chatBusy]);

  if (error || !lesson) {
    return (
      <article className="reader reader--study reader-state" aria-busy={!error}>
        <Link to="/" className="back">← Back to Learn</Link>
        {error ? (
          <>
            <h1>Couldn’t load lesson</h1>
            <p className="error" role="alert">{error}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <p className="loading" role="status">Loading lesson…</p>
        )}
      </article>
    );
  }

  return (
    <article className="reader reader--study" aria-labelledby="lesson-title">
      <header className="reader-header">
        <button type="button" className="back" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <button
          type="button"
          className={`btn-secondary reader-save${lesson.saved ? ' reader-save-active' : ''}`}
          onClick={handleSaveToggle}
          disabled={mutationBusy}
          aria-pressed={!!lesson.saved}
          aria-busy={actionBusy === 'save'}
        >
          {actionBusy === 'save' ? 'Saving…' : lesson.saved ? 'Saved ✓' : 'Save'}
        </button>
      </header>
      <span className="reader-announcement" role="status">{saveNotice}</span>
      {actionError?.kind === 'save' && (
        <p className="form-error" role="alert">Couldn’t update Saved: {actionError.message}</p>
      )}

      <div className="reader-title-block">
        <h1 id="lesson-title" lang={lessonLang}>{lesson.title}</h1>
        <div className="reader-reading-meta">
          <LessonMeta lesson={lesson} className="reader-meta" />
          {lesson.status === 'read' && (
            <span className="reader-read-state">Read ✓</span>
          )}
        </div>
      </div>

      {(lesson.source_event?.summary || lesson.source_event?.ref || lesson.citations.length > 0) && (
        <details className="reader-disclosure reader-sources">
          <summary>
            <span>Sources and context</span>
            {lesson.citations.length > 0 && (
              <span className="reader-disclosure-hint">
                {lesson.citations.length} source{lesson.citations.length === 1 ? '' : 's'}
              </span>
            )}
          </summary>
          <div className="reader-disclosure-content">
            {(lesson.source_event?.summary || lesson.source_event?.ref) && (
              <p className="source-event">
                <strong>From your work:</strong>{' '}
                {lesson.source_event.summary}
                {lesson.source_event.ref && (
                  <span className="source-ref">{lesson.source_event.ref}</span>
                )}
              </p>
            )}
            {lesson.citations.length > 0 && (
              <section className="citations" aria-labelledby="reader-sources-title">
                <h2 id="reader-sources-title">Sources</h2>
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
          </div>
        </details>
      )}

      {lesson.body.trim() ? (
        <div
          className="body"
          lang={lessonLang}
          onClick={handleBodyClick}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      ) : (
        <p className="reader-empty-body" role="status">
          {lesson.status === 'queued' || lesson.status === 'drafting'
            ? 'This lesson is not ready to read yet.'
            : 'This lesson has no reading content yet.'}
        </p>
      )}

      <footer className="reader-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleMarkRead}
          disabled={mutationBusy}
          aria-busy={actionBusy === 'read'}
          aria-describedby="reader-finish-hint"
        >
          {actionBusy === 'read' ? 'Marking read…' : 'Mark read'}
        </button>
        <p id="reader-finish-hint" className="reader-finish-hint">
          {lesson.status === 'read' ? 'Already read. Return to Learn.' : 'Finish here and return to Learn.'}
        </p>
        {actionError?.kind === 'read' && (
          <p className="form-error reader-action-error" role="alert">
            Couldn’t mark read: {actionError.message}
          </p>
        )}
      </footer>

      <details className="reader-disclosure ask-more">
        <summary>
          <span>Ask atlas</span>
          <span className="reader-disclosure-hint">Clarify a point</span>
        </summary>
        <div className="reader-disclosure-content">
          <p id="reader-ask-hint" className="muted small ask-more-hint">
            Grounded in this lesson. Keep it short — answers stay under 200 words.
          </p>
          <div
            ref={chatLogRef}
            className="ask-more-log"
            role="log"
            aria-label="Conversation about this lesson"
            aria-live="polite"
          >
            {chatTurns.length === 0 && !chatBusy && (
              <p className="muted small ask-more-empty">
                Ask anything that wasn’t clear, or push deeper on a point.
              </p>
            )}
            {chatTurns.map((t, i) => (
              <div key={i} className={`ask-bubble ask-bubble-${t.role}`}>
                <span className="ask-speaker">{t.role === 'user' ? 'You' : 'atlas'}</span>
                {t.content.split('\n').map((line, j) => (
                  <p key={j}>{line || '\u00a0'}</p>
                ))}
              </div>
            ))}
            {chatBusy && (
              <div className="ask-bubble ask-bubble-assistant ask-bubble-pending">
                Thinking…
              </div>
            )}
          </div>
          {chatError && <p id="reader-ask-error" className="form-error" role="alert">{chatError}</p>}
          <form onSubmit={handleAsk} className="ask-more-form" aria-busy={chatBusy}>
            <label htmlFor="reader-question">Your question</label>
            <textarea
              id="reader-question"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="What would you like to clarify?"
              rows={3}
              maxLength={1000}
              readOnly={chatBusy}
              aria-describedby={`reader-ask-hint${chatError ? ' reader-ask-error' : ''}`}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={chatBusy || chatDraft.trim().length === 0}
            >
              {chatBusy ? 'Asking…' : 'Ask'}
            </button>
          </form>
        </div>
      </details>

      {libraryError && (
        <div className="reader-library-notice">
          <p className="form-error" role="alert">Couldn’t load linked lessons: {libraryError}</p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLibraryAttempt((attempt) => attempt + 1)}
          >
            Retry linked lessons
          </button>
        </div>
      )}

      {lesson.suggested_next.length > 0 && (
        <section className="next" aria-labelledby="reader-next-title">
          <h2 id="reader-next-title">What to learn next</h2>
          <ul className="next-list">
            {lesson.suggested_next.map((s, i) => {
              const match = topicIndex.get(s.topic);
              const state = suggestionStates[i] ?? { kind: 'idle' };

              // 1. Already exists (published or read) — render as link.
              if (match && match.status !== 'queued') {
                return (
                  <li key={i} className="next-item next-item-link">
                    <Link to={`/lesson/${match.id}`} className="next-link">
                      <span className="next-title" lang={lessonLang}>{s.title}</span>
                      <span className="next-arrow" aria-hidden="true">→</span>
                    </Link>
                    <p className="muted" lang={lessonLang}>{s.rationale}</p>
                  </li>
                );
              }

              // 2. Already queued (from the manual queue path) — surface as "Coming soon".
              if (match && match.status === 'queued') {
                return (
                  <li key={i} className="next-item next-item-queued">
                    <div className="next-row">
                      <span className="next-title" lang={lessonLang}>{s.title}</span>
                      <span className="next-badge">Queued ✓</span>
                    </div>
                    <p className="muted" lang={lessonLang}>{s.rationale}</p>
                  </li>
                );
              }

              // Do not offer generation until queued/existing topics have been checked.
              if (!libraryReady || !isOwner) {
                return (
                  <li key={i} className="next-item next-item-info">
                    <span className="next-title" lang={lessonLang}>{s.title}</span>
                    <p className="muted" lang={lessonLang}>{s.rationale}</p>
                    {!libraryReady && (
                      <p className="muted small">
                        {libraryError ? 'Linked lessons are unavailable.' : 'Checking your library…'}
                      </p>
                    )}
                  </li>
                );
              }
              return (
                <li key={i} className="next-item next-item-generate">
                  <div className="next-row">
                    <span className="next-title" lang={lessonLang}>{s.title}</span>
                    <button
                      type="button"
                      className="btn-link next-generate"
                      onClick={() => handleQueue(i, s)}
                      disabled={state.kind === 'generating'}
                      aria-busy={state.kind === 'generating'}
                    >
                      {state.kind === 'generating' ? 'Generating…' : 'Generate this →'}
                    </button>
                  </div>
                  <p className="muted" lang={lessonLang}>{s.rationale}</p>
                  {state.kind === 'error' && (
                    <p className="error-inline" role="alert">Couldn’t generate: {state.message}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {relatedTopics.length > 0 && (
        <section className="related-topics" aria-labelledby="reader-related-title">
          <h2 id="reader-related-title">Related topics</h2>
          <p className="muted small">Already in your library — jump straight in.</p>
          <ul className="related-list">
            {relatedTopics.map((r) => (
              <li key={r.lesson.id} className="related-item">
                <Link to={`/lesson/${r.lesson.id}`} className="next-link">
                  <span className="next-title" lang={r.lesson.language ?? lessonLang}>{r.lesson.title}</span>
                  <span className="next-arrow" aria-hidden="true">→</span>
                </Link>
                <p className="muted">{r.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="reader-disclosure lesson-feedback">
        <summary>
          <span>How was this lesson?</span>
          <span className="reader-disclosure-hint">Rating and feedback</span>
        </summary>
        <div className="reader-disclosure-content">
          <div className="feedback-group" role="group" aria-label="Lesson feedback" aria-busy={actionBusy === 'feedback'}>
            <button
              type="button"
              className={`btn-feedback${lesson.feedback === 'up' ? ' btn-feedback-active' : ''}`}
              onClick={() => handleFeedback('up')}
              disabled={mutationBusy}
              aria-pressed={lesson.feedback === 'up'}
              aria-label="This lesson was helpful"
            >
              Helpful
            </button>
            <button
              type="button"
              className={`btn-feedback${lesson.feedback === 'down' ? ' btn-feedback-active' : ''}`}
              onClick={() => handleFeedback('down')}
              disabled={mutationBusy}
              aria-pressed={lesson.feedback === 'down'}
              aria-label="This lesson needs work"
            >
              Needs work
            </button>
          </div>
          {actionBusy === 'feedback' && <p className="muted small" role="status">Saving reaction…</p>}
          {actionError?.kind === 'feedback' && (
            <p className="form-error" role="alert">Couldn’t save reaction: {actionError.message}</p>
          )}
          <p className="reader-rating-label">Your rating</p>
          <div className="rating-stars" role="group" aria-label="Rate this lesson from 1 to 5">
            {[1, 2, 3, 4, 5].map((value) => {
              const active = (lesson.rating ?? 0) >= value;
              return (
                <button
                  key={value}
                  type="button"
                  className={`btn-star${active ? ' btn-star-active' : ''}`}
                  onClick={() => handleRate(value)}
                  disabled={mutationBusy}
                  aria-pressed={lesson.rating === value}
                  aria-label={`${value} star${value === 1 ? '' : 's'}`}
                  title={`${value} / 5`}
                >
                  {active ? '★' : '☆'}
                </button>
              );
            })}
            {lesson.rating != null && (
              <span className="muted small rating-value">{lesson.rating}/5</span>
            )}
          </div>
          <form className="feedback-form" onSubmit={handleCommentSave} aria-busy={feedbackBusy}>
            <label htmlFor="reader-feedback-comment">
              Anything to add? <span className="muted">(optional)</span>
            </label>
            <textarea
              id="reader-feedback-comment"
              value={commentDraft}
              onChange={(e) => {
                setCommentDraft(e.target.value);
                setFeedbackSaved(false);
              }}
              placeholder="What worked, what didn’t? (optional)"
              rows={2}
              maxLength={FEEDBACK_COMMENT_MAX}
              readOnly={feedbackBusy}
              aria-label="Lesson feedback comment"
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={mutationBusy || commentDraft.trim() === (lesson.feedback_comment ?? '')}
            >
              {feedbackBusy ? 'Saving…' : 'Save feedback'}
            </button>
          </form>
          {feedbackError && <p className="form-error" role="alert">{feedbackError}</p>}
          {!feedbackError && feedbackSaved && (
            <p className="muted small" role="status">Thanks — your feedback is saved.</p>
          )}
        </div>
      </details>
    </article>
  );
}
