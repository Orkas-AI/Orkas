import { createServer } from 'node:http';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './fixtures/orkas';

// Native executor and real MCP child -> run-local bridge -> real Electron page.
// Local HTTP receipts and rendered responses prove submission without a model.
test('native and CLI browsers submit ordinary forms once while protecting sensitive actions and task scope', async ({ orkas }) => {
  const submissions: string[] = [];
  let protectedRequests = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/submit') submissions.push(body);
        else protectedRequests += 1;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`Received: ${body}`);
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>Browser scope fixture</title>
      <form id="question"><label>Question<input id="draft"></label><button>发送</button></form>
      <p id="answer" role="status"></p>
      <label>Extra field<input id="conditional" form="question"></label>
      <form id="credentials"><button>Continue</button></form>
      <label>Password<input id="password" type="password" form="credentials" value="fixture-private-value"></label>
      <button id="purchase" type="button">Confirm payment</button>
      <label>Attachment<input id="upload" type="file"></label>
      <script>
        window.protectedActions = 0;
        document.querySelector('#question').addEventListener('submit', async event => {
          event.preventDefault();
          const response = await fetch('/submit', { method: 'POST', body: document.querySelector('#draft').value, signal: AbortSignal.timeout(5000) });
          document.querySelector('#answer').textContent = await response.text();
        });
        document.querySelector('#credentials').addEventListener('submit', event => {
          event.preventDefault();
          window.protectedActions++;
          void fetch('/protected', { method: 'POST', body: 'unexpected', signal: AbortSignal.timeout(5000) });
        });
        for (const id of ['purchase', 'upload']) document.getElementById(id).addEventListener('click', () => { window.protectedActions++; });
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = path.resolve(__dirname, '../../');
  const client = new Client({ name: 'browser-scope-test', version: '1' });
  let stderr = '';
  const createTask = async (title: string) => (await orkas.invoke<any>('conversations.create', { title })).conversation.conversation_id as string;
  const selectTask = async (cid: string) => orkas.page!.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
    (window as any).ConversationInfo.openAndSetTab('browser');
  }, cid);
  const cid = await createTask('CLI current browser');
  const otherCid = await createTask('Other conversation browser');
  try {
    await selectTask(otherCid);
    const foreign = await orkas.invoke<any>('webAssist.open', { conversationId: otherCid, url: origin + '/foreign' });
    expect(foreign.ok).toBe(true);
    const foreignId = foreign.state.active_tab_id;
    await selectTask(cid);
    const env = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const require = (process as any).mainModule.require;
      // The production groupChat entry binds its sender before dispatch.
      require(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      require(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
      (globalThis as any).__nativeBrowserTestTool = require(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
      const bridge = await require(args.root + '/src/main/features/local_agents/bridge.ts').startBridge({
        uid: 'account-e2e', cid: args.cid, agentId: 'browser-cli', agentName: 'Browser CLI', cli: 'codex',
        permissionPolicy: 'ask', currentMessageId: 'fixture-message', runId: 'cli-browser-e2e',
        configDir: args.configDir,
        sandboxEnv: { ORKAS_PC_DIR: args.root, ORKAS_NODE: args.node, ORKAS_BUNDLED_NODE: args.node, ORKAS_WORKSPACE_ROOT: args.workspace },
      });
      (globalThis as any).__cliBrowserTestBridge = bridge;
      return bridge.serverEnv;
    }, { root, cid, node: process.execPath, configDir: path.join(orkas.root, 'browser-bridge'), workspace: orkas.workspaceRoot });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/orkas-bridge.cjs')], env, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === 'inner_browser')).toBe(true);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'inner_browser', arguments: args });
      const data = JSON.parse((result.content as any[])[0].text);
      return { ...data, isError: result.isError === true };
    };
    const nativeCall = async (args: Record<string, unknown>) => orkas.electronApp!.evaluate(async (_electron, input) => {
      const result = await (globalThis as any).__nativeBrowserTestTool.execute(input, { state: {} });
      return { ...JSON.parse(result.content), isError: result.isError === true };
    }, args);
    const opened = await call({ operation: 'open', url: origin + '/current' });
    expect(opened).toMatchObject({ ok: true });
    const tabId = opened.active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    const listed = await call({ operation: 'tabs' });
    expect(listed.tabs.some((tab: any) => tab.tab_id === tabId)).toBe(true);
    expect(listed.tabs.some((tab: any) => tab.tab_id === foreignId)).toBe(false);
    let observed = await call({ operation: 'observe', tab_id: tabId });
    const field = observed.elements.find((element: any) => element.label === 'Question');
    expect(field).toBeTruthy();
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'orkas' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'Stale mutation' })).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    const readPageState = () => orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url)!;
      return page.executeJavaScript(`({ answer: document.querySelector('#answer').textContent, password: document.querySelector('#password').value, protectedActions: window.protectedActions })`);
    }, origin + '/current');
    let expectedSubmissions = 0;
    for (const [lane, submitCall] of [['CLI', call], ['native', nativeCall]] as const) {
      await test.step(`${lane}: ordinary submission, duplicate rejection, sensitive handoff and recovery`, async () => {
        observed = await submitCall({ operation: 'observe', tab_id: tabId });
        expect(JSON.stringify(observed)).not.toContain('fixture-private-value');
        const send = observed.elements.find((element: any) => element.label === '发送');
        expect(send).toMatchObject({ input_type: 'submit', requires_user_action: false });
        const click = { operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: send.ref, page_action: 'click' };

        // An externally associated field changes after observation; button refs
        // and labels stay valid, so execution must recheck its actual form.
        await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
          await webContents.getAllWebContents().find(contents => contents.getURL() === url)!
            .executeJavaScript("document.querySelector('#conditional').type = 'password'");
        }, origin + '/current');
        expect(await submitCall(click)).toMatchObject({ ok: false, code: 'user_action_required', reason: 'sensitive_form_submission', isError: true });
        expect(submissions).toHaveLength(expectedSubmissions);

        await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
          await webContents.getAllWebContents().find(contents => contents.getURL() === url)!
            .executeJavaScript("document.querySelector('#conditional').type = 'text'");
        }, origin + '/current');
        observed = await submitCall({ operation: 'observe', tab_id: tabId });
        const freshSend = observed.elements.find((element: any) => element.label === '发送');
        expect(freshSend.requires_user_action).toBe(false);
        const freshClick = { ...click, page_id: observed.page_id, element_ref: freshSend.ref };
        expect(await submitCall(freshClick)).toMatchObject({ ok: true, outcome: 'acted', isError: false });
        expect(await submitCall(freshClick)).toMatchObject({ ok: false, code: 'stale_page', isError: true });
        expectedSubmissions += 1;
        await expect.poll(() => submissions.length).toBe(expectedSubmissions);
        expect(submissions).toEqual(Array(expectedSubmissions).fill('orkas'));
        expect(await submitCall({ operation: 'wait', tab_id: tabId, wait_condition: 'text', text: 'Received: orkas' })).toMatchObject({ ok: true });
        observed = await submitCall({ operation: 'observe', tab_id: tabId });
        expect(observed.text).toContain('Received: orkas');

        for (const [label, action, reason] of [
          ['Password', 'fill', 'sensitive_input'],
          ['Continue', 'click', 'sensitive_form_submission'],
          ['Confirm payment', 'click', 'high_impact_action'],
          ['Attachment', 'click', 'file_upload'],
        ] as const) {
          const control = observed.elements.find((element: any) => element.label === label);
          expect(control, label).toMatchObject({ requires_user_action: true });
          const handback = submitCall({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: control.ref, page_action: action, ...(action === 'fill' ? { text: 'must-not-be-written' } : {}) });
          // A high-impact control is the one handback the user may answer, so
          // the host asks before it refuses. Denied here: the model is left with
          // exactly the handback it would have had, and nothing ran.
          if (reason === 'high_impact_action') {
            const confirmation = orkas.page!.locator('.bash-permission-dialog');
            await expect(confirmation).toBeVisible();
            await confirmation.locator('[data-act="cancel"]').click();
            await expect(confirmation).toHaveCount(0);
          }
          expect(await handback).toMatchObject({ ok: false, code: 'user_action_required', reason, isError: true });
        }
        expect(await readPageState()).toEqual({ answer: 'Received: orkas', password: 'fixture-private-value', protectedActions: 0 });
        expect(protectedRequests).toBe(0);
        expect(submissions).toHaveLength(expectedSubmissions);
      });
    }
    for (const input of [
      { operation: 'observe' }, { operation: 'navigate', navigation: 'goto', url: origin + '/forbidden' },
      { operation: 'act', page_id: observed.page_id, element_ref: field.ref, page_action: 'click' },
      { operation: 'wait' }, { operation: 'retain', retention: 'temporary' }, { operation: 'close' },
    ]) expect(await call({ ...input, tab_id: foreignId })).toMatchObject({ ok: false, code: 'unknown_tab', isError: true });
    // Switching the UI does not transfer this CLI's authority to that task. It
    // also no longer stops the CLI from driving its own task: the work keeps
    // running in the background, it just lands in its own tabs.
    await selectTask(otherCid);
    const backgroundList = await call({ operation: 'tabs' });
    expect(backgroundList).toMatchObject({ ok: true });
    expect(backgroundList.tabs.some((tab: any) => tab.tab_id === foreignId)).toBe(false);
    expect(await call({ operation: 'open', url: origin + '/forbidden' })).toMatchObject({ ok: true });
    const state = (await orkas.invoke<any>('webAssist.state', {})).state;
    // The task the user is now watching keeps its own page: the background open
    // landed in the CLI's task, never in this one.
    expect(state.tabs.find((tab: any) => tab.tab_id === foreignId).address_url).toBe(origin + '/foreign');
    expect(state.tabs.find((tab: any) => tab.address_url === origin + '/forbidden')?.tab_id)
      .not.toBe(foreignId);
    await selectTask(cid);
    await orkas.electronApp!.evaluate((_electron, args) => {
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    expect(await call({ operation: 'open', url: origin + '/late' })).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
    expect(await nativeCall({ operation: 'open', url: origin + '/late' })).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
    expect(submissions).toEqual(['orkas', 'orkas']);
    expect(protectedRequests).toBe(0);
  } finally {
    await client.close();
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      await (globalThis as any).__cliBrowserTestBridge?.close();
      delete (globalThis as any).__cliBrowserTestBridge;
      delete (globalThis as any).__nativeBrowserTestTool;
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(stderr).toBe('');
  }
});
