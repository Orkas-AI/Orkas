import { fitHistoryTextSuffix } from '../../util/history-text-window';
import { estimateBudgetTokens } from '../../util/token-estimate';
import { projectHistoryMediaText } from '../../util/history-media';
/**
 * Semantic context compiler for external CLI-backed agents.
 *
 * The group-chat bus owns conversation semantics, but CLI adapters should not
 * receive one monolithic user message containing identity, protocols, history,
 * and the current task on every turn. This module keeps those regions distinct:
 *
 *   durableInstructions — low-churn agent/project/protocol guidance;
 *   turnPrompt          — dynamic project/runtime data followed by the current task;
 *   recoveryContext     — bounded canonical context for a fresh session;
 *   incrementalContext  — bounded canonical delta for a resumed session.
 *
 * Each backend declares its instruction channel and lifetime in the local CLI
 * capability registry. The compiler uses that contract instead of recognizing
 * backend names.
 */

import * as crypto from 'node:crypto';
import type { Lang } from '../../i18n.js';
import { localCliCapabilities } from './registry.js';

export const CLI_HISTORY_MAX_TURNS = 5;
export const CLI_HISTORY_MAX_TOKENS = 30_000;

export interface CliHistoryTurn {
  id: string;
  messages: string[];
}

export interface CliContextPlan {
  version: 3;
  durableInstructions: string;
  durableHash: string;
  /** Hash of the canonical Agent-memory block for resumable backends that
   * support private Agent memory. The block itself remains dynamic turn
   * context and is never synthesized when the store is empty. */
  agentMemoryHash?: string;
  /** Sorted fingerprints of the individual Agent-memory entries behind
   * `agentMemoryHash`. A resumed session may keep running after appends;
   * only a removed or edited entry it has already seen forces a reset. */
  agentMemoryEntryHashes?: string[];
  turnPrompt: string;
  recoveryContext: string;
  incrementalContext: string;
  passthrough?: boolean;
}

export interface CliContextMaterialization {
  prompt: string;
  systemPrompt?: string;
  resumeFallbackPrompt: string;
}

// A rejected resume drops the native session binding and restarts the CLI
// from bounded recovery, so a false match costs the user their working
// context. Match only the CLI's own stale-session phrasings: the failure
// word must sit next to the word "session" (optionally its id), not anywhere
// on a line that merely mentions a session file, flag, or module.
const CLI_RESUME_REJECTED_PATTERNS = [
  /No conversation found with session ID/i,
  /\bsession(?: id)?\b(?: [^\s]+)? (?:was |is |has )?(?:not found|does not exist|no longer exists|expired|invalid|unknown)\b/i,
  /\b(?:unknown|invalid|expired|stale|no such|missing) session(?: id)?\b/i,
];

export function isCliResumeRejectedMessage(value: unknown): boolean {
  const text = String(value || '');
  return !!text && CLI_RESUME_REJECTED_PATTERNS.some((pattern) => pattern.test(text));
}

export function fingerprintCliContext(value: string): string {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function buildCliDurableInstructions(input: {
  agentName: string;
  intentRules?: string;
  workflow?: string;
  codingProtocol?: string;
  projectContext?: string;
  language: Lang;
}): string {
  const blocks: string[] = [];
  const name = String(input.agentName || '').trim();
  if (name) blocks.push(`You are "${name}".`);

  const intentRules = String(input.intentRules || '').trim();
  if (intentRules) blocks.push(intentRules);

  const workflow = String(input.workflow || '').trim();
  if (workflow) blocks.push(`## Workflow\n\n${workflow}`);

  const codingProtocol = String(input.codingProtocol || '').trim();
  if (codingProtocol) blocks.push(codingProtocol);

  const projectContext = String(input.projectContext || '').trim();
  if (projectContext) blocks.push(projectContext);

  blocks.push(buildCompactCliLanguageInstruction(input.language));
  return blocks.filter(Boolean).join('\n\n');
}

export function buildCliTurnPrompt(input: {
  task: string;
  projectContext?: string;
  attachmentPaths?: string[];
  runtimeProtocol?: string;
}): string {
  const blocks: string[] = [];
  const projectContext = String(input.projectContext || '').trim();
  if (projectContext) blocks.push(projectContext);

  const runtimeProtocol = String(input.runtimeProtocol || '').trim();
  if (runtimeProtocol) blocks.push(runtimeProtocol);

  const attachments = uniqueNonEmpty(input.attachmentPaths || []);
  if (attachments.length) {
    blocks.push(`## Attachments\n${attachments.map((p) => `- ${p}`).join('\n')}`);
  }

  const task = String(input.task || '').trim();
  if (blocks.length === 0) return task;
  if (task) blocks.push(`## Your task\n\n${task}`);
  return blocks.join('\n\n');
}

/** Canonical recovery/delta uses the same five-turn / 30K-token ceilings as
 * in-process history. Native CLI session history and compaction remain CLI-owned;
 * adapters do not currently expose trustworthy remaining-window capacity. */
export function buildCliConversationContext(input: {
  turns: CliHistoryTurn[];
  mode: 'recovery' | 'incremental';
}): string {
  const allTurns = input.turns
    .map((turn) => ({
      id: String(turn.id || '').trim() || 'unknown',
      messages: turn.messages
        .map((message) => projectHistoryMediaText(String(message || '').trim()))
        .filter(Boolean),
    }))
    .filter((turn) => turn.messages.length > 0);
  if (allTurns.length === 0) return '';

  const kept = allTurns.slice(-CLI_HISTORY_MAX_TURNS);
  const title = input.mode === 'incremental'
    ? '## Conversation updates since the previous CLI turn'
    : '## Conversation context recovered by Orkas';
  const entries = kept.flatMap((turn, turnIndex) => turn.messages.map((text, messageIndex) => ({ text, turnIndex, messageIndex })));
  return fitHistoryTextSuffix(entries.map(entry => entry.text), CLI_HISTORY_MAX_TOKENS, (first, boundaryText) => {
    const boundary = entries[first];
    const firstTurn = boundary?.turnIndex ?? kept.length;
    const omitted = allTurns.length - kept.length + firstTurn;
    const marker = omitted > 0 ? `\n[${omitted} older turn${omitted === 1 ? '' : 's'} omitted]` : '';
    const body = kept.slice(firstTurn).map((turn, offset) => {
      const messages = offset === 0 && boundary
        ? turn.messages.slice(boundary.messageIndex).map((text, index) => index === 0 ? boundaryText ?? text : text)
        : turn.messages;
      return `### Turn ${turn.id}\n${messages.join('\n')}`;
    }).join('\n\n');
    const status = '[History window: this block contains recent dialogue and references, not a full execution transcript. Earlier dialogue and public tool records may be available via chat_history.]';
    return `${title}${marker}\n${status}\n${body}`;
  }, estimateBudgetTokens, '');
}

export function createCliContextPlan(input: {
  durableInstructions: string;
  agentMemoryHash?: string;
  agentMemoryEntryHashes?: string[];
  turnPrompt: string;
  recoveryContext?: string;
  incrementalContext?: string;
  passthrough?: boolean;
}): CliContextPlan {
  const durableInstructions = String(input.durableInstructions || '').trim();
  return {
    version: 3,
    durableInstructions,
    durableHash: fingerprintCliContext(durableInstructions),
    ...(input.agentMemoryHash ? { agentMemoryHash: input.agentMemoryHash } : {}),
    ...(input.agentMemoryEntryHashes ? { agentMemoryEntryHashes: [...input.agentMemoryEntryHashes].sort() } : {}),
    turnPrompt: String(input.turnPrompt || '').trim(),
    recoveryContext: String(input.recoveryContext || '').trim(),
    incrementalContext: String(input.incrementalContext || '').trim(),
    ...(input.passthrough ? { passthrough: true } : {}),
  };
}

export function materializeCliContext(
  plan: CliContextPlan,
  opts: { cli: string; resumed: boolean },
): CliContextMaterialization {
  const capabilities = localCliCapabilities(opts.cli);
  const nativeInstructions = capabilities.instructionChannel === 'native';
  // A backend that declares resume=none is fresh even if a stale caller passes
  // resumed=true. This keeps Hermes and future one-shot adapters from silently
  // dropping durable instructions and visible recovery context.
  const resumed = opts.resumed && capabilities.resume !== 'none';
  if (plan.passthrough) {
    return {
      prompt: plan.turnPrompt,
      ...(nativeInstructions && plan.durableInstructions
        ? { systemPrompt: plan.durableInstructions }
        : {}),
      resumeFallbackPrompt: plan.turnPrompt,
    };
  }
  const recoveryAndTurn = joinBlocks(plan.recoveryContext, plan.turnPrompt);
  const incrementalAndTurn = joinBlocks(plan.incrementalContext, plan.turnPrompt);
  const normalPrompt = resumed ? incrementalAndTurn : recoveryAndTurn;
  const sessionOwnsDurableInstructions = resumed
    && capabilities.durableInstructionScope === 'session';
  return {
    prompt: nativeInstructions
      ? normalPrompt
      : joinBlocks(sessionOwnsDurableInstructions ? '' : plan.durableInstructions, normalPrompt),
    ...(nativeInstructions && plan.durableInstructions
      ? { systemPrompt: plan.durableInstructions }
      : {}),
    resumeFallbackPrompt: nativeInstructions
      ? recoveryAndTurn
      : joinBlocks(plan.durableInstructions, recoveryAndTurn),
  };
}

function buildCompactCliLanguageInstruction(lang: Lang): string {
  const names: Partial<Record<Lang, string>> = {
    zh: 'Chinese (简体中文)',
    en: 'English',
    ja: 'Japanese (日本語)',
    pt: 'Portuguese (Brazil)',
  };
  return [
    '## Response language',
    `Write human-readable responses and form labels in ${names[lang] || names.en} unless the user explicitly requests another language. Keep XML tags, JSON keys, ids, file paths, and code unchanged.`,
  ].join('\n\n');
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function joinBlocks(...values: string[]): string {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n\n');
}
