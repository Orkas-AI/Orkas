/**
 * Quality validator — public API.
 *
 * Two entry levels:
 *   - File-level: `validateSkillFile({ relpath, content })` — used at the
 *     `<<<skill-file>>>` write chokepoint, called per file as the LLM emits
 *     blocks.
 *   - Dir-level: `validateSkillDir(dir)` / `validateAgentDir(dir)` — used at
 *     marketplace install, where a full spec lands at once and the
 *     frontmatter + scripts all need scanning together.
 *
 * Always-stateless: no FS reads outside the explicit `validateXDir(dir)`
 * helpers; no LLM calls; no UI side effects. Persistence is a separate
 * `report.ts` concern called by the integration points after validation.
 *
 * Outer modules must only import from this file (`PC/src/main/quality`),
 * never from `quality/rules/*` or `quality/types.ts` directly — the rule set
 * is implementation detail and should be re-organizable without breaking
 * callers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Violation, ValidationReport, ScanKind, VALIDATOR_VERSION } from './types';
import {
  scanRedFlags,
  extractExecutableBlocks,
} from './rules/red-flags';
import {
  validateSkillFrontmatter,
  validateSkillMeta,
  validateAgentJsonShape,
  parseFailureViolation,
  skillMetaParseViolation,
} from './rules/schema';

// Re-export the types so callers only need one import path.
export type { Violation, ValidationReport, Level } from './types';
export { VALIDATOR_VERSION } from './types';

// ── File-level skill validation ─────────────────────────────────────────

/**
 * Validate a single skill file as it's about to be written.
 * Use this at the `writeCustomSkillFile` chokepoint.
 */
export function validateSkillFile(args: {
  relpath: string;
  content: string;
}): ValidationReport {
  const violations: Violation[] = [];
  const kind = detectSkillFileKind(args.relpath);

  if (kind === 'skill_md') {
    violations.push(..._scanSkillMd(args.content, args.relpath));
  } else if (kind === 'skill_meta') {
    violations.push(..._scanSkillMeta(args.content));
  } else if (kind === 'script') {
    violations.push(...scanRedFlags({
      content: args.content,
      kind: 'script',
      field: args.relpath,
    }));
  }
  // kind === 'other' (README / assets) → no scan

  return _finalize(violations);
}

// ── Dir-level skill validation ──────────────────────────────────────────

/**
 * Validate an on-disk skill directory. Iterates every file the validator
 * recognizes (SKILL.md + scripts) and aggregates findings.
 *
 * EXTREME if SKILL.md is missing or unparseable.
 */
export function validateSkillDir(skillDir: string): ValidationReport {
  const violations: Violation[] = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillMdPath)) {
    violations.push({
      level: 'EXTREME',
      rule: 'skill_md_missing',
      field: 'SKILL.md',
      snippet: '',
      suggested_fix: 'Every skill directory must contain a SKILL.md file.',
    });
    return _finalize(violations);
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const { meta, metaViolations } = _readSkillMeta(skillDir);
    violations.push(...metaViolations);
    violations.push(..._scanSkillMd(content, 'SKILL.md', meta));
    violations.push(...validateSkillMeta(meta));
  } catch (err) {
    violations.push(parseFailureViolation({
      kind: 'frontmatter',
      message: (err as Error).message,
    }));
    return _finalize(violations);
  }

  // Walk all other recognized files (scripts).
  for (const rel of _walkFiles(skillDir, '')) {
    if (rel.toUpperCase() === 'SKILL.MD') continue;
    if (rel === '_meta.json') continue;
    const kind = detectSkillFileKind(rel);
    if (kind !== 'script') continue;
    try {
      const content = fs.readFileSync(path.join(skillDir, rel), 'utf8');
      violations.push(...scanRedFlags({ content, kind: 'script', field: rel }));
    } catch {
      // unreadable file (binary / permission) — skip; no violation surfaced
    }
  }

  return _finalize(violations);
}

// ── Agent validation ────────────────────────────────────────────────────

/**
 * Validate an already-parsed agent.json object. Use this when the caller
 * already has the JSON in memory (e.g. marketplace install detail.agent_json).
 */
export function validateAgentSpec(args: {
  agentJson: unknown;
}): ValidationReport {
  const violations: Violation[] = [];
  if (!args.agentJson || typeof args.agentJson !== 'object') {
    violations.push(parseFailureViolation({
      kind: 'agent_json',
      message: 'agent.json must be a JSON object',
    }));
    return _finalize(violations);
  }
  const obj = args.agentJson as Record<string, unknown>;
  violations.push(...validateAgentJsonShape(obj));

  // Scan string fields for red flags (path-style strings in workflow /
  // description fields). Cheap pass over the serialized form keeps the rule
  // application uniform — we don't need per-field traversal at this scope.
  try {
    const serialized = JSON.stringify(obj);
    violations.push(...scanRedFlags({
      content: serialized,
      kind: 'agent_json',
      field: 'agent.json',
    }));
  } catch {
    // unserializable (cyclic) → not worth surfacing here, the shape check
    // above would have already failed on the broken structure
  }

  return _finalize(violations);
}

/**
 * Validate an on-disk agent directory (reads `agent.json` from `<dir>/agent.json`).
 */
export function validateAgentDir(agentDir: string): ValidationReport {
  const file = path.join(agentDir, 'agent.json');
  if (!fs.existsSync(file)) {
    return _finalize([{
      level: 'EXTREME',
      rule: 'agent_json_missing',
      field: 'agent.json',
      snippet: '',
      suggested_fix: 'Agent directory must contain an agent.json spec file.',
    }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return _finalize([parseFailureViolation({
      kind: 'agent_json',
      message: (err as Error).message,
    })]);
  }
  return validateAgentSpec({ agentJson: parsed });
}

// ── Internals ───────────────────────────────────────────────────────────

function detectSkillFileKind(relpath: string): ScanKind {
  const norm = relpath.replace(/\\/g, '/');
  if (norm.toUpperCase() === 'SKILL.MD') return 'skill_md';
  if (norm === '_meta.json') return 'skill_meta';
  const ext = path.extname(norm).toLowerCase();
  if (['.py', '.sh', '.bash', '.zsh', '.ts', '.mjs', '.js', '.rb'].includes(ext)) {
    return 'script';
  }
  // Anything else (README.md, .json, .yaml, images, …) is skipped.
  return 'other';
}

function _scanSkillMd(content: string, field: string, skillMeta: Record<string, unknown> = {}): Violation[] {
  const violations: Violation[] = [];

  // Frontmatter: parse with a minimal YAML-subset (same shape as
  // `features/skills.ts::parseSkillFrontmatter`). We intentionally don't
  // import that function — quality/ must not depend on features/.
  const { meta, body, parseError } = _splitSkillMd(content);
  if (parseError) {
    violations.push(parseFailureViolation({
      kind: 'frontmatter',
      message: parseError,
    }));
    return violations;
  }
  violations.push(...validateSkillFrontmatter(meta, skillMeta));

  // Embedded executable code blocks: scan each for red flags.
  for (const block of extractExecutableBlocks(body)) {
    violations.push(...scanRedFlags({
      content: block.content,
      kind: 'script',  // executable block → treat as script
      field: `${field}:${block.startLine} (\`\`\`${block.lang})`,
    }));
  }

  return violations;
}

function _scanSkillMeta(content: string): Violation[] {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [skillMetaParseViolation('_meta.json must be a JSON object')];
    }
    return validateSkillMeta(parsed as Record<string, unknown>);
  } catch (err) {
    return [skillMetaParseViolation((err as Error).message)];
  }
}

function _readSkillMeta(skillDir: string): { meta: Record<string, unknown>; metaViolations: Violation[] } {
  const file = path.join(skillDir, '_meta.json');
  if (!fs.existsSync(file)) return { meta: {}, metaViolations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        meta: {},
        metaViolations: [skillMetaParseViolation('_meta.json must be a JSON object')],
      };
    }
    return { meta: parsed as Record<string, unknown>, metaViolations: [] };
  } catch (err) {
    return {
      meta: {},
      metaViolations: [skillMetaParseViolation((err as Error).message)],
    };
  }
}

interface SplitResult { meta: Record<string, string>; body: string; parseError?: string }

function _splitSkillMd(text: string): SplitResult {
  if (!text.startsWith('---')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('---', 3);
  if (end === -1) {
    return { meta: {}, body: text, parseError: 'unterminated frontmatter (missing closing ---)' };
  }
  const fm = text.slice(3, end);
  const body = text.slice(end + 3);
  const meta: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    if (!line || !line.trim() || line.startsWith('#')) continue;
    if (/^\s/.test(line) || line.trim().startsWith('-')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key || !raw) continue;
    meta[key] = _unquote(raw);
  }
  return { meta, body };
}

function _unquote(raw: string): string {
  if (raw[0] === '"' && raw[raw.length - 1] === '"' && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\(.)/g, (_, ch) => {
      if (ch === 'n') return '\n';
      if (ch === 't') return '\t';
      if (ch === 'r') return '\r';
      return ch;
    });
  }
  if (raw[0] === "'" && raw[raw.length - 1] === "'" && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function* _walkFiles(root: string, rel: string): Generator<string> {
  const dir = rel ? path.join(root, rel) : root;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (e.name === '_install.json' || e.name === '_cache.json') continue;
    const subRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* _walkFiles(root, subRel);
    } else if (e.isFile()) {
      yield subRel;
    }
  }
}

function _finalize(violations: Violation[]): ValidationReport {
  const hasExtreme = violations.some((v) => v.level === 'EXTREME');
  return {
    ok: !hasExtreme,
    violations,
    validated_at: new Date().toISOString(),
    validator_version: VALIDATOR_VERSION,
  };
}
