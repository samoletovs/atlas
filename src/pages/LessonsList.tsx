import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLang, useRepo } from '../App';
import { LessonMeta } from '../components/LessonMeta';
import { listLessons, type Lesson } from '../lib/api';
import { useLessonProgressVersion } from '../lib/lessonProgress';
import { LearnHome } from './LearnHome';
import './LessonsList.css';

interface Props {
  status: string;
}

export function LessonsList({ status }: Props) {
  const { lang } = useLang();
  const { repoId } = useRepo();
  if (status === 'published') return <LearnHome />;
  return (
    <Collection
      key={JSON.stringify([status, lang, repoId])}
      status={status}
      lang={lang}
      repoId={repoId}
    />
  );
}

function Collection({
  status,
  lang,
  repoId,
}: Props & { lang: 'en' | 'ru'; repoId: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const progressVersion = useLessonProgressVersion(repoId);
  const heading = status === 'saved' ? 'Saved' : status === 'read' ? 'History' : 'Lessons';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listLessons(status, lang, repoId).then(
      (items) => {
        if (cancelled) return;
        const matching = items.filter((lesson) =>
          lesson.language === lang && (!lesson.repoId || lesson.repoId === repoId));
        setLessons([...new Map(matching.map((lesson) => [lesson.id, lesson])).values()]);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'An unexpected error occurred.');
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [status, lang, repoId, attempt, progressVersion]);

  return (
    <section className="lesson-collection" aria-labelledby="collection-title">
      <header className="collection-heading">
        <h1 id="collection-title">{heading}</h1>
        <p>
          {status === 'saved' ? "Lessons you've saved to return to."
            : status === 'read' ? "Lessons you've marked as read." : 'Browse your lessons.'}
        </p>
      </header>

      {loading && <p className="collection-loading" role="status">Loading {heading.toLowerCase()}...</p>}
      {error && (
        <div className="collection-error" role="alert">
          <div>
            <p>Couldn't load {status === 'saved' ? 'saved lessons' : status === 'read' ? 'reading history' : 'lessons'}.</p>
            <p className="collection-error-detail">{error}</p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setAttempt((current) => current + 1);
            }}
          >
            {loading ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}
      {!loading && !error && lessons.length === 0 && (
        <div className="collection-empty">
          <h2>{status === 'saved' ? 'No saved lessons yet'
            : status === 'read' ? 'No reading history yet' : 'No lessons yet'}</h2>
          <p>
            {status === 'saved' ? 'Save a lesson while reading to find it here later.'
              : status === 'read' ? 'Lessons appear here when you mark them as read.'
                : 'Ready lessons appear on Learn.'}
          </p>
          <Link to="/">Find a lesson <span aria-hidden="true">&rarr;</span></Link>
        </div>
      )}

      {lessons.length > 0 && (
        <ul className="collection-list">
          {lessons.map((lesson) => {
            const readDate = lesson.read_at ? new Date(lesson.read_at) : null;
            const hasReadDate = readDate !== null && !Number.isNaN(readDate.getTime());
            return (
              <li key={lesson.id}>
                <Link to={`/lesson/${lesson.id}`} className="collection-lesson-link">
                  <div className="collection-lesson-content">
                    <h2>{lesson.title}</h2>
                    <LessonMeta lesson={lesson} />
                    {lesson.source_event?.summary && (
                      <p className="collection-source">{lesson.source_event.summary}</p>
                    )}
                    {hasReadDate && (
                      <p className="collection-read-date">
                        Read <time dateTime={lesson.read_at ?? undefined}>
                          {readDate.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </time>
                      </p>
                    )}
                  </div>
                  <span className="collection-row-arrow" aria-hidden="true">&rarr;</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
