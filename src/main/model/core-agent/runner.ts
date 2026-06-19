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

import type { AgentTool, LLMProvider } from '#core-agent';

import {
  pickChatEntryGroup,
  bumpEntryLastUsed,
  hasConfiguredModel,
  getConfiguredModelCooldown,
  type ChatEntryChoice,
} from '../../features/auth';
import { getSystemPromptBlock, getSystemSkillsPromptBlock } from './skill-registry';
import { t } from '../../i18n';
// tool-catalog.ts: TOOL_CATALOG kept as the source of truth for the drift
// test (tool-catalog.test.ts asserts injected names ⊆ catalog) and for any
// future targeted use; runtime no longer renders the prompt block from it.
import { getSession } from './session-store';
import { addEntry, replaceEntry, removeEntry, listEntries, formatForSystemPrompt as formatMemoryForSystemPrompt } from '../../features/memory';
import * as metacognition from '../../features/metacognition';
import { appendAgentSkill, listAgents } from '../../features/agents';
const log = createLogger('model/runner');
import { createLocalTools, createFileTools } from './local-tools';
import { createKbTools } from './kb-tools';
import { createChatHistoryTools } from './chat-history-tools';
import { createImageGenTool } from './image-gen-tool';
import { createWebSearchOverrideTool } from './search-tools';
import { sessionToolResultsDir, agentEvolvedSkillsDir, userSystemSkillsDir } from '../../paths';
import {
  wrapToolWithCap,
  MAX_RESULT_CHARS_BY_TOOL,
  DEFAULT_MAX_RESULT_CHARS,
} from '../../util/tool-result-cap';
import { createMoonshotProvider, createDeepSeekProvider, createDoubaoProvider } from './external-providers';
import { createRotatingProvider, type RotatingCandidate } from './rotating-provider';
import { clearCooldown } from './profile-cooldown';
import { EXTERNAL_API_PROVIDERS, resolveConfiguredPiModel } from '../provider_catalog';
import { readDisabledSets } from '../../features/component_enabled';
import { nativeSearchToolForApi, nativeSearchToolName } from './native-search-tools';
import { hasAnySearchProfile } from '../../features/search_auth';
import { createConnectorMetaTools, getConnectorPromptBlock } from './connector-meta-tools';
import { createLogger } from '../../logger';
import type { MemoryToolHandler } from '../../../core-agent/src/tools/memory-tool';
import type { MetacognitionToolHandler } from '../../../core-agent/src/tools/metacognition-tool';

const runnerLog = createLogger('runner');

function isNativeSearchEnabled(): boolean {
  return true;
}

type CA = typeof import('#core-agent');
type AgentRunnerCtor = CA['AgentRunner'];
type AgentRunnerInstance = InstanceType<AgentRunnerCtor>;
type CoreAgentConfig = ReturnType<CA['createConfig']>;

let _caPromise: Promise<CA> | null = null;
async function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
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
  /** Project id of the conversation, when it belongs to one. Threaded
   *  through to local-tools / file-tools / image-gen-tool so workspace
   *  resolution picks up the project-scoped selection. Resolved once at
   *  the top of group_chat::runTurn from `conv.project_id`. */
  projectId?: string;
  /** Agent id bound to the conversation. Empty/undefined = default scope. */
  agentId?: string;

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
  /** Extra tools added to core-agent's builtins (e.g. group_chat commander
   * gets `plan_set` + agent-management tools). */
  extraTools?: AgentTool[];
  /** Extra absolute directory roots whitelisted for file-tools (read_file /
   *  stat_file / search_files / grep_files) on top of workspace + attachment.
   *  Read AND write are permitted under these roots. Used by per-skill
   *  edit chats to expose the skill dir. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: read tools (read_file / search_files /
   *  grep_files / stat_file) can see them, but write-side tools
   *  (edit_file / write_file / bash / markdown_to_pdf / html_to_pdf /
   *  generate_image) cannot mutate paths inside. Used by group-chat
   *  commander to inspect agent / skill specs without giving direct-write
   *  access — the structured `<agent>` / `<skill>` containers are the
   *  only sanctioned mutation channels for those resources. */
  readOnlyExtraRoots?: readonly string[];
  /** Fires with the absolute path after each successful `write_file` /
   * `markdown_to_pdf` / `html_to_pdf` call or tracked bash output file. See `model/client.ts`
   * `ChatOptions.onFileWritten` for the caller-facing contract. */
  onFileWritten?: (absPath: string) => void;
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
   *  `'extra'` = passed by caller via `extraTools` (group_chat commander uses this for plan_set / agent mgmt). */
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

function splitCommanderPlanStateBlock(prompt: string): { stable: string; planStateBlock: string } {
  const marker = '\n\n### Current plan state';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, planStateBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    planStateBlock: prompt.slice(blockStart, blockEnd).trim().replace(/^### Current plan state/, '## Current plan state'),
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

export async function buildRunner(params: BuildRunnerParams): Promise<{
  runner: AgentRunnerInstance;
  resolvedSystemPrompt: string;
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
      ...(params.onSkillAdvertised ? { onSkillAdvertised: params.onSkillAdvertised } : {}),
      displayNameById: skillDisplayNameById,
      ...(openSkillSourcesVisible ? { includeOpenSources: true } : {}),
    }),
  ]);

  const providerId = primary?.provider || 'anthropic';
  const modelId    = primary?.model    || 'claude-opus-4-8';

  // Build tools array: memory tool + metacognition tool. Assembly stays
  // above the system-prompt build because finalToolNames is still snapshotted
  // for the dev archive after this section.
  const uid = params.userId || _safeActiveUserId();
  const agentId = params.agentId || '';
  const agentDisplayNameById = new Map<string, string>();
  if (uid) {
    try {
      for (const agent of await listAgents()) {
        if (agent?.agent_id) agentDisplayNameById.set(agent.agent_id, agent.name || agent.agent_id);
      }
    } catch (err) {
      log.warn(`agent display-name scan failed: ${(err as Error).message}`);
    }
  }
  const injectedTools: AgentTool[] = [];

  if (uid) {
    // Memory tool (per-user)
    const memoryHandler: MemoryToolHandler = {
      add: (target, content) => addEntry(uid, target, content),
      replace: (target, oldText, content) => replaceEntry(uid, target, oldText, content),
      remove: (target, oldText) => removeEntry(uid, target, oldText),
      list: (target) => listEntries(uid, target),
    };
    const { createCrossSessionMemoryTool } = await import('../../../core-agent/src/tools/memory-tool');
    injectedTools.push(createCrossSessionMemoryTool(memoryHandler));
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
  const fileReadOnlyExtraRoots = [
    ...(params.readOnlyExtraRoots || []),
    ...systemSkillReadRoots,
  ];

  const localTools = createLocalTools({
    ...(uid ? { userId: uid } : {}),
    ...(params.cid ? { cid: params.cid } : {}),
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
    // `readOnlyExtraRoots` is threaded to localTools too — but ONLY the
    // `delete_file` tool actually consumes it via `guardDeletePath`. The
    // write-side tools (`write_file` / `edit_file`) still use
    // `guardEditPath`, which ignores readOnly roots and keeps them
    // immutable. The asymmetry exists because `delete_file` carries a
    // per-call UI confirm card (`delete-file-confirm.ts`) that the user
    // physically has to click — that gate justifies allowing deletion of
    // paths the caller marked read-only for silent writes.
    ...(params.readOnlyExtraRoots?.length ? { readOnlyExtraRoots: params.readOnlyExtraRoots } : {}),
    ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
    ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
    ...(params.onArtifactCreated ? { onArtifactCreated: params.onArtifactCreated } : {}),
  });

  // File-scoped tools (read_file override + search_files + grep_files).
  // Same last-write-wins rule — placed after localTools so `read_file` wins
  // over core-agent's builtin `read_file`. Skipped when uid is unknown
  // (e.g. ad-hoc test runs) since file-tools need it for cache scoping.
  // `readOnlyExtraRoots` is threaded here for the read scope (workspace +
  // attachment + extraRoots + readOnlyExtraRoots all visible), while
  // write-side tools (`write_file` / `edit_file`) still ignore it; only
  // the dedicated `delete_file` tool above can act on those paths.
  const fileTools = uid
    ? createFileTools({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.extraRoots?.length ? { extraRoots: params.extraRoots } : {}),
        ...(fileReadOnlyExtraRoots.length ? { readOnlyExtraRoots: fileReadOnlyExtraRoots } : {}),
        ...(params.onSkillInvoked ? { onSkillInvoked: params.onSkillInvoked } : {}),
      })
    : [];

  // Library tools (kb_list + kb_search + kb_read). Read-only, no localExec
  // required. Injected for every main conv + group_chat actor; agent-edit
  // / skill-edit sessions also get them (the LLM may want to preview KB
  // content when building workflows). Skipped when uid is unknown
  // (matches file-tools).
  const kbTools = uid ? createKbTools({
    userId: uid,
    ...(params.projectId ? { projectId: params.projectId } : {}),
  }) : [];

  // Conversation-history tools (chat_search + chat_read). Read-only and
  // lower-priority than KB: useful for "what did we discuss before" recall,
  // not an authoritative facts source.
  const chatHistoryTools = uid ? createChatHistoryTools({
    userId: uid,
    ...(params.cid ? { currentCid: params.cid } : {}),
  }) : [];

  // Image generation. Permission-gated like local-tools; reuses
  // localExec.granted (writing image bytes is the same blast radius as
  // write_file). Skipped when uid is unknown — generators need the
  // workspace + attachment scope to validate paths.
  const imageGenTools: AgentTool[] = uid
    ? [createImageGenTool({
        userId: uid,
        ...(params.cid ? { cid: params.cid } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.onFileWritten ? { onFileWritten: params.onFileWritten } : {}),
        ...(params.hasProducedPath ? { hasProducedPath: params.hasProducedPath } : {}),
      })]
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
  //   - `gconv` (commander)                              → block + full tools (list + call —
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
  // For agent-edit specifically, the block intentionally bypasses `agent.enabled_connectors`
  // (passes undefined agentId) — the editor LLM should see EVERYTHING the user installed so it
  // can recommend referencing a connector even if the agent's whitelist hasn't been opened to
  // it yet (the user toggles `enabled_connectors` separately in the agent-edit UI).
  const exposure = uid ? connectorExposureFromSessionId(params.sessionId) : 'none';
  const blockAgentId = exposure === 'discover+block' ? undefined : (agentId || undefined);
  const connectorBlock = exposure !== 'none' && uid
    ? await getConnectorPromptBlock(uid, blockAgentId)
    : '';
  const connectorMetaTools = uid && exposure !== 'none'
    ? await createConnectorMetaTools(
        { userId: uid, ...(agentId ? { agentId } : {}), ...(params.cid ? { cid: params.cid } : {}) },
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
    ...searchOverrideTools,
    ...(params.extraTools || []),
    ...connectorMetaTools,
  ];

  // Cap each tool's result size + persist oversized outputs. Single wrap point
  // so every tool (including core-agent's builtins like web_search/web_fetch
  // injected inside AgentRunner) is covered. Read-type tools (Infinity cap)
  // are auto-exempted by `wrapToolWithCap`. `uid` being empty happens in
  // ad-hoc test scenarios; skip wrapping there — no sessionToolResultsDir to
  // resolve and no LLM in the loop that would over-feed context anyway.
  const wrappedTools = uid
    ? allTools.map((t) =>
        wrapToolWithCap(t, {
          maxChars: MAX_RESULT_CHARS_BY_TOOL[t.name] ?? DEFAULT_MAX_RESULT_CHARS,
          toolResultsDir: sessionToolResultsDir(uid, params.sessionId),
        }),
      )
    : allTools;

  // Final tool name set the AgentRunner will see — core-agent builtins
  // (read_file/write_file/bash/list_files/web_search/web_fetch) merged with
  // our wrappedTools via last-write-wins. Used by the snapshot below and by
  // the catalog-drift test (`tool-catalog.test.ts`); we no longer render a
  // `## Available tools` block into the system prompt because the model
  // already receives every tool's full description + JSON schema via the
  // SDK tool-use protocol — the prompt block was an information subset
  // duplicating ~800 chars per call without giving the model anything new.
  const builtinTools = mod.getBuiltinTools();
  const extraToolNameSet = new Set((params.extraTools ?? []).map((t) => t.name));
  const finalToolNames = Array.from(new Set([
    ...builtinTools.map((t) => t.name),
    ...wrappedTools.map((t) => t.name),
  ]));

  // Snapshot the final tool definitions for the dev archive. Last-write-wins
  // merge: builtins first, then wrappedTools override by name. Source label
  // tracks where each definition came from so the debug panel can call out
  // injected vs. caller-supplied tools.
  const toolDefMap = new Map<string, ToolDefSnapshot>();
  for (const t of builtinTools) {
    toolDefMap.set(t.name, {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      source: 'core-agent',
    });
  }
  for (const t of wrappedTools) {
    toolDefMap.set(t.name, {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      source: extraToolNameSet.has(t.name) ? 'extra' : 'orkas',
    });
  }
  const toolDefs: ToolDefSnapshot[] = Array.from(toolDefMap.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  // Finalize system prompt. Cache-friendly order:
  //   [base prompt] → [connectors] → [system skills] → [skills]
  //   → [agents] → [runtime injection] → [memory] → [plan state]
  //   → [volatile datetime tail].
  // Tool list is no longer in the prompt (see toolsBlock removal note above)
  // because the SDK tool-use protocol delivers it via a separate API field.
  const parts: string[] = [];
  const { stable: stableSystemPrompt, volatileTail } = splitVolatilePromptTail(params.systemPrompt);
  const { stable: stableWithoutAgents, agentsBlock } = splitCommanderAgentsBlock(stableSystemPrompt);
  const { stable: stableWithoutPlan, planStateBlock } = splitCommanderPlanStateBlock(stableWithoutAgents);
  const { stable: stableWithoutRuntime, runtimeInjectionBlock } = splitRuntimeInjectionBlock(stableWithoutPlan);
  if (stableWithoutRuntime) parts.push(stableWithoutRuntime);
  if (connectorBlock) parts.push(connectorBlock.trim());
  if (systemSkillsBlock) parts.push(systemSkillsBlock.trim());
  if (skillsBlock) parts.push(skillsBlock.trim());
  if (agentsBlock) parts.push(agentsBlock);
  if (runtimeInjectionBlock) parts.push(runtimeInjectionBlock);
  // Cross-session memory (read side): the user's stored profile + notes as
  // background context. It is more turn-volatile than resource indexes, so
  // it sits after connectors / skills / agents but before per-plan state.
  // Empty string when nothing is stored (no tokens for new users).
  // Re-read each turn — a mid-conversation write shows up next turn.
  const memoryBlock = uid ? formatMemoryForSystemPrompt(uid) : '';
  if (memoryBlock) parts.push(memoryBlock);
  if (planStateBlock) parts.push(planStateBlock);
  if (volatileTail) parts.push(volatileTail);
  const resolvedSystemPrompt = parts.join('\n\n');

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

  const config: CoreAgentConfig = mod.createConfig({
    agent: {
      defaultProvider: providerId,
      defaultModel: modelId,
      ...(resolvedSystemPrompt ? { systemPrompt: resolvedSystemPrompt } : {}),
    },
    evolution: evolutionConfig,
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
  // agent's skill_list so the allowlist filter (in both `skill-registry` and
  // `SkillStore.buildIndex`) exposes it on the next turn. Without this, a
  // reflection-created skill would be immediately filtered out and the
  // self-evolution loop wouldn't close. Goes through `appendAgentSkill`
  // (not `updateCustomAgent`) to bypass the unknown-id filter, which would
  // drop the new id — System B (SkillStore) skills aren't in System A's
  // SkillLoader spec list. No-op when agentId is empty (normal
  // conv / edit chats — those don't filter anyway) or when the agent has
  // no skill_list (unrestricted access, already sees everything).
  const onSkillCreated = agentId
    ? (skillId: string) => {
        appendAgentSkill(agentId, skillId)
          .catch((err) => log.warn(`skill_list sync failed for "${skillId}" / agent ${agentId}: ${(err as Error).message}`));
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
    ...(wrappedTools.length ? { tools: wrappedTools } : {}),
    ...(params.skillList !== undefined ? { skillAllowlist: params.skillList } : {}),
    ...(onSkillCreated ? { onSkillCreated } : {}),
    ...(onLearnedSkillAdvertised ? { onLearnedSkillAdvertised } : {}),
  });

  return {
    runner,
    resolvedSystemPrompt,
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
 *   - `tools+block`:    group-chat commander sessions (`gconv`) — block + both meta-tools
 *     (`list_connector_tools` + `call_connector_tool`). Full exposure.
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
  if (/^gconv-/.test(sessionId)) return 'tools+block';
  // Agent-edit gets `list_connector_tools` (read-only, no side effects) so the editor LLM can
  // learn each connector's action names and write specific workflow steps — but NOT
  // `call_connector_tool`, since an authoring session must never produce external side
  // effects. See `connector-meta-tools.ts::createConnectorMetaTools` mode handling.
  if (/^agent-/.test(sessionId)) return 'discover+block';
  return 'none';
}

/** System skills are authoring/orchestration affordances, not worker context.
 *  Keep them visible to the group-chat commander, agent editor, and skill editor only; ordinary
 *  agent workers should receive just the concrete skills exposed by their allowlist. */
export function systemSkillsExposureFromSessionId(sessionId: string): boolean {
  return /^gconv-/.test(sessionId) || /^agent-/.test(sessionId) || /^skill-/.test(sessionId);
}

/** OPEN-tier skills (external packages + global roots) render for the
 *  commander only — plan decision D5 (open-ecosystem-architecture.md).
 *  Agent workers, edit sessions, one-shots, and background kinds never
 *  see them; opening them to agents is a P2 item. */
export function openSkillSourcesExposureFromSessionId(sessionId: string): boolean {
  return /^gconv-/.test(sessionId);
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
