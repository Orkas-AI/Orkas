/**
 * Metacognition persistence — per-agent self-assessment (COMPETENCE.md)
 * and learning strategies (LEARNING_STRATEGIES.md).
 *
 * Storage(随 agent 目录形态,落在 `<uid>/cloud/agents/<aid>/meta/`):
 *   <uid>/cloud/agents/<aid>/meta/COMPETENCE.md          — free-form markdown
 *   <uid>/cloud/agents/<aid>/meta/LEARNING_STRATEGIES.md — free-form markdown
 *   <uid>/cloud/agents/_default/meta/...                 — for unbound conversations
 *
 * 删 agent → `agents.deleteCustomAgent` 直接 `rm -rf agents/<aid>/`,
 * meta/ 子目录随之消失;`purgeAgent` 留作显式清理入口(测试 / 异常恢复用)。
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
// 元认知/自演进总开关。两层串联：
//   1. env `ORKAS_METACOGNITION='0'`：dev/CI kill switch，硬关
//   2. 用户偏好 `preferences.json::metacognition_enabled`：UI 设置项；
//      undefined（未写过）→ 视为 on，保留历史默认行为
// runner.ts 与 reflection-trigger.ts 都从这里读，不要再到处复制 env 判断。
export function isFeatureEnabled(): boolean {
  if (process.env.ORKAS_METACOGNITION === '0') return false;
  // 延迟 require 避开循环：features/config -> features/avatars -> ... 链路都很轻，
  // 但元认知在启动早期路径上被调用，保守起见用 require 落到模块缓存。
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

  const parts: string[] = ['## 元认知（自我评估与学习策略）'];

  if (comp.content) {
    parts.push('### 能力画像 (COMPETENCE)');
    parts.push(comp.content);
  }
  if (strat.content) {
    parts.push('### 学习策略 (STRATEGIES)');
    parts.push(strat.content);
  }

  return parts.join('\n\n');
}
