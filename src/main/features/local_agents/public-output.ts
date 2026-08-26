/**
 * Public-output boundary for local CLI agents.
 *
 * External runtimes remain free to emit their native output. Normalize known
 * native wire shapes only at the Orkas presentation boundary, leaving the CLI
 * prompt and raw runtime behavior unchanged:
 *
 * - Hermes installations in the wild can emit a KSTAR work record alongside
 *   the public result.
 * - Codex emits `:codex-file-citation{...}` directives for files it considers
 *   final outputs. Those directives are transport metadata, not user-facing
 *   prose; Orkas turns them into an explicit produced-file selection after
 *   verifying the path was already registered by this turn.
 */

import * as path from 'node:path';

import type { LocalCliType } from './registry.js';

type KstarSectionId = 'K' | 'S' | 'T' | 'A' | 'EXPECTED' | 'R' | 'DELTA' | 'AAR';

interface KstarHeading {
  id: KstarSectionId;
  line: number;
  suffix: string;
}

const KSTAR_HEADING_RE = /^(AAR|ΔR|R̂|K|S|T|Â|A|R)(?:\s*[（(][^)）\n]{1,48}[)）])?\s*(?:—|–|-|:|：)\s*(.*)$/u;
const EXPLICIT_KSTAR_REQUEST_RE = /(?:\bK\s*[- ]?STAR\b|KSTAR|按[^\n]{0,24}KSTAR|使用[^\n]{0,24}KSTAR)/iu;
const KSTAR_SECTION_TOKEN_RE = /\b([KSTAR])\b/gu;
const KSTAR_SECTION_REQUEST_INTENT_EN_RE = /\b(?:sections?|headings?|format|structure|organize|organise|using|use)\b/iu;
const KSTAR_SECTION_REQUEST_INTENT_ZH_RE = /(?:分节|分段|分为|分成|按|按照|使用|采用|格式|章节|小节|段落|结构)/u;
const KSTAR_SECTION_SEQUENCE = ['K', 'S', 'T', 'A', 'R'] as const;

function hasExplicitKstarRequest(userTask: string): boolean {
  const task = String(userTask || '').normalize('NFKC');
  if (EXPLICIT_KSTAR_REQUEST_RE.test(task)) return true;

  const tokens = [...task.matchAll(KSTAR_SECTION_TOKEN_RE)];
  for (let start = 0; start <= tokens.length - KSTAR_SECTION_SEQUENCE.length; start += 1) {
    const candidate = tokens.slice(start, start + KSTAR_SECTION_SEQUENCE.length);
    const isSequence = candidate.every((match, index) => match[1] === KSTAR_SECTION_SEQUENCE[index]);
    if (!isSequence) continue;

    const firstIndex = candidate[0].index ?? 0;
    const last = candidate[candidate.length - 1];
    const lastIndex = (last.index ?? firstIndex) + last[0].length;
    if (lastIndex - firstIndex > 160) continue;

    const context = task.slice(Math.max(0, firstIndex - 80), Math.min(task.length, lastIndex + 80));
    if (KSTAR_SECTION_REQUEST_INTENT_EN_RE.test(context)
      || KSTAR_SECTION_REQUEST_INTENT_ZH_RE.test(context)) return true;
  }
  return false;
}

function canonicalSectionId(raw: string): KstarSectionId {
  if (raw === 'AAR') return 'AAR';
  if (raw === 'ΔR') return 'DELTA';
  if (raw === 'R̂') return 'EXPECTED';
  if (raw === 'Â' || raw === 'A') return 'A';
  return raw as KstarSectionId;
}

function unwrapHeadingMarkup(line: string): string {
  let value = String(line || '').trim().replace(/^#{1,6}\s+/, '');
  if (value.startsWith('**') && value.endsWith('**') && value.length > 4) {
    value = value.slice(2, -2).trim();
  }
  return value;
}

function findKstarHeadings(lines: string[]): KstarHeading[] {
  const headings: KstarHeading[] = [];
  let fence = '';
  for (let line = 0; line < lines.length; line += 1) {
    const trimmed = lines[line].trim();
    const fenceMatch = /^(?:```|~~~)/.exec(trimmed);
    if (fenceMatch) {
      fence = fence ? '' : fenceMatch[0];
      continue;
    }
    if (fence) continue;
    const match = KSTAR_HEADING_RE.exec(unwrapHeadingMarkup(lines[line]));
    if (!match) continue;
    headings.push({
      id: canonicalSectionId(match[1]),
      line,
      suffix: match[2].trim(),
    });
  }
  return headings;
}

function inlineResult(suffix: string): string {
  const value = suffix.trim();
  if (!value || /^(?:结果|result)$/iu.test(value)) return '';
  const labelled = /^(?:结果|result)\s*(?:[:：])\s*(.+)$/iu.exec(value);
  return (labelled ? labelled[1] : value).trim();
}

function extractHermesKstarResult(text: string): { matched: boolean; result: string } {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const headings = findKstarHeadings(lines);
  const ids = new Set(headings.map((heading) => heading.id));
  const isPrivateScaffold = headings.length >= 4
    && ids.has('K')
    && ids.has('S')
    && ids.has('T')
    && (ids.has('A') || ids.has('EXPECTED') || ids.has('R') || ids.has('AAR'));
  if (!isPrivateScaffold) return { matched: false, result: '' };

  const resultIndex = headings.findIndex((heading) => heading.id === 'R');
  if (resultIndex < 0) return { matched: true, result: '' };
  const resultHeading = headings[resultIndex];
  const nextLine = headings[resultIndex + 1]?.line ?? lines.length;
  const parts = [
    inlineResult(resultHeading.suffix),
    ...lines.slice(resultHeading.line + 1, nextLine),
  ];
  const result = parts.join('\n').trim();
  return { matched: true, result };
}

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
  userTask?: string;
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
  if (args.cli !== 'hermes' || !text.trim()) return { text, publishedPaths: [] };
  if (hasExplicitKstarRequest(String(args.userTask || ''))) return { text, publishedPaths: [] };
  const extracted = extractHermesKstarResult(text);
  return {
    text: extracted.matched ? extracted.result : text,
    publishedPaths: [],
  };
}

export function sanitizeLocalAgentPublicOutput(args: {
  cli: LocalCliType;
  text: string;
  userTask?: string;
}): string {
  return normalizeLocalAgentPublicOutput(args).text;
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
