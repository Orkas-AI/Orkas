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
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';

/**
 * 收集 runner.ts 在"全开"条件下（uid 已知 + metacognition env on + permission
 * granted + 有 cid）会注入到 AgentRunner 的工具 name 集合。
 *
 * 不调 buildRunner（那会拽进 auth / session / network），直接调每个工厂——
 * runner.ts 也是一一调它们组装 allTools 的，源头一致。
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
  names.add(createImageGenTool({ userId: 'testuid', cid: 'testcid' }).name);

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
  it('TOOL_CATALOG 覆盖 runner 实际注入的所有工具 name（反漂移）', () => {
    const injected = enumerateAllInjectedToolNames();
    const catalog = new Set(TOOL_CATALOG.map((e) => e.name));
    const missing = [...injected].filter((n) => !catalog.has(n));
    expect(missing, `这些工具被注入但 TOOL_CATALOG 缺失：${missing.join(', ')}`).toEqual([]);
  });

  it('TOOL_CATALOG 没有重复 name', () => {
    const names = TOOL_CATALOG.map((e) => e.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('空 names 输入 → 空块', () => {
    expect(getToolsSystemPromptBlock([])).toBe('');
  });

  it('未知 name 不抛、被静默跳过', () => {
    // 已知 + 未知混合，应该只渲染已知那个，块非空
    const out = getToolsSystemPromptBlock(['read_file', 'definitely_not_a_real_tool']);
    expect(out).toContain('read_file');
    expect(out).not.toContain('definitely_not_a_real_tool');
  });

  it('全部 name 都未知 → 空块', () => {
    expect(getToolsSystemPromptBlock(['__nope_a__', '__nope_b__'])).toBe('');
  });

  it('同样输入产生同样输出（KV cache 友好）', () => {
    const names = ['read_file', 'bash', 'kb_search'];
    const a = getToolsSystemPromptBlock(names);
    const b = getToolsSystemPromptBlock([...names]);
    expect(a).toBe(b);
  });

  it('输出按 group 顺序分节，且只含命中分组', () => {
    // read_file (fs) + bash (shell) + kb_search (kb) → 三个分节按 fs/shell/kb 序
    const out = getToolsSystemPromptBlock(['kb_search', 'bash', 'read_file']);
    const fsIdx = out.indexOf('### Files / workspace');
    const shellIdx = out.indexOf('### Shell');
    const kbIdx = out.indexOf('### Knowledge base');
    expect(fsIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(fsIdx);
    expect(kbIdx).toBeGreaterThan(shellIdx);
    // 没命中的分组不出现
    expect(out).not.toContain('### PDF');
    expect(out).not.toContain('### Image');
  });

  it('权限门工具有 local-execution permission 后缀', () => {
    const out = getToolsSystemPromptBlock(['bash', 'read_file']);
    // bash 有 permission='localExec'，read_file 没有
    const bashLine = out.split('\n').find((l) => l.includes('**bash**'));
    const readLine = out.split('\n').find((l) => l.includes('**read_file**'));
    expect(bashLine).toContain('local-execution permission');
    expect(readLine).not.toContain('local-execution permission');
  });
});
