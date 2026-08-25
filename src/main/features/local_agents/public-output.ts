/**
 * Public-output boundary for local CLI agents.
 *
 * External runtimes remain free to emit their native output. Hermes
 * installations in the wild can emit a KSTAR work record alongside the public
 * result. Parse that known wire shape only at the Orkas presentation boundary,
 * leaving the CLI prompt and raw runtime behavior unchanged.
 */

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

export function sanitizeLocalAgentPublicOutput(args: {
  cli: LocalCliType;
  text: string;
  userTask?: string;
}): string {
  const text = String(args.text || '');
  if (args.cli !== 'hermes' || !text.trim()) return text;
  if (hasExplicitKstarRequest(String(args.userTask || ''))) return text;
  const extracted = extractHermesKstarResult(text);
  return extracted.matched ? extracted.result : text;
}
