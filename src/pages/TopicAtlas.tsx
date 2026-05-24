/**
 * Topic atlas — a graph view of every topic that has at least one lesson
 * in the current repo. Node size is proportional to lesson count; edges
 * come from `suggested_next` cross-links between lessons. Clicking a
 * topic opens its newest published lesson.
 *
 * Layout: tiny dependency-free force simulation that runs to a frozen
 * state on mount, then renders as a static SVG. Re-runs only when the
 * repo / language changes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lesson, listLessons } from '../lib/api';
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

  // Edges from suggested_next, but only when both endpoints exist as topics.
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
  // Radius scales with sqrt(count) so a topic with 9 lessons isn't 9× a topic with 1.
  const maxCount = Math.max(1, ...nodes.map((n) => n.count));
  for (const n of nodes) {
    const t = Math.sqrt(n.count) / Math.sqrt(maxCount);
    n.r = MIN_R + (MAX_R - MIN_R) * t;
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
  const { repoId, allowedRepos } = useRepo();
  const navigate = useNavigate();
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'graph' | 'list'>('graph');

  useEffect(() => {
    setLessons(null);
    setError(null);
    listLessons('all', lang, repoId)
      .then(setLessons)
      .catch((e: Error) => setError(e.message));
  }, [lang, repoId]);

  const graph = useMemo(() => {
    if (!lessons) return null;
    const g = buildGraph(lessons);
    runSimulation(g.nodes, g.edges);
    return g;
  }, [lessons]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((prev) => (prev && graph.nodes.some((n) => n.topic === prev) ? prev : graph.nodes[0].topic));
  }, [graph]);

  if (allowedRepos.length === 0) {
    return (
      <div className="empty">
        <h2>Topic atlas</h2>
        <p className="muted">Add a repo first — there's nothing to map yet.</p>
      </div>
    );
  }

  if (error) {
    return <div className="error">Couldn't load topics: {error}</div>;
  }
  if (!graph) {
    return <div className="loading">Mapping topics…</div>;
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="empty">
        <h2>Topic atlas</h2>
        <p className="muted">
          No published lessons yet. Once atlas has written a few, they'll show up here as
          a map you can pan through.
        </p>
      </div>
    );
  }

  const sortedNodes = [...graph.nodes].sort((a, b) => b.count - a.count);
  const activeTopic = hovered ?? selected;
  const activeNode = activeTopic ? graph.nodes.find((n) => n.topic === activeTopic) ?? null : null;

  return (
    <div className="topic-atlas">
      <header className="topic-atlas-header">
        <div className="topic-atlas-header-row">
          <h2>Topic atlas</h2>
          <div className="topic-atlas-mode-toggle" role="group" aria-label="Atlas view mode">
            <button
              type="button"
              className={mode === 'graph' ? 'atlas-mode-btn active' : 'atlas-mode-btn'}
              onClick={() => setMode('graph')}
            >
              Graph
            </button>
            <button
              type="button"
              className={mode === 'list' ? 'atlas-mode-btn active' : 'atlas-mode-btn'}
              onClick={() => setMode('list')}
            >
              List
            </button>
          </div>
        </div>
        <p className="muted">
          Every topic atlas has written for this repo. Bigger circles have more lessons;
          lines connect topics that suggest each other as next steps.
        </p>
        <div className="topic-atlas-stats" aria-label="Atlas summary">
          <span className="atlas-stat">
            <strong>{graph.nodes.length}</strong> topics
          </span>
          <span className="atlas-stat">
            <strong>{graph.nodes.reduce((acc, n) => acc + n.count, 0)}</strong> lessons
          </span>
          <span className="atlas-stat">
            <strong>{graph.edges.length}</strong> connections
          </span>
        </div>
        <div className="topic-atlas-quick-list" aria-label="Top topics">
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
        </div>
      </header>

      {mode === 'graph' ? (
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
                  return (
                    <g
                      key={n.topic}
                      className={`atlas-node${dimmed ? ' dimmed' : ''}${
                        n.primary ? ' has-primary' : ' atlas-node-queued'
                      }`}
                      transform={`translate(${n.x}, ${n.y})`}
                      onMouseEnter={() => setHovered(n.topic)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setSelected(n.topic)}
                      onClick={() => setSelected(n.topic)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${formatTopic(n.topic)}, ${n.count} lessons`}
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
                        {formatTopic(n.topic)}
                      </text>
                      <text y={4} textAnchor="middle" className="atlas-node-count">
                        {n.count}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>

          <aside className="topic-atlas-detail">
            {activeNode ? (
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
            ) : (
              <p className="muted small">Select a topic to see lessons.</p>
            )}
          </aside>
        </div>
      ) : (
        <section className="topic-atlas-list" aria-label="Topic list">
          {sortedNodes.map((n) => (
            <article key={n.topic} className="topic-atlas-list-item">
              <header className="topic-atlas-list-head">
                <h3>{formatTopic(n.topic)}</h3>
                <span className="topic-atlas-pill">{n.count} lesson{n.count === 1 ? '' : 's'}</span>
              </header>
              <ul>
                {n.lessons.slice(0, 4).map((l) => (
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
      )}
    </div>
  );
}
