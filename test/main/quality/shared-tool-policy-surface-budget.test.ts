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

const TOOL_RELATED_SECTIONS = [
  'Web search rules',
  'Answering about a document',
  'File output + chat-media usage',
] as const;

// The three global decision sections measure about 3.4K characters after PDF
// failure handling moved to create_pdf. This margin rejects tool-local manuals
// drifting back into the resident prompt.
const RESIDENT_SURFACE_CEILING = 3_500;

function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  expect(start, `${heading} must remain in the shared prompt`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf('\n## ', start + 3);
  return body.slice(start, end < 0 ? body.length : end);
}

function toolRelatedSurface(body: string): string {
  return TOOL_RELATED_SECTIONS.map((heading) => section(body, heading)).join('\n');
}

describe('shared prompt tool-policy surface', () => {
  it('keeps global decisions resident without regrowing tool-local call procedures', () => {
    const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
    expect(toolRelatedSurface(body).length).toBeLessThanOrEqual(RESIDENT_SURFACE_CEILING);
  });

  it('rejects re-adding the compacted file, PDF, and output procedures', () => {
    const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
    expect(body).not.toContain('## PDF rules');
    expect(body).not.toContain('## Skill external dependencies');
    const regrown = `${toolRelatedSurface(body)}\n${[
      'Built-in web_search gives summaries only: pick official sources and call web_fetch before conclusions.',
      'Call read_files with metadata_only for total_chars, then use paths ranges until the whole span is covered.',
      'For scanned PDFs call ocr_file; on E_OCR errors call pdf_render one page at a time, otherwise require a vision model, and never install OCR packages.',
      'Use source_type markdown for prose and html for tables and styles; do not switch PDF libraries after failure.',
      'Every write tool uses working_dir; bash exposes ORKAS_OUTPUT_DIR for final Office files while scratch and cache files go elsewhere.',
    ].join('\n')}`;
    expect(regrown.length).toBeGreaterThan(RESIDENT_SURFACE_CEILING);
  });
});
