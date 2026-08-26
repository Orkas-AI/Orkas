import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  CodexFileCitationStreamFilter,
  normalizeLocalAgentPublicOutput,
  persistedCodexOutputCitationPaths,
  sanitizeLocalAgentPublicOutput,
  sanitizePersistedCodexFileCitations,
} from '../../../../src/main/features/local_agents/public-output';

describe('local_agents/public-output', () => {
  it('publishes only the result from a real Hermes KSTAR scaffold', () => {
    const raw = [
      'K — 知识',
      '- 用户画像：PRIVATE_PROFILE_SENTINEL',
      'S — 情境',
      '- 用户只是打了个招呼。',
      'T — 任务',
      '- 回复用户。',
      'Â — 行动',
      '- 生成简短问候。',
      'R̂ — 预期结果',
      '- 不泄露内部上下文。',
      'R — 结果',
      '你好！今天想一起处理什么？',
      'ΔR — 差距',
      '- 无。',
      'AAR — 复盘',
      '- 已完成。',
    ].join('\n');

    const output = sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '你好',
    });

    expect(output).toBe('你好！今天想一起处理什么？');
    expect(output).not.toContain('PRIVATE_PROFILE_SENTINEL');
    expect(output).not.toContain('AAR');
  });

  it('accepts Markdown headings and an inline result label', () => {
    const raw = [
      '**K — Knowledge**',
      'context',
      '**S — Situation**',
      'greeting',
      '**T — Task**',
      'reply',
      '**A — Action**',
      'compose',
      '**R — Result: Ready to help.**',
      '**AAR — Retrospective**',
      'done',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Hello',
    })).toBe('Ready to help.');
  });

  it('accepts heading, separator, label, and newline variants', () => {
    const raw = [
      '### K（知识）：known context',
      '### S (Situation): greeting',
      '### T - reply',
      '### Â (Action) – compose',
      '### R̂（预期结果）：concise answer',
      '### R (Result)：结果：兼容后的公开答案',
      '### ΔR (Gap): none',
      '### AAR（复盘）：done',
    ].join('\r\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '你好',
    })).toBe('兼容后的公开答案');
  });

  it('leaves an ordinary answer with a KSTAR-like fragment unchanged', () => {
    const raw = 'A normal explanation may mention this notation:\nK — Knowledge\nThat alone is not a private scaffold.';

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Explain the notation',
    })).toBe(raw);
  });

  it('does not treat a fenced KSTAR example as an emitted scaffold', () => {
    const raw = [
      'Here is the template:',
      '```text',
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: example',
      'AAR — Retrospective',
      '```',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Show a template',
    })).toBe(raw);
  });

  it('suppresses a recognized private scaffold when no public result exists', () => {
    const raw = [
      'K — Knowledge',
      'PRIVATE_PROFILE_SENTINEL',
      'S — Situation',
      'greeting',
      'T — Task',
      'reply',
      'A — Action',
      'interrupted before result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Hello',
    })).toBe('');
  });

  it('preserves KSTAR when the user explicitly requests that format', () => {
    const raw = [
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: requested output',
      'AAR — Retrospective',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: '请使用 KSTAR 格式回答',
    })).toBe(raw);
  });

  it.each([
    '请按 K、S、T、A、R 五段回答',
    'Please answer using sections K, S, T, A, and R.',
    'Use K/S/T/A/R format.',
  ])('preserves explicitly requested K/S/T/A/R sections: %s', (userTask) => {
    const raw = [
      'K — Knowledge',
      'requested knowledge',
      'S — Situation',
      'requested situation',
      'T — Task',
      'requested task',
      'A — Action',
      'requested action',
      'R — Result: requested result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask,
    })).toBe(raw);
  });

  it.each([
    'Please answer whether K, S, T, A, and R are used as variable names.',
    '请回答 K、S、T、A、R 是否只是变量名。',
    'Use K/S/A/T/R format.',
    'Use K/S/T/A format.',
    `Use K ${'context '.repeat(24)}S/T/A/R format.`,
  ])('does not preserve a scaffold without an explicit ordered section request: %s', (userTask) => {
    const raw = [
      'K — Knowledge',
      'private knowledge',
      'S — Situation',
      'private situation',
      'T — Task',
      'private task',
      'A — Action',
      'private action',
      'R — Result: public result',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask,
    })).toBe('public result');
  });

  it('does not rewrite another CLI runtime', () => {
    const raw = [
      'K — Knowledge',
      'S — Situation',
      'T — Task',
      'A — Action',
      'R — Result: keep all sections',
      'AAR — Retrospective',
    ].join('\n');

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'codex',
      text: raw,
      userTask: 'Summarize',
    })).toBe(raw);
  });

  it('does not infer a Hermes runtime failure from successful response text', () => {
    const raw = 'API call failed after 3 retries: HTTP 404: 404 Not found. Check the docs for available routes.';

    expect(sanitizeLocalAgentPublicOutput({
      cli: 'hermes',
      text: raw,
      userTask: 'Reply with this diagnostic verbatim.',
    })).toBe(raw);
    expect(sanitizeLocalAgentPublicOutput({
      cli: 'codex',
      text: raw,
      userTask: 'Repeat this diagnostic.',
    })).toBe(raw);
  });

  describe('Codex file citations', () => {
    const workingDir = path.resolve('tmp-public-output-workspace');
    const deckPath = path.join(workingDir, 'assets', 'AI会议助手竞品分析.pptx');

    it('turns the native output directive into an exact published-file selection', () => {
      const raw = [
        '演示文稿已经完成。',
        '',
        `:codex-file-citation{path="${deckPath}" purpose="output"}`,
      ].join('\n');

      expect(normalizeLocalAgentPublicOutput({
        cli: 'codex',
        text: raw,
        workingDir,
        producedPaths: [deckPath, path.join(workingDir, 'supporting-notes.md')],
      })).toEqual({
        text: '演示文稿已经完成。',
        publishedPaths: [deckPath],
      });
    });

    it('supports relative paths, attribute order, and multiple deduplicated outputs', () => {
      const spreadsheetPath = path.join(workingDir, 'results', 'metrics.xlsx');
      const raw = [
        ':codex-file-citation{purpose="output" path="assets/AI会议助手竞品分析.pptx"}',
        ':codex-file-citation{path="results/metrics.xlsx" purpose="output"}',
        ':codex-file-citation{path="results/metrics.xlsx" purpose="output"}',
      ].join('\n');

      expect(normalizeLocalAgentPublicOutput({
        cli: 'codex',
        text: raw,
        workingDir,
        producedPaths: [deckPath, spreadsheetPath],
      })).toEqual({
        text: '',
        publishedPaths: [deckPath, spreadsheetPath],
      });
    });

    it('removes transport metadata but cannot publish a path not registered by the turn', () => {
      const outsidePath = path.resolve('private', 'unregistered.pdf');
      expect(normalizeLocalAgentPublicOutput({
        cli: 'codex',
        text: `Done.\n${`:codex-file-citation{path="${outsidePath}" purpose="output"}`}`,
        workingDir,
        producedPaths: [deckPath],
      })).toEqual({
        text: 'Done.',
        publishedPaths: [],
      });
    });

    it('preserves fenced, quoted, inline, and malformed examples', () => {
      const raw = [
        'Example:',
        '```text',
        `:codex-file-citation{path="${deckPath}" purpose="output"}`,
        '```',
        `> :codex-file-citation{path="${deckPath}" purpose="output"}`,
        `Inline :codex-file-citation{path="${deckPath}" purpose="output"}`,
        ':codex-file-citation{path="unterminated purpose="output"}',
      ].join('\n');

      expect(normalizeLocalAgentPublicOutput({
        cli: 'codex',
        text: raw,
        workingDir,
        producedPaths: [deckPath],
      })).toEqual({ text: raw, publishedPaths: [] });
    });

    it('does not interpret a Codex directive emitted by another CLI adapter', () => {
      const raw = `:codex-file-citation{path="${deckPath}" purpose="output"}`;
      expect(normalizeLocalAgentPublicOutput({
        cli: 'claude',
        text: raw,
        workingDir,
        producedPaths: [deckPath],
      })).toEqual({ text: raw, publishedPaths: [] });
    });

    it('projects legacy persisted output only when its structured file list backs the citation', () => {
      const raw = `Ready.\n:codex-file-citation{path="${deckPath}" purpose="output"}`;
      expect(sanitizePersistedCodexFileCitations(raw, [deckPath])).toBe('Ready.');
      expect(sanitizePersistedCodexFileCitations(raw, [])).toBe(raw);
    });

    it('extracts legacy output candidates without consuming fenced examples', () => {
      const raw = [
        `:codex-file-citation{path="assets/AI会议助手竞品分析.pptx" purpose="output"}`,
        '```text',
        ':codex-file-citation{path="private/inside-example.pdf" purpose="output"}',
        '```',
        ':codex-file-citation{path="assets/notes.md" purpose="input"}',
      ].join('\n');

      expect(persistedCodexOutputCitationPaths(raw, workingDir)).toEqual([deckPath]);
    });

    it('consumes the legacy suffix adjacent to a Markdown link for the same file', () => {
      const directive = `:codex-file-citation{path="${deckPath}" name="deck" purpose="output"}`;
      const link = `新版文件：[AI会议助手竞品分析.pptx](${deckPath})`;
      const raw = `${link}${directive}`;

      expect(persistedCodexOutputCitationPaths(raw)).toEqual([deckPath]);
      expect(sanitizePersistedCodexFileCitations(raw, [deckPath])).toBe(link);

      const mismatched = `${link}:codex-file-citation{path="${path.join(workingDir, 'other.pptx')}" purpose="output"}`;
      expect(persistedCodexOutputCitationPaths(mismatched)).toEqual([]);
      expect(sanitizePersistedCodexFileCitations(mismatched, [deckPath])).toBe(mismatched);
    });

    it('never streams a split directive and keeps fenced examples visible', () => {
      const filter = new CodexFileCitationStreamFilter();
      const chunks = [
        filter.push('完成。\n:codex-file-'),
        filter.push(`citation{path="${deckPath}" purpose="out`),
        filter.push('put"}\n下一行'),
        filter.flush(),
      ];
      expect(chunks.join('')).toBe('完成。\n下一行');

      const inline = new CodexFileCitationStreamFilter();
      const link = `[deck](${deckPath})`;
      expect([
        inline.push(`${link}:codex-file-citation{path="${deckPath}" purpose="output"}\n`),
        inline.flush(),
      ].join('')).toBe(`${link}\n`);

      const fenced = new CodexFileCitationStreamFilter();
      expect([
        fenced.push(`\`\`\`text\n:codex-file-citation{path="${deckPath}" purpose="output"}\n`),
        fenced.push('\`\`\`'),
        fenced.flush(),
      ].join('')).toBe([
        '```text',
        `:codex-file-citation{path="${deckPath}" purpose="output"}`,
        '```',
      ].join('\n'));
    });
  });
});
