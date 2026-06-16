import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Electron isn't available in unit tests; stub `app.getLocale()` only.
// `initLanguage(locale)` takes the locale explicitly so tests never hit
// `initLanguageFromApp`; this mock just keeps the top-level import from
// exploding.
vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => '') },
}));

// Point WS_ROOT at a fresh tmp dir for each test, BEFORE loading paths /
// config / i18n. paths.ts reads `ORKAS_WORKSPACE_ROOT` at module load time
// and calls `ensureTopLevelLayout()`, so we must set the env + reset modules
// to pick up a clean dir each time. We also activate a deterministic uid so
// `readPreferences`/`writePreferences` can resolve `<uid>/cloud/config/`.
let tmpDir: string;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-config-'));
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const electron = await import('electron');
  (electron.app.getLocale as unknown as { mockReturnValue: (v: string) => void }).mockReturnValue('');
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
});

async function load() {
  const appConfig = await import('../../../src/main/features/config');
  const i18n = await import('../../../src/main/i18n');
  i18n._resetCacheForTests();
  i18n.setCurrentLang('en');
  return { appConfig, i18n };
}

describe('features/config › readConfig / writeConfig', () => {
  it('readConfig returns {} when file missing', async () => {
    const { appConfig } = await load();
    expect(appConfig.readConfig()).toEqual({});
  });

  it('writeConfig merges partials without clobbering other keys', async () => {
    // AppConfig now only carries `language`; we verify merge by setting
    // and overwriting that single key plus an unknown forward-compat key.
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    appConfig.writeConfig({ language: 'en' });
    const cfg = appConfig.readConfig();
    expect(cfg.language).toBe('en');
  });

  it('writeConfig ignores undefined values', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    appConfig.writeConfig({ language: undefined });
    expect(appConfig.readConfig().language).toBe('zh');
  });

  it('records per-field clocks for preference sync merges', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'zh' });
    const first = appConfig.readConfig()._field_updated_at?.language || 0;
    appConfig.writeConfig({ commander_avatar: { icon: 'crown', color: 'gold' } });
    const cfg = appConfig.readConfig();
    expect(cfg._field_updated_at?.language).toBe(first);
    expect(cfg._field_updated_at?.commander_avatar).toBeGreaterThan(first);
  });
});

describe('features/config › initLanguage', () => {
  it('uses persisted language when present (ignores system locale)', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    expect(appConfig.initLanguage('en-US')).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });

  it('detects zh-* on first boot and persists', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.initLanguage('zh-CN')).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
    expect(appConfig.readConfig().language).toBe('zh');
  });

  it('detects ja-* on first boot and persists', async () => {
    const { appConfig, i18n } = await load();
    expect(appConfig.initLanguage('ja-JP')).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(appConfig.readConfig().language).toBe('ja');
  });

  it('falls back to en for unsupported locales on first boot', async () => {
    const paths = await import('../../../src/main/paths');
    const prefPath = paths.userPreferencesFile(TEST_UID);
    for (const locale of ['en-US', 'fr-FR', '']) {
      fs.rmSync(prefPath, { force: true });
      vi.resetModules();
      const users = await import('../../../src/main/features/users');
      users.activateUser(TEST_UID);
      const { appConfig: fresh, i18n: freshI18n } = await load();
      expect(fresh.initLanguage(locale)).toBe('en');
      expect(freshI18n.getCurrentLang()).toBe('en');
      expect(fresh.readConfig().language).toBe('en');
    }
  });

  it('overwrites corrupt language value with detected default', async () => {
    const { appConfig } = await load();
    appConfig.writeConfig({ language: 'fr' as unknown as 'en' });
    expect(appConfig.initLanguage('zh-HK')).toBe('zh');
    expect(appConfig.readConfig().language).toBe('zh');
  });
});

describe('features/config › setLanguage', () => {
  it('persists + updates in-memory current lang', async () => {
    const { appConfig, i18n } = await load();
    appConfig.setLanguage('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(appConfig.readConfig().language).toBe('ja');
  });

  it('rejects unsupported languages', async () => {
    const { appConfig } = await load();
    expect(() => appConfig.setLanguage('fr' as unknown as 'en')).toThrow();
  });

  it('refreshes in-memory current lang from synced preferences without rewriting', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    i18n.setCurrentLang('en');
    expect(appConfig.refreshCurrentLanguageFromPreferences()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });
});

describe('features/config › getLanguage', () => {
  it('returns en when unset', async () => {
    const { appConfig, i18n } = await load();
    i18n.setCurrentLang('zh');
    expect(appConfig.getLanguage()).toBe('en');
    expect(i18n.getCurrentLang()).toBe('en');
    expect(process.env.ORKAS_ACCEPT_LANGUAGE).toMatch(/^en-US/);
  });

  it('detects system language when no user preference exists', async () => {
    const electron = await import('electron');
    (electron.app.getLocale as unknown as { mockReturnValue: (v: string) => void }).mockReturnValue('zh-CN');
    const { appConfig, i18n } = await load();

    expect(appConfig.getLanguage()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
    expect(process.env.ORKAS_ACCEPT_LANGUAGE).toMatch(/^zh-CN/);
  });

  it('returns persisted value', async () => {
    const { appConfig, i18n } = await load();
    appConfig.writeConfig({ language: 'zh' });
    expect(appConfig.getLanguage()).toBe('zh');
    expect(i18n.getCurrentLang()).toBe('zh');
  });

  it('returns en when persisted value is not a valid Lang', async () => {
    const { appConfig, i18n } = await load();
    i18n.setCurrentLang('zh');
    appConfig.writeConfig({ language: 'xx' as unknown as 'en' });
    expect(appConfig.getLanguage()).toBe('en');
    expect(i18n.getCurrentLang()).toBe('en');
  });

  it('can resolve and sync language for an explicit user id', async () => {
    const { appConfig, i18n } = await load();
    const paths = await import('../../../src/main/paths');
    const prefPath = paths.userPreferencesFile('u2');
    fs.mkdirSync(path.dirname(prefPath), { recursive: true });
    fs.writeFileSync(prefPath, JSON.stringify({ language: 'ja' }));
    i18n.setCurrentLang('en');

    expect(appConfig.getLanguageForUser('u2')).toBe('ja');
    expect(i18n.getCurrentLang()).toBe('ja');
    expect(process.env.ORKAS_ACCEPT_LANGUAGE).toMatch(/^ja-JP/);
  });
});
