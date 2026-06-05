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
export const MEMORY_CHAR_LIMIT = 2500;   // facts: keep room for several durable notes
export const USER_CHAR_LIMIT   = 1500;   // profile/preferences: should stay concise
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

// ── Import parsing (read-only classifier for the UI import flow) ───────────
//
// Splits pasted/imported text into candidate entries, runs the SAME
// `scanForInjection` the write path uses, and heuristically guesses each
// entry's target + a cosmetic display "kind". This is advisory only — the
// user confirms every target in the review step and the actual merge goes
// through `addEntry` (which re-scans, dedups, and truncates). Adds no new
// limit / separator / scanner behaviour.

export interface ParsedImportEntry {
  text: string;
  target: 'memory' | 'user';
  kind: string;
  threat: string | null;
}

// First-person self-disclosure → user profile (en + zh). Advisory only — the
// user confirms every target in the import-review step before merge.
const USER_HINTS: Array<{ re: RegExp; kind: string }> = [
  { re: /\b(i am|i'm|my name is|i work as)\b/i, kind: 'identity' },
  { re: /(我是|我叫|我的名字|我在.*(工作|做))/, kind: 'identity' },
  { re: /\b(i (like|love|enjoy|prefer|usually|tend to|dislike|hate))\b/i, kind: 'preference' },
  { re: /(喜欢|偏好|讨厌|不喜欢|习惯|倾向)/, kind: 'preference' },
  { re: /\b(i('m| am)? (direct|concise|brief)|communication style)\b/i, kind: 'comm-style' },
  { re: /(沟通风格|说话风格|先给结论|不要寒暄)/, kind: 'comm-style' },
  { re: /\b(i use|we use|my stack|i code in|typescript|python|react|vs ?code)\b/i, kind: 'tech-stack' },
  { re: /(技术栈|主力设备|常用.*(目录|工具|语言)|我用)/, kind: 'tech-stack' },
];

// Decisions / milestones / conventions → facts (target="memory").
const MEMORY_HINTS: Array<{ re: RegExp; kind: string }> = [
  { re: /\b(we |i )?(decided|chose|agreed)\b/i, kind: 'decision' },
  { re: /(决定|选定|定下|敲定)/, kind: 'decision' },
  { re: /\b(shipped|launched|released|milestone|deadline)\b/i, kind: 'milestone' },
  { re: /(上线|发布|里程碑|周报|截止)/, kind: 'milestone' },
  { re: /\b(deployed on|uses (aws|postgres|mysql)|convention|the project)\b/i, kind: 'convention' },
  { re: /(约定|规范|项目.*(用|约定)|部署在|环境)/, kind: 'convention' },
];

function classifyImportEntry(text: string): { target: 'memory' | 'user'; kind: string } {
  for (const { re, kind } of MEMORY_HINTS) {
    if (re.test(text)) return { target: 'memory', kind };
  }
  for (const { re, kind } of USER_HINTS) {
    if (re.test(text)) return { target: 'user', kind };
  }
  // Default to user profile when nothing matches: a misfiled preference is
  // cheaper to fix than a task-state note landing in long-term facts, and the
  // user re-checks every target in the review step anyway.
  return { target: 'user', kind: 'preference' };
}

/**
 * Parse free-form imported text into candidate memory entries. Splits on blank
 * lines first (paragraph blocks), then on single line breaks, then trims +
 * drops empties + dedups. Each candidate is scanned for injection and given an
 * advisory target/kind. Bullet / list markers are stripped from the head.
 */
export function parseImportText(text: string): ParsedImportEntry[] {
  if (!text || !text.trim()) return [];
  const seen = new Set<string>();
  const out: ParsedImportEntry[] = [];
  // Blank-line-separated blocks, then per-line within a block — covers both
  // prose paragraphs and one-fact-per-line note dumps.
  const blocks = text.split(/\n\s*\n+/);
  const candidates: string[] = [];
  for (const block of blocks) {
    for (const line of block.split(/\n/)) {
      candidates.push(line);
    }
  }
  for (const raw of candidates) {
    // Strip leading list markers ("- ", "* ", "1. ", "• ") and surrounding ws.
    const trimmed = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const { target, kind } = classifyImportEntry(trimmed);
    out.push({ text: trimmed, target, kind, threat: scanForInjection(trimmed) });
  }
  return out;
}

// ── System prompt block (read side) ──────────────────────────────────────

/**
 * Render the user's existing memory as a system-prompt block so the model has
 * it as background context every turn. READ side only — it does NOT teach the
 * model when to write; the `cross_session_memory` tool's own description owns
 * the save/skip rules (single source, kept tight). Returns '' when there is
 * nothing stored, so new users pay zero prompt tokens and we never inject a
 * "(no entries)" placeholder.
 *
 * Injected by `runner.ts::buildRunner` for any session with a uid. The system
 * prompt is rebuilt every turn, so this re-reads from disk each turn — a model
 * write mid-conversation is visible on the next turn (cache re-prefills only on
 * the rare write turns; writes are infrequent by design).
 */
export function formatForSystemPrompt(userId: string): string {
  const userEntries = loadEntries(userProfileFile(userId));
  const memEntries = loadEntries(userMemoryFile(userId));
  if (userEntries.length === 0 && memEntries.length === 0) return '';

  const parts: string[] = [
    '## What you already know about this user',
    'Persistent across sessions — treat as background context. Keep it current with the `cross_session_memory` tool when the user corrects or adds something.',
  ];
  if (userEntries.length > 0) {
    parts.push('### User profile (role, preferences, communication style, tech stack)');
    parts.push(userEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }
  if (memEntries.length > 0) {
    parts.push('### Notes (durable facts, decisions, conventions)');
    parts.push(memEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }
  return parts.join('\n\n');
}
