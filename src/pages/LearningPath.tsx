import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LearningPathLesson, getRecommendations } from '../lib/api';
import { isRecentlyRead } from '../lib/recentlyRead';
import { useLang, useRepo } from '../App';

/**
 * "For you" page — shows adaptively-ranked unread lessons.
 *
 * Lessons are scored based on the user's reading history:
 *   - Brand-new topics → intro lessons first
 *   - Topics where intro is read → intermediate recommended
 *   - Topics where intermediate is read → deep recommended
 *   - Saved topics get a relevance bonus
 */
export function LearningPath() {
  const { lang } = useLang();
  const { repoId, allowedRepos } = useRepo();
  const [lessons, setLessons] = useState<LearningPathLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLessons(null);
    setError(null);
    getRecommendations(lang, repoId)
      .then((items) =>
        setLessons(items.filter((l) => !isRecentlyRead(l.id))),
      )
      .catch((e: Error) => setError(e.message));
  }, [lang, repoId]);

  if (allowedRepos.length === 0) {
    return (
      <div className="empty">
        <h2>For you</h2>
        <p className="muted">Add a repo first — there's nothing to adapt yet.</p>
      </div>
    );
  }

  if (error) return <div className="error">Couldn't load recommendations: {error}</div>;
  if (!lessons) return <div className="loading">Building your learning path…</div>;

  if (lessons.length === 0) {
    return (
      <div className="empty">
        <h2>For you</h2>
        <p className="muted">
          No new lessons yet, or you've read everything. Check back after your next build
          session — atlas will keep your path fresh.
        </p>
      </div>
    );
  }

  // Top 5 are the primary recommendations; rest goes to "More to explore".
  const top = lessons.slice(0, 5);
  const rest = lessons.slice(5);

  return (
    <div className="list">
      <h2 className="list-heading">For you</h2>
      <p className="learning-path-intro muted">
        Ranked by what fits your current level. Topics you've started come first — at
        the depth that makes sense next.
      </p>

      {top.map((l) => (
        <RecommendedCard key={l.id} lesson={l} />
      ))}

      {rest.length > 0 && (
        <>
          <h2 className="list-heading list-heading-muted">More to explore</h2>
          {rest.map((l) => (
            <RecommendedCard key={l.id} lesson={l} />
          ))}
        </>
      )}
    </div>
  );
}

function RecommendedCard({ lesson }: { lesson: LearningPathLesson }) {
  return (
    <Link to={`/lesson/${lesson.id}`} className="card">
      <div className="card-meta">
        <span className="topic">{lesson.topic.split('/').slice(-1)[0]}</span>
        <span className="depth">{lesson.depth}</span>
        <span className="read-min">{lesson.read_minutes} min</span>
      </div>
      <h3 className="card-title">{lesson.title}</h3>
      {lesson.recommendation_reason && (
        <p className="recommendation-reason">
          <span className="recommendation-icon" aria-hidden="true">✦</span>
          {lesson.recommendation_reason}
        </p>
      )}
      {lesson.source_event?.summary && (
        <p className="card-source">From: {lesson.source_event.summary}</p>
      )}
    </Link>
  );
}
