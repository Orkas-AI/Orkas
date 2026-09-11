import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { safeLocalCliAuthUrl } from '../../src/main/util/window-security';

type InteractiveCliFunctions = {
  _iclConnectorPrompt: (session: Record<string, unknown>) => { label: string; choices: string[]; selected: number } | null;
  _iclEsc: (value: unknown) => string;
  _iclAutoOpenLocalConnectorAuthUrls: (session: Record<string, unknown>) => void;
  _iclHandleEvent: (payload: Record<string, unknown>) => void;
  _iclRevealSession: (session: Record<string, unknown>) => void;
  _iclLocalConnectorAuthUrl: (url: string) => string | null;
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
  view?: string;
  cid?: string;
  invoke?: ReturnType<typeof vi.fn>;
  toast?: ReturnType<typeof vi.fn>;
} = {}) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/modules/interactive-cli.js'),
    'utf8',
  );
  let pushHandler: ((payload: Record<string, unknown>) => void) | null = null;
  const invoke = input.invoke || vi.fn(async () => ({ ok: true }));
  const toast = input.toast || vi.fn();
  const sandbox = {
    currentUserId: input.userId || 'account-a',
    currentView: input.view || 'conversation',
    currentCid: input.cid || 'conversation-a',
    createLogger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
    window: {
      addEventListener: () => {},
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
    URL,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'interactive-cli.js' });
  return {
    cli: context as typeof context & InteractiveCliFunctions,
    sessionCount: () => vm.runInContext('_interactiveCliSessions.size', context) as number,
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
    const { sessionCount, push } = loadInteractiveCli({ userId: 'account-a' });

    push({
      type: 'started',
      session_id: 'foreign-session',
      user_id: 'account-b',
      status: 'running',
    });

    expect(sessionCount()).toBe(0);
  });

  it('accepts a session event only for the active account', () => {
    const { sessionCount, push } = loadInteractiveCli({ userId: 'account-a' });

    push({
      type: 'started',
      session_id: 'own-session',
      user_id: 'account-a',
      status: 'running',
    });

    expect(sessionCount()).toBe(1);
  });

  it.each([
    ['conversation', undefined],
    ['conversation', ''],
    ['conversation', '   '],
    ['conversation', 'conversation-b'],
    ['new-chat', 'conversation-a'],
    ['connectors', 'conversation-a'],
  ])('never renders terminal output outside its owning task (%s, %s)', (view, conversationId) => {
    const { push } = loadInteractiveCli({ view });
    const base = {
      session_id: 'task-command', user_id: 'account-a', conversation_id: conversationId,
      presentation: 'agent_terminal', purpose: 'Agent command',
    };
    // Any DOM creation throws. Both a prompt and a terminal error must stay out of
    // unrelated pages; the claimed presentation alone is insufficient authority.
    expect(() => {
      push({ ...base, type: 'started', status: 'running' });
      push({ ...base, type: 'waiting_input', prompt_kind: 'secret' });
      push({ ...base, type: 'error', status: 'error', text: 'fixture failure' });
      push({ ...base, type: 'output', status: 'error', text: 'late diagnostic' });
    }).not.toThrow();
  });

  it.each(['browser_auth', 'connector_input'])('does not reveal a second failure panel for %s authorization', (presentation) => {
    const { push } = loadInteractiveCli();
    const base = { session_id: 'connector-failure', user_id: 'account-a', presentation };
    push({ ...base, type: 'started', status: 'running' });
    // DOM creation is deliberately unavailable: a failed connector belongs to the Connect
    // result dialog, even if late output or repeated terminal events arrive afterwards.
    expect(() => {
      push({ ...base, type: 'error', status: 'error' });
      push({ ...base, type: 'output', status: 'error', text: 'A new provider failure' });
      push({ ...base, type: 'error', status: 'error' });
    }).not.toThrow();
  });

  it.each([undefined, 'terminal', 'unknown'])('never grants terminal UI from prompts, URLs or errors with presentation %s', async (presentation) => {
    const { cli, push, invoke } = loadInteractiveCli();
    const session = {
      id: 'unclassified', status: 'running', presentation,
      urls: ['https://login.dingtalk.com/oauth2/device/verify.htm?user_code=DING-42'],
      autoOpenFailed: true,
    };
    expect(cli._iclShouldRevealForOutput({ prompt_kind: 'secret' }, session)).toBe(false);
    // No DOM creation API is provided: any attempt to reveal a card fails this case.
    cli._iclRevealSession(session);
    for (const type of ['started', 'output', 'waiting_input', 'error']) {
      push({ ...session, type, session_id: 'unclassified', user_id: 'account-a',
        agent_id: 'claimed-agent', purpose: 'Agent command', prompt_kind: 'secret',
        text: 'Enter password: https://login.dingtalk.com/oauth2/device/verify.htm?user_code=DING-42',
      });
    }
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
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

  it('does not submit a stale task form after navigation away', async () => {
    const { cli, invoke } = loadInteractiveCli({ view: 'new-chat' });
    const input = { value: 'unsent-draft', disabled: false };
    await cli._iclSendInput({
      id: 'session-a', userId: 'account-a', conversationId: 'conversation-a',
      presentation: 'agent_terminal', status: 'running',
    }, input, { disabled: false });
    expect(invoke).not.toHaveBeenCalled();
    expect(input.value).toBe('unsent-draft');
  });

  it('reveals only actionable browser authorization output', () => {
    const { cli } = loadInteractiveCli();
    const session = {
      presentation: 'agent_terminal',
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

  it('keeps browser-only authorization quiet even when code instructions arrive before the URL', () => {
    const { cli, push, invoke } = loadInteractiveCli();
    const session = { status: 'running', presentation: 'browser_auth', urls: [] };
    expect(cli._iclShouldRevealForOutput({
      prompt_kind: 'auth_code', text: 'Please enter the authorization code in your browser:',
    }, session)).toBe(false);

    const base = { session_id: 'dingtalk-auth', user_id: 'account-a', status: 'running', presentation: 'browser_auth' };
    push({ ...base, type: 'started' });
    push({ ...base, type: 'waiting_input', prompt_kind: 'auth_code', sensitive_hint: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['DingTalk', 'https://login.dingtalk.com/oauth2/device/verify.htm', 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=DING-42'],
    ['WeCom', 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external', 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=WECOM-42'],
    ['Constant Contact', 'https://identity.constantcontact.com/activate', 'https://identity.constantcontact.com/activate?user_code=CODE-42'],
  ])('opens only the complete %s device URL once across repeated polling output', async (_provider, incomplete, url) => {
    const invoke = vi.fn(async () => ({ opened: true }));
    const { push } = loadInteractiveCli({ invoke });
    const base = { session_id: 'dingtalk-auth', user_id: 'account-a', status: 'running', presentation: 'browser_auth' };
    push({ ...base, type: 'started' });
    for (let i = 0; i < 3; i++) {
      push({ ...base, type: 'output', text: `Polling ${i}\n`, urls: [
        incomplete, url,
      ] });
    }
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith('connectors.open_local_cli_auth_url', { url });
  });

  it('keeps the renderer local-auth allow-list in lockstep with main safeLocalCliAuthUrl', () => {
    // The renderer copy only decides what to auto-open and reveal; main is the
    // authority and refuses anything else. A provider added to one table only
    // either never auto-opens or is refused with `local_cli_auth_url_invalid`,
    // so both validators must agree on every accepted and rejected shape.
    const { cli } = loadInteractiveCli();
    const accepted = [
      'https://open.feishu.cn/page/cli?user_code=FEISHU-42',
      'https://open.larksuite.com/page/cli?user_code=LARK-42',
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=FEISHU-42',
      'https://accounts.larksuite.com/oauth/v1/device/verify?flow_id=flow-2&user_code=LARK-42',
      'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=DING-42',
      'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=WECOM-42',
      'https://identity.constantcontact.com/activate?user_code=CODE-42',
      'https://authz.constantcontact.com/activate?user_code=CODE-42',
    ];
    const rejected = [
      'http://open.feishu.cn/page/cli?user_code=CODE',
      'https://open.feishu.cn.evil.test/page/cli?user_code=CODE',
      'https://user@open.feishu.cn/page/cli?user_code=CODE',
      'https://open.feishu.cn:444/page/cli?user_code=CODE',
      'https://open.feishu.cn/page/cli/extra?user_code=CODE',
      'https://open.feishu.cn/page/cli',
      'https://open.feishu.cn/page/cli?user_code=ONE&user_code=TWO',
      'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=CODE',
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow&user_code=%0A',
      'https://open.feishu.cn/page/cli?user_code=CODE#fragment',
      'http://login.dingtalk.com/oauth2/device/verify.htm?user_code=CODE',
      'https://login.dingtalk.com.evil.test/oauth2/device/verify.htm?user_code=CODE',
      'https://user@login.dingtalk.com/oauth2/device/verify.htm?user_code=CODE',
      'https://work.weixin.qq.com/ai/qc/gen?source=other&scode=WECOM-42',
      'https://example.com/activate?user_code=CODE-42',
    ];
    for (const value of accepted) {
      expect(cli._iclLocalConnectorAuthUrl(value), value).toBe(safeLocalCliAuthUrl(value));
      expect(safeLocalCliAuthUrl(value), value).toBe(value);
    }
    for (const value of rejected) {
      expect(cli._iclLocalConnectorAuthUrl(value), value).toBeNull();
      expect(safeLocalCliAuthUrl(value), value).toBeNull();
    }
  });

  it('recognizes official Feishu/Lark routes structurally without exposing fallback UI', () => {
    const { cli } = loadInteractiveCli();
    const session = {
      presentation: 'browser_auth',
      status: 'running',
      output: '',
      urls: ['https://open.feishu.cn/page/cli?user_code=FEISHU-42'],
    };

    expect(cli._iclShouldRevealForOutput({
      text: '在浏览器中打开以下链接进行认证：',
    }, session)).toBe(false);
    expect(cli._iclShouldRevealForOutput({
      text: 'provider output changed completely',
    }, session)).toBe(false);
    expect(cli._iclLocalConnectorAuthUrl(
      'https://accounts.larksuite.com/oauth/v1/device/verify?flow_id=flow-1&user_code=LARK-42',
    )).toBe(
      'https://accounts.larksuite.com/oauth/v1/device/verify?flow_id=flow-1&user_code=LARK-42',
    );

    session.autoOpenFailed = true;
    expect(cli._iclShouldRevealForOutput({ text: 'anything' }, session)).toBe(true);
  });

  it('auto-opens each validated local connector authorization URL only once', async () => {
    const invoke = vi.fn(async () => ({ opened: true }));
    const { cli } = loadInteractiveCli({ invoke });
    const session = {
      presentation: 'browser_auth',
      status: 'running',
      urls: ['https://open.feishu.cn/page/cli?user_code=FEISHU-42'],
    };

    cli._iclAutoOpenLocalConnectorAuthUrls(session);
    cli._iclAutoOpenLocalConnectorAuthUrls(session);

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('connectors.open_local_cli_auth_url', {
      url: 'https://open.feishu.cn/page/cli?user_code=FEISHU-42',
    });
    expect(session).not.toHaveProperty('autoOpenFailed', true);
  });

  it('reveals the local connector fallback only after automatic opening fails', async () => {
    const invoke = vi.fn(async () => ({
      ok: false,
      code: 'local_cli_auth_url_open_failed',
    }));
    const { cli } = loadInteractiveCli({ invoke });
    const session = {
      presentation: 'browser_auth',
      status: 'running',
      output: '',
      urls: ['https://open.feishu.cn/page/cli?user_code=FEISHU-42'],
    };

    expect(cli._iclShouldRevealForOutput({}, session)).toBe(false);
    cli._iclAutoOpenLocalConnectorAuthUrls(session);

    await vi.waitFor(() => expect(session).toHaveProperty('autoOpenFailed', true));
    expect(cli._iclShouldRevealForOutput({}, session)).toBe(true);
  });

  it('does not auto-open local connector authorization look-alikes', async () => {
    const invoke = vi.fn(async () => ({ opened: true }));
    const { cli } = loadInteractiveCli({ invoke });
    const session = {
      presentation: 'browser_auth',
      status: 'running',
      urls: [
        'http://open.feishu.cn/page/cli?user_code=CODE',
        'https://open.feishu.cn.evil.test/page/cli?user_code=CODE',
        'https://open.feishu.cn/page/cli/extra?user_code=CODE',
        'https://open.feishu.cn/page/cli',
        'https://login.dingtalk.com.evil.test/oauth2/device/verify.htm?user_code=CODE',
        'https://login.dingtalk.com/oauth2/device/verify.htm',
        'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=ONE&user_code=TWO',
        'https://work.weixin.qq.com.evil.test/ai/qc/gen?source=wecom_cli_external&scode=CODE',
        'https://work.weixin.qq.com/ai/qc/gen?source=other&scode=CODE',
        'https://work.weixin.qq.com/ai/qc/generate?source=wecom_cli_external&scode=CODE',
        'https://identity.constantcontact.com/activate',
        'https://identity.constantcontact.com.evil.test/activate?user_code=CODE',
      ],
    };

    cli._iclAutoOpenLocalConnectorAuthUrls(session);
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('escapes CLI-controlled labels before inserting HTML', () => {
    const { cli } = loadInteractiveCli();

    expect(cli._iclEsc('<img src=x onerror=\"boom\">')).toBe(
      '&lt;img src=x onerror=&quot;boom&quot;&gt;',
    );
  });

  it('projects the current Inquirer setup question and retires answered questions', () => {
    const { cli } = loadInteractiveCli();
    // Captured from @inquirer/prompts 7.10.1, the ^7 dependency used by Xero 0.0.7,
    // with pipe-backed stdin/stdout. Cursor clearing separates redraws without newlines.
    const prompt = '? Select a Xero organisation:\n❯ First company\n  Second company\n\n↑↓ navigate • ⏎ select\x1b[?25l\x1b[23G';
    const redraw = '\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G';
    expect(cli._iclConnectorPrompt({ output: 'private diagnostic\n? Xero Client ID:\x1b[19G' }))
      .toEqual({ label: 'Xero Client ID:', choices: [], selected: 0 });
    expect(cli._iclConnectorPrompt({ output: prompt + redraw + prompt.replace('❯ First company\n  Second company', '  First company\n❯ Second company') }))
      .toEqual({ label: 'Select a Xero organisation:', choices: ['First company', 'Second company'], selected: 1 });
    expect(cli._iclConnectorPrompt({ output: prompt + redraw + '✔ Select a Xero organisation: Second company\x1b[45G\n\x1b[?25h' })).toBeNull();
  });
});
