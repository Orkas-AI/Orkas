/**
 * Commander-navigable app surfaces for `open_app_view` and setup tools.
 *
 * The tool stages a navigation card on the commander's reply; the renderer
 * executes the navigation only when the user clicks the card, so this
 * registry carries no side effects — it is the single source of truth for
 * which surfaces exist and what the tool schema advertises. The renderer's
 * executor map (conversation.js) must cover exactly these ids;
 * `test/main/features/group_chat/app-nav-registry.test.ts` pins that parity.
 */

export type AppNavAction = 'open' | 'create' | 'add_custom' | 'configure';

export interface AppNavSurface {
  id: string;
  /** Review-facing one-liner; the model schema receives the compact matrix. */
  summary: string;
  /** Closed actions supported by this surface. `open` is the default. */
  actions: readonly AppNavAction[];
  /** Actions that require a stable business id resolved by the renderer. */
  targetRequiredFor?: readonly AppNavAction[];
}

export const APP_NAV_SURFACES: readonly AppNavSurface[] = [
  { id: 'settings.models', summary: 'Settings → Models: model providers, API keys, priority order, connection tests.', actions: ['open'] },
  { id: 'settings.general', summary: 'Settings → General: interface language and app preferences.', actions: ['open'] },
  { id: 'settings.data', summary: 'Settings → Data: local data and access permissions.', actions: ['open'] },
  {
    id: 'connectors',
    summary: 'Connectors: open the catalog or add a custom MCP server. The configure action remains a navigation compatibility route; connector_setup owns guided built-in setup.',
    actions: ['open', 'add_custom', 'configure'],
    targetRequiredFor: ['configure'],
  },
  { id: 'library', summary: 'Library: durable documents imported for retrieval.', actions: ['open'] },
  {
    id: 'projects',
    summary: 'Projects: focus the sidebar list, start creation, or open one existing Project by id.',
    actions: ['open', 'create', 'configure'],
    targetRequiredFor: ['configure'],
  },
  {
    id: 'agents',
    summary: 'AI Team: open installed Agents, start creation, or open one Agent by id.',
    actions: ['open', 'create', 'configure'],
    targetRequiredFor: ['configure'],
  },
  { id: 'skills', summary: 'Skills: open installed Skills or start Skill creation.', actions: ['open', 'create'] },
  {
    id: 'auto',
    summary: 'Automation: open scheduled tasks, start creation, or edit one task by id.',
    actions: ['open', 'create', 'configure'],
    targetRequiredFor: ['configure'],
  },
  { id: 'apps', summary: 'My Apps: saved interactive results that can be launched again.', actions: ['open'] },
  { id: 'marketplace', summary: 'Marketplace: installable Agents and Skills.', actions: ['open'] },
];

export const APP_NAV_ACTIONS: readonly AppNavAction[] = Array.from(new Set(
  APP_NAV_SURFACES.flatMap((surface) => surface.actions),
));

export function findAppNavSurface(id: string): AppNavSurface | null {
  return APP_NAV_SURFACES.find((s) => s.id === id) ?? null;
}

export function appNavSurfaceDescription(): string {
  const idsByActionSet = new Map<string, string[]>();
  for (const surface of APP_NAV_SURFACES) {
    const actionSet = surface.actions.join('|');
    const ids = idsByActionSet.get(actionSet) ?? [];
    ids.push(surface.id);
    idsByActionSet.set(actionSet, ids);
  }
  return `Actions: ${[...idsByActionSet.entries()]
    .map(([actions, ids]) => `${ids.join(', ')}=${actions}`)
    .join(';')}.`;
}

export function validateAppNavRequest(input: {
  surface_id: string;
  action?: string;
  target_id?: string;
}): { ok: true; request: Omit<AppNavRequest, 'requested_at'> } | { ok: false; error: string } {
  const surface = findAppNavSurface(input.surface_id);
  if (!surface) return { ok: false, error: `unknown surface_id: ${input.surface_id || '(empty)'}` };
  const action = (input.action || 'open') as AppNavAction;
  if (!surface.actions.includes(action)) {
    return { ok: false, error: `action ${action} is not supported for ${surface.id}; allowed: ${surface.actions.join(', ')}` };
  }
  const targetId = String(input.target_id || '').trim();
  if (targetId.length > 160 || /[\u0000-\u001f\u007f]/.test(targetId)) {
    return { ok: false, error: 'target_id must be a bounded printable identifier' };
  }
  const requiresTarget = surface.targetRequiredFor?.includes(action) === true;
  if (requiresTarget && !targetId) {
    return { ok: false, error: `target_id is required for ${surface.id}/${action}` };
  }
  if (!requiresTarget && targetId) {
    if (surface.actions.includes('configure')) {
      return {
        ok: false,
        error: `target_id requires action configure for ${surface.id}; retry with action configure and the same target_id`,
      };
    }
    return { ok: false, error: `target_id is not supported for ${surface.id}/${action}` };
  }
  return {
    ok: true,
    request: {
      surface_id: surface.id,
      action,
      ...(targetId ? { target_id: targetId } : {}),
    },
  };
}

/** One staged navigation card (GroupMessage.app_nav_requests entry). */
export interface AppNavRequest {
  surface_id: string;
  action: AppNavAction;
  target_id?: string;
  requested_at: string;
}
