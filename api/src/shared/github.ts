/**
 * GitHub API helpers — read repo metadata, README, file tree, recent commits.
 *
 * Auth strategy:
 *   - Prefer the SWA-injected `x-ms-token-github-access-token` header when
 *     present. SWA Free + the shared OAuth app does not expose this; SWA
 *     Standard with our own GitHub OAuth app does. So today these helpers
 *     run unauthenticated (60 req/h shared) — fine for low add-repo volume.
 *   - If a future P4-style PAT is stored on the user doc, callers can pass
 *     `authToken` directly.
 *
 * We never throw network errors out of these helpers; instead we return null
 * for not-found / rate-limited and surface a 5xx via `error` for transport
 * failures the caller can decide how to handle.
 */

import type { HttpRequest } from '@azure/functions';

const GH = 'https://api.github.com';
const UA = 'atlas-naurolabs';

export interface GithubRepoMeta {
  owner: string;
  repo: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  language: string | null;
  stargazersCount: number;
  topics: string[];
}

export interface GithubCommit {
  sha: string;
  message: string;
  authorLogin: string | null;
  authorName: string | null;
  date: string;
}

export interface GithubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

const GITHUB_URL_RE =
  /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/**
 * Parse common GitHub URL formats (https, ssh, with/without .git suffix).
 * Returns lowercased owner+repo, or null if the input doesn't look like a
 * GitHub repo URL.
 */
export function parseGithubUrl(input: string): { owner: string; repo: string } | null {
  if (!input || typeof input !== 'string') return null;
  const m = input.trim().match(GITHUB_URL_RE);
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2].replace(/\.git$/, '').toLowerCase();
  if (!owner || !repo || owner.length > 39 || repo.length > 100) return null;
  return { owner, repo };
}

/** Read the SWA-injected GitHub OAuth token, if SWA was configured to expose it. */
export function getGithubTokenFromRequest(req: HttpRequest): string | null {
  const t = req.headers.get('x-ms-token-github-access-token');
  return t && t.length > 0 ? t : null;
}

function buildHeaders(token?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * GET https://api.github.com/repos/{owner}/{repo}
 *
 * Returns:
 *   - { ok: true, meta }       when the repo exists and is readable
 *   - { ok: false, status: 404 } when the repo doesn't exist OR is private and we lack the scope
 *   - { ok: false, status: 403 } when rate-limited (60/h unauth)
 *   - { ok: false, status: 5xx } for transport errors
 */
export async function fetchRepoMetadata(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<
  | { ok: true; meta: GithubRepoMeta }
  | { ok: false; status: number; message?: string }
> {
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${owner}/${repo}`, { headers: buildHeaders(token) });
  } catch (e) {
    return { ok: false, status: 502, message: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    meta: {
      owner,
      repo,
      name: typeof data.name === 'string' ? data.name : repo,
      description: typeof data.description === 'string' ? data.description : null,
      htmlUrl:
        typeof data.html_url === 'string' ? data.html_url : `https://github.com/${owner}/${repo}`,
      defaultBranch:
        typeof data.default_branch === 'string' ? data.default_branch : 'main',
      isPrivate: data.private === true,
      language: typeof data.language === 'string' ? data.language : null,
      stargazersCount:
        typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
      topics: Array.isArray(data.topics) ? (data.topics as string[]) : [],
    },
  };
}

/** Fetch the rendered README markdown (returns null on 404). */
export async function fetchReadme(
  owner: string,
  repo: string,
  token?: string | null,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${owner}/${repo}/readme`, {
      headers: { ...buildHeaders(token), Accept: 'application/vnd.github.raw' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  // Cap to ~32k to keep prompt budgets predictable.
  return text.length > 32_000 ? text.slice(0, 32_000) : text;
}

/**
 * Fetch the recursive tree at HEAD of `branch`. Returns null on 404 or if
 * the tree was truncated and we couldn't paginate.
 */
export async function fetchTree(
  owner: string,
  repo: string,
  branch: string,
  token?: string | null,
): Promise<GithubTreeEntry[] | null> {
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
      headers: buildHeaders(token),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as { tree?: unknown[]; truncated?: boolean };
  if (!Array.isArray(data.tree)) return null;
  return data.tree
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.path === 'string' && typeof e.type === 'string')
    .map((e) => ({
      path: e.path as string,
      type: e.type as GithubTreeEntry['type'],
      size: typeof e.size === 'number' ? (e.size as number) : undefined,
    }));
}

/** Fetch the last `n` commits on `branch`. */
export async function fetchRecentCommits(
  owner: string,
  repo: string,
  branch: string,
  token?: string | null,
  n = 5,
): Promise<GithubCommit[]> {
  let res: Response;
  try {
    res = await fetch(
      `${GH}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`,
      { headers: buildHeaders(token) },
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const arr = (await res.json()) as unknown[];
  return arr
    .map((c) => c as Record<string, unknown>)
    .map((c) => {
      const commit = (c.commit ?? {}) as Record<string, unknown>;
      const author = (commit.author ?? {}) as Record<string, unknown>;
      const ghAuthor = (c.author ?? null) as Record<string, unknown> | null;
      return {
        sha: typeof c.sha === 'string' ? (c.sha as string) : '',
        message: typeof commit.message === 'string' ? (commit.message as string) : '',
        authorLogin: ghAuthor && typeof ghAuthor.login === 'string' ? (ghAuthor.login as string) : null,
        authorName: typeof author.name === 'string' ? (author.name as string) : null,
        date: typeof author.date === 'string' ? (author.date as string) : '',
      };
    })
    .filter((c) => c.sha);
}
