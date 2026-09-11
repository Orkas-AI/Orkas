/** Runtime and authoring contract for Skill discovery descriptions. */
export const SKILL_DESCRIPTION_ROSTER_MAX_CHARS = 512;
/** Maximum size of the regular Skill routing index injected into one prompt.
 * System Skills use their separate authoring block. The regular index first
 * removes lower-tier descriptions and then omits searchable rows; it is never
 * capped by Skill count. */
export const SKILL_ROSTER_MAX_CHARS = 8_000;
/** Commander agent-directory ceiling. Agents are a short roster (about ten
 * built-ins) whose authored description must carry phrasings, routing terms,
 * and a negative boundary per the agent-authoring contract; the Skill roster
 * ceiling silently cut the trailing trigger lists of five built-in agents. */
export const AGENT_DESCRIPTION_ROSTER_MAX_CHARS = 800;

/** Preferred range for descriptions authored from scratch. */
export const SKILL_DESCRIPTION_AUTHORING_MIN_CHARS = 100;
export const SKILL_DESCRIPTION_AUTHORING_MAX_CHARS = 500;
