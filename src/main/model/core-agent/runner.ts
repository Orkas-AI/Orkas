/**
 * Runner factory — assembles a fresh `AgentRunner` per chat request.
 *
 * Priority-list driven:
 *   - `pickChatEntry()` returns the first usable (provider, model, apiKey)
 *     tuple from the user-ordered entries list (see features/auth.ts).
 *   - The runner rebuilds `defaultProvider` + `defaultModel` to match that
 *     choice on every build, so the entries list is the single source of
 *     truth for "what model am I talking to right now".
 *   - Cheap: we use pi-ai through a per-build `ProviderRegistry` and only
 *     materialize the single provider we picked.
 *
 * When `pickChatEntry()` returns null we fail fast with a user-facing
 * "no model configured" error so the renderer doesn't surface the Anthropic SDK's
 * cryptic "Could not resolve authentication method" message. Dev escape
 * hatch: set `ANTHROPIC_API_KEY` in the environment and we pass through
 * to the SDK's default-provider + env-var auth path.
 */

import type { AgentTool, HistoryResource, LLMProvider, ToolContext, ToolResult } from '#core-agent';
import * as path from 'node:path';

import {
  pickChatEntryGroup,
  bumpEntryLastUsed,
  hasConfiguredModel,
  getConfiguredModelCooldown,
  getConfiguredModelOAuthExpiredMessage,
  type ChatEntryChoice,
} from '../../features/auth';
import { getSystemPromptBlock, getSystemSkillsPromptBlock } from './skill-registry';
import { t } from '../../i18n';
// tool-catalog.ts: TOOL_CATALOG kept as the source of truth for the drift
// test (tool-catalog.test.ts asserts injected names ⊆ catalog) and for any
// future targeted use; runtime no longer renders the prompt block from it.
import { getSession, memoryScopeForSession, sessionKindOf, toolResultsDirForSession } from './session-store';
import {
  addEntry,
  replaceEntry,
  removeEntry,
  listEntries,
  formatForSystemPrompt as formatMemoryForSystemPrompt,
  type MemoryScope,
} from '../../features/memory';
import {
  formatProjectContextPolicyForSystemPrompt,
  formatProjectInstructionsForSystemPrompt,
  writeProjectInstructions,
} from '../../features/projects';
import * as projectTasks from '../../features/project_tasks';
import * as metacognition from '../../features/metacognition';
import { appendAgentSkill, listAgents } from '../../features/agents';
const log = createLogger('model/runner');
import { createLocalTools, createFileTools } from './local-tools';
import { createOfficeTools } from './office-tools';
import { officeCliAvailable } from '../../features/office/office_engine';
import { createKbTools } from './kb-tools';
import { createChatHistoryTools } from './chat-history-tools';
import { createImageGenTool } from './image-gen-tool';
import { createVideoStudioTool } from './video-studio-tool';
import { createResearchRerankTool } from './research-rerank-tool';
import { isToolVisibleToAgent } from './tool-catalog';
import { createWebSearchOverrideTool } from './search-tools';
import {
  agentEvolvedSkillsDir,
  agentPrivateSkillsDir,
  userMarketplaceAgentSkillsDir,
  userSystemSkillsDir,
} from '../../paths';
import { artifactDirForConversation } from '../../util/project-layout';
import {
  capToolResult,
  DEFAULT_INLINE_RESULT_TOKENS,
} from '../../util/tool-result-cap';
import { createToolResultTools } from './tool-result-tools';
import {
  buildMoonshotModel,
  buildDeepSeekModel,
  buildDoubaoModel,
  createMoonshotProvider,
  createDeepSeekProvider,
  createDoubaoProvider,
} from './external-providers';
import { createRotatingProvider, type RotatingCandidate } from './rotating-provider';
import { clearCooldown } from './profile-cooldown';
import { EXTERNAL_API_PROVIDERS, resolveConfiguredPiModel } from '../provider_catalog';
import { readDisabledSets } from '../../features/component_enabled';
import { nativeSearchToolForApi, nativeSearchToolName } from './native-search-tools';
import { hasAnySearchProfile } from '../../features/search_auth';
import { createConnectorMetaTools, getConnectorPromptBlock } from './connector-meta-tools';
import { createLogger } from '../../logger';
import { logErrorSummary, maskId } from '../../util/log-redact';
import type { MemoryToolHandler } from '../../../core-agent/src/tools/memory-tool';
import type { MetacognitionToolHandler } from '../../../core-agent/src/tools/metacognition-tool';

const runnerLog = createLogger('runner');

function isNativeSearchEnabled(): boolean {
  return true;
}

function buildExternalProviderModel(providerId: string, modelId: string): { contextWindow?: number; maxTokens?: number } | null {
  switch (providerId) {
    case 'moonshot':
      return buildMoonshotModel(modelId);
    case 'deepseek':
      return buildDeepSeekModel(modelId);
    case 'doubao':
      return buildDoubaoModel(modelId);
    default:
      return null;
  }
}

function modelCatalogEntryFromModel(
  model: { contextWindow?: number; maxTokens?: number } | null | undefined,
): { contextWindow?: number; maxOutputTokens?: number } | null {
  if (!model) return null;
  const entry: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    entry.contextWindow = model.contextWindow;
  }
  if (typeof model.maxTokens === 'number' && model.maxTokens > 0) {
    entry.maxOutputTokens = model.maxTokens;
  }
  return Object.keys(entry).length ? entry : null;
}

type CA = typeof import('#core-agent');
type AgentRunnerCtor = CA['AgentRunner'];
type AgentRunnerInstance = InstanceType<AgentRunnerCtor>;
type CoreAgentConfig = ReturnType<CA['createConfig']>;

let _caPromise: Promise<CA> | null = null;
function applyRetryErrorPolicy(mod: CA): void {
  try {
    mod.configureRetryErrorPolicy();
  } catch (err) {
    runnerLog.warn('retry error policy sync failed', { error: logErrorSummary(err) });
  }
}

async function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  const mod = await _caPromise;
  applyRetryErrorPolicy(mod);
  return mod;
}

/** No-op retained for backward compat; nothing is cached anymore. */
export function invalidateConfig(): void {}

function _intersectRenderAllowlist(
  agentList: readonly string[] | undefined,
  projectList: readonly string[] | undefined,
): readonly string[] | undefined {
  if (projectList === undefined) return agentList;
  if (agentList === undefined) return projectList;
  const agentSet = new Set(agentList);
  return projectList.filter((id) => agentSet.has(id));
}

export interface BuildRunnerParams {
  sessionId: string;
  systemPrompt?: string;
  userId?: string;
  /** Conversation id. Used by file-tools to scope read_file / search_file
   *  / process_file_full calls whose path targets the attachment dir of the
   *  current conv. */
  cid?: string;
  /** Stable id for the current visible actor/model turn. Used by delete_file
   *  confirmation UI so batching never crosses prior conversation turns. */
  turnId?: string;
  /** Current real user text, used by tools that must bind an approval action
   * to explicit user intent rather than merely to the existence of a turn. */
  userMessage?: string;
  /** Project id of the conversation, when it belongs to one. Threaded
   *  through to local-tools / file-tools / image-gen-tool so workspace
   *  resolution picks up the project-scoped selection. Resolved once at
   *  the top of group_chat::runTurn from `conv.project_id`. */
  projectId?: string;
  /** Agent id bound to the conversation. Empty/undefined = default scope. */
  agentId?: string;
  /** Human-readable actor name used in user-facing local permission prompts. */
  agentName?: string;
  /** Max tool-call rounds per turn before force-end. Undefined → core-agent
   *  default (50). Group chat raises it for the commander's long builds. */
  maxToolLoops?: number;

  /** Optional subset of skill ids; undefined = full global listing. See
   * `skill-registry.getSystemPromptBlock` for the exact semantics. */
  skillList?: string[];
  /** Project-scope skill allowlist applied ONLY to the System A render
   *  block (`getSystemPromptBlock`). When present, the rendered allowlist
   *  is `intersect(skillList, projectAllowedSkillIds)`; SkillStore (System
   *  B, agent self-evolved skills) stays gated by `skillList` alone so
   *  agents in projects retain access to their own evolved skills. See
   *  CLAUDE.md §6 + `features/projects.ts::resolveProjectScope`. */
  projectAllowedSkillIds?: readonly string[];
  /** User-explicit skill refs selected in the composer. These are rendered
   *  even when they live in open/global skill roots that are normally lazy. */
  forceOpenSkillRefs?: readonly string[];
  /** Extra tools added to core-agent's builtins (e.g. group_chat commander
   * gets dispatch tools (`run_worker` / `dispatch_to`) plus marketplace /
   * skill-search / automation-listing tools). */
  extraTools?: AgentTool[];
  /** Extra absolute directory roots whitelisted for file-tools (read_file /
   *  stat_file / search_files / grep_files) on top of workspace + attachment.
   *  Read AND write are permitted under these roots. Used by per-skill
   *  edit chats to expose the skill dir. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: read tools (read_file / search_files /
   *  grep_files / stat_file) can see them, but write-side tools
   *  (edit_file / write_file / bash / markdown_to_pdf / html_to_pdf /
   *  generate_image and other write-capable tools) cannot mutate paths inside.
   *  Used by group-chat commander to inspect agent / skill specs without
   *  giving direct-write access — the structured `<agent>` / `<skill>`
   *  containers are the only sanctioned mutation channels for those resources. */
  readOnlyExtraRoots?: readonly string[];
  /** Additional file-tool-only read roots. Like `readOnlyExtraRoots`, these
   *  are never passed to localTools, so `delete_file` and other local-exec
   *  tools cannot act on them. Used for user-approved read-only folder grants. */
  fileReadOnlyExtraRoots?: readonly string[];
  /** Fires with the absolute path after each successful `write_file` /
   * `markdown_to_pdf` / `html_to_pdf` call or tracked bash output file. See `model/client.ts`
   * `ChatOptions.onFileWritten` for the caller-facing contract. */
  onFileWritten?: (absPath: string) => void | Promise<void>;
  /** Turn owner validation hook for the `publish_outputs` tool. */
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  /** Caller-supplied predicate consumed by write-style tools' uniquify
   *  logic. See `model/client.ts` `ChatOptions.hasProducedPath`. */
  hasProducedPath?: (absPath: string) => boolean;
  /** Fires after each successful `create_artifact` call. See `model/client.ts`
   *  `ChatOptions.onArtifactCreated`. */
  onArtifactCreated?: (a: { id: string; title: string }) => void;
  /** Fires once per skill id rendered into the system-prompt skills index,
   *  with its source system. Called at runner build time (before the LLM
   *  sees the prompt). Bus collects per turn for `skill_advertised`. */
  onSkillAdvertised?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B') => void;
  /** Fires when `read_file` resolves to a SKILL.md path inside any of the
   *  three skill roots. Bus collects per turn for `skill_invoked`. */
  onSkillInvoked?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B', trigger: 'read_file') => void;
  /** Fires when the pi-ai onPayload hook injects a vendor native web search
   *  tool schema for this call. Used by client.ts to record a synthetic
   *  `progress/native_search/injected` event into the devtools archive.
   *  May fire multiple times per chat turn if rotating-provider falls over
   *  to a secondary candidate. */
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void;
  /** Fires when rotating-provider commits to a candidate (success) or
   *  surfaces a non-rotatable error (failure). Used by client.ts to update
   *  the dev archive's recorded model / provider / profile so the stored
   *  row reflects the candidate that actually owned the visible outcome,
   *  not the rotating-provider's primary label. Fires at most once per
   *  call; not invoked when rotation rolls past a candidate. */
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string }) => void;
}

export interface NativeSearchInjectedInfo {
  provider: string;
  model: string;
  api: string;
  tool: string;
}

/** Tool definition snapshot persisted to the dev-only LLM archive so the
 * debug panel can show "what tools did the LLM actually see for this call".
 * Mirrors the AgentTool shape minus the executor closure (which is not
 * serialisable). */
export interface ToolDefSnapshot {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `'core-agent'` = pi-ai builtin (read_file / write_file / bash / web_search / web_fetch / list_files);
   *  `'orkas'` = injected by buildRunner (overrides + extras like memory, kb, image_gen, web_search override);
   *  `'extra'` = passed by caller via `extraTools` (group_chat commander uses this for dispatch + marketplace / skill / automation tools). */
  source: 'core-agent' | 'orkas' | 'extra';
}

function splitVolatilePromptTail(prompt: string | undefined): { stable: string; volatileTail: string } {
  const raw = (prompt || '').trim();
  if (!raw) return { stable: '', volatileTail: '' };
  const marker = '\n\n---\n\n## Current date\n';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return { stable: raw, volatileTail: '' };
  const stable = raw.slice(0, idx).trim();
  const volatileTail = raw.slice(idx + 2).trim();
  return { stable, volatileTail };
}

function splitCommanderAgentsBlock(prompt: string): { stable: string; agentsBlock: string } {
  const marker = '\n\n### Agents list\n\n';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, agentsBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    agentsBlock: prompt.slice(blockStart, blockEnd).trim().replace(/^### Agents list/, '## Agents list'),
  };
}

function splitRuntimeInjectionBlock(prompt: string): { stable: string; runtimeInjectionBlock: string } {
  const marker = '\n\n## Runtime injection';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, runtimeInjectionBlock: '' };
  const blockStart = idx + 2;
  return {
    stable: prompt.slice(0, idx).trim(),
    runtimeInjectionBlock: prompt.slice(blockStart).trim(),
  };
}

/**
 * Peel the commander's `## Orchestration state` section out of the cached
 * prefix. Its body renders the per-turn `orchestration_ledger` JSON (status,
 * updated_at, interrupted_at, …), which changes every commander turn while an
 * agent handoff / form / dispatch pause is live. Left in place — it sits near
 * the TOP of chat_commander.md, far ahead of `## Runtime injection` — any
 * ledger change invalidates the whole Anthropic cache prefix after it (~7-9K
 * tokens re-billed at full input price per turn). Relocating the whole H2
 * section to the volatile region keeps the cached prefix stable and follows
 * CLAUDE.md's "runtime-volatile prompt fields go in one trailing section"
 * rule. The header is already H2 so no heading rewrite is needed.
 */
function splitCommanderOrchestrationBlock(prompt: string): { stable: string; orchestrationBlock: string } {
  const marker = '\n\n## Orchestration state';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, orchestrationBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    orchestrationBlock: prompt.slice(blockStart, blockEnd).trim(),
  };
}

/** Exported for unit tests — see runner.test.ts. */
export const _splitCommanderOrchestrationBlock = splitCommanderOrchestrationBlock;

export async function buildRunner(params: BuildRunnerParams): Promise<{
  runner: AgentRunnerInstance;
  resolvedSystemPrompt: string;
  /** Per-turn volatile blocks (orchestration ledger / plan / datetime) peeled
   *  OUT of the system prompt to keep the cache prefix stable; the caller
   *  forwards this as `runStream({ turnEphemeral })` so it rides this turn's
   *  user message instead. Empty for runs with no volatile blocks. */
  turnEphemeral: string;
  entryId?: string;
  profileId?: string;
  providerId: string;
  modelId: string;
  /** Final tool set visible to the LLM (after last-write-wins merge of
   *  core-agent builtins + buildRunner-injected + caller-supplied extras).
   *  Used by the dev-only archiver. */
  toolDefs: ToolDefSnapshot[];
  /** UI-only skill display names collected while rendering the prompt block.
   *  Not injected into model context; reused for process-log labels. */
  skillDisplayNameById: Map<string, string>;
  /** UI-only agent display names collected once before the run.
   *  Not injected into model context; reused for process-log labels. */
  agentDisplayNameById: Map<string, string>;
}> {
  // Auth gate first — if no group has any usable candidate, fail before
  // loading core-agent / scanning skills / opening a session file. Gives
  // a clear user message instead of the Anthropic SDK's "Could not
  // resolve authentication method".
  const group = await pickChatEntryGroup();
  const primary: ChatEntryChoice | undefined = group[0];
  if (!primary && !process.env.ANTHROPIC_API_KEY) {
    const oauthExpiredMessage = getConfiguredModelOAuthExpiredMessage();
    if (oauthExpiredMessage) throw new Error(oauthExpiredMessage);
    const cooldown = getConfiguredModelCooldown();
    if (cooldown) {
      const seconds = Math.max(1, Math.ceil((cooldown.cooledUntil - Date.now()) / 1000));
      throw new Error(t('errors.model_temporarily_unavailable', { seconds }));
    }
    if (hasConfiguredModel().configured) {
      throw new Error(t('errors.model_config_unavailable'));
    }
    throw new Error(t('errors.no_model_configured'));
  }

  // Per-user disabled-skill set; passed into getSystemPromptBlock so the
  // rendered `## Available skills` block excludes user-disabled skills regardless
  // of agent-level allowlist. Resolved off the active uid; session_id no longer
  // carries the uid (CLAUDE.md §5), so callers that don't pass `params.userId`
  // fall through to the active-user singleton. Wrapped in a try/catch so ad-hoc
  // test paths that activate no user just see a null uid → empty disabled set.
  const earlyUid = params.userId || _safeActiveUserId();
  const disabledSkillIds = earlyUid ? readDisabledSets(earlyUid).skills : new Set<string>();

  // System A render allowlist = intersect(skillList, project bindings).
  //   - no project scope (`projectAllowedSkillIds` undefined) → legacy
  //     `skillList`-only behavior
  //   - commander in a project (`skillList` undefined, project list set) →
  //     project list governs the render block
  //   - agent in a project (both set) → intersection
  // SkillStore (System B) stays gated by `skillList` alone — see line ~429.
  const renderAllowlist = _intersectRenderAllowlist(params.skillList, params.projectAllowedSkillIds);
  const skillDisplayNameById = new Map<string, string>();
  const systemSkillsVisible = systemSkillsExposureFromSessionId(params.sessionId);
  const openSkillSourcesVisible = openSkillSourcesExposureFromSessionId(params.sessionId);
  const [mod, session, systemSkillsBlock, skillsBlock] = await Promise.all([
    ca(),
    getSession(params.sessionId),
    systemSkillsVisible ? getSystemSkillsPromptBlock(earlyUid || undefined) : Promise.resolve(''),
    getSystemPromptBlock({
      ...(renderAllowlist === undefined ? {} : { allowlist: [...renderAllowlist] }),
      disabledIds: disabledSkillIds,
      // Acting agent id gates agent-private (`ownerAgent`) skills: an agent's
      // own internal skills render for it, but never for the commander or
      // other agents. Empty for commander/non-agent sessions.
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.onSkillAdvertised ? { onSkillAdvertised: params.onSkillAdvertised } : {}),
      displayNameById: skillDisplayNameById,
      ...(openSkillSourcesVisible ? { includeOpenSources: true } : {}),
      ...(params.forceOpenSkillRefs?.length ? { forceOpenSkillRefs: [...params.forceOpenSkillRefs] } : {}),
    }),
  ]);

  const providerId = primary?.provider || 'anthropic';
  const modelId    = primary?.model    || 'claude-opus-4-8';

  // Build tools array: memory tool + metacognition tool. Assembly stays
  // above the system-prompt build because finalToolNames is still snapshotted
  // for the dev archive after this section.
  const uid = params.userId || _safeActiveUserId();
  const agentId = params.agentId || '';
  // Cross-session memory eligibility + per-agent scope (null = not eligible →
  // no tool, no injection). See memoryScopeForSession for the per-kind rule.
  const memoryAgentScope = memoryScopeForSession(params.sessionId, agentId);
  // The commander (the project's orchestrator conversation, `gconv`) owns the
  // two project-wide stores: it may WRITE project instructions (ORKAS.md, via
  // the `project_instructions` tool) and project memory. Dispatched sub-agents
  // (gmember / gworker / cli) get read-only access to both. Derived from the
  // immutable session id, so it can't drift mid-session.
  const isCommander = sessionKindOf(params.sessionId) === 'gconv';
  const agentDisplayNameById = new Map<string, string>();
  if (uid) {
    try {
      for (const agent of await listAgents()) {
        if (agent?.agent_id) agentDisplayNameById.set(agent.agent_id, agent.name || agent.agent_id);
      }
    } catch (err) {
      log.warn('agent display-name scan failed', { user_id: maskId(uid), error: logErrorSummary(err) });
    }
  }
  const agentName = (params.agentName || (agentId ? agentDisplayNameById.get(agentId) : '') || agentId || '').trim();
  const injectedTools: AgentTool[] = [];

  const recordHistoryResource = (resource: HistoryResource) => {
    try {
      session.addHistoryResource(resource);
    } catch (err) {
      log.warn('history resource registration failed', {
        session_id: maskId(params.sessionId),
        kind: resource.kind,
        error: logErrorSummary(err),
      });
    }
  };
  const onArtifactCreatedForHistory = params.onArtifactCreated
    ? (a: { id: string; title: string }) => {
        try {
          params.onArtifactCreated!(a);
        } finally {
          if (uid && params.cid) {
            recordHistoryResource({
              kind: 'final_output',
              path: path.join(artifactDirForConversation(uid, params.cid, a.id), 'index.html'),
              name: a.title || a.id,
              note: 'Interactive app artifact entry point.',
            });
          }
        }
      }
    : undefined;

  if (uid && memoryAgentScope) {
    // Cross-session memory. `agent` tier binds to THIS caller's scope and
    // `project` to THIS conversation's project, so the model can never reach
    // another agent's or project's store; `shared`/`user` are global. The
    // `project` tier exists only in project sessions — outside a project it is
    // absent from the tool schema entirely (see memory-tool.ts).
    const scopeId = memoryAgentScope; // narrowed to string
    const projectScopeId = params.projectId || '';
    const toScope = (tier: 'agent' | 'project' | 'shared' | 'user'): MemoryScope =>
      tier === 'agent' ? { agent: scopeId }
      : tier === 'project' ? { project: projectScopeId }
      : tier === 'shared' ? 'memory' : 'user';
    const memoryHandler: MemoryToolHandler = {
      add: (tier, content) => addEntry(uid, toScope(tier), content),
      replace: (tier, oldText, content) => replaceEntry(uid, toScope(tier), oldText, content),
      remove: (tier, oldText) => removeEntry(uid, toScope(tier), oldText),
      list: (tier) => listEntries(uid, toScope(tier)),
    };
    const { createCrossSessionMemoryTool } = await import('../../../core-agent/src/tools/memory-tool');
    // Project memory: commander read+write, sub-agents read-only (list only).
    injectedTools.push(createCrossSessionMemoryTool(memoryHandler, {
      includeProjectTier: !!projectScopeId,
      projectTierReadOnly: !!projectScopeId && !isCommander,
    }));
  }

  // Project tasks: the project's shared, structured work backlog. Real work
  // sessions in a project only (commander + agents) — gated like the memory
  // project tier (`memoryAgentScope`), so edit / one-shot / reflection sessions
  // never get it. Owner is a display NAME here (best-effort — the store
  // validates a resolved id when the UI supplies one; the name is kept for
  // display).
  if (uid && memoryAgentScope && params.projectId) {
    const pid = params.projectId;
    const cid = params.cid || '';
    const toView = (task: import('../../features/project_tasks').ProjectTask) => projectTasks.taskView(task);
    const projectTasksHandler = {
      list: async () => {
        const tasks = await projectTasks.listTasks(uid, pid);
        return { ok: true, tasks: tasks.map(toView), progress: projectTasks.computeProgress(tasks) };
      },
      create: async (input: { title: string; detail?: string; owner?: string; status?: projectTasks.TaskStatus }) => {
        const r = await projectTasks.createTask(uid, pid, {
          title: input.title,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.owner ? { owner_agent: input.owner } : {}),
          created_by: 'agent',
          ...(cid ? { origin_cid: cid } : {}),
        });
        return r.ok ? { ok: true, task: toView(r.task) } : { ok: false, error: (r as { error: string }).error };
      },
      update: async (taskId: string, patch: { title?: string; detail?: string; status?: projectTasks.TaskStatus; owner?: string; result_ref?: string }) => {
        const r = await projectTasks.updateTask(uid, pid, taskId, {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.owner !== undefined ? { owner_agent: patch.owner } : {}),
          ...(patch.result_ref !== undefined ? { result_ref: patch.result_ref } : {}),
        });
        return r.ok ? { ok: true, task: toView(r.task) } : { ok: false, error: (r as { error: string }).error };
      },
      complete: async (taskId: string, resultRef?: string) => {
        const r = await projectTasks.completeTask(uid, pid, taskId, resultRef);
        return r.ok ? { ok: true, task: toView(r.task) } : { ok: false, error: (r as { error: string }).error };
      },
    };
    const { createProjectTasksTool } = await import('../../../core-agent/src/tools/project-tasks-tool');
    injectedTools.push(createProjectTasksTool(projectTasksHandler));

    // Project instructions (ORKAS.md): the project's goal + rules. Commander
    // writes; sub-agents read it from their system prompt but don't get this
    // tool. Injected for the commander only, so there is no other write path.
    if (isCommander) {
      const { createProjectInstructionsTool } = await import('../../../core-agent/src/tools/project-instructions-tool');
      injectedTools.push(createProjectInstructionsTool({
        set: async (instructions: string) => {
          const r = await writeProjectInstructions(uid, pid, instructions);
          return r.ok ? { ok: true } : { ok: false, error: (r as { error: string }).error };
        },
      }));
    }
  }

  // Metacognition tool (per-agent, only if enabled via env var)
  if (isMetacognitionEnabled()) {
    const metaHandler: MetacognitionToolHandler = {
      read: (target) => metacognition.readContent(agentId, target),
      write: (target, content) => metacognition.writeContent(agentId, target, content),
    };
    const { createMetacognitionTool } = await import('../../../core-agent/src/tools/metacognition-tool');
    injectedTools.push(createMetacognitionTool(metaHandler, {
      competence: metacognition.COMPETENCE_CHAR_LIMIT,
      strategies: metacognition.STRATEGIES_CHAR_LIMIT,
    }));
  }

  // Local-machine tools: bash / write_file overrides (permission-gated) +
  // markdown_to_pdf / html_to_pdf. These MUST come after core-agent's
  // builtins in the list so `AgentRunner`'s last-write-wins tool map
  // overrides `bash` and `write_file` with the permission-gated versions.
  const systemSkillReadRoots = uid ? [userSystemSkillsDir(uid)] : [];
  const agentPrivateSkillReadRoots = uid && agentId
    ? [
      userMarketplaceAgentSkillsDir(uid, agentId),
      agentPrivateSkillsDir(uid, agentId),
      agentEvolvedSkillsDir(uid, agentId),
    ]
    : [];
  const fileReadOnlyExtraRoots = [
    ...(params.fileReadOnlyExtraRoots || []),
    ...(params.readOnlyExtraRoots || []),
    ...systemSkillReadRoots,
    ...agentPrivateSkillReadRoots,
  ];
  const toolResultsDir = uid ? toolResultsDirForSession(uid, params.sessionId) : '';
  const localReadOnlyDenyRoots = [
    ...fileReadOnlyExtraRoots,
    ...(toolResultsDir ? [toolResultsDir] : []),
  ];

  const localTools = createLocalTools({
    ...(uid ? { userId: uid } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
    // Read-only roots intentionally stay out of localTools. `delete_file`,
    // `write_file`, PDF tools, and bash-adjacent local execution only get the
    // writable lane (`extraRoots`), while read-only roots are visible through
    // fileTools below.
    ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
    ...(params.onOutputsPublished ? { onOutputsPublished: params.onOutputsPublished } : {}),
    ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
    ...(onArtifactCreatedForHistory ? { onArtifactCreated: onArtifactCreatedForHistory } : {}),
  });

  // File-scoped tools (read_file override + search_files + grep_files).
  // Same last-write-wins rule — placed after localTools so `read_file` wins
  // over core-agent's builtin `read_file`. Skipped when uid is unknown
  // (e.g. ad-hoc test runs) since file-tools need it for cache scoping.
  // `readOnlyExtraRoots` is threaded here for the read scope (workspace +
  // attachment + extraRoots + readOnlyExtraRoots all visible). Local write
  // and delete tools never receive those roots.
  const fileTools = uid
    ? createFileTools({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(fileReadOnlyExtraRoots.length || toolResultsDir
          ? { readOnlyExtraRoots: [...fileReadOnlyExtraRoots, ...(toolResultsDir ? [toolResultsDir] : [])] }
          : {}),
        ...(toolResultsDir ? { toolResultsRoot: toolResultsDir } : {}),
        ...(params.onSkillInvoked ? { onSkillInvoked: params.onSkillInvoked } : {}),
      })
    : [];

  // Persisted oversized outputs have their own capability boundary. The model
  // receives opaque refs and can only search or read bounded cursor chunks;
  // generic read_file is explicitly denied for this root below.
  const toolResultTools = toolResultsDir ? createToolResultTools({ toolResultsDir }) : [];

  // Library tools (kb_list + kb_search + kb_read). Read-only, no localExec
  // required. Injected for every main conv + group_chat actor; agent-edit
  // / skill-edit sessions also get them (the LLM may want to preview KB
  // content when building workflows). Skipped when uid is unknown
  // (matches file-tools).
  const kbTools = uid ? createKbTools({
    userId: uid,
    ...(params.projectId ? { projectId: params.projectId } : {}),
  }) : [];

  // Conversation-history tools (chat_search + chat_read). Commander-only:
  // agent workers receive the material they need through their visibility
  // slice / dispatcher payload and must never browse full conversation logs.
  // Project commanders search their own project by default; Library remains
  // authoritative for durable document facts.
  const chatHistoryTools = uid && isCommander ? createChatHistoryTools({
    userId: uid,
    ...(params.cid ? { currentCid: params.cid } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
  }) : [];

  // Media generation. Shares the localExec access mode with
  // local-tools (writing image bytes is the same blast radius as write_file).
  // Skipped when uid is unknown — generators need the
  // workspace + attachment scope to validate paths.
  const imageGenTools: AgentTool[] = uid
    ? [createImageGenTool({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })]
    : [];
  const videoStudioTools: AgentTool[] = uid
    ? [createVideoStudioTool({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.userMessage ? { userMessage: params.userMessage } : {}),
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.onOutputsPublished ? { onOutputsPublished: params.onOutputsPublished } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })]
    : [];

  // Deep-research-owned tools (ownerAgent gate). Pure local compute (embedding
  // + ranking), so no uid / workspace scope and no Tool Execution Access needed;
  // hidden from the commander and every other actor via isToolVisibleToAgent.
  const deepResearchTools: AgentTool[] = [];
  if (isToolVisibleToAgent('research_rerank', agentId)) {
    deepResearchTools.push(createResearchRerankTool());
  }

  // Office document tools (bundled OfficeCLI engine). Permission-gated like
  // local-tools (writing a docx/xlsx/pptx is the same blast radius as
  // write_file). Skipped when uid is unknown — the factory needs the
  // workspace + attachment scope to sandbox output paths.
  const officeTools: AgentTool[] = uid && officeCliAvailable()
    ? createOfficeTools({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })
    : [];

  // `web_search` override — last-write-wins replacement for core-agent's
  // built-in keyless web_search. Routes to a paid search API when the user
  // has any `searchProfiles` configured; otherwise delegates back to the
  // built-in Brave/Bing scraper. See `model/core-agent/search-tools.ts`.
  // Async because the factory pulls `defineTool` / `runBuiltinWebSearch`
  // off the ESM core-agent dynamic import.
  const searchOverrideTools: AgentTool[] = [await createWebSearchOverrideTool()];

  // Connector meta-tools + system-prompt block (MCP-based, umbrella pattern). When ≥1
  // connector is visible to this actor we inject the two meta-tools (`list_connector_tools` /
  // `call_connector_tool`) plus a `## Connectors` block enumerating the connectors directly in
  // the system prompt — the model sees the catalog without a discovery round-trip, and the
  // block sits in the cached prefix. When 0 visible: zero tools, no block. Per-connector MCP
  // actions are NEVER injected into `tools[]` — the model discovers and invokes them through
  // the meta-tools (umbrella pattern); flat-injecting would balloon `tools[]` past the 20–50
  // selection-accuracy cliff and invalidate the prompt-cache prefix on every connect/disconnect.
  //
  // Session-kind gate (tri-state):
  //   - `gconv` (commander) + `gmember` (agent worker)    → block + full tools (list + call —
  //                                                         actual user tasks invoking external
  //                                                         services).
  //   - `agent` (agent-edit)                              → block + discover-only tool
  //                                                         (`list_connector_tools`). Editor
  //                                                         LLM reads action names + JSON
  //                                                         schemas so the authored workflow
  //                                                         can write "use gmail's `send_email`
  //                                                         with body=..." rather than the
  //                                                         coarse "use gmail to send email".
  //                                                         `call_connector_tool` is withheld
  //                                                         so an authoring session can never
  //                                                         produce external side effects.
  //   - everything else (skill-edit / KB-image / CLI dispatch / reflect / memory-extract /
  //     anon)                                            → none.
  // Group-chat agents intentionally share the commander's connector visibility:
  // do not pass agentId here. Agent-edit also bypasses `agent.enabled_connectors`
  // so the editor LLM can inspect every installed connector while authoring.
  const exposure = uid ? connectorExposureFromSessionId(params.sessionId) : 'none';
  const blockAgentId = undefined;
  const connectorBlock = exposure !== 'none' && uid
    ? await getConnectorPromptBlock(uid, blockAgentId)
    : '';
  const connectorMetaTools = uid && exposure !== 'none'
    ? await createConnectorMetaTools(
        {
          userId: uid,
          ...(params.cid ? { cid: params.cid } : {}),
        },
        exposure === 'discover+block' ? 'discover' : 'full',
      )
    : [];

  // Merge injected tools with extra tools from caller
  const allTools = [
    ...injectedTools,
    ...localTools,
    ...fileTools,
    ...kbTools,
    ...chatHistoryTools,
    ...imageGenTools,
    ...videoStudioTools,
    ...deepResearchTools,
    ...officeTools,
    ...searchOverrideTools,
    ...toolResultTools,
    ...(params.extraTools || []),
    ...connectorMetaTools,
  ];

  // Authoritative owner-scoped visibility gate: drop any tool whose catalog
  // entry declares an `ownerAgent` other than this actor. Defense-in-depth
  // beyond the construction-time gate above — guarantees an owner-only tool can
  // never reach another actor's tools[] regardless of which injection path
  // produced it. Caller-supplied extraTools / core-agent builtins aren't in the
  // catalog, so `isToolVisibleToAgent` returns true for them (unaffected).
  const visibleTools = allTools.filter((tool) => isToolVisibleToAgent(tool.name, agentId));
  const visibleToolNameSet = new Set(visibleTools.map((tool) => tool.name));
  const builtinTools = mod.getBuiltinTools();

  // Apply one simple 8K per-result policy at AgentRunner's FINAL result
  // boundary. Keeping this as a result transformer (instead of pre-wrapping
  // the current tool list) also covers core builtins and tools AgentRunner adds
  // later, notably skill_manage. AgentRunner supplies a shared 16K-per-model-
  // step ledger through ctx.state and shrinks it when context headroom is low.
  // `uid` can be empty in ad-hoc tests; without a session Result Store we leave
  // outputs untouched.
  const transformToolResult = uid
    ? (toolName: string, result: ToolResult, ctx: ToolContext): ToolResult =>
        capToolResult(toolName, result, ctx, {
          maxInlineTokens: DEFAULT_INLINE_RESULT_TOKENS,
          toolResultsDir,
        })
    : undefined;

  // Final tool name set the AgentRunner will see — core-agent builtins
  // (read_file/write_file/bash/list_files/web_search/web_fetch) merged with
  // our visibleTools via last-write-wins. Used by the snapshot below and by
  // the catalog-drift test (`tool-catalog.test.ts`); we no longer render a
  // `## Available tools` block into the system prompt because the model
  // already receives every tool's compact description + JSON schema via the
  // SDK tool-use protocol — the prompt block was an information subset
  // duplicating ~800 chars per call without giving the model anything new.
  const extraToolNameSet = new Set((params.extraTools ?? []).map((t) => t.name));
  const finalToolNames = Array.from(new Set([
    ...builtinTools.map((t) => t.name),
    ...visibleTools.map((t) => t.name),
  ]));

  // Snapshot the final tool definitions for the dev archive. Last-write-wins
  // merge: builtins first, then visibleTools override by name. Source label
  // tracks where each definition came from so the debug panel can call out
  // injected vs. caller-supplied tools.
  const toolDefMap = new Map<string, ToolDefSnapshot>();
  const snapshotTool = (t: AgentTool, source: ToolDefSnapshot['source']): ToolDefSnapshot => {
    const def = mod.toToolDefinition(t);
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      source,
    };
  };
  for (const t of builtinTools) {
    toolDefMap.set(t.name, snapshotTool(t, 'core-agent'));
  }
  for (const t of visibleTools) {
    toolDefMap.set(
      t.name,
      snapshotTool(
        t,
        extraToolNameSet.has(t.name) ? 'extra' : visibleToolNameSet.has(t.name) ? 'orkas' : 'core-agent',
      ),
    );
  }
  const toolDefs: ToolDefSnapshot[] = Array.from(toolDefMap.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  // Finalize system prompt. Cache-friendly order:
  //   [base prompt] → [connectors] → [system skills] → [skills]
  //   → [agents] → [runtime injection] → [memory] → [orchestration state]
  //   → [volatile datetime tail].
  // Everything from [runtime injection] onward is the turn-volatile region;
  // the stable prefix above it is what the provider prompt-cache reuses.
  // Tool list is no longer in the prompt (see toolsBlock removal note above)
  // because the SDK tool-use protocol delivers it via a separate API field.
  const parts: string[] = [];
  const { stable: stableSystemPrompt, volatileTail } = splitVolatilePromptTail(params.systemPrompt);
  const { stable: stableWithoutAgents, agentsBlock } = splitCommanderAgentsBlock(stableSystemPrompt);
  const { stable: stableWithoutRuntime, runtimeInjectionBlock } = splitRuntimeInjectionBlock(stableWithoutAgents);
  // Orchestration state carries the per-turn `orchestration_ledger` JSON; it
  // must leave the cached prefix or it invalidates the whole prefix after it
  // every commander turn a ledger is live. Peel it here and re-emit it in the
  // volatile region below.
  const { stable: stableWithoutOrchestration, orchestrationBlock } = splitCommanderOrchestrationBlock(stableWithoutRuntime);
  if (stableWithoutOrchestration) parts.push(stableWithoutOrchestration);
  if (connectorBlock) parts.push(connectorBlock.trim());
  if (systemSkillsBlock) parts.push(systemSkillsBlock.trim());
  if (skillsBlock) parts.push(skillsBlock.trim());
  if (agentsBlock) parts.push(agentsBlock);
  // Static rules for resolving conflicts among the user-managed project
  // layers. Always present in real project work sessions, even when ORKAS.md,
  // memory, or the task backlog is empty.
  const projectContextPolicyBlock = (uid && memoryAgentScope && params.projectId)
    ? formatProjectContextPolicyForSystemPrompt()
    : '';
  if (projectContextPolicyBlock) parts.push(projectContextPolicyBlock);
  // User-authored project instructions (read side): low-churn configuration,
  // so it stays in the stable cache prefix (before the runtime injection).
  // Gated on memoryAgentScope like memory: edit/one-shot sessions get neither.
  const projectInstructionsBlock = (uid && memoryAgentScope && params.projectId)
    ? formatProjectInstructionsForSystemPrompt(uid, params.projectId)
    : '';
  if (projectInstructionsBlock) parts.push(projectInstructionsBlock);
  if (runtimeInjectionBlock) parts.push(runtimeInjectionBlock);
  // Cross-session memory (read side): the user's stored profile + notes as
  // background context. It is more turn-volatile than resource indexes, so
  // it sits after connectors / skills / agents but before per-turn state.
  // Empty string when nothing is stored (no tokens for new users).
  // Re-read each turn — a mid-conversation write shows up next turn.
  // Project sessions additionally render the project's own notes section.
  const memoryBlock = (uid && memoryAgentScope) ? formatMemoryForSystemPrompt(uid, memoryAgentScope, params.projectId) : '';
  if (memoryBlock) parts.push(memoryBlock);
  const resolvedSystemPrompt = parts.join('\n\n');
  // P2: the truly per-turn-volatile blocks — the orchestration ledger (~7-9K
  // JSON that changes every commander turn) and the datetime tail — do NOT go
  // into the system prompt. Even peeled to the tail they bust the
  // Anthropic single-block system cache (and therefore the whole history
  // prefix) every turn. Instead they ride on THIS turn's user message
  // (core-agent AgentRunParams.turnEphemeral → getMessagesForModel), the
  // uncached tail after all history, so the system + history cache prefix stays
  // byte-stable across turns. See Common/docs/plans/context-cost-optimization.md.
  // Live project task board (project sessions only). Rides the turn — NOT the
  // cached system prefix — because it changes as tasks update. The goal/rules
  // stay in ORKAS.md (prefix) and decisions in the memory block; this is the
  // task layer. See features/project_tasks.ts::formatProjectStatusForTurn.
  const projectStatusBlock = (uid && memoryAgentScope && params.projectId)
    ? await projectTasks.formatProjectStatusForTurn(uid, params.projectId)
    : '';
  const turnEphemeral = [orchestrationBlock, volatileTail, projectStatusBlock]
    .filter((b) => b && b.trim())
    .join('\n\n');

  // Evolution (the self-evolving skill store) is per-agent: when an
  // agentId is present we write into that agent's private directory
  // `<uid>/cloud/agents/<aid>/skills/`. The core default conversation
  // (no agentId) has evolution disabled — the commander shouldn't be
  // auto-producing skills; user-authored skills go through the
  // System A path in the user UI.
  // When the evolution stanza is not passed, core-agent defaults to
  // enabled=true + skillsDir="skills" relative to cwd, which would
  // dump into `PC/skills/` (see the fix point in
  // docs/plans/agent-as-directory.md).
  const evolutionConfig = (agentId && earlyUid)
    ? { enabled: true, skillsDir: agentEvolvedSkillsDir(earlyUid, agentId) }
    : { enabled: false };

  // Fill the model catalog with each model's REAL context window (+ max output
  // tokens) so core-agent's compaction trigger uses it instead of the 200K
  // fallback — otherwise a 1M-window model compacts at 0.8×200K=160K, throwing
  // away most of its context (G7). Populate EVERY candidate in the rotating
  // group (keyed by its modelId), not just the primary: rotating-provider can
  // fail over to a different-window model mid-run, and core-agent looks the
  // window up by the model the stream actually reported (P1-6).
  // resolveConfiguredPiModel returns the pi-ai Model (catalog or custom-built),
  // which carries contextWindow + maxTokens.
  // Each entry must satisfy core-agent's ModelConfigSchema, which REQUIRES
  // `provider` + `model` (contextWindow / maxOutputTokens are optional).
  // modelCatalogEntryFromModel only supplies the windows, so add provider/model
  // here. These two are schema-required metadata only — core-agent reads the
  // catalog solely for contextWindow/maxOutputTokens and routes via
  // defaultProvider/defaultModel + the injected rotating provider, never via
  // catalog[x].provider. (Omitting them is what crashed createConfig with a Zod
  // "provider/model Required" error once a candidate carried a real window.)
  const modelCatalog: Record<string, { provider: string; model: string; contextWindow?: number; maxOutputTokens?: number }> = {};
  for (const choice of group) {
    if (modelCatalog[choice.model]) continue;
    const model = EXTERNAL_API_PROVIDERS.includes(choice.provider)
      ? buildExternalProviderModel(choice.provider, choice.model)
      : resolveConfiguredPiModel(mod, choice.provider, choice.model)?.model;
    const entry = modelCatalogEntryFromModel(model);
    if (entry) modelCatalog[choice.model] = { provider: choice.provider, model: choice.model, ...entry };
  }
  const config: CoreAgentConfig = mod.createConfig({
    agent: {
      defaultProvider: providerId,
      defaultModel: modelId,
      ...(resolvedSystemPrompt ? { systemPrompt: resolvedSystemPrompt } : {}),
      ...(params.maxToolLoops ? { maxToolLoops: params.maxToolLoops } : {}),
    },
    evolution: evolutionConfig,
    ...(Object.keys(modelCatalog).length ? { models: { catalog: modelCatalog } } : {}),
    // We deliberately do NOT populate `models.providers` —
    // ProviderRegistry's constructor runs the default factory
    // (anthropic / openai / pi-ai) on every entry and stuffs the
    // provider instance into the `providers` cache; subsequent
    // `providers.get(id)` calls hit the cache first and never reach
    // the registerFactory-injected rotating-provider below (this
    // includes the single-key case — the old "group.length===1 → take
    // the legacy path" branch missed cooldown / error classification
    // for exactly this reason). Hand all provider creation to
    // rotating-provider; for a single key the wrapper is just one
    // closure (negligible cost) and we get a uniform error path.
  });

  const providers = new mod.ProviderRegistry(config);

  if (primary) {
    // Build a rotating provider covering the whole primary group. Even
    // when there's only one candidate, the wrapper is cheap (just one
    // pass-through) and keeps the code path uniform.
    const rotating = await buildRotatingProvider(mod, providerId, group, params.onNativeSearchInjected, params.onCandidateChosen);
    // Inject the rotating provider into BOTH the factory slot AND the
    // pre-built instance cache. ProviderRegistry.get() short-circuits on
    // the instance cache without consulting the factory, so injecting
    // only the factory would be a no-op if any upstream path ever
    // pre-warms the default implementation.
    providers.registerFactory(providerId, () => rotating);
    (providers as any).providers?.set?.(providerId, rotating);
  }

  // When a skill is learned via skill_manage(create), append it to the bound
  // agent's explicit skill_list metadata if one exists. Goes through
  // `appendAgentSkill` (not `updateCustomAgent`) to bypass the unknown-id
  // filter, which would drop the new id — System B (SkillStore) skills aren't
  // in System A's SkillLoader spec list. No-op when agentId is empty or when
  // the agent has no explicit dependency list.
  const onSkillCreated = agentId
    ? (skillId: string) => {
        appendAgentSkill(agentId, skillId)
          .catch((err) => log.warn('skill_list sync failed', {
            agent_id: maskId(agentId),
            skill_id: maskId(skillId),
            error: logErrorSummary(err),
          }));
      }
    : undefined;

  // Bridge System B advertised → ChatOptions.onSkillAdvertised. The SDK
  // doesn't know about the host's skill-system taxonomy; we tag every id
  // it surfaces as `'B'` before passing it up.
  const onLearnedSkillAdvertised = params.onSkillAdvertised
    ? (id: string) => params.onSkillAdvertised!(id, 'B')
    : undefined;

  const runner = new mod.AgentRunner({
    config,
    providers,
    session,
    ...(visibleTools.length ? { tools: visibleTools } : {}),
    ...(transformToolResult ? { transformToolResult } : {}),
    ...(toolResultsDir ? { toolContextState: { toolResultSpoolDir: toolResultsDir } } : {}),
    ...(params.skillList !== undefined ? { skillAllowlist: params.skillList } : {}),
    ...(onSkillCreated ? { onSkillCreated } : {}),
    ...(onLearnedSkillAdvertised ? { onLearnedSkillAdvertised } : {}),
  });

  return {
    runner,
    resolvedSystemPrompt,
    turnEphemeral,
    entryId: primary?.entryId,
    profileId: primary?.profileId,
    providerId,
    modelId,
    toolDefs,
    skillDisplayNameById,
    agentDisplayNameById,
  };
}

/** Best-effort accessor for the active uid that doesn't throw when no user is activated yet
 *  (ad-hoc / test paths). Production callers always come through with `params.userId` or after
 *  `activateUser()`, so the fallback is just a safety net. Loaded lazily via require to avoid
 *  pulling features/users into the early import graph. */
function _safeActiveUserId(): string | null {
  try {
    const { getActiveUserId } = require('../../features/users') as typeof import('../../features/users');
    return getActiveUserId();
  } catch {
    return null;
  }
}

/** Tri-state connector exposure, gated by session kind (CLAUDE.md §5 session-id table):
 *   - `tools+block`:    group-chat task sessions (`gconv` commander + `gmember` agent worker)
 *     — block + both meta-tools (`list_connector_tools` + `call_connector_tool`). Full exposure.
 *   - `discover+block`: agent-edit (`agent`) — block + `list_connector_tools` ONLY. Editor LLM
 *     can discover action names + JSON schemas to write specific workflow steps; cannot invoke
 *     (an authoring session must never produce external side effects).
 *   - `none`:           skill-edit, KB-image, CLI dispatch, reflect, memory-extract, anon, and
 *     any future kind — neither block nor tools.
 *   Add a new conversation kind that needs connectors? Extend this function explicitly + add
 *   an entry to CLAUDE.md §5's session-id table.
 *
 * session_id format is `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id), so the
 * kind keyword is anchored at the start. */
export function connectorExposureFromSessionId(sessionId: string): 'tools+block' | 'discover+block' | 'none' {
  if (/^(gconv|gmember)-/.test(sessionId)) return 'tools+block';
  // Agent-edit gets `list_connector_tools` (read-only, no side effects) so the editor LLM can
  // learn each connector's action names and write specific workflow steps — but NOT
  // `call_connector_tool`, since an authoring session must never produce external side
  // effects. See `connector-meta-tools.ts::createConnectorMetaTools` mode handling.
  if (/^agent-/.test(sessionId)) return 'discover+block';
  return 'none';
}

/** System skills are authoring/orchestration affordances, not worker context.
 *  Keep them visible to the group-chat commander, agent editor, and skill editor only; ordinary
 *  agent workers receive the normal user skill surface, not authoring protocols. */
export function systemSkillsExposureFromSessionId(sessionId: string): boolean {
  return /^gconv-/.test(sessionId) || /^agent-/.test(sessionId) || /^skill-/.test(sessionId);
}

/** OPEN-tier skills (external packages + global roots) render for group-chat
 *  task sessions and agent-edit authoring sessions. One-shots and background
 *  kinds never see them. */
export function openSkillSourcesExposureFromSessionId(sessionId: string): boolean {
  return /^(gconv|gmember|agent)-/.test(sessionId);
}

/**
 * Factory dispatcher for Orkas's external (pi-ai-unaware) providers.
 * Extend the switch when a new id is added to `EXTERNAL_API_PROVIDERS`.
 * Async because the underlying factories await core-agent dynamic import.
 */
async function buildExternalProvider(providerId: string, apiKey: string, modelId: string): Promise<LLMProvider> {
  switch (providerId) {
    case 'moonshot':
      return await createMoonshotProvider({ apiKey, modelId });
    case 'deepseek':
      return await createDeepSeekProvider({ apiKey, modelId });
    case 'doubao':
      return await createDoubaoProvider({ apiKey, modelId });
    default:
      throw new Error(`no external provider factory for "${providerId}"`);
  }
}

/**
 * Build an `LLMProvider` that wraps every entry behind cross-provider
 * fallback rotation. `build()` closures are deferred so we only pay the
 * construction cost for candidates we actually try — if the primary key
 * works on first request, fallbacks never get built.
 *
 * Candidates may target different `(provider, model)` pairs — e.g. the
 * primary might be `openai/gpt-5.4` and the next fallback
 * `anthropic/claude-opus-4.7`. rotating-provider overrides `params.model`
 * with each candidate's own model id before delegating, so AgentRunner
 * (which only knows the primary's model) is none the wiser.
 *
 * The wrapper is registered under `primary.provider` as far as
 * ProviderRegistry is concerned. That's just a routing label — once
 * AgentRunner retrieves it, all rotation is handled internally.
 *
 * On success (`onSuccess`), we bump `lastUsed` on the winning entry
 * and clear any prior cooldown on that profile (the key just proved it
 * works — don't keep skipping it).
 */
async function buildRotatingProvider(
  mod: CA,
  providerId: string,
  group: ChatEntryChoice[],
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void,
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string }) => void,
): Promise<LLMProvider> {
  const candidates: RotatingCandidate[] = group.map((choice) => {
    const candProviderId = choice.provider;
    const candModelId = choice.model;
    const isExternal = EXTERNAL_API_PROVIDERS.includes(candProviderId);
    return {
      profileId: choice.profileId,
      providerId: candProviderId,
      modelId: candModelId,
      build: async () => {
        if (isExternal) {
          return buildExternalProvider(candProviderId, choice.apiKey, candModelId);
        }
        const resolvedModel = resolveConfiguredPiModel(mod, candProviderId, candModelId);
        if (resolvedModel?.isConfiguredFallback) {
          log.info('using configured model fallback', {
            provider: candProviderId,
            model: candModelId,
            templateProvider: resolvedModel.catalogProviderId,
            templateModel: resolvedModel.templateModelId,
          });
        }
        return mod.createPiProvider({
          provider: candProviderId,
          ...(resolvedModel?.needsCustomModel ? { customModel: resolvedModel.model } : { model: candModelId }),
          apiKey: choice.apiKey,
          onPayload: buildNativeSearchOnPayload(candProviderId, candModelId, onNativeSearchInjected),
        });
      },
    };
  });

  return createRotatingProvider({
    providerId,
    candidates,
    onSuccess: (profileId) => {
      const winner = group.find((c) => c.profileId === profileId);
      if (winner) bumpEntryLastUsed(winner.entryId);
      clearCooldown(profileId);
    },
    ...(onCandidateChosen ? { onCandidateChosen } : {}),
  });
}

/** Check if metacognition feature is enabled.
 *
 *  Single source of truth lives in `features/metacognition.isFeatureEnabled`
 *  (combines env `ORKAS_METACOGNITION='0'` kill switch + per-user preference
 *  written from settings UI). This thin wrapper exists to avoid changing
 *  every existing call site at once. */
/** Check if metacognition feature is enabled (env var toggle). */
export function isMetacognitionEnabled(): boolean {
  return metacognition.isFeatureEnabled();
}

/**
 * Builds a pi-ai `onPayload` callback: pi-ai invokes it after handing us
 * the result of `buildParams` and before sending the request. When both
 * "the debug toggle is on" and "model.api is in the supported list" hold,
 * we append the model's native web search tool schema to `params.tools`,
 * write an info log, and bubble the "injected" event up through the
 * caller-supplied callback to client.ts's archive recorder.
 *
 * On a miss we return params unchanged (pi-ai treats an undefined return
 * as no-op, so a no-op return is also legal).
 */
function buildNativeSearchOnPayload(
  providerId: string,
  modelId: string,
  onNativeSearchInjected?: (info: NativeSearchInjectedInfo) => void,
): (params: unknown, model: { api?: string }) => unknown {
  return (params, model) => {
    if (!isNativeSearchEnabled()) return params;
    // Don't inject the model-side native search when the user has any paid
    // search-tool API key configured — let the overriding `web_search` tool
    // (search-tools.ts) be the single search surface, otherwise the LLM
    // sees two competing tools and may bypass the paid one the user paid for.
    if (hasAnySearchProfile()) return params;
    const api = model?.api;
    if (!api) return params;
    const tool = nativeSearchToolForApi(api);
    if (!tool) return params;
    const toolName = nativeSearchToolName(tool) || 'native_web_search';
    // Payload shape + size stamped into each injection so post-incident
    // grepping can correlate fetch failures to body size / turn length.
    // Cheap — one JSON.stringify of an already-serialisable object.
    const cur = params as { tools?: unknown[]; messages?: unknown[]; input?: unknown[] } & Record<string, unknown>;
    let approxBodyBytes = -1;
    try { approxBodyBytes = JSON.stringify(params).length; } catch { /* circular — give up */ }
    const msgCount = Array.isArray(cur.messages)
      ? cur.messages.length
      : (Array.isArray(cur.input) ? cur.input.length : -1);
    const toolsBefore = Array.isArray(cur.tools) ? cur.tools.length : 0;
    runnerLog.info('native web search injected', {
      provider: providerId, model: modelId, api, tool: toolName,
      msgCount, toolsBefore, approxBodyBytes,
    });
    try {
      onNativeSearchInjected?.({ provider: providerId, model: modelId, api, tool: toolName });
    } catch (err) {
      runnerLog.warn(`onNativeSearchInjected callback failed: ${(err as Error).message}`);
    }
    return { ...cur, tools: [...(Array.isArray(cur.tools) ? cur.tools : []), tool] };
  };
}
