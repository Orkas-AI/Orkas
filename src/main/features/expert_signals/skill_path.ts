/**
 * Pure helpers to classify a SKILL.md path back to its source system.
 *
 * Used at the `read_file` chokepoint to emit `skill_invoked` signals — when
 * the LLM reads a SKILL.md body (Claude Code progressive disclosure), we
 * want to know whether it came from System A.custom / A.platform / B.
 *
 * Why this lives in `features/expert_signals/` (not in a shared util):
 * the parsing is a one-trick pony for signal attribution; no other caller
 * needs it. Keeping it next to its consumer avoids over-abstracting.
 *
 * **No FS access**: pure path-string comparison against the three root
 * helpers from `paths.ts`. Reading the SKILL.md body would violate
 * PC/CLAUDE.md §3 (model layer doesn't read business data) and is
 * unnecessary — the system label is derivable from the absolute path
 * alone.
 *
 * See `Common/docs/plans/expert-signals-skill-attribution.md` §3.3.
 */

import * as path from 'node:path';

import {
  userSkillsDir,
  userMarketplaceSkillsDir,
  userAgentsDir,
} from '../../paths';

export type SkillSystem = 'A.custom' | 'A.platform' | 'B';

export interface ParsedSkillPath {
  system: SkillSystem;
  /** Directory name of the skill (last segment before `SKILL.md`). */
  skill_id: string;
  /** Owning agent id — only set for System B (`<uid>/cloud/agents/<aid>/skills/<sid>/SKILL.md`). */
  agent_id?: string;
}

/** Returns true iff the absolute path resolves to a SKILL.md inside one of
 *  the three skill roots for the given uid. */
export function isSkillMdPath(absPath: string, uid: string): boolean {
  return parseSkillPath(absPath, uid) !== null;
}

/** Parse a SKILL.md absolute path into `{ system, skill_id, agent_id? }`.
 *  Returns `null` if the path is not under any of the three roots, doesn't
 *  end in SKILL.md, or has an unexpected segment count. */
export function parseSkillPath(absPath: string, uid: string): ParsedSkillPath | null {
  if (!absPath || !uid) return null;
  const abs = path.resolve(absPath);
  if (path.basename(abs) !== 'SKILL.md') return null;

  const a = _tryUnderRoot(abs, userSkillsDir(uid), 1);
  if (a) return { system: 'A.custom', skill_id: a.segments[0] };

  const p = _tryUnderRoot(abs, userMarketplaceSkillsDir(uid), 1);
  if (p) return { system: 'A.platform', skill_id: p.segments[0] };

  // System B: `<uid>/cloud/agents/<aid>/skills/<sid>/SKILL.md`
  const b = _tryUnderRoot(abs, userAgentsDir(uid), 3);
  if (b && b.segments[1] === 'skills') {
    return { system: 'B', skill_id: b.segments[2], agent_id: b.segments[0] };
  }

  return null;
}

/** If `abs` lives under `root` with exactly `expectedDirSegments` directory
 *  segments between root and the SKILL.md file, return those segments;
 *  otherwise return null. Rejects paths that escape root via `..` (we'd
 *  see segments starting with `..` from path.relative). */
function _tryUnderRoot(abs: string, root: string, expectedDirSegments: number): { segments: string[] } | null {
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  // Expected: [...dirSegments, 'SKILL.md']
  if (segments.length !== expectedDirSegments + 1) return null;
  if (segments[segments.length - 1] !== 'SKILL.md') return null;
  return { segments: segments.slice(0, expectedDirSegments) };
}
