import path from 'node:path';
import { openSidebarEntry, expect, test } from './fixtures/orkas';
declare const currentCid: string;


test('a program reads an edit source and delivers one working application that survives reopening', async ({ modelOrkas: orkas }, info) => {
  const page = orkas.page!;
  const source = orkas.createWorkspaceFile('program-app/index.html', '<!doctype html><h1>Original workspace</h1><button onclick="this.textContent=\'Working\'">Try</button>');
  const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: source, title: 'Workspace' });
  expect(saved.ok).toBe(true);
  await openSidebarEntry(page, '#apps-btn');
  const card = page.locator(`.app-card[data-app-id="${saved.id}"]`);
  await card.hover(); await card.locator('[data-app-more]').click();
  await page.locator('.app-row-menu [data-action="edit"]').click();
  await expect(page.locator('#chat-attachments')).toContainText('app-source.md');
  const cid = await page.evaluate(() => currentCid);
  const attachment = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chat_attachments', cid, 'app-source.md');
  let invoked = false;
  orkas.setModelRequestScript((_request, tools) => {
    if (!tools.has('create_artifact')) return { calls: [{ callId: 'load-app', name: 'tool_load', args: { groups: ['workspace.artifact'] } }] };
    if (invoked) return { text: 'Program application delivered.' };
    invoked = true;
    return { calls: [{ callId: 'program-app', name: 'run_program', args: { code: `
      const source = await tools.read_files({ paths: [{ path: ${JSON.stringify(attachment)} }], raw_text: true });
      if (!source.ok) throw Error(source.content);
      const file = JSON.parse(source.content).files[0];
      const parts = file.content.split(/^========== FILE: (.+?) ==========\\s*\\n/m);
      const html = parts[2].split('========== END ==========')[0].replace('Original workspace', 'Image workspace');
      const app = await tools.create_artifact({ title: 'Image workspace', files: [{ path: 'index.html', content: html }] });
      if (!app.ok) throw Error(app.content);
      text('Source transformed and application created.');
    ` } }] };
  });
  await page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]').fill('Keep only the image workspace.');
  await page.locator('#chat-send-btn').click();
  await expect(page.locator('#chat-history .chat-message.assistant')).toContainText('Program application delivered.', { timeout: 60000 });
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const apps = page.locator('#chat-history .chat-artifact-card');
  await expect(apps).toHaveCount(1);
  const frame = page.frameLocator('#chat-history .chat-artifact-card iframe');
  await expect(frame.locator('h1')).toHaveText('Image workspace');
  await frame.getByRole('button', { name: 'Try', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Working', exact: true })).toBeVisible();
  const artifactId = await apps.locator('iframe').getAttribute('data-artifact-id');
  await apps.screenshot({ path: info.outputPath('program-application-delivered.png') });
  await page.reload();
  await page.evaluate(async cid => { await (window as any).loadConversations(); (window as any).setView('conversation', cid); }, cid);
  await expect(apps).toHaveCount(1);
  await expect(apps.locator('iframe')).toHaveAttribute('data-artifact-id', artifactId!);
  await expect(frame.locator('h1')).toHaveText('Image workspace');
  await expect(frame.getByRole('button', { name: 'Try', exact: true })).toBeVisible();
  await apps.screenshot({ path: info.outputPath('program-application-reopened.png') });
});

test('a corrected application keeps one card and its SDK data through reload and explicit save', async ({ orkas }, info) => {
  const page = orkas.page!;
  const state = await orkas.electronApp!.evaluate(async (_electron, input) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const uid = req(input.users).getActiveUserId();
    const task = await req(input.chats).createConversation(uid, { title: 'Correct an application' });
    const cid = task.conversation_id;
    const events: any[] = [];
    const tool = req(input.tools).createLocalTools({ userId: uid, cid, agentId: 'commander',
      onArtifactCreated: (artifact: any) => events.push({ ...artifact, agent_id: 'commander' }),
      artifactInteractionSmoke: async () => ({ ok: events.length > 0, blockers: events.length ? [] : ['fixture runtime issue'] }),
    }).find((candidate: any) => candidate.name === 'create_artifact');
    const files = (title: string) => [
      { path: 'index.html', content: `<!doctype html><html><head><script src="/__orkas/sdk.js"></script></head><body><h1>${title}</h1><button onclick="this.textContent='Working'">Try</button></body></html>` },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
    ];
    const result = await tool.execute({ title: 'Chat', files: files('Draft') }, { state: {} });
    if (result.isError) throw new Error(result.content);
    (globalThis as any).__artifactRevisionFixture = { tool, events, files, uid, cid };
    return { cid, artifact: events[0] };
  }, { users: path.resolve('src/main/features/users.ts'), chats: path.resolve('src/main/features/chats.ts'),
    tools: path.resolve('src/main/model/core-agent/local-tools.ts') });
  const mount = async (artifacts: any[]) => page.evaluate(({ cid, artifacts }) => {
    let host = document.querySelector('#revision-app');
    if (!host) {
      host = document.createElement('div'); host.id = 'revision-app'; host.className = 'chat-bubble';
      host.setAttribute('style', 'width:600px;max-width:100%;container-type:inline-size');
      document.querySelector('#panel-new-chat')!.appendChild(host);
    }
    (window as any).mountMessageArtifacts(host, artifacts, cid);
  }, { cid: state.cid, artifacts });
  await mount([state.artifact]);
  const frame = page.frameLocator('#revision-app iframe');
  await expect(frame.locator('h1')).toHaveText('Draft');
  await frame.locator('body').evaluate(async () => (window as any).orkasApp.storage.set({ key: 'draft', value: 'Keep my data' }));
  const corrected = await orkas.electronApp!.evaluate(async () => {
    const fixture = (globalThis as any).__artifactRevisionFixture;
    const result = await fixture.tool.execute({ artifact_id: fixture.events[0].id, files: fixture.files('Corrected') }, { state: {} });
    if (result.isError) throw new Error(result.content);
    return fixture.events;
  });
  expect(corrected.map((item: any) => item.id)).toEqual([state.artifact.id, state.artifact.id]);
  await mount(corrected);
  await expect(page.locator('#revision-app .chat-artifact-card')).toHaveCount(1);
  await expect(frame.locator('h1')).toHaveText('Corrected');
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'draft' }))).toEqual({ value: 'Keep my data' });
  await frame.getByRole('button', { name: 'Try' }).click();
  await expect(frame.getByRole('button', { name: 'Working' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('corrected-single-app.png') });
  await page.reload();
  await expect(page.locator('#panel-new-chat')).toHaveClass(/active/);
  await mount(corrected);
  await expect(page.locator('#revision-app .chat-artifact-card')).toHaveCount(1);
  await expect(frame.locator('h1')).toHaveText('Corrected');
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'draft' }))).toEqual({ value: 'Keep my data' });
  const saved: any = await orkas.invoke('conversations.artifacts.save', { cid: state.cid, artifactId: state.artifact.id });
  expect(saved.ok).toBe(true);
  const preview = await orkas.openPreview(() => page.evaluate(source => (window as any).OrkasPreviewWindows.open(source),
    { kind: 'app', appId: saved.id, title: 'Chat' }));
  await expect(preview.frameLocator('.saved-app-viewer-frame').locator('h1')).toHaveText('Corrected');
  expect(orkas.modelRequests).toHaveLength(0);
});
