/**
 * Topic index with an optional graph of topics that have at least one lesson
 * in the current repo. Node size is proportional to lesson count; edges
 * come from `suggested_next` cross-links between lessons. Clicking a
 * topic opens its newest published lesson.
 *
 * "Ghost" nodes represent topics referenced in `suggested_next` that have
 * no lessons yet — owners can click them to generate a lesson inline.
 *
 * Layout: tiny dependency-free force simulation that runs to a frozen
 * state when Graph is selected, then renders as a static SVG. The default
 * list does not run the simulation.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lesson, listLessons, generateLessonNow } from '../lib/api';
import { useLang, useRepo } from '../App';

interface TopicNode {
  topic: string;
  count: number;
  lessons: Lesson[];
  /** First non-queued lesson on this topic, used as the click target. */
  primary: Lesson | null;
  // Layout state — filled in by the simulation.
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual radius in px, derived from `count`. */
  r: number;
  /**
   * True for topics that appear in `suggested_next` but have no lessons yet.
   * These render as ghost (dashed) nodes; owners can generate them inline.
   */
  isGhost?: boolean;
  /** Best human-readable title for ghost nodes (from the suggestion entry). */
  ghostTitle?: string;
}

interface TopicEdge {
  from: string; // topic slug
  to: string;   // topic slug
  weight: number;
}

const WIDTH = 800;
const HEIGHT = 560;
const MIN_R = 14;
const MAX_R = 40;
const SIM_ITERATIONS = 220;
const REPULSION = 2400; // node-node
const SPRING = 0.04;    // edge attraction
const SPRING_LEN = 110; // target edge length
const CENTER_PULL = 0.012;
const DAMPING = 0.82;

function buildGraph(lessons: Lesson[]): { nodes: TopicNode[]; edges: TopicEdge[] } {
  const byTopic = new Map<string, TopicNode>();
  for (const l of lessons) {
    if (l.status === 'archived' || l.status === 'drafting') continue;
    const t = (l.topic ?? '').trim();
    if (!t) continue;
    let node = byTopic.get(t);
    if (!node) {
      node = {
        topic: t,
        count: 0,
        lessons: [],
        primary: null,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: MIN_R,
      };
      byTopic.set(t, node);
    }
    node.count += 1;
    node.lessons.push(l);
    if (!node.primary && l.status !== 'queued') {
      node.primary = l;
    }
  }

  // Collect suggested topics that are not yet their own lessons (ghost nodes).
  for (const l of lessons) {
    for (const s of l.suggested_next ?? []) {
      const dst = (s.topic ?? '').trim();
      if (!dst || byTopic.has(dst)) continue;
      byTopic.set(dst, {
        topic: dst,
        count: 0,
        lessons: [],
        primary: null,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: MIN_R * 0.75,
        isGhost: true,
        ghostTitle: (s.title ?? '').trim() || undefined,
      });
    }
  }

  // Edges from suggested_next — now valid for both real and ghost endpoints.
  const edgeKey = (a: string, b: string) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);
  const seen = new Map<string, TopicEdge>();
  for (const l of lessons) {
    const src = (l.topic ?? '').trim();
    if (!src || !byTopic.has(src)) continue;
    for (const s of l.suggested_next ?? []) {
      const dst = (s.topic ?? '').trim();
      if (!dst || dst === src || !byTopic.has(dst)) continue;
      const key = edgeKey(src, dst);
      const existing = seen.get(key);
      if (existing) {
        existing.weight += 1;
      } else {
        seen.set(key, { from: src, to: dst, weight: 1 });
      }
    }
  }

  const nodes = Array.from(byTopic.values());
  // Radius scales with sqrt(count) for real nodes; ghost nodes keep their fixed r.
  const maxCount = Math.max(1, ...nodes.filter((n) => !n.isGhost).map((n) => n.count));
  for (const n of nodes) {
    if (!n.isGhost) {
      const t = Math.sqrt(n.count) / Math.sqrt(maxCount);
      n.r = MIN_R + (MAX_R - MIN_R) * t;
    }
  }

  // Seed positions on a circle so the sim starts spread out, not stacked.
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = Math.min(WIDTH, HEIGHT) * 0.32;
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
  });

  return { nodes, edges: Array.from(seen.values()) };
}

function runSimulation(nodes: TopicNode[], edges: TopicEdge[]): void {
  if (nodes.length === 0) return;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const byTopic = new Map(nodes.map((n) => [n.topic, n] as const));

  for (let step = 0; step < SIM_ITERATIONS; step += 1) {
    // Repulsion (all pairs — fine for <100 nodes).
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.5;
          dy = (Math.random() - 0.5) * 0.5;
          dist2 = dx * dx + dy * dy + 0.01;
        }
        const dist = Math.sqrt(dist2);
        const force = REPULSION / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Spring attraction along edges (heavier edges pull harder).
    for (const e of edges) {
      const a = byTopic.get(e.from);
      const b = byTopic.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const stretch = dist - SPRING_LEN;
      const f = SPRING * stretch * Math.min(3, e.weight);
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Gentle pull toward the centre so disconnected components don't drift.
    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
    }

    // Integrate + damp.
    for (const n of nodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      // Keep nodes inside the viewBox with a small margin.
      const margin = n.r + 4;
      if (n.x < margin) { n.x = margin; n.vx = 0; }
      if (n.x > WIDTH - margin) { n.x = WIDTH - margin; n.vx = 0; }
      if (n.y < margin) { n.y = margin; n.vy = 0; }
      if (n.y > HEIGHT - margin) { n.y = HEIGHT - margin; n.vy = 0; }
    }
  }
}

function formatTopic(s: string): string {
  return s
    .split('/')
    .pop()!
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TopicAtlas() {
  const { lang } = useLang();
  const { repoId, allowedRepos, role } = useRepo();
  return (
    <TopicAtlasContent
      key={JSON.stringify([repoId, lang, role])}
      repoId={repoId}
      lang={lang}
      isOwner={role === 'owner'}
      hasRepos={allowedRepos.length > 0}
    />
  );
}

function TopicAtlasContent({ repoId, lang, isOwner, hasRepos }: {
  repoId: string;
  lang: 'en' | 'ru';
  isOwner: boolean;
  hasRepos: boolean;
}) {
  const navigate = useNavigate();
  const contextKey = `${repoId}\u0000${lang}`;
  const [result, setResult] = useState<{ key: string; lessons: Lesson[] | null; error: string | null }>({
    key: contextKey, lessons: null, error: null,
  });
  const [reload, setReload] = useState(0);
  const lessons = result.key === contextKey ? result.lessons : null;
  const error = result.key === contextKey ? result.error : null;
  const activeContext = useRef(contextKey);
  activeContext.current = contextKey;
  const mounted = useRef(false);
  const generationInFlight = useRef(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'graph' | 'list'>('list');
  const [generatingTopic, setGeneratingTopic] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [newTopicInput, setNewTopicInput] = useState('');

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setResult({ key: contextKey, lessons: null, error: null });
    setHovered(null);
    setGeneratingTopic(null);
    setGenerateError(null);
    setNewTopicInput('');
    listLessons('all', lang, repoId)
      .then((items) => {
        if (active) setResult({ key: contextKey, lessons: items, error: null });
      })
      .catch((reason: unknown) => {
        if (active) setResult({
          key: contextKey, lessons: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => { active = false; };
  }, [contextKey, lang, repoId, reload]);

  const graph = useMemo(() => {
    if (!lessons) return null;
    const g = buildGraph(lessons);
    if (mode === 'graph') runSimulation(g.nodes, g.edges);
    return g;
  }, [lessons, mode]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((prev) => {
      if (prev && graph.nodes.some((n) => n.topic === prev)) return prev;
      const firstReal = graph.nodes.find((n) => !n.isGhost);
      return firstReal ? firstReal.topic : graph.nodes[0].topic;
    });
  }, [graph]);

  async function generateTopic(topic: string, title: string) {
    if (!isOwner || generationInFlight.current) return;
    generationInFlight.current = true;
    const startedContext = contextKey;
    setGeneratingTopic(topic);
    setGenerateError(null);
    try {
      const generated = await generateLessonNow(
        { title, topic, language: lang },
        repoId,
      );
      if (!mounted.current || activeContext.current !== startedContext) return;
      setGeneratingTopic(null);
      navigate(`/lesson/${generated.id}`);
    } catch (e) {
      if (!mounted.current || activeContext.current !== startedContext) {
        console.warn('Topic generation failed after leaving its context', e);
        return;
      }
      setGenerateError(e instanceof Error ? e.message : String(e));
      setGeneratingTopic(null);
    } finally {
      generationInFlight.current = false;
    }
  }

  async function handleGenerateGhost(node: TopicNode) {
    await generateTopic(node.topic, node.ghostTitle || formatTopic(node.topic));
  }

  async function handleGenerateNewTopic(e: { preventDefault(): void }) {
    e.preventDefault();
    const input = newTopicInput.trim();
    if (!input || !isOwner || generatingTopic) return;
    const topic = input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || input;
    await generateTopic(topic, input);
  }

  if (!hasRepos) {
    return (
      <div className="empty">
        <h1>Topics</h1>
        <p className="muted">Add a repo first to explore its lessons.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty">
        <h1>Topics</h1>
        <p className="error-inline" role="alert">Couldn't load topics: {error}</p>
        <button type="button" className="btn-secondary" onClick={() => setReload((value) => value + 1)}>Retry</button>
      </div>
    );
  }
  if (!graph) {
    return <div className="loading" role="status">Loading topics…</div>;
  }

  const realNodes = graph.nodes.filter((n) => !n.isGhost);
  const ghostNodes = graph.nodes.filter((n) => n.isGhost);
  const sortedNodes = [...realNodes].sort((a, b) => b.count - a.count);
  const activeTopic = hovered ?? selected;
  const activeNode = activeTopic ? graph.nodes.find((n) => n.topic === activeTopic) ?? null : null;

  return (
    <div className="topic-atlas">
      <header className="topic-atlas-header">
        <div className="topic-atlas-header-row">
          <h1>Topics</h1>
          <div className="topic-atlas-mode-toggle" role="group" aria-label="Topic view">
            <button
              type="button"
              className={mode === 'list' ? 'atlas-mode-btn active' : 'atlas-mode-btn'}
              aria-pressed={mode === 'list'}
              onClick={() => setMode('list')}
            >
              List
            </button>
            <button
              type="button"
              className={mode === 'graph' ? 'atlas-mode-btn active' : 'atlas-mode-btn'}
              aria-pressed={mode === 'graph'}
              onClick={() => setMode('graph')}
              disabled={graph.nodes.length === 0}
            >
              Graph
            </button>
          </div>
        </div>
        <p className="muted">
          {mode === 'list'
            ? 'Explore the concepts in your lessons. Related topics are suggestions, not prerequisites.'
            : 'Bigger circles have more lessons. Lines show suggested next topics, not prerequisites.'}
        </p>
        <div className="topic-atlas-stats" aria-label="Topic summary">
          <span className="atlas-stat">
            <strong>{realNodes.length}</strong> topics
          </span>
          <span className="atlas-stat">
            <strong>{realNodes.reduce((acc, n) => acc + n.count, 0)}</strong> lessons
          </span>
          <span className="atlas-stat">
            <strong>{graph.edges.length}</strong> connections
          </span>
          {ghostNodes.length > 0 && (
            <span className="atlas-stat">
              <strong>{ghostNodes.length}</strong> suggested
            </span>
          )}
        </div>
        {mode === 'graph' && <div className="topic-atlas-quick-list" aria-label="Top topics">
          {sortedNodes.slice(0, 10).map((n) => (
            <button
              key={n.topic}
              type="button"
              className={activeTopic === n.topic ? 'atlas-chip active' : 'atlas-chip'}
              onClick={() => {
                setSelected(n.topic);
                setHovered(null);
                setMode('graph');
              }}
            >
              {formatTopic(n.topic)} · {n.count}
            </button>
          ))}
        </div>}
        {isOwner && (
          <details className="topic-create">
            <summary>Generate a lesson on a new topic</summary>
          <form className="atlas-generate-form" onSubmit={(e) => void handleGenerateNewTopic(e)}>
            <input
              type="text"
              className="atlas-generate-input"
              placeholder="Generate lesson for any topic…"
              value={newTopicInput}
              onChange={(e) => setNewTopicInput(e.target.value)}
              disabled={!!generatingTopic}
              maxLength={200}
              aria-label="New topic name"
            />
            <button
              type="submit"
              className="btn-primary atlas-generate-btn"
              disabled={!!generatingTopic || !newTopicInput.trim()}
            >
              {generatingTopic && !graph.nodes.some((n) => n.topic === generatingTopic)
                ? 'Generating…'
                : 'Generate →'}
            </button>
          </form>
          </details>
        )}
        {generateError && (
          <p className="error-inline atlas-generate-error">{generateError}</p>
        )}
      </header>

      {graph.nodes.length === 0 ? (
        <section className="empty">
          <h2>No topics yet.</h2>
          <p>Topics will appear as lessons become available in this project.</p>
          <Link to="/" className="btn-secondary">Back to Learn</Link>
        </section>
      ) : mode === 'graph' ? (
        <div className="topic-atlas-canvas">
          <div className="topic-atlas-viewport">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label="Topic map"
              preserveAspectRatio="xMidYMid meet"
            >
              {/* Edges first so nodes paint on top. */}
              <g className="atlas-edges">
                {graph.edges.map((e, i) => {
                  const a = graph.nodes.find((n) => n.topic === e.from)!;
                  const b = graph.nodes.find((n) => n.topic === e.to)!;
                  const active = activeTopic === e.from || activeTopic === e.to;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className={active ? 'atlas-edge active' : 'atlas-edge'}
                      strokeWidth={Math.min(3, 0.6 + e.weight * 0.4)}
                    />
                  );
                })}
              </g>
              <g className="atlas-nodes">
                {graph.nodes.map((n) => {
                  const dimmed = activeTopic != null && activeTopic !== n.topic;
                  const nodeClass = `atlas-node${dimmed ? ' dimmed' : ''}${
                    n.isGhost
                      ? ' atlas-node-ghost'
                      : n.primary
                      ? ' has-primary'
                      : ' atlas-node-queued'
                  }`;
                  return (
                    <g
                      key={n.topic}
                      className={nodeClass}
                      transform={`translate(${n.x}, ${n.y})`}
                      onMouseEnter={() => setHovered(n.topic)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setSelected(n.topic)}
                      onClick={() => setSelected(n.topic)}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        n.isGhost
                          ? `${n.ghostTitle || formatTopic(n.topic)}, suggested (no lesson yet)`
                          : `${formatTopic(n.topic)}, ${n.count} lessons`
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(n.topic);
                        }
                      }}
                    >
                      <circle r={n.r} />
                      <text
                        y={n.r + 14}
                        textAnchor="middle"
                        className="atlas-node-label"
                      >
                        {n.isGhost ? (n.ghostTitle || formatTopic(n.topic)) : formatTopic(n.topic)}
                      </text>
                      {!n.isGhost && (
                        <text y={4} textAnchor="middle" className="atlas-node-count">
                          {n.count}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>

          <aside className="topic-atlas-detail">
            {activeNode ? (
              activeNode.isGhost ? (
                <>
                  <h3>{activeNode.ghostTitle || formatTopic(activeNode.topic)}</h3>
                  <p className="muted small">No lesson yet — suggested by existing topics.</p>
                  {isOwner ? (
                    <button
                      type="button"
                      className="btn-primary atlas-ghost-generate"
                      onClick={() => void handleGenerateGhost(activeNode)}
                      disabled={!!generatingTopic}
                    >
                      {generatingTopic === activeNode.topic ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Generating…
                        </>
                      ) : (
                        'Generate lesson →'
                      )}
                    </button>
                  ) : (
                    <p className="muted small">No lesson is ready for this topic yet.</p>
                  )}
                  {generateError && generatingTopic === null && (
                    <p className="error-inline">{generateError}</p>
                  )}
                </>
              ) : (
                <>
                  <h3>{formatTopic(activeNode.topic)}</h3>
                  <p className="muted small">
                    {activeNode.count} lesson{activeNode.count === 1 ? '' : 's'}
                  </p>
                  <ul>
                    {activeNode.lessons.slice(0, 6).map((l) => (
                      <li key={l.id}>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => navigate(`/lesson/${l.id}`)}
                          disabled={l.status === 'queued'}
                        >
                          {l.title}
                          {l.status === 'queued' && ' (queued)'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : (
              <p className="muted small">Select a topic to see lessons.</p>
            )}
          </aside>
        </div>
      ) : (
        <>
          <section className="topic-atlas-list" aria-label="Topic list">
            {sortedNodes.map((n) => (
              <article key={n.topic} className="topic-atlas-list-item">
                <header className="topic-atlas-list-head">
                  <h3>{formatTopic(n.topic)}</h3>
                  <span className="topic-atlas-pill">{n.count} lesson{n.count === 1 ? '' : 's'}</span>
                </header>
                <ul>
                  {n.lessons.map((l) => (
                    <li key={l.id}>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => navigate(`/lesson/${l.id}`)}
                        disabled={l.status === 'queued'}
                      >
                        {l.title}
                        {l.status === 'queued' && ' (queued)'}
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
          {ghostNodes.length > 0 && (
            <section className="topic-atlas-suggested" aria-label="Suggested topics">
              <h3 className="topic-atlas-suggested-heading">
                Suggested topics
                <span className="muted"> — referenced but not yet generated</span>
              </h3>
              <div className="topic-atlas-list">
                {ghostNodes.map((n) => {
                  const label = n.ghostTitle || formatTopic(n.topic);
                  const busy = generatingTopic === n.topic;
                  return (
                    <article key={n.topic} className="topic-atlas-list-item topic-atlas-list-item-ghost">
                      <header className="topic-atlas-list-head">
                        <h3>{label}</h3>
                        <span className="topic-atlas-pill topic-atlas-pill-ghost">suggested</span>
                      </header>
                      {isOwner && (
                        <button
                          type="button"
                          className="btn-link next-generate"
                          onClick={() => void handleGenerateGhost(n)}
                          disabled={!!generatingTopic}
                        >
                          {busy ? (
                            <>
                              <span className="spinner" aria-hidden="true" /> Generating…
                            </>
                          ) : (
                            'Generate lesson →'
                          )}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
