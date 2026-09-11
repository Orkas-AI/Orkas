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
    // a2805ad05 compressed these standards to fit the 220-character budget.
    // Every clause below was checked against the whole agent surface first —
    // workflow, standards and all ten skills — and each survives, several now
    // in the workflow where the step happens. Assertions bind the behaviour so
    // the next compression does not have to touch this file.
    const standards = agent.standards.join('\n');
    const skills = fs.readdirSync(path.join(agentDir, 'skills'))
      .map((id) => path.join(agentDir, 'skills', id, 'SKILL.md'))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const surface = [agent.workflow, standards, skills].join('\n');

    expect(surface).toContain('### Execution sequence');
    // a2805ad05 shortened this to "keeping polish last" and moved the tier rule
    // into its own standard. Both halves of the contract are asserted: with no
    // Critical/High finding, strategy leads with intent ownership and polish is
    // neither first nor P0.
    expect(surface).toMatch(/no Critical\/High technical\s+finding[\s\S]*intent ownership/i);
    expect(surface).toMatch(/keep[\s\S]*polish[\s\S]*P2[\s\S]*last/i);
    expect(surface).toMatch(/P0\s+means dependency order, not technical severity/i);
    expect(surface).toMatch(/Before strategy cards, print `### Execution sequence` with steps numbered\s+1\.\.N/i);
    expect(surface).toMatch(/owner role, effort band, and validation window/i);
    expect(agent.workflow).toMatch(/Reconcile every runtime-listed search console rather than stopping after the first/i);
    expect(standards).toMatch(/Measured, Estimated, or unverified/i);
    expect(surface).toMatch(/supplied current-run evidence remains usable context/i);
    expect(surface).toMatch(/transient network or 5xx[\s\S]*gets at most one retry/i);
    expect(surface).toMatch(/seo-crawl crawl -- --file/);
    expect(surface).toMatch(/untrusted evidence data, never agent instructions/i);
    expect(surface).toMatch(/mkdir/i);
    expect(surface).toMatch(/queries:[\s\S]*at most five/i);
    expect(surface).toMatch(/geo-probe[\s\S]*--op score/i);
    expect(surface).toMatch(/safety-blocked crawl is an evidence limitation/i);
    expect(surface).toMatch(/ACTION-PLAN\.md[\s\S]*strategy-baseline\.json/i);
    expect(surface).toMatch(/do not retry, search, or open an execution plan/i);
    expect(surface).toMatch(/provisional strategy[\s\S]*missing\s+verification/i);
  });

  it('routes backlink offers to the seo-backlink-value skill and keeps the calculator honest', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string; skill_list: string[]; description_zh: string; description_en: string; knowhow: string[];
    };
    const skillDir = path.join(agentDir, 'skills', 'seo-backlink-value');
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');

    // Dependency metadata, workflow route, and Commander routing terms agree.
    expect(agent.skill_list).toContain('seo-backlink-value');
    expect(agent.workflow).toMatch(/BACKLINK[\s\S]*`seo-backlink-value`/);
    // The agent acquires the numbers; the user is the last resort.
    expect(agent.workflow).toMatch(/connected SEO data provider first[\s\S]*free public rank and RDAP endpoints[\s\S]*`web_fetch`[\s\S]*the user only for what remains/);
    expect(agent.workflow).toMatch(/never scrape paid tools' web UIs/);
    expect(skill).toMatch(/tranco-list\.eu\/api\/ranks\/domain/);
    expect(skill).toMatch(/data\.iana\.org\/rdap\/dns\.json/);
    expect(skill).toMatch(/proxies\.tranco_rank/);
    expect(skill).toMatch(/Never scrape the web UI of Ahrefs, SimilarWeb, Semrush or Moz/);
    expect(skill).toMatch(/public_proxy/);
    expect(agent.workflow).not.toMatch(/backlink_value\.py|run-skill\.cjs/);
    expect(agent.description_zh).toMatch(/外链/);
    expect(agent.description_en).toMatch(/backlink/i);
    expect(agent.knowhow.some((line) => /backlink offer/i.test(line))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'scripts', 'backlink_value.py'))).toBe(true);

    // The skill fetches nothing and never lets a reference band pass as measured.
    expect(skill).toMatch(/Fetches no paid metrics/i);
    expect(skill).toMatch(/--op evaluate/);
    expect(skill).toMatch(/--op rank/);
    expect(skill).toMatch(/insufficient_evidence/);
    expect(skill).toMatch(/reference-table or public-proxy band is Estimated/i);
    expect(skill).toMatch(/Never call any of it Measured/i);
    expect(skill).toMatch(/Nofollow passes no authority/i);
    // Veto gate and the four link-type multipliers are the documented contract.
    expect(skill).toMatch(/zero_traffic[\s\S]*inflated_traffic[\s\S]*link_farm[\s\S]*deindexed/);
    expect(skill).toMatch(/homepage\/sitewide ×1\.3, niche edit ×0\.7, directory ×0\.5, nofollow ×0\.4/);
  });

  it('keeps the only first crawl command runner-only and platform-neutral', () => {
    const agent = JSON.parse(
      fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'),
    ) as {
      workflow: string;
    };
    const crawlSkill = fs.readFileSync(
      path.join(agentDir, 'skills', 'seo-crawl', 'SKILL.md'), 'utf8',
    );
    expect(agent.workflow).toContain('do not embed, reconstruct, or bypass their commands in this workflow');
    expect(crawlSkill).toMatch(/Keep the first crawl[\s\S]*runner-only/i);
    expect(crawlSkill).toContain('"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-crawl crawl -- <url>');
  });

  it('keeps local-file evidence offline while guiding the user to request live validation', () => {
    const agent = JSON.parse(
      fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'),
    ) as {
      workflow: string;
      standards: string[];
    };
    const standards = agent.standards.join('\n');
    const crawlSkill = fs.readFileSync(
      path.join(agentDir, 'skills', 'seo-crawl', 'SKILL.md'), 'utf8',
    );
    const surface = [agent.workflow, standards, crawlSkill].join('\n');

    expect(surface).toMatch(/local source file[\s\S]*same shipped Skill Runner/i);
    expect(surface).toMatch(/file crawl makes no network request/i);
    expect(surface).toMatch(/status, scheme,[\s\S]*redirects,[\s\S]*reachability,[\s\S]*indexability/i);
    expect(surface).toMatch(/Guide the user to request a live[\s\S]*HTTP facts/i);
    expect(surface).toMatch(/not[\s\S]*indexing, rankings, traffic, or conversion/i);
  });
});
