/**
 * Build a compact activity digest for the metacognition reflection.
 *
 * Walks recent core-agent session jsonls bound to a target agent and
 * aggregates tool usage + errors into a markdown summary that gets
 * spliced into the reflection prompt as `conversationDigest`. Without
 * this, startup reflection is blind to what actually happened in the
 * cooldown window — see `reflection-trigger.ts` for the call site.
 *
 * Scope:
 *   - Only `<uid>-gconv-*.jsonl` are scanned (main conversations).
 *     Subagent invocations are not in scope (the `sub` kind has been
 *     deprecated; group_chat `gmember` sessions are the new home for
 *     per-agent histories).
 *
 * Output target: ~800 chars, ~250 tokens.
 */

import * as fs from 'node:fs';
import { userSessionFile } from '../paths';
import { createLogger } from '../logger';
import { listConversations, type Conversation } from './chats';

const log = createLogger('reflection-digest');

const ERROR_SAMPLE_MAX = 3;
const ERROR_SAMPLE_LEN = 160;
const TOOL_TOP_N = 8;
const SKILLS_TOP_N = 8;

// ── Aggregator (pure) ───────────────────────────────────────────────────

export interface SessionMetrics {
  sessionsAnalyzed: number;
  toolCalls: Record<string, number>;
  errorCount: number;
  errorSamples: string[];
  skillsLoaded: Record<string, number>;
  earliestTs: number | null;
  latestTs: number | null;
}

export function emptyMetrics(): SessionMetrics {
  return {
    sessionsAnalyzed: 0,
    toolCalls: {},
    errorCount: 0,
    errorSamples: [],
    skillsLoaded: {},
    earliestTs: null,
    latestTs: null,
  };
}

/**
 * Aggregate one session's messages into the running totals. Messages are
 * the parsed jsonl lines — same shape as core-agent emits (role + content
 * blocks: text / tool_use / tool_result).
 */
export function aggregateSession(messages: any[], into: SessionMetrics): void {
  if (!messages.length) return;
  into.sessionsAnalyzed += 1;

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.ts === 'number') {
      into.earliestTs = into.earliestTs === null ? m.ts : Math.min(into.earliestTs, m.ts);
      into.latestTs   = into.latestTs   === null ? m.ts : Math.max(into.latestTs, m.ts);
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        into.toolCalls[block.name] = (into.toolCalls[block.name] || 0) + 1;
        if (block.name === 'skill_manage' && block.input?.action === 'read' && typeof block.input?.id === 'string') {
          into.skillsLoaded[block.input.id] = (into.skillsLoaded[block.input.id] || 0) + 1;
        }
      } else if (block.type === 'tool_result' && block.isError === true) {
        into.errorCount += 1;
        if (into.errorSamples.length < ERROR_SAMPLE_MAX) {
          const text = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          into.errorSamples.push(text.slice(0, ERROR_SAMPLE_LEN).replace(/\s+/g, ' ').trim());
        }
      }
    }
  }
}

// ── Formatter (pure) ────────────────────────────────────────────────────

export function formatDigest(metrics: SessionMetrics, sinceMs: number, nowMs: number): string {
  if (metrics.sessionsAnalyzed === 0) {
    return `近期 (${isoDate(sinceMs)} 至 ${isoDate(nowMs)}) 无新增对话活动。`;
  }

  const parts: string[] = [];
  const range = `${isoDate(metrics.earliestTs ?? sinceMs)} 至 ${isoDate(metrics.latestTs ?? nowMs)}`;
  parts.push(`基于 ${metrics.sessionsAnalyzed} 个会话 (${range}):`);

  const sortedTools = Object.entries(metrics.toolCalls).sort((a, b) => b[1] - a[1]).slice(0, TOOL_TOP_N);
  if (sortedTools.length) {
    parts.push('');
    parts.push('**工具调用**:');
    for (const [name, n] of sortedTools) parts.push(`- ${name}: ${n} 次`);
  }

  if (metrics.errorCount > 0) {
    parts.push('');
    parts.push(`**错误总数**: ${metrics.errorCount}`);
    if (metrics.errorSamples.length) {
      parts.push('**错误样本**:');
      for (const s of metrics.errorSamples) parts.push(`- ${s}`);
    }
  }

  const sortedSkills = Object.entries(metrics.skillsLoaded).sort((a, b) => b[1] - a[1]).slice(0, SKILLS_TOP_N);
  if (sortedSkills.length) {
    parts.push('');
    parts.push('**加载的技能**:');
    for (const [id, n] of sortedSkills) parts.push(`- ${id}${n > 1 ? ` (${n}x)` : ''}`);
  }

  return parts.join('\n');
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── I/O wrapper ─────────────────────────────────────────────────────────

/**
 * Build the digest for a target agent ('_default' or a specific agent_id).
 * Picks conversations whose `agent_id` matches and whose session jsonl
 * was modified at or after `sinceMs`.
 */
export async function buildAgentReflectionDigest(
  uid: string,
  agentId: string,
  sinceMs: number,
  nowMs: number = Date.now(),
): Promise<string> {
  const metrics = emptyMetrics();
  let convs: Conversation[] = [];
  try {
    convs = await listConversations(uid);
  } catch (err) {
    log.warn(`listConversations failed for uid ${uid}: ${(err as Error).message}`);
    return formatDigest(metrics, sinceMs, nowMs);
  }

  // _default → empty agent_id; specific agent → exact match
  const targetMatches = (convAgentId: string): boolean =>
    agentId === '_default' ? !convAgentId : convAgentId === agentId;

  for (const conv of convs) {
    if (!targetMatches(conv.agent_id || '')) continue;
    if (!conv.session_id) continue;
    let file: string;
    try { file = userSessionFile(uid, conv.session_id); }
    catch { continue; }
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch { continue; }
    if (stat.mtimeMs < sinceMs) continue;

    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { log.warn(`read ${file} failed: ${(err as Error).message}`); continue; }
    const messages: any[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); }
      catch { /* skip malformed line */ }
    }
    aggregateSession(messages, metrics);
  }

  return formatDigest(metrics, sinceMs, nowMs);
}
