import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INLINE_RESULT_TOKENS,
  estimateToolResultTokens,
} from '../../../src/main/util/tool-result-cap';

/**
 * A skill body the model cannot read in one tool result is not a skill.
 *
 * 2026-08-07, watching a live COMPOSE run: the model read `stage-compose`
 * (62,685 chars = 16,226 estimated tokens against a 12,500-token inline cap),
 * got a `<persisted-output>` stub back, and then keyword-searched its own
 * skill looking for the manifest schema. Any rule whose wording did not match
 * whatever it happened to search for was, in practice, invisible — and the
 * skill had been over the cap since the day it was written. Nothing failed.
 * The same thing had happened before to `skill-creator` and `agent-creator`,
 * and was fixed then by raising the cap rather than by noticing at authoring
 * time.
 *
 * Silent degradation is the whole problem: a spilled skill still "works",
 * just worse, in a way no test and no log line reports. This test converts it
 * into a build failure. Conditional depth belongs in `references/`, which is
 * read only when it applies.
 */

const BUILTIN_ROOT = path.join(__dirname, '..', '..', '..', 'resources', 'builtin');

/** What `read_file` actually hands the model: numbered lines inside a `<file>`
 *  envelope. Measuring the raw body would under-count by ~3% and let a skill
 *  sit just under the line while the real result is over it. */
function asReadFileResult(body: string, label: string): string {
  const lines = body.split('\n');
  return `<file path="${label}" kind="text" total_chars="${body.length}" `
    + `covered="0-${body.length}" lines="1-${lines.length}" `
    + `file_hash="sha256:${'0'.repeat(64)}">\n`
    + lines.map((line, index) => `${index + 1}\t${line}`).join('\n')
    + '\n</file>';
}

function collectSkillDocs(): Array<{ label: string; body: string }> {
  const docs: Array<{ label: string; body: string }> = [];
  const walk = (dir: string, insideSkillReferences = false): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A references/ tree belongs to a skill only when its parent owns a
        // SKILL.md. Carry the state recursively so nested reference documents
        // cannot silently escape this corpus scan.
        const entersSkillReferences = insideSkillReferences
          || (entry.name === 'references' && fs.existsSync(path.join(dir, 'SKILL.md')));
        walk(abs, entersSkillReferences);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      // SKILL.md is read on every use; a `references/` file is read only when
      // its condition applies, but it is still one read_file result and still
      // spills the same way, so both are held to the budget.
      const isSkillBody = entry.name === 'SKILL.md';
      const isReference = insideSkillReferences;
      if (!isSkillBody && !isReference) continue;
      docs.push({
        label: path.relative(BUILTIN_ROOT, abs),
        body: fs.readFileSync(abs, 'utf8'),
      });
    }
  };
  walk(BUILTIN_ROOT);
  return docs;
}

describe('builtin skill inline budget', () => {
  const docs = collectSkillDocs();

  it('finds the builtin skill corpus', () => {
    // A silent zero here would make every assertion below vacuously true.
    expect(docs.length).toBeGreaterThan(40);
    expect(docs.some((doc) => doc.label.endsWith('SKILL.md'))).toBe(true);
    expect(docs.some((doc) => /[\\/]references[\\/].+[\\/].+\.md$/.test(doc.label))).toBe(true);
  });

  it('keeps every skill body readable in a single tool result', () => {
    const oversized = docs
      .map((doc) => ({
        label: doc.label,
        tokens: estimateToolResultTokens(asReadFileResult(doc.body, doc.label)),
      }))
      .filter((doc) => doc.tokens > DEFAULT_INLINE_RESULT_TOKENS)
      .map((doc) => `${doc.label}: ~${doc.tokens} tokens (budget ${DEFAULT_INLINE_RESULT_TOKENS})`);

    expect(
      oversized,
      'these skills spill to disk instead of being read; move conditional depth into references/',
    ).toEqual([]);
  });

  it('reports how close the largest skills sit to the budget', () => {
    // Not a failure condition — a visible ranking so the next person adding a
    // paragraph knows which files have no room left. The three names below
    // were all within ~500 tokens of the cap when this was written.
    const ranked = docs
      .map((doc) => ({
        label: doc.label,
        tokens: estimateToolResultTokens(asReadFileResult(doc.body, doc.label)),
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);

    expect(ranked[0].tokens).toBeGreaterThan(0);
    for (const doc of ranked) {
      expect(doc.tokens, `${doc.label} is over budget`).toBeLessThanOrEqual(DEFAULT_INLINE_RESULT_TOKENS);
    }
  });
});
