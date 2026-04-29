/**
 * Prompt template loader.
 *
 * Templates live as `app/main/prompts/<name>.md`, using `$variable` placeholders
 * (ports Python `string.Template` — so a body can contain literal `{}` without
 * escaping, and a forgotten arg stays literal instead of crashing).
 *
 * Substitution rules (mirrors Python `string.Template.safe_substitute`):
 *   - `$identifier`   → substituted from args
 *   - `${identifier}` → substituted from args
 *   - `$$`            → literal `$`
 *   - unknown id      → left literal (e.g. `$foo` stays `$foo`)
 *   - identifier      → `[A-Za-z_][A-Za-z0-9_]*`
 *
 * Loaded templates are cached per-name keyed by file mtime, so editing a .md
 * on disk is picked up without a restart.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('prompts');

const DEFAULT_TEMPLATES_DIR = __dirname;

const TEMPLATE_RE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export type TemplateArgs = Record<string, string | number | boolean>;

export function safeSubstitute(body: string, args: TemplateArgs): string {
  return body.replace(TEMPLATE_RE, (match, _g1, braced: string | undefined, named: string | undefined) => {
    if (match === '$$') return '$';
    const key = braced || named;
    if (key && Object.prototype.hasOwnProperty.call(args, key)) {
      return String(args[key]);
    }
    return match; // unknown → literal
  });
}

interface CacheEntry { mtime: number; body: string }

export class PromptManager {
  readonly root: string;
  private _cache: Map<string, CacheEntry>;

  constructor(root?: string) {
    this.root = root || DEFAULT_TEMPLATES_DIR;
    this._cache = new Map();
  }

  private _pathFor(template: string): string {
    return path.join(this.root, `${template}.md`);
  }

  private _body(template: string): string {
    const p = this._pathFor(template);
    let stat: fs.Stats;
    try { stat = fs.statSync(p); }
    catch { log.warn(`template missing: ${p}`); return ''; }
    const mtime = stat.mtimeMs;
    const cached = this._cache.get(template);
    if (cached && cached.mtime === mtime) return cached.body;
    let body: string;
    try { body = fs.readFileSync(p, 'utf8'); }
    catch (err) { log.warn(`failed to read ${p}: ${(err as Error).message}`); return ''; }
    this._cache.set(template, { mtime, body });
    return body;
  }

  exists(template: string): boolean {
    return fs.existsSync(this._pathFor(template));
  }

  /** Render `<template>.md` with the given substitutions. */
  load(template: string, args: TemplateArgs = {}): string {
    return safeSubstitute(this._body(template), args || {});
  }

  /** Drop all cached templates; next load() re-reads from disk. */
  reload(): void {
    this._cache.clear();
  }
}

export const prompts = new PromptManager();
