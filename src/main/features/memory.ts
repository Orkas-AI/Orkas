/**
 * Cross-session memory — per-user persistent notes (MEMORY.md) and
 * user profile (USER.md).
 *
 * Inspired by hermes-agent's built-in memory: small markdown files using
 * `§` as entry separator, frozen into the system prompt at session start,
 * and mutated via an agent tool during the conversation.
 *
 * Storage:
 *   data/<user_id>/memory/MEMORY.md   — agent notes (~2200 char cap)
 *   data/<user_id>/memory/USER.md     — user profile (~1375 char cap)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userMemoryFile, userProfileFile, userMemoryDir } from '../paths';
import { writeTextAtomicSync } from '../storage';
import { createLogger } from '../logger';

const log = createLogger('memory');

// ── Constants ────────────────────────────────────────────────────────────
export const MEMORY_CHAR_LIMIT = 2200;   // ~800 tokens
export const USER_CHAR_LIMIT   = 1375;   // ~500 tokens
export const ENTRY_SEPARATOR   = '\n§\n';

// ── Types ────────────────────────────────────────────────────────────────
export interface MemoryEntry {
  text: string;
}

export interface MemoryOpResult {
  ok: boolean;
  error?: string;
  entries: string[];
  usage: { current: number; limit: number };
}

// ── Security: injection pattern scanning ─────────────────────────────────
const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Prompt injection
  { re: /ignore\s+(all\s+)?previous\s+instructions/i, label: 'prompt-injection' },
  { re: /you\s+are\s+now\s+/i, label: 'prompt-injection' },
  { re: /^system\s*:/im, label: 'prompt-injection' },
  { re: /disregard\s+(all\s+)?(prior|above|previous)/i, label: 'prompt-injection' },
  // Secret exfiltration
  { re: /(curl|wget)\s+.*\b(api[_-]?key|bearer|token|secret)\b/i, label: 'exfiltration' },
  { re: /\.netrc/i, label: 'exfiltration' },
  // Invisible unicode
  { re: /[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/, label: 'invisible-unicode' },
];

export function scanForInjection(content: string): string | null {
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fileForTarget(userId: string, target: 'memory' | 'user'): string {
  return target === 'memory' ? userMemoryFile(userId) : userProfileFile(userId);
}

function limitForTarget(target: 'memory' | 'user'): number {
  return target === 'memory' ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
}

/** Load §-separated entries from a markdown file. */
export function loadEntries(filePath: string): MemoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  // Split by § (may be surrounded by newlines)
  return raw.split(/\n?§\n?/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(text => ({ text }));
}

/** Save entries atomically, respecting char limit (drops excess from end). */
export function saveEntries(filePath: string, entries: MemoryEntry[], charLimit: number): void {
  // Deduplicate (keep first occurrence)
  const seen = new Set<string>();
  const deduped: MemoryEntry[] = [];
  for (const e of entries) {
    if (!seen.has(e.text)) {
      seen.add(e.text);
      deduped.push(e);
    }
  }

  // Build text, trim from end if over limit
  let kept = [...deduped];
  let text = kept.map(e => e.text).join(ENTRY_SEPARATOR);
  while (text.length > charLimit && kept.length > 1) {
    kept.pop();
    text = kept.map(e => e.text).join(ENTRY_SEPARATOR);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeTextAtomicSync(filePath, text);
}

function buildResult(userId: string, target: 'memory' | 'user', ok: boolean, error?: string): MemoryOpResult {
  const entries = loadEntries(fileForTarget(userId, target));
  const text = entries.map(e => e.text).join(ENTRY_SEPARATOR);
  return {
    ok,
    ...(error ? { error } : {}),
    entries: entries.map(e => e.text),
    usage: { current: text.length, limit: limitForTarget(target) },
  };
}

// ── Public API ───────────────────────────────────────────────────────────

export function addEntry(userId: string, target: 'memory' | 'user', content: string): MemoryOpResult {
  const trimmed = content.trim();
  if (!trimmed) return buildResult(userId, target, false, 'empty content');

  const threat = scanForInjection(trimmed);
  if (threat) {
    log.warn(`blocked memory write (${threat}): ${trimmed.slice(0, 80)}...`);
    return buildResult(userId, target, false, `blocked: suspicious content (${threat})`);
  }

  const filePath = fileForTarget(userId, target);
  const limit = limitForTarget(target);
  const entries = loadEntries(filePath);
  entries.push({ text: trimmed });
  saveEntries(filePath, entries, limit);
  return buildResult(userId, target, true);
}

export function replaceEntry(userId: string, target: 'memory' | 'user', oldText: string, content: string): MemoryOpResult {
  const trimmed = content.trim();
  if (!trimmed) return buildResult(userId, target, false, 'empty content');

  const threat = scanForInjection(trimmed);
  if (threat) {
    log.warn(`blocked memory write (${threat}): ${trimmed.slice(0, 80)}...`);
    return buildResult(userId, target, false, `blocked: suspicious content (${threat})`);
  }

  const filePath = fileForTarget(userId, target);
  const limit = limitForTarget(target);
  const entries = loadEntries(filePath);
  const idx = entries.findIndex(e => e.text.includes(oldText));
  if (idx === -1) return buildResult(userId, target, false, 'old_text not found');

  entries[idx] = { text: trimmed };
  saveEntries(filePath, entries, limit);
  return buildResult(userId, target, true);
}

export function removeEntry(userId: string, target: 'memory' | 'user', oldText: string): MemoryOpResult {
  const filePath = fileForTarget(userId, target);
  const limit = limitForTarget(target);
  const entries = loadEntries(filePath);
  const idx = entries.findIndex(e => e.text.includes(oldText));
  if (idx === -1) return buildResult(userId, target, false, 'old_text not found');

  entries.splice(idx, 1);
  saveEntries(filePath, entries, limit);
  return buildResult(userId, target, true);
}

export function listEntries(userId: string, target: 'memory' | 'user'): MemoryOpResult {
  return buildResult(userId, target, true);
}

export function clearMemory(userId: string, target: 'memory' | 'user'): void {
  const filePath = fileForTarget(userId, target);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextAtomicSync(filePath, '');
  } catch (err) {
    log.warn(`clearMemory failed: ${(err as Error).message}`);
  }
}

// ── System prompt guidance (always injected) ─────────────────────────────

const MEMORY_GUIDANCE = [
  '## Cross-session memory',
  '',
  'You have persistent memory across sessions via the `cross_session_memory` tool. Memory persists across conversations.',
  '',
  '⚠️ Core principle: when the user shares any personal information, you MUST immediately call the cross_session_memory tool to save it — not just acknowledge it verbally. Not calling the tool = forgetting.',
  '',
  '**You MUST call the tool in these situations (verbal acknowledgment alone = forgetting, strictly forbidden):**',
  '- User explicitly says "remember", "make a note", "don\'t forget"',
  '- User corrects your behavior ("don\'t do that", "from now on please…")',
  '- User shares personal preferences, interests, or habits → target="user"',
  '  e.g. "I like basketball", "I love coffee", "my hobby is swimming", "I\'m an early riser", "I dislike overtime"',
  '- User reveals their role, profession, or identity → target="user"',
  '  e.g. "I\'m a product manager", "I\'m a founder", "I\'m a student"',
  '- User mentions tech preferences or tool choices → target="user"',
  '  e.g. "I use VS Code", "I prefer TypeScript", "we use React"',
  '- User describes their personality or communication style → target="user"',
  '  e.g. "I\'m direct", "I prefer concise answers"',
  '',
  '**Rule of thumb: whenever the user\'s words contain a self-disclosing phrase like "I like / I love / I prefer / I usually / I dislike / I hate / I am / I\'m working on / my hobby / I tend to" — or its equivalent in any other language — you MUST call the tool with target="user". Better to over-save than to miss.**',
  '',
  '**You should proactively call the tool in these situations (target="memory"):**',
  '- Important decisions or milestones ("we decided to use X", "the project has shipped")',
  '- Project conventions or environment info ("deployed on AWS", "uses PostgreSQL")',
  '',
  '**Do NOT save:**',
  '- One-off debugging details',
  '- Large code blocks or raw log dumps',
  '',
  'Two targets:',
  '- `memory`: your notes (facts, decisions, milestones, project conventions)',
  '- `user`: user profile (role, preferences, interests, communication style, tech stack)',
].join('\n');

/**
 * Format memory guidance + existing entries as a system prompt block.
 * Always includes guidance so the LLM knows it has persistent memory,
 * even when there are no entries yet.
 */
export function formatForSystemPrompt(userId: string): string {
  const memEntries = loadEntries(userMemoryFile(userId));
  const userEntries = loadEntries(userProfileFile(userId));

  const parts: string[] = [MEMORY_GUIDANCE];

  if (memEntries.length > 0) {
    parts.push('### Current MEMORY entries');
    parts.push(memEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }
  if (userEntries.length > 0) {
    parts.push('### Current USER entries');
    parts.push(userEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }

  if (memEntries.length === 0 && userEntries.length === 0) {
    parts.push('_(no memory entries yet)_');
  }

  return parts.join('\n\n');
}

/**
 * Extract key facts from a compaction summary and save to MEMORY.md.
 *
 * Called asynchronously after context compaction — should not block the
 * main conversation stream. Uses an LLM call to extract facts.
 */
export async function extractAndSaveCompactFacts(
  userId: string,
  summary: string,
): Promise<void> {
  if (!summary.trim()) return;

  // Lazy-import to avoid circular deps (features -> model -> features)
  const { chatWithModel } = await import('../model/client');
  const { prompts } = await import('../prompts/loader');

  const extractPrompt = prompts.load('memory_extract', { summary });
  if (!extractPrompt) {
    log.warn('memory_extract prompt template not found; skipping fact extraction');
    return;
  }

  // Use a throwaway session for the extraction call
  const result = await chatWithModel({
    userId,
    message: extractPrompt,
    sessionId: `memory-extract-${Date.now()}`,
    systemPrompt: 'You are a fact extraction assistant. Follow the instructions strictly and do not add any extra content.',
  });

  if (!result.ok || !result.text.trim()) {
    log.warn(`compact fact extraction failed: ${result.error || 'empty response'}`);
    return;
  }

  // Parse output: one fact per line, lines starting with "- "
  const lines = result.text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean);

  let added = 0;
  for (const fact of lines) {
    const res = addEntry(userId, 'memory', fact);
    if (res.ok) added++;
    else break; // likely at char limit
  }

  if (added > 0) {
    log.info(`extracted ${added} facts from compaction summary for user ${userId}`);
  }
}
