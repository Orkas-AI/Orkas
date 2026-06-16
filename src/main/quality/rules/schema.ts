/**
 * Schema-level checks for SKILL.md frontmatter, skill _meta.json, and agent.json. Catches
 * structural breakage prompt rules can't reliably prevent (truncation,
 * malformed YAML, wrong name pattern).
 *
 * EXTREME = spec is unusable; MEDIUM = spec works but should be cleaned up.
 *
 * Portable SKILL.md frontmatter stays host-generic: `name / description`.
 * Orkas extensions such as category, localized descriptions, and routing
 * hints live in `_meta.json`. Legacy frontmatter extension fields are
 * tolerated as advisory findings so existing skills remain importable.
 */

import { Violation } from '../types';

// Skill name pattern: starts with a letter, then word chars / dashes.
// Spaces are not allowed. Mirrors `skills.ts::SKILL_NAME_RE`.
const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
// Agent names mirror `agents.ts::NAME_TOKEN_RE`.
const AGENT_NAME_RE = /^[A-Za-z0-9_一-鿿-]+$/;

// Description length budget: signal for "selection prompt readability" rather
// than a hard cap. Empirically established by scanning current marketplace
// content — the long tail sits in the 500-700 range with a real ceiling
// around 800.
const MAX_DESC_LEN = 800;

const CATEGORY_CODE_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const SKILL_FRONTMATTER_EXTENSION_KEYS = new Set([
  'description_zh',
  'description_en',
  'category',
  'status',
  'state',
]);

function _stringField(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === 'string' ? String(obj[key]).trim() : '';
}

function _skillMetaDescriptions(meta: Record<string, unknown> | undefined): { zh: string; en: string } {
  if (!meta || typeof meta !== 'object') return { zh: '', en: '' };
  const descriptions = meta.descriptions && typeof meta.descriptions === 'object' && !Array.isArray(meta.descriptions)
    ? meta.descriptions as Record<string, unknown>
    : {};
  return {
    zh: _stringField(descriptions, 'zh') || _stringField(meta, 'description_zh'),
    en: _stringField(descriptions, 'en') || _stringField(meta, 'description_en'),
  };
}

/**
 * Validate SKILL.md frontmatter. Body content is scanned separately by
 * red-flags + extractExecutableBlocks.
 */
export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  skillMeta: Record<string, unknown> = {},
): Violation[] {
  const out: Violation[] = [];

  const name = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  if (!name.trim()) {
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
      suggested_fix: 'Skill name should start with a letter and contain only letters, digits, `_`, and `-`; spaces are not allowed.',
    });
  }

  for (const key of Object.keys(frontmatter)) {
    if (!SKILL_FRONTMATTER_EXTENSION_KEYS.has(key)) continue;
    out.push({
      level: 'LOW',
      rule: 'frontmatter_extension_field',
      field: `frontmatter:${key}`,
      snippet: String(frontmatter[key] || '').slice(0, 120),
      suggested_fix: 'Keep SKILL.md frontmatter portable (`name` and `description` only); store Orkas metadata in `_meta.json`.',
    });
  }

  const metaDescriptions = _skillMetaDescriptions(skillMeta);
  const zh = _stringField(frontmatter, 'description_zh');
  const en = _stringField(frontmatter, 'description_en');
  const legacy = _stringField(frontmatter, 'description');
  if (!zh && !en && !legacy && !metaDescriptions.zh && !metaDescriptions.en) {
    out.push({
      level: 'MEDIUM',
      rule: 'frontmatter_description_missing',
      field: 'frontmatter:description',
      snippet: '',
      suggested_fix: 'Add a concise `description:` in SKILL.md, or localized descriptions under `_meta.json.descriptions`.',
    });
  } else {
    for (const [field, value] of [
      ['description_zh', zh], ['description_en', en], ['description', legacy],
      ['_meta.descriptions.zh', metaDescriptions.zh], ['_meta.descriptions.en', metaDescriptions.en],
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

export function validateSkillMeta(
  skillMeta: Record<string, unknown>,
): Violation[] {
  const out: Violation[] = [];
  const category = _stringField(skillMeta, 'category');
  if (!category) {
    out.push({
      level: 'MEDIUM',
      rule: 'skill_meta_category_missing',
      field: '_meta.json:category',
      snippet: '',
      suggested_fix: 'Add `category` to `_meta.json` using a safe marketplace category code.',
    });
  } else if (!CATEGORY_CODE_RE.test(category)) {
    out.push({
      level: 'MEDIUM',
      rule: 'skill_meta_category_invalid',
      field: '_meta.json:category',
      snippet: category.slice(0, 80),
      suggested_fix: 'Use a safe marketplace category code in `_meta.json`.',
    });
  }

  const routing = skillMeta.routing && typeof skillMeta.routing === 'object' && !Array.isArray(skillMeta.routing)
    ? skillMeta.routing as Record<string, unknown>
    : {};
  const negativeExamples = Array.isArray(routing.negative_examples) && routing.negative_examples.length > 0;
  const applicableDomain = (
    typeof routing.applicable_domain === 'string' && routing.applicable_domain.trim()
  ) || (
    Array.isArray(routing.applicable_domain) && routing.applicable_domain.length > 0
  );
  const prerequisites = Array.isArray(routing.prerequisites);
  if (!negativeExamples || !applicableDomain || !prerequisites) {
    out.push({
      level: 'LOW',
      rule: 'skill_meta_routing_incomplete',
      field: '_meta.json:routing',
      snippet: '',
      suggested_fix: 'Add routing.applicable_domain, routing.negative_examples, and routing.prerequisites when they help distinguish this skill.',
    });
  }

  return out;
}

export function skillMetaParseViolation(message: string): Violation {
  return {
    level: 'MEDIUM',
    rule: 'skill_meta_unparseable',
    field: '_meta.json',
    snippet: message.slice(0, 200),
    suggested_fix: 'Make `_meta.json` valid JSON so Orkas can read category, localized descriptions, and routing hints.',
  };
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

  const name = typeof agentJson.name === 'string' ? agentJson.name : '';
  if (!name.trim()) {
    out.push({
      level: 'EXTREME',
      rule: 'agent_name_missing',
      field: 'agent.json:name',
      snippet: '',
      suggested_fix: 'Agent spec must include a non-empty `name`.',
    });
  } else if (!AGENT_NAME_RE.test(name)) {
    out.push({
      level: 'MEDIUM',
      rule: 'agent_name_invalid',
      field: 'agent.json:name',
      snippet: name.slice(0, 100),
      suggested_fix: 'Agent name should contain only letters, digits, `_`, `-`, or CJK characters; spaces are not allowed.',
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

  const category = typeof agentJson.category === 'string' ? agentJson.category.trim() : '';
  if (!category) {
    out.push({
      level: 'MEDIUM',
      rule: 'agent_category_missing',
      field: 'agent.json:category',
      snippet: '',
      suggested_fix: 'Add `category` using the category codes defined in agent-creator; the writer can backfill the default when missing.',
    });
  } else if (!CATEGORY_CODE_RE.test(category)) {
    out.push({
      level: 'MEDIUM',
      rule: 'agent_category_invalid',
      field: 'agent.json:category',
      snippet: category.slice(0, 80),
      suggested_fix: 'Use a safe marketplace category code from agent-creator.',
    });
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
