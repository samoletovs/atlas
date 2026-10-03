export interface NextSuggestion {
  title: string;
  topic: string;
  rationale: string;
}

function suggestion(value: unknown): NextSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 200
    || typeof item.topic !== 'string' || !item.topic.trim() || item.topic.trim().length > 200
    || typeof item.rationale !== 'string' || !item.rationale.trim()
  ) return null;
  return { title: item.title.trim(), topic: item.topic.trim(), rationale: item.rationale.trim() };
}

function parseSuggestions(block: string): NextSuggestion[] | null {
  const text = block.trim().replace(/^(?:[-*]|\d+\.)[ \t]+/gm, '').replace(/,\s*$/, '');
  for (const candidate of [text, `[${text}]`, `[${text.replace(/}\s*\n\s*(?=\{)/g, '},\n')}]`]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const items = values.map(suggestion);
      if (items.length && items.every((item): item is NextSuggestion => item !== null)) return items;
    } catch {
      // Ordinary prose and incomplete JSON stay in the body unchanged.
    }
  }
  return null;
}

function isNextHeading(line: string): boolean {
  const text = line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:$/, '').trim();
  return /^(?:what to learn next|suggested next(?: steps| topics)?|next steps|что (?:изучать|изучить|учить) дальше|что дальше изучать|следующие (?:шаги|темы)|что дальше)$/i.test(text);
}

/** Repair legacy/model JSON suggestions before they reach the reader or storage. */
export function recoverLessonSuggestions<T extends { body: string; suggested_next: NextSuggestion[] }>(lesson: T): T {
  if (typeof lesson.body !== 'string') return lesson;
  const suggestions = new Map<string, NextSuggestion>();
  for (const value of Array.isArray(lesson.suggested_next) ? lesson.suggested_next : []) {
    const item = suggestion(value);
    if (item && !suggestions.has(item.topic)) suggestions.set(item.topic, item);
  }
  const output: string[] = [];
  let block: string[] = [];
  let headingIndex: number | null = null;
  let fence: string | null = null;
  let recoverFence = false;
  const flush = () => {
    if (!block.length) return;
    const recovered = parseSuggestions(block.join('\n'));
    if (recovered) {
      for (const item of recovered) {
        if (!suggestions.has(item.topic)) suggestions.set(item.topic, item);
      }
      if (headingIndex !== null && output.slice(headingIndex + 1).every(line => !line.trim())) {
        output[headingIndex] = '';
      }
    } else {
      output.push(...block);
      headingIndex = null;
    }
    block = [];
  };
  for (const line of lesson.body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        if (recoverFence) {
          if (parseSuggestions(block.join('\n'))) flush();
          else {
            output.push(`${fence}json`, ...block, line);
            block = [];
          }
        } else output.push(line);
        fence = null;
      } else if (recoverFence) block.push(line);
      else output.push(line);
      continue;
    }
    if (marker) {
      flush();
      fence = marker[1];
      recoverFence = headingIndex !== null && marker[2].trim().toLowerCase() === 'json';
      if (!recoverFence) {
        output.push(line);
        headingIndex = null;
      }
    } else if (isNextHeading(line)) {
      flush();
      headingIndex = output.length;
      output.push(line);
    } else if (!line.trim() || /^#{1,6}\s/.test(line)) {
      flush();
      output.push(line);
      if (line.trim()) headingIndex = null;
    } else block.push(line);
  }
  if (fence && recoverFence) {
    output.push(`${fence}json`, ...block);
  } else flush();
  return { ...lesson, body: output.join('\n').trim(), suggested_next: [...suggestions.values()] };
}
