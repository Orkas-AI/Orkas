/**
 * ToolCatalog — registry of injected built-in tools.
 *
 * Symmetric to `skill-registry.ts`: emits an "available tools" markdown
 * block injected into setup-LLM prompts, so that prompt templates
 * (`chat_agent_setup.md` etc.) don't have to hard-code tool names.
 *
 * Source of truth: a hand-written central constant table `TOOL_CATALOG`.
 * NOT derived from `AgentTool` instances — the runtime `description` on
 * each tool is a long English doc aimed at the runtime LLM, while the
 * catalog `summary` is a short blurb aimed at the setup LLM; the two
 * audiences are different. `group` / `permission` are human-judged
 * metadata and cannot be inferred from code.
 *
 * Anti-drift: `tool-catalog.test.ts` asserts that the set of tool names
 * runner.ts actually injects is a subset of `TOOL_CATALOG`. Forgetting
 * a catalog entry → test red.
 *
 * Connectors (Notion / Slack / GitHub / Gmail / …) are surfaced through two umbrella meta-
 * tools (`list_connector_tools` / `call_connector_tool`) PLUS a `## Connectors` system-prompt
 * block enumerating connector ids + descriptions. Both are injected only when ≥1 connector is
 * visible to the current actor; otherwise zero connector slots in `tools[]`. The two meta-
 * tools are static and ARE in this catalog; the per-connector MCP actions discovered at
 * runtime are NOT enumerated here (they vary per-user / per-install). See
 * `connector-meta-tools.ts` for the rationale (tool-selection accuracy cliff at 20–50 tools +
 * prompt-cache stability).
 */

import { createLogger } from '../../logger';

const log = createLogger('tool-catalog');

export type ToolGroup =
  | 'fs'         // files / workspace
  | 'shell'      // command line
  | 'pdf'        // PDF rendering
  | 'kb'         // knowledge base
  | 'chat'       // conversation history
  | 'image'      // image generation
  | 'web'        // web access
  | 'connector'  // third-party services via MCP umbrella tools
  | 'meta'       // cross-session state
  | 'group';     // group-chat dispatch (commander only)

export interface ToolCatalogEntry {
  /** Tool name. Must match `AgentTool.name` exactly. */
  name: string;
  /** One-line English description aimed at the setup LLM. */
  summary: string;
  /** Render group; decides which section the entry lands in. */
  group: ToolGroup;
  /** Filled when the tool is gated by a runtime permission. Currently
   *  the only value is `localExec`. */
  permission?: 'localExec';
}

/**
 * The central constant table. **Always** append a row when adding a new
 * tool; the anti-drift test catches omissions.
 *
 * Within each group the order is "most frequently used first", kept stable
 * to keep the rendered KV-cache prefix stable.
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // Files / workspace
  { name: 'read_file',     group: 'fs', summary: 'Read a slice of text from a workspace or attachment file (PDF/DOCX text or image as multimodal).' },
  { name: 'write_file',    group: 'fs', permission: 'localExec', summary: 'Write text/code/markdown into the workspace; resolves under $working_dir.' },
  { name: 'edit_file',     group: 'fs', permission: 'localExec', summary: 'In-place `old_string → new_string` replacement on an existing text file (instead of rewriting the whole file).' },
  { name: 'list_files',    group: 'fs', summary: 'List the workspace directory tree.' },
  { name: 'stat_file',     group: 'fs', summary: 'Trigger PDF/DOCX extraction and return total_chars; call before read_file.' },
  { name: 'search_files',  group: 'fs', summary: 'Find files by name / glob across the workspace + attachment scope.' },
  { name: 'grep_files',    group: 'fs', summary: 'Grep text across the workspace + attachment scope (PDF/DOCX auto-extracted, then searched).' },
  { name: 'create_artifact', group: 'fs', permission: 'localExec', summary: 'Build an interactive multi-file web app (HTML/CSS/JS) rendered live & clickable inside the chat bubble; for dashboards / calculators / visualizations / mini-tools — not documents (html_to_pdf) or images (generate_image).' },

  // Shell
  { name: 'bash',          group: 'shell', permission: 'localExec', summary: 'Execute a shell command on the user\'s machine (cwd = $working_dir).' },

  // PDF
  { name: 'markdown_to_pdf', group: 'pdf', permission: 'localExec', summary: 'Markdown → PDF (CJK-friendly, zero external dependency).' },
  { name: 'html_to_pdf',     group: 'pdf', permission: 'localExec', summary: 'HTML → PDF (same renderer).' },

  // Knowledge base
  { name: 'kb_search',     group: 'kb', summary: 'Semantic search over the user\'s knowledge base.' },
  { name: 'kb_read',       group: 'kb', summary: 'Read source-text chunks from a KB file that kb_search has hit.' },

  // Conversation history
  { name: 'chat_search',   group: 'chat', summary: 'Search prior conversation messages after KB is insufficient or the user asks about previous chats.' },
  { name: 'chat_read',     group: 'chat', summary: 'Read nearby messages from a chat_search hit, or the latest messages from one conversation.' },

  // Image
  { name: 'generate_image', group: 'image', permission: 'localExec', summary: 'Call the configured image-generation API and save the result into the workspace.' },

  // Web (when a vendor-native search is available the framework picks it automatically; the two below are the fallback channel)
  { name: 'web_search',    group: 'web', summary: 'Built-in fallback web search (vendor-native search is preferred automatically when available).' },
  { name: 'web_fetch',     group: 'web', summary: 'Fetch the body of a URL; pairs with web_search.' },

  // Connectors (umbrella meta-tools — actual MCP actions are discovered + invoked via these;
  // injected only when at least one connector is visible to the actor, alongside a
  // `## Connectors` system-prompt block listing the connector ids + descriptions)
  { name: 'list_connector_tools', group: 'connector', summary: 'Discover the actions a specific connector exposes (returns name + JSON input schema for each).' },
  { name: 'call_connector_tool',  group: 'connector', summary: 'Invoke an action on a connector; call list_connector_tools first to learn the action name and schema.' },

  // Cross-session state
  { name: 'cross_session_memory', group: 'meta', summary: 'Read/write user / agent memory that persists across sessions.' },
  { name: 'metacognition',        group: 'meta', summary: 'Read/write metacognition (COMPETENCE / LEARNING_STRATEGIES); env-flag gated.' },

  // Group-chat dispatch (commander only — never injected for ordinary agents)
  { name: 'plan_set',    group: 'group', summary: 'Persist the overall execution plan; the first call announces in the group, subsequent overwrites only update the file.' },
  { name: 'plan_update', group: 'group', summary: 'Update the status of one step (in_progress / done / failed).' },
];

/** Fixed render order + section heading per group. */
const GROUP_ORDER: ReadonlyArray<{ group: ToolGroup; title: string }> = [
  { group: 'fs',    title: 'Files / workspace' },
  { group: 'shell', title: 'Shell' },
  { group: 'pdf',   title: 'PDF' },
  { group: 'kb',    title: 'Knowledge base' },
  { group: 'chat',  title: 'Conversation history' },
  { group: 'image', title: 'Image' },
  { group: 'web',       title: 'Web' },
  { group: 'connector', title: 'Connectors (third-party services)' },
  { group: 'meta',      title: 'Cross-session state' },
  { group: 'group', title: 'Group-chat dispatch' },
];

const CATALOG_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e]),
);

const PREAMBLE =
  'Built-in tools available in the current session, grouped by purpose. ' +
  '**Calling a tool does NOT require a skill wrapper** — if a tool can do the job in one call, just call it; ' +
  'do not design a skill for a single-step task. The real value of a skill is encapsulating multi-step logic, ' +
  'managing third-party API credentials, or reusing a high-frequency composite flow.';

/**
 * Render the `## Available tools` block.
 *
 * `names` should be sourced from runner.ts's actual assembled
 * `allTools.map(t => t.name)` — that way runtime-conditional tools
 * (memory / metacognition / plan_* / uid-gated fileTools, ...) follow
 * the actual injection state automatically; no "listed but not
 * actually injected" drift.
 *
 * Behaviour:
 * - empty `names` → return `""` (core-agent treats empty string as "skip
 *   this section")
 * - a name in `names` that is missing from `TOOL_CATALOG` → warn log +
 *   skip that name; never throws
 * - output is assembled in fixed `GROUP_ORDER`; within each group the
 *   order matches the catalog array — same input → same output, KV
 *   cache friendly
 */
export function getToolsSystemPromptBlock(names: string[]): string {
  if (!names.length) return '';

  const seen = new Set<string>();
  const present: ToolCatalogEntry[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = CATALOG_BY_NAME.get(name);
    if (!entry) {
      log.warn(`tool "${name}" injected at runtime but missing from TOOL_CATALOG; skipping`);
      continue;
    }
    present.push(entry);
  }
  if (!present.length) return '';

  const presentSet = new Set(present.map((e) => e.name));
  const lines: string[] = ['## Available tools', '', PREAMBLE, ''];

  for (const { group, title } of GROUP_ORDER) {
    const groupEntries = TOOL_CATALOG.filter(
      (e) => e.group === group && presentSet.has(e.name),
    );
    if (!groupEntries.length) continue;
    lines.push(`### ${title}`);
    for (const e of groupEntries) {
      const perm = e.permission === 'localExec' ? ' (gated by local-execution permission)' : '';
      lines.push(`- **${e.name}** — ${e.summary}${perm}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
