import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PromptManager, safeSubstitute, prompts } from '../../../src/main/prompts/loader';

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
    expect(prompts.root).toMatch(/main\/prompts$/);
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

describe('prompts › chat_shared_rules PDF toolchain invariants', () => {
  const load = () => prompts.load('chat_shared_rules', {});

  it('forbids hand-rolling reportlab / wkhtmltopdf / pypdf / pdfkit / LaTeX for PDFs', () => {
    const body = load();
    expect(body).toMatch(/Do not.*reportlab/);
    expect(body).toContain('wkhtmltopdf');
    expect(body).toContain('pypdf');
    // CJK font issue is the concrete reason — lock the justification in.
    expect(body).toMatch(/CJK fonts/i);
  });

  it('forbids silent fallback from the built-in PDF tools to lower-level libs on error', () => {
    const body = load();
    expect(body).toMatch(/do not fall back/i);
  });
});
