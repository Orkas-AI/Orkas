/**
 * Model interaction client.
 *
 * Thin wrapper over the core-agent backend — see `./core-agent/client.ts`
 * for the actual implementation. This file exists so feature code can
 * keep doing `require('../model/client')` / `import { chatWithModel } from
 * '../model/client'` with no path changes.
 *
 * Public API:
 *   - `chatWithModel(opts)`        — blocking; returns { ok, text, error }
 *   - `streamChatWithModel(opts)`  — async generator yielding SSE-shape events
 *
 * Types (`ChatOptions`, `ChatResult`, `StreamEvent`) are defined here as the
 * cross-module contract between features/ and model/.
 */

import type { AgentTool } from '#core-agent';

import {
  chatWithModel as _chatWithModel,
  streamChatWithModel as _streamChatWithModel,
} from './core-agent/client';

export interface StreamEvent {
  type: 'progress' | 'event' | 'delta' | 'final' | 'error' | 'done';
  text?: string;
  event?: Record<string, unknown>;
  aborted?: boolean;
  /** Only present on the main-chat `final` event when the assistant text
   * contained a fenced `agent-input-form` block. Carries the parsed form
   * payload + the msgIndex at which the assistant message will land, so
   * the renderer can attach the widget live. */
  form?: unknown;
  msgIndex?: number;
}

export interface ChatResult {
  ok: boolean;
  text: string;
  error: string;
  aborted: boolean;
}

export interface ChatOptions {
  userId: string;
  message: string;
  sessionId?: string;
  /** Extra system prompt prepended to core-agent's auto-generated skills block.
   * Use this for conversation-level rules that must stay in context for every
   * turn (kept on the system channel, not duplicated into each user message). */
  systemPrompt?: string;
  /** Legacy agent-name knob — ignored by the core-agent backend but kept
   * in the signature so feature code that still passes it compiles. */
  agentName?: string;
  /** Working directory for tool execution (list_files, read_file, bash, etc.).
   * Defaults to process.cwd() if omitted. */
  workingDir?: string;
  /** Image attachments forwarded to vision-capable providers. `data` is base64
   * (no `data:` prefix). Used by `features/contexts_extract` for vision-based
   * description of uploaded images in the knowledge base staging area. */
  images?: Array<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }>;
  idleTimeout?: number;
  abortSignal?: AbortSignal | null;
  /** Legacy openclaw CLI timeout — ignored, retained for signature parity. */
  timeout?: number;
  /** Subset of skill ids to inject into this call's system prompt. Undefined
   * keeps the legacy behavior (every discovered skill is listed). Empty array
   * produces no skills block — used when the target agent declares
   * `skill_list: []`. Sourced from the target agent's `skill_list` field
   * (see `features/agents.ts`). */
  skillList?: string[];
  /** Extra tools merged into core-agent's builtin tool set for this call.
   * Currently used by group_chat commander to surface `plan_set` and
   * agent-management tools alongside the builtin set. */
  extraTools?: AgentTool[];
  /** Agent id bound to the conversation. Used to scope metacognition
   * (COMPETENCE.md / LEARNING_STRATEGIES.md) to the specific agent.
   * Empty/undefined = default scope ("_default"). */
  agentId?: string;
  /** Conversation id. Propagated into the file-tools factory so
   *  read_file / search_files / grep_files scope to this conv's attachment
   *  dir in addition to the user's active workspace. */
  cid?: string;
  /** Extra absolute directory roots whitelisted for file-tools on top of
   *  workspace + attachment. Read AND write are permitted under these roots.
   *  Per-skill edit chats pass the skill dir so the LLM can read / search /
   *  overwrite files it manages. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: read tools (read_file / search_files /
   *  grep_files / stat_file) can see these, but write-side tools
   *  (edit_file / write_file / bash / markdown_to_pdf / html_to_pdf /
   *  generate_image) cannot mutate paths inside. Used by group-chat
   *  commander to inspect agent / skill specs while the structured
   *  `<agent>` / `<skill>` containers remain the only sanctioned mutation
   *  channels. */
  readOnlyExtraRoots?: readonly string[];
  /** Fired with the absolute path of every file produced by the local-exec
   * tools (`write_file`, `markdown_to_pdf`, `html_to_pdf`) during this run.
   * `features/chats` uses this to attach a `produced[]` list to the
   * assistant message so the UI can offer a "reveal in Finder" chip. */
  onFileWritten?: (absPath: string) => void;
  /** Predicate: true when the given absolute path was already written by
   * this caller's session (typically: a `Set` populated by `onFileWritten`
   * earlier in the same turn). Used by the write-style tools' uniquify
   * logic to distinguish refinement (overwrite in place) from foreign
   * collision (rename to `-2 / -3 / ...`). When undefined, every
   * pre-existing path at the target is treated as a foreign collision. */
  hasProducedPath?: (absPath: string) => boolean;
  /** Prompt-cache TTL policy. Undefined lets pi-ai pick its default
   * (`"short"` = Anthropic 5m / OpenAI in-memory). `"long"` opts into
   * extended retention (Anthropic 1h with 2x write premium / OpenAI 24h).
   * `"none"` disables caching. Feature layer leaves this undefined today;
   * a future settings-page toggle will flip it per-user. Providers without
   * prompt-cache support (e.g. Mistral) silently ignore it. */
  cacheRetention?: 'none' | 'short' | 'long';
  /** Thinking/reasoning effort for reasoner models. Undefined lets the
   *  provider pick its default — for DeepSeek V4 Pro that's `'low'`
   *  (the API requires `reasoning_effort` whenever `model.reasoning` is
   *  true, otherwise 400 with a misleading "reasoning_content must be
   *  passed back" error); for Anthropic / OpenAI it stays off (cost-
   *  preserving). Set `'off'` to suppress thinking even on a reasoner;
   *  set `'low'` / `'high'` to override. */
  thinkingLevel?: 'off' | 'low' | 'high';
}

export const chatWithModel = _chatWithModel;
export const streamChatWithModel = _streamChatWithModel;
