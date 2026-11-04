import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

import { SkillLoader } from '../../../src/core-agent/src/skills/loader';
import { normalizeAgent } from '../../../src/main/features/agents';
import { _buildAgentRuntimeGuidanceForTest } from '../../../src/main/features/group_chat/bus';
import {
  _renderSkillLinesForTest,
  pickPromptDescription,
} from '../../../src/main/model/core-agent/skill-registry';
import { AGENT_DESCRIPTION_ROSTER_MAX_CHARS } from '../../../src/main/util/skill-description-policy';
import { BUILTIN_AGENT_TOOL_SURFACE_CASES } from '../model/core-agent/builtin-agent-tool-surface-fixture';

/**
 * Comparable character measurements of Agent-authored resident content.
 * The production normalizer, runtime guidance and Skill roster supply this
 * partial surface; display descriptions are excluded. It is not billed usage
 * or the complete initial request. The uniform estimated-token acceptance
 * lives in agent-initial-overhead.test.ts under test-case policy section 5.1.
 */

const AGENTS_ROOT = path.join(
  __dirname, '..', '..', '..', 'resources', 'builtin', 'marketplace', 'agents',
);

/** Historical character references, retained only for growth reporting.
 *  These included descriptions, which no longer enter the execution prompt.
 *  The former ceilings were
 *  set just above each agent's measurement
 *  (2026-08-16 baseline of workflow + guidance; VideoStudio re-measured
 *  2026-08-20 after edit-intent routing, DeepResearcher after ledger-backed
 *  fetch budgets — both carry their own prompt audits; UIDesigner re-measured
 *  2026-08-26 after the read-only-repo rewrite moved detail into its Skill;
 *  StockAnalyser was measured at introduction on 2026-08-28 after its six
 *  route Skills absorbed conditional rules; every agent re-measured on
 *  2026-09-04 when the description and skill roster joined the gate, which
 *  had been counting only about half of the resident text). The headroom is
 *  deliberately about one percent; they do not define current acceptance. */
const HISTORICAL_CHARACTER_CEILINGS: Readonly<Record<string, number>> = {
  // Re-measured 2026-10-20 at 7,205 after one resident Route line for setup or
  // cost questions: those turns load no Skill, and the receiving Agent cannot
  // read `orkas-guide`, so live answers omitted the configured video-service path.
  VideoStudio: 7_277,
  VoiceStudio: 2_571, // Audio-only Agent; one private Skill, no runtime manual.
  // Re-measured 2026-09-09 at 7,996 after the BACKLINK route joined the
  // surface: one workflow line naming `seo-backlink-value`, its roster
  // description, one knowhow line, and the routing terms in both
  // descriptions. The offer-valuation procedure itself lives in the Skill.
  SeoGeoAgent: 7_683,
  UIDesigner: 6_728,
  ImageStudio: 3_817,
  PptMaker: 3_816,
  ProductDeveloper: 2_536,
  DeepResearcher: 2_382,
  OfficeWorker: 2_219,
  ContentWriter: 1_912,
  StockAnalyser: 4_725,
  // Added as built-ins on 2026-09-21. Each ceiling is the measured resident
  // surface plus about one percent; route-specific procedures remain in the
  // six standalone ecommerce Skills shipped with them.
  ECommerceResearcher: 2_569,
  ECommerceReviewer: 2_568,
  ECommerceOperator: 1_642,
  ECommerceWriter: 1_605,
  ECommerceAnalyzer: 1_445,
};

/** Retain the former aggregate reference without treating separate requests
 *  as one provider request or restoring an Agent-specific acceptance rule. */
// 2026-09-15: routing descriptions lost 2,224 characters of duplicated prose;
// lower the existing ceilings by that delta, preserving their prior headroom.
// 2026-09-17: ProductDeveloper delegates execution procedures to product-dev.
const HISTORICAL_CORPUS_CHARACTER_CEILING = 55_208;

interface AgentSurface {
  name: string;
  workflow: number;
  guidance: number;
  skills: number;
  total: number;
}

/** Measure one agent the way the group-chat worker prompt assembles it. */
async function measure(raw: unknown, fallbackName: string, skillsRoot: string): Promise<AgentSurface | null> {
  const agent = normalizeAgent(raw, 'builtin') as
    | { name?: string; workflow?: string; profile?: unknown; description_zh?: string; description_en?: string }
    | null;
  if (!agent) return null;
  const workflow = String(agent.workflow || '').trim();
  const guidance = _buildAgentRuntimeGuidanceForTest(agent.profile);
  const guidanceLength = guidance === '(none)' ? 0 : guidance.length;
  const specs = fs.existsSync(skillsRoot) ? new SkillLoader({ dirs: [skillsRoot] }).list() : [];
  const roster = specs.length ? await _renderSkillLinesForTest(specs, []) : '';
  return {
    name: agent.name || fallbackName,
    workflow: workflow.length,
    guidance: guidanceLength,
    skills: roster.length,
    total: workflow.length + guidanceLength + roster.length,
  };
}

async function measureAll(): Promise<AgentSurface[]> {
  const rows: AgentSurface[] = [];
  for (const dir of fs.readdirSync(AGENTS_ROOT)) {
    const file = path.join(AGENTS_ROOT, dir, 'agent.json');
    if (!fs.existsSync(file)) continue;
    const row = await measure(
      JSON.parse(fs.readFileSync(file, 'utf8')),
      dir,
      path.join(AGENTS_ROOT, dir, 'skills'),
    );
    if (row) rows.push(row);
  }
  return rows.sort((left, right) => right.total - left.total);
}

describe('built-in agent resident prompt surface', () => {
  let rows: AgentSurface[] = [];
  let tmpDir = '';
  let prevWorkspaceRoot: string | undefined;
  beforeAll(async () => {
    // The roster renderer labels each entry's source against the active
    // user's skill roots; an empty scratch workspace is enough.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agent-surface-'));
    prevWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    const users = await import('../../../src/main/features/users');
    users.activateUser('agent-prompt-surface-budget');
    rows = await measureAll();
  });
  afterAll(async () => {
    await drainMainRuntimeForTest();
    process.env.ORKAS_WORKSPACE_ROOT = prevWorkspaceRoot;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps every built-in Agent to the uniform initial-overhead portfolio', () => {
    expect(rows.map(row => row.name).sort())
      .toEqual(BUILTIN_AGENT_TOOL_SURFACE_CASES.map(scenario => scenario.name).sort());
    expect(rows.every((row) => row.total > 0)).toBe(true);
  });

  it('measures added workflow text without an Agent-specific character gate', async () => {
    const dir = path.join(AGENTS_ROOT, '79df9cc89f5f');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) as { workflow?: string };
    const skillsRoot = path.join(dir, 'skills');
    const baseline = await measure(raw, 'VideoStudio', skillsRoot);
    expect(baseline).not.toBeNull();

    const grown = await measure(
      { ...raw, workflow: `${String(raw.workflow || '').trim()}\n\n${'x'.repeat(400)}` },
      'VideoStudio',
      skillsRoot,
    );
    expect(grown!.workflow).toBe(baseline!.workflow + 402);
    expect(grown!.total).toBe(baseline!.total + 402);
  });

  it('detects repeated source mechanics moved back into a resident workflow', async () => {
    const dir = path.join(AGENTS_ROOT, 'bcfcb4921dce');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) as {
      workflow?: string;
    };
    const skillsRoot = path.join(dir, 'skills');
    const baseline = await measure(raw, 'UIDesigner', skillsRoot);
    expect(baseline).not.toBeNull();

    // A dropped/replaced workflow must fail this independent size delta.
    const mechanics = '\n\n- Keep a resident Source Authority Map with Preserve, Change, and Derive rows for every inspectable source.';
    const duplicated = await measure({
      ...raw,
      workflow: `${String(raw.workflow || '').trim()}${mechanics.repeat(4)}`,
    }, 'UIDesigner', skillsRoot);
    expect(duplicated!.total).toBe(baseline!.total + mechanics.length * 4);
  });

  it('excludes display-description growth while retaining the owned-skill surface', async () => {
    // Routing descriptions remain in Commander discovery, outside this
    // execution-only measurement. Owned Skill entries remain resident.
    const dir = path.join(AGENTS_ROOT, '79df9cc89f5f');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) as {
      description_en?: string;
    };
    const skillsRoot = path.join(dir, 'skills');
    const baseline = await measure(raw, 'VideoStudio', skillsRoot);
    const longerDescription = await measure(
      { ...raw, description_en: `${raw.description_en || ''} ${'y'.repeat(400)}` },
      'VideoStudio',
      skillsRoot,
    );
    expect(longerDescription!.total).toBe(baseline!.total);

    const withoutSkills = await measure(raw, 'VideoStudio', path.join(dir, 'no-such-skills'));
    expect(baseline!.skills).toBeGreaterThan(0);
    expect(withoutSkills!.skills).toBe(0);
    expect(withoutSkills!.total).toBe(baseline!.total - baseline!.skills);
  });

  it('keeps every built-in routing description inside the agent roster ceiling', () => {
    // The Commander directory shortens longer descriptions with an ellipsis
    // and no other signal. A description over the ceiling can lose a boundary
    // silently; fail here instead.
    const over = fs.readdirSync(AGENTS_ROOT).flatMap((dir) => {
      const file = path.join(AGENTS_ROOT, dir, 'agent.json');
      if (!fs.existsSync(file)) return [];
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const description = pickPromptDescription(raw as { description_zh?: string; description_en?: string });
      return description.length > AGENT_DESCRIPTION_ROSTER_MAX_CHARS
        ? [`${String(raw.name ?? dir)}=${description.length}`]
        : [];
    });
    expect(over).toEqual([]);
  });

  it('reports the per-turn cost of each agent', () => {
    // Observations only. Unknown/new Agents need uniform-overhead coverage,
    // not a new historical character allowance.
    const report = rows
      .map((row) => `${row.name}=${row.total}(w${row.workflow}/g${row.guidance}/s${row.skills},historical=${HISTORICAL_CHARACTER_CEILINGS[row.name] ?? 'unmeasured'})`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`[agent-prompt-surface] ${report} corpus=${rows.reduce((sum, row) => sum + row.total, 0)} historical_corpus=${HISTORICAL_CORPUS_CHARACTER_CEILING}`);
    expect(rows[0].total).toBeGreaterThan(0);
  });
});
