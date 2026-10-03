import { test, expect } from '@playwright/test';
import { recoverLessonSuggestions } from '../api/src/shared/lessonSuggestions';

const next = [
  { title: 'Основы Azure Functions', topic: 'agent-platforms/azure-functions', rationale: 'Понимание серверлесс-вычислений поможет в разработке кастомных решений.' },
  { title: 'Интеграция с Azure Logic Apps', topic: 'agent-platforms/logic-apps', rationale: 'Автоматизация процессов может улучшить эффективность вашего решения.' },
];

for (const [name, body] of [
  ['bare objects', next.map(item => JSON.stringify(item)).join(',\n')],
  ['bullets', next.map(item => `- ${JSON.stringify(item)}`).join('\n')],
  ['array', JSON.stringify(next, null, 2)],
  ['Russian section', `## Что изучать дальше\n${JSON.stringify(next)}`],
  ['bold heading', `**Следующие темы:**\n${JSON.stringify(next)}`],
  ['JSON section', `## What to learn next\n\`\`\`json\n${JSON.stringify(next, null, 2)}\n\`\`\``],
  ['adjacent prose', `Начало объяснения.\n${JSON.stringify(next)}\nПродолжение урока.`],
  ['section with adjacent prose', `## Что изучать дальше\n${JSON.stringify(next)}\nПродолжение урока.`],
]) {
  test(`recovers ${name} without changing hierarchical topics or later prose`, () => {
    const result = recoverLessonSuggestions({
      body: `Объяснение.\n\n${body}\n\n## Итог\nПолезный вывод.`,
      suggested_next: [],
    });
    expect(result.suggested_next).toEqual(next);
    expect(result.body).toContain('Объяснение.');
    expect(result.body).toContain('## Итог\nПолезный вывод.');
    expect(result.body).not.toContain('"topic"');
    expect(result.body).not.toContain('Что изучать дальше');
    if (name.includes('adjacent prose')) expect(result.body).toContain('Продолжение урока.');
    expect(recoverLessonSuggestions(result)).toEqual(result);
  });
}

test('merges missing suggestions while preferring existing metadata', () => {
  const existing = { ...next[0], title: 'Existing title' };
  const input = { body: JSON.stringify(next), suggested_next: [existing] };
  expect(recoverLessonSuggestions(input).suggested_next).toEqual([existing, next[1]]);
  expect(input.body).toBe(JSON.stringify(next));
});

for (const body of [
  'A normal paragraph about the next steps.',
  '{"title": "Example", "topic": "example"}',
  JSON.stringify([{ ...next[0], topic: '' }]),
  JSON.stringify([{ ...next[0], title: 'x'.repeat(201) }]),
  '## Что изучать дальше\nЗдесь есть полезное объяснение.',
  `\`\`\`json\n${JSON.stringify(next)}\n\`\`\``,
  `~~~typescript\n${JSON.stringify(next)}\n~~~`,
  `## What to learn next\n\`\`\`json\n${JSON.stringify(next)}`,
  `## What to learn next\n  \`\`\`JSON\n{broken}\n  \`\`\``,
  `    ${JSON.stringify(next[0])}`,
  `\t${JSON.stringify(next[0])}`,
  JSON.stringify(next, null, 2).split('\n').map(line => `    ${line}`).join('\n'),
]) {
  test(`preserves prose, malformed data or code: ${body.slice(0, 50)}`, () => {
    const result = recoverLessonSuggestions({ body, suggested_next: [] });
    expect(result).toEqual({ body, suggested_next: [] });
  });
}
