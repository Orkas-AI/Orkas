import { describe, it, expect } from 'vitest';
import {
  CodexAgentMessageAccumulator,
  buildCodexThreadPermissionOverrides,
  buildCodexTurnPermissionOverrides,
  buildCodexTurnRuntimeOverrides,
  extractCodexDiffFiles,
  extractThreadId,
  extractCodexUsage,
  mapCodexItemToolEvent,
  selectCodexTurnPrompt,
} from '../../../../src/main/features/local_agents/backends/codex';

describe('local_agents/backends/codex › phased agent messages', () => {
  it('maps item phases onto deltas and resolves only the final answer', () => {
    const messages = new CodexAgentMessageAccumulator();
    messages.rememberItem({ id: 'comment-1', type: 'agentMessage', phase: 'commentary' });
    expect(messages.appendDelta({ itemId: 'comment-1', delta: 'Checking files…' })).toEqual({
      itemId: 'comment-1',
      phase: 'commentary',
      text: 'Checking files…',
    });

    messages.rememberItem({ id: 'final-1', type: 'agentMessage', phase: 'final_answer' });
    expect(messages.appendDelta({ itemId: 'final-1', delta: 'Fixed.' })).toEqual({
      itemId: 'final-1',
      phase: 'final_answer',
      text: 'Fixed.',
    });
    expect(messages.output()).toBe('Fixed.');
  });

  it('emits only a missing completion suffix and keeps its phase', () => {
    const messages = new CodexAgentMessageAccumulator();
    messages.rememberItem({ id: 'final-1', type: 'agentMessage', phase: 'final_answer' });
    messages.appendDelta({ itemId: 'final-1', delta: 'Final ' });

    expect(messages.appendCompletedFallback({
      id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'Final answer',
    })).toEqual({ itemId: 'final-1', phase: 'final_answer', text: 'answer' });
    expect(messages.output()).toBe('Final answer');
  });

  it('preserves legacy unphased and commentary-only output', () => {
    const legacy = new CodexAgentMessageAccumulator();
    legacy.appendDelta({ delta: 'legacy body' });
    expect(legacy.output()).toBe('legacy body');

    const commentaryOnly = new CodexAgentMessageAccumulator();
    commentaryOnly.rememberItem({ id: 'comment-1', type: 'agentMessage', phase: 'commentary' });
    commentaryOnly.appendDelta({ itemId: 'comment-1', delta: 'partial work' });
    expect(commentaryOnly.output()).toBe('partial work');
  });
});

describe('local_agents/backends/codex › structured work items', () => {
  it('maps MCP and background-agent items onto visible tool lifecycle events', () => {
    expect(mapCodexItemToolEvent({
      id: 'mcp-1',
      type: 'mcpToolCall',
      server: 'browser',
      tool: 'navigate',
      arguments: { url: 'https://example.com' },
    }, 'use')).toEqual({
      type: 'tool-event',
      tool: 'browser.navigate',
      callId: 'mcp-1',
      phase: 'use',
      input: { url: 'https://example.com' },
    });
    expect(mapCodexItemToolEvent({
      id: 'agent-1',
      type: 'subAgentActivity',
      kind: 'completed',
    }, 'result')).toEqual({
      type: 'tool-event',
      tool: 'background_agent',
      callId: 'agent-1',
      phase: 'result',
      output: 'completed',
    });
  });

  it('does not remap text and command items handled by dedicated paths', () => {
    expect(mapCodexItemToolEvent({ type: 'agentMessage' }, 'use')).toBeNull();
    expect(mapCodexItemToolEvent({ type: 'commandExecution' }, 'result')).toBeNull();
  });

  it.each([
    {
      name: 'dynamic tool',
      raw: {
        id: 'dynamic-1',
        type: 'dynamicToolCall',
        namespace: 'design',
        tool: 'render',
        arguments: { page: 2 },
        contentItems: [{ type: 'text', text: 'rendered' }],
      },
      tool: 'design.render',
      input: { page: 2 },
      output: [{ type: 'text', text: 'rendered' }],
    },
    {
      name: 'collaboration tool',
      raw: {
        id: 'collab-1',
        type: 'collabAgentToolCall',
        tool: 'spawn_agent',
        receiverThreadIds: ['thread-a', 'thread-b'],
        prompt: 'inspect the parser',
        agentsStates: { 'thread-a': 'completed' },
      },
      tool: 'collaboration:spawn_agent',
      input: { receiverCount: 2, prompt: 'inspect the parser' },
      output: { 'thread-a': 'completed' },
    },
    {
      name: 'web search',
      raw: {
        id: 'search-1',
        type: 'webSearch',
        query: 'protocol docs',
        results: [{ title: 'Docs' }],
      },
      tool: 'web_search',
      input: { query: 'protocol docs' },
      output: [{ title: 'Docs' }],
    },
    {
      name: 'image view',
      raw: {
        id: 'image-1',
        type: 'imageView',
        path: '/tmp/screenshot.png',
        status: 'completed',
      },
      tool: 'view_image',
      input: { path: '/tmp/screenshot.png' },
      output: 'completed',
    },
    {
      name: 'image generation',
      raw: {
        id: 'generation-1',
        type: 'imageGeneration',
        prompt: 'a blue square',
        result: { path: '/tmp/generated.png' },
      },
      tool: 'image_generation',
      input: { prompt: 'a blue square' },
      output: { path: '/tmp/generated.png' },
    },
    {
      name: 'background wait',
      raw: {
        id: 'sleep-1',
        type: 'sleep',
        durationMs: 250,
        status: 'completed',
      },
      tool: 'background_wait',
      input: { durationMs: 250 },
      output: 'completed',
    },
    {
      name: 'context compaction',
      raw: {
        id: 'compact-1',
        type: 'contextCompaction',
        status: 'completed',
      },
      tool: 'context_compaction',
      input: {},
      output: 'completed',
    },
  ])('maps $name start and completion payloads', ({ raw, tool, input, output }) => {
    expect(mapCodexItemToolEvent(raw, 'use')).toEqual({
      type: 'tool-event',
      tool,
      callId: raw.id,
      phase: 'use',
      input,
    });
    expect(mapCodexItemToolEvent(raw, 'result')).toEqual({
      type: 'tool-event',
      tool,
      callId: raw.id,
      phase: 'result',
      output,
    });
  });
});

describe('local_agents/backends/codex › extractThreadId', () => {
  it('returns top-level threadId when present', () => {
    expect(extractThreadId({ threadId: 'th-1', other: 1 })).toBe('th-1');
  });

  it('falls back to nested .thread.id', () => {
    expect(extractThreadId({ thread: { id: 'th-2' } })).toBe('th-2');
  });

  it('returns undefined for missing / malformed input', () => {
    expect(extractThreadId(null)).toBeUndefined();
    expect(extractThreadId(undefined)).toBeUndefined();
    expect(extractThreadId({})).toBeUndefined();
    expect(extractThreadId({ threadId: '' })).toBeUndefined();
    expect(extractThreadId({ threadId: 42 as any })).toBeUndefined();
    expect(extractThreadId({ thread: { id: 0 as any } })).toBeUndefined();
  });

  it('prefers top-level over nested when both present', () => {
    expect(extractThreadId({ threadId: 'top', thread: { id: 'nested' } })).toBe('top');
  });
});

describe('local_agents/backends/codex › extractCodexUsage', () => {
  it('pulls usage from a flat snake_case params block', () => {
    const u = extractCodexUsage({
      threadId: 't1',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
    });
    expect(u).toEqual({ input: 100, output: 50, cacheRead: 30 });
  });

  it('pulls usage from camelCase variants codex sometimes emits', () => {
    const u = extractCodexUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 12,
      model: 'gpt-5',
    });
    expect(u).toEqual({
      input: 100, output: 50, cacheRead: 30, cacheCreate: 12, model: 'gpt-5',
    });
  });

  it('reads from params.info.totalTokenUsage nested shape', () => {
    const u = extractCodexUsage({
      info: {
        model: 'gpt-5',
        totalTokenUsage: {
          input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3,
        },
      },
    });
    expect(u).toMatchObject({ input: 1, output: 2, cacheRead: 3, model: 'gpt-5' });
  });

  it('falls back to lastTokenUsage when totalTokenUsage is absent', () => {
    const u = extractCodexUsage({
      info: { lastTokenUsage: { input_tokens: 9, output_tokens: 8 } },
    });
    expect(u).toMatchObject({ input: 9, output: 8 });
  });

  it('returns undefined when no recognizable numeric fields are present', () => {
    expect(extractCodexUsage({})).toBeUndefined();
    expect(extractCodexUsage({ usage: { unknownKey: 'foo' } })).toBeUndefined();
    expect(extractCodexUsage(null)).toBeUndefined();
  });
});

describe('local_agents/backends/codex › trusted local permissions', () => {
  it('starts threads without sandbox approval prompts', () => {
    expect(buildCodexThreadPermissionOverrides()).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('starts turns with full-access sandbox policy', () => {
    expect(buildCodexTurnPermissionOverrides('/tmp/project')).toEqual({
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('omits CLI-owned defaults and sends only explicit per-Agent turn overrides', () => {
    expect(buildCodexTurnRuntimeOverrides({})).toEqual({});
    expect(buildCodexTurnRuntimeOverrides({
      modelOverride: 'gpt-5.4',
      thinkingLevel: 'high',
    })).toEqual({ model: 'gpt-5.4', effort: 'high' });
  });
});

describe('local_agents/backends/codex › resume recovery prompt', () => {
  const input = {
    prompt: 'current task only',
    resumeSessionId: 'thread-old',
    resumeFallbackPrompt: 'bounded recovery\n\ncurrent task only',
  };

  it('keeps the current-turn delta when native resume succeeds', () => {
    expect(selectCodexTurnPrompt(input, true)).toBe('current task only');
  });

  it('uses bounded recovery when native resume falls back to a fresh thread', () => {
    expect(selectCodexTurnPrompt(input, false)).toBe('bounded recovery\n\ncurrent task only');
  });

  it('does not add recovery to an intentionally fresh run', () => {
    expect(selectCodexTurnPrompt({
      prompt: 'fresh task',
      resumeFallbackPrompt: 'unused recovery',
    }, false)).toBe('fresh task');
  });
});

describe('local_agents/backends/codex › extractCodexDiffFiles', () => {
  it('extracts changed files from a unified git diff', () => {
    const files = extractCodexDiffFiles([
      'diff --git a/app/index.html b/app/index.html',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/app/index.html',
      '@@ -0,0 +1 @@',
      '+<html></html>',
      'diff --git a/app/script.js b/app/script.js',
      'index 1111111..2222222 100644',
      '--- a/app/script.js',
      '+++ b/app/script.js',
    ].join('\n'));
    expect(files).toEqual(['app/index.html', 'app/script.js']);
  });

  it('ignores empty or /dev/null paths', () => {
    expect(extractCodexDiffFiles('--- /dev/null\n+++ /dev/null')).toEqual([]);
  });

  it('does not treat deleted files as produced files', () => {
    const files = extractCodexDiffFiles([
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
    ].join('\n'));
    expect(files).toEqual(['new.txt']);
  });
});
