import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AGENT_GUIDANCE_ITEM_LIMIT,
  normalizeAgent,
} from '../../../src/main/features/agents';
import {
  _buildAgentInGroupSystemPromptForTest,
  _buildAgentRuntimeGuidanceForTest,
} from '../../../src/main/features/group_chat/bus';
import { BUILTIN_AGENT_TOOL_SURFACE_CASES } from '../model/core-agent/builtin-agent-tool-surface-fixture';

/**
 * `knowhow` is display-only and `standards` is resident runtime guidance;
 * neither is a procedural rule store. New authoring is capped at five items per field by agent-creator
 * and the host write boundary. Built-ins must meet the same contract directly:
 * no legacy allowance, silent item loss, or 220-character truncation. The
 * production normalizer still reports counts when legacy input exceeds its
 * compatibility limits; this suite requires the built-in corpus to have zero
 * such debt.
 */
const AGENTS_ROOT = path.join(
  __dirname, '..', '..', '..', 'resources', 'builtin', 'marketplace', 'agents',
);

type GuidanceField = 'knowhow' | 'standards';

interface AgentGuidanceReach {
  id: string;
  name: string;
  authored: Record<GuidanceField, string[]>;
  normalized: Record<GuidanceField, string[]>;
  guidance: string;
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

function measure(dir: string): AgentGuidanceReach | null {
  const file = path.join(AGENTS_ROOT, dir, 'agent.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    name?: string;
    knowhow?: unknown[];
    standards?: unknown[];
  };
  const agent = normalizeAgent(raw, 'builtin');
  if (!agent) return null;
  const authored = Object.fromEntries((['knowhow', 'standards'] as const).map((field) => [
    field,
    (Array.isArray(raw[field]) ? raw[field] : [])
      .filter((item): item is string => typeof item === 'string')
      .map(collapse)
      .filter(Boolean),
  ])) as Record<GuidanceField, string[]>;
  return {
    id: dir,
    name: raw.name || dir,
    authored,
    normalized: {
      knowhow: agent.profile?.knowhow || [],
      standards: agent.profile?.standards || [],
    },
    guidance: _buildAgentRuntimeGuidanceForTest(agent.profile),
  };
}

function measureAll(): AgentGuidanceReach[] {
  return fs.readdirSync(AGENTS_ROOT)
    .map(measure)
    .filter((row): row is AgentGuidanceReach => row !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe('built-in Agent runtime guidance contract', () => {
  const rows = measureAll();

  it('finds the complete built-in Agent corpus', () => {
    expect(rows.map(row => row.name).sort()).toEqual(
      BUILTIN_AGENT_TOOL_SURFACE_CASES.map(agent => agent.name).sort(),
    );
  });

  it('keeps knowhow and standards at five items or fewer', () => {
    const over = rows.flatMap((row) => (['knowhow', 'standards'] as const)
      .filter((field) => row.authored[field].length > AGENT_GUIDANCE_ITEM_LIMIT)
      .map((field) => `${row.name}.${field}=${row.authored[field].length}`));
    expect(over, 'merge resident guidance or move route-specific rules into Skills').toEqual([]);
  });

  it('normalizes both fields but injects only standards into runtime guidance', () => {
    for (const row of rows) {
      for (const field of ['knowhow', 'standards'] as const) {
        expect(row.normalized[field], `${row.name}.${field} normalization`).toEqual(row.authored[field]);
      }
      for (const item of row.authored.standards) {
        expect(row.guidance, `${row.name}.standards missing from runtime prompt`).toContain(item);
      }
      for (const item of row.authored.knowhow) {
        expect(row.guidance, `${row.name}.knowhow leaked into runtime prompt`).not.toContain(item);
      }
    }
  });

  it('keeps every item inside its display or runtime line budget', () => {
    const long = rows.flatMap((row) => (['knowhow', 'standards'] as const).flatMap((field) => (
      row.authored[field]
        .filter((item) => item.length > 220)
        .map((item) => `${row.name}.${field}=${item.length}`)
    )));
    expect(long, 'shorten the line instead of relying on runtime truncation').toEqual([]);
  });

  it.each(rows)('carries $name delivery criteria once into the real prompt while keeping capability display out', async ({ id, name }) => {
    const raw = JSON.parse(fs.readFileSync(path.join(AGENTS_ROOT, id, 'agent.json'), 'utf8'));
    const agent = normalizeAgent(raw, 'builtin');
    expect(agent?.name).toBe(name);
    for (const language of ['en', 'zh'] as const) {
      const prompt = await _buildAgentInGroupSystemPromptForTest(agent!, '/tmp/studio-guidance', language);
      expect(prompt.match(/^### Delivery standards$/gm)).toHaveLength(1);
      for (const standard of raw.standards) expect(prompt.split(standard), `${name}/${language}`).toHaveLength(2);
      for (const capability of raw.knowhow || []) expect(prompt, `${name}/${language}`).not.toContain(capability);
      expect(prompt).not.toMatch(/\$(?:workflow|agent_runtime_guidance|input_channel_protocol)/);
    }
  });

  it('reports the profile item count for each Agent', () => {
    // eslint-disable-next-line no-console
    console.log('[agent-guidance] ' + rows.map((row) => (
      `${row.name}=k${row.authored.knowhow.length}/s${row.authored.standards.length}`
    )).join(' '));
    expect(rows.length).toBeGreaterThan(0);
  });
});
