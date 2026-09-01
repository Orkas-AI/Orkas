/**
 * Canonical catalog for every in-process Orkas tool.
 *
 * Tool groups are a stable compatibility API used by agent.json.tool_list,
 * runtime activation, and persisted session state. Runtime availability is
 * still authoritative: catalog membership never grants a tool or permission.
 */

import { createLogger } from '../../logger';

const log = createLogger('tool-catalog');

export type ToolGroupId =
  | 'workspace'
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.write.output'
  | 'workspace.write.edit'
  | 'workspace.execute'
  | 'workspace.execute.command'
  | 'workspace.execute.session'
  | 'workspace.artifact'
  | 'office'
  | 'office.word'
  | 'office.spreadsheet'
  | 'office.presentation'
  | 'office.pdf'
  | 'library'
  | 'web'
  | 'media'
  | 'media.image'
  | 'media.video'
  | 'media.speech'
  | 'connectors'
  | 'context'
  | 'orchestration'
  | 'management'
  | 'management.app'
  | 'management.skills'
  | 'management.marketplace'
  | 'management.automation'
  | 'runtime';

export interface ToolGroupEntry {
  id: ToolGroupId;
  title: string;
  summary: string;
  parent?: ToolGroupId;
  /** Whether Commander may activate the group with tool_load. */
  activation: 'loadable' | 'host-managed';
  /** Whether Agent Creator may persist this group in agent.json.tool_list. */
  agentDependency: boolean;
}

export interface ToolCatalogEntry {
  /** Exact AgentTool.name. */
  name: string;
  /** Compact discovery/diagnostic description. */
  summary: string;
  /** Groups that may activate this tool. */
  loadGroups?: ToolGroupId[];
  /** Existing default-deny owner isolation. */
  ownerAgent?: string | string[];
  /** False for Commander-only tools that share a loadable group with tools a
   * named Agent may declare. Defaults to true when the group is eligible. */
  agentAssignable?: boolean;
  /** Execution permission; loading never grants it. */
  permission?: 'localExec';
}

export const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
export const IMAGE_STUDIO_AGENT_ID = '814b61b027f0';

export const TOOL_GROUPS: readonly ToolGroupEntry[] = [
  { id: 'workspace', title: 'Workspace', summary: 'Read, modify, execute in, or build interactive artifacts in the workspace.', activation: 'loadable', agentDependency: true },
  { id: 'workspace.read', title: 'Workspace read', summary: 'Read, inspect, find, OCR, and search workspace or attachment files.', parent: 'workspace', activation: 'loadable', agentDependency: true },
  { id: 'workspace.write', title: 'Workspace write', summary: 'Create, edit, delete, diff, and publish workspace files.', parent: 'workspace', activation: 'loadable', agentDependency: true },
  { id: 'workspace.write.output', title: 'Workspace output', summary: 'Create, append, and publish output files without editing or deleting existing files.', parent: 'workspace.write', activation: 'loadable', agentDependency: true },
  { id: 'workspace.write.edit', title: 'Workspace edit', summary: 'Patch, edit, delete, and inspect changes to existing workspace files.', parent: 'workspace.write', activation: 'loadable', agentDependency: true },
  { id: 'workspace.execute', title: 'Workspace execute', summary: 'Run shell commands and persistent or interactive local processes.', parent: 'workspace', activation: 'loadable', agentDependency: true },
  { id: 'workspace.execute.command', title: 'Workspace command', summary: 'Run non-interactive shell commands.', parent: 'workspace.execute', activation: 'loadable', agentDependency: true },
  { id: 'workspace.execute.session', title: 'Workspace process session', summary: 'Manage persistent processes and interactive command-line sessions.', parent: 'workspace.execute', activation: 'loadable', agentDependency: true },
  { id: 'workspace.artifact', title: 'Workspace artifact', summary: 'Create and visually inspect interactive HTML artifacts.', parent: 'workspace', activation: 'loadable', agentDependency: true },
  { id: 'office', title: 'Office', summary: 'Create, read, edit, render, and review PDF, Word, Excel, and PowerPoint files.', activation: 'loadable', agentDependency: true },
  { id: 'office.word', title: 'Word', summary: 'Create, inspect, edit, and review DOCX files.', parent: 'office', activation: 'loadable', agentDependency: true },
  { id: 'office.spreadsheet', title: 'Spreadsheet', summary: 'Create, inspect, edit, and review XLSX files.', parent: 'office', activation: 'loadable', agentDependency: true },
  { id: 'office.presentation', title: 'Presentation', summary: 'Create, inspect, edit, and review PPTX files.', parent: 'office', activation: 'loadable', agentDependency: true },
  { id: 'office.pdf', title: 'PDF', summary: 'Create, edit, and render PDF files.', parent: 'office', activation: 'loadable', agentDependency: true },
  { id: 'library', title: 'Library', summary: 'List, search, and read the user Library.', activation: 'loadable', agentDependency: true },
  { id: 'web', title: 'Web', summary: 'Search the web and fetch web pages.', activation: 'loadable', agentDependency: true },
  { id: 'media', title: 'Media', summary: 'Generate images, video, and speech or use an owned Studio runtime.', activation: 'loadable', agentDependency: true },
  { id: 'media.image', title: 'Image media', summary: 'Generate images or use the ImageStudio-owned runtime.', parent: 'media', activation: 'loadable', agentDependency: true },
  { id: 'media.video', title: 'Video media', summary: 'Generate or edit video or use the VideoStudio-owned runtime.', parent: 'media', activation: 'loadable', agentDependency: true },
  { id: 'media.speech', title: 'Speech media', summary: 'Generate speech audio.', parent: 'media', activation: 'loadable', agentDependency: true },
  { id: 'connectors', title: 'Connectors', summary: 'Discover and call enabled third-party connector actions.', activation: 'loadable', agentDependency: true },
  { id: 'context', title: 'Context', summary: 'Conversation, plan, memory, and project context managed by the host.', activation: 'host-managed', agentDependency: false },
  { id: 'orchestration', title: 'Orchestration', summary: 'Commander delegation, handoff, and anonymous worker controls.', activation: 'host-managed', agentDependency: false },
  { id: 'management', title: 'Management', summary: 'App support, Skill, marketplace, and automation management controls.', activation: 'loadable', agentDependency: false },
  { id: 'management.app', title: 'App support', summary: 'Navigate supported Orkas screens and inspect sanitized app health.', parent: 'management', activation: 'loadable', agentDependency: false },
  { id: 'management.skills', title: 'Skill management', summary: 'Discover global-folder Skills or import a user-requested Skill package.', parent: 'management', activation: 'loadable', agentDependency: false },
  { id: 'management.marketplace', title: 'Marketplace management', summary: 'Search the Marketplace and request a confirmed installation.', parent: 'management', activation: 'loadable', agentDependency: false },
  { id: 'management.automation', title: 'Automation management', summary: 'Inspect scheduled and recurring automation tasks.', parent: 'management', activation: 'loadable', agentDependency: false },
  { id: 'runtime', title: 'Runtime', summary: 'Tool-surface, learned-skill, and oversized-result runtime controls.', activation: 'host-managed', agentDependency: false },
] as const;

export const LOADABLE_TOOL_GROUP_IDS: readonly ToolGroupId[] = TOOL_GROUPS
  .filter((group) => group.activation === 'loadable')
  .map((group) => group.id);

export const AGENT_DEPENDENCY_TOOL_GROUP_IDS: readonly ToolGroupId[] = TOOL_GROUPS
  .filter((group) => group.agentDependency)
  .map((group) => group.id);

/** Lowest-privilege groups a named Agent may activate as a turn-local
 * fallback. Persisted Agent dependencies may still use parent groups; the
 * fallback surface intentionally cannot turn one request into a broad parent
 * expansion. */
export const AGENT_FALLBACK_TOOL_GROUP_IDS: readonly ToolGroupId[] = TOOL_GROUPS
  .filter((group) => (
    group.agentDependency
    && !TOOL_GROUPS.some((child) => child.parent === group.id && child.agentDependency)
  ))
  .map((group) => group.id);

export const TOOL_GROUP_ALIASES: Readonly<Record<string, ToolGroupId>> = Object.freeze({
  fs: 'workspace',
  shell: 'workspace.execute',
  pdf: 'office.pdf',
  kb: 'library',
  image: 'media',
  video: 'media',
  connector: 'connectors',
});

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: 'read_files', loadGroups: ['workspace.read'], summary: 'Read one or more files, ranges, images, or prepared document metadata.' },
  { name: 'list_files', loadGroups: ['workspace.read'], summary: 'List the workspace directory tree.' },
  { name: 'ocr_file', loadGroups: ['workspace.read'], summary: 'OCR PDF pages or image files.' },
  { name: 'search_files', loadGroups: ['workspace.read'], summary: 'Find files by name or glob.' },
  { name: 'grep_files', loadGroups: ['workspace.read'], summary: 'Search text across workspace and attachment files.' },

  { name: 'write_file', loadGroups: ['workspace.write.output'], permission: 'localExec', summary: 'Write a text file.' },
  { name: 'append_file', loadGroups: ['workspace.write.output'], permission: 'localExec', summary: 'Append a checked chunk to a text file.' },
  { name: 'publish_outputs', loadGroups: ['workspace.write.output'], summary: 'Declare final file deliverables for the turn.' },
  { name: 'apply_patch', loadGroups: ['workspace.write.edit'], permission: 'localExec', summary: 'Apply a transactional multi-file patch.' },
  { name: 'edit_file', loadGroups: ['workspace.write.edit'], permission: 'localExec', summary: 'Replace exact text in an existing file.' },
  { name: 'delete_file', loadGroups: ['workspace.write.edit'], permission: 'localExec', summary: 'Delete one file, requesting confirmation only outside the active workspace scope.' },
  { name: 'workspace_diff', loadGroups: ['workspace.write.edit'], summary: 'Read observed workspace changes.' },

  { name: 'bash', loadGroups: ['workspace.execute.command'], permission: 'localExec', summary: 'Run a shell command.' },
  { name: 'process_session', loadGroups: ['workspace.execute.session'], permission: 'localExec', summary: 'Manage a persistent process session.' },
  { name: 'interactive_cli', loadGroups: ['workspace.execute.session'], permission: 'localExec', summary: 'Manage a live user-input CLI session.' },
  { name: 'create_artifact', loadGroups: ['workspace.artifact'], permission: 'localExec', summary: 'Build an interactive HTML/CSS/JS artifact.' },
  { name: 'html_preview', loadGroups: ['workspace.artifact'], permission: 'localExec', summary: 'Audit local HTML at desktop or mobile targets.' },

  { name: 'create_pdf', loadGroups: ['office.pdf'], permission: 'localExec', summary: 'Create a PDF from Markdown or HTML.' },
  { name: 'edit_pdf', loadGroups: ['office.pdf'], permission: 'localExec', summary: 'Edit PDF pages, overlays, watermarks, and forms.' },
  { name: 'pdf_render', loadGroups: ['office.pdf'], permission: 'localExec', summary: 'Render a PDF page for visual review.' },
  { name: 'create_docx', loadGroups: ['office.word'], permission: 'localExec', summary: 'Create a Word document.' },
  { name: 'create_xlsx', loadGroups: ['office.spreadsheet'], permission: 'localExec', summary: 'Create an Excel workbook.' },
  { name: 'create_pptx', loadGroups: ['office.presentation'], permission: 'localExec', summary: 'Create a PowerPoint deck.' },
  { name: 'office_read', loadGroups: ['office.word', 'office.spreadsheet', 'office.presentation'], permission: 'localExec', summary: 'Inspect an Office document with editable paths.' },
  { name: 'edit_office', loadGroups: ['office.word', 'office.spreadsheet', 'office.presentation'], permission: 'localExec', summary: 'Edit an existing Word, Excel, or PowerPoint file; optionally returns a first-page PNG with preview:true.' },
  { name: 'office_review', loadGroups: ['office.word', 'office.spreadsheet', 'office.presentation'], permission: 'localExec', summary: 'Validate and render an Office file for review.' },

  { name: 'library', loadGroups: ['library'], summary: 'List, search, or read the user Library.' },
  { name: 'web_search', loadGroups: ['web'], summary: 'Search the web.' },
  { name: 'web_fetch', loadGroups: ['web'], summary: 'Fetch the body of a URL.' },

  { name: 'generate_image', loadGroups: ['media.image'], permission: 'localExec', summary: 'Generate an image into the workspace.' },
  { name: 'image_studio', loadGroups: ['media.image'], permission: 'localExec', ownerAgent: IMAGE_STUDIO_AGENT_ID, summary: 'ImageStudio-owned QA and export runtime.' },
  { name: 'generate_video', loadGroups: ['media.video'], permission: 'localExec', summary: 'Generate or edit a short video into the workspace.' },
  { name: 'video_studio', loadGroups: ['media.video'], permission: 'localExec', ownerAgent: VIDEO_STUDIO_AGENT_ID, summary: 'VideoStudio-owned production runtime.' },
  { name: 'generate_speech', loadGroups: ['media.speech'], permission: 'localExec', summary: 'Generate speech audio.' },

  { name: 'list_connector_tools', loadGroups: ['connectors'], summary: 'List actions exposed by one connector.' },
  { name: 'call_connector_tool', loadGroups: ['connectors'], summary: 'Call an action on an enabled connector.' },
  { name: 'add_custom_connector', loadGroups: ['connectors'], agentAssignable: false, summary: 'Commander-only custom MCP installation request.' },

  { name: 'chat_history', loadGroups: ['context'], summary: 'Search or read prior conversation messages.' },
  { name: 'manage_execution_plan', loadGroups: ['context'], summary: 'Manage the durable current-task execution plan.' },
  { name: 'cross_session_memory', loadGroups: ['context'], summary: 'Read or update cross-session memory.' },
  { name: 'metacognition', loadGroups: ['context'], summary: 'Read or update agent competence and strategies.' },
  { name: 'project_instructions', loadGroups: ['context'], summary: 'Update project standing instructions.' },
  { name: 'project_tasks', loadGroups: ['context'], summary: 'Read or update the project task backlog.' },

  { name: 'dispatch_to', loadGroups: ['orchestration'], summary: 'Delegate visible work and continue the commander turn.' },
  { name: 'hand_off_to', loadGroups: ['orchestration'], summary: 'Transfer terminal ownership to another Agent.' },
  { name: 'run_worker', loadGroups: ['orchestration'], summary: 'Run an anonymous private worker.' },

  { name: 'skill_search', loadGroups: ['management.skills'], summary: 'Search available global-folder skills.' },
  { name: 'import_skill_package', loadGroups: ['management.skills'], summary: 'Import a user-requested skill package.' },
  { name: 'skill_manage', loadGroups: ['runtime'], summary: 'Manage an Agent-owned learned skill.' },
  { name: 'marketplace_search', loadGroups: ['management.marketplace'], summary: 'Search the marketplace.' },
  { name: 'marketplace_request_install', loadGroups: ['management.marketplace'], summary: 'Request a user-confirmed marketplace installation.' },
  { name: 'auto_tasks_list', loadGroups: ['management.automation'], summary: 'List automation tasks.' },
  { name: 'open_app_view', loadGroups: ['management.app'], summary: 'Stage a click-to-open navigation card to an app surface.' },
  { name: 'app_health', loadGroups: ['management.app'], summary: 'Read-only sanitized app diagnosis snapshot.' },

  { name: 'tool_load', loadGroups: ['runtime'], summary: 'Activate one or more loadable tool groups.' },
  { name: 'tool_result', loadGroups: ['runtime'], summary: 'Search, aggregate, or page a persisted oversized tool result.' },
] as const;

const GROUP_BY_ID = new Map(TOOL_GROUPS.map((group) => [group.id, group]));
const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));
const GROUP_ORDER = new Map(TOOL_GROUPS.map((group, index) => [group.id, index]));

export function getToolCatalogEntry(name: string): ToolCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}

export function isToolVisibleToAgent(name: string, agentId: string): boolean {
  const entry = CATALOG_BY_NAME.get(name);
  if (agentId && entry?.agentAssignable === false) return false;
  const owner = entry?.ownerAgent;
  if (!owner) return true;
  return Array.isArray(owner) ? owner.includes(agentId) : owner === agentId;
}

export function canonicalToolGroupId(value: unknown): ToolGroupId | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (GROUP_BY_ID.has(id as ToolGroupId)) return id as ToolGroupId;
  return TOOL_GROUP_ALIASES[id];
}

export function isLoadableToolGroup(id: ToolGroupId): boolean {
  return GROUP_BY_ID.get(id)?.activation === 'loadable';
}

export function isAgentDependencyToolGroup(id: ToolGroupId): boolean {
  return GROUP_BY_ID.get(id)?.agentDependency === true;
}

export function isAgentFallbackToolGroup(id: ToolGroupId): boolean {
  return AGENT_FALLBACK_TOOL_GROUP_IDS.includes(id);
}

export function expandToolGroups(values: readonly string[]): ToolGroupId[] {
  const requested = new Set<ToolGroupId>();
  for (const value of values) {
    const id = canonicalToolGroupId(value);
    if (id && isLoadableToolGroup(id)) requested.add(id);
  }
  const expanded = new Set<ToolGroupId>();
  const pending = [...requested];
  while (pending.length) {
    const id = pending.shift()!;
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const group of TOOL_GROUPS) {
      if (group.parent === id && group.activation === 'loadable') pending.push(group.id);
    }
  }
  return [...expanded].sort((a, b) => (GROUP_ORDER.get(a) ?? 999) - (GROUP_ORDER.get(b) ?? 999));
}

/** Stable minimal representation for runtime loading and persisted sidecars. */
export function canonicalizeToolGroups(values: readonly string[]): ToolGroupId[] {
  return canonicalizeGroups(values, isLoadableToolGroup);
}

/** Stable representation accepted by agent.json.tool_list and Agent Creator. */
export function canonicalizeAgentToolGroups(values: readonly string[]): ToolGroupId[] {
  return canonicalizeGroups(values, isAgentDependencyToolGroup);
}

function canonicalizeGroups(
  values: readonly string[],
  accepts: (id: ToolGroupId) => boolean,
): ToolGroupId[] {
  const ids = new Set<ToolGroupId>();
  for (const value of values) {
    const id = canonicalToolGroupId(value);
    if (id && accepts(id)) ids.add(id);
  }
  for (const id of [...ids]) {
    let parent = GROUP_BY_ID.get(id)?.parent;
    while (parent) {
      if (ids.has(parent)) {
        ids.delete(id);
        break;
      }
      parent = GROUP_BY_ID.get(parent)?.parent;
    }
  }
  return [...ids].sort((a, b) => (GROUP_ORDER.get(a) ?? 999) - (GROUP_ORDER.get(b) ?? 999));
}

export function invalidToolGroupRefs(values: readonly unknown[]): string[] {
  return invalidGroupRefs(values, isLoadableToolGroup);
}

export function invalidAgentToolGroupRefs(values: readonly unknown[]): string[] {
  return invalidGroupRefs(values, isAgentDependencyToolGroup);
}

function invalidGroupRefs(
  values: readonly unknown[],
  accepts: (id: ToolGroupId) => boolean,
): string[] {
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => !canonicalToolGroupId(value) || !accepts(canonicalToolGroupId(value)!));
}

export function toolNamesForGroups(groups: readonly string[]): string[] {
  const expanded = new Set(expandToolGroups(groups));
  return TOOL_CATALOG
    .filter((entry) => entry.loadGroups?.some((group) => expanded.has(group)))
    .map((entry) => entry.name);
}

export function toolNamesForAgentGroups(groups: readonly string[]): string[] {
  return toolNamesForGroups(groups).filter((name) => CATALOG_BY_NAME.get(name)?.agentAssignable !== false);
}

export function hostManagedToolNames(): string[] {
  return TOOL_CATALOG
    .filter((entry) => entry.loadGroups?.some((group) => GROUP_BY_ID.get(group)?.activation === 'host-managed'))
    .map((entry) => entry.name);
}

/** Compact deterministic category index; full tool schemas arrive only after activation. */
export function getLoadableToolGroupsSystemPromptBlock(input: {
  availableToolNames: readonly string[];
  /** Optional runtime allow-list supplied by ToolSurfaceController. */
  allowedGroupIds?: readonly ToolGroupId[];
  /** Runtime mode advertises `tool_load`.
   * Agent-runtime mode is the lower-privilege fallback directory for a named
   * Agent and contains only Agent-declarable groups/tools.
   * Agent-authoring mode is a schema directory only: it lets Agent Creator
   * write exact dependency ids without changing the current legacy surface. */
  purpose?: 'runtime' | 'agent-runtime' | 'agent-authoring';
}): string {
  const purpose = input.purpose ?? 'runtime';
  const available = new Set(input.availableToolNames);
  const allowedGroups = input.allowedGroupIds
    ? new Set(input.allowedGroupIds)
    : purpose === 'agent-runtime'
      ? new Set(AGENT_FALLBACK_TOOL_GROUP_IDS)
      : undefined;
  const toolAllowedForPurpose = (entry: ToolCatalogEntry): boolean => purpose === 'runtime'
    || entry.agentAssignable !== false;
  const groupHasAvailableTool = (id: ToolGroupId): boolean => TOOL_CATALOG.some(
    (entry) => toolAllowedForPurpose(entry) && available.has(entry.name) && entry.loadGroups?.includes(id),
  );
  const groupAllowedForPurpose = (group: ToolGroupEntry): boolean => (
    purpose === 'runtime' ? group.activation === 'loadable' : group.agentDependency
  );
  const groupHasAvailableToolInSubtree = (id: ToolGroupId): boolean => {
    if (groupHasAvailableTool(id)) return true;
    return TOOL_GROUPS.some((child) => (
      child.parent === id
      && groupAllowedForPurpose(child)
      && groupHasAvailableToolInSubtree(child.id)
    ));
  };
  const visible = TOOL_GROUPS.filter((group) => {
    if (!groupAllowedForPurpose(group)) return false;
    if (allowedGroups && !allowedGroups.has(group.id)) return false;
    return groupHasAvailableToolInSubtree(group.id);
  });
  if (!visible.length) return '';
  const lines = [
    purpose === 'agent-authoring' ? '## Agent tool dependencies' : '## Loadable tool groups',
    '',
    purpose !== 'agent-authoring'
      ? (purpose === 'agent-runtime'
        ? 'Fallback only: if the current tools cannot complete an in-domain request, load the smallest sufficient groups in one call. Loads last for this user turn only.'
        : 'Fallback only: use `tool_load` when the tools already shown cannot complete the task. Load all clearly needed groups in one call; choose the smallest sufficient groups, and remember that a parent loads all children. Loads last for the current user turn only. Runtime-only groups must not be written into an Agent dependency list.')
      : 'Use these exact group ids when authoring an Agent\'s built-in tool dependencies. This directory does not change the current session\'s tool surface.',
    '',
  ];
  for (const group of visible) {
    const directTools = purpose !== 'runtime'
      ? TOOL_CATALOG
        .filter((entry) => (
          entry.agentAssignable !== false
          && available.has(entry.name)
          && entry.loadGroups?.includes(group.id)
        ))
        .map((entry) => `\`${entry.name}\``)
      : [];
    if (purpose === 'agent-runtime') {
      lines.push(`- \`${group.id}\` — ${group.title}. Tools: ${directTools.join(', ')}.`);
      continue;
    }
    let depth = 0;
    let parent = group.parent;
    while (parent) {
      depth += 1;
      parent = GROUP_BY_ID.get(parent)?.parent;
    }
    const indent = '  '.repeat(depth);
    const markers = purpose === 'runtime' && !group.agentDependency
      ? ['runtime only; not an Agent dependency']
      : [];
    const status = markers.length ? ` (${markers.join('; ')})` : '';
    const members = directTools.length ? ` Tools: ${directTools.join(', ')}.` : '';
    lines.push(`${indent}- \`${group.id}\`${status} — ${group.summary}${members}`);
  }
  return lines.join('\n');
}

/** Per-turn activation state, kept out of the stable system prefix so the
 * connector, Skill, Agent, and project instruction blocks stay byte-stable
 * across ordinary rounds. Providers with native deferred-tool loading insert
 * newly activated schemas after the corresponding tool result and preserve
 * the earlier prefix. Other providers still receive the ordinary expanded
 * `tools[]` snapshot; for those providers a group's first load can rewrite the
 * provider-defined tool prefix. */
export function getActiveToolGroupsTurnBlock(groups: readonly string[]): string {
  const active = canonicalizeToolGroups(groups);
  if (!active.length) return '';
  return [
    '## Active tool groups',
    '',
    `Already active; do not call \`tool_load\` for these groups: ${active.map((id) => `\`${id}\``).join(', ')}.`,
  ].join('\n');
}
