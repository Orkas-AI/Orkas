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
//   B1. Inside a non-XML fenced code block.
//   B2. Inside an inline backtick span.
//   B3. Inside an UNCLOSED inline backtick (mid-stream code-explanation).
//
// Mixed: real container + literal mention coexisting in one buffer — only
// the real container goes, the literal mention stays put.
//
// Note on ```xml fences: starting `bc6e0156`, ```xml is treated as a
// **structural** fence (its body IS the LLM's actual tag emission), not as
// a preservation marker. The earlier set B1 wording "inside a ```xml block
// must be preserved" is intentionally retired — the positive coverage for
// the new semantic lives in the "explicit XML fences are treated as
// structural blocks" describe blocks further down. ```xml as an example
// container preservation marker is not coming back; LLM teaching surfaces
// should use plain ``` for examples.
//
// Adding a new guard / branch to any of these strippers? Add a fixture
// for the motivating shape AND keep the existing fixtures green. Don't
// rely on "I checked it manually" — that's the loop these tests exist
// to break.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const strip = require('../../src/renderer/modules/strip-structural-blocks.js');
const {
  _splitMarkdownProseCode,
  _findOuterTagRanges,
  _stripOuterTagBlocks,
  _replaceOuterTagBlocks,
  _findOuterAgentRanges,
  _stripSurvivingAgentBlocks,
  _replaceOuterAgentBlocks,
  _stripSkillCreateContainer,
  _stripSurvivingStructuralBlocks,
  _stripUserStructuralBlocksForDisplay,
  _replaceKnownSkillIdsForDisplay,
  _simplifyKnownSkillFollowPhrasesForDisplay,
  _normalizeKnownSkillRefsForDisplay,
  _collapseRepeatedStructuralPlaceholders,
} = strip as {
  _splitMarkdownProseCode: (text: string) => Array<{ kind: 'prose' | 'code'; text: string; xmlFence?: boolean }>;
  _findOuterTagRanges: (text: string, tagName: string) => Array<[number, number]>;
  _stripOuterTagBlocks: (text: string, tagName: string) => string;
  _replaceOuterTagBlocks: (buf: string, tagName: string, placeholder: string) => string;
  _findOuterAgentRanges: (text: string) => Array<[number, number]>;
  _stripSurvivingAgentBlocks: (text: string) => string;
  _replaceOuterAgentBlocks: (buf: string, placeholder: string) => string;
  _stripSkillCreateContainer: (buf: string, fallbackPlaceholder: string) => string;
  _stripSurvivingStructuralBlocks: (text: string) => string;
  _stripUserStructuralBlocksForDisplay: (text: string) => string;
  _replaceKnownSkillIdsForDisplay: (text: string, skills: Array<{ id: string; name?: string }>) => string;
  _simplifyKnownSkillFollowPhrasesForDisplay: (text: string, skills: Array<{ id: string; name?: string }>) => string;
  _normalizeKnownSkillRefsForDisplay: (text: string, skills: Array<{ id: string; name?: string }>) => string;
  _collapseRepeatedStructuralPlaceholders: (buf: string, placeholder: string) => string;
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

  // A6 pins the actual commander edit-marketplace-agent shape we shipped
  // 2026-05-21: dispatch landed through updateAgentSpec for the first time
  // (commit dc60c86d), and the renderer surfaced the container's inner
  // agent_id + bilingual descriptions as a stray bubble next to the real
  // reply because some render path skipped strip and let markdown's HTML
  // pass-through swallow only the tags. Container shape matches what
  // `extractAgentFieldBlocks` accepts: `<agent>` with `<agent_id>` /
  // `<description_zh>` / `<description_en>` / `<workflow>` sub-tags, multi-
  // line description bodies, mixed zh+en, fence-free.
  it('A6. commander edit container with agent_id + bilingual descriptions + workflow', () => {
    const buf = [
      'preface',
      '',
      '<agent>',
      '<agent_id>bc7ac250df71</agent_id>',
      '<description_zh>按来源边界整理 Agent / Skill 候选，核对原始材料并保持来源保真；触发词：整合、交接包</description_zh>',
      '<description_en>Organize Agent / Skill candidates by source boundary, verify original source material; Triggers: consolidate, handoff package</description_en>',
      '<workflow>',
      '### 1. 接收候选',
      '- 读取用户提供的 Top 候选',
      '</workflow>',
      '</agent>',
      'tail',
    ].join('\n');
    const stripped = _stripSurvivingAgentBlocks(buf);
    expect(stripped).not.toContain('bc7ac250df71');
    expect(stripped).not.toContain('按来源边界整理');
    expect(stripped).not.toContain('Organize Agent / Skill');
    expect(stripped).not.toContain('<workflow>');
    expect(stripped).toBe('preface\n\ntail');

    const replaced = _replaceOuterAgentBlocks(buf, PH);
    expect(replaced).toBe(`preface\n\n${PH}\ntail`);
    expect(replaced.split(PH).length - 1).toBe(1);
  });
});

// --- Set B: literal mentions must survive ---------------------------------

describe('set B — literal <agent> in code must be preserved', () => {
  it('B1. inside a fenced non-XML code block', () => {
    const buf = 'Use this format:\n```\n<agent><name>X</name></agent>\n```\nafter';
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

  it('B4. inline quoted text survives', () => {
    const buf = '请输出 "<agent>...</agent>" 这几个字符';
    expect(_stripSurvivingAgentBlocks(buf)).toBe(buf);
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(buf);
  });
});

describe('explicit XML fences are treated as structural blocks', () => {
  it('strips a complete agent container inside ```xml', () => {
    const buf = '```xml\n<agent><name>X</name></agent>\n```';
    expect(_stripSurvivingAgentBlocks(buf)).toBe('```xml\n\n```');
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`\`\`\`xml\n${PH}\n\`\`\``);
  });

  it('quoted XML at line start is still a structure block', () => {
    const buf = '"<agent><name>X</name></agent>"';
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`"${PH}"`);
  });

  it('inline quoted XML inside ```xml is still structural', () => {
    const buf = '```xml\nvalue="<agent><name>X</name></agent>"\n```';
    expect(_replaceOuterAgentBlocks(buf, PH)).toBe(`\`\`\`xml\nvalue="${PH}"\n\`\`\``);
  });
});

// --- Mixed: container + literal mention coexisting -------------------------

describe('mixed — real container + literal mention in one buffer', () => {
  it('only the real container is replaced; quoted example survives', () => {
    const buf = [
      'Example format:',
      '```',
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
    // Quoted example inside a non-XML code fence stays.
    expect(stripped).toContain('```');
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

  it('opener inside non-XML fenced code → no range produced', () => {
    const buf = '```\n<agent>x</agent>\n```';
    expect(_findOuterAgentRanges(buf)).toEqual([]);
  });

  it('opener inside explicit XML fenced code → range produced', () => {
    const buf = '```xml\n<agent>x</agent>\n```';
    expect(_findOuterAgentRanges(buf)).toHaveLength(1);
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
  it('B1. inside a fenced non-XML code block (protocol explanation)', () => {
    const buf = 'Format:\n```\n<agent-input-form>\n[]\n</agent-input-form>\n```\nend';
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

describe('<agent-input-form> — explicit XML fences are structural', () => {
  it('replaces a form block inside ```xml', () => {
    const buf = 'Format:\n```xml\n<agent-input-form>\n[]\n</agent-input-form>\n```\nend';
    expect(_replaceOuterTagBlocks(buf, 'agent-input-form', PH)).toBe(`Format:\n\`\`\`xml\n${PH}\n\`\`\`\nend`);
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
  it('B1. inside a fenced non-XML code block', () => {
    const buf = 'Reply format:\n```\n<agent-input-submission form_id="x" agent_id="y">\n{}\n</agent-input-submission>\n```';
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

describe('<agent-input-submission> — explicit XML fences are structural', () => {
  it('strips a submission block inside ```xml', () => {
    const buf = 'Reply format:\n```xml\n<agent-input-submission form_id="x" agent_id="y">\n{}\n</agent-input-submission>\n```';
    expect(_stripOuterTagBlocks(buf, 'agent-input-submission')).toBe('Reply format:\n```xml\n\n```');
  });
});

describe('main-chat creation stream stripping', () => {
  function streamDisplay(buf: string): string {
    const skillPh = '[organizing skill config]';
    return _collapseRepeatedStructuralPlaceholders(_stripSkillCreateContainer(
      _replaceOuterTagBlocks(
        strip._replaceOuterSkillFileBlocks(buf, () => `\n${skillPh}\n`),
        'agent',
        PH,
      ),
      `\n${skillPh}\n`,
    ), `\n${skillPh}\n`);
  }

  it('does not leak skill frontmatter or agent XML while bulk create output streams', () => {
    const raw = [
      '<skill>',
      '<<<skill-file path=SKILL.md',
      '---',
      'name: leio-sdlc-adapter',
      'description_zh: "把研发工作组织成带状态机和队列的流程"',
      'description_en: "Organize engineering work into an SDLC flow"',
      '---',
      '',
      '# leio-sdlc-adapter',
      '## 何时使用',
      '- 用户提到 `LEIO SDLC`。',
      '>>>',
      '</skill>',
      '',
      '<agent>',
      '<name>Plandex研发助手</name>',
      '<description_zh>围绕大项目编码任务做计划。</description_zh>',
      '<workflow>',
      '### 1. 收集上下文',
      '- `read_file` — 读取材料。',
      '</workflow>',
      '</agent>',
    ].join('\n');

    for (let i = 1; i <= raw.length; i++) {
      const display = streamDisplay(raw.slice(0, i));
      expect(display).not.toMatch(/name: leio|description_zh|description_en|把研发工作组织|Organize engineering|# leio-sdlc-adapter|<workflow>|Plandex研发助手/);
    }
    expect(streamDisplay(raw)).toContain('[organizing skill config]');
  });

  it('shows one skill placeholder for consecutive skill-file blocks', () => {
    const raw = [
      '<skill>',
      '<<<skill-file path=SKILL.md',
      '---',
      'name: first',
      '>>>',
      '<<<skill-file path=scripts/a.py',
      'print("a")',
      '>>>',
      '</skill>',
    ].join('\n');
    const display = streamDisplay(raw);
    expect(display.split('[organizing skill config]').length - 1).toBe(1);
  });
});

describe('stream placeholders', () => {
  it('collapses consecutive repeated structural placeholders', () => {
    expect(_collapseRepeatedStructuralPlaceholders(`lead\n${PH}\n\n${PH}\ntrail`, PH))
      .toBe(`lead\n${PH}\ntrail`);
    expect(_collapseRepeatedStructuralPlaceholders(`lead\n${PH}\nkeep\n${PH}`, PH))
      .toBe(`lead\n${PH}\nkeep\n${PH}`);
  });
});

describe('user message display stripping', () => {
  it('preserves ordinary one-line @agent messages', () => {
    const buf = '@Agent Skill 搜集 你再次执行';
    expect(_stripUserStructuralBlocksForDisplay(buf)).toBe(buf);
  });

  it('strips the routing @mention only for real form submission replays', () => {
    const buf = [
      '@Research Agent',
      'You confirmed:',
      '<agent-input-submission form_id="abc12345" agent_id="research-agent">',
      '{"topic":"x"}',
      '</agent-input-submission>',
    ].join('\n');
    expect(_stripUserStructuralBlocksForDisplay(buf)).toBe('You confirmed:');
  });
});

describe('skill id display replacement', () => {
  const skills = [
    { id: '16e1bfcb3426', name: 'agent-creator' },
    { id: 'efb0fe5d9664', name: 'skill-creator' },
  ];

  it('renders marketplace skill ids as display names in prose', () => {
    const buf = 'Use `16e1bfcb3426`, then follow efb0fe5d9664.';
    expect(_replaceKnownSkillIdsForDisplay(buf, skills))
      .toBe('Use `agent-creator`, then follow skill-creator.');
  });

  it('does not replace embedded hash fragments or unknown ids', () => {
    const buf = 'x16e1bfcb3426y 000000000000';
    expect(_replaceKnownSkillIdsForDisplay(buf, skills)).toBe(buf);
  });

  it('simplifies skill follow phrasing to a compact display reference', () => {
    expect(_simplifyKnownSkillFollowPhrasesForDisplay('skill: follow the `agent-creator` skill，then continue', skills))
      .toBe('`agent-creator` skill，then continue');
    expect(_normalizeKnownSkillRefsForDisplay('`skill: follow the 16e1bfcb3426 skill` — create agents', skills))
      .toBe('`agent-creator` skill — create agents');
  });
});

// `<artifact-result>` — the machine tag a renderer composes when an
// interactive artifact posts a result back; carried in a user message so
// the agent can parse it, stripped from the user bubble's display via
// `_stripArtifactResultTagForDisplay` (which delegates to `_stripOuterTagBlocks`).
// Same whack-a-mole class as the submission tag — pin set A + set B.
describe('<artifact-result> — set A (real result tags stripped from display)', () => {
  it('A1. result tag with attributes and a JSON payload body', () => {
    const buf = 'Result from "Tip calc"\n\n<artifact-result artifact_id="abc123" agent_id="helper">\n{"payload":{"tip":18,"total":118}}\n</artifact-result>';
    expect(_stripOuterTagBlocks(buf, 'artifact-result')).toBe('Result from "Tip calc"\n\n');
  });

  it('A2. payload JSON value contains backticks / angle brackets — still atomic', () => {
    const buf = 'Result from "Editor"\n\n<artifact-result artifact_id="x" agent_id="a">\n{"payload":{"code":"a `b` <c>"}}\n</artifact-result>\nthanks';
    const out = _stripOuterTagBlocks(buf, 'artifact-result');
    expect(out).not.toContain('artifact-result');
    expect(out).not.toContain('`b`');
    expect(out).toBe('Result from "Editor"\n\n\nthanks');
  });
});

describe('<artifact-result> — set B (literal mentions survive)', () => {
  it('B1. inside a fenced non-XML code block (e.g. the tool description quoting the protocol)', () => {
    const buf = 'Format:\n```\n<artifact-result artifact_id="x" agent_id="y">\n{...}\n</artifact-result>\n```';
    expect(_stripOuterTagBlocks(buf, 'artifact-result')).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'The renderer posts a `<artifact-result ...>` tag back to you.';
    expect(_stripOuterTagBlocks(buf, 'artifact-result')).toBe(buf);
  });

  it('B3. UNCLOSED inline backtick', () => {
    const buf = 'see `<artifact-result';
    expect(_stripOuterTagBlocks(buf, 'artifact-result')).toBe(buf);
  });
});

describe('<artifact-result> — explicit XML fences are structural', () => {
  it('strips a result block inside ```xml', () => {
    const buf = 'Format:\n```xml\n<artifact-result artifact_id="x" agent_id="y">\n{...}\n</artifact-result>\n```';
    expect(_stripOuterTagBlocks(buf, 'artifact-result')).toBe('Format:\n```xml\n\n```');
  });
});

// `<marketplace-install-result>` — the machine tag the commander composes
// when an install request resolves (accepted / declined / failed). Carried
// in a user message so the next commander turn can read it; stripped from
// the user bubble's display via `_stripUserStructuralBlocksForDisplay`.
// Same whack-a-mole class as `<agent-input-submission>` / `<artifact-result>`
// — added to `_stripSurvivingStructuralBlocks` allow-list in `2f325f90`
// without fixtures, retroactively pinned here. Real shape (from
// `group_chat/index.ts::resolveMarketplaceInstallRequest`):
//   `<marketplace-install-result request_id="..." kind="..." id="..." status="..."> body </marketplace-install-result>`
describe('<marketplace-install-result> — set A (real result tags stripped from display)', () => {
  it('A1. result tag with the 4 standard attributes + body', () => {
    const buf = 'Confirming install:\n\n<marketplace-install-result request_id="r-1" kind="agent" id="abcd1234" status="accepted">\nuser approved\n</marketplace-install-result>';
    expect(_stripOuterTagBlocks(buf, 'marketplace-install-result')).toBe('Confirming install:\n\n');
  });

  it('A2. body contains backticks / angle brackets — still atomic', () => {
    const buf = 'pre\n\n<marketplace-install-result request_id="r" kind="skill" id="x" status="declined">\nreason: user said "use `<existing>` instead"\n</marketplace-install-result>\npost';
    const out = _stripOuterTagBlocks(buf, 'marketplace-install-result');
    expect(out).not.toContain('marketplace-install-result');
    expect(out).not.toContain('`<existing>`');
    expect(out).toBe('pre\n\n\npost');
  });
});

describe('<marketplace-install-result> — set B (literal mentions survive)', () => {
  it('B1. inside a fenced non-XML code block (e.g. docs quoting the protocol)', () => {
    const buf = 'Wire format:\n```\n<marketplace-install-result request_id="X" kind="agent" id="Y" status="accepted">\n...\n</marketplace-install-result>\n```';
    expect(_stripOuterTagBlocks(buf, 'marketplace-install-result')).toBe(buf);
  });

  it('B2. inside an inline backtick span', () => {
    const buf = 'The commander posts a `<marketplace-install-result ...>` tag when the install resolves.';
    expect(_stripOuterTagBlocks(buf, 'marketplace-install-result')).toBe(buf);
  });

  it('B3. UNCLOSED inline backtick (mid-stream code-explanation)', () => {
    const buf = 'see `<marketplace-install-result';
    expect(_stripOuterTagBlocks(buf, 'marketplace-install-result')).toBe(buf);
  });
});

describe('<marketplace-install-result> — explicit XML fences are structural', () => {
  it('strips a result block inside ```xml (parity with <artifact-result>)', () => {
    const buf = 'Reply:\n```xml\n<marketplace-install-result request_id="X" kind="agent" id="Y" status="accepted">\nok\n</marketplace-install-result>\n```';
    expect(_stripOuterTagBlocks(buf, 'marketplace-install-result')).toBe('Reply:\n```xml\n\n```');
  });
});

describe('<marketplace-install-result> — round-trip through the two strip callers', () => {
  it('_stripSurvivingStructuralBlocks removes assistant-text hallucinations of the tag', () => {
    const buf = 'Sure, here is the install reply you asked for: <marketplace-install-result request_id="r" kind="skill" id="x" status="accepted">echo</marketplace-install-result> done.';
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).not.toContain('marketplace-install-result');
    expect(out).toContain('Sure, here is the install reply you asked for:');
    expect(out).toContain('done.');
  });

  it('_stripUserStructuralBlocksForDisplay removes the user-emitted tag from the bubble', () => {
    const buf = 'I accept.\n\n<marketplace-install-result request_id="r" kind="agent" id="x" status="accepted">ok</marketplace-install-result>';
    expect(_stripUserStructuralBlocksForDisplay(buf)).toBe('I accept.');
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

  it('strips a leaked <artifact-result> in assistant text but preserves a literal mention in code', () => {
    const real = 'lead\n<artifact-result artifact_id="x" agent_id="a">{"payload":1}</artifact-result>\ntail';
    expect(_stripSurvivingStructuralBlocks(real)).toBe('lead\n\ntail');
    const literal = 'Post back a `<artifact-result ...>` tag.';
    expect(_stripSurvivingStructuralBlocks(literal)).toBe(literal);
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
      '```',
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
      '```',
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

  it('strips structural tags inside explicit XML fences', () => {
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
    expect(out).not.toContain('<agent><name>X</name></agent>');
    expect(out).not.toContain('<agent-input-form>');
    expect(out).not.toContain('<agent-input-submission');
    expect(out).toContain('```xml');
    expect(out).toContain('end');
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
// Different delimiter family from XML tags above (see strip-structural-blocks.js
// header). The skill-file block wraps **arbitrary file content** that may
// contain naked `<` / `>` chars (Python, TypeScript, HTML, JSX, configs);
// using XML tags would force the LLM to escape — instead the LLM-side
// prompt (`chat_skill_setup.md`) declares a literal `<<<` / `\n>>>` fence
// pair. The renderer must still apply the same prose/code outer-context
// guard so a literal `<<<skill-file ...>>>` mention inside a fenced code
// block / inline backtick (LLM explaining the protocol to the user)
// survives, while a real block (containing arbitrary file content with
// naked backticks / fences inside) is stripped/replaced atomically.

const skill = require('../../src/renderer/modules/strip-structural-blocks.js');
const {
  _findOuterSkillFileRanges,
  _stripOuterSkillFileBlocks,
  _replaceOuterSkillFileBlocks,
  _extractSkillFilePath,
  _replaceUnclosedDashboardBlocks,
} = skill as {
  _findOuterSkillFileRanges: (text: string) => Array<[number, number]>;
  _stripOuterSkillFileBlocks: (text: string) => string;
  _replaceOuterSkillFileBlocks: (buf: string, makePlaceholder: (path: string) => string) => string;
  _extractSkillFilePath: (blockText: string) => string;
  _replaceUnclosedDashboardBlocks: (buf: string, placeholder: string) => string;
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

  it('B4. inline quoted text survives', () => {
    const buf = '请输出 "<<<skill-file path=SKILL.md>>>" 这几个字符';
    expect(_stripOuterSkillFileBlocks(buf)).toBe(buf);
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe(buf);
  });
});

describe('skill-file — explicit XML fences are machine blocks', () => {
  it('replaces a complete skill-file block inside ```xml', () => {
    const buf = [
      '```xml',
      '<<<skill-file path=SKILL.md',
      'body',
      '>>>',
      '```',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('```xml\n\n```');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('```xml\n⟨SKILL:SKILL.md⟩\n```');
  });

  it('replaces an inline quoted skill-file block inside ```xml', () => {
    const buf = [
      '```xml',
      'value="<<<skill-file path=SKILL.md',
      'body',
      '>>>"',
      '```',
    ].join('\n');
    expect(_stripOuterSkillFileBlocks(buf)).toBe('```xml\nvalue=""\n```');
    expect(_replaceOuterSkillFileBlocks(buf, SKILL_PH)).toBe('```xml\nvalue="⟨SKILL:SKILL.md⟩"\n```');
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

describe('dashboard streaming placeholders', () => {
  const DASH_PH = '⟨DASHBOARD⟩';

  it('replaces an unclosed dashboard block so partial JSON does not stream into the bubble', () => {
    const buf = '已生成网页看板：\n\n:::dashboard\n{\n  "root": { "type": "Table", "props": {';
    expect(_replaceUnclosedDashboardBlocks(buf, DASH_PH))
      .toBe('已生成网页看板：\n\n⟨DASHBOARD⟩');
  });

  it('leaves a complete dashboard block alone so the final renderer can mount it', () => {
    const buf = 'before\n:::dashboard\n{"root":{"type":"Separator"}}\n:::\nafter';
    expect(_replaceUnclosedDashboardBlocks(buf, DASH_PH)).toBe(buf);
  });

  it('does not replace literal dashboard examples inside fenced code', () => {
    const buf = '```md\n:::dashboard\n{"root":null}\n```\n';
    expect(_replaceUnclosedDashboardBlocks(buf, DASH_PH)).toBe(buf);
  });
});

// Streaming-time skill-container stripper. Unique surface vs `<agent>`:
// closed containers must keep their inner content (per-file placeholders)
// while still hiding outer `<skill>` / `<skill_id>` scaffolding; unclosed
// containers must collapse to a single fallback placeholder. Adding a
// guard / branch here later requires extending the fixture set with the
// new motivating shape — patch isn't done until the new fixture is green
// AND every previous fixture still passes (PC/CLAUDE.md §9 hard rule).
describe('_stripSkillCreateContainer — set A (real shapes)', () => {
  it('A1. closed container with skill_id + per-file placeholder body', () => {
    // The earlier pipeline pass replaces `<<<skill-file>>>` with the
    // per-file placeholder; we feed the post-pass shape and expect the
    // outer `<skill>` shell + `<skill_id>` to vanish, body retained.
    const buf = 'preface\n<skill>\n<skill_id>foo</skill_id>\n[Writing SKILL.md…]\n</skill>\ntail';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('preface');
    expect(out).toContain('[Writing SKILL.md…]');
    expect(out).toContain('tail');
    expect(out).not.toContain('<skill>');
    expect(out).not.toContain('</skill>');
    expect(out).not.toContain('<skill_id>');
    expect(out).not.toContain('foo');
    expect(out).not.toContain('⟨FALLBACK⟩');
  });

  it('A2. closed container WITHOUT skill_id (create flow)', () => {
    const buf = '<skill>\n[Writing SKILL.md…]\n[Writing scripts/foo.py…]\n</skill>';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('[Writing SKILL.md…]');
    expect(out).toContain('[Writing scripts/foo.py…]');
    expect(out).not.toContain('<skill>');
  });

  it('A2c. metadata-only skill edit collapses to the fallback placeholder', () => {
    const buf = '<skill>\n<skill_id>foo</skill_id>\n<category>data</category>\n</skill>';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toBe('⟨FALLBACK⟩');
    expect(out).not.toContain('<category>');
    expect(out).not.toContain('data');
  });

  it('A2b. closed real container hides skill-file blocks even when the LLM fenced them', () => {
    // The backend can still parse this because the `<skill>` container is
    // real. If a raw `<<<skill-file>>>` survives until this later pass, the
    // streaming renderer must not leak SKILL.md body content while waiting
    // for the final parsed message.
    const buf = [
      '<skill>',
      '```xml',
      '<<<skill-file path=SKILL.md',
      '---',
      'name: frontend-ui-engineering',
      '---',
      '',
      '## Quick Reference: ARIA Live Regions',
      '| Value | Behavior |',
      '>>>',
      '```',
      '</skill>',
    ].join('\n');
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('⟨FALLBACK⟩');
    expect(out).not.toContain('<<<skill-file');
    expect(out).not.toContain('frontend-ui-engineering');
    expect(out).not.toContain('Quick Reference: ARIA Live Regions');
  });

  it('A3. unclosed container collapses to fallback placeholder', () => {
    // Mid-stream: `<skill>` opened, no `</skill>` yet. Inner content may
    // still be raw `<skill_id>` / token fragments — the fallback hides
    // ALL of it until the closer arrives.
    const buf = 'before\n<skill>\n<skill_id>foo</skill_id>\nhalf-stre';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('before');
    expect(out).toContain('⟨FALLBACK⟩');
    expect(out).not.toContain('<skill_id>');
    expect(out).not.toContain('half-stre');
  });

  it('A4. multiple closed containers in one buffer (rare; both stripped)', () => {
    const buf = '<skill>\n<skill_id>a</skill_id>\nA-body\n</skill>\nmid\n<skill>\nB-body\n</skill>';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('A-body');
    expect(out).toContain('mid');
    expect(out).toContain('B-body');
    expect(out).not.toContain('<skill>');
    expect(out).not.toContain('<skill_id>');
  });

  it('A5. interior whitespace trim — opening newline + closing newline both eaten', () => {
    const buf = '<skill>\n\nINNER\n\n</skill>';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toContain('INNER');
    // The `\s*` strips on both sides should keep the line count tame —
    // no triple-newline runs left over from the surgery.
    expect(/\n{3,}/.test(out)).toBe(false);
  });
});

describe('_stripSkillCreateContainer — set B (look-alikes must NOT match)', () => {
  it('B1. agent <skills> sub-tag must NOT trigger skill-container handling', () => {
    // The agent flow's `<skills>` list lives inside an `<agent>` container.
    // The boundary check (`<skill>` open token) must reject `<skills>` —
    // matching it would silently swallow the agent's skill list.
    const buf = '<agent>\n<skills>\nfoo-skill\n</skills>\n</agent>';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toBe(buf);
  });

  it('B2. explicit `<skill>` inside a fenced ```xml block is structural', () => {
    const buf = 'See:\n```xml\n<skill>\n<skill_id>foo</skill_id>\n</skill>\n```\nend';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).not.toContain('<skill>');
    expect(out).not.toContain('<skill_id>');
    expect(out).not.toContain('foo');
  });

  it('B3. literal `<skill>` inside an inline backtick span', () => {
    const buf = 'use the `<skill>` container to wrap things';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toBe(buf);
  });

  it('B3b. inline quoted `<skill>` text survives', () => {
    const buf = '请输出 "<skill>...</skill>" 这几个字符';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toBe(buf);
  });

  it('B4. bare prose with no `<skill>` token returns input unchanged', () => {
    const buf = 'I will write a skill that does X';
    const out = _stripSkillCreateContainer(buf, '⟨FALLBACK⟩');
    expect(out).toBe(buf);
  });

  it('B5. empty / falsy input', () => {
    expect(_stripSkillCreateContainer('', '⟨FALLBACK⟩')).toBe('');
    expect(_stripSkillCreateContainer(undefined as any, '⟨FALLBACK⟩')).toBe(undefined);
  });
});

describe('<skill-meta> final safety strip', () => {
  it('strips leaked skill metadata blocks', () => {
    const buf = 'done\n<skill-meta>\n<category>data</category>\n</skill-meta>\ntail';
    const out = _stripSurvivingStructuralBlocks(buf);
    expect(out).toBe('done\n\ntail');
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
