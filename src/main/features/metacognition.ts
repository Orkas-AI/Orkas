/**
 * Metacognition persistence — per-agent self-assessment (COMPETENCE.md)
 * and learning strategies (LEARNING_STRATEGIES.md).
 *
 * Storage (follows the agent directory layout, lives at `<uid>/cloud/agents/<aid>/meta/`):
 *   <uid>/cloud/agents/<aid>/meta/COMPETENCE.md          — free-form markdown
 *   <uid>/cloud/agents/<aid>/meta/LEARNING_STRATEGIES.md — free-form markdown
 *   <uid>/cloud/agents/_default/meta/...                 — for unbound conversations
 *
 * Deleting an agent → `agents.deleteCustomAgent` runs `rm -rf agents/<aid>/`
 * directly, so the `meta/` subdirectory disappears with it; `purgeAgent`
 * remains as an explicit cleanup entry point (used by tests / recovery).
 *
 * Unlike memory.ts (which uses §-separated entries), metacognition files
 * are free-form markdown that the agent writes and reads as a whole.
 * The agent structures them with ## headings internally.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentCompetenceFile, agentStrategiesFile, agentMetaDir } from '../paths';
import { writeTextAtomicSync } from '../storage';
import { createLogger } from '../logger';
import { scanForInjection } from './memory';
import { getActiveUserId } from './users';

const log = createLogger('metacognition');

/** Sentinel agent id for conversations not bound to a specific agent. */
export const DEFAULT_AGENT_ID = '_default';

// ── Constants ────────────────────────────────────────────────────────────
export const COMPETENCE_CHAR_LIMIT = 3000;   // ~1000 tokens
export const STRATEGIES_CHAR_LIMIT = 4000;   // ~1300 tokens — strategies is a play-library, naturally grows; competence is a self-check, stays small

// ── Feature gate (single source of truth) ────────────────────────────────
// Master switch for metacognition / self-evolution. Two layers ANDed together:
//   1. env `ORKAS_METACOGNITION='0'` — dev/CI kill switch, hard off.
//   2. user preference `preferences.json::metacognition_enabled` — UI setting;
//      undefined (never written) → treated as on, preserving historical default.
// runner.ts and reflection-trigger.ts both read from here; don't sprinkle the
// env check around again.
export function isFeatureEnabled(): boolean {
  if (process.env.ORKAS_METACOGNITION === '0') return false;
  // Lazy-require to break a potential cycle: features/config -> features/avatars
  // -> ... is light, but metacognition is called early during startup; play
  // safe and use require so it lands in the module cache.
  try {
    const cfg = require('./config') as typeof import('./config');
    return cfg.getMetacognitionEnabled();
  } catch {
    return true;
  }
}

// ── Types ────────────────────────────────────────────────────────────────
export interface MetacognitionOpResult {
  ok: boolean;
  error?: string;
  content: string;
  usage: { current: number; limit: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Normalize empty/undefined agent id to the default sentinel. */
function normalizeAgentId(agentId: string | undefined | null): string {
  return agentId || DEFAULT_AGENT_ID;
}

function fileForTarget(agentId: string, target: 'competence' | 'strategies'): string {
  const id = normalizeAgentId(agentId);
  const uid = getActiveUserId();
  return target === 'competence' ? agentCompetenceFile(uid, id) : agentStrategiesFile(uid, id);
}

function limitForTarget(target: 'competence' | 'strategies'): number {
  return target === 'competence' ? COMPETENCE_CHAR_LIMIT : STRATEGIES_CHAR_LIMIT;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Read the full content of a metacognition file. */
export function readContent(agentId: string, target: 'competence' | 'strategies'): MetacognitionOpResult {
  const filePath = fileForTarget(agentId, target);
  const limit = limitForTarget(target);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    // File doesn't exist yet — that's fine
  }
  return {
    ok: true,
    content,
    usage: { current: content.length, limit },
  };
}

/** Write (replace) the full content of a metacognition file. */
export function writeContent(agentId: string, target: 'competence' | 'strategies', content: string): MetacognitionOpResult {
  const trimmed = content.trim();
  const limit = limitForTarget(target);
  const id = normalizeAgentId(agentId);

  if (!trimmed) {
    return { ok: false, error: 'empty content', content: '', usage: { current: 0, limit } };
  }

  // Security scan
  const threat = scanForInjection(trimmed);
  if (threat) {
    log.warn(`blocked metacognition write (${threat}): ${trimmed.slice(0, 80)}...`);
    return {
      ok: false,
      error: `blocked: suspicious content (${threat})`,
      content: '',
      usage: { current: 0, limit },
    };
  }

  // Reject oversize writes so the LLM sees the overflow and condenses,
  // instead of silently losing the tail of its self-assessment. The tool
  // description already tells the LLM the limit — this is the safety net.
  if (trimmed.length > limit) {
    log.warn(`${target} write rejected for agent ${id}: ${trimmed.length} > ${limit}`);
    return {
      ok: false,
      error: `content exceeds limit: ${trimmed.length}/${limit} chars — condense and retry`,
      content: '',
      usage: { current: trimmed.length, limit },
    };
  }

  const filePath = fileForTarget(agentId, target);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeTextAtomicSync(filePath, trimmed);

  log.info(`updated ${target} for agent ${id} (${trimmed.length}/${limit} chars)`);

  return {
    ok: true,
    content: trimmed,
    usage: { current: trimmed.length, limit },
  };
}

/** Clear a metacognition file. */
export function clearContent(agentId: string, target: 'competence' | 'strategies'): void {
  const filePath = fileForTarget(agentId, target);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextAtomicSync(filePath, '');
  } catch (err) {
    log.warn(`clearContent(${target}) failed: ${(err as Error).message}`);
  }
}

/** Remove all metacognition data for an agent (used on agent deletion). */
export function purgeAgent(agentId: string): void {
  const dir = agentMetaDir(getActiveUserId(), normalizeAgentId(agentId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`purged metacognition for agent ${agentId}`);
  } catch (err) {
    log.warn(`purgeAgent(${agentId}) failed: ${(err as Error).message}`);
  }
}

// ── System prompt formatting ─────────────────────────────────────────────

/**
 * Format metacognition content for system prompt injection.
 * Returns empty string if no content exists for this agent.
 */
export function formatForSystemPrompt(agentId: string): string {
  const comp = readContent(agentId, 'competence');
  const strat = readContent(agentId, 'strategies');

  if (!comp.content && !strat.content) return '';

  const parts: string[] = ['## Metacognition (self-assessment & learning strategies)'];

  if (comp.content) {
    parts.push('### Competence profile (COMPETENCE)');
    parts.push(comp.content);
  }
  if (strat.content) {
    parts.push('### Learning strategies (STRATEGIES)');
    parts.push(strat.content);
  }

  return parts.join('\n\n');
}
