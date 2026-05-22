/**
 * Schema-level checks for SKILL.md frontmatter + agent.json. Catches
 * structural breakage prompt rules can't reliably prevent (truncation,
 * malformed YAML, wrong name pattern).
 *
 * EXTREME = spec is unusable; MEDIUM = spec works but should be cleaned up.
 *
 * Field set matches `PC/CLAUDE.md` §6 — allowed frontmatter keys are
 * `name / description_zh / description_en / category`. Legacy `description`
 * is tolerated (migrated by the loader's CJK heuristic) but does not satisfy
 * the bilingual-pair requirement.
 */

import { Violation } from '../types';

// Skill name pattern: starts with a letter, then word chars / dashes, single
// spaces allowed between groups. Mirrors `skills.ts::SKILL_NAME_RE`.
const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+)*$/;

// Description length budget: signal for "selection prompt readability" rather
// than a hard cap. Empirically established by scanning current marketplace
// content — the long tail sits in the 500-700 range with a real ceiling
// around 800.
const MAX_DESC_LEN = 800;

/**
 * Validate SKILL.md frontmatter. Body content is scanned separately by
 * red-flags + extractExecutableBlocks.
 */
export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
): Violation[] {
  const out: Violation[] = [];

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    out.push({
      level: 'EXTREME',
      rule: 'frontmatter_name_missing',
      field: 'frontmatter:name',
      snippet: '',
      suggested_fix: 'Add a `name:` field in the SKILL.md frontmatter.',
    });
  } else if (!SKILL_NAME_RE.test(name)) {
    // MEDIUM, not EXTREME: legacy marketplace skills carry display names with
    // `/` or other punctuation ("Word / DOCX", "Excel / XLSX"). Blocking
    // their write would brick re-saves; flag for cleanup instead.
    out.push({
      level: 'MEDIUM',
      rule: 'frontmatter_name_invalid',
      field: 'frontmatter:name',
      snippet: name.slice(0, 100),
      suggested_fix: 'Skill name should start with a letter and contain only letters, digits, `_`, `-`, and single spaces between word groups.',
    });
  }

  // Bilingual description is required for marketplace distribution but the
  // loader migrates a single legacy `description` via CJK heuristic — treat
  // "at least one of zh/en/legacy is non-empty" as the minimum bar.
  const zh = typeof frontmatter.description_zh === 'string' ? frontmatter.description_zh.trim() : '';
  const en = typeof frontmatter.description_en === 'string' ? frontmatter.description_en.trim() : '';
  const legacy = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!zh && !en && !legacy) {
    out.push({
      level: 'EXTREME',
      rule: 'frontmatter_description_missing',
      field: 'frontmatter:description',
      snippet: '',
      suggested_fix: 'Add `description_zh:` and `description_en:` fields so the commander can pick this skill in either UI language.',
    });
  } else {
    for (const [field, value] of [
      ['description_zh', zh], ['description_en', en], ['description', legacy],
    ] as const) {
      if (value.length > MAX_DESC_LEN) {
        out.push({
          level: 'MEDIUM',
          rule: 'frontmatter_description_too_long',
          field: `frontmatter:${field}`,
          snippet: `${value.slice(0, 80)}…`,
          suggested_fix: `Trim ${field} to under ${MAX_DESC_LEN} characters — the commander selection prompt truncates long descriptions and loses signal.`,
        });
      }
    }
  }

  return out;
}

/**
 * Validate parsed agent.json shape.
 *
 * Required fields: `agent_id`, `name`, plus at least one of `description_zh` /
 * `description_en` / legacy `description`.
 */
export function validateAgentJsonShape(
  agentJson: Record<string, unknown>,
): Violation[] {
  const out: Violation[] = [];

  const agentId = typeof agentJson.agent_id === 'string' ? agentJson.agent_id.trim() : '';
  if (!agentId) {
    out.push({
      level: 'EXTREME',
      rule: 'agent_id_missing',
      field: 'agent.json:agent_id',
      snippet: '',
      suggested_fix: 'Agent spec must include `agent_id`.',
    });
  }

  const name = typeof agentJson.name === 'string' ? agentJson.name.trim() : '';
  if (!name) {
    out.push({
      level: 'EXTREME',
      rule: 'agent_name_missing',
      field: 'agent.json:name',
      snippet: '',
      suggested_fix: 'Agent spec must include a non-empty `name`.',
    });
  }

  const zh = typeof agentJson.description_zh === 'string' ? agentJson.description_zh.trim() : '';
  const en = typeof agentJson.description_en === 'string' ? agentJson.description_en.trim() : '';
  const legacy = typeof agentJson.description === 'string' ? agentJson.description.trim() : '';
  if (!zh && !en && !legacy) {
    // MEDIUM, not EXTREME: agents are commonly created as a stub
    // (createCustomAgent with no body) and filled in via the inline
    // edit chat afterwards. Blocking the create breaks that flow.
    // The commander will simply not pick a description-less agent
    // until the user fills it in — non-fatal.
    out.push({
      level: 'MEDIUM',
      rule: 'agent_description_missing',
      field: 'agent.json:description',
      snippet: '',
      suggested_fix: 'Add `description_zh` and `description_en` so the commander can dispatch this agent in either UI language.',
    });
  } else {
    for (const [field, value] of [
      ['description_zh', zh], ['description_en', en], ['description', legacy],
    ] as const) {
      if (value.length > MAX_DESC_LEN) {
        out.push({
          level: 'MEDIUM',
          rule: 'agent_description_too_long',
          field: `agent.json:${field}`,
          snippet: `${value.slice(0, 80)}…`,
          suggested_fix: `Trim ${field} to under ${MAX_DESC_LEN} characters.`,
        });
      }
    }
  }

  return out;
}

/**
 * Parse-fail violation. Issued by the public API when YAML / JSON cannot be
 * read at all, so the persisted report still captures the failure.
 */
export function parseFailureViolation(args: {
  kind: 'frontmatter' | 'agent_json';
  message: string;
}): Violation {
  return {
    level: 'EXTREME',
    rule: args.kind === 'frontmatter' ? 'frontmatter_unparseable' : 'agent_json_unparseable',
    field: args.kind === 'frontmatter' ? 'frontmatter' : 'agent.json',
    snippet: args.message.slice(0, 200),
    suggested_fix: args.kind === 'frontmatter'
      ? 'SKILL.md frontmatter must be a valid YAML scalar map between two `---` lines.'
      : 'agent.json must be valid JSON.',
  };
}
