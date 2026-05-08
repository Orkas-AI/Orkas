// Pin the set-A vs set-B invariants for the `<agent>` container strippers.
// Without these fixtures, the next "fix one shape, regress another" round
// is invisible to typecheck and reviewer eyeballs — same class of bug has
// already burned us across 34e27fcb / a3110e61 / a follow-up.
//
// Set A — real `<agent>` containers that MUST be stripped (final) /
//         replaced by a single placeholder (streaming):
//   A1. Plain closed container, no special tokens inside.
//   A2. Closed container whose `<workflow>` quotes tool / value names with
//       INLINE BACKTICKS — the shape that broke streaming and forced the
//       most recent rewrite. This is the load-bearing fixture.
//   A3. Closed container whose body has a multi-line FENCED CODE BLOCK
//       inside (e.g., LLM showing an example payload). The container is
//       still atomic at the OUTER level even though its body opens a
//       fence.
//   A4. Unclosed `<agent>` mid-stream — strip / replace from the opener
//       through end-of-buffer.
//   A5. Two closed containers in one buffer — both stripped, prose between
//       them preserved.
//
// Set B — literal `<agent>` mentions that MUST be preserved:
//   B1. Inside a fenced ```xml code block (the original 34e27fcb case).
//   B2. Inside an inline backtick span.
//   B3. Inside an UNCLOSED inline backtick (mid-stream code-explanation).
//
// Mixed: real container + literal mention coexisting in one buffer — only
// the real container goes, the literal mention stays put.
//
// Adding a new guard / branch to any of these strippers? Add a fixture
// for the motivating shape AND keep the existing fixtures green. Don't
// rely on "I checked it manually" — that's the loop these tests exist
// to break.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const strip = require('../../src/renderer/modules/strip-agent.js');
const {
  _splitMarkdownProseCode,
  _findOuterTagRanges,
  _stripOuterTagBlocks,
  _replaceOuterTagBlocks,
  _findOuterAgentRanges,
  _stripSurvivingAgentBlocks,
  _replaceOuterAgentBlocks,
  _stripSurvivingStructuralBlocks,
} = strip as {
  _splitMarkdownProseCode: (text: string) => Array<{ kind: 'prose' | 'code'; text: string }>;
  _findOuterTagRanges: (text: string, tagName: string) => Array<[number, number]>;
  _stripOuterTagBlocks: (text: string, tagName: string) => string;
  _replaceOuterTagBlocks: (buf: string, tagName: string, placeholder: string) => string;
  _findOuterAgentRanges: (text: string) => Array<[number, number]>;
  _stripSurvivingAgentBlocks: (text: string) => string;
  _replaceOuterAgentBlocks: (buf: string, placeholder: string) => string;
  _stripSurvivingStructuralBlocks: (text: string) => string;
};

const PH = '⟨PLACEHOLDER⟩';

// --- Set A: real containers ------------------------------------------------

describe('set A — real <agent> containers must be stripped / replaced', () => {
  it('A1. plain closed container', () => {
    const buf = 'preface\n<agent>\n<name>Foo</name>\n</agent>\ntail';
    expect(_stripSurvivingAgentBlocks(buf)).toBe('preface\n\ntail');
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`preface\n${PH}\ntail`);
  });

  it('A2. container body contains INLINE BACKTICKS (the screenshot bug)', () => {
    const buf = [
      'before',
      '<agent>',
      '<workflow>',
      '1. Read inputs',
      '   - `bash` — read user submission',
      '   - normalize to `agent` / `skill` / `agent_and_skill`',
      '</workflow>',
      '</agent>',
      'after',
    ].join('\n');
    const stripped = _stripSurvivingAgentBlocks(buf);
    expect(stripped).not.toContain('<agent>');
    expect(stripped).not.toContain('</agent>');
    expect(stripped).not.toContain('<workflow>');
    expect(stripped).not.toContain('`bash`');
    expect(stripped).not.toContain('agent_and_skill');
    expect(stripped).toBe('before\n\nafter');

    const replaced = _replaceOuterAgentBlocks(buf, PH);
    expect(replaced).toBe(`before\n${PH}\nafter`);
    // Exactly one placeholder — no leak after it.
    expect(replaced.split(PH).length - 1).toBe(1);
  });

  it('A3. container body contains a fenced code block', () => {
    const buf = [
      'before',
      '<agent>',
      '<description_en>',
      'See example:',
      '```json',
      '{"k": "v"}',
      '```',
      '</description_en>',
      '</agent>',
      'after',
    ].join('\n');
    expect(_stripSurvivingAgentBlocks(buf)).toBe('before\n\nafter');
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`before\n${PH}\nafter`);
  });

  it('A4. unclosed <agent> mid-stream', () => {
    const buf = 'streaming…\n<agent>\n<name>Foo</name>\n<workflow>step `bash` —';
    expect(_stripSurvivingAgentBlocks(buf)).toBe('streaming…');
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`streaming…\n${PH}`);
  });

  it('A5. two closed containers in one buffer', () => {
    const buf = '<agent><name>A</name></agent>\nmid\n<agent><name>B</name></agent>';
    expect(_stripSurvivingAgentBlocks(buf)).toBe('mid');
    const replaced = _replaceOuterAgentBlocks(buf, PH);
    expect(replaced).toBe(`${PH}\nmid\n${PH}`);
    expect(replaced.split(PH).length - 1).toBe(2);
  });
});

// --- Set B: literal mentions must survive ---------------------------------

describe('set B — literal <agent> in code must be preserved', () => {
  it('B1. inside a fenced ```xml block', () => {
    const buf = 'Use this format:\n```xml\n<agent><name>X</name></agent>\n```\nafter';
    expect(_stripSurvivingAgentBlocks(buf)).toBe(buf.trim());
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'Wrap your spec in `<agent>...</agent>` to declare it.';
    expect(_stripSurvivingAgentBlocks(buf)).toBe(buf);
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(buf);
  });

  it('B3. inside an UNCLOSED inline backtick mid-stream', () => {
    const buf = 'You write `<agent>';
    expect(_stripSurvivingAgentBlocks(buf)).toBe(buf);
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(buf);
  });
});

// --- Mixed: container + literal mention coexisting -------------------------

describe('mixed — real container + literal mention in one buffer', () => {
  it('only the real container is replaced; quoted example survives', () => {
    const buf = [
      'Example format:',
      '```xml',
      '<agent><name>Example</name></agent>',
      '```',
      'And here is the actual one:',
      '<agent>',
      '<name>Real</name>',
      '<workflow>step uses `bash`</workflow>',
      '</agent>',
      'done.',
    ].join('\n');
    const stripped = _stripSurvivingAgentBlocks(buf);
    // Quoted example inside ```xml stays.
    expect(stripped).toContain('```xml');
    expect(stripped).toContain('<agent><name>Example</name></agent>');
    // Real one's tags / interior gone.
    expect(stripped).not.toContain('<name>Real</name>');
    expect(stripped).not.toContain('<workflow>');
    expect(stripped).not.toContain('`bash`');

    const replaced = _replaceOuterAgentBlocks(buf, PH);
    expect(replaced).toContain('<agent><name>Example</name></agent>');
    expect(replaced).toContain(PH);
    expect(replaced).not.toContain('<name>Real</name>');
    expect(replaced.split(PH).length - 1).toBe(1);
  });
});

// --- Granularity invariant ------------------------------------------------

describe('granularity invariant — the guard is anchored at the opening tag', () => {
  it('range covers from <agent> opener to </agent> close, atomic across interior backticks', () => {
    const buf = 'x\n<agent>a `b` c</agent>\ny';
    const ranges = _findOuterAgentRanges(buf);
    expect(ranges).toHaveLength(1);
    const [start, end] = ranges[0];
    expect(buf.slice(start, end)).toBe('<agent>a `b` c</agent>');
  });

  it('opener inside fenced code → no range produced', () => {
    const buf = '```\n<agent>x</agent>\n```';
    expect(_findOuterAgentRanges(buf)).toEqual([]);
  });

  it('opener inside inline backticks → no range produced', () => {
    const buf = 'see `<agent>` token';
    expect(_findOuterAgentRanges(buf)).toEqual([]);
  });
});

// --- Empty / no-op inputs --------------------------------------------------

describe('empty / no-op inputs', () => {
  it('returns input unchanged when no <agent> token present', () => {
    expect(_stripSurvivingAgentBlocks('hello world')).toBe('hello world');
    expect(_replaceOuterAgentBlocks('hello world', PH)).toBe('hello world');
    expect(_findOuterAgentRanges('hello world')).toEqual([]);
  });

  it('handles empty / falsy input', () => {
    expect(_stripSurvivingAgentBlocks('')).toBe('');
    expect(_replaceOuterAgentBlocks('', PH)).toBe('');
    expect(_findOuterAgentRanges('')).toEqual([]);
  });
});

// --- Sanity check on the prose/code splitter (used by the rangefinder) ----

// --- Generic tagName parameter: the same matrix must hold for ----------
// `<agent-input-form>` and `<agent-input-submission>`. Both currently lack
// the prose/code guard in their original strippers; these fixtures lock
// down the unified atomic-container behavior.

describe('<agent-input-form> — set A (real form blocks must be replaced)', () => {
  it('A1. plain XML form block, JSON body', () => {
    const buf = 'lead-in\n<agent-input-form>\n[{"name":"topic","type":"text"}]\n</agent-input-form>\ntrail';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH))
      .toBe('lead-in\n' + PH + '\ntrail');
  });

  it('A2. unclosed mid-stream form block', () => {
    const buf = 'streaming…\n<agent-input-form>\n[{"name":"topic"';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH))
      .toBe('streaming…\n' + PH);
  });

  it('A3. body containing inline backticks (label like "Use `bash`")', () => {
    const buf = '<agent-input-form>\n[{"name":"x","label":"Use `bash` here"}]\n</agent-input-form>';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH)).toBe(PH);
  });
});

describe('<agent-input-form> — set B (literal mentions must survive)', () => {
  it('B1. inside a fenced ```xml block (protocol explanation)', () => {
    const buf = 'Format:\n```xml\n<agent-input-form>\n[]\n</agent-input-form>\n```\nend';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH)).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'Wrap fields in `<agent-input-form>` — the agent emits this.';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH)).toBe(buf);
  });

  it('B3. UNCLOSED inline backtick mid-stream (the streaming case)', () => {
    const buf = 'Use `<agent-input-form>';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH)).toBe(buf);
  });
});

describe('<agent-input-submission> — set A (real submission tags stripped)', () => {
  it('A1. submission tag with attributes and JSON body', () => {
    const buf = 'You confirmed:\n<agent-input-submission form_id="abc12345" agent_id="my-agent">\n{"topic":"x"}\n</agent-input-submission>';
    expect(_stripOuterTagBlocks(buf, 'agent-input-submission'))
      .toBe('You confirmed:\n');
  });

  it('A2. body whose JSON value contains backticks', () => {
    const buf = 'You confirmed:\n<agent-input-submission form_id="abc12345" agent_id="my-agent">\n{"q":"run `bash` and `sh`"}\n</agent-input-submission>\nthanks';
    const out = _stripOuterTagBlocks(buf, 'agent-input-submission');
    expect(out).not.toContain('agent-input-submission');
    expect(out).not.toContain('`bash`');
    expect(out).toBe('You confirmed:\n\nthanks');
  });
});

describe('<agent-input-submission> — set B (literal mentions survive)', () => {
  it('B1. inside a fenced ```xml block', () => {
    const buf = 'Reply format:\n```xml\n<agent-input-submission form_id="x" agent_id="y">\n{}\n</agent-input-submission>\n```';
    expect(_stripOuterTagBlocks(buf, 'agent-input-submission')).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'Use `<agent-input-submission ...>` to reply.';
    expect(_stripOuterTagBlocks(buf, 'agent-input-submission')).toBe(buf);
  });

  it('B3. UNCLOSED inline backtick (defense-in-depth, even though the tag normally only appears in user messages and not mid-stream)', () => {
    const buf = 'see `<agent-input-submission';
    expect(_stripOuterTagBlocks(buf, 'agent-input-submission')).toBe(buf);
  });
});

// --- Boundary check: tagName lookup must not bleed across siblings -------

describe('boundary check — `<agent>` lookup must not match `<agent-input-form>`', () => {
  it('a buffer containing only <agent-input-form> has no <agent> ranges', () => {
    const buf = '<agent-input-form>\n[]\n</agent-input-form>';
    expect(_findOuterTagRanges(buf, 'agent')).toEqual([]);
    expect(_findOuterTagRanges(buf, 'agent-input-form')).toHaveLength(1);
  });

  it('a buffer containing only <agent-input-submission ...> has no <agent> ranges', () => {
    const buf = '<agent-input-submission form_id="x" agent_id="y">{}</agent-input-submission>';
    expect(_findOuterTagRanges(buf, 'agent')).toEqual([]);
    expect(_findOuterTagRanges(buf, 'agent-input-submission')).toHaveLength(1);
  });

  it('mixed buffer — each tag matches independently', () => {
    const buf = [
      '<agent><name>A</name></agent>',
      '<agent-input-form>\n[]\n</agent-input-form>',
      '<agent-input-submission form_id="f" agent_id="a">{}</agent-input-submission>',
    ].join('\n');
    expect(_findOuterTagRanges(buf, 'agent')).toHaveLength(1);
    expect(_findOuterTagRanges(buf, 'agent-input-form')).toHaveLength(1);
    expect(_findOuterTagRanges(buf, 'agent-input-submission')).toHaveLength(1);
  });
});

// --- Final-time defense-in-depth strip ----------------------------------
// `_stripSurvivingStructuralBlocks` is the safety net at `_streamingSetFinal`
// + persisted-render time. It must:
//   - strip every real outer container of all three tag families
//   - preserve every literal mention inside fenced code / inline backticks
//   - leave clean prose (no leftover blank-line runs)

describe('_stripSurvivingStructuralBlocks (final-time safety strip)', () => {
  it('strips a real <agent> container', () => {
    const buf = 'lead\n<agent><name>X</name></agent>\ntail';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe('lead\n\ntail');
  });

  it('strips a surviving <agent-input-form> (main extractor missed it)', () => {
    const buf = 'lead\n<agent-input-form>\n[]\n</agent-input-form>\ntail';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe('lead\n\ntail');
  });

  it('strips a hallucinated <agent-input-submission> in assistant text', () => {
    const buf = 'lead\n<agent-input-submission form_id="f" agent_id="a">{}</agent-input-submission>\ntail';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe('lead\n\ntail');
  });

  it('strips all three tags coexisting in one buffer', () => {
    const buf = [
      'before',
      '<agent><name>A</name></agent>',
      'mid1',
      '<agent-input-form>\n[]\n</agent-input-form>',
      'mid2',
      '<agent-input-submission form_id="f" agent_id="a">{}</agent-input-submission>',
      'after',
    ].join('\n');
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).not.toContain('<agent>');
    expect(out).not.toContain('<agent-input-form>');
    expect(out).not.toContain('<agent-input-submission');
    expect(out).toContain('before');
    expect(out).toContain('mid1');
    expect(out).toContain('mid2');
    expect(out).toContain('after');
  });

  it('preserves every literal mention inside fenced code', () => {
    const buf = [
      'Three protocol tags:',
      '```xml',
      '<agent><name>X</name></agent>',
      '<agent-input-form>\n[]\n</agent-input-form>',
      '<agent-input-submission form_id="f" agent_id="a">{}</agent-input-submission>',
      '```',
      'end',
    ].join('\n');
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).toContain('<agent><name>X</name></agent>');
    expect(out).toContain('<agent-input-form>');
    expect(out).toContain('<agent-input-submission');
  });

  it('preserves every literal mention inside inline backticks', () => {
    const buf = 'Use `<agent>`, `<agent-input-form>`, `<agent-input-submission ...>` for the three tags.';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe(buf);
  });

  it('mixed: real <agent> + literal forms in code → only <agent> stripped', () => {
    const buf = [
      'spec:',
      '```xml',
      '<agent-input-form>\n[]\n</agent-input-form>',
      '```',
      '<agent><name>Real</name></agent>',
      'after',
    ].join('\n');
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).toContain('<agent-input-form>');
    expect(out).not.toContain('<name>Real</name>');
    expect(out).toContain('after');
  });

  it('no-op when buffer has none of the three tags', () => {
    const buf = 'plain prose with no structural tags';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe(buf);
  });

  it('handles empty input', () => {
    expect(_stripSurvivingStructuralBlocks('')).toBe('');
  });
});

// --- Custom-fence blocks: `<<<skill-file path=X ... >>>` ----------------
// Different delimiter family from XML tags above (see strip-agent.js
// header). The skill-file block wraps **arbitrary file content** that may
// contain naked `<` / `>` chars (Python, TypeScript, HTML, JSX, configs);
// using XML tags would force the LLM to escape — instead the LLM-side
// prompt (`chat_skill_setup.md`) declares a literal `<<<` / `\n>>>` fence
// pair. The renderer must still apply the same prose/code outer-context
// guard so a literal `<<<skill-file ...>>>` mention inside a fenced code
// block / inline backtick (LLM explaining the protocol to the user)
// survives, while a real block (containing arbitrary file content with
// naked backticks / fences inside) is stripped/replaced atomically.

const skill = require('../../src/renderer/modules/strip-agent.js');
const {
  _findOuterSkillFileRanges,
  _stripOuterSkillFileBlocks,
  _replaceOuterSkillFileBlocks,
  _extractSkillFilePath,
} = skill as {
  _findOuterSkillFileRanges: (text: string) => Array<[number, number]>;
  _stripOuterSkillFileBlocks: (text: string) => string;
  _replaceOuterSkillFileBlocks: (buf: string, makePlaceholder: (path: string) => string) => string;
  _extractSkillFilePath: (blockText: string) => string;
};

const SKILL_PH = (path: string) => `⟨SKILL:${path || '?'}⟩`;

describe('skill-file — set A (real <<<skill-file>>> blocks must be replaced)', () => {
  it('A1. plain closed block, SKILL.md frontmatter body', () => {
    const buf = [
      'wrote it for you.',
      '<<<skill-file path=SKILL.md',
      '---',
      'name: foo',
      'description_zh: 中文',
      'description_en: English',
      '---',
      '',
      '# body',
      '>>>',
      'done.',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('wrote it for you.\n\ndone.');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('wrote it for you.\n⟨SKILL:SKILL.md⟩\ndone.');
  });

  it('A2. block body contains naked `<` `>` (HTML / JSX / generic types) — atomic strip', () => {
    // The whole reason we use a literal fence instead of XML tags: file
    // content routinely has these chars. Strip must not be confused by them.
    const buf = [
      'before',
      '<<<skill-file path=scripts/render.tsx',
      'function Foo(): JSX.Element { return <div>{x < y && y > z}</div>; }',
      'type Bag<T> = Array<T>;',
      '>>>',
      'after',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('before\n\nafter');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('before\n⟨SKILL:scripts/render.tsx⟩\nafter');
  });

  it('A3. block body contains a fenced code block (markdown SKILL.md with ``` examples)', () => {
    const buf = [
      'before',
      '<<<skill-file path=SKILL.md',
      '# Usage',
      '```bash',
      'python3 scripts/run.py "topic"',
      '```',
      '>>>',
      'after',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('before\n\nafter');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('before\n⟨SKILL:SKILL.md⟩\nafter');
  });

  it('A4. unclosed block mid-stream — swallow to EOF', () => {
    const buf = 'streaming…\n<<<skill-file path=SKILL.md\n---\nname: foo\n# partial body still arr';
    expect(_stripOuterSkillFileBlocks(buf)).toBe('streaming…\n');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('streaming…\n⟨SKILL:SKILL.md⟩');
  });

  it('A5. two closed blocks in one buffer (e.g., SKILL.md + scripts/foo.py written same turn)', () => {
    const buf = [
      'wrote two files.',
      '<<<skill-file path=SKILL.md',
      'a',
      '>>>',
      'and',
      '<<<skill-file path=scripts/foo.py',
      'print("hi")',
      '>>>',
      'done.',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('wrote two files.\n\nand\n\ndone.');
    const replaced = _replaceOuterSkillFileBlocks(buf, SKILL_PH);
    expect(replaced).toContain('⟨SKILL:SKILL.md⟩');
    expect(replaced).toContain('⟨SKILL:scripts/foo.py⟩');
    expect(replaced.match(/⟨SKILL:/g)?.length).toBe(2);
  });
});

describe('skill-file — set B (literal <<<skill-file>>> mentions must survive)', () => {
  it('B1. inside a fenced ```text block (LLM showing the protocol to the user)', () => {
    const buf = [
      'Use this format to write a file:',
      '```',
      '<<<skill-file path=SKILL.md',
      'content',
      '>>>',
      '```',
      'after',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe(buf);
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'Wrap content in `<<<skill-file path=X>>>...>>>` to write it.';
    expect(_stripOuterSkillFileBlocks(buf)).toBe(buf);
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe(buf);
  });

  it('B3. inside an UNCLOSED inline backtick (mid-stream code-explanation)', () => {
    const buf = 'You can write `<<<skill-file path=SKILL.md';
    expect(_stripOuterSkillFileBlocks(buf)).toBe(buf);
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe(buf);
  });
});

describe('skill-file — mixed (real block + literal mention coexisting)', () => {
  it('only the real block goes; quoted protocol example stays', () => {
    const buf = [
      'Format reference:',
      '```',
      '<<<skill-file path=PATH',
      'content',
      '>>>',
      '```',
      'And here is the actual write:',
      '<<<skill-file path=SKILL.md',
      'real body',
      '>>>',
      'done.',
    ].join('\n');
    const stripped = _stripOuterSkillFileBlocks(buf);
    expect(stripped).toContain('```');
    expect(stripped).toContain('<<<skill-file path=PATH');  // literal mention preserved
    expect(stripped).not.toContain('real body');
    expect(stripped).toContain('done.');

    const replaced = _replaceOuterSkillFileBlocks(buf, SKILL_PH);
    expect(replaced).toContain('<<<skill-file path=PATH');  // literal mention preserved
    expect(replaced).toContain('⟨SKILL:SKILL.md⟩');
    expect(replaced).not.toContain('real body');
    // Exactly one placeholder (only the real block; the in-fence example doesn't count).
    expect(replaced.match(/⟨SKILL:/g)?.length).toBe(1);
  });
});

describe('skill-file — _extractSkillFilePath', () => {
  it('extracts the path attribute regardless of trailing attrs', () => {
    expect(_extractSkillFilePath('<<<skill-file path=SKILL.md')).toBe('SKILL.md');
    expect(_extractSkillFilePath('<<<skill-file path=scripts/foo.py extra=1')).toBe('scripts/foo.py');
  });

  it('tolerates quoted forms even though the spec says unquoted', () => {
    expect(_extractSkillFilePath('<<<skill-file path="SKILL.md"')).toBe('SKILL.md');
    expect(_extractSkillFilePath("<<<skill-file path='scripts/run.sh'")).toBe('scripts/run.sh');
  });

  it('returns empty string when path attr is missing', () => {
    expect(_extractSkillFilePath('<<<skill-file')).toBe('');
    expect(_extractSkillFilePath('')).toBe('');
  });
});

describe('skill-file — _stripSurvivingStructuralBlocks final-time safety', () => {
  it('strips a surviving <<<skill-file>>> block (backend extractor missed it: stream aborted before \\n>>>)', () => {
    const buf = 'lead\n<<<skill-file path=SKILL.md\n# partial body never closed';
    expect(_stripSurvivingStructuralBlocks(buf)).toBe('lead');
  });

  it('coexists with XML-tag strip: real <agent> + real <<<skill-file>>> + literal mentions', () => {
    const buf = [
      'before',
      '<agent><name>A</name></agent>',
      'mid',
      '<<<skill-file path=SKILL.md',
      'real body',
      '>>>',
      'after',
      '```',
      '<agent><name>QuotedExample</name></agent>',  // literal in code stays
      '<<<skill-file path=Q>>>...>>>',              // inline-ish in code stays
      '```',
      'end',
    ].join('\n');
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).not.toContain('<name>A</name>');
    expect(out).not.toContain('real body');
    expect(out).toContain('<name>QuotedExample</name>');  // protected by ``` fence
    expect(out).toContain('mid');
    expect(out).toContain('after');
    expect(out).toContain('end');
  });
});

describe('_splitMarkdownProseCode sanity', () => {
  it('keeps inline backtick spans as code segments', () => {
    const segs = _splitMarkdownProseCode('a `b` c');
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'code', 'prose']);
    expect(segs[1].text).toBe('`b`');
  });

  it('treats unclosed inline backtick as code through EOF', () => {
    const segs = _splitMarkdownProseCode('a `b');
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'code']);
    expect(segs[1].text).toBe('`b');
  });

  it('treats fenced block as code, including info string line', () => {
    const segs = _splitMarkdownProseCode('intro\n```xml\n<x/>\n```\nend');
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'code', 'prose']);
    expect(segs[1].text).toContain('```xml');
    expect(segs[1].text).toContain('```');
  });
});
