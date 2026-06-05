/**
 * i18n — minimal lookup for main-side user-facing strings.
 *
 * Tables live in `src/main/locales/*.json` as flat key → string maps
 * (dot-separated keys like `errors.not_utf8`).
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

export type Lang = 'zh' | 'en' | 'ja';

export interface LocaleMeta {
  code: Lang;
  label: string;
  htmlLang: string;
  intlLocale: string;
  llmName: string;
  fallback: Lang | null;
}

export const LOCALES: readonly LocaleMeta[] = [
  {
    code: 'zh',
    label: '简体中文',
    htmlLang: 'zh-CN',
    intlLocale: 'zh-CN',
    llmName: 'Chinese (简体中文)',
    fallback: 'en',
  },
  {
    code: 'en',
    label: 'English',
    htmlLang: 'en',
    intlLocale: 'en-US',
    llmName: 'English',
    fallback: null,
  },
  {
    code: 'ja',
    label: '日本語',
    htmlLang: 'ja',
    intlLocale: 'ja-JP',
    llmName: 'Japanese (日本語)',
    fallback: 'en',
  },
] as const;

export const SUPPORTED_LANGS: readonly Lang[] = LOCALES.map((l) => l.code);
const LOCALE_BY_CODE: Readonly<Record<Lang, LocaleMeta>> = LOCALES.reduce((acc, meta) => {
  acc[meta.code] = meta;
  return acc;
}, {} as Record<Lang, LocaleMeta>);

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && SUPPORTED_LANGS.includes(v as Lang);
}

export function normalizeLang(rawLocale: unknown): Lang | null {
  const s = typeof rawLocale === 'string' ? rawLocale.trim().toLowerCase() : '';
  if (!s) return null;
  for (const lang of SUPPORTED_LANGS) {
    if (s === lang || s.startsWith(`${lang}-`) || s.startsWith(`${lang}_`)) return lang;
  }
  return null;
}

export function getLocaleMeta(lang: Lang): LocaleMeta {
  return LOCALE_BY_CODE[lang] ?? LOCALE_BY_CODE.en;
}

export function acceptLanguageHeader(lang: Lang): string {
  const parts: string[] = [];
  for (const [idx, candidate] of fallbackChain(lang).entries()) {
    const meta = getLocaleMeta(candidate);
    const q = idx === 0 ? '' : `;q=${Math.max(0.1, 0.9 - idx * 0.1).toFixed(1)}`;
    parts.push(`${meta.intlLocale}${q}`);
    if (candidate !== meta.intlLocale.split('-')[0]) parts.push(`${candidate}${q}`);
  }
  return parts.join(',');
}

export function fallbackChain(lang: Lang): Lang[] {
  const out: Lang[] = [];
  const seen = new Set<Lang>();
  let cur: Lang | null = lang;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = getLocaleMeta(cur).fallback;
  }
  return out;
}

export function descriptionLang(lang: Lang): 'zh' | 'en' {
  return lang === 'zh' ? 'zh' : 'en';
}

/**
 * Map an Electron `app.getLocale()` / BCP-47 tag to the supported UI language
 * space. Unknown input falls back to English.
 */
export function detectSystemLang(rawLocale: unknown): Lang {
  return normalizeLang(rawLocale) ?? 'en';
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
  for (const lang of SUPPORTED_LANGS) {
    _tables[lang] = undefined;
    _rendererTables[lang] = undefined;
  }
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

/** Returns all renderer tables for the renderer-side i18n module. */
export function getRendererTables(): Record<Lang, Table> {
  const out = {} as Record<Lang, Table>;
  for (const lang of SUPPORTED_LANGS) out[lang] = loadRendererTable(lang);
  return out;
}

// ── Current lang ─────────────────────────────────────────────────────────
let _current: Lang = 'en';

export function setCurrentLang(lang: Lang): void {
  _current = lang;
  try { process.env.ORKAS_ACCEPT_LANGUAGE = acceptLanguageHeader(lang); } catch { /* non-node test harness */ }
}

export function getCurrentLang(): Lang {
  return _current;
}

// ── LLM language directive ───────────────────────────────────────────────
// Appended near the tail of every conversational system prompt so the model
// replies in the user's chosen UI language. Callers may append per-turn
// context after this block when it changes more often than language.

export function buildLanguageDirective(lang: Lang = _current): string {
  const name = getLocaleMeta(lang).llmName;
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
  let raw: string | undefined;
  for (const candidate of fallbackChain(primary)) {
    raw = loadTable(candidate)[key];
    if (raw != null) break;
  }
  raw = raw ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v == null ? m : String(v);
  });
}
