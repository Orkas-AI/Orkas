// Real wiring for what a conversation produced, end to end.
//
// Two defects this pins, neither reachable from a unit test because both need
// the real IPC + renderer + `chat-app://` stack:
//
//   - a `create_artifact` bundle lives outside the workspace, so no listing saw
//     it and the app existed only inside the bubble that made it;
//   - presentation of generated media depended on the model pasting a
//     `chat-media://` link for its own output, so the same image showed a
//     player in one turn and a bare chip in the next.
//
// The first reply below deliberately does NOT paste a media link; the second
// one does, and must not gain a duplicate underneath it.
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { expect, test } from './fixtures/orkas';

/** A real decodable PNG rather than a pasted blob, so the preview under test
 *  has actual bytes and an intrinsic size. */
function pngBytes(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = 40 + Math.floor((x * 180) / width);
      raw[px + 1] = 90 + Math.floor((y * 120) / height);
      raw[px + 2] = 200;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe.configure({ timeout: 120_000 });

test('surfaces produced files, outside files, and artifacts for one conversation', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const uid = 'account-e2e';
  const chatFile = (cid: string) => path.join(
    orkas.workspaceRoot, uid, 'cloud', 'chats', `${cid}.jsonl`,
  );

  const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
    'conversations.create',
    { title: 'Outputs check' },
  );
  const cid = created.conversation.conversation_id;

  // Opening the conversation is what freezes `state.workspace_dir`, so resolve
  // the scan root only after that — otherwise the seeded files land beside the
  // conversation folder instead of inside it.
  await page.evaluate(async (id) => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  const listing = await orkas.invoke<{ root: string }>('conversations.files.list', { cid });

  const wsDir = path.join(listing.root, 'reports');
  mkdirSync(wsDir, { recursive: true });
  const imagePath = path.join(wsDir, 'cover.png');
  writeFileSync(imagePath, pngBytes(64, 40));
  const notesPath = path.join(wsDir, 'summary.md');
  writeFileSync(notesPath, '# Summary\n');

  // Written somewhere the workspace scan cannot reach.
  const outsideDir = path.join(orkas.root, 'seo-review-20260817');
  mkdirSync(outsideDir, { recursive: true });
  const outsidePath = path.join(outsideDir, 'TARGETS.md');
  writeFileSync(outsidePath, '# Targets\n');

  // A create_artifact bundle in the pool the workspace scan can never reach.
  const artifactId = 'aRtIfAcT00001';
  const artifactDir = path.join(orkas.workspaceRoot, uid, 'cloud', 'chat_artifacts', cid, artifactId);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, 'index.html'),
    '<!doctype html><title>Pricing calculator</title><h1>Pricing calculator</h1>',
  );
  writeFileSync(
    path.join(artifactDir, '__orkas-meta.json'),
    JSON.stringify({
      title: 'Pricing calculator',
      agentId: 'commander',
      createdAt: new Date(0).toISOString(),
    }),
  );

  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_user',
    ts: new Date(Date.now() - 2000).toISOString(),
    from: 'user',
    to: ['commander'],
    text: 'Make the cover and the target list.',
  })}\n${JSON.stringify({
    id: 'm_outputs_reply',
    ts: new Date(Date.now() - 1000).toISOString(),
    from: 'commander',
    to: ['user'],
    text: 'Done. The cover image, a summary, and the target list are ready.',
    produced: [imagePath, notesPath, outsidePath],
    artifacts: [{ id: artifactId, title: 'Pricing calculator', agent_id: 'commander' }],
  })}\n`, 'utf8');

  const reopen = async () => {
    await page.evaluate(async (id) => {
      (window as any).setView('new-chat');
      (window as any).setView('conversation', id);
    }, cid);
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  };
  await reopen();

  const reply = page.locator('#chat-history .chat-message.assistant').last();
  // Every deliverable stays reachable, and the image the reply never embedded
  // is presented by the host.
  await expect(reply.locator('.chat-msg-produced-item')).toHaveCount(3);
  await expect(reply.locator('.chat-msg-produced-media img.chat-md-img')).toHaveCount(1);
  await expect(reply.locator('.chat-artifact-host')).toHaveCount(1);

  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-info-tab]')).toHaveCount(3);
  await expect(panel.locator('[data-info-tab].is-active')).toHaveAttribute('data-info-tab', 'files');
  // Workspace files keep their tree position; the artifact and the stray file
  // get their own sections instead of being hung off the tree root.
  await expect(panel.locator('.conversation-info-dir-name')).toHaveText('reports');
  await expect(panel.locator('.conversation-info-file.is-outside')).toHaveCount(1);
  await expect(panel.locator('.conversation-info-file.is-outside')).toContainText('TARGETS.md');
  await expect(panel.locator('.conversation-info-file[data-artifact-id]')).toHaveCount(1);
  await expect(panel.locator('.conversation-info-file[data-artifact-id]')).toContainText('Pricing calculator');
  // The badge is the user's cue that the turn produced something; an artifact
  // is one of those things.
  await expect(page.locator('#conversation-info-tab-count-files')).toHaveText('4');

  // Opening the artifact from the panel reaches the same frame the bubble uses.
  const artifactPreview = await orkas.openPreview(() => panel.locator('.conversation-info-file[data-artifact-id]').click());
  await expect(artifactPreview.locator('.chat-artifact-viewer.is-open')).toBeVisible();
  await orkas.closePreview(artifactPreview);
  await page.locator('#conversation-info-toggle').click();

  // A reply that embedded the media itself must not gain a second copy.
  const secondImage = path.join(wsDir, 'poster.png');
  writeFileSync(secondImage, pngBytes(64, 40));
  const mediaUrl = `chat-media://local/${
    secondImage.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
  }`;
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_reply_2',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Here is the poster.\n\n![poster](${mediaUrl})`,
    produced: [secondImage],
  })}\n`, 'utf8');
  await reopen();

  const pasted = page.locator('#chat-history .chat-message.assistant').last();
  await expect(pasted.locator('.chat-msg-produced-item')).toHaveCount(1);
  await expect(pasted.locator('img.chat-md-img')).toHaveCount(1);
  await expect(pasted.locator('.chat-msg-produced-media')).toHaveCount(0);

  // Revisit existing files in the body while the footer contains only this
  // reply's new output. The outside file needs the current conversation scope;
  // a custom link label must not replace the filename used to select a viewer.
  const htmlPath = path.join(wsDir, 'previous draft (1).html');
  writeFileSync(htmlPath, '<!doctype html><html><body><h1>Previous draft</h1></body></html>');
  const currentPath = path.join(wsDir, 'revision.txt');
  writeFileSync(currentPath, 'Current revision');
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_existing_files_reply',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Existing references:\n\n[Read the summary](${notesPath}:21)\n\n[Read targets](${outsidePath})\n\n[Open previous draft](<${htmlPath}>)\n\n<span class="file-reference-baseline">正文对齐</span> [正文对齐](${notesPath}:21:5)\n\n[Read relative summary](reports/summary.md#L21)\n\n[Outside relative](<${path.relative(listing.root, outsidePath)}>)\n\n[Missing relative](reports/missing.md)`,
    produced: [currentPath],
  })}\n`, 'utf8');
  await reopen();

  const references = page.locator('#chat-history .chat-message.assistant').last();
  await expect(references.locator('[data-chat-md-file-open="1"]')).toHaveCount(5);
  await expect(references.getByRole('button', { name: 'Outside relative' })).toHaveCount(0);
  await expect(references.getByRole('button', { name: 'Missing relative' })).toHaveCount(0);
  await expect(references).toContainText('TARGETS.md');
  await expect(references).toContainText('missing.md');
  const baselineOffset = await references.evaluate((element) => {
    const textRect = (selector: string) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector(selector)!);
      return range.getBoundingClientRect();
    };
    const prose = textRect('.file-reference-baseline');
    const label = textRect('.file-reference-baseline + .chat-attach-chip .chat-attach-label');
    return Math.abs(prose.bottom - label.bottom);
  });
  expect(baselineOffset).toBeLessThanOrEqual(1);
  await references.screenshot({ path: testInfo.outputPath('inline-file-references.png') });
  await expect(references.locator('.chat-msg-produced-item')).toHaveCount(1);
  await expect(references.locator('.chat-msg-produced-item')).toContainText('revision.txt');
  let preview: import('@playwright/test').Page;
  let viewer: import('@playwright/test').Locator;
  for (const [label, name, content] of [
    ['Read the summary', 'summary.md', 'Summary'],
    ['Read targets', 'TARGETS.md', 'Targets'],
    ['Read relative summary', 'summary.md', 'Summary'],
  ]) {
    preview = await orkas.openPreview(() => references.getByRole('button', { name: label, exact: true }).click());
    viewer = preview.locator('.chat-file-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.chat-file-viewer-title')).toHaveText(name);
    await expect(viewer.locator('.chat-file-viewer-body')).toContainText(content);
    await orkas.closePreview(preview);
  }
  preview = await orkas.openPreview(() => references.getByRole('button', { name: 'Open previous draft', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer.locator('.chat-file-viewer-title')).toHaveText('previous draft (1).html');
  await expect(preview.frameLocator('.chat-file-viewer-html').getByRole('heading', { name: 'Previous draft' })).toBeVisible();
  await orkas.closePreview(preview);

  // A stale reference gives feedback; it neither reopens stale preview content
  // nor adds the missing file to the turn's outputs.
  unlinkSync(notesPath);
  await references.getByRole('button', { name: 'Read the summary', exact: true }).click();
  await expect(page.locator('.ui-toast')).toContainText('no longer exists');
  await expect.poll(() => preview.isClosed()).toBe(true);
  await expect(references.locator('.chat-msg-produced-item')).toHaveCount(1);

  writeFileSync(notesPath, '# Restored summary\nFresh contents after recovery.\n');
  preview = await orkas.openPreview(() => references.getByRole('button', { name: 'Read the summary', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer).toHaveClass(/\bis-open\b/);
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('Fresh contents after recovery.');
  await orkas.closePreview(preview);

  // A reference-only reply must stay usable after a full renderer reload,
  // including keyboard activation, without claiming an output for this turn.
  const longLabel = 'Read the previous summary and its detailed supporting notes from the earlier conversation';
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_reference_only_reply',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Here is the existing reference: [${longLabel}](${notesPath})`,
  })}\n`, 'utf8');
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).setView === 'function');
  await reopen();

  const referenceOnly = page.locator('#chat-history .chat-message.assistant').last();
  const card = referenceOnly.getByRole('button', { name: longLabel, exact: true });
  await expect(card).toBeVisible();
  await expect(referenceOnly.locator('.chat-msg-produced')).toHaveCount(0);
  // Long labels remain inside the chip; the full accessible name is retained.
  const label = card.locator('.chat-attach-label');
  await expect(label).toHaveCSS('text-overflow', 'ellipsis');
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await card.focus();
  preview = await orkas.openPreview(() => page.keyboard.press('Enter'));
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer).toHaveClass(/\bis-open\b/);
  await expect(viewer.locator('.chat-file-viewer-title')).toHaveText('summary.md');
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('Fresh contents after recovery.');
  await expect(referenceOnly.locator('.chat-msg-produced')).toHaveCount(0);
});

test('opens code references from the project task selected directory', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const uid = 'account-e2e';
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Code references' });
  const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
    title: 'Review the code', projectId: project.project_id,
  });
  const cid = conversation.conversation_id;
  // Real persisted device selection, outside the app's default workspace.
  // These existing source files have never been recorded as produced outputs.
  const repository = path.join(orkas.root, 'selected repository');
  mkdirSync(repository);
  const runner = path.join(repository, 'runner.ts');
  const bridge = path.join(repository, 'bridge.ts');
  writeFileSync(runner, 'export const assembleAgent = () => "agent ready";\n');
  writeFileSync(bridge, 'export const authorizeCli = () => "cli authorized";\n');
  const selection = path.join(orkas.workspaceRoot, uid, 'local', 'cli-directories', `${cid}.json`);
  mkdirSync(path.dirname(selection), { recursive: true });
  writeFileSync(selection, JSON.stringify({ version: 1, directory: repository, explicit: true }));
  const unavailable = path.join(orkas.root, 'unselected.txt');
  writeFileSync(unavailable, 'Outside the selected task directory');
  const history = path.join(orkas.workspaceRoot, uid, 'cloud', 'projects', project.project_id, 'chats', `${cid}.jsonl`);
  appendFileSync(history, `${JSON.stringify({
    id: 'm_code_reference', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: `按本次运行条件授予。[Agent 组装逻辑](<${runner}:646>)、[CLI 授权逻辑](bridge.ts#L212)\n\n[Unselected file](<${unavailable}>)`,
  })}\n`);
  await page.evaluate(async (id) => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  const reply = page.locator('#chat-history .chat-message.assistant').last();
  let preview: import('@playwright/test').Page;
  let viewer: import('@playwright/test').Locator;
  await expect(reply.getByRole('button', { name: 'Agent 组装逻辑', exact: true })).toBeVisible();
  await reply.screenshot({ path: testInfo.outputPath('coding-file-references.png') });
  for (const [label, name, content] of [
    ['Agent 组装逻辑', 'runner.ts', 'agent ready'],
    ['CLI 授权逻辑', 'bridge.ts', 'cli authorized'],
  ]) {
    preview = await orkas.openPreview(() => reply.getByRole('button', { name: label, exact: true }).click());
    viewer = preview.locator('.chat-file-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.chat-file-viewer-title')).toHaveText(name);
    await expect(viewer.locator('.chat-file-viewer-body')).toContainText(content);
    await expect(reply.locator('.chat-msg-produced')).toHaveCount(0);
    if (name === 'runner.ts') await viewer.screenshot({ path: testInfo.outputPath('coding-file-preview.png') });
    await orkas.closePreview(preview);
  }

  await reply.getByRole('button', { name: 'Unselected file', exact: true }).click();
  const dialog = page.locator('.ui-dialog-overlay:visible');
  await expect(dialog).toContainText('Could not read');
  await expect(page.locator('.ui-toast').filter({ hasText: 'no longer exists' })).toHaveCount(0);
  await dialog.locator('[data-act="cancel"]').click();
  await expect.poll(() => preview.isClosed()).toBe(true);
  preview = await orkas.openPreview(() => reply.getByRole('button', { name: 'Agent 组装逻辑', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('agent ready');
});
