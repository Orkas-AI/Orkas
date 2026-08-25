import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeAgent } from '../../../src/main/features/agents';
import { _buildAgentRuntimeGuidanceForTest } from '../../../src/main/features/group_chat/bus';

/**
 * What a built-in agent charges the user for every single turn.
 *
 * `workflow` goes into `chat_agent_in_group` verbatim (`bus.ts:5535`, trimmed
 * only), and `role`/`standards` come back from
 * `buildAgentRuntimeGuidance`. Together they are the agent-authored resident
 * surface: unlike a Skill, nothing about them is conditional, so a paragraph
 * added here is re-sent on every turn of every conversation with that agent,
 * whether or not the turn has anything to do with it.
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
 * `buildAgentRuntimeGuidance`) rather than re-reading the JSON fields, so it
 * measures what is actually handed to the model, including the truncation
 * `_profileTextList` applies on the way.
 */

const AGENTS_ROOT = path.join(
  __dirname, '..', '..', '..', 'resources', 'builtin', 'marketplace', 'agents',
);

/** Per-agent ceiling in characters of `workflow` + runtime guidance, set just
 *  above each agent's measurement (2026-08-16 baseline; VideoStudio re-measured
 *  2026-08-20 after edit-intent routing, DeepResearcher after ledger-backed
 *  fetch budgets — both carry their own prompt audits). The headroom is
 *  deliberately about one percent: an ordinary wording fix fits, a new
 *  paragraph does not. */
const RECORDED_CEILING: Readonly<Record<string, number>> = {
  ProductDeveloper: 2_870,
  SeoGeoAgent: 2_710,
  VideoStudio: 2_500,
  UIDesigner: 2_367,
  PptMaker: 2_211,
  DeepResearcher: 2_120,
  OfficeWorker: 2_039,
  ImageStudio: 1_768,
  ContentWriter: 1_731,
};

/** The corpus total matters on its own: nine agents each creeping under their
 *  own ceiling is still a shared regression, because a user with several
 *  agents in one group chat pays for all of them. */
const RECORDED_CORPUS_CEILING = 20_040;

interface AgentSurface {
  name: string;
  workflow: number;
  guidance: number;
  total: number;
}

/** Measure one agent the way the group-chat worker prompt assembles it. */
function measure(raw: unknown, fallbackName: string): AgentSurface | null {
  const agent = normalizeAgent(raw, 'builtin') as
    | { name?: string; workflow?: string; profile?: unknown }
    | null;
  if (!agent) return null;
  const workflow = String(agent.workflow || '').trim();
  const guidance = _buildAgentRuntimeGuidanceForTest(agent.profile);
  const guidanceLength = guidance === '(none)' ? 0 : guidance.length;
  return {
    name: agent.name || fallbackName,
    workflow: workflow.length,
    guidance: guidanceLength,
    total: workflow.length + guidanceLength,
  };
}

function measureAll(): AgentSurface[] {
  return fs.readdirSync(AGENTS_ROOT)
    .map((dir) => {
      const file = path.join(AGENTS_ROOT, dir, 'agent.json');
      if (!fs.existsSync(file)) return null;
      return measure(JSON.parse(fs.readFileSync(file, 'utf8')), dir);
    })
    .filter((row): row is AgentSurface => row !== null)
    .sort((left, right) => right.total - left.total);
}

describe('built-in agent resident prompt surface', () => {
  const rows = measureAll();

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

  it('detects a paragraph added to a workflow', () => {
    // Negative control. Without it this file only reports numbers, and a
    // measurement that cannot fail is not a gate. The mutation is the exact
    // shape of the regression: prose appended to `workflow`, which reads as an
    // ordinary documentation edit in a diff.
    const file = path.join(AGENTS_ROOT, '79df9cc89f5f', 'agent.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { workflow?: string };
    const baseline = measure(raw, 'VideoStudio');
    expect(baseline).not.toBeNull();
    expect(baseline!.total).toBeLessThanOrEqual(RECORDED_CEILING.VideoStudio);

    const grown = measure(
      { ...raw, workflow: `${raw.workflow || ''}\n\n${'x'.repeat(400)}` },
      'VideoStudio',
    );
    expect(grown!.total).toBeGreaterThan(RECORDED_CEILING.VideoStudio);
  });

  it('reports the per-turn cost of each agent', () => {
    // Not a failure condition — a visible ranking, so the next person editing a
    // workflow can see how much room that agent has before it is spent.
    const report = rows
      .map((row) => `${row.name}=${row.total}(w${row.workflow}/g${row.guidance})`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`[agent-prompt-surface] ${report}`);
    expect(rows[0].total).toBeGreaterThan(0);
  });
});
