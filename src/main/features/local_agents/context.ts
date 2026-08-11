/**
 * Semantic context compiler for external CLI-backed agents.
 *
 * The group-chat bus owns conversation semantics, but CLI adapters should not
 * receive one monolithic user message containing identity, protocols, history,
 * and the current task on every turn. This module keeps those regions distinct:
 *
 *   durableInstructions — low-churn agent/project/protocol guidance;
 *   turnPrompt          — only the current task and current-turn runtime data;
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

export const CLI_RECOVERY_MAX_BYTES = 16 * 1024;
export const CLI_HISTORY_MAX_TURNS = 20;
export const CLI_HISTORY_MAX_MESSAGE_BYTES = 8 * 1024;

export interface CliHistoryTurn {
  id: string;
  messages: string[];
}

export interface CliContextPlan {
  version: 3;
  durableInstructions: string;
  durableHash: string;
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

const CLI_RESUME_REJECTED_PATTERNS = [
  /No conversation found with session ID/i,
  /session.*(not found|does not exist|expired|invalid|unknown)/i,
  /(not found|does not exist|expired|invalid|unknown).*session/i,
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
  workflow?: string;
  codingProtocol?: string;
  projectInstructions?: string;
  language: Lang;
}): string {
  const blocks: string[] = [];
  const name = String(input.agentName || '').trim();
  if (name) blocks.push(`You are "${name}".`);

  const workflow = String(input.workflow || '').trim();
  if (workflow) blocks.push(`## Workflow\n\n${workflow}`);

  const codingProtocol = String(input.codingProtocol || '').trim();
  if (codingProtocol) blocks.push(codingProtocol);

  const projectInstructions = String(input.projectInstructions || '').trim();
  if (projectInstructions) blocks.push(projectInstructions);

  blocks.push(buildCompactCliLanguageInstruction(input.language));
  return blocks.filter(Boolean).join('\n\n');
}

export function buildCliTurnPrompt(input: {
  task: string;
  attachmentPaths?: string[];
  runtimeProtocol?: string;
}): string {
  const blocks: string[] = [];
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

/**
 * Render complete, newest-first-selected conversation turns under both count
 * and byte limits. The caller supplies canonical-log rows already grouped into
 * turns; this layer owns only transport limits, so CLI backends all receive the
 * same bounded semantics.
 */
export function buildCliConversationContext(input: {
  turns: CliHistoryTurn[];
  mode: 'recovery' | 'incremental';
  maxBytes?: number;
  maxTurns?: number;
  maxMessageBytes?: number;
}): string {
  const maxBytes = Math.max(1024, input.maxBytes || CLI_RECOVERY_MAX_BYTES);
  const maxTurns = Math.max(1, input.maxTurns || CLI_HISTORY_MAX_TURNS);
  const maxMessageBytes = Math.max(256, input.maxMessageBytes || CLI_HISTORY_MAX_MESSAGE_BYTES);
  const allTurns = input.turns
    .map((turn) => ({
      id: String(turn.id || '').trim() || 'unknown',
      messages: turn.messages
        .map((message) => truncateUtf8(String(message || '').trim(), maxMessageBytes))
        .filter(Boolean),
    }))
    .filter((turn) => turn.messages.length > 0);
  if (allTurns.length === 0) return '';

  const omittedByCount = Math.max(0, allTurns.length - maxTurns);
  const kept = allTurns.slice(-maxTurns);
  const title = input.mode === 'incremental'
    ? '## Conversation updates since the previous CLI turn'
    : '## Conversation context recovered by Orkas';
  let omittedByBytes = 0;

  const render = (turns: typeof kept, oversizedBody?: string) => {
    const omitted = omittedByCount + omittedByBytes;
    const marker = omitted > 0 ? `\n[${omitted} older turn${omitted === 1 ? '' : 's'} omitted]` : '';
    const body = oversizedBody ?? turns
      .map((turn) => `### Turn ${turn.id}\n${turn.messages.join('\n')}`)
      .join('\n\n');
    return `${title}${marker}\n${body}`;
  };

  let rendered = render(kept);
  while (Buffer.byteLength(rendered, 'utf8') > maxBytes && kept.length > 1) {
    kept.shift();
    omittedByBytes += 1;
    rendered = render(kept);
  }
  if (Buffer.byteLength(rendered, 'utf8') <= maxBytes) return rendered;

  // A single pathological turn may itself exceed the transport budget. Keep
  // its newest bounded representation and make the truncation explicit.
  const only = kept[0];
  const prefix = render([{ ...only, messages: [] }], '').replace(/\n$/, '');
  const available = Math.max(0, maxBytes - Buffer.byteLength(`${prefix}\n`, 'utf8'));
  const body = truncateUtf8(
    `### Turn ${only.id}\n${only.messages.join('\n')}`,
    available,
  );
  return `${prefix}\n${body}`;
}

export function createCliContextPlan(input: {
  durableInstructions: string;
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
  const names: Record<Lang, string> = {
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

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '\n[… message truncated by Orkas …]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) {
    return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
  }
  const budget = maxBytes - markerBytes;
  const headBytes = Math.ceil(budget / 2);
  const tailBytes = Math.floor(budget / 2);
  const raw = Buffer.from(value, 'utf8');
  const head = raw.subarray(0, headBytes).toString('utf8').replace(/\uFFFD+$/u, '');
  const tail = raw.subarray(Math.max(0, raw.length - tailBytes)).toString('utf8').replace(/^\uFFFD+/u, '');
  return `${head}${marker}${tail}`;
}

function joinBlocks(...values: string[]): string {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n\n');
}
