/**
 * ToolCatalog — registry of injected built-in tools.
 *
 * Source of truth: a hand-written central constant table `TOOL_CATALOG`.
 * Historically it also rendered an "available tools" markdown block into the
 * setup-LLM prompts, but the runner no longer injects that block; the catalog
 * now backs the anti-drift test below (and any future tool-listing surface).
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
  | 'office'     // Word / Excel / PowerPoint documents
  | 'kb'         // Library
  | 'chat'       // conversation history
  | 'image'      // image generation
  | 'video'      // video generation
  | 'web'        // web access
  | 'connector'  // third-party services via MCP umbrella tools
  | 'meta';      // cross-session state

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
  /** When set, the tool is OWNED by one agent (a single id) or a fixed set of
   *  agents (a list of ids): it is injected only when the current actor's
   *  agentId is the owner / among the owners, and is invisible to every other
   *  actor (commander included). Default-deny — used for agent-specific tools
   *  that would only clutter the commander's `tools[]`. Enforced in runner.ts
   *  via `isToolVisibleToAgent`; the binding lives here so the catalog stays
   *  the single source of truth. */
  ownerAgent?: string | string[];
}

/**
 * The central constant table. **Always** append a row when adding a new
 * tool; the anti-drift test catches omissions.
 *
 * Within each group the order is "most frequently used first", kept stable
 * to keep the rendered KV-cache prefix stable.
 */
/**
 * Agent ids that share the deep-research engine, so its `research_rerank` tool
 * is visible to the platform DeepResearcher and hosted data/research agents
 * that can hand work into the research flow:
 * DeepResearcher / KnowledgeManager / SocialResearcher / BrandResearcher.
 * Referenced by opaque marketplace id (as skill_list does), not by name.
 */
export const DEEP_RESEARCH_AGENT_IDS = [
  '78900d8758bc', // DeepResearcher
  '5dd962efb425', // KnowledgeManager
  '17c0a2e95df3', // SocialResearcher
  '7083ff63b398', // BrandResearcher
];

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // Files / workspace
  { name: 'read_file',     group: 'fs', summary: 'Read a slice of text from a workspace or attachment file (PDF/modern Office text or image as multimodal).' },
  { name: 'write_file',    group: 'fs', permission: 'localExec', summary: 'Write text/code/markdown into the workspace; resolves under $working_dir.' },
  { name: 'edit_file',     group: 'fs', permission: 'localExec', summary: 'In-place `old_string → new_string` replacement on an existing text file (instead of rewriting the whole file).' },
  { name: 'delete_file',   group: 'fs', permission: 'localExec', summary: 'Delete a single file from the workspace / current attachment dir / extraRoots. The first call shows an inline confirmation card and returns a token; multiple deletes from the same turn are grouped in one card when possible. Use instead of `bash rm` for removals.' },
  { name: 'list_files',    group: 'fs', summary: 'List the workspace directory tree.' },
  { name: 'stat_file',     group: 'fs', summary: 'Trigger PDF/modern Office extraction and return total_chars; call before read_file.' },
  { name: 'ocr_file',      group: 'fs', summary: 'Run local OCR on PDF pages or image files when visual text is not available through read_file/stat_file.' },
  { name: 'search_files',  group: 'fs', summary: 'Find files by name / glob across the workspace + attachment scope.' },
  { name: 'grep_files',    group: 'fs', summary: 'Grep text across the workspace + attachment scope (PDF/modern Office auto-extracted, then searched); optional `glob` scope + `output_mode` files/count.' },
  { name: 'create_artifact', group: 'fs', permission: 'localExec', summary: 'Build an interactive multi-file app (HTML/CSS/JS) rendered live & clickable inside the chat bubble; for interactive dashboards / calculators / visualizations / mini-tools. Static/read-only dashboards should use :::dashboard; not documents (html_to_pdf) or images (generate_image).' },

  // Shell
  { name: 'bash',          group: 'shell', permission: 'localExec', summary: 'Execute a shell command on the user\'s machine (cwd = $working_dir).' },
  { name: 'interactive_cli_start', group: 'shell', permission: 'localExec', summary: 'Start a live stdin/stdout session for any local CLI command expected to wait for user input.' },
  { name: 'interactive_cli_read',  group: 'shell', permission: 'localExec', summary: 'Read status and recent output from an interactive CLI session.' },
  { name: 'interactive_cli_send',  group: 'shell', permission: 'localExec', summary: 'Send non-secret stdin to an interactive CLI session; user secrets must go through the UI panel.' },
  { name: 'interactive_cli_close', group: 'shell', permission: 'localExec', summary: 'Terminate an interactive CLI session and its process tree.' },

  // PDF
  { name: 'markdown_to_pdf', group: 'pdf', permission: 'localExec', summary: 'Markdown → PDF (CJK-friendly, zero external dependency).' },
  { name: 'html_to_pdf',     group: 'pdf', permission: 'localExec', summary: 'HTML → PDF (same renderer).' },

  // Office documents (bundled OfficeCLI engine — no MS Office needed)
  { name: 'create_docx',   group: 'office', permission: 'localExec', summary: 'Create a Word (.docx) document from paragraphs (styles + inline bold/font/size/color), plus tables and images; CJK-ready, first-page PNG preview; built-in engine, no MS Office required.' },
  { name: 'create_xlsx',   group: 'office', permission: 'localExec', summary: 'Create an Excel (.xlsx) workbook from rows (values + formulas + number formats + cell fill/font/align/border), with multiple sheets and column widths; CJK-ready, PNG preview.' },
  { name: 'create_pptx',   group: 'office', permission: 'localExec', summary: 'Create a PowerPoint (.pptx) deck (title/body/layout, slide background/transition, free-positioned styled shapes, plus images and tables for designed slides); CJK-ready, first-slide PNG preview.' },
  { name: 'office_read',   group: 'office', permission: 'localExec', summary: 'Read an existing .docx/.xlsx/.pptx with element paths (text/outline/get/query) so edits can target them; pairs with edit_office.' },
  { name: 'edit_office',   group: 'office', permission: 'localExec', summary: 'Edit an existing .docx/.xlsx/.pptx in place (set/add/remove on element paths), preserving formatting; returns a PNG preview.' },
  { name: 'office_render', group: 'office', permission: 'localExec', summary: 'Render a page of an existing .docx/.xlsx/.pptx to a PNG image to inspect layout / fonts / CJK glyphs.' },

  // Library
  { name: 'kb_list',       group: 'kb', summary: 'List Library files and indexing status before choosing what to search or read.' },
  { name: 'kb_search',     group: 'kb', summary: 'Semantic search over the user\'s Library.' },
  { name: 'kb_read',       group: 'kb', summary: 'Read source-text chunks from a Library file that kb_search has hit.' },
  { name: 'research_rerank', group: 'kb', ownerAgent: DEEP_RESEARCH_AGENT_IDS, summary: 'Semantically rerank candidate research passages against a sub-question by local embedding similarity — the second stage after the deep-research compress skill\'s lexical filter, surfacing on-topic passages that share no keywords. Read-only, local, no Tool Execution Access. Owned by the deep-research + data-research agents (hidden from the commander).' },

  // Conversation history
  { name: 'chat_search',   group: 'chat', summary: 'Search prior conversation messages after Library is insufficient or the user asks about previous chats.' },
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
  { name: 'add_custom_connector', group: 'connector', summary: 'Commander-only: add a user-described custom MCP server (requires a user confirmation dialog before install).' },

  // Cross-session state
  { name: 'cross_session_memory', group: 'meta', summary: 'Read/write user profile, shared facts, and agent memory that persist across sessions.' },
  { name: 'metacognition',        group: 'meta', summary: 'Read/write metacognition (COMPETENCE / LEARNING_STRATEGIES); env-flag gated.' },

  // NB: the commander's group-dispatch tools (dispatch_to / run_worker) and other
  // group_chat extras (auto_tasks_list / marketplace_* / skill_search) are
  // caller-supplied `extraTools`, NOT runner-injected, so they are intentionally
  // absent here — the anti-drift test only covers runner-injected builtins.
];

/** Fixed render order + section heading per group. */
const GROUP_ORDER: ReadonlyArray<{ group: ToolGroup; title: string }> = [
  { group: 'fs',    title: 'Files / workspace' },
  { group: 'shell', title: 'Shell' },
  { group: 'pdf',   title: 'PDF' },
  { group: 'office', title: 'Office documents' },
  { group: 'kb',    title: 'Library' },
  { group: 'chat',  title: 'Conversation history' },
  { group: 'image', title: 'Image' },
  { group: 'video', title: 'Video' },
  { group: 'web',       title: 'Web' },
  { group: 'connector', title: 'Connectors (third-party services)' },
  { group: 'meta',      title: 'Cross-session state' },
];

const CATALOG_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e]),
);

/**
 * Owner-scoped visibility gate. A tool is visible to an actor when its catalog
 * entry declares no `ownerAgent`, or lists `agentId` among its owner(s) (a
 * single id or an array of ids). Tools not in the catalog (caller-supplied
 * `extraTools` such as the commander's dispatch tools) are never owner-gated →
 * always visible. This is the authoritative check runner.ts applies before
 * handing `tools[]` to the model.
 */
export function isToolVisibleToAgent(name: string, agentId: string): boolean {
  const owner = CATALOG_BY_NAME.get(name)?.ownerAgent;
  if (!owner) return true;
  return Array.isArray(owner) ? owner.includes(agentId) : owner === agentId;
}

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
      log.warn('runtime tool missing from TOOL_CATALOG', { tool: name });
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
