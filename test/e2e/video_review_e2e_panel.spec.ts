import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { expect, test } from './fixtures/orkas';

// Host-owned video review panel (P2): the drawer renders scenes, preview
// evidence, narration audio, and takes straight from production state, and
// its action buttons only prefill the composer. This spec runs the real
// pipeline end to end: a conversation created through the actual composer and
// model, production state seeded on disk exactly where the tool would write
// it, the probe resolving it through the real IPC + workspace mapping, frames
// served over chat-media://local, and the prefill landing in the composer.

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('video review panel', () => {
  test.describe.configure({ timeout: process.platform === 'win32' ? 120_000 : 60_000 });

  test('surfaces production state with scenes, takes, and composer prefill', async ({ modelOrkas }, testInfo) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    const page = modelOrkas.page;

    // 1. A real conversation through the composer + local model.
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Prepare the video review e2e conversation.');
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]'))
      .toBeVisible({ timeout: 30_000 });
    const cid = String(await page.evaluate('currentCid'));
    expect(cid).toMatch(/\w/);
    // The video review toggle stays hidden while no production state exists.
    await expect(page.locator('#video-review-toggle')).toBeHidden();

    // 2. Freeze the conversation workspace slug so the seeded production
    //    lands inside the workspace the panel resolves for this cid.
    const uid = 'account-e2e';
    const convStateFile = path.join(
      modelOrkas.workspaceRoot, uid, 'cloud', 'chats', cid, 'state.json',
    );
    const convState = JSON.parse(readFileSync(convStateFile, 'utf8')) as Record<string, unknown>;
    convState.workspace_dir = 'e2e-video-review';
    writeFileSync(convStateFile, JSON.stringify(convState), 'utf8');

    // 3. Seed the production exactly where the tool would write it.
    const compositionDir = path.join(
      modelOrkas.workspaceRoot, '..', 'userWorkSpace', 'e2e-video-review', 'project', 'composition',
    );
    const previewDir = path.join(compositionDir, 'preview');
    const draftPath = path.join(path.dirname(compositionDir), 'render', 'draft.mp4');
    mkdirSync(previewDir, { recursive: true });
    mkdirSync(path.join(compositionDir, 'assets'), { recursive: true });
    mkdirSync(path.dirname(draftPath), { recursive: true });
    writeFileSync(path.join(compositionDir, 'composition-manifest.json'), JSON.stringify({
      schema_version: 1,
      composition: { id: 'main', width: 1920, height: 1080, duration: 5, fps: 30 },
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 5,
        approved_copy: ['E2E Approved'],
        narration_text: 'Speak once.',
        narration_refs: [],
        source_shots: ['cover'],
        roles: ['title'],
      }],
      audio: { owner: 'none', tracks: [] },
    }), 'utf8');
    const contactSheet = path.join(previewDir, 'contact-sheet.png');
    const coverFrame = path.join(previewDir, '02-cover-mid.png');
    const frozenSheet = path.join(previewDir, 'frozen-take.png');
    writeFileSync(contactSheet, TINY_PNG);
    writeFileSync(coverFrame, TINY_PNG);
    writeFileSync(frozenSheet, TINY_PNG);
    writeFileSync(path.join(compositionDir, 'assets', 'narration.mp3'), Buffer.from('e2e-audio'));
    // The renderer assertion below is about the review surface wiring the
    // host-provided path into its real media flow. Media decoding belongs to
    // the chat file viewer suite, so deterministic bytes are sufficient here.
    writeFileSync(draftPath, Buffer.from('e2e-draft-video'));

    const stateKey = createHash('sha256')
      .update(`${uid}\0${path.resolve(compositionDir)}`)
      .digest('hex')
      .slice(0, 32);
    const gatesDir = path.join(modelOrkas.workspaceRoot, uid, 'local', 'video_studio', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    writeFileSync(path.join(gatesDir, `${stateKey}.json`), JSON.stringify({
      schema_version: 1,
      revision: 3,
      composition_dir: compositionDir,
      task_title: 'A 60-second Orkas product film',
      stage: 'draft_ready',
      plan_approval: { gate: 'B', signature: 'sig', turn_id: 't1', approved_at: 'now' },
      preview: {
        signature: 'full-sig',
        status: 'approved',
        path: contactSheet,
        frame_paths: [coverFrame],
        validation_version: 5,
        turn_id: 't1',
        created_at: 'now',
      },
      narration: {
        status: 'materialized',
        path: path.join(compositionDir, 'assets', 'narration.mp3'),
        measured_duration_sec: 4.2,
        language: 'en',
        speed: 1,
      },
      draft: {
        signature: 'draft-sig',
        status: 'ready',
        path: draftPath,
        validation_version: 5,
        turn_id: 't2',
        created_at: 'now',
      },
      current_candidate: {
        revision_id: 'candidate-e2e-current',
        content_hash: 'hash-current',
        artifacts: {},
        locators: { preview_path: contactSheet },
        runtime_fingerprint: 'fp',
        created_at: '2026-08-03T01:00:00Z',
        last_observed_at: '2026-08-03T02:00:00Z',
        last_observed_op: 'composition.snapshot',
        last_quality_result: { ok: true, observed_at: '2026-08-03T02:00:00Z' },
      },
      candidate_history: [{
        revision_id: 'candidate-e2e-older',
        content_hash: 'hash-older',
        artifacts: {},
        locators: {},
        snapshot: { locators: { preview_path: frozenSheet } },
        runtime_fingerprint: 'fp',
        created_at: '2026-08-03T00:00:00Z',
        last_observed_at: '2026-08-03T00:30:00Z',
        last_observed_op: 'composition.snapshot',
        last_quality_result: { ok: false, error_code: 'E_PREVIEW_QA_BLOCKED', observed_at: '2026-08-03T00:30:00Z' },
      }],
    }), 'utf8');

    // 4. Re-probe (same call the conversation-detail-open hook makes).
    await page.evaluate('VideoReviewPanel.probe(currentCid)');

    // 5. The toggle appears only now, and the drawer renders the production:
    //    what the user asked for, how far it got, then the evidence. The
    //    composition path is an instruction identifier, never a heading.
    await expect(page.locator('#video-review-toggle')).toBeVisible();
    await page.locator('#video-review-toggle').click();
    await expect(page.locator('#video-review-panel')).toBeVisible();
    await expect(page.locator('.video-review-comp-name')).toHaveText('A 60-second Orkas product film');
    await expect(page.locator('.video-review-comp-name')).not.toContainText('project/composition');
    await expect(page.locator('.video-review-step')).toHaveCount(4);
    await expect(page.locator('.video-review-step').nth(1)).toHaveClass(/\bis-done\b/);
    await expect(page.locator('.video-review-step').nth(3)).toHaveClass(/\bis-wait\b/);
    // A standalone final-confirmation stop stores its playable artifact in
    // draft.path; final.path only exists for assembled delivery. Exercise the
    // real IPC + renderer path so a panel cannot say "waiting" while omitting
    // the video the user is meant to review.
    const draftVideo = page.locator('.video-review-final-video');
    await expect(draftVideo).toHaveCount(1);
    await expect(draftVideo).toHaveAttribute('src', /^chat-media:\/\/local\//);
    await expect(draftVideo).toHaveAttribute('src', /draft\.mp4/);
    await draftVideo.click();
    await expect(page.locator('.chat-file-viewer')).toHaveClass(/\bis-open\b/);
    await expect(page.locator('.chat-file-viewer-video')).toHaveAttribute('src', /draft\.mp4/);
    await page.locator('.chat-file-viewer-close').click();
    // Scenes are labelled by position, never by the authoring id (2026-08-06):
    // `cover` / `s2_body` mean nothing to the person watching the video.
    await expect(page.locator('.video-review-scene-id')).toHaveText(/^(Scene|场景|シーン|Cena)\s*1$/);
    await expect(page.locator('.video-review-scene-id')).not.toHaveText('cover');
    await expect(page.locator('.video-review-scene-narration')).toHaveText('Speak once.');
    await expect(page.locator('.video-review-narration audio')).toHaveCount(1);
    await expect(page.locator('.video-review-take')).toHaveCount(0);

    // Scene frames stream over chat-media://local — a broken URL would leave
    // naturalWidth at 0 even though the <img> is "visible".
    await expect.poll(async () => page.locator('.video-review-scene-frame')
      .evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // There is no whole-production frames overview (removed 2026-08-06 by
    // product decision — too many frames); the scene image itself is the
    // entry: clicking expands it into the shared lightbox, and closing
    // returns to the panel untouched.
    await expect(page.locator('.video-review-sheet-img')).toHaveCount(0);
    await expect(page.locator('.video-review-scene-frame')).toHaveClass(/\bis-expandable\b/);
    await page.locator('.video-review-scene-frame').click();
    await expect(page.locator('.chat-lightbox .chat-lightbox-img')).toBeVisible();
    await expect.poll(async () => page.locator('.chat-lightbox .chat-lightbox-img')
      .evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.chat-lightbox')).toBeHidden();
    await expect(page.locator('#video-review-panel')).toBeVisible();

    // 6. Modification entries prefill the composer and never auto-send.
    const messagesBefore = await page.locator('#chat-history .chat-message').count();
    await page.locator('.video-review-scene-actions button').nth(1).click();
    const composer = page.locator('#chat-input');
    // The instruction leads with the position the user just clicked and keeps
    // the authoring id as the handle that binds the edit to the right scene
    // even if positions shift before it is sent.
    await expect(composer).toHaveValue(/(scene|场景|シーン|cena)[^\n]*1/i);
    await expect(composer).toHaveValue(/cover/);
    // The instruction names the video the way the panel titles it, so the user
    // can check what they are about to send against what they clicked.
    await expect(composer).toHaveValue(/A 60-second Orkas product film/);
    await expect(composer).not.toHaveValue(/project\/composition/);
    expect(await page.locator('#chat-history .chat-message').count()).toBe(messagesBefore);

    // 7. A second entry accumulates instead of replacing the first, so one
    // message can carry several changes. The production is already named, so
    // the follow-up line drops the identifier rather than repeating it.
    await page.locator('.video-review-scene-actions button').nth(0).click();
    const merged = await composer.inputValue();
    expect(merged.split('\n').filter((line) => line.trim())).toHaveLength(2);
    expect(merged.match(/A 60-second Orkas product film/g)).toHaveLength(1);
    expect(await page.locator('#chat-history .chat-message').count()).toBe(messagesBefore);

    // No version history and no restore entry point in the panel.
    await expect(page.locator('#video-review-panel')).not.toContainText('candidate-e2e-older');

    await page.screenshot({ path: testInfo.outputPath('video-review-panel.png'), fullPage: false });
  });
});
