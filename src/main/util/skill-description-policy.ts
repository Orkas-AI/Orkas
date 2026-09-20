/** Local estimated-token budgets for Skill discovery, including CJK and JSON.
 * Separate authoring targets below remain writing guidance, not context caps. */
export const SKILL_DESCRIPTION_ROSTER_MAX_TOKENS = 200;
/** Fitting budget of the regular Skill routing index injected into one prompt.
 * System Skills use their separate authoring block. The regular index first
 * removes lower-tier descriptions and then omits searchable rows; it is never
 * capped by Skill count. Protected builtin/private/explicit rows may exceed
 * this budget; the existing retention contract takes precedence. */
export const SKILL_ROSTER_MAX_TOKENS = 4_000;
/** Commander agent-directory ceiling. Agents are a short roster (about ten
 * built-ins) whose authored description must carry phrasings, routing terms,
 * and a negative boundary per the agent-authoring contract; the Skill roster
 * ceiling silently cut the trailing trigger lists of five built-in agents. */
export const AGENT_DESCRIPTION_ROSTER_MAX_CHARS = 800;

/** Preferred ceiling for descriptions authored from scratch; no minimum. */
export const SKILL_DESCRIPTION_AUTHORING_MAX_CHARS = 200;
