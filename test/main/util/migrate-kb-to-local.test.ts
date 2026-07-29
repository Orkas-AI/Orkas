import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fsFaults = vi.hoisted(() => ({
  renameSource: '',
  renameTarget: '',
  renameCode: '',
  copySource: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync(source: fs.PathLike, target: fs.PathLike): void {
      if (
        fsFaults.renameCode
        && String(source) === fsFaults.renameSource
        && (!fsFaults.renameTarget || String(target) === fsFaults.renameTarget)
      ) {
        const error = new Error(`injected ${fsFaults.renameCode}`) as NodeJS.ErrnoException;
        error.code = fsFaults.renameCode;
        throw error;
      }
      actual.renameSync(source, target);
    },
    copyFileSync(source: fs.PathLike, target: fs.PathLike): void {
      if (fsFaults.copySource && String(source) === fsFaults.copySource) {
        const error = new Error('injected copy failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actual.copyFileSync(source, target);
    },
  };
});

const UID = 'migration-user';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;

function cloudContexts(): string {
  return path.join(workspaceRoot, UID, 'cloud', 'contexts');
}

function localContexts(): string {
  return path.join(workspaceRoot, UID, 'local', 'contexts');
}

function migrationStamp(): string {
  return path.join(workspaceRoot, UID, 'local', '.migrations');
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function stampLines(): string[] {
  if (!fs.existsSync(migrationStamp())) return [];
  return fs.readFileSync(migrationStamp(), 'utf8').split('\n').filter(Boolean);
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kb-migration-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  fsFaults.renameSource = '';
  fsFaults.renameTarget = '';
  fsFaults.renameCode = '';
  fsFaults.copySource = '';
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('migrateKbToLocalContexts', () => {
  it('moves the machine-private index out of cloud and is idempotent', async () => {
    const legacy = path.join(cloudContexts(), '.kb', 'vector.db');
    const migrated = path.join(localContexts(), '.kb', 'vector.db');
    write(legacy, 'complete-index');
    const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util/migrate-kb-to-local'
    );

    migrateKbToLocalContexts(UID);

    expect(fs.readFileSync(migrated, 'utf8')).toBe('complete-index');
    expect(fs.existsSync(path.join(cloudContexts(), '.kb'))).toBe(false);
    expect(stampLines()).toContain('kb-to-local-contexts-v1');

    write(path.join(localContexts(), '.kb', 'after-first-run'), 'must stay');
    migrateKbToLocalContexts(UID);
    expect(fs.readFileSync(path.join(localContexts(), '.kb', 'after-first-run'), 'utf8'))
      .toBe('must stay');
  });

  it('preserves both indexes and prior cloud backups when local data already exists', async () => {
    write(path.join(localContexts(), '.kb', 'vector.db'), 'current-index');
    write(path.join(cloudContexts(), '.kb', 'vector.db'), 'legacy-index');
    write(path.join(cloudContexts(), '.kb.legacy-earlier', 'vector.db'), 'earlier-index');
    const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util/migrate-kb-to-local'
    );

    migrateKbToLocalContexts(UID);

    expect(fs.readFileSync(path.join(localContexts(), '.kb', 'vector.db'), 'utf8'))
      .toBe('current-index');
    const backups = fs.readdirSync(localContexts())
      .filter((name) => name.startsWith('.kb.legacy-'));
    expect(backups).toHaveLength(2);
    expect(backups.map((name) => (
      fs.readFileSync(path.join(localContexts(), name, 'vector.db'), 'utf8')
    )).sort()).toEqual(['earlier-index', 'legacy-index']);
    expect(fs.existsSync(path.join(cloudContexts(), '.kb'))).toBe(false);
    expect(fs.existsSync(path.join(cloudContexts(), '.kb.legacy-earlier'))).toBe(false);
  });

  it('moves a malformed legacy index file out of the syncable tree without deleting it', async () => {
    const legacy = path.join(cloudContexts(), '.kb');
    write(legacy, 'recoverable-malformed-index');
    const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util/migrate-kb-to-local'
    );

    migrateKbToLocalContexts(UID);

    expect(fs.existsSync(legacy)).toBe(false);
    const preserved = fs.readdirSync(localContexts())
      .filter((name) => name.startsWith('.kb.legacy-file-'));
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(localContexts(), preserved[0]), 'utf8'))
      .toBe('recoverable-malformed-index');
    expect(stampLines()).toContain('kb-to-local-contexts-v1');
  });

  it('does not stamp a failed conflict-preservation move and retries next activation', async () => {
    const legacyRoot = path.join(cloudContexts(), '.kb');
    write(path.join(localContexts(), '.kb', 'vector.db'), 'current-index');
    write(path.join(legacyRoot, 'vector.db'), 'legacy-index');
    fsFaults.renameSource = legacyRoot;
    fsFaults.renameCode = 'EACCES';
    const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util/migrate-kb-to-local'
    );

    migrateKbToLocalContexts(UID);

    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(stampLines()).not.toContain('kb-to-local-contexts-v1');

    fsFaults.renameCode = '';
    migrateKbToLocalContexts(UID);
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(stampLines()).toContain('kb-to-local-contexts-v1');
    expect(fs.readdirSync(localContexts()).some((name) => name.startsWith('.kb.legacy-')))
      .toBe(true);
  });

  it('publishes cross-device copies atomically and recovers after a partial-copy fault', async () => {
    const legacyRoot = path.join(cloudContexts(), '.kb');
    const targetRoot = path.join(localContexts(), '.kb');
    const legacyFile = path.join(legacyRoot, 'vector.db');
    write(legacyFile, 'complete-index');
    fsFaults.renameSource = legacyRoot;
    fsFaults.renameTarget = targetRoot;
    fsFaults.renameCode = 'EXDEV';
    fsFaults.copySource = legacyFile;
    const { migrateKbToLocalContexts } = await import(
      '../../../src/main/util/migrate-kb-to-local'
    );

    migrateKbToLocalContexts(UID);

    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(fs.existsSync(targetRoot)).toBe(false);
    expect(
      fs.existsSync(localContexts())
        ? fs.readdirSync(localContexts()).filter((name) => name.includes('.migrating-'))
        : [],
    ).toEqual([]);
    expect(stampLines()).not.toContain('kb-to-local-contexts-v1');

    fsFaults.copySource = '';
    migrateKbToLocalContexts(UID);
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(fs.readFileSync(path.join(targetRoot, 'vector.db'), 'utf8')).toBe('complete-index');
    expect(stampLines()).toContain('kb-to-local-contexts-v1');
  });
});
