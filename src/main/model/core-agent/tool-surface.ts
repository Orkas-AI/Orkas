import type { AgentTool, ToolResult, ToolSurfaceState } from '#core-agent';
import {
  AGENT_FALLBACK_TOOL_GROUP_IDS,
  LOADABLE_TOOL_GROUP_IDS,
  TOOL_CATALOG,
  canonicalToolGroupId,
  canonicalizeAgentToolGroups,
  canonicalizeToolGroups,
  expandToolGroups,
  hostManagedToolNames,
  isAgentFallbackToolGroup,
  isLoadableToolGroup,
  toolNamesForGroups,
  type ToolGroupId,
} from './tool-catalog';
import { TOOL_CATALOG_REVISION } from './tool-catalog-revision';

/** Stamped into the persisted sidecar for eval evidence, not for runtime:
 * production-regression contracts pin captured tool-surface evidence to the
 * catalog revision it ran against (a drift ratchet — bumping the catalog
 * forces those contracts red until evidence is re-reviewed), and the
 * migration scenarios encode older revisions. Runtime never uses the value
 * to activate tools: v3 dynamic groups are turn-local and durable groups stay
 * empty. Reviewed 2026-08-16 (F-13): keep. */
export { TOOL_CATALOG_REVISION } from './tool-catalog-revision';

export type ToolLoadingMode = 'legacy' | 'scoped';

export function configuredToolLoadingMode(): ToolLoadingMode {
  // Scoped is the production default for eligible new sessions. Operators can
  // still force the old full surface while rolling back an incident; existing
  // conversations are separately preserved as legacy_all below.
  return process.env.ORKAS_TOOL_LOADING_MODE === 'legacy' ? 'legacy' : 'scoped';
}

export interface ToolSurfaceController {
  readonly mode: 'scoped' | 'legacy_all';
  /** Whether this actor may expand its surface during the session. */
  readonly dynamicLoading: boolean;
  readonly dynamicLoadPolicy: 'loadable' | 'agent-dependency';
  isActive(name: string): boolean;
  activeToolNames(): string[];
  loadedGroups(): ToolGroupId[];
  /** Groups this actor may load in this runtime, after policy and actual
   * tool-availability filtering. This is the single source for the prompt,
   * tool schema, and execute-time validation. */
  loadableGroups(): ToolGroupId[];
  runtimeStats(): {
    loadCalls: number;
    newlyLoadedGroups: ToolGroupId[];
    /** Tools that became active specifically because of successful
     * model-triggered tool_load calls. Host runtime grants are excluded. */
    newlyActivatedToolNames: string[];
  };
  load(groups: readonly unknown[]): ToolResult;
}

export function createToolSurfaceController(input: {
  availableToolNames: readonly string[];
  /** Tools eligible for model-triggered fallback loading. Defaults to every
   * available executor. Hosts may retain a broader dormant executor set for
   * explicit runtime grants without advertising those tools to tool_load. */
  dynamicLoadableToolNames?: readonly string[];
  configuredGroups?: readonly string[];
  hostPreloadGroups?: readonly string[];
  /** Mutable, host-owned current-turn grants. Trusted ingress may extend this
   * array after construction when the user explicitly selects a capability
   * such as a Connector; this path takes precedence over Agent fallback load. */
  runtimeGrantedGroups?: readonly string[];
  hostRequiredToolNames?: readonly string[];
  restoredState?: ToolSurfaceState;
  preserveLegacySession?: boolean;
  scopedEligible: boolean;
  /** Fixed actors use only configured + host groups. They ignore restored
   * dynamic groups and cannot be widened by the legacy rollback switch. */
  dynamicLoading?: boolean;
  /** Commander may load every loadable group. Named Agents use the narrower
   * Agent-dependency policy so fallback loading cannot reach management or
   * runtime-only capabilities. */
  dynamicLoadPolicy?: 'loadable' | 'agent-dependency';
  /** The legacy-all rollback is Commander-only. A named Agent keeps its
   * authored baseline even when the global rollback switch is set. */
  allowLegacyAll?: boolean;
  persist?: (state: ToolSurfaceState) => void;
}): ToolSurfaceController {
  const available = new Set(input.availableToolNames);
  const dynamicLoadable = new Set(
    (input.dynamicLoadableToolNames ?? input.availableToolNames)
      .filter((name) => available.has(name)),
  );
  const dynamicLoading = input.dynamicLoading !== false;
  const allowLegacyAll = input.allowLegacyAll !== false;
  const dynamicLoadPolicy = input.dynamicLoadPolicy ?? 'loadable';
  const acceptsDynamicGroup = (id: ToolGroupId): boolean => (
    dynamicLoadPolicy === 'agent-dependency'
      ? isAgentFallbackToolGroup(id)
      : isLoadableToolGroup(id)
  );
  const legacy = !input.scopedEligible || (dynamicLoading && allowLegacyAll && (
    configuredToolLoadingMode() === 'legacy'
    || input.restoredState?.mode === 'legacy_all'
    || input.preserveLegacySession === true
  ));

  if (legacy) {
    return {
      mode: 'legacy_all',
      dynamicLoading: false,
      dynamicLoadPolicy,
      isActive: (name) => available.has(name),
      activeToolNames: () => [...available],
      loadedGroups: () => [...LOADABLE_TOOL_GROUP_IDS],
      loadableGroups: () => [],
      runtimeStats: () => ({
        loadCalls: 0,
        newlyLoadedGroups: [],
        newlyActivatedToolNames: [],
      }),
      load: () => ({ content: JSON.stringify({ ok: true, mode: 'legacy_all', already_loaded: ['all'] }) }),
    };
  }

  const required = new Set([
    ...hostManagedToolNames(),
    ...(input.hostRequiredToolNames ?? []),
  ].filter((name) => available.has(name)));
  // Persisted Agent dependencies accept only authorable groups. Host policy
  // may still preload runtime-only groups for a specialized execution path.
  const configuredGroupRefs = canonicalizeAgentToolGroups(input.configuredGroups ?? []);
  const hostPreloadGroupRefs = canonicalizeToolGroups(input.hostPreloadGroups ?? []);
  // Dynamic loads are deliberately scoped to this controller, which is built
  // once per user turn. Persisted v1/v2 groups are ignored so an optional tool
  // must be selected again on a later turn.
  const dynamicGroupCandidates = dynamicLoadPolicy === 'agent-dependency'
    ? AGENT_FALLBACK_TOOL_GROUP_IDS
    : LOADABLE_TOOL_GROUP_IDS;
  const availableDynamicGroupRefs = dynamicGroupCandidates.filter((group) => (
    toolNamesForGroups([group]).some((name) => dynamicLoadable.has(name))
  ));
  const availableDynamicGroups = new Set(availableDynamicGroupRefs);
  let turnLoadedGroupRefs: ToolGroupId[] = [];
  let loadCalls = 0;
  const toolLoadActivatedToolNames = new Set<string>();
  let runtimeGrantedGroupsKey = JSON.stringify(input.runtimeGrantedGroups ?? []);
  let runtimeGrantedGroupRefs = canonicalizeAgentToolGroups(input.runtimeGrantedGroups ?? []);
  const computeEffectiveGroupRefs = (): ToolGroupId[] => canonicalizeToolGroups([
    ...configuredGroupRefs,
    ...hostPreloadGroupRefs,
    // User-selected runtime grants may expand only Agent-authorable groups;
    // malformed or host/runtime-only values never become capabilities.
    ...runtimeGrantedGroupRefs,
    ...turnLoadedGroupRefs,
  ]);
  const computeModelBaselineGroupRefs = (): ToolGroupId[] => canonicalizeToolGroups([
    ...configuredGroupRefs,
    ...hostPreloadGroupRefs,
  ]);
  let effectiveGroupRefs = computeEffectiveGroupRefs();
  let active = recomputeActive(
    available,
    dynamicLoadable,
    required,
    computeModelBaselineGroupRefs(),
    runtimeGrantedGroupRefs,
    turnLoadedGroupRefs,
  );
  const refreshRuntimeGrants = (): void => {
    const key = JSON.stringify(input.runtimeGrantedGroups ?? []);
    if (key === runtimeGrantedGroupsKey) return;
    runtimeGrantedGroupsKey = key;
    runtimeGrantedGroupRefs = canonicalizeAgentToolGroups(input.runtimeGrantedGroups ?? []);
    effectiveGroupRefs = computeEffectiveGroupRefs();
    active = recomputeActive(
      available,
      dynamicLoadable,
      required,
      computeModelBaselineGroupRefs(),
      runtimeGrantedGroupRefs,
      turnLoadedGroupRefs,
    );
  };

  const durableState: ToolSurfaceState = {
    version: 3,
    mode: 'scoped',
    loadedGroups: [],
    catalogRevision: TOOL_CATALOG_REVISION,
  };
  const restoredAlreadyCurrent = input.restoredState?.version === durableState.version
    && input.restoredState.mode === durableState.mode
    && input.restoredState.catalogRevision === durableState.catalogRevision
    && input.restoredState.loadedGroups.length === 0;

  // Establish or migrate the durable marker once. Rebuilding an unchanged
  // runner must not synchronously rewrite the same sidecar every turn.
  if (!restoredAlreadyCurrent) input.persist?.(durableState);

  return {
    mode: 'scoped',
    dynamicLoading,
    dynamicLoadPolicy,
    isActive: (name) => {
      refreshRuntimeGrants();
      return active.has(name);
    },
    activeToolNames: () => {
      refreshRuntimeGrants();
      return [...active];
    },
    loadedGroups: () => {
      refreshRuntimeGrants();
      return [...effectiveGroupRefs];
    },
    loadableGroups: () => dynamicLoading ? [...availableDynamicGroupRefs] : [],
    runtimeStats: () => ({
      loadCalls,
      newlyLoadedGroups: [...turnLoadedGroupRefs],
      newlyActivatedToolNames: [...toolLoadActivatedToolNames],
    }),
    load(groups) {
      refreshRuntimeGrants();
      const activeBeforeLoad = new Set(active);
      loadCalls += 1;
      if (!dynamicLoading) {
        return {
          content: JSON.stringify({ ok: false, error: 'E_TOOL_LOADING_DISABLED' }),
          isError: true,
        };
      }
      if (groups.length > 8) {
        return {
          content: JSON.stringify({ ok: false, error: 'E_TOOL_GROUP_LIMIT', max_groups: 8 }),
          isError: true,
        };
      }
      const requested: ToolGroupId[] = [];
      const unavailable: string[] = [];
      const seen = new Set<ToolGroupId>();
      const duplicates = new Set<string>();
      for (const raw of groups) {
        const id = canonicalToolGroupId(raw);
        if (!id || !acceptsDynamicGroup(id) || !availableDynamicGroups.has(id)) {
          unavailable.push(typeof raw === 'string' ? raw : '<invalid>');
          continue;
        }
        if (seen.has(id)) {
          duplicates.add(id);
          continue;
        }
        seen.add(id);
        requested.push(id);
      }
      if (duplicates.size) {
        return {
          content: JSON.stringify({
            ok: false,
            error: 'E_TOOL_GROUP_DUPLICATE',
            duplicates: [...duplicates],
          }),
          isError: true,
        };
      }
      if (!requested.length) {
        return {
          content: JSON.stringify({ ok: false, error: 'E_TOOL_GROUP_INVALID', unavailable }),
          isError: true,
        };
      }
      const beforeExpanded = new Set(expandToolGroups(effectiveGroupRefs));
      const requestedCanonical = canonicalizeToolGroups(requested);
      const eligibleRequested = requestedCanonical;
      const newlyLoaded = eligibleRequested.filter((group) => !beforeExpanded.has(group));
      const alreadyLoaded = eligibleRequested.filter((group) => beforeExpanded.has(group));
      if (newlyLoaded.length) {
        turnLoadedGroupRefs = canonicalizeToolGroups([
          ...turnLoadedGroupRefs,
          ...newlyLoaded,
        ]);
        effectiveGroupRefs = computeEffectiveGroupRefs();
        active = recomputeActive(
          available,
          dynamicLoadable,
          required,
          computeModelBaselineGroupRefs(),
          runtimeGrantedGroupRefs,
          turnLoadedGroupRefs,
        );
        for (const name of active) {
          if (!activeBeforeLoad.has(name)) toolLoadActivatedToolNames.add(name);
        }
      }
      return {
        content: JSON.stringify({
          ok: unavailable.length === 0,
          newly_loaded: newlyLoaded,
          already_loaded: alreadyLoaded,
          unavailable,
          activated_tools: active.size,
        }),
        ...(unavailable.length && !eligibleRequested.length ? { isError: true } : {}),
      };
    },
  };
}

function recomputeActive(
  available: ReadonlySet<string>,
  dynamicLoadable: ReadonlySet<string>,
  required: ReadonlySet<string>,
  modelBaselineGroups: readonly string[],
  runtimeGrantedGroups: readonly string[],
  turnLoadedGroups: readonly string[],
): Set<string> {
  const active = new Set<string>();
  for (const name of required) if (available.has(name)) active.add(name);
  for (const name of toolNamesForGroups(modelBaselineGroups)) {
    if (dynamicLoadable.has(name)) active.add(name);
  }
  // Runtime grants originate from an accepted host/user selection and may
  // activate an executor intentionally retained outside model fallback.
  for (const name of toolNamesForGroups(runtimeGrantedGroups)) {
    if (available.has(name)) active.add(name);
  }
  for (const name of toolNamesForGroups(turnLoadedGroups)) {
    if (dynamicLoadable.has(name)) active.add(name);
  }
  return active;
}

export function createToolLoadTool(
  controller: ToolSurfaceController,
  options: {
    /** Bounded host context that lets the model use a group immediately after loading it. */
    contextByGroup?: Partial<Record<ToolGroupId, string>>;
  } = {},
): AgentTool {
  const policy = controller.dynamicLoadPolicy;
  const allowedGroups = controller.loadableGroups();
  const description = policy === 'agent-dependency'
    ? 'Fallback only for an in-domain request: activate missing Agent-dependency tool groups for this user turn. This does not expand the Agent domain or execution permissions. Include every clearly needed group in one call.'
    : 'Fallback only: activate missing built-in tool groups for the current user turn when active tools cannot complete the request. Include every clearly needed group in one call. Loading never grants execution permissions.';
  return {
    name: 'tool_load',
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groups: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string', enum: [...allowedGroups] },
          description: 'Exact loadable group ids from this enum.',
        },
      },
      required: ['groups'],
    },
    async execute(raw) {
      const groups = Array.isArray(raw?.groups) ? raw.groups : [];
      const result = controller.load(groups);
      if (result.isError || !options.contextByGroup || typeof result.content !== 'string') {
        return result;
      }
      const activeGroups = new Set(expandToolGroups(controller.loadedGroups()));
      const loadedGroupContext: Partial<Record<ToolGroupId, string>> = {};
      for (const rawGroup of groups) {
        const group = canonicalToolGroupId(rawGroup);
        const context = group ? options.contextByGroup[group]?.trim() : '';
        if (group && context && activeGroups.has(group)) loadedGroupContext[group] = context;
      }
      if (!Object.keys(loadedGroupContext).length) return result;
      try {
        const receipt = JSON.parse(result.content) as Record<string, unknown>;
        return {
          ...result,
          content: JSON.stringify({
            ...receipt,
            loaded_group_context: loadedGroupContext,
          }),
        };
      } catch {
        // Controller receipts are JSON by contract. Preserve the original
        // result if a future controller implementation violates that shape.
        return result;
      }
    },
  };
}

export function catalogedToolNames(): string[] {
  return TOOL_CATALOG.map((entry) => entry.name);
}
