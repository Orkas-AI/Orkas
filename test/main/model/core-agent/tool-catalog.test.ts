import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG,
  DEEP_RESEARCH_AGENT_IDS,
  getToolsSystemPromptBlock,
  isToolVisibleToAgent,
} from '../../../../src/main/model/core-agent/tool-catalog';
import {
  getBuiltinTools,
  createExecutionPlanTool,
  SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS,
  TOOL_DESCRIPTION_SOFT_BUDGET_CHARS,
  toToolDefinition,
  type AgentTool,
} from '../../../../src/core-agent/src/tools';
import { createCrossSessionMemoryTool } from '../../../../src/core-agent/src/tools/memory-tool';
import { createMetacognitionTool } from '../../../../src/core-agent/src/tools/metacognition-tool';
import { createLocalTools, createFileTools } from '../../../../src/main/model/core-agent/local-tools';
import { createKbTools } from '../../../../src/main/model/core-agent/kb-tools';
import { createChatHistoryTools } from '../../../../src/main/model/core-agent/chat-history-tools';
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';
import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';

const DEEP_RESEARCH_SKILL_ID = 'ee99fbb42964';
const SOURCE_DESCRIPTION_BUDGET_EXCEPTIONS = new Set([
  'generate_image:/inputSchema/properties/output_path',
]);

const RERANK_OWNER_AGENT_RESOURCES = [
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
function enumerateAllInjectedTools(): AgentTool[] {
  const tools: AgentTool[] = [];

  // core-agent builtins (always merged into AgentRunner's tool map)
  tools.push(...getBuiltinTools());
  tools.push(createExecutionPlanTool({
    update: () => ({
      version: 1,
      objective: 'task',
      objectiveTurnId: 1,
      updatedTurnId: 1,
      revision: 1,
      steps: [{ step: 'work', status: 'in_progress' }],
      updatedAt: 1,
    }),
    clear: () => {},
  }));

  // injected (memory + metacognition)
  tools.push(
    createCrossSessionMemoryTool({
      add: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
      replace: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
      remove: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
      list: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
    }),
  );
  tools.push(
    createMetacognitionTool({
      read: () => ({ ok: true, content: '', usage: { current: 0, limit: 1 } }),
      write: () => ({ ok: true, usage: { current: 0, limit: 1 } }),
    }, { competence: 3000, strategies: 2500 }),
  );

  // local + file + kb + image gen.
  // Pass cid + onArtifactCreated so `create_artifact` is included — runner.ts
  // wires both through for group-chat turns (see local-tools.createLocalTools).
  tools.push(...createLocalTools({
    userId: 'testuid',
    cid: 'testcid',
    onArtifactCreated: () => {},
    onOutputsPublished: (paths) => paths,
  }));
  tools.push(...createFileTools({ userId: 'testuid', cid: 'testcid' }));
  tools.push(...createKbTools({ userId: 'testuid' }));
  tools.push(...createChatHistoryTools({ userId: 'testuid' }));
  tools.push(createImageGenTool({ userId: 'testuid', cid: 'testcid' }));
  tools.push(...createOfficeTools({ userId: 'testuid', cid: 'testcid' }));

  const byName = new Map<string, AgentTool>();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}

function enumerateAllInjectedToolNames(): Set<string> {
  const names = new Set(enumerateAllInjectedTools().map((t) => t.name));

  // Connector umbrella meta-tools: two fixed tools, only injected when ≥1 connector is visible
  // to the actor. Asserting presence in the catalog independent of runtime visibility — calling
  // the factory here would short-circuit to [] without a manager mock, defeating the drift
  // check. Per-connector MCP actions discovered at runtime are NOT enumerated (they vary
  // per-user / per-install — see tool-catalog.ts header).
  names.add('list_connector_tools');
  names.add('call_connector_tool');

  return names;
}

function walkSchemaDescriptions(
  schema: unknown,
  visit: (path: string, description: string) => void,
  path = '/inputSchema',
): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => walkSchemaDescriptions(item, visit, `${path}/${index}`));
    return;
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj.description === 'string') visit(path, obj.description);
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'description') continue;
    walkSchemaDescriptions(value, visit, `${path}/${escapePointerSegment(key)}`);
  }
}

function descriptionAtPath(schema: unknown, path: string): string | undefined {
  const parts = path
    .replace(/^\/inputSchema/, '')
    .split('/')
    .filter(Boolean);
  let cursor: unknown = schema;
  for (const part of parts) {
    const key = unescapePointerSegment(part);
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(key)];
    } else {
      cursor = (cursor as Record<string, unknown>)?.[key];
    }
  }
  return typeof (cursor as Record<string, unknown> | undefined)?.description === 'string'
    ? ((cursor as Record<string, unknown>).description as string)
    : undefined;
}

function escapePointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function providerGuidanceText(tool: AgentTool): string {
  const def = toToolDefinition(tool);
  return `${def.description}\n${JSON.stringify(def.inputSchema)}`.toLowerCase();
}

function normalizedDescription(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toolByName(name: string): AgentTool {
  const tool = enumerateAllInjectedTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool not enumerated: ${name}`);
  return tool;
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

  it('provider tool definitions preserve descriptions without a hard length cap', () => {
    const lost: string[] = [];
    for (const tool of enumerateAllInjectedTools()) {
      const def = toToolDefinition(tool);
      expect(def.description).toBe(normalizedDescription(tool.description));
      walkSchemaDescriptions(tool.inputSchema, (path, description) => {
        if (!description.trim()) return;
        const providerDescription = descriptionAtPath(def.inputSchema, path);
        if (!providerDescription?.trim()) lost.push(`${tool.name}:${path}`);
        expect(providerDescription).toBe(normalizedDescription(description));
      });
    }
    expect(lost).toEqual([]);
  });

  it('reports tool descriptions above the soft review budget without failing', () => {
    const overBudget: string[] = [];
    for (const tool of enumerateAllInjectedTools()) {
      if (normalizedDescription(tool.description).length > TOOL_DESCRIPTION_SOFT_BUDGET_CHARS) {
        overBudget.push(`${tool.name}:description=${tool.description.length}`);
      }
      walkSchemaDescriptions(tool.inputSchema, (path, description) => {
        const key = `${tool.name}:${path}`;
        if (normalizedDescription(description).length > SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS && !SOURCE_DESCRIPTION_BUDGET_EXCEPTIONS.has(key)) {
          overBudget.push(`${tool.name}:${path}.description=${description.length}`);
        }
      });
    }
    if (overBudget.length) {
      console.warn(
        `Tool descriptions above soft budget (${TOOL_DESCRIPTION_SOFT_BUDGET_CHARS}/${SCHEMA_DESCRIPTION_SOFT_BUDGET_CHARS} chars):`,
        overBudget,
      );
    }
    expect(overBudget).toEqual(expect.any(Array));
  });

  it('critical tools keep enough provider-visible guidance to choose and call them', () => {
    const checks: Record<string, string[]> = {
      read_file: ['read', 'charstart', 'charend', 'stat_file'],
      stat_file: ['total_chars', 'before', 'read_file'],
      search_files: ['path is unknown', 'substring', 'glob'],
      grep_files: ['pattern', 'glob', 'output_mode'],
      write_file: ['write', 'path', 'content'],
      edit_file: ['old_string', 'new_string', 'unique', 'e_stale'],
      publish_outputs: ['complete', 'final', 'paths', 'this turn'],
      create_artifact: ['interactive', 'files', 'path', 'content', 'index.html'],
      delete_file: ['confirmation', 'confirmation_token', 'path'],
      interactive_cli_start: ['live user stdin', 'command', 'purpose'],
      generate_image: ['generate', 'image', 'prompt', 'output_path', 'reference'],
      create_docx: ['paragraphs', 'tables', 'images', 'path'],
      create_xlsx: ['rows', 'sheets', 'formula', 'path'],
      create_pptx: ['slides', 'shapes', 'images', 'path'],
      cross_session_memory: ['remember', 'agent', 'shared', 'user', 'routing', 'language', 'proper nouns', 'add', 'replace', 'remove', 'list'],
      metacognition: ['competence', 'strategies', 'content limits', 'rejected', 'condense', 'read', 'write'],
    };

    const missing: string[] = [];
    for (const [name, needles] of Object.entries(checks)) {
      const text = providerGuidanceText(toolByName(name));
      for (const needle of needles) {
        if (!text.includes(needle)) missing.push(`${name}:${needle}`);
      }
    }
    expect(missing).toEqual([]);
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

  it('keeps delete_file confirmation guidance scoped to outside-workspace deletes', () => {
    const out = getToolsSystemPromptBlock(['delete_file']);
    expect(out).toContain('Files inside the current workspace/attachment/editor scope are deleted immediately');
    expect(out).toContain('files outside that scope use an inline confirmation card');
    expect(out).not.toContain('The first call shows an inline confirmation card');
  });
});

describe('isToolVisibleToAgent (ownerAgent gate)', () => {
  it('un-owned catalog tools are visible to every actor', () => {
    expect(isToolVisibleToAgent('read_file', '')).toBe(true);
    expect(isToolVisibleToAgent('generate_image', 'image-studio')).toBe(true);
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
    expect(checked).toEqual(['78900d8758bc']);
  });

  it('an array ownerAgent still hides the tool from the commander and non-owners', () => {
    expect(isToolVisibleToAgent('research_rerank', '')).toBe(false);
    expect(isToolVisibleToAgent('research_rerank', 'video-studio')).toBe(false);
    expect(isToolVisibleToAgent('research_rerank', 'some-other-agent')).toBe(false);
  });
});
