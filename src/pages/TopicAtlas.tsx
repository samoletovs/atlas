/**
 * Topic atlas — a graph view of every topic that has at least one lesson
 * in the current repo. Node size is proportional to lesson count; edges
 * come from `suggested_next` cross-links between lessons.
 *
 * The page is mobile-first: the topic list and detail panel are the primary
 * interaction surfaces, while the graph helps users spot clusters on larger
 * screens and still works as a touch-friendly selector on phones.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lesson, listLessons } from '../lib/api';
import { useLang, useRepo } from '../App';

interface TopicNode {
  topic: string;
  count: number;
  lessons: Lesson[];
  /** Newest non-queued lesson on this topic, used as the default CTA. */
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

interface TopicRelation {
  topic: string;
  weight: number;
}

interface TopicSummary {
  label: string;
  latestAt: number;
  latestLesson: Lesson | null;
  totalReadMinutes: number;
}

const WIDTH = 900;
const HEIGHT = 620;
const MIN_R = 16;
const MAX_R = 44;
const SIM_ITERATIONS = 220;
const REPULSION = 2500; // node-node
const SPRING = 0.04;    // edge attraction
const SPRING_LEN = 118; // target edge length
const CENTER_PULL = 0.012;
const DAMPING = 0.82;

function newestFirst(a: Lesson, b: Lesson): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

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
    if (
      l.status !== 'queued' &&
      (!node.primary || Date.parse(l.created_at) > Date.parse(node.primary.created_at))
    ) {
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
  const maxCount = Math.max(1, ...nodes.map((n) => n.count));
  for (const n of nodes) {
    n.lessons.sort(newestFirst);
    const t = Math.sqrt(n.count) / Math.sqrt(maxCount);
    n.r = MIN_R + (MAX_R - MIN_R) * t;
  }

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = Math.min(WIDTH, HEIGHT) * 0.34;
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

    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
    }

    for (const n of nodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      const margin = n.r + 8;
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

function sortByCountThenRecent(a: TopicNode, b: TopicNode): number {
  return (
    b.count - a.count ||
    Date.parse(b.lessons[0]?.created_at ?? '') - Date.parse(a.lessons[0]?.created_at ?? '') ||
    formatTopic(a.topic).localeCompare(formatTopic(b.topic))
  );
}

export function TopicAtlas() {
  const { lang } = useLang();
  const { repoId, allowedRepos } = useRepo();
  const navigate = useNavigate();
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'count' | 'recent' | 'alpha'>('count');

  useEffect(() => {
    setLessons(null);
    setError(null);
    setHovered(null);
    setSelected(null);
    setQuery('');
    setSortBy('count');
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

  const nodeByTopic = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.topic, n] as const)),
    [graph],
  );

  const relationsByTopic = useMemo(() => {
    const map = new Map<string, TopicRelation[]>();
    if (!graph) return map;
    for (const node of graph.nodes) map.set(node.topic, []);
    for (const edge of graph.edges) {
      map.get(edge.from)?.push({ topic: edge.to, weight: edge.weight });
      map.get(edge.to)?.push({ topic: edge.from, weight: edge.weight });
    }
    for (const [topic, relations] of map) {
      relations.sort(
        (a, b) => b.weight - a.weight || formatTopic(a.topic).localeCompare(formatTopic(b.topic)),
      );
      map.set(topic, relations);
    }
    return map;
  }, [graph]);

  const summariesByTopic = useMemo(() => {
    const map = new Map<string, TopicSummary>();
    if (!graph) return map;
    for (const node of graph.nodes) {
      map.set(node.topic, {
        label: formatTopic(node.topic),
        latestAt: Date.parse(node.lessons[0]?.created_at ?? '') || 0,
        latestLesson: node.primary,
        totalReadMinutes: node.lessons.reduce((sum, lesson) => sum + (lesson.read_minutes ?? 0), 0),
      });
    }
    return map;
  }, [graph]);

  const normalizedQuery = query.trim().toLowerCase();

  const visibleNodes = useMemo(() => {
    if (!graph) return [];
    const filtered = graph.nodes.filter((node) => {
      if (!normalizedQuery) return true;
      const label = formatTopic(node.topic).toLowerCase();
      return (
        node.topic.toLowerCase().includes(normalizedQuery) ||
        label.includes(normalizedQuery) ||
        node.lessons.some((lesson) => lesson.title.toLowerCase().includes(normalizedQuery))
      );
    });

    filtered.sort((a, b) => {
      if (sortBy === 'alpha') {
        return formatTopic(a.topic).localeCompare(formatTopic(b.topic));
      }
      if (sortBy === 'recent') {
        return (
          (summariesByTopic.get(b.topic)?.latestAt ?? 0) -
            (summariesByTopic.get(a.topic)?.latestAt ?? 0) ||
          sortByCountThenRecent(a, b)
        );
      }
      return sortByCountThenRecent(a, b);
    });

    return filtered;
  }, [graph, normalizedQuery, sortBy, summariesByTopic]);

  useEffect(() => {
    if (visibleNodes.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !visibleNodes.some((node) => node.topic === selected)) {
      setSelected(visibleNodes[0].topic);
    }
  }, [selected, visibleNodes]);

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
          a map you can browse and search.
        </p>
      </div>
    );
  }

  const totalLessons = graph.nodes.reduce((sum, node) => sum + node.count, 0);
  const connectedTopics = graph.nodes.filter((node) => (relationsByTopic.get(node.topic)?.length ?? 0) > 0).length;
  const mostConnected = graph.nodes
    .slice()
    .sort(
      (a, b) =>
        (relationsByTopic.get(b.topic)?.length ?? 0) - (relationsByTopic.get(a.topic)?.length ?? 0) ||
        sortByCountThenRecent(a, b),
    )[0];

  const activeTopic = hovered ?? selected;
  const activeNode = activeTopic ? nodeByTopic.get(activeTopic) ?? null : null;
  const activeRelations = activeTopic ? relationsByTopic.get(activeTopic) ?? [] : [];
  const activeRelatedTopics = new Set(activeRelations.map((relation) => relation.topic));
  const visibleTopicSet = new Set(visibleNodes.map((node) => node.topic));

  return (
    <div className="topic-atlas">
      <header className="topic-atlas-header">
        <div>
          <p className="topic-atlas-kicker">Explore the repo</p>
          <h2>Topic atlas</h2>
          <p className="muted">
            Mobile-first browsing for everything atlas has taught from this repo.
            Start with the topic list, then use the map to spot clusters and next steps.
          </p>
        </div>
      </header>

      <section className="topic-atlas-summary" aria-label="Atlas summary">
        <article className="topic-atlas-summary-card">
          <span className="topic-atlas-summary-label">Topics</span>
          <strong>{graph.nodes.length}</strong>
          <p className="muted small">Distinct things atlas can already teach in this repo.</p>
        </article>
        <article className="topic-atlas-summary-card">
          <span className="topic-atlas-summary-label">Lessons</span>
          <strong>{totalLessons}</strong>
          <p className="muted small">Use this to find dense areas before you dive into a lesson.</p>
        </article>
        <article className="topic-atlas-summary-card">
          <span className="topic-atlas-summary-label">Connected topics</span>
          <strong>{connectedTopics}</strong>
          <p className="muted small">These are linked by suggested next steps, not just listed nearby.</p>
        </article>
        <article className="topic-atlas-summary-card">
          <span className="topic-atlas-summary-label">Most connected</span>
          <strong>{mostConnected ? formatTopic(mostConnected.topic) : '—'}</strong>
          <p className="muted small">A good place to start if you want a hub with lots of follow-ons.</p>
        </article>
      </section>

      <section className="topic-atlas-toolbar" aria-label="Topic atlas filters">
        <label className="topic-atlas-search">
          <span className="topic-atlas-control-label">Find a topic</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topics or lesson titles"
            aria-label="Search topics or lesson titles"
          />
        </label>
        <label className="topic-atlas-sort">
          <span className="topic-atlas-control-label">Sort</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'count' | 'recent' | 'alpha')}>
            <option value="count">Most lessons</option>
            <option value="recent">Most recent</option>
            <option value="alpha">A–Z</option>
          </select>
        </label>
      </section>

      <div className="topic-atlas-layout">
        <section className="topic-atlas-browser" aria-labelledby="topic-atlas-browser-heading">
          <div className="topic-atlas-section-head">
            <div>
              <h3 id="topic-atlas-browser-heading">Browse topics</h3>
              <p className="muted">Tap a topic to inspect lessons and related branches.</p>
            </div>
            <span className="muted small">{visibleNodes.length} shown</span>
          </div>

          {visibleNodes.length === 0 ? (
            <div className="topic-atlas-empty-search">
              <p>No topics match “{query}”.</p>
              <button type="button" className="btn-link" onClick={() => setQuery('')}>
                Clear search
              </button>
            </div>
          ) : (
            <div className="topic-atlas-topic-list">
              {visibleNodes.map((node) => {
                const summary = summariesByTopic.get(node.topic);
                const relationCount = relationsByTopic.get(node.topic)?.length ?? 0;
                const isSelected = node.topic === selected;
                return (
                  <button
                    key={node.topic}
                    type="button"
                    className={`topic-atlas-topic-card${isSelected ? ' selected' : ''}`}
                    onClick={() => setSelected(node.topic)}
                    aria-pressed={isSelected}
                  >
                    <div className="topic-atlas-topic-card-head">
                      <h4>{summary?.label ?? formatTopic(node.topic)}</h4>
                      <span className="topic-atlas-count-pill">{node.count}</span>
                    </div>
                    <p className="muted small">
                      {node.count} lesson{node.count === 1 ? '' : 's'} • {relationCount}{' '}
                      linked topic{relationCount === 1 ? '' : 's'}
                    </p>
                    <p className="topic-atlas-topic-card-preview">
                      {summary?.latestLesson?.title ?? node.lessons[0]?.title ?? 'Queued topic'}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="topic-atlas-visual">
          <aside className="topic-atlas-detail-card" aria-live="polite">
            {activeNode ? (
              <>
                <div className="topic-atlas-detail-head">
                  <div>
                    <p className="topic-atlas-kicker">Selected topic</p>
                    <h3>{formatTopic(activeNode.topic)}</h3>
                  </div>
                  {activeNode.primary && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => navigate(`/lesson/${activeNode.primary?.id}`)}
                    >
                      Open latest lesson
                    </button>
                  )}
                </div>

                <div className="topic-atlas-detail-stats">
                  <span>{activeNode.count} lesson{activeNode.count === 1 ? '' : 's'}</span>
                  <span>{summariesByTopic.get(activeNode.topic)?.totalReadMinutes ?? 0} min total</span>
                  <span>{activeRelations.length} linked topic{activeRelations.length === 1 ? '' : 's'}</span>
                </div>

                {activeRelations.length > 0 && (
                  <div className="topic-atlas-related">
                    <h4>Often linked with</h4>
                    <div className="topic-atlas-pill-row">
                      {activeRelations.slice(0, 6).map((relation) => (
                        <button
                          key={relation.topic}
                          type="button"
                          className="topic-atlas-pill"
                          onClick={() => setSelected(relation.topic)}
                        >
                          {formatTopic(relation.topic)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="topic-atlas-lessons">
                  <h4>Lessons in this topic</h4>
                  <ul>
                    {activeNode.lessons.slice(0, 6).map((lesson) => (
                      <li key={lesson.id}>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => navigate(`/lesson/${lesson.id}`)}
                          disabled={lesson.status === 'queued'}
                        >
                          {lesson.title}
                          {lesson.status === 'queued' && ' (queued)'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <p className="muted">Pick a topic to inspect it.</p>
            )}
          </aside>

          <div className="topic-atlas-canvas-card">
            <div className="topic-atlas-section-head">
              <div>
                <h3>Topic map</h3>
                <p className="muted">
                  The visual map is best for spotting clusters; the list above stays the fastest way
                  to browse on mobile.
                </p>
              </div>
            </div>

            <div className="topic-atlas-canvas">
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label="Topic map"
                preserveAspectRatio="xMidYMid meet"
              >
                <g className="atlas-edges">
                  {graph.edges.map((edge, i) => {
                    const a = nodeByTopic.get(edge.from);
                    const b = nodeByTopic.get(edge.to);
                    if (!a || !b) return null;
                    const active = activeTopic === edge.from || activeTopic === edge.to;
                    const filtered =
                      normalizedQuery.length > 0 &&
                      (!visibleTopicSet.has(edge.from) || !visibleTopicSet.has(edge.to));
                    return (
                      <line
                        key={i}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        className={`atlas-edge${active ? ' active' : ''}${filtered ? ' filtered' : ''}`}
                        strokeWidth={Math.min(3.2, 0.6 + edge.weight * 0.45)}
                      />
                    );
                  })}
                </g>
                <g className="atlas-nodes">
                  {graph.nodes.map((node) => {
                    const isSelected = selected === node.topic;
                    const isRelated = activeTopic != null && (node.topic === activeTopic || activeRelatedTopics.has(node.topic));
                    const dimmed = activeTopic != null && !isRelated;
                    const filtered = normalizedQuery.length > 0 && !visibleTopicSet.has(node.topic);
                    return (
                      <g
                        key={node.topic}
                        className={`atlas-node${dimmed ? ' dimmed' : ''}${filtered ? ' filtered' : ''}${
                          isSelected ? ' selected' : ''
                        }${node.primary ? ' has-primary' : ' atlas-node-queued'}`}
                        transform={`translate(${node.x}, ${node.y})`}
                        onMouseEnter={() => setHovered(node.topic)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={() => setSelected(node.topic)}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelected(node.topic);
                          }
                        }}
                      >
                        <circle r={node.r} />
                        <text y={4} textAnchor="middle" className="atlas-node-count">
                          {node.count}
                        </text>
                        <text
                          y={node.r + 16}
                          textAnchor="middle"
                          className="atlas-node-label"
                        >
                          {formatTopic(node.topic)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
