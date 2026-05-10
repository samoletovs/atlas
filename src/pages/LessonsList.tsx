import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lesson, listLessons } from '../lib/api';
import { useLang } from '../App';

interface Props {
  status: string;
}

export function LessonsList({ status }: Props) {
  const { lang } = useLang();
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [queued, setQueued] = useState<Lesson[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLessons(null);
    setError(null);
    listLessons(status, lang)
      .then(setLessons)
      .catch((e: Error) => setError(e.message));

    // Only show "Coming soon" on the main "Next up" view.
    if (status === 'published') {
      listLessons('queued', lang)
        .then(setQueued)
        .catch(() => setQueued([]));
    } else {
      setQueued([]);
    }
  }, [status, lang]);

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

      {queued.length > 0 && (
        <>
          <h2 className="list-heading list-heading-muted">Coming soon</h2>
          {queued.map((l) => (
            <div key={l.id} className="card card-queued">
              <div className="card-meta">
                <span className="topic">{l.topic.split('/').slice(-1)[0]}</span>
                <span className="next-badge">Queued</span>
              </div>
              <h3 className="card-title">{l.title}</h3>
              {l.source_event?.summary && (
                <p className="card-source muted">{l.source_event.summary}</p>
              )}
            </div>
          ))}
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

