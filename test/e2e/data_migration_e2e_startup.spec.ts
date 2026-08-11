import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { OrkasTestApp } from './fixtures/orkas';

test('startup preserves conflicting legacy KB data and remains idempotent after relaunch', async ({}, testInfo) => {
  const app = new OrkasTestApp(testInfo);
  const cloudContexts = path.join(
    app.workspaceRoot,
    'account-e2e',
    'cloud',
    'contexts',
  );
  const localContexts = path.join(
    app.workspaceRoot,
    'account-e2e',
    'local',
    'contexts',
  );
  const legacyKb = path.join(cloudContexts, '.kb');
  const currentKb = path.join(localContexts, '.kb');
  mkdirSync(legacyKb, { recursive: true });
  mkdirSync(currentKb, { recursive: true });
  writeFileSync(path.join(legacyKb, 'vector.db'), 'legacy-index', 'utf8');
  writeFileSync(path.join(currentKb, 'vector.db'), 'current-index', 'utf8');

  try {
    await app.launch();

    expect(readFileSync(path.join(currentKb, 'vector.db'), 'utf8')).toBe('current-index');
    const backupsAfterLaunch = readdirSync(localContexts)
      .filter((name) => name.startsWith('.kb.legacy-'));
    expect(backupsAfterLaunch).toHaveLength(1);
    expect(readFileSync(path.join(localContexts, backupsAfterLaunch[0], 'vector.db'), 'utf8'))
      .toBe('legacy-index');
    expect(readdirSync(cloudContexts)).not.toContain('.kb');

    await app.relaunch();

    expect(readFileSync(path.join(currentKb, 'vector.db'), 'utf8')).toBe('current-index');
    expect(readdirSync(localContexts).filter((name) => name.startsWith('.kb.legacy-')))
      .toEqual(backupsAfterLaunch);
  } finally {
    await app.dispose();
  }
});
