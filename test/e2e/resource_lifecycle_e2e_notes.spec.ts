import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

for (const variant of ['working', 'denied-order', 'memory-only', 'write-only', 'fake-list'] as const) {
  test(`notes completion oracle observes real save/list/reopen: ${variant}`, async ({ sdkOrkas: orkas }, info) => {
    const data = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }],
      access: { read: ['body'], insert: ['body'] } }] };
    const query = `await orkasApp.data.query({table:'notes'${variant === 'denied-order' ? ",order:{field:'createdAt',direction:'desc'}" : ''}})`;
    const entry = orkas.createWorkspaceFile('notes/index.html', `<!doctype html><html><head><script src="/__orkas/sdk.js"></script></head><body>
      <label>Note<textarea></textarea></label><button>Save</button><h2>Notes</h2><ul></ul><p role="status"></p>
      <script>const field=document.querySelector('textarea'),list=document.querySelector('ul');let rows=[];
      async function refresh(){const r=${variant === 'memory-only' ? '{records:rows}' : query};list.replaceChildren();for(const row of r.records){const li=document.createElement('li');li.textContent=row.body;list.append(li);}}
      document.querySelector('button').onclick=async()=>{try{
        ${variant === 'memory-only' || variant === 'fake-list' ? "rows.push({body:field.value});" : "await orkasApp.data.insert({table:'notes',values:{body:field.value},requestId:crypto.randomUUID()});"}
        ${variant === 'fake-list' ? "list.textContent=field.value;" : variant === 'write-only' ? '' : 'await refresh();'}
      }catch(e){document.querySelector('[role=status]').textContent=e.code;}};
      ${variant === 'write-only' || variant === 'fake-list' ? '' : "refresh().catch(e=>document.querySelector('[role=status]').textContent=e.code);"}
      </script></body></html>`);
    orkas.createWorkspaceFile('notes/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data }));
    orkas.createWorkspaceFile('notes/__orkas-meta.json', JSON.stringify({ appType: 'web' }));
    const marker = `Note ${randomUUID()}`;
    const source = await orkas.electronApp!.evaluate(async (_, args) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = req('node:fs'), path = req('node:path');
      const artifacts = req(`${args.root}/src/main/features/chat_artifacts.ts`);
      const chats = req(`${args.root}/src/main/features/chats.ts`);
      const saved = req(`${args.root}/src/main/features/saved_apps.ts`);
      const runtime = req(`${args.root}/src/main/features/web_apps/host.ts`).runtime;
      const uid = req(`${args.root}/src/main/features/users.ts`).getActiveUserId();
      const beforeApps = saved.listSavedApps(uid).map((app: any) => app.id).sort();
      const chat = await chats.createConversation(uid, { title: 'Notes journey calibration' });
      const files = ['index.html', 'orkas-app.json'].map(name => ({ path: name,
        content: fs.readFileSync(path.join(path.dirname(args.entry), name), 'utf8') }));
      const created = await artifacts.createArtifact(uid, chat.conversation_id, 'commander', { appType: 'web', files });
      if (!created.ok) throw new Error('calibration-artifact-create-failed');
      const manifest = JSON.parse(files[1].content);
      const valid = artifacts.resolveArtifactDir(uid, chat.conversation_id, created.artifactId).ok
        && artifacts.readArtifactMeta(uid, chat.conversation_id, created.artifactId)?.appType === 'web'
        && JSON.stringify(manifest.capabilities) === JSON.stringify(['data']) && manifest.data?.tables?.length > 0;
      const observed = { inserts: 0, reads: 0, calls: [] as Array<{ method: string; ok: boolean; code?: string }> };
      const original = runtime.call;
      // Observe successful production calls without fabricating an SDK answer.
      runtime.call = async function (...call: any[]) {
        try {
          const value = await original.apply(this, call);
          if (call[0] === uid && String(call[4]).startsWith('data.')) {
            if (observed.calls.length < 64) observed.calls.push({ method: call[4], ok: true });
            if ((call[4] === 'data.insert' || call[4] === 'data.insertIf') && value?.id) observed.inserts++;
            if (call[4] === 'data.query' && value?.records?.some((row: any) => row.body === args.marker)) observed.reads++;
          }
          return value;
        } catch (error) {
          if (call[0] === uid && String(call[4]).startsWith('data.') && observed.calls.length < 64)
            observed.calls.push({ method: call[4], ok: false, code: (error as any)?.code });
          throw error;
        }
      };
      (globalThis as any).__notesCompletion = { observed, runtime, original, saved, uid, beforeApps };
      return { kind: 'artifact' as const, cid: chat.conversation_id, artifactId: created.artifactId, title: 'Notes', valid };
    }, { root: path.resolve(__dirname, '../..'), entry, marker });
    const evidence = { saved: false, listed: false, reopened: false, commonData: false, status: 'incomplete' };
    const readObservation = () => orkas.electronApp!.evaluate(() => (globalThis as any).__notesCompletion.observed);
    const open = () => orkas.openPreview(() => orkas.page!.evaluate(({ valid: _valid, ...source }) =>
      (window as any).OrkasPreviewWindows.open(source), source));
    let preview: Awaited<ReturnType<typeof open>> | undefined;
    let inventoryPreserved = false;
    try {
      preview = await open();
      let frame = preview.frameLocator('.chat-artifact-viewer-frame');
      await frame.getByRole('textbox', { name: 'Note', exact: true }).fill(marker);
      await frame.getByRole('button', { name: 'Save', exact: true }).click();
      // Negative controls are ordinary UI outcomes, not swallowed test failures.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline
        && !(await frame.getByRole('listitem').filter({ hasText: marker }).isVisible())
        && !(await frame.getByRole('status').textContent())) await preview.waitForTimeout(50);
      if (variant === 'denied-order') await expect(frame.getByRole('status')).toHaveText('E_PERMISSION');
      const first = await readObservation();
      evidence.saved = first.inserts > 0;
      evidence.listed = await frame.getByRole('listitem').filter({ hasText: marker }).isVisible() && first.reads > 0;
      await orkas.closePreview(preview); preview = undefined;
      await orkas.electronApp!.evaluate(async () => { await (globalThis as any).__notesCompletion.runtime.drainData(); });
      if (evidence.saved && evidence.listed) {
        preview = await open();
        frame = preview.frameLocator('.chat-artifact-viewer-frame');
        await expect(frame.getByRole('listitem').filter({ hasText: marker })).toBeVisible();
        evidence.reopened = (await readObservation()).reads > first.reads;
      }
      evidence.commonData = evidence.saved && evidence.listed && evidence.reopened;
      if (evidence.commonData) evidence.status = 'completed';
    } finally {
      try { if (preview && !preview.isClosed()) await orkas.closePreview(preview); }
      finally {
        inventoryPreserved = await orkas.electronApp!.evaluate(async () => {
          const fixture = (globalThis as any).__notesCompletion;
          fixture.runtime.call = fixture.original;
          await fixture.runtime.drainData();
          const unchanged = JSON.stringify(fixture.saved.listSavedApps(fixture.uid).map((app: any) => app.id).sort()) === JSON.stringify(fixture.beforeApps);
          delete (globalThis as any).__notesCompletion;
          return unchanged;
        });
      }
    }
    const observed = { evidence, bundleValid: source.valid, inventoryPreserved,
      accepted: source.valid && inventoryPreserved && evidence.commonData };
    expect(observed.accepted).toBe(variant === 'working');
    writeFileSync(info.outputPath('journey.json'), JSON.stringify(observed, null, 2));
    expect(evidence.commonData).toBe(variant === 'working');
    if (variant === 'working') expect(evidence).toMatchObject({ saved: true, listed: true, reopened: true, status: 'completed' });
    else expect(evidence.status).toBe('incomplete');
    expect(orkas.modelRequests).toHaveLength(0);
  });
}

test('caught SDK failures remain observations and the artifact is delivered in every viewport', async ({ sdkOrkas: orkas }, info) => {
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const toolsModule = req(`${args.root}/src/main/model/core-agent/local-tools.ts`);
    const artifacts = req(`${args.root}/src/main/features/chat_artifacts.ts`);
    const { getActiveUserId } = req(`${args.root}/src/main/features/users.ts`);
    const uid = getActiveUserId(), cid = 'sdk-observation-e2e';
    let artifactId = '';
    const tools = toolsModule.createLocalTools({ userId: uid, cid, onArtifactCreated: (a: any) => { artifactId = a.id; } });
    const files = [{ path: 'index.html', content: `<!doctype html><html><head><script src="/__orkas/sdk.js"></script>
      <style>button:focus-visible{outline:3px solid blue}</style></head><body><button>Update</button><output></output><script>
      const out=document.querySelector('output');document.querySelector('button').onclick=()=>out.textContent='Updated';
      // The defect used to disappear when it occurred outside the first viewport.
      if(innerWidth<500)orkasApp.data.query({table:'notes',order:{field:'createdAt',direction:'desc'}}).catch(e=>out.textContent=e.code);
      </script></body></html>` }, { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['data'],
        data: { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }], access: { read: ['body'], insert: ['body'] } }] } }) }];
    const created = await tools.find((t: any) => t.name === 'create_artifact').execute({ title: 'Editable notes', appType: 'web', files }, { state: {} });
    const dir = artifacts.resolveArtifactDir(uid, cid, artifactId);
    const preview = await tools.find((t: any) => t.name === 'html_preview').execute({ artifact_id: artifactId, target: 'responsive', screenshots: false }, { state: {} });
    return { created, delivered: Boolean(artifactId && dir.ok), preview };
  }, { root: path.resolve(__dirname, '../..') });
  writeFileSync(info.outputPath('observations.json'), JSON.stringify(result, null, 2));
  expect(result.delivered).toBe(true);
  expect(result.created.isError).toBeUndefined();
  expect(result.created.content).toContain('mobile data.query: E_PERMISSION');
  expect(result.created.content).not.toContain('checks passed');
  expect(result.created.content).toContain('not a full functional verification');
  expect(result.preview.isError).toBeUndefined();
  const evidence = JSON.parse(result.preview.content);
  expect(evidence.sdk.calls).toEqual([]);
  expect(evidence.sdkByViewport.find((item: any) => item.viewport === 'mobile').calls).toContainEqual({ method: 'data.query', code: 'E_PERMISSION' });
  expect(evidence.blockers).toEqual([]);
});
