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
 *   - `<uid>-gconv-*.jsonl` (commander session) AND
 *   - `<uid>-gmember-<cid>-<aid>.jsonl` (agent worker session) for the
 *     target agent — added per plan §1.3 P0 because agent worker tool
 *     calls / errors are the largest reflection blind spot when only
 *     the commander session is read.
 *
 * Output target: ~800 chars, ~250 tokens.
 */

import * as fs from 'node:fs';
import { userSessionFile } from '../paths';
import { createLogger } from '../logger';
import { listConversations, type Conversation } from './chats';
import { buildGmemberSessionId } from './group_chat/state';

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
    return `No new conversation activity in the range ${isoDate(sinceMs)} to ${isoDate(nowMs)}.`;
  }

  const parts: string[] = [];
  const range = `${isoDate(metrics.earliestTs ?? sinceMs)} to ${isoDate(metrics.latestTs ?? nowMs)}`;
  parts.push(`Based on ${metrics.sessionsAnalyzed} session(s) (${range}):`);

  const sortedTools = Object.entries(metrics.toolCalls).sort((a, b) => b[1] - a[1]).slice(0, TOOL_TOP_N);
  if (sortedTools.length) {
    parts.push('');
    parts.push('**Tool calls**:');
    for (const [name, n] of sortedTools) parts.push(`- ${name}: ${n}`);
  }

  if (metrics.errorCount > 0) {
    parts.push('');
    parts.push(`**Total errors**: ${metrics.errorCount}`);
    if (metrics.errorSamples.length) {
      parts.push('**Error samples**:');
      for (const s of metrics.errorSamples) parts.push(`- ${s}`);
    }
  }

  const sortedSkills = Object.entries(metrics.skillsLoaded).sort((a, b) => b[1] - a[1]).slice(0, SKILLS_TOP_N);
  if (sortedSkills.length) {
    parts.push('');
    parts.push('**Skills loaded**:');
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
    // Two sessions per matched conv: the commander gconv-* (already on
    // conv.session_id), and — when the target agent is a specific one
    // (not '_default') — the agent worker's gmember-* derived from
    // (cid, agentId). _default = commander-only convs.
    const sessionIds: string[] = [];
    if (conv.session_id) sessionIds.push(conv.session_id);
    if (agentId !== '_default') {
      sessionIds.push(buildGmemberSessionId(conv.conversation_id, agentId));
    }
    for (const sessionId of sessionIds) {
      _scanSessionFile(uid, sessionId, sinceMs, metrics);
    }
  }

  return formatDigest(metrics, sinceMs, nowMs);
}

/** Read one session jsonl (gated by mtime), parse lines, fold into metrics.
 *  Logs warn + skips on read errors so a single corrupt file doesn't break
 *  the digest. */
function _scanSessionFile(uid: string, sessionId: string, sinceMs: number, metrics: SessionMetrics): void {
  let file: string;
  try { file = userSessionFile(uid, sessionId); }
  catch { return; }
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch { return; }
  if (stat.mtimeMs < sinceMs) return;

  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { log.warn(`read ${file} failed: ${(err as Error).message}`); return; }
  const messages: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  aggregateSession(messages, metrics);
}
