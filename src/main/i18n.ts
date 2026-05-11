/**
 * i18n — minimal lookup for main-side user-facing strings.
 *
 * Two locales only: `zh` (简体中文) / `en` (English). Tables live in
 * `src/main/locales/{zh,en}.json` as flat key → string maps (dot-separated
 * keys like `errors.not_utf8`).
 *
 * Lookup order: current lang → `en` → raw key (so missing keys stand out in
 * UI instead of going silently blank).
 *
 * Used by features/* to produce localized `error` fields returned to the
 * renderer. LLM prompts and logs remain in their source language and are
 * NOT routed through here.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import { SRC_ROOT } from './paths';

export type Lang = 'zh' | 'en';
export const SUPPORTED_LANGS: readonly Lang[] = ['zh', 'en'] as const;

export function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en';
}

/**
 * Map an Electron `app.getLocale()` / BCP-47 tag to our two-locale space.
 * Anything starting with `zh` → `zh`; everything else → `en`.
 */
export function detectSystemLang(rawLocale: unknown): Lang {
  const s = typeof rawLocale === 'string' ? rawLocale.trim().toLowerCase() : '';
  return s.startsWith('zh') ? 'zh' : 'en';
}

// ── Table loading ────────────────────────────────────────────────────────
// Locale JSON lives next to this file in `locales/`. In packaged builds
// (asar), `__dirname` still resolves inside the archive and fs can read it
// because locale tables are tiny JSON (no asar-unpack needed).

type Table = Record<string, string>;
const _tables: Partial<Record<Lang, Table>> = {};

function localeFile(lang: Lang): string {
  return path.join(__dirname, 'locales', `${lang}.json`);
}

function loadTable(lang: Lang): Table {
  const cached = _tables[lang];
  if (cached) return cached;
  let table: Table = {};
  try {
    const raw = fs.readFileSync(localeFile(lang), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') table = parsed as Table;
  } catch { /* missing or malformed → empty table, lookup falls through */ }
  _tables[lang] = table;
  return table;
}

/** Clear cached tables; test-only — app code never needs this. */
export function _resetCacheForTests(): void {
  _tables.zh = undefined;
  _tables.en = undefined;
  _rendererTables.zh = undefined;
  _rendererTables.en = undefined;
}

// ── Renderer-side tables (shipped under src/renderer/locales/) ───────────
// Main reads these too so the IPC handler can hand them to the renderer on
// boot. Separate namespace from the main tables above because UI strings
// (buttons, placeholders) have no reason to overlap with feature error
// strings.

const _rendererTables: Partial<Record<Lang, Table>> = {};

function rendererLocaleFile(lang: Lang): string {
  return path.join(SRC_ROOT, 'renderer', 'locales', `${lang}.json`);
}

function loadRendererTable(lang: Lang): Table {
  const cached = _rendererTables[lang];
  if (cached) return cached;
  let table: Table = {};
  try {
    const raw = fs.readFileSync(rendererLocaleFile(lang), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') table = parsed as Table;
  } catch { /* missing → empty; renderer falls through to raw key */ }
  _rendererTables[lang] = table;
  return table;
}

/** Returns both renderer tables for the renderer-side i18n module. */
export function getRendererTables(): { zh: Table; en: Table } {
  return {
    zh: loadRendererTable('zh'),
    en: loadRendererTable('en'),
  };
}

// ── Current lang ─────────────────────────────────────────────────────────
let _current: Lang = 'en';

export function setCurrentLang(lang: Lang): void {
  _current = lang;
}

export function getCurrentLang(): Lang {
  return _current;
}

// ── LLM language directive ───────────────────────────────────────────────
// Appended at the tail of every conversational system prompt so the model
// replies in the user's chosen UI language. Lives at the very end (after
// runtime injection) — this is the most volatile part of the prompt, so
// keeping it last avoids invalidating the KV-cache prefix.

const LANG_NAMES: Record<Lang, string> = {
  zh: 'Chinese (简体中文)',
  en: 'English',
};

export function buildLanguageDirective(lang: Lang = _current): string {
  const name = LANG_NAMES[lang] ?? LANG_NAMES.en;
  return [
    '## User language',
    '',
    `The user's UI language is set to **${name}**. Every piece of human-readable prose you produce — final replies, form lead-ins, announcements, status notes, AND **the natural-language content inside any structured tag or JSON field** (e.g. \`<workflow>\` step titles and step body descriptions, \`<inputs>\` / \`<agent-input-form>\` field \`label\` values, \`plan_set\` step \`title\` and \`input\` strings, \`<agent>\` container prose) — MUST be in ${name}.`,
    '',
    `What stays in its native form regardless of language: XML tag names themselves (\`<agent>\` / \`<workflow>\` / \`<inputs>\` etc.; do not translate the tag), tool names and skill_ids written in backticks (\`read_file\` / \`kb_search\` / \`web_fetch\` / etc.), JSON object keys (\`"id"\` / \`"type"\` / \`"options"\` / \`"value"\`), file paths, code snippets, and \`value\` strings inside \`select\` / \`multiselect\` options (the value is an internal id; the matching \`label\` is what gets translated).`,
    '',
    `Bilingual description fields are pinned by suffix and ignore the UI language: \`<description_zh>\` / \`description_zh\` always carries Chinese; \`<description_en>\` / \`description_en\` always carries English. Examples in this system prompt may be written in English to illustrate shape — when you produce the actual content, write it in ${name}, not by copying the example's language.`,
  ].join('\n');
}

// ── Lookup ───────────────────────────────────────────────────────────────

/**
 * Resolve a key to its localized string.
 *
 * Order: current lang → `en` → raw key. Optional `vars` replaces `{name}`
 * placeholders (curly-brace style). Passing `lang` overrides the current
 * locale for this single call (rare — reserved for callers that know the
 * target locale, e.g. per-user UIs if we ever support that).
 */
export function t(key: string, vars?: Record<string, string | number>, lang?: Lang): string {
  const primary = lang && isLang(lang) ? lang : _current;
  const fromPrimary = loadTable(primary)[key];
  const raw = fromPrimary != null
    ? fromPrimary
    : (primary === 'en' ? key : (loadTable('en')[key] ?? key));
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v == null ? m : String(v);
  });
}
