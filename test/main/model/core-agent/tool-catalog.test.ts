import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG,
  DEEP_RESEARCH_AGENT_IDS,
  getToolsSystemPromptBlock,
  isToolVisibleToAgent,
} from '../../../../src/main/model/core-agent/tool-catalog';
import { getBuiltinTools } from '../../../../src/core-agent/src/tools';
import { createCrossSessionMemoryTool } from '../../../../src/core-agent/src/tools/memory-tool';
import { createMetacognitionTool } from '../../../../src/core-agent/src/tools/metacognition-tool';
import { createLocalTools, createFileTools } from '../../../../src/main/model/core-agent/local-tools';
import { createKbTools } from '../../../../src/main/model/core-agent/kb-tools';
import { createChatHistoryTools } from '../../../../src/main/model/core-agent/chat-history-tools';
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';
import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';

const DEEP_RESEARCH_SKILL_ID = 'ee99fbb42964';

const RERANK_OWNER_AGENT_RESOURCES = [
  { id: 'b6ddc5e6b432', name: '深度研究', kind: 'builtin', hasDeepResearchSkill: true },
  { id: '78900d8758bc', name: 'DeepResearcher', kind: 'builtin', hasDeepResearchSkill: true },
  { id: '5dd962efb425', name: 'KnowledgeManager', kind: 'resource', hasDeepResearchSkill: false },
  { id: '17c0a2e95df3', name: 'SocialResearcher', kind: 'resource', hasDeepResearchSkill: true },
  { id: '7083ff63b398', name: 'BrandResearcher', kind: 'resource', hasDeepResearchSkill: true },
] as const;

function pcRoot(): string {
  return fs.existsSync(path.join(process.cwd(), 'resources', 'builtin'))
    ? process.cwd()
    : path.resolve(process.cwd(), 'PC');
}

function agentJsonPath(spec: typeof RERANK_OWNER_AGENT_RESOURCES[number]): string {
  const pc = pcRoot();
  if (spec.kind === 'builtin') {
    return path.join(pc, 'resources', 'builtin', 'marketplace', 'agents', spec.id, 'agent.json');
  }
  return path.join(path.dirname(pc), 'Resource', 'agents', spec.id, 'agent.json');
}

/**
 * Collect the tool names runner.ts injects under "everything available"
 * conditions (uid known + metacognition enabled + permission granted + cid).
 *
 * Avoid buildRunner here because that pulls in auth / session / network; call
 * the same factories runner.ts uses to assemble allTools.
 */
function enumerateAllInjectedToolNames(): Set<string> {
  const names = new Set<string>();

  // core-agent builtins (always merged into AgentRunner's tool map)
  for (const t of getBuiltinTools()) names.add(t.name);

  // injected (memory + metacognition)
  names.add(
    createCrossSessionMemoryTool({
      add: async () => {},
      replace: async () => {},
      remove: async () => {},
      list: async () => '',
    }).name,
  );
  names.add(
    createMetacognitionTool({
      read: async () => '',
      write: async () => {},
    }).name,
  );

  // local + file + kb + image gen.
  // Pass cid + onArtifactCreated so `create_artifact` is included — runner.ts
  // wires both through for group-chat turns (see local-tools.createLocalTools).
  for (const t of createLocalTools({ userId: 'testuid', cid: 'testcid', onArtifactCreated: () => {} })) names.add(t.name);
  for (const t of createFileTools({ userId: 'testuid', cid: 'testcid' })) names.add(t.name);
  for (const t of createKbTools({ userId: 'testuid' })) names.add(t.name);
  for (const t of createChatHistoryTools({ userId: 'testuid' })) names.add(t.name);
  names.add(createImageGenTool({ userId: 'testuid', cid: 'testcid' }).name);
  for (const t of createOfficeTools({ userId: 'testuid', cid: 'testcid' })) names.add(t.name);

  // Connector umbrella meta-tools: two fixed tools, only injected when ≥1 connector is visible
  // to the actor. Asserting presence in the catalog independent of runtime visibility — calling
  // the factory here would short-circuit to [] without a manager mock, defeating the drift
  // check. Per-connector MCP actions discovered at runtime are NOT enumerated (they vary
  // per-user / per-install — see tool-catalog.ts header).
  names.add('list_connector_tools');
  names.add('call_connector_tool');

  return names;
}

describe('tool-catalog', () => {
  it('TOOL_CATALOG covers every tool name injected by runner (anti-drift)', () => {
    const injected = enumerateAllInjectedToolNames();
    const catalog = new Set(TOOL_CATALOG.map((e) => e.name));
    const missing = [...injected].filter((n) => !catalog.has(n));
    expect(missing, `Injected tools missing from TOOL_CATALOG: ${missing.join(', ')}`).toEqual([]);
  });

  it('TOOL_CATALOG has no duplicate names', () => {
    const names = TOOL_CATALOG.map((e) => e.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('empty names input returns an empty block', () => {
    expect(getToolsSystemPromptBlock([])).toBe('');
  });

  it('unknown names are skipped without throwing', () => {
    // Known + unknown should render only the known tool and still return a block.
    const out = getToolsSystemPromptBlock(['read_file', 'definitely_not_a_real_tool']);
    expect(out).toContain('read_file');
    expect(out).not.toContain('definitely_not_a_real_tool');
  });

  it('all unknown names return an empty block', () => {
    expect(getToolsSystemPromptBlock(['__nope_a__', '__nope_b__'])).toBe('');
  });

  it('same input produces the same output for KV-cache stability', () => {
    const names = ['read_file', 'bash', 'kb_search'];
    const a = getToolsSystemPromptBlock(names);
    const b = getToolsSystemPromptBlock([...names]);
    expect(a).toBe(b);
  });

  it('renders sections in group order and includes only matched groups', () => {
    // read_file (fs) + bash (shell) + kb_search (kb) -> fs/shell/kb order.
    const out = getToolsSystemPromptBlock(['kb_search', 'bash', 'read_file']);
    const fsIdx = out.indexOf('### Files / workspace');
    const shellIdx = out.indexOf('### Shell');
    const kbIdx = out.indexOf('### Library');
    expect(fsIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(fsIdx);
    expect(kbIdx).toBeGreaterThan(shellIdx);
    // Unmatched groups are omitted.
    expect(out).not.toContain('### PDF');
    expect(out).not.toContain('### Image');
  });

  it('permission-gated tools include a local-execution permission suffix', () => {
    const out = getToolsSystemPromptBlock(['bash', 'read_file']);
    // bash has permission='localExec'; read_file does not.
    const bashLine = out.split('\n').find((l) => l.includes('**bash**'));
    const readLine = out.split('\n').find((l) => l.includes('**read_file**'));
    expect(bashLine).toContain('local-execution permission');
    expect(readLine).not.toContain('local-execution permission');
  });
});

describe('isToolVisibleToAgent (ownerAgent gate)', () => {
  it('un-owned catalog tools are visible to every actor', () => {
    expect(isToolVisibleToAgent('read_file', '')).toBe(true);
    expect(isToolVisibleToAgent('generate_image', 'video-studio')).toBe(true);
    expect(isToolVisibleToAgent('generate_image', 'anything')).toBe(true);
  });

  it('tools absent from the catalog (extraTools / builtins) are never gated', () => {
    // commander dispatch tools + core-agent builtins aren't catalog entries
    expect(isToolVisibleToAgent('dispatch_to', '')).toBe(true);
    expect(isToolVisibleToAgent('run_worker', 'video-studio')).toBe(true);
  });

  it('an array ownerAgent makes the tool visible to EVERY listed agent', () => {
    const entry = TOOL_CATALOG.find((e) => e.name === 'research_rerank');
    expect(Array.isArray(entry?.ownerAgent)).toBe(true);
    expect(DEEP_RESEARCH_AGENT_IDS.length).toBeGreaterThan(1);
    expect(entry?.ownerAgent).toEqual(DEEP_RESEARCH_AGENT_IDS);
    for (const id of DEEP_RESEARCH_AGENT_IDS) {
      expect(isToolVisibleToAgent('research_rerank', id), id).toBe(true);
    }
  });

  it('research_rerank bundled owner ids match the in-repo agent resources', () => {
    const checked: string[] = [];
    for (const spec of RERANK_OWNER_AGENT_RESOURCES) {
      const file = agentJsonPath(spec);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const agent = JSON.parse(raw) as { agent_id?: string; name?: string; skill_list?: string[] };
      expect(agent.agent_id).toBe(spec.id);
      expect(agent.name).toBe(spec.name);
      expect(Array.isArray(agent.skill_list)).toBe(true);
      if (spec.hasDeepResearchSkill) {
        expect(agent.skill_list).toContain(DEEP_RESEARCH_SKILL_ID);
      }
      checked.push(spec.id);
    }
    expect(checked).toEqual(['b6ddc5e6b432', '78900d8758bc']);
  });

  it('an array ownerAgent still hides the tool from the commander and non-owners', () => {
    expect(isToolVisibleToAgent('research_rerank', '')).toBe(false);
    expect(isToolVisibleToAgent('research_rerank', 'video-studio')).toBe(false);
    expect(isToolVisibleToAgent('research_rerank', 'some-other-agent')).toBe(false);
  });
});
