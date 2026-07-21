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
});
