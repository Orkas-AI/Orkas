/**
 * Commander runtime statistics.
 *
 * The commander is a built-in orchestration role, not an installable agent, so
 * its counters live outside `cloud/agents/` while reusing the same per-device
 * merge-friendly file format as agent runtime stats.
 */

import { commanderRuntimeStatsFile } from '../paths';
import { getActiveUserId } from './users';
import { getCurrentDevice } from '../util/device';
import { nowIso, readJson, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import {
  normalizeAgentRuntimeStatsFile,
  recordAgentRuntimeStatsForDevice,
  type AgentRuntimeStatsFile,
} from './agent_runtime_stats';

export type CommanderRuntimeStats = AgentRuntimeStatsFile;

function markCommanderRuntimeStatsDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('commander', 'cloud/commander/runtime_stats.json');
  } catch { /* features/sync stripped */ }
}

function statsHasData(stats: AgentRuntimeStatsFile): boolean {
  return !!(
    stats.attempts
    || stats.successes
    || stats.deliveries
    || stats.failures
    || stats.errors
    || stats.total_duration_ms
    || stats.successful_duration_ms
    || stats.updated_at
  );
}

export async function readCommanderRuntimeStats(userId = getActiveUserId()): Promise<CommanderRuntimeStats | undefined> {
  const raw = await readJson(commanderRuntimeStatsFile(userId));
  const stats = normalizeAgentRuntimeStatsFile(raw);
  return statsHasData(stats) ? stats : undefined;
}

export async function recordCommanderRuntimeStats(
  result: { duration_ms?: unknown; durationMs?: unknown; success?: unknown; aborted?: unknown; errored?: unknown; status?: unknown } = {},
  userId = getActiveUserId(),
): Promise<{ ok: boolean; stats: CommanderRuntimeStats }> {
  const file = commanderRuntimeStatsFile(userId);
  // Unlike per-agent stats (sharded per agent file), every commander turn for a
  // user — across all their conversations — writes this one file. Serialize the
  // read-modify-write so concurrent turns don't lose each other's increment.
  const statsFile = await fileEditLock(file).runExclusive(async () => {
    const raw = await readJson(file);
    const device = getCurrentDevice();
    const next = recordAgentRuntimeStatsForDevice(raw, device.id || device.name, result, nowIso());
    await writeJson(file, next);
    return next;
  });
  markCommanderRuntimeStatsDirty();
  return { ok: true, stats: statsFile };
}
