import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG,
  getToolsSystemPromptBlock,
} from '../../../../src/main/model/core-agent/tool-catalog';
import { getBuiltinTools } from '../../../../src/core-agent/src/tools';
import { createCrossSessionMemoryTool } from '../../../../src/core-agent/src/tools/memory-tool';
import { createMetacognitionTool } from '../../../../src/core-agent/src/tools/metacognition-tool';
import { createLocalTools, createFileTools } from '../../../../src/main/model/core-agent/local-tools';
import { createKbTools } from '../../../../src/main/model/core-agent/kb-tools';
import { createChatHistoryTools } from '../../../../src/main/model/core-agent/chat-history-tools';
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';
import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';

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
