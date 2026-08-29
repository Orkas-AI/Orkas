/**
 * Read-only app-health probes for the Commander `app_health` tool.
 *
 * Every probe is side-effect free and sanitized: status kinds, counts, ids,
 * and already-localized user-facing messages only — never credentials, base
 * URLs, file paths, or free-form provider error text. The `tasks` probe is
 * injected by the bus (its running-state maps live there) to avoid an import
 * cycle. A probe failure degrades to an `unavailable` marker instead of
 * failing the whole snapshot.
 */

import * as auth from '../auth';
import * as connectorManager from '../connectors/manager';
import { isConnectorRuntimeEnabled } from '../connectors/availability';
import { isConnectorUsable } from '../connectors/types';
import {
  isConnectorEnabledFromSnapshot,
  readEnabledMap,
} from '../component_enabled';
import * as kbVector from '../kb_vector';

export type AppHealthDomain = 'model' | 'connectors' | 'kb' | 'tasks';
export const APP_HEALTH_DOMAINS: readonly AppHealthDomain[] = ['model', 'connectors', 'kb', 'tasks'];

export function isAppHealthDomain(value: string): value is AppHealthDomain {
  return (APP_HEALTH_DOMAINS as readonly string[]).includes(value);
}

export interface AppHealthTasksProbe {
  active_work: boolean;
  active_conversation_count: number;
  other_active_conversation_count: number;
  current_conversation: {
    processing: boolean;
    in_flight_actor_count: number;
    active_turn_count: number;
  };
}

const CONNECTOR_ITEM_CAP = 20;

async function modelProbe(): Promise<Record<string, unknown>> {
  const configured = auth.hasConfiguredModel().configured;
  const cfg = await auth.getConfig();
  const cooldown = auth.getConfiguredModelCooldown();
  return {
    configured,
    default_provider: cfg.provider || null,
    default_model: cfg.model || null,
    // `kind` is the bounded failure classification; the free-form reason and
    // profile label are deliberately dropped.
    credential_cooldown: cooldown
      ? {
        kind: String(cooldown.kind),
        seconds_remaining: Math.max(0, Math.ceil((cooldown.cooledUntil - Date.now()) / 1000)),
      }
      : null,
    // Already a localized, sanitized user-facing sentence (or null).
    oauth_expired: auth.getConfiguredModelOAuthExpiredMessage(),
  };
}

async function connectorsProbe(uid: string): Promise<Record<string, unknown>> {
  const instances = connectorManager.listInstances(uid);
  const enabledSnapshot = readEnabledMap(uid);
  const items = instances.map((instance) => {
    const enabled = isConnectorRuntimeEnabled(instance.id)
      && isConnectorEnabledFromSnapshot(enabledSnapshot, instance.id);
    return {
      id: instance.id,
      name: instance.display_name,
      status: String(instance.status?.kind || 'unknown'),
      enabled,
      usable: enabled && isConnectorUsable(instance.status),
    };
  });
  return {
    configured_count: items.length,
    connected_count: items.filter((item) => item.enabled && item.status === 'connected').length,
    usable_count: items.filter((item) => item.usable).length,
    items: items.slice(0, CONNECTOR_ITEM_CAP),
  };
}

export async function collectAppHealth(
  uid: string,
  domains: readonly AppHealthDomain[],
  tasksProbe: () => AppHealthTasksProbe,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const domain of domains) {
    try {
      if (domain === 'model') out.model = await modelProbe();
      else if (domain === 'connectors') out.connectors = await connectorsProbe(uid);
      else if (domain === 'kb') out.kb = kbVector.statusSummary(uid);
      else if (domain === 'tasks') out.tasks = tasksProbe();
    } catch {
      out[domain] = { unavailable: true };
    }
  }
  return out;
}
