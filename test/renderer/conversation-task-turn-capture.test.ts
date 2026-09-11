import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  // Skip the parameter list first: a default value such as `opts = {}` would
  // otherwise terminate the brace scan before the body starts.
  const parenStart = source.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = source.indexOf('{', i);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`missing body of ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function extractPresentationRegistration(): string {
  const marker = "try {\n  if (window.orkas && typeof window.orkas.onPushEvent === 'function')";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('missing presentation listener registration');
  const end = source.indexOf('} catch (_) {}', start) + '} catch (_) {}'.length;
  return source.slice(start, end);
}

describe('conversation terminal and media presentation', () => {
  it('applies a completed media download only to the active user and conversation', () => {
    const apply = vi.fn();
    const document = {};
    const handler = vm.runInNewContext(
      `(${extractFunction('_conversationMediaHandleMaterialized')})`,
      {
        currentUserId: 'user-1',
        currentCid: 'conversation-1',
        _applyMaterializedMarkdownMedia: apply,
        document,
      },
    );
    const matching = { user_id: 'user-1', conversation_id: 'conversation-1' };

    handler({ ...matching, user_id: 'user-2' });
    handler({ ...matching, conversation_id: 'conversation-2' });
    handler(matching);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(matching, document);
  });

  it('delivers pushed terminal state to failure and unread presentation', () => {
    const syncFailure = vi.fn();
    const handleUnread = vi.fn();
    const presentationHandler = vm.runInNewContext(
      `(${extractFunction('_taskTerminalHandlePresentation')})`,
      {
        _syncFailedFromTaskTerminal: syncFailure,
        _handleTaskTerminalUnread: handleUnread,
      },
    );
    const mediaHandler = vi.fn();
    const pushHandlers: Record<string, (payload: unknown) => void> = {};
    vm.runInNewContext(extractPresentationRegistration(), {
      window: {
        orkas: {
          onPushEvent: vi.fn((channel: string, handler: (payload: unknown) => void) => {
            pushHandlers[channel] = handler;
          }),
        },
      },
      _taskTerminalHandlePresentation: presentationHandler,
      _conversationMediaHandleMaterialized: mediaHandler,
    });
    const terminal = {
      type: 'terminal',
      run_id: 'run-ui-only',
      conversation_id: 'conversation-ui-only',
      status: 'failed',
    };

    expect(Object.keys(pushHandlers).sort()).toEqual([
      'conversation:media_materialized',
      'conversation:task_terminal',
    ]);
    pushHandlers['conversation:task_terminal'](terminal);

    expect(syncFailure).toHaveBeenCalledWith(terminal);
    expect(handleUnread).toHaveBeenCalledWith(terminal);
    const materialized = { conversation_id: 'conversation-ui-only', local_url: 'chat-media://cid/x/y.png' };
    pushHandlers['conversation:media_materialized'](materialized);
    expect(mediaHandler).toHaveBeenCalledWith(materialized);
  });

});
