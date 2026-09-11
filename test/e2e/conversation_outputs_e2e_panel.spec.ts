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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

test('surfaces produced files, outside files, and artifacts for one conversation', async ({ orkas }) => {
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
  await panel.locator('.conversation-info-file[data-artifact-id]').click();
  await expect(page.locator('.chat-artifact-viewer.is-open')).toBeVisible();
  await page.locator('.chat-artifact-viewer-close').click();
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
});
