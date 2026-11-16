import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { validateSkillDir } from '../../../src/main/quality';

const pcRoot = path.resolve(__dirname, '../../..');
const skillDir = path.join(pcRoot, 'resources/builtin/marketplace/skills/e7f5c0e6f1be');

it('runs both social analysis commands with the shared packaged helper and preserves return bases', () => {
  expect(validateSkillDir(skillDir).ok).toBe(true);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-social-metrics-'));
  const python = process.env.ORKAS_TEST_PYTHON || path.join(pcRoot, 'venv',
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  try {
    fs.writeFileSync(path.join(workspace, 'campaign.json'), JSON.stringify({
      total_spend: 100, revenue: 1000, non_marketing_costs: 600,
      conversion_value: 500, value_per_engagement: 1000,
      posts: [{ likes: 10, comments: 0, shares: 0, saves: 0,
        reach: 100, impressions: 200, clicks: 10 }],
    }));
    const outputs = ['calculate_metrics', 'analyze_performance'].map(command => {
      const result = spawnSync(process.execPath,
        [path.join(pcRoot, 'bin/run-skill.cjs'), 'social-data', command, '--', 'campaign.json'], {
          cwd: workspace, encoding: 'utf8', timeout: 15000,
          env: { ...process.env, ORKAS_PC_DIR: pcRoot, ORKAS_RUN_SKILL_DIR: skillDir,
            ORKAS_WORKSPACE_ROOT: workspace, ORKAS_PYTHON: python, PYTHONDONTWRITEBYTECODE: '1' },
        });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.roi_metrics).toMatchObject({
        roas: 10, roi_percentage: 300, roi_basis: 'revenue_less_non_marketing_costs',
        conversion_value_return_percentage: 400, estimated_value: 10000,
        estimated_roi_percentage: 9900, estimate_basis: 'user_supplied_value_per_engagement',
      });
      return output;
    });
    expect(outputs[0].roi_metrics).toEqual(outputs[1].roi_metrics);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
