import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'A0653F11-9F05-4A8B-89CE-0026D809EAFC';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recycle-display-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recycle display preview', () => {
  it('shows skill edit chats as edit conversations and skills as skills', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const paths = await import('../../../../src/main/paths');
    const skillDir = path.join(paths.userCloudRoot(UID), 'skills', 'academic-tutor');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: Academic Tutor\n---\n',
    );

    const { buildRecycleDisplayPreview } = await import('../../../../src/main/features/recycle_bin');
    const items = await buildRecycleDisplayPreview(UID, [
      'cloud/chats/skill/academic-tutor/chat.json',
      'cloud/chats/skill/academic-tutor/chat.jsonl',
      'cloud/sessions/skill-academic-tutor.jsonl',
    ]);

    expect(items).toEqual([
      {
        category: 'edit_conversation',
        id: 'skill:academic-tutor',
        path: 'cloud/chats/skill/academic-tutor/chat.jsonl',
        title: 'Academic Tutor',
      },
    ]);
  });

  it('hides edit chats when their parent skill is deleted', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const paths = await import('../../../../src/main/paths');
    const skillDir = path.join(paths.userCloudRoot(UID), 'skills', 'academic-tutor');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: Academic Tutor\n---\n',
    );

    const { buildRecycleDisplayPreview } = await import('../../../../src/main/features/recycle_bin');
    const items = await buildRecycleDisplayPreview(UID, [
      'cloud/chats/skill/academic-tutor/chat.json',
      'cloud/chats/skill/academic-tutor/chat.jsonl',
      'cloud/sessions/skill-academic-tutor.jsonl',
      'cloud/skills/academic-tutor/SKILL.md',
      'cloud/skills/academic-tutor/references/prompt.md',
    ]);

    expect(items).toEqual([
      {
        category: 'skill',
        id: 'academic-tutor',
        path: 'cloud/skills/academic-tutor/SKILL.md',
        title: 'Academic Tutor',
      },
    ]);
  });

  it('collapses legacy recycle display items for skill edit sessions', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const paths = await import('../../../../src/main/paths');
    const batchId = '2026-06-01T12-15-09-000Z-study-planner';
    const batchDir = path.join(paths.userRecycleDir(UID), batchId);
    await fs.promises.mkdir(batchDir, { recursive: true });
    await fs.promises.writeFile(path.join(batchDir, 'batch.json'), JSON.stringify({
      id: batchId,
      source: 'cloud_sync',
      reason: 'remote_tombstone',
      created_at_ms: Date.UTC(2026, 5, 1, 12, 15, 9),
      expires_at_ms: 0,
      items: [
        { path: 'cloud/skills/study-planner/SKILL.md', size: 1 },
        { path: 'cloud/sessions/skill-study-planner.jsonl', size: 1 },
      ],
      display_items: [
        { category: 'skill', id: 'study-planner', title: 'study-planner', path: 'cloud/skills/study-planner/SKILL.md' },
        { category: 'conversation', id: 'skill-study-planner.jsonl', title: 'skill-study-planner.jsonl', path: 'cloud/sessions/skill-study-planner.jsonl' },
      ],
    }));

    const { listRecycleBatches } = await import('../../../../src/main/features/recycle_bin');
    const [batch] = await listRecycleBatches(UID);
    expect(batch.display_items).toEqual([
      {
        category: 'skill',
        id: 'study-planner',
        path: 'cloud/skills/study-planner/SKILL.md',
        title: 'study-planner',
      },
    ]);
  });

  it('hides supplemental file rows when a legacy recycle batch has a core skill item', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const paths = await import('../../../../src/main/paths');
    const batchId = '2026-06-02T08-00-00-000Z-spec-driven-development';
    const batchDir = path.join(paths.userRecycleDir(UID), batchId);
    await fs.promises.mkdir(batchDir, { recursive: true });
    await fs.promises.writeFile(path.join(batchDir, 'batch.json'), JSON.stringify({
      id: batchId,
      source: 'cloud_sync',
      reason: 'remote_tombstone',
      created_at_ms: Date.UTC(2026, 5, 2, 8, 0, 0),
      expires_at_ms: 0,
      items: [
        { path: 'cloud/skills/spec-driven-development/SKILL.md', size: 1 },
        { path: 'cloud/marketplace/plugins/spec-driven-development/plugin.json', size: 1 },
      ],
      display_items: [
        {
          category: 'skill',
          id: 'spec-driven-development',
          title: 'spec-driven-development',
          path: 'cloud/skills/spec-driven-development/SKILL.md',
        },
        {
          category: 'file',
          id: 'cloud/marketplace/plugins/spec-driven-development/plugin.json',
          title: 'plugin.json',
          path: 'cloud/marketplace/plugins/spec-driven-development/plugin.json',
        },
        {
          category: 'marketplace',
          id: 'cloud/marketplace/plugins/spec-driven-development/marketplace.json',
          title: 'marketplace.json',
          path: 'cloud/marketplace/plugins/spec-driven-development/marketplace.json',
        },
      ],
    }));

    const { listRecycleBatches } = await import('../../../../src/main/features/recycle_bin');
    const [batch] = await listRecycleBatches(UID);
    expect(batch.display_items).toEqual([
      {
        category: 'skill',
        id: 'spec-driven-development',
        path: 'cloud/skills/spec-driven-development/SKILL.md',
        title: 'spec-driven-development',
      },
    ]);
  });
});
