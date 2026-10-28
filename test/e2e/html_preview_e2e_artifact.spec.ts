import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

test('creates an app and previews its ID with a working host bridge and no workspace copy', async ({ sdkOrkas: orkas }, info) => {
  const workspaceEntry = orkas.createWorkspaceFile('preview-artifact/placeholder.txt', 'Workspace remains separate.');
  const result = await orkas.electronApp!.evaluate(async (_, args) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const { createLocalTools } = req(`${args.pcRoot}/src/main/model/core-agent/local-tools.ts`);
    const { getActiveUserId } = req(`${args.pcRoot}/src/main/features/users.ts`);
    const artifacts = req(`${args.pcRoot}/src/main/features/chat_artifacts.ts`);
    const fs = req('node:fs');
    const path = req('node:path');
    const uid = getActiveUserId();
    const cid = 'artifact-preview-e2e';
    let artifactId = '';
    const tools = createLocalTools({ userId: uid, cid,
      onArtifactCreated: (artifact: { id: string }) => { artifactId = artifact.id; } });
    const context = { workingDir: path.dirname(args.workspaceEntry), state: {} };
    const created = await tools.find((t: any) => t.name === 'create_artifact').execute({
      files: [{ path: 'index.html', content: `<!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font:18px sans-serif;padding:24px;color:#173453;background:#f2f6fc}
        button{font:inherit;padding:12px;background:#173453;color:white}
        button:focus-visible{outline:3px solid #d24f00;outline-offset:3px}</style>
        <h1>Artifact preview</h1><p id="status">Ready</p><button id="send">Send update</button>
        <script src="__orkas/bridge.js"></script><script>
        document.getElementById('send').onclick=()=>{
          window.orkasArtifact.send('Preview checked');
          document.getElementById('status').textContent='Bridge worked';
        };</script>` }],
    }, context);
    const entry = artifacts.resolveArtifactFilePath(uid, cid, artifactId, 'index.html');
    const before = entry.ok ? fs.readFileSync(entry.absPath, 'utf8') : '';
    const preview = await tools.find((t: any) => t.name === 'html_preview').execute({
      artifact_id: artifactId, target: 'responsive', screenshots: true,
    }, context);
    const other = createLocalTools({ userId: uid, cid: 'other-conversation' });
    const rejected = await other.find((t: any) => t.name === 'html_preview').execute({ artifact_id: artifactId }, context);
    return { createdError: created.isError, artifactId, preview, rejected,
      sourceUnchanged: entry.ok && fs.readFileSync(entry.absPath, 'utf8') === before,
      workspaceCopy: fs.existsSync(path.join(context.workingDir, 'index.html')),
      bridgeOnDisk: entry.ok && fs.existsSync(path.join(path.dirname(entry.absPath), '__orkas', 'bridge.js')) };
  }, { pcRoot: path.resolve(__dirname, '../..'), workspaceEntry });
  writeFileSync(info.outputPath('artifact-preview.json'), JSON.stringify({ ...result,
    preview: { ...result.preview, images: undefined } }, null, 2));
  expect(result.createdError).toBeUndefined();
  expect(result.preview.isError, result.preview.content).toBeUndefined();
  const evidence = JSON.parse(result.preview.content);
  expect(evidence).toMatchObject({ ok: true, artifact_id: result.artifactId, blockedResourceCount: 0 });
  expect(evidence).not.toHaveProperty('entryPath');
  expect(evidence.interactions.artifactMessagesObserved).toBeGreaterThan(0);
  expect(evidence.interactions.stateChangesObserved).toBeGreaterThan(0);
  expect(result.preview.images).toHaveLength(2);
  result.preview.images.forEach((image: { data: string }, index: number) =>
    writeFileSync(info.outputPath(`artifact-${index}.webp`), Buffer.from(image.data, 'base64')));
  expect(result.rejected.isError).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.workspaceCopy).toBe(false);
  expect(result.bridgeOnDisk).toBe(false);
});
