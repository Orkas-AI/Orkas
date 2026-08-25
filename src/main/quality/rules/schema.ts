/**
 * Schema-level checks for SKILL.md frontmatter, skill _meta.json, and agent.json. Catches
 * structural breakage prompt rules can't reliably prevent (truncation,
 * malformed YAML, wrong name pattern).
 *
 * EXTREME = spec is unusable; MEDIUM = spec works but should be cleaned up.
 *
 * User-authored and external portable SKILL.md frontmatter uses
 * `name / description`. Repository-managed System, Marketplace, and official
 * Agent-private Skills use `name / description_zh / description_en` so both
 * routing locales are explicit. The two description shapes are alternatives,
 * never three simultaneous fields. Other Orkas extensions such as category
 * and routing hints live in `_meta.json`; legacy extension fields remain
 * advisory so existing skills stay importable.
 */

import { Violation } from '../types';
import { SKILL_DESCRIPTION_ROSTER_MAX_CHARS } from '../../util/skill-description-policy';

// Skill name pattern: starts with a letter, then word chars / dashes.
// Spaces are not allowed. Mirrors `skills.ts::SKILL_NAME_RE`.
const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
// Agent names mirror `agents.ts::NAME_TOKEN_RE`.
const AGENT_NAME_RE = /^[A-Za-z0-9_一-鿿-]+$/;

// Agent descriptions retain their existing authoring advisory. Skill
// descriptions align with the runtime roster ceiling below so the author sees
// a quality finding before routing-critical text is visibly shortened.
const MAX_AGENT_DESC_LEN = 800;
const MAX_AGENT_WORKFLOW_LEN = 3_000;
const MAX_AGENT_GUIDANCE_ITEMS = 5;
const MAX_AGENT_GUIDANCE_ITEM_LEN = 220;

const CATEGORY_CODE_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const SKILL_FRONTMATTER_EXTENSION_KEYS = new Set([
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

function _validateAgentGuidanceList(
  agentJson: Record<string, unknown>,
  field: 'knowhow' | 'standards',
  required: boolean,
): Violation[] {
  const value = agentJson[field];
  if (value === undefined) {
    return required ? [{
      level: 'MEDIUM',
      rule: `agent_${field}_missing`,
      field: `agent.json:${field}`,
      snippet: '',
      suggested_fix: field === 'knowhow'
        ? 'Add 1–5 concise display-only capability summaries for this LLM-managed Agent.'
        : 'Add 1–5 observable final handoff or valid-stop conditions for this LLM-managed Agent.',
    }] : [];
  }
  if (!Array.isArray(value)) {
    return [{
      level: 'MEDIUM',
      rule: `agent_${field}_invalid`,
      field: `agent.json:${field}`,
      snippet: String(value).slice(0, 120),
      suggested_fix: field === 'knowhow'
        ? `Store ${field} as an optional array of 0–${MAX_AGENT_GUIDANCE_ITEMS} concise strings.`
        : `Store ${field} as an array of 1–${MAX_AGENT_GUIDANCE_ITEMS} concise strings.`,
    }];
  }

  const out: Violation[] = [];
  if (required && value.length === 0) {
    out.push({
      level: 'MEDIUM',
      rule: `agent_${field}_missing`,
      field: `agent.json:${field}`,
      snippet: '[]',
      suggested_fix: field === 'knowhow'
        ? 'Add at least one concrete display-only capability summary.'
        : 'Add at least one observable final handoff or valid-stop condition.',
    });
  }
  if (value.length > MAX_AGENT_GUIDANCE_ITEMS) {
    out.push({
      level: 'MEDIUM',
      rule: `agent_${field}_too_many`,
      field: `agent.json:${field}`,
      snippet: `${value.length} items`,
      suggested_fix: `Merge overlaps or move route-specific detail into Skills; keep at most ${MAX_AGENT_GUIDANCE_ITEMS} items.`,
    });
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      out.push({
        level: 'MEDIUM',
        rule: `agent_${field}_item_invalid`,
        field: `agent.json:${field}[${index}]`,
        snippet: String(item).slice(0, 120),
        suggested_fix: `Use a non-empty string for every ${field} item.`,
      });
    } else if (item.length > MAX_AGENT_GUIDANCE_ITEM_LEN) {
      out.push({
        level: 'MEDIUM',
        rule: `agent_${field}_item_too_long`,
        field: `agent.json:${field}[${index}]`,
        snippet: `${item.slice(0, 80)}…`,
        suggested_fix: `Keep each ${field} item at or below ${MAX_AGENT_GUIDANCE_ITEM_LEN} characters.`,
      });
    }
  });
  return out;
}

/**
 * Validate SKILL.md frontmatter. Body content is scanned separately by
 * red-flags + extractExecutableBlocks.
 */
export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  skillMeta: Record<string, unknown> = {},
  options: { allowExtensionFields?: boolean } = {},
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
    if (options.allowExtensionFields === true) continue;
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
  const generic = _stringField(frontmatter, 'description');
  if (generic && (zh || en)) {
    out.push({
      level: 'MEDIUM',
      rule: 'frontmatter_description_shapes_mixed',
      field: 'frontmatter:description',
      snippet: generic.slice(0, 120),
      suggested_fix: 'Use exactly one description shape: `description` for a user/custom portable Skill, or both `description_zh` and `description_en` for a platform-managed Skill.',
    });
  }
  if (!generic && (zh || en) && (!zh || !en)) {
    out.push({
      level: 'MEDIUM',
      rule: 'frontmatter_localized_description_incomplete',
      field: `frontmatter:${zh ? 'description_en' : 'description_zh'}`,
      snippet: '',
      suggested_fix: 'Platform-managed localized descriptions are a pair; add the missing `description_zh` or `description_en`, or use one portable `description` for a user/custom Skill.',
    });
  }
  if (!zh && !en && !generic && !metaDescriptions.zh && !metaDescriptions.en) {
    out.push({
      level: 'MEDIUM',
      rule: 'frontmatter_description_missing',
      field: 'frontmatter:description',
      snippet: '',
      suggested_fix: 'Add one concise `description` for a user/custom Skill, or both `description_zh` and `description_en` for a platform-managed Skill.',
    });
  } else {
    for (const [field, value] of [
      ['description_zh', zh], ['description_en', en], ['description', generic],
      ['_meta.descriptions.zh', metaDescriptions.zh], ['_meta.descriptions.en', metaDescriptions.en],
    ] as const) {
      if (value.length > SKILL_DESCRIPTION_ROSTER_MAX_CHARS) {
        out.push({
          level: 'MEDIUM',
          rule: 'frontmatter_description_too_long',
          field: `frontmatter:${field}`,
          snippet: `${value.slice(0, 80)}…`,
          suggested_fix: `Keep ${field} at or below ${SKILL_DESCRIPTION_ROSTER_MAX_CHARS} characters — longer runtime roster text is shortened with an ellipsis, so put routing-critical signal first.`,
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

  // Routing metadata is optional because the authored description is the
  // runtime selection index. Validate a supplied routing object, but do not
  // make every simple Skill carry a second copy of the same boundary text.
  if (!Object.prototype.hasOwnProperty.call(skillMeta, 'routing')) return out;
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
      suggested_fix: 'Complete routing.applicable_domain, routing.negative_examples, and routing.prerequisites, or omit routing when the authored description already distinguishes this skill.',
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
      if (value.length > MAX_AGENT_DESC_LEN) {
        out.push({
          level: 'MEDIUM',
          rule: 'agent_description_too_long',
          field: `agent.json:${field}`,
          snippet: `${value.slice(0, 80)}…`,
          suggested_fix: `Trim ${field} to under ${MAX_AGENT_DESC_LEN} characters.`,
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

  const workflowValue = agentJson.workflow;
  const hasWorkflow = typeof workflowValue === 'string' && workflowValue.trim().length > 0;
  if (workflowValue !== undefined && typeof workflowValue !== 'string') {
    out.push({
      level: 'MEDIUM',
      rule: 'agent_workflow_invalid',
      field: 'agent.json:workflow',
      snippet: String(workflowValue).slice(0, 120),
      suggested_fix: 'Store workflow as a Markdown string for an LLM-managed Agent, or omit it for a CLI-backed Agent.',
    });
  } else if (typeof workflowValue === 'string' && workflowValue.length > MAX_AGENT_WORKFLOW_LEN) {
    out.push({
      level: 'MEDIUM',
      rule: 'agent_workflow_too_long',
      field: 'agent.json:workflow',
      snippet: `${workflowValue.slice(0, 80)}…`,
      suggested_fix: `Keep resident orchestration at or below ${MAX_AGENT_WORKFLOW_LEN} characters; move conditional procedure, commands, schemas, retries, and examples into the owning Skill.`,
    });
  }

  out.push(..._validateAgentGuidanceList(agentJson, 'knowhow', false));
  out.push(..._validateAgentGuidanceList(agentJson, 'standards', hasWorkflow));

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
