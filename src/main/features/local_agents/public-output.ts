/**
 * Public-output boundary for local CLI agents.
 *
 * External runtimes remain free to emit their native output. Normalize known
 * native wire shapes only at the Orkas presentation boundary, leaving the CLI
 * prompt and raw runtime behavior unchanged:
 *
 * Native answer text remains opaque; user wording and Markdown headings do
 * not select, suppress, or rewrite its sections.
 *
 * - Codex emits `:codex-file-citation{...}` directives for files it considers
 *   final outputs. Those directives are transport metadata, not user-facing
 *   prose; Orkas turns them into an explicit produced-file selection after
 *   verifying the path was already registered by this turn.
 */

import * as path from 'node:path';

import type { LocalCliType } from './registry.js';

interface CodexFileCitation {
  path: string;
  purpose: string;
}

interface ParsedCodexFileCitationLine {
  citation: CodexFileCitation;
  /** Text to keep when the directive is consumed. Empty for a standalone directive. */
  replacement: string;
}

const CODEX_FILE_CITATION_PREFIX = ':codex-file-citation{';
const CODEX_FILE_CITATION_LINE_RE = /^\s*:codex-file-citation\{([\s\S]*)\}\s*$/u;
const CODEX_FILE_CITATION_ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*"((?:\\.|[^"\\])*)"/gy;

function decodeCodexAttribute(value: string): string {
  // Codex currently escapes only quote and backslash in directive attributes.
  // Preserve unknown escape sequences so a Windows path such as `C:\tmp`
  // does not silently lose characters if an older runtime emits it verbatim.
  return value.replace(/\\(["\\])/g, '$1');
}

function parseCodexFileCitationLine(line: string): CodexFileCitation | null {
  const match = CODEX_FILE_CITATION_LINE_RE.exec(line);
  if (!match) return null;
  const body = match[1];
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    while (/\s/u.test(body[offset] || '')) offset += 1;
    if (offset >= body.length) break;
    CODEX_FILE_CITATION_ATTR_RE.lastIndex = offset;
    const attribute = CODEX_FILE_CITATION_ATTR_RE.exec(body);
    if (!attribute || attribute.index !== offset) return null;
    attributes.set(attribute[1], decodeCodexAttribute(attribute[2]));
    offset = CODEX_FILE_CITATION_ATTR_RE.lastIndex;
  }
  const citationPath = String(attributes.get('path') || '').trim();
  const purpose = String(attributes.get('purpose') || '').trim();
  return citationPath && purpose ? { path: citationPath, purpose } : null;
}

function codexCitationPathIdentity(rawPath: string): string {
  let value = String(rawPath || '').trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  try { value = decodeURI(value); } catch { /* preserve malformed legacy text */ }
  return value.replace(/\\/g, '/');
}

/**
 * Besides the current standalone wire shape, some older Codex builds emitted
 * the directive immediately after a Markdown link to the same file. Keep that
 * link as prose, but consume the adjacent transport suffix. Requiring an exact
 * path match keeps ordinary inline examples untouched.
 */
function parseCodexFileCitationPresentationLine(line: string): ParsedCodexFileCitationLine | null {
  const standalone = parseCodexFileCitationLine(line);
  if (standalone) return { citation: standalone, replacement: '' };

  const markerIndex = line.lastIndexOf(CODEX_FILE_CITATION_PREFIX);
  if (markerIndex <= 0) return null;
  const citation = parseCodexFileCitationLine(line.slice(markerIndex));
  if (!citation) return null;
  const leading = line.slice(0, markerIndex);
  const link = /\[[^\]\n]+\]\(([^)\n]+)\)\s*$/u.exec(leading);
  if (!link) return null;
  if (codexCitationPathIdentity(link[1]) !== codexCitationPathIdentity(citation.path)) return null;
  return { citation, replacement: leading.trimEnd() };
}

function markdownFenceToken(line: string): string {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match?.[1] || '';
}

function isClosingMarkdownFence(token: string, openFence: string): boolean {
  return !!token
    && token[0] === openFence[0]
    && token.length >= openFence.length;
}

function resolveCitationPath(rawPath: string, workingDir?: string): string | null {
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  if (!workingDir) return null;
  return path.resolve(workingDir, rawPath);
}

function normalizeCodexFileCitations(args: {
  text: string;
  producedPaths?: readonly string[];
  workingDir?: string;
  removeUnmatched: boolean;
}): { text: string; publishedPaths: string[] } {
  const text = String(args.text || '');
  if (!text.includes(CODEX_FILE_CITATION_PREFIX)) {
    return { text, publishedPaths: [] };
  }

  const produced = new Map<string, string>();
  for (const rawPath of args.producedPaths || []) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
    const resolved = path.resolve(rawPath);
    produced.set(resolved, resolved);
  }

  const published = new Set<string>();
  const kept: string[] = [];
  let openFence = '';
  let removed = false;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const fence = markdownFenceToken(line);
    if (fence) {
      if (!openFence) openFence = fence;
      else if (isClosingMarkdownFence(fence, openFence)) openFence = '';
      kept.push(line);
      continue;
    }
    if (openFence) {
      kept.push(line);
      continue;
    }

    const parsed = parseCodexFileCitationPresentationLine(line);
    if (!parsed) {
      kept.push(line);
      continue;
    }
    const citation = parsed.citation;
    const resolved = resolveCitationPath(citation.path, args.workingDir);
    const registered = resolved ? produced.get(path.resolve(resolved)) : undefined;
    if (citation.purpose === 'output' && registered) published.add(registered);
    if (registered || args.removeUnmatched) {
      removed = true;
      if (parsed.replacement) kept.push(parsed.replacement);
      continue;
    }
    kept.push(line);
  }

  const normalizedText = removed
    ? kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    : text;
  return { text: normalizedText, publishedPaths: Array.from(published) };
}

export interface LocalAgentPublicOutput {
  text: string;
  /** Exact current-turn produced files selected by native output metadata. */
  publishedPaths: string[];
}

export function normalizeLocalAgentPublicOutput(args: {
  cli: LocalCliType;
  text: string;
  workingDir?: string;
  producedPaths?: readonly string[];
}): LocalAgentPublicOutput {
  const text = String(args.text || '');
  if (args.cli === 'codex') {
    return normalizeCodexFileCitations({
      text,
      workingDir: args.workingDir,
      producedPaths: args.producedPaths,
      removeUnmatched: true,
    });
  }
  return { text, publishedPaths: [] };
}

/**
 * Read-only compatibility projection for messages persisted by builds that
 * displayed Codex's native directive. Only citations already backed by that
 * message's structured `produced` list are removed; unmatched prose remains
 * intact and the canonical JSONL is never rewritten.
 */
export function sanitizePersistedCodexFileCitations(
  text: string,
  producedPaths?: readonly string[],
  workingDir?: string,
): string {
  return normalizeCodexFileCitations({
    text,
    producedPaths,
    workingDir,
    removeUnmatched: false,
  }).text;
}

/**
 * Extract only recognized `purpose="output"` paths from persisted Codex
 * transport metadata. The caller remains responsible for checking existence
 * and conversation-scoped path authorization before treating them as files.
 */
export function persistedCodexOutputCitationPaths(
  text: string,
  workingDir?: string,
): string[] {
  const source = String(text || '');
  if (!source.includes(CODEX_FILE_CITATION_PREFIX)) return [];

  const found = new Set<string>();
  let openFence = '';
  for (const line of source.replace(/\r/g, '').split('\n')) {
    const fence = markdownFenceToken(line);
    if (fence) {
      if (!openFence) openFence = fence;
      else if (isClosingMarkdownFence(fence, openFence)) openFence = '';
      continue;
    }
    if (openFence) continue;
    const parsed = parseCodexFileCitationPresentationLine(line);
    if (!parsed || parsed.citation.purpose !== 'output') continue;
    const resolved = resolveCitationPath(parsed.citation.path, workingDir);
    if (resolved) found.add(path.resolve(resolved));
  }
  return Array.from(found);
}

/**
 * Streaming filter used by the Codex adapter boundary. It buffers at most one
 * incomplete line, so a directive split across arbitrary protocol deltas is
 * never briefly painted as chat prose. Fenced examples remain visible.
 */
export class CodexFileCitationStreamFilter {
  private buffer = '';

  private openFence = '';

  push(chunk: string): string {
    this.buffer += String(chunk || '').replace(/\r/g, '');
    let output = '';
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      output += this.filterCompleteLine(line, '\n');
      newline = this.buffer.indexOf('\n');
    }
    return output;
  }

  flush(): string {
    const line = this.buffer;
    this.buffer = '';
    return this.filterCompleteLine(line, '');
  }

  private filterCompleteLine(line: string, ending: string): string {
    const fence = markdownFenceToken(line);
    if (fence) {
      if (!this.openFence) this.openFence = fence;
      else if (isClosingMarkdownFence(fence, this.openFence)) this.openFence = '';
      return `${line}${ending}`;
    }
    if (!this.openFence) {
      const parsed = parseCodexFileCitationPresentationLine(line);
      if (parsed) return `${parsed.replacement}${parsed.replacement ? ending : ''}`;
    }
    return `${line}${ending}`;
  }
}
