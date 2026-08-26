import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SHARED_PROMPT = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'prompts',
  'chat_shared_rules.md',
);

// Output-format selection remains in the role-specific presentation hint;
// this resident surface owns only the baseline and the dashboard grammar.
// The margin permits small clarity fixes without restoring the removed full
// dashboard example or a second format-selection decision tree.
const OUTPUT_PRESENTATION_CEILING = 1_900;

function outputPresentationSurface(): string {
  const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
  const start = body.indexOf('## Output formats');
  expect(start, 'shared output-format heading must remain present').toBeGreaterThanOrEqual(0);
  return body.slice(start);
}

describe('shared output-presentation prompt surface', () => {
  it('keeps the resident grammar compact without dropping supported output modes', () => {
    const surface = outputPresentationSurface();
    expect(surface.length).toBeLessThanOrEqual(OUTPUT_PRESENTATION_CEILING);
    expect(surface).toContain('ordinary text/Markdown replies');
    expect(surface).toContain('**`:::dashboard`**');
    expect(surface).toContain('**`create_artifact`**');
    expect(surface).not.toMatch(/use `:::dashboard` for structured data/i);
  });

  it('would reject restoring the duplicate chooser and verbose dashboard example', () => {
    const regrown = `${outputPresentationSurface()}\n${[
      'Choose plain text or Markdown for narrative answers and dashboards for structured data.',
      'Use create_artifact only when the user must interact with the result.',
      '{"type":"Metric","props":{"label":"Hosts","value":"24","tone":"positive"}}',
      '{"type":"Table","props":{"columns":[{"key":"x","label":"X"}],"rows":[{"x":"A"}]}}',
    ].join('\n')}`;
    expect(regrown.length).toBeGreaterThan(OUTPUT_PRESENTATION_CEILING);
  });
});
