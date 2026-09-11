import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

import { SkillLoader } from '../../../src/core-agent/src/skills/loader';
import { normalizeAgent } from '../../../src/main/features/agents';
import {
  _buildAgentRuntimeGuidanceForTest,
  _pickAgentRuntimeDescriptionForTest,
} from '../../../src/main/features/group_chat/bus';
import {
  _renderSkillLinesForTest,
  pickPromptDescription,
} from '../../../src/main/model/core-agent/skill-registry';
import { AGENT_DESCRIPTION_ROSTER_MAX_CHARS } from '../../../src/main/util/skill-description-policy';

/**
 * What a built-in agent charges the user for every single turn.
 *
 * `workflow` goes into `chat_agent_in_group` verbatim (trimmed only),
 * `role`/`standards` come back from `buildAgentRuntimeGuidance`, the
 * `description` line is sent with them, and every skill the agent owns adds
 * a roster entry to the same prompt. Together they are the agent-authored
 * resident surface: unlike a Skill body, nothing about them is conditional,
 * so a paragraph added here is re-sent on every turn of every conversation
 * with that agent, whether or not the turn has anything to do with it.
 *
 * The cost is not only tokens. This surface competes with conversation history
 * for the same window, so growth pulls compaction earlier — and the visible
 * symptom of earlier compaction is an agent that has forgotten what the user
 * said a few turns ago.
 *
 * The regression this gate protects against is documented and recent:
 * VideoStudio's prompt surface grew 2.2x in the 26 days to 2026-08-10 with no
 * observer of any kind, and on 2026-08-11 a cleanup removed ~4,700 characters
 * of standards that the runtime had been silently discarding anyway. Nothing
 * in the repository prevented either the growth or a re-growth; every
 * `agent.json` edit is a candidate, and the diff of a prose field never looks
 * like a cost decision.
 *
 * This is a ratchet, not a design opinion: the numbers below are what each
 * agent measured after the 2026-08-16 workflow/standards split, and they may only go down. Lowering an entry
 * after real cleanup is the intended edit. Raising one is the thing under
 * test — do it deliberately, in review, with a reason.
 *
 * The oracle runs the production path (`normalizeAgent` ->
 * `buildAgentRuntimeGuidance`, the worker's description pick, the registry's
 * roster renderer over the agent's own skill directory) rather than
 * re-reading the JSON fields, so it measures what is actually handed to the
 * model, including the truncation `_profileTextList` applies on the way and
 * the description compaction the roster applies to each skill. The roster
 * block carries the shared header lines as well; they are the same for every
 * agent and are counted once per agent here.
 */

const AGENTS_ROOT = path.join(
  __dirname, '..', '..', '..', 'resources', 'builtin', 'marketplace', 'agents',
);

/** Per-agent ceiling in characters of `workflow` + runtime guidance +
 *  description + owned-skill roster, set just above each agent's measurement
 *  (2026-08-16 baseline of workflow + guidance; VideoStudio re-measured
 *  2026-08-20 after edit-intent routing, DeepResearcher after ledger-backed
 *  fetch budgets — both carry their own prompt audits; UIDesigner re-measured
 *  2026-08-26 after the read-only-repo rewrite moved detail into its Skill;
 *  StockAnalyser was measured at introduction on 2026-08-28 after its six
 *  route Skills absorbed conditional rules; every agent re-measured on
 *  2026-09-04 when the description and skill roster joined the gate, which
 *  had been counting only about half of the resident text). The headroom is
 *  deliberately about one percent: an ordinary wording fix fits, a new
 *  paragraph does not. */
const RECORDED_CEILING: Readonly<Record<string, number>> = {
  VideoStudio: 7_292,
  // Re-measured 2026-09-09 at 7,996 after the BACKLINK route joined the
  // surface: one workflow line naming `seo-backlink-value`, its roster
  // description, one knowhow line, and the routing terms in both
  // descriptions. The offer-valuation procedure itself lives in the Skill.
  SeoGeoAgent: 8_080,
  UIDesigner: 6_920,
  ImageStudio: 4_068,
  PptMaker: 3_925,
  ProductDeveloper: 3_274,
  DeepResearcher: 2_751,
  OfficeWorker: 2_444,
  ContentWriter: 1_936,
};

/** The corpus total matters on its own: nine agents each creeping under their
 *  own ceiling is still a shared regression, because a user with several
 *  agents in one group chat pays for all of them. */
const RECORDED_CORPUS_CEILING = 40_740; // 40,331 measured 2026-09-09 (SeoGeoAgent BACKLINK route)

interface AgentSurface {
  name: string;
  workflow: number;
  guidance: number;
  description: number;
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
  const description = _pickAgentRuntimeDescriptionForTest(agent);
  const specs = fs.existsSync(skillsRoot) ? new SkillLoader({ dirs: [skillsRoot] }).list() : [];
  const roster = specs.length ? await _renderSkillLinesForTest(specs, []) : '';
  return {
    name: agent.name || fallbackName,
    workflow: workflow.length,
    guidance: guidanceLength,
    description: description.length,
    skills: roster.length,
    total: workflow.length + guidanceLength + description.length + roster.length,
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

  it('finds the built-in agent corpus', () => {
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.every((row) => row.total > 0)).toBe(true);
  });

  it('does not let any agent grow its per-turn prompt surface', () => {
    const over = rows
      .filter((row) => row.total > (RECORDED_CEILING[row.name] ?? 0))
      .map((row) => `${row.name}=${row.total} (ceiling ${RECORDED_CEILING[row.name] ?? 0})`);
    expect(
      over,
      'this text is re-sent every turn; move conditional rules into a Skill, or raise the ceiling deliberately',
    ).toEqual([]);
  });

  it('does not let the corpus grow in aggregate', () => {
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    expect(total).toBeLessThanOrEqual(RECORDED_CORPUS_CEILING);
  });

  it('requires a newly added agent to declare its ceiling', () => {
    const undeclared = rows
      .filter((row) => RECORDED_CEILING[row.name] === undefined)
      .map((row) => `${row.name}=${row.total}`);
    expect(
      undeclared,
      'a new built-in agent states what it costs every turn before it ships',
    ).toEqual([]);
  });

  it('detects a paragraph added to a workflow', async () => {
    // Negative control. Without it this file only reports numbers, and a
    // measurement that cannot fail is not a gate. The mutation is the exact
    // shape of the regression: prose appended to `workflow`, which reads as an
    // ordinary documentation edit in a diff.
    const dir = path.join(AGENTS_ROOT, '79df9cc89f5f');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) as { workflow?: string };
    const skillsRoot = path.join(dir, 'skills');
    const baseline = await measure(raw, 'VideoStudio', skillsRoot);
    expect(baseline).not.toBeNull();
    expect(baseline!.total).toBeLessThanOrEqual(RECORDED_CEILING.VideoStudio);

    const grown = await measure(
      { ...raw, workflow: `${raw.workflow || ''}\n\n${'x'.repeat(400)}` },
      'VideoStudio',
      skillsRoot,
    );
    expect(grown!.total).toBeGreaterThan(RECORDED_CEILING.VideoStudio);
  });

  it('rejects moving UIDesigner source mechanics back into its resident workflow', async () => {
    const dir = path.join(AGENTS_ROOT, 'bcfcb4921dce');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) as {
      workflow?: string;
    };
    const skillsRoot = path.join(dir, 'skills');
    const baseline = await measure(raw, 'UIDesigner', skillsRoot);
    expect(baseline).not.toBeNull();
    expect(baseline!.total).toBeLessThanOrEqual(RECORDED_CEILING.UIDesigner);

    const duplicated = await measure({
      ...raw,
      workflow: `${raw.workflow || ''}\n\n- Keep a resident Source Authority Map with Preserve, Change, and Derive rows for every inspectable source.`,
    }, 'UIDesigner', skillsRoot);
    expect(duplicated!.total).toBeGreaterThan(RECORDED_CEILING.UIDesigner);
  });

  it('detects a sentence added to a description or an owned skill', async () => {
    // The two surfaces the gate did not see before 2026-09-04: a longer
    // description line, and a skill whose roster entry grows. Both are sent
    // on every turn exactly like the workflow.
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
    expect(longerDescription!.description).toBeGreaterThan(baseline!.description);
    expect(longerDescription!.total).toBeGreaterThan(RECORDED_CEILING.VideoStudio);

    const withoutSkills = await measure(raw, 'VideoStudio', path.join(dir, 'no-such-skills'));
    expect(baseline!.skills).toBeGreaterThan(0);
    expect(withoutSkills!.skills).toBe(0);
    expect(withoutSkills!.total).toBe(baseline!.total - baseline!.skills);
  });

  it('keeps every built-in routing description inside the agent roster ceiling', () => {
    // The Commander directory shortens longer descriptions with an ellipsis
    // and no other signal, and the tail is where authors put the trigger
    // list. A description over the ceiling therefore loses routing terms
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
    // Not a failure condition — a visible ranking, so the next person editing a
    // workflow can see how much room that agent has before it is spent.
    const report = rows
      .map((row) => `${row.name}=${row.total}(w${row.workflow}/g${row.guidance}/d${row.description}/s${row.skills})`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`[agent-prompt-surface] ${report}`);
    expect(rows[0].total).toBeGreaterThan(0);
  });
});
