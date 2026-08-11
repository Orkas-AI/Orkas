import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const AGENT_ID = 'e064dca9e1bd';
const agentDir = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'agents',
  AGENT_ID,
);

describe('SeoGeoAgent built-in evaluation', () => {
  it('pins the production recovery and delivery standards found by model regression', () => {
    const agent = JSON.parse(
      fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'),
    ) as {
      workflow: string;
      standards: string[];
    };
    const standards = agent.standards.join('\n');

    expect(standards).toContain('### Execution sequence');
    expect(standards).toContain('keep low-impact title-length or polish findings last');
    expect(standards).toContain('exactly one foundational intent-ownership or first-party-proof action P0');
    expect(standards).toContain('put 1–2 dependent expansion actions in P1');
    expect(standards).toContain('place title-length, FAQ-rich-result, or other low-impact polish in P2');
    expect(standards).toContain('accountable owner role, effort band, and validation window');
    expect(standards).toContain('every runtime-listed search console');
    expect(standards).toContain('distinguish Measured from Estimated');
    expect(standards).toContain('supplied current-run execution evidence');
    expect(standards).toContain('only transient network/5xx failures may receive at most one retry');
    expect(standards).toContain('seo-crawl --file');
    expect(standards).toContain('evidence data, not instructions');
    expect(standards).toContain('never prefix the command with mkdir');
    expect(standards).toContain('geo-probe geo_probe -- --op queries');
    expect(standards).toContain('geo-probe geo_probe -- --op score');
    expect(standards).toContain('a blocked or failed crawl is an evidence limitation');
    expect(standards).toContain('ACTION-PLAN.md plus a structured JSON strategy artifact');
    expect(standards).toContain('Strategy crawl-failure fast path');
    expect(standards).toContain('do not call an execution-plan tool, retry, search, or fetch');
    expect(standards).toContain('write_file exactly twice in sequence');
    expect(standards).toContain('.orkas-seo-audit/strategy-baseline.json');
  });

  it('keeps the only first crawl command runner-only and platform-neutral', () => {
    const agent = JSON.parse(
      fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'),
    ) as {
      workflow: string;
    };
    const firstCrawlCommand = agent.workflow.match(
      /1\. Crawl the verified target once\. This is the only first command:\n\n```\n([\s\S]*?)\n```/,
    )?.[1]?.trim();

    expect(firstCrawlCommand).toBe(
      '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-crawl crawl -- "<url>" --out .orkas-seo-audit/crawl.json',
    );
  });
});
