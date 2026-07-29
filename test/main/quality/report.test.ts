import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ValidationReport } from '../../../src/main/quality/types';

function report(version: string): ValidationReport {
  return {
    ok: true,
    violations: [],
    validated_at: `2026-07-20T00:00:0${version}.000Z`,
    validator_version: version,
  };
}

describe('quality report persistence lifecycle', () => {
  let tmpDir = '';
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-quality-report-'));
    previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const reports = await import('../../../src/main/quality/report');
    await reports.drainReportWrites();
    if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('serializes same-target writes so the latest report wins', async () => {
    const reports = await import('../../../src/main/quality/report');
    void reports.persistReport({ uid: 'u1', kind: 'skill', id: 'alpha', report: report('1') });
    void reports.persistReport({ uid: 'u1', kind: 'skill', id: 'alpha', report: report('2') });

    await expect(reports.readReport({ uid: 'u1', kind: 'skill', id: 'alpha' }))
      .resolves.toMatchObject({ validator_version: '2' });
  });

  it('drains fire-and-forget writes before a workspace is removed', async () => {
    const reports = await import('../../../src/main/quality/report');
    for (let i = 0; i < 20; i += 1) {
      void reports.persistReport({ uid: 'u1', kind: 'skill', id: `skill-${i}`, report: report('1') });
    }

    await reports.drainReportWrites();
    const reportDir = path.join(tmpDir, 'u1', 'local', 'quality_reports', 'skills');
    expect(fs.readdirSync(reportDir)).toHaveLength(20);
  });

  it('orders deletion after an already queued write', async () => {
    const reports = await import('../../../src/main/quality/report');
    void reports.persistReport({ uid: 'u1', kind: 'agent', id: 'writer', report: report('1') });
    await reports.deleteReport({ uid: 'u1', kind: 'agent', id: 'writer' });

    await expect(reports.readReport({ uid: 'u1', kind: 'agent', id: 'writer' })).resolves.toBeNull();
  });

  it('treats a corrupt persisted payload as unavailable instead of a clean report', async () => {
    const reports = await import('../../../src/main/quality/report');
    const paths = await import('../../../src/main/paths');
    const file = paths.qualitySkillReportFile('u1', 'corrupt-skill');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not-json', 'utf8');

    await expect(reports.readReport({
      uid: 'u1',
      kind: 'skill',
      id: 'corrupt-skill',
    })).resolves.toBeNull();

    fs.writeFileSync(file, '{}', 'utf8');
    await expect(reports.readReport({
      uid: 'u1',
      kind: 'skill',
      id: 'corrupt-skill',
    })).resolves.toBeNull();

    fs.writeFileSync(file, JSON.stringify({
      ...report('1'),
      ok: false,
      violations: [],
    }), 'utf8');
    await expect(reports.readReport({
      uid: 'u1',
      kind: 'skill',
      id: 'corrupt-skill',
    })).resolves.toBeNull();
  });

  it('rejects unsafe identifiers at the persistence boundary', async () => {
    const reports = await import('../../../src/main/quality/report');

    await expect(reports.persistReport({
      uid: 'u1',
      kind: 'skill',
      id: '../config/auth-profiles',
      report: report('1'),
    })).rejects.toThrow('invalid quality report id');
    await expect(reports.readReport({
      uid: 'u1',
      kind: 'agent',
      id: 'writer/../../secret',
    })).rejects.toThrow('invalid quality report id');
  });
});
