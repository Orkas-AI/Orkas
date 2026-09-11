import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { collectLogFiles } = require('../e2e/fixtures/electron-log-files.cjs');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('retains application and runtime errors even when Chromium has a larger binary database log', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orkas-log-evidence-'));
  roots.push(root);
  const put = (name: string, body: string | Buffer) => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put('electron-user-data/Local Storage/leveldb/000003.log', Buffer.alloc(3 * 1024 * 1024));
  put('workspace/logs/current.log', '[error] application failure\n');
  put('workspace/logs/previous.old.log', '[warn] recovered failure\n');
  put('electron-user-data/logs/runtime.log', '[error] runtime failure\n');
  const logs = collectLogFiles(root);
  expect(logs).toContain('[error] application failure');
  expect(logs).toContain('[warn] recovered failure');
  expect(logs).toContain('[error] runtime failure');
  expect(logs).not.toContain('leveldb');
  expect(logs).not.toContain('\0');
});

it('handles fixtures that exit before creating a diagnostic directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orkas-log-evidence-'));
  roots.push(root);
  expect(collectLogFiles(root)).toBe('');
});
