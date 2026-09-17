import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useLang, useMe, useRepo } from '../App';
import { LessonMeta } from '../components/LessonMeta';
import {
  generateLessonNow,
  getRecommendations,
  listLessons,
  type AtlasRole,
  type LearningPathLesson,
  type Lesson,
} from '../lib/api';
import { isRecentlyRead, useRecentlyReadVersion } from '../lib/recentlyRead';
import { listDueReviewCards, markReviewDone, reviewStepLabel } from '../lib/spacedReview';
import './LearnHome.css';

interface LessonSource<T extends Lesson> {
  items: T[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

type ReadyLesson = Lesson & Partial<Pick<LearningPathLesson, 'recommendation_reason'>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.';
}

function useLessonSource<T extends Lesson>(load: () => Promise<T[]>): LessonSource<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    items: T[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    load().then(
      (items) => {
        if (!cancelled) setState({ items, loading: false, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
        }
      },
    );
    return () => { cancelled = true; };
  }, [load, attempt]);

  return {
    ...state,
    retry: () => {
      setState((current) => ({ ...current, loading: true }));
      setAttempt((current) => current + 1);
    },
  };
}

function SourceWarning({
  source,
  label,
  message,
}: {
  source: Pick<LessonSource<Lesson>, 'loading' | 'error' | 'retry'>;
  label: string;
  message: string;
}) {
  if (!source.error) return null;
  return (
    <div className="learn-notice" role="alert">
      <div>
        <p>{message}</p>
        <p className="learn-error-detail">{source.error}</p>
      </div>
      <button
        type="button"
        className="learn-button"
        disabled={source.loading}
        onClick={source.retry}
      >
        {source.loading ? `Retrying ${label}...` : `Retry ${label}`}
      </button>
    </div>
  );
}

export function LearnHome() {
  const { lang } = useLang();
  const { repoId, role } = useRepo();
  const location = useLocation();
  const navigationState: unknown = location.state;
  const justRead = navigationState && typeof navigationState === 'object'
    && 'justRead' in navigationState && typeof navigationState.justRead === 'string'
    ? navigationState.justRead
    : null;

  // Remount before paint so a new repository or language never shows the old feed.
  return (
    <LearnHomeContent
      key={JSON.stringify([repoId, lang, role, justRead])}
      repoId={repoId}
      lang={lang}
      role={role}
      justRead={justRead}
    />
  );
}

function LearnHomeContent({
  repoId,
  lang,
  role,
  justRead,
}: {
  repoId: string;
  lang: 'en' | 'ru';
  role: AtlasRole | null;
  justRead: string | null;
}) {
  const navigate = useNavigate();
  const { quota, refreshMe } = useMe();
  const readVersion = useRecentlyReadVersion(repoId);
  const recommendations = useLessonSource(useCallback(
    () => getRecommendations(lang, repoId), [lang, repoId],
  ));
  const published = useLessonSource(useCallback(
    () => listLessons('published', lang, repoId), [lang, repoId],
  ));
  const queued = useLessonSource(useCallback(
    () => listLessons('queued', lang, repoId), [lang, repoId],
  ));
  const read = useLessonSource(useCallback(
    () => listLessons('read', lang, repoId), [lang, repoId, readVersion],
  ));
  const [reviewVersion, setReviewVersion] = useState(0);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState('');
  const [generation, setGeneration] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const active = useRef(true);
  const currentRole = useRef(role);
  const generatingIds = useRef(new Set<string>());
  const quotaRequest = useRef(false);
  const [quotaNow, setQuotaNow] = useState(Date.now);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useLayoutEffect(() => { currentRole.current = role; }, [role]);

  const refreshQuota = useCallback(async () => {
    if (quotaRequest.current) return;
    quotaRequest.current = true;
    if (active.current) {
      setQuotaNow(Date.now());
      setQuotaRefreshing(true);
      setQuotaError(null);
    }
    try {
      const me = await refreshMe();
      if (!me) throw new Error('Account limits are unavailable. Please sign in again.');
    } catch (error: unknown) {
      if (active.current) setQuotaError(errorMessage(error));
      else console.warn('Daily quota refresh failed after navigation', error);
    } finally {
      quotaRequest.current = false;
      if (active.current) setQuotaRefreshing(false);
    }
  }, [refreshMe]);

  useEffect(() => {
    const expiresAt = Date.parse(quota.resetAt);
    if (role !== 'owner' || quota.limit === null || !Number.isFinite(expiresAt)) return;
    let stopped = false;
    let timer = 0;
    const refreshIfExpired = () => {
      if (!stopped && active.current && !document.hidden && Date.now() >= expiresAt) {
        setQuotaNow(Date.now());
        void refreshQuota();
      }
    };
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (Date.now() < expiresAt) schedule();
        else refreshIfExpired();
      }, Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647)));
    };
    schedule();
    window.addEventListener('focus', refreshIfExpired);
    document.addEventListener('visibilitychange', refreshIfExpired);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshIfExpired);
      document.removeEventListener('visibilitychange', refreshIfExpired);
    };
  }, [quota.resetAt, quota.limit, role, refreshQuota]);

  const belongsHere = useCallback((lesson: Lesson) =>
    lesson.language === lang && (!lesson.repoId || lesson.repoId === repoId), [lang, repoId]);
  const readLessons = useMemo(() =>
    [...new Map(read.items.filter(belongsHere).map((lesson) => [lesson.id, lesson])).values()],
  [read.items, belongsHere]);
  const readIds = new Set(readLessons.map((lesson) => lesson.id));
  const readyById = new Map<string, ReadyLesson>();

  // Only the recommendations response establishes a ranking or recommendation reason.
  const ranked = recommendations.error ? [] : recommendations.items;
  const unranked = published.items.map((lesson): ReadyLesson => {
    const item: ReadyLesson = { ...lesson };
    delete item.recommendation_reason;
    return item;
  });
  for (const lesson of [...ranked, ...unranked]) {
    if (belongsHere(lesson) && lesson.status === 'published'
      && !readIds.has(lesson.id) && !isRecentlyRead(lesson.id, repoId) && lesson.id !== justRead
      && !readyById.has(lesson.id)) {
      readyById.set(lesson.id, lesson);
    }
  }
  const [lead, ...alternatives] = [...readyById.values()];
  const queuedLessons = [...new Map(
    queued.items.filter((lesson) => belongsHere(lesson)
      && (lesson.status === 'queued' || lesson.status === 'drafting')
      && !readyById.has(lesson.id)).map((lesson) => [lesson.id, lesson]),
  ).values()];
  const reviews = useMemo(() => {
    try {
      return { cards: listDueReviewCards(repoId, readLessons), error: null };
    } catch (error: unknown) {
      return { cards: [], error: errorMessage(error) };
    }
  }, [repoId, readLessons, reviewVersion]);
  const readyLoading = recommendations.loading || published.loading;
  const readyIncomplete = Boolean(recommendations.error || published.error);
  const readyUnavailable = Boolean(recommendations.error && published.error);
  const loadingSources = [
    recommendations.loading && 'recommendations',
    published.loading && 'ready lessons',
    queued.loading && 'queued lessons',
    read.loading && 'reading history',
  ].filter(Boolean);
  const quotaReached = quota.limit === 0
    || (quota.remaining === 0 && Date.parse(quota.resetAt) > quotaNow);

  async function generate(lesson: Lesson) {
    if (currentRole.current !== 'owner' || quotaReached || generatingIds.current.has(lesson.id)) return;
    generatingIds.current.add(lesson.id);
    setGeneration((current) => ({ ...current, [lesson.id]: { busy: true, error: null } }));
    try {
      const generated = await generateLessonNow({
        title: lesson.title,
        topic: lesson.topic,
        language: lesson.language,
        rationale: lesson.source_event?.summary,
        source_lesson_id: lesson.source_event?.ref,
        depth: lesson.depth,
      }, repoId);
      if (!active.current || currentRole.current !== 'owner') return;
      if (generated.status !== 'published') {
        throw new Error('The lesson is not ready yet. Please try again.');
      }
      navigate(`/lesson/${generated.id}`);
    } catch (error: unknown) {
      if (active.current && currentRole.current === 'owner') {
        setGeneration((current) => ({
          ...current,
          [lesson.id]: { busy: false, error: errorMessage(error) },
        }));
      }
    } finally {
      generatingIds.current.delete(lesson.id);
      void refreshQuota();
    }
  }

  function completeReview(lessonId: string) {
    try {
      markReviewDone(repoId, lessonId);
      setReviewError(null);
      setReviewNotice('Review recorded in this browser.');
      setReviewVersion((current) => current + 1);
    } catch (error: unknown) {
      setReviewError(errorMessage(error));
      setReviewNotice('');
    }
  }

  return (
    <div className="learn-home">
      {lead ? (
        <>
          <header className="learn-direction" aria-labelledby="learn-title">
            <div className="learn-direction-content">
              <h1 id="learn-title">{lead.title}</h1>
              <LessonMeta lesson={lead} />
            </div>
            <Link to={`/lesson/${lead.id}`} className="learn-read-link">
              Read lesson <span aria-hidden="true">&rarr;</span>
            </Link>
            {lead.recommendation_reason && (
              <p className="learn-direction-reason">{lead.recommendation_reason}</p>
            )}
          </header>
          {lead.source_event?.summary && (
            <section className="learn-context" aria-labelledby="learn-context-title">
              <h2 id="learn-context-title">Connected to your work</h2>
              <p>{lead.source_event.summary}</p>
            </section>
          )}
        </>
      ) : (
        <header className="learn-intro">
          <h1>
            {readyLoading ? 'Learn' : readyUnavailable ? "Couldn't load ready lessons"
              : readyIncomplete ? "Couldn't load all ready lessons" : 'No ready lessons right now'}
          </h1>
          {!readyLoading && !readyIncomplete && (
            <p>
              {reviews.cards.length > 0
                ? 'Revisit a lesson below, or explore a related topic.'
                : queuedLessons.length > 0
                  ? 'The lessons below are queued, not ready to read yet.'
                  : 'Explore Topics, or return to a lesson in Saved or History.'}
            </p>
          )}
        </header>
      )}

      <div className="learn-service-status">
        {loadingSources.length > 0 && (
          <p className="learn-loading" role="status">Loading {loadingSources.join(', ')}...</p>
        )}
        {lead && recommendations.loading && recommendations.items.length === 0 && (
          <p className="learn-loading">Showing ready lessons while recommendations load.</p>
        )}
        <SourceWarning
          source={recommendations}
          label="recommendations"
          message={lead
            ? "Recommendations couldn't be loaded. Showing available ready lessons without a personalized ranking."
            : "Recommendations couldn't be loaded."}
        />
        <SourceWarning
          source={published}
          label="ready lessons"
          message={lead
            ? "The full ready-lesson list couldn't be loaded. Available recommendations are still shown."
            : "The full ready-lesson list couldn't be loaded."}
        />
        <SourceWarning source={queued} label="queued lessons" message="Queued lessons couldn't be loaded." />
        <SourceWarning
          source={read}
          label="reading history"
          message="Reading history couldn't be loaded. Review reminders may be incomplete."
        />
        {role === 'owner' && (
          <SourceWarning
            source={{ loading: quotaRefreshing, error: quotaError, retry: () => { void refreshQuota(); } }}
            label="daily limit"
            message="The daily limit couldn't be refreshed. The server still checks every generation request."
          />
        )}
      </div>

      {alternatives.length > 0 && (
        <section className="learn-section" aria-labelledby="learn-more-title">
          <div className="learn-section-heading">
            <h2 id="learn-more-title">More to read</h2>
            <p>Other ready lessons</p>
          </div>
          <ul className="learn-lesson-list">
            {alternatives.map((lesson) => (
              <li key={lesson.id}>
                <Link to={`/lesson/${lesson.id}`} className="learn-lesson-link">
                  <div>
                    <h3>{lesson.title}</h3>
                    <LessonMeta lesson={lesson} />
                    {lesson.recommendation_reason && (
                      <p className="learn-row-reason">{lesson.recommendation_reason}</p>
                    )}
                    {!lesson.recommendation_reason && lesson.source_event?.summary && (
                      <p className="learn-row-source">From your work: {lesson.source_event.summary}</p>
                    )}
                  </div>
                  <span className="learn-row-arrow" aria-hidden="true">&rarr;</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(reviews.cards.length > 0 || reviews.error || reviewError || reviewNotice) && (
        <section className="learn-section learn-review" aria-labelledby="learn-review-title">
          <div className="learn-section-heading">
            <h2 id="learn-review-title">Review a lesson</h2>
            <p>Reminders are local to this browser, not synced across devices.</p>
          </div>
          {reviews.error && (
            <div className="learn-notice" role="alert">
              <p>Couldn't load browser-local reviews: {reviews.error}</p>
              <button
                type="button"
                className="learn-button"
                onClick={() => setReviewVersion((current) => current + 1)}
              >
                Retry local reviews
              </button>
            </div>
          )}
          {reviewError && (
            <p className="learn-inline-error" role="alert">
              Couldn't save this review in your browser: {reviewError} Use Mark reviewed to retry.
            </p>
          )}
          {reviewNotice && <p className="learn-review-notice" role="status">{reviewNotice}</p>}
          <ul className="learn-lesson-list">
            {reviews.cards.map((card) => (
              <li key={card.lesson.id}>
                <article className="learn-review-row">
                  <div>
                    <h3>{card.lesson.title}</h3>
                    <LessonMeta lesson={card.lesson} />
                    <p className="learn-review-cadence">{reviewStepLabel(card.step)} &middot; Due now</p>
                  </div>
                  <div className="learn-row-actions">
                    <Link to={`/lesson/${card.lesson.id}`} className="learn-button">Review lesson</Link>
                    <button
                      type="button"
                      className="learn-button"
                      onClick={() => completeReview(card.lesson.id)}
                    >
                      Mark reviewed
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      )}

      {queuedLessons.length > 0 && (
        <section className="learn-section learn-queued" aria-labelledby="learn-queued-title">
          <div className="learn-section-heading">
            <h2 id="learn-queued-title">Not ready yet</h2>
            <p>
              {role === 'owner' ? 'Queued lessons can be generated when you need them.'
                : 'These lessons are queued. Only repository owners can generate them.'}
            </p>
          </div>
          {role === 'owner' && quotaReached && (
            <p className="learn-inline-error" role="status">
              Your generation limit has been reached. You can still read ready lessons.
            </p>
          )}
          <ul className="learn-lesson-list">
            {queuedLessons.map((lesson) => {
              const state = generation[lesson.id];
              const busy = state?.busy ?? false;
              const drafting = lesson.status === 'drafting';
              return (
                <li key={lesson.id}>
                  <article className="learn-queued-row">
                    <div>
                      <p className="learn-queued-label">{drafting ? 'Being prepared' : 'Queued'}</p>
                      <h3>{lesson.title}</h3>
                      <p className="learn-queued-topic">{lesson.topic.split('/').slice(-1)[0]}</p>
                      {lesson.source_event?.summary && (
                        <p className="learn-row-source">{lesson.source_event.summary}</p>
                      )}
                    </div>
                    {role === 'owner' && (
                      <div className="learn-row-actions">
                        <button
                          type="button"
                          className="learn-button"
                          disabled={busy || drafting || quotaReached}
                          aria-busy={busy}
                          onClick={() => { void generate(lesson); }}
                        >
                          {busy ? 'Generating lesson...' : drafting ? 'Being prepared'
                            : state?.error ? 'Retry generation' : 'Generate lesson'}
                        </button>
                        {busy && <p role="status">Generating this lesson. It will open when ready.</p>}
                        {state?.error && (
                          <p className="learn-inline-error" role="alert">Couldn't generate: {state.error}</p>
                        )}
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!lead && !readyLoading && (
        <div className="learn-retrieval">
          <Link to="/atlas">Explore Topics <span aria-hidden="true">&rarr;</span></Link>
          <Link to="/saved">Saved lessons</Link>
          <Link to="/read">Reading history</Link>
        </div>
      )}
    </div>
  );
}
