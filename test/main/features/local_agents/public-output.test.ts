import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  CodexFileCitationStreamFilter,
  normalizeLocalAgentPublicOutput,
  persistedCodexOutputCitationPaths,
  sanitizePersistedCodexFileCitations,
} from '../../../../src/main/features/local_agents/public-output';

describe('local_agents/public-output', () => {
  // The requester confirmed that native answer text is opaque to Orkas.
  // Section labels are task content, including older Hermes work-record shapes.
  it.each([
    { name: 'ordinary four-section answer without R', text: 'K — Retry count: 3\nS — Timeout: 60 seconds\nT — Target: output\nA — Archive: enabled' },
    { name: 'ordinary five-section answer', text: 'K — Retry count: 3\nS — Timeout: 60 seconds\nT — Target: output\nA — Archive: enabled\nR — Retention: 7 days' },
    { name: 'native work record with a result', text: 'K — Knowledge\nContext\nS — Situation\nGreeting\nT — Task\nReply\nÂ — Action\nCompose\nR̂ — Expected result\nA greeting\nR — Result\nHello!\nΔR — Gap\nNone\nAAR — Retrospective\nDone' },
    { name: 'Markdown and fullwidth heading variants', text: '### K（知识）：上下文\r\n**S — Situation**\r\nGreeting\r\n### T - reply\r\n### Â (Action) – compose\r\n### R (Result)：结果：你好' },
    { name: 'fenced example', text: 'Template:\n```text\nK — Knowledge\nS — Situation\nT — Task\nA — Action\nR — Result: example\n```' },
    { name: 'incomplete heading fragment', text: 'The notation is:\nK — Knowledge\nThat is one section.' },
    { name: 'empty native answer', text: '' },
    { name: 'whitespace-only native answer', text: '  \r\n' },
  ])('preserves Hermes $name verbatim', ({ text }) => {
    expect(normalizeLocalAgentPublicOutput({ cli: 'hermes', text }))
      .toEqual({ text, publishedPaths: [] });
  });

  it.each(['codex', 'claude', 'opencode', 'openclaw'] as const)(
    'preserves ordinary sectioned text from %s', (cli) => {
      const text = 'K — Knowledge\nS — Situation\nT — Task\nA — Action\nR — Result: keep all sections';
      expect(normalizeLocalAgentPublicOutput({ cli, text })).toEqual({ text, publishedPaths: [] });
    },
  );

  it('does not infer a Hermes runtime failure from successful response text', () => {
    const text = 'API call failed after 3 retries: HTTP 404: 404 Not found. Check the docs for available routes.';
    expect(normalizeLocalAgentPublicOutput({ cli: 'hermes', text })).toEqual({ text, publishedPaths: [] });
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
