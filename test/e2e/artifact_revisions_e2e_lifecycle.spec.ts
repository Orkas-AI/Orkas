import path from 'node:path';
import { expect, test } from './fixtures/orkas';


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
