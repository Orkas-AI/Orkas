/**
 * Semantic context compiler for external CLI-backed agents.
 *
 * The group-chat bus owns conversation semantics, but CLI adapters should not
 * receive one monolithic user message containing identity, protocols, history,
 * and the current task on every turn. This module keeps those regions distinct:
 *
 *   durableInstructions — low-churn agent/project/protocol guidance;
 *   turnPrompt          — only the current task and current-turn runtime data;
 *   recoveryContext     — bounded prior visible context for a fresh session.
 *
 * Each backend declares its instruction channel and lifetime in the local CLI
 * capability registry. The compiler uses that contract instead of recognizing
 * backend names.
 */

import * as crypto from 'node:crypto';
import type { Lang } from '../../i18n.js';
import { localCliCapabilities } from './registry.js';

export const CLI_RECOVERY_MAX_BYTES = 16 * 1024;

export interface CliContextPlan {
  version: 2;
  durableInstructions: string;
  durableHash: string;
  turnPrompt: string;
  recoveryContext: string;
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

export function buildCliRecoveryContext(input: {
  historyLines?: string[];
  attachmentPaths?: string[];
  maxBytes?: number;
}): string {
  const maxBytes = Math.max(1024, input.maxBytes || CLI_RECOVERY_MAX_BYTES);
  const attachments = uniqueNonEmpty(input.attachmentPaths || []);
  const lines = (input.historyLines || []).map((line) => String(line || '').trim()).filter(Boolean);
  const keptLines = lines.slice();
  const keptAttachments = attachments.slice();
  const render = () => {
    const blocks: string[] = [];
    if (keptLines.length) {
      blocks.push(
        `## Conversation context recovered by Orkas`
        + `${keptLines.length < lines.length ? ' (older entries omitted)' : ''}`
        + `\n${keptLines.join('\n')}`,
      );
    }
    if (keptAttachments.length) {
      blocks.push(
        `## Earlier attachments`
        + `${keptAttachments.length < attachments.length ? ' (older paths omitted)' : ''}`
        + `\n${keptAttachments.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    return blocks.join('\n\n');
  };

  // Old attachment paths are less valuable than visible dialogue, so trim
  // them first; both lists remove oldest-first and therefore retain the most
  // recent recoverable context. Re-rendering includes section headers in the
  // byte accounting, guaranteeing the whole recovery payload stays bounded.
  let rendered = render();
  while (Buffer.byteLength(rendered, 'utf8') > maxBytes && keptAttachments.length) {
    keptAttachments.shift();
    rendered = render();
  }
  while (Buffer.byteLength(rendered, 'utf8') > maxBytes && keptLines.length) {
    keptLines.shift();
    rendered = render();
  }
  return rendered;
}

export function createCliContextPlan(input: {
  durableInstructions: string;
  turnPrompt: string;
  recoveryContext?: string;
  passthrough?: boolean;
}): CliContextPlan {
  const durableInstructions = String(input.durableInstructions || '').trim();
  return {
    version: 2,
    durableInstructions,
    durableHash: fingerprintCliContext(durableInstructions),
    turnPrompt: String(input.turnPrompt || '').trim(),
    recoveryContext: String(input.recoveryContext || '').trim(),
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
  const normalPrompt = resumed ? plan.turnPrompt : recoveryAndTurn;
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

function joinBlocks(...values: string[]): string {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n\n');
}
