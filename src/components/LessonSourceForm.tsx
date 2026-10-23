import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  DOCUMENT_SOURCE_MAX_BYTES,
  generateLessonFromDocument,
  generateLessonNow,
  type Lesson,
} from '../lib/api';
import './LessonSourceForm.css';

export function LessonSourceForm({
  lang,
  repoId,
  role,
}: {
  lang: 'en' | 'ru';
  repoId: string;
  role: 'owner' | 'member' | null;
}) {
  const [source, setSource] = useState<'topic' | 'document'>('document');
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Lesson | null>(null);

  if (role !== 'owner') return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setGenerated(null);
    setBusy(true);
    try {
      const input = { title, topic, language: lang };
      const lesson = source === 'document'
        ? await (async () => {
            if (!file) throw new Error('Choose a document to upload.');
            if (!/\.(?:md|txt)$/i.test(file.name)) {
              throw new Error('Choose a plain-text .txt or .md document.');
            }
            if (file.size > DOCUMENT_SOURCE_MAX_BYTES) {
              throw new Error('The document must be no larger than 16000 bytes.');
            }
            const documentText = await file.text();
            if (!documentText.trim()) throw new Error('The document is empty.');
            return generateLessonFromDocument({
              ...input,
              documentName: file.name,
              documentText,
            }, repoId);
          })()
        : await generateLessonNow(input, repoId);
      setGenerated(lesson);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to generate the lesson.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lesson-source-form" aria-labelledby="lesson-source-title">
      <h2 id="lesson-source-title">Create a lesson</h2>
      <form onSubmit={submit}>
        <label>
          Lesson source
          <select value={source} onChange={(event) => setSource(event.target.value as 'topic' | 'document')}>
            <option value="document">Uploaded document</option>
            <option value="topic">Topic prompt</option>
          </select>
        </label>
        <label>
          Lesson title
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </label>
        <label>
          Topic
          <input value={topic} onChange={(event) => setTopic(event.target.value)} required maxLength={200} />
        </label>
        {source === 'document' && (
          <label>
            Document (.txt or .md, up to 16 KB)
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Generating…' : 'Generate lesson'}
        </button>
      </form>
      {error && <p className="lesson-source-error" role="alert">{error}</p>}
      {generated && (
        <p className="lesson-source-success" role="status">
          Lesson created: <Link to={`/lesson/${generated.id}`}>{generated.title}</Link>
        </p>
      )}
    </section>
  );
}
