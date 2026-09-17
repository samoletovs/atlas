import type { Lesson } from '../lib/api';

interface Props {
  lesson: Pick<Lesson, 'topic' | 'depth' | 'read_minutes'>;
  className?: string;
}

export function LessonMeta({ lesson, className }: Props) {
  return (
    <div className={['lesson-meta', className].filter(Boolean).join(' ')}>
      <span>{lesson.topic.split('/').slice(-1)[0]}</span>
      <span>{lesson.depth}</span>
      <span>{lesson.read_minutes} min</span>
    </div>
  );
}
