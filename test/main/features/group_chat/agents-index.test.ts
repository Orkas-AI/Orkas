// Pin the `agents_index` block format used by `buildCommanderSystemPrompt`.
//
// Format (one entry per agent, ordered by insertion):
//   `\`read_file(<ROOT>/<id>/agent.json)\` — ROOT by Source:`
//   `- custom:  <abs path>`
//   `- builtin: <abs path>`
//   `Use these ROOT values verbatim. \`id:\` is tool-call input only — prose mentions agents as @<name>.`
//   ``
//   `- @<name> (Source: custom|builtin, id: <agent_id>) — desc`
//   `  inputs_schema: <slim json>`   ← optional, only when inputs[] non-empty
//
// Why these fixtures matter (added 2026-05): the prior format hid agent_id
// (to discourage hex-id leak in user prose) and put paths in a separate
// `## Resource locations` section, forcing commander to do a 2-step
// search_files + read_file dance to load any existing agent's spec. The
// new format inlines `id:` per entry + ROOT values right next to the
// entries, so commander goes 1 round-trip. Shipping this regression once
// would mean either (a) ROOT values gone → LLM falls back on training-prior
// `/data/custom/agents/<id>/` paths and trips E_PATH_OUT_OF_SCOPE, or
// (b) `id:` gone → commander can't find agent.json without the dance.
// The "@<name> in prose" hint relies on the existing `@<id>→@<name>`
// rewrite chain in router.ts; both layers together keep hex IDs out of
// user-visible bubbles.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-agents-idx';

function customAgentsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents');
}
function builtinAgentsDir(): string {
  return path.join(tmpDir, 'builtin', 'agents');
}

function writeAgent(root: string, agent_id: string, body: Record<string, unknown>) {
  const dir = path.join(root, agent_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent.json'),
    JSON.stringify({ agent_id, created_at: '2026-01-01', updated_at: '2026-01-01', ...body }),
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agentsidx-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Force fresh module loads so `BUILTIN_AGENTS_DIR` (module-level const
  // resolved at paths.ts import time) gets the test ORKAS_WORKSPACE_ROOT.
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildBlock(uid: string): Promise<string> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildAgentsIndexBlockForTest(uid);
}

describe('agents_index block — header + per-entry shape', () => {
  it('header carries Read pattern, resolved ROOT values, and anti-prior warning', async () => {
    writeAgent(customAgentsDir(), 'a1b2c3d4', { name: 'Alpha', description_zh: 'A', description_en: 'A' });
    writeAgent(builtinAgentsDir(), 'e5f6a7b8', { name: 'Beta', description_zh: 'B', description_en: 'B' });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('`read_file(<ROOT>/<id>/agent.json)`');
    expect(text).toContain(`- custom:  ${path.resolve(customAgentsDir())}`);
    expect(text).toContain(`- builtin: ${path.resolve(builtinAgentsDir())}`);
    expect(text).toContain('Use these ROOT values verbatim');
    expect(text).toContain('@<name>');
  });

  it('entry includes id: <agent_id> next to Source — commander needs it for read_file + <agent_id> sub-tag', async () => {
    writeAgent(customAgentsDir(), 'a1b2c3d4e5f6', { name: 'Reviewer', description_zh: 'R', description_en: 'R' });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@Reviewer (Source: custom, id: a1b2c3d4e5f6)');
  });

  it('inputs_schema is inlined as slim json on a continuation line when non-empty', async () => {
    writeAgent(customAgentsDir(), 'agent-with-inputs', {
      name: 'WithInputs',
      description_zh: 'I',
      description_en: 'I',
      inputs: [{ id: 'topic', type: 'text', required: true, default: '', label: 'Topic', description: 'should be stripped' }],
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('inputs_schema:');
    expect(text).toContain('"topic"');
    // narrative `description` field stripped from slim view
    expect(text).not.toContain('"should be stripped"');
  });

  it('returns header + (no agents) when no agents are present', async () => {
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('`read_file(<ROOT>/<id>/agent.json)`');
    expect(text).toContain('(no agents)');
  });
});
