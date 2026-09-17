import { test as base, expect, type Page, type Request, type Route } from '@playwright/test';
import type {
  AllowedRepo,
  AskResult,
  AtlasMe,
  AtlasPreferences,
  AtlasRole,
  ClientPrincipal,
  LearningPathLesson,
  Lesson,
  LessonStateAction,
  QueueLessonInput,
} from '../../src/lib/api';

export const LOCAL_BASE_URL = process.env.ATLAS_LOCAL_BASE_URL ?? 'http://127.0.0.1:43127';
const localOrigin = new URL(LOCAL_BASE_URL);
if (
  !['http:', 'https:'].includes(localOrigin.protocol)
  || !['localhost', '127.0.0.1', '[::1]'].includes(localOrigin.hostname)
  || localOrigin.username || localOrigin.password
) {
  throw new Error('ATLAS_LOCAL_BASE_URL must be a credential-free loopback Vite URL.');
}

// Synthetic Example Company data only. The reserved example.com sources are never fetched.
export const REPOS = [
  {
    repoId: 'example-company__learning-lab',
    name: 'learning-lab',
    ownerId: 'example-reader',
    githubUrl: 'https://example.com/example-company/learning-lab',
    visibility: 'private',
    role: 'owner',
  },
  {
    repoId: 'example-company__reliability-lab',
    name: 'reliability-lab',
    ownerId: 'example-reader',
    githubUrl: 'https://example.com/example-company/reliability-lab',
    visibility: 'private',
    role: 'owner',
  },
] satisfies AllowedRepo[];

type Language = Lesson['language'];
type Source = 'recommended' | 'published' | 'queued' | 'read' | 'saved' | 'all';
interface PortalOptions {
  viewerRole: AtlasRole;
  lessonLanguage: Language;
  appearance: NonNullable<AtlasPreferences['theme']>;
}

interface LessonSet {
  recommended: LearningPathLesson;
  companion: Lesson;
  queued: Lesson;
  review: Lesson;
  all: Lesson[];
}

export interface ReviewState {
  step: number;
  dueAt: string;
  updatedAt: string;
}

interface ApiRequest {
  method: string;
  pathname: string;
  repoId: string | null;
  lang: string | null;
  status: string | null;
  body: unknown;
}

interface Hold {
  repoId: string;
  lang: Language;
  entered: Promise<void>;
  notify: () => void;
  waiting: Promise<void>;
  resume: () => void;
  finished: Promise<void>[];
  released: boolean;
}

interface PostHold {
  pathname: string;
  repoId: string;
  claimed: boolean;
  entered: Promise<void>;
  notify: () => void;
  waiting: Promise<void>;
  resume: () => void;
  finished: Promise<void> | null;
}

function makeLessons(repoId: string, language: Language, ownerId: string): LessonSet {
  const prefix = `${repoId}-${language}`;
  const russian = language === 'ru';
  const otherRepo = repoId === REPOS[1].repoId;
  const make = (id: string, override: Partial<Lesson> = {}): Lesson => ({
    id: `${prefix}-${id}`,
    repoId,
    ownerId,
    title: `Example Company lesson ${id}`,
    topic: `example/${id}`,
    depth: 'intro',
    read_minutes: 4,
    body: '## A practical check\n\nUse a health check before moving traffic.',
    citations: ['https://example.com/docs/safe-rollouts'],
    suggested_next: [],
    source_event: {
      type: 'pull_request',
      ref: `https://example.com/engineering/changes/${id}`,
      summary: `Example Company: reviewed ${id}`,
    },
    status: 'published',
    language,
    created_at: '2026-01-09T10:00:00.000Z',
    read_at: null,
    saved: false,
    feedback: null,
    rating: null,
    feedback_comment: null,
    feedback_at: null,
    ...override,
  });

  const companion = make('health-probes', {
    title: russian ? 'Проверки готовности перед переключением трафика' : 'Health probes before moving traffic',
    topic: 'health-probes',
    created_at: '2026-01-10T10:00:00.000Z',
  });
  const queued = make('queued', {
    title: russian ? 'Следующий урок: автоматизация выпуска' : 'Next lesson: release automation',
    topic: 'release-queue',
    status: 'queued',
    body: '',
    citations: [],
    created_at: '2026-01-11T10:00:00.000Z',
  });
  const review = make('review', {
    title: russian ? 'Повторение: безопасные проверки выпуска' : 'Deployment checks worth revisiting',
    topic: 'deployment-basics',
    status: 'read',
    // Not due by the fallback calculation: the review-only test must use the real stored schema.
    read_at: new Date().toISOString(),
  });
  const recommended: LearningPathLesson = {
    ...make('recommended', {
      title: russian
        ? (otherRepo
            ? 'Надёжность второго проекта при переключении трафика'
            : 'Как безопасно переключать трафик между версиями приложения и сохранять понятный план восстановления при неожиданном отказе')
        : (otherRepo ? 'Keep the second project reliable during a rollout' : 'Keep a deployment safe when traffic moves'),
      topic: 'traffic-safety',
      depth: 'intermediate',
      read_minutes: 8,
      created_at: '2026-01-01T10:00:00.000Z',
      source_event: {
        type: 'pull_request',
        ref: 'https://example.com/engineering/changes/42',
        summary: 'Example Company: staged traffic switching review',
      },
      body: russian
        ? '## Практическая проверка\n\nПроверьте [готовность](topic:health-probes) перед переключением. Изучите [автоматический откат](topic:rollback-automation).\n\n```text\nrelease_identifier=example-company-very-long-deployment-identifier-without-spaces-for-a-narrow-phone-screen\n```\n\n### Следующий шаг\n\nСохраните предыдущую версию до завершения проверки.'
        : '## A practical check\n\nCheck [readiness probes](topic:health-probes) before moving traffic. Consider [automated rollback](topic:rollback-automation).\n\n### Next step\n\nKeep the previous version available until the checks pass.',
      suggested_next: [
        { title: companion.title, topic: companion.topic, rationale: 'Check readiness before moving traffic.' },
        { title: 'Rollback automation', topic: 'rollback-automation', rationale: 'Make recovery repeatable.' },
        { title: queued.title, topic: queued.topic, rationale: 'This lesson is already queued.' },
      ],
    }),
    recommendation_reason: 'You finished deployment basics; traffic safety is the next intermediate step.',
    recommendation_score: 98,
  };
  const additional = Array.from({ length: 5 }, (_, index) => make(`published-${index + 1}`, {
    title: russian ? `Практика выпуска: шаг ${index + 1}` : `Release practice: step ${index + 1}`,
  }));
  return { recommended, companion, queued, review, all: [queued, companion, ...additional, review, recommended] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ru';
}

function isDepth(value: unknown): value is Lesson['depth'] {
  return value === 'intro' || value === 'intermediate' || value === 'deep';
}

function isSource(value: string | null): value is Source {
  return value !== null && ['recommended', 'published', 'queued', 'read', 'saved', 'all'].includes(value);
}

export class PortalBackend {
  readonly requests: ApiRequest[] = [];
  readonly unexpectedRequests: string[] = [];
  readonly failures = new Set<Source>();
  readonly answers = [
    'Keep the previous version ready until health checks pass.',
    'Send a small portion of traffic first, then compare the health checks.',
  ];
  readonly me: AtlasMe;
  private readonly data = new Map<string, LessonSet>();
  private readonly holds: Hold[] = [];
  private readonly postHolds: PostHold[] = [];
  private answerIndex = 0;

  constructor(readonly page: Page, readonly options: PortalOptions) {
    this.me = {
      userId: 'example-reader',
      githubLogin: 'example-reader',
      githubId: 123456,
      createdAt: '2026-01-01T00:00:00.000Z',
      allowedRepos: REPOS.map((repo) => ({
        ...repo,
        ownerId: options.viewerRole === 'owner' ? 'example-reader' : 'example-owner',
        role: options.viewerRole,
      })),
      quota: { used: 0, limit: 10, remaining: 10, resetAt: '2099-01-01T00:00:00.000Z' },
      preferences: { lang: options.lessonLanguage, theme: options.appearance },
      githubToken: null,
    };
    for (const repo of this.me.allowedRepos) {
      for (const lang of ['en', 'ru'] as const) {
        this.data.set(`${repo.repoId}:${lang}`, makeLessons(repo.repoId, lang, repo.ownerId));
      }
    }
  }

  lessons(repoId: string = REPOS[0].repoId, lang: Language = this.options.lessonLanguage): LessonSet {
    const data = this.data.get(`${repoId}:${lang}`);
    if (!data) throw new Error(`No fixture lessons for repo=${repoId}, lang=${lang}`);
    return data;
  }

  async install(): Promise<void> {
    await this.seedStorage({
      'atlas-repo': REPOS[0].repoId,
      'atlas-lang': this.options.lessonLanguage,
      'atlas-theme': this.options.appearance,
    });
    // Context routing remains active while pages close and pending effects settle.
    await this.page.context().route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== localOrigin.origin) {
        this.unexpectedRequests.push(`External request blocked: ${url.href}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (url.pathname === '/.auth/me' && route.request().method() === 'GET') {
        const principal: ClientPrincipal = {
          userId: this.me.userId,
          userDetails: this.me.githubLogin,
          identityProvider: 'github',
          userRoles: ['anonymous', 'authenticated'],
        };
        await route.fulfill({ json: { clientPrincipal: principal } });
      } else if (url.pathname.startsWith('/.auth/')) {
        await this.unexpected(route, 'Unexpected authentication navigation');
      } else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const hold = this.postHolds.find(candidate => !candidate.claimed
          && route.request().method() === 'POST' && candidate.pathname === url.pathname
          && candidate.repoId === url.searchParams.get('repoId'));
        if (hold) {
          hold.claimed = true;
          hold.finished = this.requestFinished(route.request());
          hold.notify();
          await hold.waiting;
          if (route.request().failure()) return;
        }
        await this.handleApi(route, url);
      } else {
        await route.continue();
      }
    });
  }

  async seedStorage(values: Record<string, string>): Promise<void> {
    await this.page.addInitScript((entries) => {
      for (const [key, value] of Object.entries(entries)) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
    }, values);
  }

  async reviewOnly(): Promise<void> {
    const data = this.lessons();
    data.all = [data.review];
    // Matches src/lib/spacedReview.ts: repo-scoped map, not a list or a per-user key.
    const state: Record<string, ReviewState> = {
      [data.review.id]: { step: 0, dueAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' },
    };
    await this.seedStorage({ [`atlas-spaced-review:${REPOS[0].repoId}`]: JSON.stringify(state) });
  }

  async goto(path = '/'): Promise<void> {
    const url = new URL(path, LOCAL_BASE_URL);
    if (url.origin !== localOrigin.origin) throw new Error('Fixture navigation must stay on local Vite.');
    await this.page.goto(url.href);
  }

  holdRecommendations(repoId: string, lang: Language) {
    let notify!: () => void;
    let resume!: () => void;
    const hold: Hold = {
      repoId, lang,
      entered: new Promise<void>((resolve) => { notify = resolve; }),
      waiting: new Promise<void>((resolve) => { resume = resolve; }),
      notify: () => notify(),
      resume: () => resume(),
      finished: [],
      released: false,
    };
    this.holds.push(hold);
    return {
      entered: hold.entered,
      release: async () => {
        await this.releaseHold(hold);
        // Wait for the old response to finish and React to paint, not an arbitrary sleep.
        await this.page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
      },
    };
  }

  holdNextPost(pathname: string, repoId: string = REPOS[0].repoId) {
    let notify!: () => void;
    let resume!: () => void;
    const hold: PostHold = {
      pathname, repoId, claimed: false, finished: null,
      entered: new Promise<void>(resolve => { notify = resolve; }),
      notify: () => notify(),
      waiting: new Promise<void>(resolve => { resume = resolve; }),
      resume: () => resume(),
    };
    this.postHolds.push(hold);
    return {
      entered: hold.entered,
      release: async () => {
        hold.resume();
        if (hold.finished) await hold.finished;
        await this.page.evaluate(() => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
      },
    };
  }

  private async releaseHold(hold: Hold): Promise<void> {
    hold.released = true;
    hold.resume();
    await Promise.all(hold.finished);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.holds.map((hold) => this.releaseHold(hold)));
    for (const hold of this.postHolds) hold.resume();
    await Promise.all(this.postHolds.flatMap(hold => hold.finished ? [hold.finished] : []));
    // Keep the network guard in place until the document can no longer issue requests.
    await this.page.close();
  }

  private requestFinished(request: Request): Promise<void> {
    return new Promise((resolve) => {
      const done = (candidate: Request) => {
        if (candidate !== request) return;
        this.page.off('requestfinished', done);
        this.page.off('requestfailed', done);
        resolve();
      };
      this.page.on('requestfinished', done);
      this.page.on('requestfailed', done);
    });
  }

  private async unexpected(route: Route, reason: string): Promise<void> {
    const message = `${reason}: ${route.request().method()} ${route.request().url()}`;
    this.unexpectedRequests.push(message);
    await route.fulfill({ status: 501, json: { error: message } });
  }

  private async handleApi(route: Route, url: URL): Promise<void> {
    const method = route.request().method();
    const body: unknown = route.request().postData() ? route.request().postDataJSON() : null;
    const repoId = url.searchParams.get('repoId');
    const lang = url.searchParams.get('lang');
    this.requests.push({ method, pathname: url.pathname, repoId, lang, status: url.searchParams.get('status'), body });

    if (url.pathname === '/api/me' && method === 'GET') {
      await route.fulfill({ json: this.me });
      return;
    }
    if (url.pathname === '/api/me/preferences' && method === 'PATCH') {
      if (!isRecord(body)
        || Object.keys(body).some((key) => key !== 'lang' && key !== 'theme')
        || (body.lang !== undefined && !isLanguage(body.lang))
        || (body.theme !== undefined && body.theme !== 'light' && body.theme !== 'dark')) {
        await this.unexpected(route, 'Invalid preferences payload');
        return;
      }
      if (isLanguage(body.lang)) this.me.preferences.lang = body.lang;
      if (body.theme === 'light' || body.theme === 'dark') this.me.preferences.theme = body.theme;
      this.me.preferences.updatedAt = new Date().toISOString();
      await route.fulfill({ json: { preferences: this.me.preferences } });
      return;
    }

    const repo = this.me.allowedRepos.find((candidate) => candidate.repoId === repoId);
    if (!repo) {
      await this.unexpected(route, 'Missing or unknown repoId');
      return;
    }
    if (method === 'GET' && (url.pathname === '/api/lessons' || url.pathname === '/api/lessons/recommended')) {
      const source = url.pathname.endsWith('/recommended') ? 'recommended' : url.searchParams.get('status');
      if (!isLanguage(lang) || !isSource(source)
        || (url.pathname === '/api/lessons' && source === 'recommended')) {
        await this.unexpected(route, 'Missing or invalid lang/status');
        return;
      }
      const data = this.lessons(repo.repoId, lang);
      let lessons: Lesson[] = data.all.filter((lesson) => lesson.status !== 'archived');
      if (source === 'recommended') {
        lessons = [data.recommended, ...data.all.filter((lesson) => lesson.id !== data.recommended.id)]
          .filter((lesson) => data.all.includes(lesson) && lesson.status === 'published')
          .map((lesson, index): LearningPathLesson => ({
            ...lesson,
            recommendation_reason: lesson.id === data.recommended.id
              ? data.recommended.recommendation_reason : 'More learning from your Example Company project.',
            recommendation_score: 98 - index * 5,
          }));
      } else {
        lessons = lessons
          .filter((lesson) => source === 'all' || (source === 'saved' ? lesson.saved : lesson.status === source))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
      }
      const response = this.failures.has(source)
        ? { status: 503, json: { error: `Fixture ${source} source unavailable` } }
        : { status: 200, json: { lessons: structuredClone(lessons) } };
      const hold = source === 'recommended'
        ? this.holds.find((candidate) => !candidate.released && candidate.repoId === repo.repoId && candidate.lang === lang)
        : undefined;
      if (hold) {
        hold.finished.push(this.requestFinished(route.request()));
        hold.notify();
        await hold.waiting;
      }
      if (!route.request().failure()) await route.fulfill(response);
      return;
    }

    if (method === 'POST' && ['/api/lessons/generate', '/api/lessons/queue'].includes(url.pathname)) {
      if (repo.role !== 'owner') {
        await this.unexpected(route, 'A member attempted owner-only generation');
        return;
      }
      if (!isRecord(body) || typeof body.title !== 'string' || typeof body.topic !== 'string'
        || !isLanguage(body.language) || (body.depth !== undefined && !isDepth(body.depth))
        || (body.rationale !== undefined && typeof body.rationale !== 'string')
        || (body.source_lesson_id !== undefined && typeof body.source_lesson_id !== 'string')) {
        await this.unexpected(route, 'Invalid generation payload');
        return;
      }
      const input: QueueLessonInput = {
        title: body.title, topic: body.topic, language: body.language,
        ...(isDepth(body.depth) ? { depth: body.depth } : {}),
        ...(typeof body.rationale === 'string' ? { rationale: body.rationale } : {}),
        ...(typeof body.source_lesson_id === 'string' ? { source_lesson_id: body.source_lesson_id } : {}),
      };
      const data = this.lessons(repo.repoId, input.language);
      const queued = data.all.find((lesson) => lesson.topic === input.topic && lesson.status === 'queued');
      const generated: Lesson = {
        ...data.recommended,
        id: `${repo.repoId}-${input.language}-generated-${data.all.length}`,
        title: input.title, topic: input.topic, language: input.language, depth: input.depth ?? 'intro',
        status: url.pathname.endsWith('/queue') ? 'queued' : 'published',
        read_at: null, saved: false, feedback: null, rating: null, feedback_comment: null, feedback_at: null,
        body: url.pathname.endsWith('/queue') ? '' : '## Generated fixture lesson\n\nA deterministic Example Company example.',
        suggested_next: [],
        created_at: new Date().toISOString(),
        source_event: { type: 'suggestion', ref: input.source_lesson_id ?? '', summary: input.rationale ?? 'Example Company learning request' },
      };
      if (queued) queued.status = 'archived';
      data.all.unshift(generated);
      this.me.quota.used += 1;
      this.me.quota.remaining = Math.max(0, (this.me.quota.limit ?? 10) - this.me.quota.used);
      await route.fulfill({ json: generated });
      return;
    }

    const match = /^\/api\/lessons\/([^/]+)(?:\/(state|ask))?$/.exec(url.pathname);
    if (!match) {
      await this.unexpected(route, 'Unknown API route');
      return;
    }
    const lesson = (['en', 'ru'] as const)
      .flatMap((language) => this.lessons(repo.repoId, language).all)
      .find((candidate) => candidate.id === decodeURIComponent(match[1]));
    if (!lesson) {
      await this.unexpected(route, 'Unknown lesson or wrong repo');
      return;
    }
    if (!match[2] && method === 'GET') {
      await route.fulfill({ json: lesson });
    } else if (match[2] === 'state' && method === 'POST' && isRecord(body)) {
      await this.updateState(route, lesson, body);
    } else if (match[2] === 'ask' && method === 'POST' && isRecord(body)) {
      if (typeof body.question !== 'string' || !body.question.trim() || !Array.isArray(body.history)) {
        await this.unexpected(route, 'Invalid Ask payload');
        return;
      }
      for (const turn of body.history) {
        if (!isRecord(turn) || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') {
          await this.unexpected(route, 'Invalid Ask history');
          return;
        }
      }
      const answer = this.answers[this.answerIndex++];
      if (!answer) {
        await this.unexpected(route, 'No fixture answer for this turn');
        return;
      }
      const result: AskResult = { answer, lessonId: lesson.id };
      await route.fulfill({ json: result });
    } else {
      await this.unexpected(route, 'Unknown API method or invalid payload');
    }
  }

  private async updateState(route: Route, lesson: Lesson, body: Record<string, unknown>): Promise<void> {
    const action = body.action;
    const actions: readonly LessonStateAction[] = [
      'mark_read', 'save', 'unsave', 'feedback_up', 'feedback_down', 'feedback_clear', 'set_rating', 'set_comment',
    ];
    if (!actions.some((allowed) => allowed === action)) {
      await this.unexpected(route, 'Unknown lesson state action');
      return;
    }
    switch (action) {
      case 'mark_read':
        lesson.status = 'read';
        lesson.read_at = new Date().toISOString();
        break;
      case 'save': lesson.saved = true; break;
      case 'unsave': lesson.saved = false; break;
      case 'feedback_up': lesson.feedback = 'up'; break;
      case 'feedback_down': lesson.feedback = 'down'; break;
      case 'feedback_clear': lesson.feedback = null; break;
      case 'set_rating':
        if (body.rating !== null && (typeof body.rating !== 'number'
          || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)) {
          await this.unexpected(route, 'Invalid rating');
          return;
        }
        lesson.rating = body.rating;
        lesson.feedback_at = new Date().toISOString();
        break;
      case 'set_comment':
        if (body.comment !== null && typeof body.comment !== 'string') {
          await this.unexpected(route, 'Invalid feedback comment');
          return;
        }
        if (typeof body.comment === 'string' && body.comment.trim().length > 1000) {
          await this.unexpected(route, 'Feedback comment exceeds the API limit');
          return;
        }
        lesson.feedback_comment = body.comment?.trim() || null;
        lesson.feedback_at = new Date().toISOString();
        break;
    }
    await route.fulfill({ json: lesson });
  }
}

export const test = base.extend<PortalOptions & { portal: PortalBackend }>({
  viewerRole: ['owner', { option: true }],
  lessonLanguage: ['en', { option: true }],
  appearance: ['light', { option: true }],
  portal: async ({ page, viewerRole, lessonLanguage, appearance }, use) => {
    const portal = new PortalBackend(page, { viewerRole, lessonLanguage, appearance });
    await portal.install();
    try {
      await use(portal);
    } finally {
      await portal.dispose();
      expect(portal.unexpectedRequests, 'No fixture request may reach a real API or an unhandled endpoint').toEqual([]);
    }
  },
});

export { expect };
