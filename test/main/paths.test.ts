import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// paths.ts has side effects on import (mkdir of top-level skeleton) and
// reads env vars at load time. Each test resets the module graph so we can
// swap WS_ROOT without state bleeding between cases.

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-paths-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('paths › roots', () => {
  it('PC_ROOT points at the OrkasOpen repo root and APP_ROOT aliases it', async () => {
    const p = await import('../../src/main/paths');
    expect(path.basename(p.PC_ROOT)).toBe('OrkasOpen');
    expect(p.APP_ROOT).toBe(p.PC_ROOT);
  });

  it('PROJECT_ROOT is the parent of PC_ROOT', async () => {
    const p = await import('../../src/main/paths');
    expect(p.PROJECT_ROOT).toBe(path.resolve(p.PC_ROOT, '..'));
  });

  it('WS_ROOT honors ORKAS_WORKSPACE_ROOT env var', async () => {
    const p = await import('../../src/main/paths');
    expect(p.WS_ROOT).toBe(tmpDir);
  });
});

describe('paths › top-level (users.json / logs)', () => {
  it('USERS_FILE sits at the data root', async () => {
    const p = await import('../../src/main/paths');
    expect(p.USERS_FILE).toBe(path.join(p.WS_ROOT, 'users.json'));
  });

  it('LOGS_DIR is a top-level sibling', async () => {
    const p = await import('../../src/main/paths');
    expect(p.LOGS_DIR).toBe(path.join(p.WS_ROOT, 'logs'));
  });
});

describe('paths › cloud-synced per-user', () => {
  it('chats / attachments / sessions / contexts / memory land under <uid>/cloud/', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    expect(p.userChatsDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chats'));
    expect(p.userSkillChatDir(uid, 's1')).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chats', 'skill', 's1'));
    expect(p.userAgentChatDir(uid, 'a1')).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chats', 'agent', 'a1'));
    expect(p.groupChatDir(uid, 'c1'))
      .toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chats', 'c1'));
    expect(p.groupChatVisibilityFile(uid, 'c1', 'commander'))
      .toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chats', 'c1', 'visibility', 'commander.jsonl'));
    expect(p.chatAttachmentDir(uid, 'c1'))
      .toBe(path.join(p.WS_ROOT, uid, 'cloud', 'chat_attachments', 'c1'));
    expect(p.userSessionsDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'sessions'));
    expect(p.userContextsDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'contexts'));
    expect(p.userMemoryFile(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'memory', 'MEMORY.md'));
  });

  it('custom agents / skills / preferences land under <uid>/cloud/', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    expect(p.userAgentsDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'agents'));
    expect(p.userSkillsDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'cloud', 'skills'));
    expect(p.userPreferencesFile(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'cloud', 'config', 'preferences.json'));
  });

  it('per-agent layout: spec + meta + evolved skills under agents/<aid>/', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    const aid = 'a1';
    const root = path.join(p.WS_ROOT, uid, 'cloud', 'agents', aid);
    expect(p.agentDir(uid, aid)).toBe(root);
    expect(p.agentDefinitionFile(uid, aid)).toBe(path.join(root, 'agent.json'));
    expect(p.agentMetaDir(uid, aid)).toBe(path.join(root, 'meta'));
    expect(p.agentCompetenceFile(uid, aid)).toBe(path.join(root, 'meta', 'COMPETENCE.md'));
    expect(p.agentStrategiesFile(uid, aid)).toBe(path.join(root, 'meta', 'LEARNING_STRATEGIES.md'));
    expect(p.agentEvolvedSkillsDir(uid, aid)).toBe(path.join(root, 'skills'));
  });

  it('session file path composes by session_id', async () => {
    const p = await import('../../src/main/paths');
    const sid = 'u1-gconv-abc';
    expect(p.userSessionFile('u1', sid))
      .toBe(path.join(p.WS_ROOT, 'u1', 'cloud', 'sessions', `${sid}.jsonl`));
  });
});

describe('paths › local (per-user, not synced)', () => {
  it('auth / web-search / search / test land under <uid>/local/', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    expect(p.userAuthProfilesFile(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'local', 'config', 'auth-profiles.json'));
    expect(p.userWebSearchCache(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'local', 'config', 'web-search-cache.json'));
    expect(p.userSearchDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'local', 'search'));
    expect(p.userContextsIndexPath(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'local', 'search', 'contexts.idx.json'));
    expect(p.userChatsIndexPath(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'local', 'search', 'chats.idx.json'));
    expect(p.userTestDir(uid)).toBe(path.join(p.WS_ROOT, uid, 'local', 'test'));
    expect(p.userWorkspaceConfigFile(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'local', 'workspace.json'));
  });

  it('marketplace install dirs land under <uid>/local/marketplace/', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    const root = path.join(p.WS_ROOT, uid, 'local', 'marketplace');
    expect(p.userMarketplaceDir(uid)).toBe(root);
    expect(p.userMarketplaceAgentsDir(uid)).toBe(path.join(root, 'agents'));
    expect(p.userMarketplaceSkillsDir(uid)).toBe(path.join(root, 'skills'));
    expect(p.userMarketplaceAgentDir(uid, 'a1')).toBe(path.join(root, 'agents', 'a1'));
    expect(p.userMarketplaceSkillDir(uid, 's1')).toBe(path.join(root, 'skills', 's1'));
  });

  it('marketplace cloud-sync manifest lands under <uid>/cloud/marketplace/installs.json', async () => {
    const p = await import('../../src/main/paths');
    const uid = 'u1';
    expect(p.userMarketplaceInstallsFile(uid))
      .toBe(path.join(p.WS_ROOT, uid, 'cloud', 'marketplace', 'installs.json'));
  });
});

describe('paths › ensureTopLevelLayout side effect', () => {
  it('mkdirs the top-level skeleton on import (no uid-specific dirs)', async () => {
    await import('../../src/main/paths');
    expect(fs.existsSync(path.join(tmpDir, 'logs')), 'expected logs/ to exist').toBe(true);
    // Crucially: no `config/` at the top level any more — that was legacy.
    expect(fs.existsSync(path.join(tmpDir, 'config'))).toBe(false);
    // And no `shared/` — folded into `<uid>/cloud/`.
    expect(fs.existsSync(path.join(tmpDir, 'shared'))).toBe(false);
    // And no `builtin/` — pre-marketplace tree is retired.
    expect(fs.existsSync(path.join(tmpDir, 'builtin'))).toBe(false);
  });

  it('ensureUserLayout is idempotent + builds both cloud and local subtrees', async () => {
    const p = await import('../../src/main/paths');
    expect(() => p.ensureUserLayout('u1')).not.toThrow();
    expect(() => p.ensureUserLayout('u1')).not.toThrow();
    for (const d of [
      path.join(tmpDir, 'u1', 'cloud', 'chats'),
      path.join(tmpDir, 'u1', 'cloud', 'sessions'),
      path.join(tmpDir, 'u1', 'cloud', 'config'),
      path.join(tmpDir, 'u1', 'local', 'config'),
      path.join(tmpDir, 'u1', 'local', 'search'),
      path.join(tmpDir, 'u1', 'local', 'test'),
    ]) {
      expect(fs.existsSync(d), `expected ${d} to exist`).toBe(true);
    }
    // contexts_tmp/ is retired — ensureUserLayout sweeps it on every
    // activate; assert it is NOT present after layout init.
    expect(fs.existsSync(path.join(tmpDir, 'u1', 'local', 'contexts_tmp'))).toBe(false);
  });
});
