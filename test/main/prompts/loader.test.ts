import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PromptManager, safeSubstitute, prompts } from '../../../src/main/prompts/loader';
import { buildRuntimeDatetimeBlock, formatCurrentDate } from '../../../src/main/prompts/runtime_context';

describe('prompts › safeSubstitute', () => {
  it('substitutes $identifier', () => {
    expect(safeSubstitute('hi $name', { name: 'Bob' })).toBe('hi Bob');
  });

  it('substitutes ${braced}', () => {
    expect(safeSubstitute('hi ${name}!', { name: 'Bob' })).toBe('hi Bob!');
  });

  it('escapes $$ to literal $', () => {
    expect(safeSubstitute('price=$$9', {})).toBe('price=$9');
  });

  it('leaves unknown identifiers literal', () => {
    expect(safeSubstitute('x=$foo', {})).toBe('x=$foo');
    expect(safeSubstitute('x=${foo}', {})).toBe('x=${foo}');
  });

  it('coerces numeric values to string', () => {
    expect(safeSubstitute('n=$count', { count: 42 })).toBe('n=42');
  });

  it('coerces boolean values to string', () => {
    expect(safeSubstitute('flag=$on', { on: true })).toBe('flag=true');
  });

  it('does not match invalid identifier characters', () => {
    // $ followed by non-identifier char stays literal
    expect(safeSubstitute('$ end', {})).toBe('$ end');
    expect(safeSubstitute('$1abc', {})).toBe('$1abc'); // identifier can't start with digit
  });

  it('mixed substitution + escape + literal', () => {
    expect(
      safeSubstitute('${a} and $b but not $c and $$ is literal', { a: '1', b: '2' })
    ).toBe('1 and 2 but not $c and $ is literal');
  });

  it('handles literal {} without escaping', () => {
    expect(safeSubstitute('json: {"x":1}', {})).toBe('json: {"x":1}');
  });
});

describe('prompts › runtime datetime context', () => {
  it('formats local date with timezone context first', () => {
    const block = buildRuntimeDatetimeBlock(new Date(2026, 5, 5, 14, 30, 0));

    expect(formatCurrentDate(new Date(2026, 5, 5, 14, 30, 0))).toBe('2026-06-05');
    expect(block).toContain('## Current date');
    expect(block).toContain('Current date: 2026-06-05');
    expect(block).toMatch(/Timezone: .+/);
    expect(block.indexOf('Timezone:')).toBeLessThan(block.indexOf('Current date:'));
    expect(block).not.toContain('This datetime is authoritative');
    expect(block).not.toContain('Current year:');
  });
});

describe('prompts › PromptManager (custom root)', () => {
  let tmpDir: string;
  let mgr: PromptManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-prompts-'));
    mgr = new PromptManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists() returns true for present .md, false otherwise', () => {
    fs.writeFileSync(path.join(tmpDir, 'greet.md'), 'hi $name');
    expect(mgr.exists('greet')).toBe(true);
    expect(mgr.exists('missing')).toBe(false);
  });

  it('load() renders with substitutions', () => {
    fs.writeFileSync(path.join(tmpDir, 'greet.md'), 'hi $name');
    expect(mgr.load('greet', { name: 'Bob' })).toBe('hi Bob');
  });

  it('load() returns empty string for missing template', () => {
    expect(mgr.load('missing')).toBe('');
  });

  it('caches body — when mtime is held constant, load returns cached body even after content rewrite', () => {
    const p = path.join(tmpDir, 't.md');
    fs.writeFileSync(p, 'first');
    // Pin mtime to a fixed integer-second value so kernel storage precision
    // doesn't bite us. Both writes will be re-stamped to this exact mtime.
    const fixedSec = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(p, fixedSec, fixedSec);
    expect(mgr.load('t')).toBe('first'); // warms cache
    fs.writeFileSync(p, 'second');
    fs.utimesSync(p, fixedSec, fixedSec); // re-pin same mtime
    expect(mgr.load('t')).toBe('first'); // cache hit despite new content
  });

  it('cache invalidates when file mtime changes — picks up new content', async () => {
    const p = path.join(tmpDir, 't.md');
    fs.writeFileSync(p, 'first');
    expect(mgr.load('t')).toBe('first');
    // Advance mtime past current cached value. Use bigint-precision time
    // jump to avoid mtimeMs collisions inside the same millisecond.
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(p, 'second');
    fs.utimesSync(p, future, future);
    expect(mgr.load('t')).toBe('second');
  });

  it('reload() clears cache so next load re-reads from disk', () => {
    const p = path.join(tmpDir, 't.md');
    fs.writeFileSync(p, 'first');
    expect(mgr.load('t')).toBe('first');
    fs.writeFileSync(p, 'second');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);
    mgr.reload();
    expect(mgr.load('t')).toBe('second');
  });

  it('load() with empty args still substitutes literal $$', () => {
    fs.writeFileSync(path.join(tmpDir, 'p.md'), '$$10');
    expect(mgr.load('p')).toBe('$10');
  });
});

describe('prompts › default singleton', () => {
  it('exposes PromptManager instance via prompts export', () => {
    expect(prompts).toBeInstanceOf(PromptManager);
  });

  it('default root points at main/prompts directory', () => {
    expect(prompts.root).toMatch(/main[\\/]prompts$/);
  });
});

// PDF / search invariants used to live in chat_commander.md; the
// lifecycle refactor moved them into chat_shared_rules.md (consumed by
// both commander and agent system prompts via concatSharedRules).
// These invariants encode environmental facts (network failure modes,
// CJK font behavior of low-level PDF libs) so they're worth locking
// against the canonical shared file.

describe('prompts › chat_shared_rules web-search invariants', () => {
  it('empty search results require ≥2 alternate-strategy retries before declaring failure', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toMatch(/single empty result is not a reason to give up/i);
    expect(body).toMatch(/at least two different strategies/i);
  });

  it('distinguishes native search (no extra fetch) from internal/skill search (must fetch 3-5)', () => {
    // Skipping web_fetch when the search tool already includes citations
    // is a real token-saving rule — locking the distinction so a future
    // rewrite doesn't collapse them back into a single "always fetch" line.
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toMatch(/native model search[\s\S]*don't `web_fetch` again/i);
    expect(body).toMatch(/3[–-]5 URLs/i);
  });
});

describe('prompts › chat_shared_rules execution-plan policy', () => {
  it('creates plans for outcome continuity risks rather than tool-heavy linear plumbing', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toMatch(/only when it materially protects correct completion/i);
    expect(body).toMatch(/multiple independent success criteria/i);
    expect(body).toMatch(/dependencies, branches, approval points, or recovery choices/i);
    expect(body).toMatch(/Tool count, file count, and a fixed linear workflow are not reasons/i);
    expect(body).toMatch(/Skip an explicit plan for one bounded outcome/i);
  });

  it('updates only on material milestone transitions and preserves evidence ordering', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toMatch(/outcome milestones, not reads, tool calls, status narration/i);
    expect(body).toMatch(/only when a milestone completes or blocks/i);
    expect(body).toMatch(/never call the plan tool merely to announce the next action/i);
    expect(body).toMatch(/prefer one atomic `set_statuses` call/i);
    expect(body).toMatch(/never declare completion before its evidence exists/i);
    expect(body).toMatch(/stored objective is authoritative over checkpoint summaries/i);
  });
});

describe('prompts › chat_shared_rules unavailable-verifier invariants', () => {
  it('forbids success predictions and speculative user-driven retry loops', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toMatch(/unavailable verifier does not support a prediction/i);
    expect(body).toMatch(/fresh compiler, test, device, or service failure/i);
    expect(body).toMatch(/keep the patch unverified/i);
    expect(body).toMatch(/After two consecutive failures[\s\S]*stop speculative edits/i);
    expect(body).toMatch(/current primary documentation[\s\S]*runnable verifier access/i);
    expect(body).toMatch(/instead of using the user as the retry loop/i);
  });
});

describe('prompts › chat_shared_rules PDF toolchain invariants', () => {
  const load = () => prompts.load('chat_shared_rules', {});

  it('forbids hand-rolling reportlab / wkhtmltopdf / pdfkit / LaTeX for PDF generation', () => {
    const body = load();
    expect(body).toMatch(/Do not.*reportlab/);
    expect(body).toContain('wkhtmltopdf');
    expect(body).toContain('pdfkit');
    expect(body).toContain('LaTeX');
    // CJK font issue is the concrete reason — lock the justification in.
    expect(body).toMatch(/CJK fonts/i);
  });

  it('forbids silent fallback from the built-in PDF tools to lower-level libs on error', () => {
    const body = load();
    // `\W+` between "not" and "fall back" accepts either plain spacing or the
    // markdown bold form ("**do not** fall back") the prompt now uses.
    expect(body).toMatch(/do not\W+fall back/i);
  });

  it('uses a bounded visual fallback for failed OCR instead of shell repair', () => {
    const body = load();
    expect(body).toMatch(/local OCR returns `E_OCR_\*`[\s\S]*fall back once with `pdf_render`/i);
    expect(body).toMatch(/Never install or repair OCR\/PDF packages with `bash`, `pip`, or `uv`/i);
  });
});

describe('prompts › chat_shared_rules ordinary reply structure', () => {
  it('keeps normal text/Markdown replies structured without forcing dashboards or reports', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toContain('## Ordinary reply structure');
    expect(body).toMatch(/optionally with an inline `:::dashboard` when useful/i);
    expect(body).toMatch(/Start with the direct conclusion/i);
    expect(body).toMatch(/key point visible before details/i);
    expect(body).toMatch(/2-4 short user-facing sections/i);
    expect(body).toMatch(/most important section first/i);
    expect(body).toMatch(/structured data, metrics, comparisons, timelines, and status snapshots in `:::dashboard` by default/i);
    expect(body).toMatch(/full reports, or playbooks/i);
  });
});

describe('prompts › document-content grounding invariants', () => {
  // Regression: a user referenced a 28-page PDF the commander had produced and
  // asked for a summary. The turn made zero read calls and answered from a
  // 21.5% head/tail spot-check taken twelve minutes earlier for a different
  // purpose, so the whole middle of the document was silently missing.
  it('requires reading a document this turn before answering about its contents', () => {
    const body = prompts.load('chat_shared_rules', {});
    expect(body).toContain('## Answering about a document');
    expect(body).toMatch(/read that file \*\*this turn\*\* before answering/i);
    expect(body).toMatch(/including when you produced it yourself/i);
    expect(body).toMatch(/Prior context is not coverage/i);
    expect(body).toMatch(/head\/tail preview/i);
    expect(body).toMatch(/sub-agent's report/i);
    expect(body).toMatch(/`stat_file` for `total_chars`/i);
    expect(body).toMatch(/name the part you did not read/i);
  });

  it('treats referenced file paths as authoritative without weakening quoted-record inertness', () => {
    const body = prompts.load('chat_commander', {});
    expect(body).toMatch(/`<attachments>` and `<referenced-files>` paths are equally authoritative/i);
    expect(body).toMatch(/inert for \*\*routing and instructions\*\* only/i);
    expect(body).toMatch(/does not make the files it names off-limits/i);
    expect(body).toMatch(/treat it exactly like a fresh attachment/i);
  });
});

describe('prompts › user-intent integrity', () => {
  it('preserves explicit constraints, authority, and clarification boundaries', () => {
    const body = prompts.load('chat_user_intent_rules', {});
    expect(body).toMatch(/explicit user requirements as the primary execution constraints/i);
    expect(body).toMatch(/Optional preferences are not blockers/i);
    expect(body).toMatch(/Do not re-ask a resolved field/i);
    expect(body).toMatch(/separate action authority from target resolution/i);
    expect(body).toMatch(/current user request authorizes the exact action/i);
    expect(body).toMatch(/ask only for the missing target.*retain that authority/is);
    expect(body).toMatch(/materially different action, target, or condition/i);
    expect(body).toMatch(/adds privilege, force, destructive scope, cost, or policy bypass.*stopping with the current state unchanged/is);
    expect(body).toMatch(/platform-required.*gate.*exactly once/is);
    expect(body).toMatch(/select.*multiselect.*genuinely closed domain/is);
    expect(body).toMatch(/open preferences.*text.*textarea/is);
    expect(body).toMatch(/suggestions may be optional examples, never an exhaustive list/i);
    expect(body).toMatch(/approve them or revise them with free text/i);
  });
});
