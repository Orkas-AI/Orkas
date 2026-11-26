import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { OrkasTestApp } from './fixtures/orkas';

// Real Electron startup with the isolated local user. No model request occurs.
test('publishes bundled resources before boot readiness across first use and restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  const bundled = path.resolve(__dirname, '../../resources/builtin');
  const manifest = JSON.parse(readFileSync(path.join(bundled, 'system/skills/_system.json'), 'utf8'));
  const rows: Array<{ id: string; update_at: number | string }> = Array.isArray(manifest) ? manifest : manifest.skills;
  function assertPublished(uid: string): string {
    const system = path.join(app.workspaceRoot, uid, 'local/system/skills');
    const localManifest = readFileSync(path.join(system, '_system.json'), 'utf8');
    expect(JSON.parse(localManifest)).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)));
    for (const { id } of rows) {
      expect(readFileSync(path.join(system, id, 'SKILL.md'), 'utf8'))
        .toBe(readFileSync(path.join(bundled, 'system/skills', id, 'SKILL.md'), 'utf8'));
    }
    for (const kind of ['agents', 'skills']) {
      for (const entry of readdirSync(path.join(bundled, 'marketplace', kind), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const file = kind === 'agents' ? 'agent.json' : 'SKILL.md';
        if (!existsSync(path.join(bundled, 'marketplace', kind, entry.name, file))) continue;
        expect(existsSync(path.join(app.workspaceRoot, uid, 'local/marketplace', kind, entry.name, file))).toBe(true);
      }
    }
    for (const entry of readdirSync(path.join(bundled, 'apps'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('builtin-')) continue;
      const source = path.join(bundled, 'apps', entry.name);
      const installed = path.join(app.workspaceRoot, uid, 'local/builtin_apps', entry.name);
      const metadata = JSON.parse(readFileSync(path.join(source, '__orkas-meta.json'), 'utf8'));
      expect(JSON.parse(readFileSync(path.join(installed, '__orkas-meta.json'), 'utf8')))
        .toMatchObject({ version: metadata.version, browserStorage: 'isolated-v1' });
      expect(readFileSync(path.join(installed, metadata.entry || 'index.html'), 'utf8'))
        .toBe(readFileSync(path.join(source, metadata.entry || 'index.html'), 'utf8'));
    }
    return localManifest;
  }
  try {
    await app.launch();
    await expect(app.page!.locator('html')).toHaveAttribute('data-orkas-boot-ready', 'true');
    const registryFile = path.join(app.workspaceRoot, 'open-users.json');
    const uid = JSON.parse(readFileSync(registryFile, 'utf8')).open_current_user_id;
    expect(uid).toBe('account-e2e');
    const first = assertPublished(uid);
    await app.relaunch();
    expect(JSON.parse(readFileSync(registryFile, 'utf8')).open_current_user_id).toBe(uid);
    expect(assertPublished(uid)).toBe(first);
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    await app.dispose();
  }
});
