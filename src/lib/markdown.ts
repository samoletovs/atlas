/**
 * Minimal, dependency-free markdown renderer for atlas lesson bodies.
 *
 * Supports: paragraphs, headings (h2/h3/h4), bold (**), italic (*),
 * bullet lists (- ), ordered lists (1. ), inline code (`), code blocks (```),
 * links [text](url), and explicit line breaks.
 *
 * Intentionally NOT a full markdown engine. Lessons follow a tight format.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESCAPES[c]!);
}

function applyInline(s: string): string {
  // Escape first
  let out = escapeHtml(s);
  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return out;
}

export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length) {
      out.push(`<p>${applyInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  }

  function flushList() {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  }

  for (const raw of lines) {
    const line = raw;

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
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    // Headings
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph();
      flushList();
      const level = h[1]!.length;
      out.push(`<h${level}>${applyInline(h[2]!)}</h${level}>`);
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
      out.push(`<li>${applyInline(ul[1]!)}</li>`);
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
      out.push(`<li>${applyInline(ol[1]!)}</li>`);
      continue;
    }

    // Plain paragraph line
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  if (inCodeBlock) {
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }

  return out.join('\n');
}
