import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { OrkasTestApp } from './fixtures/orkas';

// Real Electron startup with the isolated local user. No model request occurs.
test('publishes bundled resources before boot readiness across first use and restart', async ({}, testInfo) => {
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
    return localManifest;
  }
  try {
    await app.launch();
    await expect(app.page!.locator('html')).toHaveAttribute('data-orkas-boot-ready', 'true');
    const first = assertPublished('local');
    await app.relaunch();
    expect(assertPublished('local')).toBe(first);
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    await app.dispose();
  }
});
