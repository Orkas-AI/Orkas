import { createServer } from 'node:http';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './fixtures/orkas';

// Real MCP child -> run-local bridge -> real Electron page. No live model or
// external provider: the rendered field/output are independent action evidence.
test('CLI browser operates only its current conversation and rejects foreign tabs and stale authority', async ({ orkas }) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Browser scope fixture</title><label>Display name<input id="draft"></label><button type="button" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Preview</button><output></output><label>Password<input type="password"></label>');
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
    expect((await client.listTools()).tools.some(tool => tool.name === 'browser')).toBe(true);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'browser', arguments: args });
      const data = JSON.parse((result.content as any[])[0].text);
      return { ...data, isError: result.isError === true };
    };
    const opened = await call({ operation: 'open', url: origin + '/current' });
    expect(opened).toMatchObject({ ok: true });
    const tabId = opened.active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    const listed = await call({ operation: 'tabs' });
    expect(listed.tabs.some((tab: any) => tab.tab_id === tabId)).toBe(true);
    expect(listed.tabs.some((tab: any) => tab.tab_id === foreignId)).toBe(false);
    let observed = await call({ operation: 'observe', tab_id: tabId });
    const field = observed.elements.find((element: any) => element.label === 'Display name');
    expect(field).toBeTruthy();
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'Current conversation only' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: field.ref, page_action: 'fill', text: 'Stale mutation' })).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    observed = await call({ operation: 'observe', tab_id: tabId });
    const preview = observed.elements.find((element: any) => element.label === 'Preview');
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: preview.ref, page_action: 'click' })).toMatchObject({ ok: true });
    const output = await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === url)!;
      return page.executeJavaScript('document.querySelector("output").textContent');
    }, origin + '/current');
    expect(output).toBe('Current conversation only');
    observed = await call({ operation: 'observe', tab_id: tabId });
    const password = observed.elements.find((element: any) => element.input_type === 'password');
    expect(await call({ operation: 'act', tab_id: tabId, page_id: observed.page_id, element_ref: password.ref, page_action: 'fill', text: 'fixture' })).toMatchObject({ ok: false, code: 'user_action_required', isError: true });
    for (const input of [
      { operation: 'observe' }, { operation: 'navigate', navigation: 'goto', url: origin + '/forbidden' },
      { operation: 'act', page_id: observed.page_id, element_ref: field.ref, page_action: 'click' },
      { operation: 'wait' }, { operation: 'retain', retention: 'temporary' }, { operation: 'close' },
    ]) expect(await call({ ...input, tab_id: foreignId })).toMatchObject({ ok: false, code: 'unknown_tab', isError: true });
    // Switching the UI does not transfer this CLI's authority to that task.
    await selectTask(otherCid);
    expect(await call({ operation: 'tabs' })).toMatchObject({ ok: false, code: 'task_not_visible', isError: true });
    expect(await call({ operation: 'open', url: origin + '/forbidden' })).toMatchObject({ ok: false, code: 'task_not_visible', isError: true });
    const state = (await orkas.invoke<any>('webAssist.state', {})).state;
    expect(state.tabs.find((tab: any) => tab.tab_id === foreignId).address_url).toBe(origin + '/foreign');
    expect(state.tabs.some((tab: any) => tab.address_url === origin + '/forbidden')).toBe(false);
    await selectTask(cid);
    await orkas.electronApp!.evaluate((_electron, args) => {
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    expect(await call({ operation: 'open', url: origin + '/late' })).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
  } finally {
    await client.close();
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      await (globalThis as any).__cliBrowserTestBridge?.close();
      delete (globalThis as any).__cliBrowserTestBridge;
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'cli-browser-e2e');
    }, { root, cid });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(stderr).toBe('');
  }
});
