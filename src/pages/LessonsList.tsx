import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Lesson, listLessons, generateLessonNow } from '../lib/api';
import { isRecentlyRead } from '../lib/recentlyRead';
import { listDueReviewCards, markReviewDone, reviewStepLabel } from '../lib/spacedReview';
import { useLang, useRepo } from '../App';

interface Props {
  status: string;
}

export function LessonsList({ status }: Props) {
  const { lang } = useLang();
  const { repoId, role } = useRepo();
  const navigate = useNavigate();
  const location = useLocation();
  // When navigating here right after marking a lesson read, the id is passed
  // via navigation state so we can filter it out before the API response
  // arrives (works even when the Cosmos read-after-write hasn't propagated).
  const justRead = (location.state as { justRead?: string } | null)?.justRead ?? null;
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [reviewCards, setReviewCards] = useState<
    { lesson: Lesson; step: number; dueAt: string }[]
  >([]);
  const [queued, setQueued] = useState<Lesson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState<Record<string, 'busy' | { error: string }>>({});

  const isOwner = role === 'owner';

  useEffect(() => {
    setLessons(null);
    setError(null);
    listLessons(status, lang, repoId)
      .then((items) =>
        // On "Next up", hide lessons marked read this session even if the
        // backend read-after-write hasn't propagated yet.
        setLessons(
          status === 'published'
            ? items.filter((l) => !isRecentlyRead(l.id) && l.id !== justRead)
            : items,
        ),
      )
      .catch((e: Error) => setError(e.message));

    // Only show "Coming soon" on the main "Next up" view.
    if (status === 'published') {
      listLessons('queued', lang, repoId)
        .then(setQueued)
        .catch(() => setQueued([]));
      listLessons('read', lang, repoId)
        .then((readLessons) => setReviewCards(listDueReviewCards(repoId, readLessons)))
        .catch(() => setReviewCards([]));
    } else {
      setQueued([]);
      setReviewCards([]);
    }
  }, [status, lang, repoId, justRead]);

  if (error) return <div className="error">Couldn’t load lessons: {error}</div>;
  if (!lessons) return <div className="loading">Loading…</div>;

  if (lessons.length === 0 && queued.length === 0) {
    return (
      <div className="empty">
        <h2>{statusToHeading(status)}</h2>
        <p className="muted">{emptyMessage(status)}</p>
      </div>
    );
  }

  return (
    <div className="list">
      <h2 className="list-heading">{statusToHeading(status)}</h2>
      {lessons.map((l) => (
        <Link key={l.id} to={`/lesson/${l.id}`} className="card">
          <div className="card-meta">
            <span className="topic">{l.topic.split('/').slice(-1)[0]}</span>
            <span className="depth depth-{l.depth}">{l.depth}</span>
            <span className="read-min">{l.read_minutes} min</span>
          </div>
          <h3 className="card-title">{l.title}</h3>
          {l.source_event?.summary && (
            <p className="card-source">From: {l.source_event.summary}</p>
          )}
        </Link>
      ))}

      {status === 'published' && reviewCards.length > 0 && (
        <>
          <h2 className="list-heading list-heading-muted">Review cards</h2>
          {reviewCards.map((c) => (
            <article key={c.lesson.id} className="card card-review">
              <div className="card-meta">
                <span className="topic">{c.lesson.topic.split('/').slice(-1)[0]}</span>
                <span>{reviewStepLabel(c.step)}</span>
                <span>due now</span>
              </div>
              <h3 className="card-title">{c.lesson.title}</h3>
              <div className="review-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigate(`/lesson/${c.lesson.id}`)}
                >
                  Review lesson
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    markReviewDone(repoId, c.lesson.id);
                    setReviewCards((current) => current.filter((x) => x.lesson.id !== c.lesson.id));
                  }}
                >
                  Mark reviewed
                </button>
              </div>
            </article>
          ))}
        </>
      )}

      {queued.length > 0 && (
        <>
          <h2 className="list-heading list-heading-muted">Coming soon</h2>
          {queued.map((l) => {
            const state = generating[l.id];
            const busy = state === 'busy';
            const err = typeof state === 'object' ? state.error : null;
            const clickable = isOwner && !busy;
            return (
              <button
                key={l.id}
                type="button"
                className="card card-queued"
                disabled={!clickable}
                onClick={() => {
                  if (!clickable) return;
                  setGenerating((g) => ({ ...g, [l.id]: 'busy' }));
                  generateLessonNow(
                    {
                      title: l.title,
                      topic: l.topic,
                      language: l.language ?? lang,
                      rationale: l.source_event?.summary,
                      source_lesson_id: l.source_event?.ref,
                      depth: l.depth,
                    },
                    repoId,
                  )
                    .then((generated) => navigate(`/lesson/${generated.id}`))
                    .catch((e: Error) => {
                      setGenerating((g) => ({
                        ...g,
                        [l.id]: { error: e.message },
                      }));
                    });
                }}
              >
                <div className="card-meta">
                  <span className="topic">{l.topic.split('/').slice(-1)[0]}</span>
                  <span className="next-badge">
                    {busy ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Generating…
                      </>
                    ) : (
                      'Queued'
                    )}
                  </span>
                </div>
                <h3 className="card-title">{l.title}</h3>
                {l.source_event?.summary && (
                  <p className="card-source muted">{l.source_event.summary}</p>
                )}
                {isOwner && !busy && !err && (
                  <p className="card-hint muted small">Tap to generate now (~10s)</p>
                )}
                {err && <p className="error-inline">Couldn’t generate: {err}</p>}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

function statusToHeading(s: string): string {
  if (s === 'published') return 'Next up';
  if (s === 'saved') return 'Saved';
  if (s === 'read') return 'Already read';
  return s;
}

function emptyMessage(s: string): string {
  if (s === 'published') return 'No new lessons yet. Check back after your next build session.';
  if (s === 'saved') return 'You haven’t saved any lessons.';
  if (s === 'read') return 'You haven’t finished any lessons yet.';
  return 'Nothing here.';
}
