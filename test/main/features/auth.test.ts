import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// auth.ts has two layers:
//   - pure helpers (maskKey, FEATURED_PROVIDERS, getConfig, saveConfig)
//   - core-agent integration (listProviders, listModels, saveApiKey,
//     removeCredential, testConnection)
// Per test/README, the integration layer is out of scope for unit tests —
// it requires real provider credentials and network reach. We cover only
// the pure helpers + the local config file IO here.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '99999999';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auth-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  // auth.ts goes through `getActiveUserId()` for every file path, so we
  // must pin an active uid before any dynamic import of auth-related modules.
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auth › maskKey', () => {
  it('returns empty for non-string inputs', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey(null)).toBe('');
    expect(a.maskKey(undefined)).toBe('');
    expect(a.maskKey(123)).toBe('');
    expect(a.maskKey({})).toBe('');
    expect(a.maskKey('')).toBe('');
  });

  it('replaces short keys (≤ 8 chars) entirely with stars', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('abc')).toBe('***');
    expect(a.maskKey('12345678')).toBe('********');
  });

  it('keeps first-4 and last-4 chars for normal-length keys', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
    expect(a.maskKey('1234567890abcdef')).toBe('1234…cdef');
  });

  it('trims surrounding whitespace before masking', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(a.maskKey('  sk-abcdefghijkl  ')).toBe('sk-a…ijkl');
  });
});

describe('auth › FEATURED_PROVIDERS', () => {
  it('lists the curated API-key providers in CATALOG order', async () => {
    const a = await import('../../../src/main/features/auth');
    // Global frontier labs → China mainstream → aggregators. Must match
    // `CATALOG` in provider_catalog.ts (minus `oauthOnly: true` entries).
    expect(a.FEATURED_PROVIDERS).toEqual([
      'anthropic',
      'openai',
      'google',
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-cn',
      'openrouter',
    ]);
    // minimax-portal / minimax-portal-cn are oauthOnly and excluded from
    // the API-key docs list (FEATURED_PROVIDERS). They still appear in
    // CATALOG / VISIBLE_PROVIDERS.
  });
});

describe('auth › multi-profile store (addApiKey / removeCredential / renameProfile)', () => {
  it('addApiKey creates a default-labelled profile for a new provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'sk-first-one-xxxxxxx');
    expect(profileId).toBe('anthropic:default');

    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles).toHaveLength(1);
    expect(anth.profiles[0].label).toBe('default');
    expect(anth.profiles[0].type).toBe('api_key');
    expect(anth.profiles[0].masked).toBe('sk-f…xxxx');
  });

  it('addApiKey generates unique auto-labels when default already exists', async () => {
    const a = await import('../../../src/main/features/auth');
    const r1 = await a.addApiKey('anthropic', 'key-1-xxxxxxxxxxxx');
    const r2 = await a.addApiKey('anthropic', 'key-2-xxxxxxxxxxxx');
    const r3 = await a.addApiKey('anthropic', 'key-3-xxxxxxxxxxxx');
    expect(r1.profileId).toBe('anthropic:default');
    expect(r2.profileId).toBe('anthropic:account2');
    expect(r3.profileId).toBe('anthropic:account3');
  });

  it('concurrent addApiKey for distinct providers persists every profile', async () => {
    // auth-profiles.json is read-modify-written. Today's impl is incidentally
    // safe because both load and save are sync fs calls (no await in the
    // critical section). This test guards against a future refactor to async
    // fs — the moment a real microtask boundary opens between read and write,
    // overlapping calls will silently lose profiles.
    const a = await import('../../../src/main/features/auth');
    const N = 8;
    const providers = Array.from({ length: N }, (_, i) => `prov${i}`);
    await Promise.all(providers.map((p) => a.addApiKey(p, `key-${p}-xxxxxxxx`)));
    const { providers: list } = await a.listProviders();
    const seen = new Set(list.map((p) => p.id));
    for (const p of providers) expect(seen.has(p)).toBe(true);
  });

  it('addApiKey with explicit label sanitises invalid characters', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('openai', 'key-xxxxxxxxxxxx', 'work @home/1');
    expect(profileId).toBe('openai:work--home-1');
  });

  it('removeCredential drops the profile', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'work');
    const res = await a.removeCredential(profileId);
    expect(res.removed).toBe(true);
    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles).toHaveLength(0);
  });

  it('removeCredential on unknown id returns removed=false', async () => {
    const a = await import('../../../src/main/features/auth');
    const res = await a.removeCredential('anthropic:missing');
    expect(res.removed).toBe(false);
  });

  it('renameProfile changes the label and rewrites the profile id', async () => {
    const a = await import('../../../src/main/features/auth');
    const { profileId } = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'old');
    const res = await a.renameProfile(profileId, 'new-name');
    expect(res.profileId).toBe('anthropic:new-name');
    const { providers } = await a.listProviders();
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.profiles.map((p) => p.label)).toEqual(['new-name']);
  });

  it('renameProfile rejects collisions with an existing label', async () => {
    const a = await import('../../../src/main/features/auth');
    const r1 = await a.addApiKey('anthropic', 'k1-xxxxxxxxxxxx', 'one');
    await a.addApiKey('anthropic', 'k2-xxxxxxxxxxxx', 'two');
    await expect(a.renameProfile(r1.profileId, 'two')).rejects.toThrow();
  });
});

describe('auth › listProviders grouping', () => {
  it('returns providers in catalog order regardless of insertion order', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('openai', 'k-xxxxxxxxxxxx');
    await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const { providers } = await a.listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids.indexOf('anthropic')).toBeLessThan(ids.indexOf('openai'));
  });

  it('exposes supportsApiKey / supportsOAuth flags consistent with the catalog', async () => {
    const a = await import('../../../src/main/features/auth');
    const { providers } = await a.listProviders();

    // anthropic — both API-key and OAuth work against the same endpoint.
    const anth = providers.find((p) => p.id === 'anthropic')!;
    expect(anth.supportsApiKey).toBe(true);
    expect(anth.supportsOAuth).toBe(true);
    expect(anth.oauthProvider).toBe('anthropic');

    // openai — API-key only. OAuth lives on the separate `openai-codex`
    // entry since the Codex endpoint is a different API surface.
    const openai = providers.find((p) => p.id === 'openai')!;
    expect(openai.supportsApiKey).toBe(true);
    expect(openai.supportsOAuth).toBe(false);

    // openai-codex — surfaced as its own provider, OAuth only.
    const codex = providers.find((p) => p.id === 'openai-codex');
    expect(codex).toBeTruthy();
    expect(codex!.supportsApiKey).toBe(false);
    expect(codex!.supportsOAuth).toBe(true);
    expect(codex!.oauthProvider).toBe('openai-codex');
  });
});

describe('auth › pickRotationKey', () => {
  it('returns null when no profile is configured', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(await a.pickRotationKey('anthropic')).toBeNull();
  });

  it('picks the profile with oldest lastUsed and bumps it', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('anthropic', 'key-one-xxxxxxxx', 'one');
    await a.addApiKey('anthropic', 'key-two-xxxxxxxx', 'two');

    // First pick: deterministic tie-break by insertion order (both lastUsed=0)
    const first = await a.pickRotationKey('anthropic');
    expect(first).not.toBeNull();
    // Second pick: must be the other profile (its lastUsed is still 0,
    // while the one just used now has a non-zero lastUsed).
    const second = await a.pickRotationKey('anthropic');
    expect(second).not.toBeNull();
    expect(second!.profileId).not.toBe(first!.profileId);

    // Third pick: first is now older again → rotates back.
    const third = await a.pickRotationKey('anthropic');
    expect(third).not.toBeNull();
    expect(third!.profileId).toBe(first!.profileId);
  });
});

describe('auth › entries (priority list)', () => {
  it('listEntries is empty on a fresh store', async () => {
    const a = await import('../../../src/main/features/auth');
    const { entries } = await a.listEntries();
    expect(entries).toEqual([]);
  });

  it('addEntry appends and preserves order', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'key-xxxxxxxxxxxx', 'one');
    const p2 = await a.addApiKey('openai', 'sk-xxxxxxxxxxxx', 'one');
    const r1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p1.profileId });
    const r2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5',            profileId: p2.profileId });
    expect(r1.entryId).toBeTruthy();
    expect(r2.entryId).not.toBe(r1.entryId);

    const { entries } = await a.listEntries();
    expect(entries.map((e) => `${e.provider}:${e.model}`)).toEqual([
      'anthropic:claude-opus-4-5',
      'openai:gpt-5',
    ]);
  });

  it('addEntry is idempotent for the same (provider, model, profileId)', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const r1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    const r2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    expect(r2.entryId).toBe(r1.entryId);
    const { entries } = await a.listEntries();
    expect(entries).toHaveLength(1);
  });

  it('addEntry rejects a profileId belonging to a different provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    await expect(
      a.addEntry({ provider: 'openai', model: 'gpt-5', profileId: p.profileId }),
    ).rejects.toThrow();
  });

  it('removeEntry drops the tuple', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const r = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    const out = await a.removeEntry(r.entryId);
    expect(out.removed).toBe(true);
    expect((await a.listEntries()).entries).toEqual([]);
  });

  it('removeCredential cascades — entries pointing at the dropped profile go away', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    await a.removeCredential(p.profileId);
    expect((await a.listEntries()).entries).toEqual([]);
  });

  it('reorderEntries permutes the list in the order given', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    const q = await a.addApiKey('openai', 'k-xxxxxxxxxxxx');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5',            profileId: q.profileId });

    const res = await a.reorderEntries([e2.entryId, e1.entryId]);
    expect(res.entries.map((e) => e.entryId)).toEqual([e2.entryId, e1.entryId]);
  });

  it('pickChatEntry returns null when entries list is empty', async () => {
    const a = await import('../../../src/main/features/auth');
    await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx'); // credential but no entry
    expect(await a.pickChatEntry()).toBeNull();
  });

  it('pickChatEntry prefers the first entry and rotates within a same-(provider, model) group', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'k-one-xxxxxxxx', 'one');
    const p2 = await a.addApiKey('anthropic', 'k-two-xxxxxxxx', 'two');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p2.profileId });

    const first  = await a.pickChatEntry();
    const second = await a.pickChatEntry();
    const third  = await a.pickChatEntry();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    // Both entry ids must show up — round-robin within the top group.
    const ids = new Set([first!.entryId, second!.entryId]);
    expect(ids).toEqual(new Set([e1.entryId, e2.entryId]));
  });

  it('pickChatEntry falls back to the next group when top group has no usable credential', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('openai', 'k-openai-xxxxxxx');
    const p2 = await a.addApiKey('anthropic', 'k-anthropic-xxxx');
    // Priority: anthropic(bad)/openai(good) — we simulate "bad" by deleting
    // the credential after adding the entry (leaves a dangling entry, which
    // should be skipped, not returned).
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p2.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5',            profileId: p1.profileId });
    // Remove credential p2 directly via removeCredential; since that cascades,
    // it also drops e1. To simulate a dangling entry without cascade, reach
    // into the json file.
    const fs   = await import('node:fs');
    const pathMod = await import('../../../src/main/paths');
    const storePath = pathMod.userAuthProfilesFile(TEST_UID);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    delete store.profiles[p2.profileId];
    fs.writeFileSync(storePath, JSON.stringify(store));

    const pick = await a.pickChatEntry();
    expect(pick).not.toBeNull();
    expect(pick!.entryId).toBe(e2.entryId);
    expect(pick!.provider).toBe('openai');
    // Sanity: e1 is still in the list (we didn't remove the entry, only the credential)
    const { entries } = await a.listEntries();
    expect(entries.map((e) => e.entryId)).toContain(e1.entryId);
  });
});

describe('auth › pickChatEntryGroup + 冷却联动', () => {
  it('单把 key → group 只有 1 个候选', async () => {
    const a = await import('../../../src/main/features/auth');
    const p = await a.addApiKey('anthropic', 'k-only-xxxxxxxx');
    const e = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });

    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e.entryId);
  });

  it('同 (provider, model) 两把 key → 组内按 lastUsed 升序返候选', async () => {
    const a = await import('../../../src/main/features/auth');
    const p1 = await a.addApiKey('anthropic', 'k-1-xxxxxxxxxxx', 'one');
    const p2 = await a.addApiKey('anthropic', 'k-2-xxxxxxxxxxx', 'two');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p2.profileId });

    // Bump e1 first → e2 应该成为 oldest，排在前
    a.bumpEntryLastUsed(e1.entryId);

    const group = await a.pickChatEntryGroup();
    expect(group.map((c) => c.entryId)).toEqual([e2.entryId, e1.entryId]);
  });

  it('冷却中的 profile 在 pickChatEntryGroup 被跳过', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-cold-xxxxxxx', 'cold');
    const p2 = await a.addApiKey('anthropic', 'k-warm-xxxxxxx', 'warm');
    const e1 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p2.profileId });

    // 冷却 p1 —— 组内候选应该只剩 p2
    cd.markCooldown(p1.profileId, 'auth', 'mocked 401');
    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e2.entryId);

    cd._clearAll();
    // 清冷却后 p1 应该重新进入候选
    const group2 = await a.pickChatEntryGroup();
    expect(group2.map((c) => c.entryId).sort()).toEqual([e1.entryId, e2.entryId].sort());
  });

  it('组内全部冷却 → 回落下一组', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-top-xxxxxxxx');
    const p2 = await a.addApiKey('openai',    'k-fallback-xxx');
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p1.profileId });
    const e2 = await a.addEntry({ provider: 'openai',    model: 'gpt-5', profileId: p2.profileId });

    cd.markCooldown(p1.profileId, 'auth', 'cold');
    const group = await a.pickChatEntryGroup();
    expect(group.length).toBe(1);
    expect(group[0].entryId).toBe(e2.entryId);

    cd._clearAll();
  });

  it('addApiKey 成功路径自动清冷却', async () => {
    const a = await import('../../../src/main/features/auth');
    const cd = await import('../../../src/main/model/core-agent/profile-cooldown');
    cd._clearAll();

    const p1 = await a.addApiKey('anthropic', 'k-old-xxxxxxxx', 'rotate-me');
    cd.markCooldown(p1.profileId, 'auth', 'pretend this 401ed');
    expect(cd.isCooledDown(p1.profileId)).toBe(true);

    // 再次 addApiKey（同 provider + label）更新 key → 应当清冷却
    await a.addApiKey('anthropic', 'k-new-xxxxxxxx', 'rotate-me');
    expect(cd.isCooledDown(p1.profileId)).toBe(false);

    cd._clearAll();
  });

  it('bumpEntryLastUsed 对不存在的 entryId 安全无操作', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(() => a.bumpEntryLastUsed('nonexistent')).not.toThrow();
  });
});

describe('auth › hasConfiguredModel', () => {
  it('reports not-configured on a fresh store', async () => {
    const a = await import('../../../src/main/features/auth');
    delete process.env.ANTHROPIC_API_KEY;
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
  });

  it('reports configured once an entry is added', async () => {
    const a = await import('../../../src/main/features/auth');
    delete process.env.ANTHROPIC_API_KEY;
    const p = await a.addApiKey('anthropic', 'k-xxxxxxxxxxxx');
    // Credential alone is not enough — we require an entry in the priority list.
    expect(a.hasConfiguredModel()).toEqual({ configured: false });
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-5', profileId: p.profileId });
    expect(a.hasConfiguredModel()).toEqual({ configured: true });
  });

  it('falls back to the ANTHROPIC_API_KEY env var when set', async () => {
    const a = await import('../../../src/main/features/auth');
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-env-xxxxxxxx';
    try {
      expect(a.hasConfiguredModel()).toEqual({ configured: true });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('auth › listModels', () => {
  it('returns the hand-curated list for a known provider', async () => {
    const a = await import('../../../src/main/features/auth');
    const { models } = await a.listModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.name).toBe('string');
    }
  });

  it('returns empty array for unknown providers', async () => {
    const a = await import('../../../src/main/features/auth');
    const { models } = await a.listModels('no-such-provider');
    expect(models).toEqual([]);
  });
});

describe('auth › getConfig', () => {
  it('returns empty pair when no profiles exist', async () => {
    const a = await import('../../../src/main/features/auth');
    expect(await a.getConfig()).toEqual({ provider: '', model: '' });
  });

  it('returns entries[0] (provider, model) as the effective default', async () => {
    // getConfig now reads from auth-profiles.json's priority entries list;
    // legacy config.json fallback is removed — auth-profiles is the single
    // source of truth for the default (provider, model) pair.
    const a = await import('../../../src/main/features/auth');
    const profiles = await a.saveApiKey('anthropic', 'sk-test', 'acc1');
    expect(profiles.profileId).toBeTruthy();
    await a.addEntry({ provider: 'anthropic', model: 'claude-opus-4-7', profileId: profiles.profileId });
    expect(await a.getConfig()).toEqual({ provider: 'anthropic', model: 'claude-opus-4-7' });
  });
});
