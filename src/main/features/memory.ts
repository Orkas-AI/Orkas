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
  '## 跨会话记忆',
  '',
  '你拥有跨会话持久记忆能力，通过 `cross_session_memory` 工具实现。记忆在不同对话之间保持。',
  '',
  '⚠️ 核心原则：当用户分享任何个人信息时，你必须立即调用 cross_session_memory tool 保存，而不是仅口头回应。不调用 tool 等于遗忘。',
  '',
  '**必须调用 tool 的场景（不调用 = 遗忘，严禁只口头回应）：**',
  '- 用户明确说"记住/记一下/remember/别忘了"',
  '- 用户纠正你的行为（"不要这样做"、"以后请..."）',
  '- 用户分享个人喜好、兴趣、习惯 -> target="user"',
  '  例："我喜欢打篮球"、"我爱喝咖啡"、"我的爱好是游泳"、"我习惯早起"、"我不喜欢加班"',
  '- 用户透露角色、职业、身份 -> target="user"',
  '  例："我是产品经理"、"我在创业"、"我是学生"',
  '- 用户提到技术偏好或工具选择 -> target="user"',
  '  例："我习惯用 VS Code"、"我更喜欢 TypeScript"、"我们用 React"',
  '- 用户描述自己的性格、沟通风格 -> target="user"',
  '  例："我比较直接"、"我喜欢简洁的回答"',
  '',
  '**判断规则：只要用户的话包含"我喜欢/我爱/我习惯/我偏好/我不喜欢/我讨厌/我是/我在做/我的爱好/我平时"等表达个人信息的句式，就必须调用 tool 保存到 target="user"。宁可多存也不要漏存。**',
  '',
  '**应该主动调用 tool 的场景（target="memory"）：**',
  '- 重要决策或里程碑（"我们决定用 X"、"项目已上线"）',
  '- 项目约定或环境信息（"部署在 AWS"、"用 PostgreSQL"）',
  '',
  '**不要保存：**',
  '- 一次性调试细节',
  '- 大段代码或日志原文',
  '',
  '两个 target：',
  '- `memory`：你的笔记（事实、决策、里程碑、项目约定）',
  '- `user`：用户画像（角色、偏好、兴趣爱好、沟通风格、技术栈）',
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
    parts.push('### 当前 MEMORY 条目');
    parts.push(memEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }
  if (userEntries.length > 0) {
    parts.push('### 当前 USER 条目');
    parts.push(userEntries.map(e => e.text).join(ENTRY_SEPARATOR));
  }

  if (memEntries.length === 0 && userEntries.length === 0) {
    parts.push('_(暂无记忆条目)_');
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
    sessionId: `${userId}-memory-extract-${Date.now()}`,
    systemPrompt: '你是一个事实提取助手。严格按照指示输出，不要添加任何额外内容。',
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
