import {
  createExecutionPlanTool,
  getBuiltinTools,
  type AgentTool,
} from '../../../../src/core-agent/src/tools';
import { createCrossSessionMemoryTool } from '../../../../src/core-agent/src/tools/memory-tool';
import { createMetacognitionTool } from '../../../../src/core-agent/src/tools/metacognition-tool';
import { createChatHistoryTool } from '../../../../src/main/model/core-agent/chat-history-tools';
import { createFileTools, createLocalTools } from '../../../../src/main/model/core-agent/local-tools';
import { createGenerateSpeechTool } from '../../../../src/main/model/core-agent/generate-speech-tool';
import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';
import { createImageStudioTool } from '../../../../src/main/model/core-agent/image-studio-tool';
import { createLibraryTool } from '../../../../src/main/model/core-agent/kb-tools';
import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';
import { createPdfTools } from '../../../../src/main/model/core-agent/pdf-tools';

/**
 * Assemble the stable built-in tool corpus measured by both runner-facing
 * gates. Keeping this in one fixture makes the catalog anti-drift check and
 * the serialized-size budget measure the same surface instead of maintaining
 * two independently drifting factory lists.
 *
 * buildRunner is intentionally avoided because it pulls in auth, sessions and
 * network state. Owner-, project-, and run-state-specific tools have their own
 * focused tests. Dynamic per-user connector actions are likewise outside this
 * deterministic corpus; the two stable connector umbrella tools are exposed
 * separately by enumerateAllInjectedToolNames().
 */
export function enumerateAllInjectedTools(): AgentTool[] {
  const userId = 'tool-fixture-uid';
  const cid = 'tool-fixture-cid';
  const tools: AgentTool[] = [];

  tools.push(...getBuiltinTools().filter((tool) => tool.name !== 'read_file'));
  tools.push(createExecutionPlanTool({
    get: () => undefined,
    update: () => ({
      version: 1,
      objective: 'task',
      objectiveTurnId: 1,
      updatedTurnId: 1,
      revision: 1,
      steps: [{ id: 1, step: 'work', status: 'in_progress' }],
      nextStepId: 2,
      lastWorkLedgerId: 0,
      updatedAt: 1,
    }),
    clear: () => {},
  }));
  tools.push(createCrossSessionMemoryTool({
    add: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
    replace: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
    remove: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
    list: () => ({ ok: true, entries: [], usage: { current: 0, limit: 1 } }),
  }));
  tools.push(createMetacognitionTool({
    read: () => ({ ok: true, content: '', usage: { current: 0, limit: 1 } }),
    write: () => ({ ok: true, usage: { current: 0, limit: 1 } }),
  }, { competence: 3000, strategies: 2500 }));
  tools.push(...createLocalTools({
    userId,
    cid,
    onArtifactCreated: () => {},
    onOutputsPublished: (paths) => paths,
  }));
  tools.push(...createFileTools({ userId, cid, includeOcrFile: true }));
  tools.push(createLibraryTool({ userId }));
  tools.push(createChatHistoryTool({ userId }));
  tools.push(createImageGenTool({ userId, cid }));
  tools.push(createGenerateSpeechTool({ userId, cid }));
  tools.push(createImageStudioTool({ userId, cid }));
  tools.push(...createOfficeTools({ userId, cid }));
  tools.push(...createPdfTools({ userId, cid }));

  const byName = new Map<string, AgentTool>();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}

export function enumerateAllInjectedToolNames(): Set<string> {
  const names = new Set(enumerateAllInjectedTools().map((tool) => tool.name));

  // Runtime-/actor-specific factories are expensive or stateful to construct
  // in this pure fixture. Pin their canonical names so the anti-drift test
  // covers the complete in-process surface, not just runner.ts's common path.
  for (const name of [
    'tool_result',
    'project_instructions',
    'project_tasks',
    'video_studio',
    'list_connector_tools',
    'call_connector_tool',
    'add_custom_connector',
    'skill_search',
    'import_skill_package',
    'auto_tasks_list',
    'marketplace_search',
    'marketplace_request_install',
    'dispatch_to',
    'hand_off_to',
    'run_worker',
    'open_app_view',
    'app_health',
    'skill_manage',
    'tool_load',
  ]) names.add(name);
  return names;
}
