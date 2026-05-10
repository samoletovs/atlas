/**
 * Minimal, dependency-free markdown renderer for atlas lesson bodies.
 *
 * Supports: paragraphs, headings (h2/h3/h4), bold (**), italic (*),
 * bullet lists (- ), ordered lists (1. ), inline code (`), code blocks (```),
 * links [text](url), blockquotes (> text), GitHub-style callouts
 * (> [!KEY], [!TIP], [!WARN], [!REMEMBER]), and internal wiki-links of the
 * form [term](topic:slug-here) resolved via the optional opts.resolveTopicLink.
 *
 * Intentionally NOT a full markdown engine. Lessons follow a tight format.
 */

export type RenderOpts = {
  /**
   * Called for every internal link of the form [label](topic:slug).
   * Should return raw HTML to inline. Default: render as a span with
   * a class so it's at least visible if no resolver is wired up.
   */
  resolveTopicLink?: (slug: string, label: string) => string;
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESCAPES[c]!);
}

const CALLOUT_KINDS: Record<string, string> = {
  KEY: 'key',
  TIP: 'tip',
  WARN: 'warn',
  WARNING: 'warn',
  NOTE: 'tip',
  IMPORTANT: 'key',
  CAUTION: 'warn',
  REMEMBER: 'remember',
};

function defaultResolveTopicLink(slug: string, label: string): string {
  // No resolver provided — render as a non-interactive marker so missing
  // wiring is visible without breaking the page.
  return `<span class="topic-link topic-link-unresolved" data-topic="${escapeHtml(slug)}">${escapeHtml(label)}</span>`;
}

function applyInline(s: string, opts: RenderOpts): string {
  // Escape first
  let out = escapeHtml(s);
  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links: [text](url) — supports http(s), topic:slug, and other URLs.
  // Note: we matched against the *escaped* string above, so square brackets
  // / parens are still literal here.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    if (/^topic:/.test(url)) {
      const slug = url.slice('topic:'.length);
      const resolver = opts.resolveTopicLink ?? defaultResolveTopicLink;
      // text is already HTML-escaped from escapeHtml() above; resolvers
      // must escape any data they themselves inject (slug, attrs).
      return resolver(slug, text);
    }
    // Fallback: render as a regular link without target=_blank.
    return `<a href="${url}">${text}</a>`;
  });
  return out;
}

function renderBlockquote(lines: string[], opts: RenderOpts): string {
  // Detect callout marker on the first line: [!KIND] optional title
  const first = lines[0] ?? '';
  const m = /^\[!([A-Za-z]+)\]\s*(.*)$/.exec(first);
  if (m) {
    const kind = CALLOUT_KINDS[m[1]!.toUpperCase()];
    if (kind) {
      const title = m[2]!.trim();
      const bodyLines = lines.slice(1).filter((l) => l.length > 0);
      const titleHtml = title
        ? `<div class="callout-title">${applyInline(title, opts)}</div>`
        : `<div class="callout-title">${m[1]!.toUpperCase()}</div>`;
      const bodyHtml = bodyLines.length
        ? `<p>${applyInline(bodyLines.join(' '), opts)}</p>`
        : '';
      return `<aside class="callout callout-${kind}">${titleHtml}${bodyHtml}</aside>`;
    }
  }
  // Plain blockquote — collapse blank lines into paragraph breaks.
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      paragraphs.push(`<p>${applyInline(buf.join(' '), opts)}</p>`);
      buf = [];
    }
  };
  for (const l of lines) {
    if (l.trim() === '') flush();
    else buf.push(l);
  }
  flush();
  return `<blockquote>${paragraphs.join('')}</blockquote>`;
}

export function renderMarkdown(md: string, opts: RenderOpts = {}): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length) {
      out.push(`<p>${applyInline(paragraph.join(' '), opts)}</p>`);
      paragraph = [];
    }
  }

  function flushList() {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Code fence
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      i++;
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    // Blockquote / callout — accumulate consecutive `> ...` lines.
    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      const bqLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        bqLines.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      out.push(renderBlockquote(bqLines, opts));
      continue;
    }

    // Headings
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph();
      flushList();
      const level = h[1]!.length;
      out.push(`<h${level}>${applyInline(h[2]!, opts)}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
        out.push('<ul>');
      }
      out.push(`<li>${applyInline(ul[1]!, opts)}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${applyInline(ol[1]!, opts)}</li>`);
      i++;
      continue;
    }

    // Plain paragraph line
    flushList();
    paragraph.push(line);
    i++;
  }

  flushParagraph();
  flushList();
  if (inCodeBlock) {
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }

  return out.join('\n');
}
