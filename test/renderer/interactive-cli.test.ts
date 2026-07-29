import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type InteractiveCliExports = {
  _iclEsc: (value: unknown) => string;
  _iclHandleEvent: (payload: Record<string, unknown>) => void;
  _iclLooksLikeInteractiveAuthUrl: (url: string) => boolean;
  _iclOutputAsksForBrowserAction: (text: string) => boolean;
  _iclSendInput: (
    session: Record<string, unknown>,
    input: { value: string; disabled: boolean },
    send: { disabled: boolean },
  ) => Promise<void>;
  _iclShouldRevealForOutput: (
    payload: Record<string, unknown>,
    session: Record<string, unknown>,
  ) => boolean;
  _iclSessionCountForTest: () => number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function loadInteractiveCli(input: {
  userId?: string;
  invoke?: ReturnType<typeof vi.fn>;
  toast?: ReturnType<typeof vi.fn>;
} = {}) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/modules/interactive-cli.js'),
    'utf8',
  );
  const module = { exports: {} as InteractiveCliExports };
  let pushHandler: ((payload: Record<string, unknown>) => void) | null = null;
  const invoke = input.invoke || vi.fn(async () => ({ ok: true }));
  const toast = input.toast || vi.fn();
  const sandbox = {
    module,
    exports: module.exports,
    currentUserId: input.userId || 'account-a',
    createLogger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
    window: {
      orkas: {
        invoke,
        onPushEvent: (_channel: string, handler: typeof pushHandler) => {
          pushHandler = handler;
        },
      },
      uiIconHtml: () => '',
    },
    document: {
      body: {
        contains: () => false,
      },
    },
    uiToast: toast,
    t: (key: string) => key,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'interactive-cli.js' });
  return {
    cli: module.exports,
    invoke,
    toast,
    push: (payload: Record<string, unknown>) => {
      if (!pushHandler) throw new Error('interactive CLI push handler was not registered');
      pushHandler(payload);
    },
  };
}

describe('interactive CLI renderer', () => {
  it('ignores every session event owned by another account', () => {
    const { cli, push } = loadInteractiveCli({ userId: 'account-a' });

    push({
      type: 'started',
      session_id: 'foreign-session',
      user_id: 'account-b',
      status: 'running',
    });

    expect(cli._iclSessionCountForTest()).toBe(0);
  });

  it('accepts a session event only for the active account', () => {
    const { cli, push } = loadInteractiveCli({ userId: 'account-a' });

    push({
      type: 'started',
      session_id: 'own-session',
      user_id: 'account-a',
      status: 'running',
    });

    expect(cli._iclSessionCountForTest()).toBe(1);
  });

  it('single-flights sensitive input and locks controls while IPC is pending', async () => {
    const gate = deferred<{ ok: boolean }>();
    const invoke = vi.fn(() => gate.promise);
    const { cli } = loadInteractiveCli({ invoke });
    const session = {
      id: 'session-1',
      status: 'running',
      sensitive: true,
      sendPromise: null,
    };
    const input = { value: 'secret-code-42', disabled: false };
    const send = { disabled: false };

    const first = cli._iclSendInput(session, input, send);
    const second = cli._iclSendInput(session, input, send);
    const pendingControls = { input: input.disabled, send: send.disabled };
    gate.resolve({ ok: true });
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('interactiveCli.send', {
      session_id: 'session-1',
      input: 'secret-code-42',
      add_newline: true,
      sensitive: true,
    });
    expect(pendingControls).toEqual({ input: true, send: true });
    expect(input.value).toBe('');
    expect(input.disabled).toBe(false);
    expect(send.disabled).toBe(false);
  });

  it('preserves retryable input and unlocks controls when IPC rejects', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('stdin unavailable');
    });
    const toast = vi.fn();
    const { cli } = loadInteractiveCli({ invoke, toast });
    const session = {
      id: 'session-1',
      status: 'running',
      sensitive: true,
      sendPromise: null,
    };
    const input = { value: 'retry-code', disabled: false };
    const send = { disabled: false };

    await cli._iclSendInput(session, input, send);

    expect(input.value).toBe('retry-code');
    expect(input.disabled).toBe(false);
    expect(send.disabled).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('reveals only actionable browser authorization output', () => {
    const { cli } = loadInteractiveCli();
    const session = {
      status: 'running',
      output: '',
      urls: [
        'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085',
      ],
    };

    expect(cli._iclShouldRevealForOutput({
      text: 'Your browser has been opened to visit the authorization page.',
    }, session)).toBe(true);
    expect(cli._iclShouldRevealForOutput({
      text: 'Downloaded release notes from the URL.',
    }, session)).toBe(false);
    expect(cli._iclLooksLikeInteractiveAuthUrl('javascript:alert(1)')).toBe(false);
  });

  it('escapes CLI-controlled labels before inserting HTML', () => {
    const { cli } = loadInteractiveCli();

    expect(cli._iclEsc('<img src=x onerror=\"boom\">')).toBe(
      '&lt;img src=x onerror=&quot;boom&quot;&gt;',
    );
  });
});
