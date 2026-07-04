export interface AgentRuntimeStatsBucket {
  attempts: number;
  successes: number;
  deliveries: number;
  failures: number;
  errors: number;
  total_duration_ms: number;
  successful_duration_ms: number;
  updated_at?: string;
}

export interface AgentRuntimeStatsFile extends AgentRuntimeStatsBucket {
  version: 2;
  /**
   * Aggregate counters observed before per-device buckets existed. Kept as a
   * baseline so two devices migrating the same old total do not double-count it.
   */
  baseline: AgentRuntimeStatsBucket;
  /** Per sync-device increments written by each device after the baseline. */
  devices: Record<string, AgentRuntimeStatsBucket>;
}

const COUNTER_KEYS = [
  'attempts',
  'successes',
  'deliveries',
  'failures',
  'errors',
  'total_duration_ms',
  'successful_duration_ms',
] as const;

export type AgentRunStatus = 'success' | 'failure' | 'error';

function coerceCounter(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function cleanUpdatedAt(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 80) : undefined;
}

export function emptyAgentRuntimeStatsBucket(): AgentRuntimeStatsBucket {
  return {
    attempts: 0,
    successes: 0,
    deliveries: 0,
    failures: 0,
    errors: 0,
    total_duration_ms: 0,
    successful_duration_ms: 0,
  };
}

export function normalizeAgentRuntimeStatsBucket(raw: unknown): AgentRuntimeStatsBucket {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const bucket = emptyAgentRuntimeStatsBucket();
  for (const key of COUNTER_KEYS) bucket[key] = coerceCounter(obj[key]);
  if (!Object.prototype.hasOwnProperty.call(obj, 'successes')) {
    bucket.successes = bucket.deliveries;
  }
  const updatedAt = cleanUpdatedAt(obj.updated_at ?? obj.updatedAt);
  if (updatedAt) bucket.updated_at = updatedAt;
  return bucket;
}

function bucketHasData(bucket: AgentRuntimeStatsBucket): boolean {
  return COUNTER_KEYS.some((key) => bucket[key] > 0) || !!bucket.updated_at;
}

function addBuckets(a: AgentRuntimeStatsBucket, b: AgentRuntimeStatsBucket): AgentRuntimeStatsBucket {
  const out = emptyAgentRuntimeStatsBucket();
  for (const key of COUNTER_KEYS) out[key] = a[key] + b[key];
  out.updated_at = newerUpdatedAt(a.updated_at, b.updated_at);
  return out;
}

function maxBuckets(a: AgentRuntimeStatsBucket, b: AgentRuntimeStatsBucket): AgentRuntimeStatsBucket {
  const out = emptyAgentRuntimeStatsBucket();
  for (const key of COUNTER_KEYS) out[key] = Math.max(a[key], b[key]);
  out.updated_at = newerUpdatedAt(a.updated_at, b.updated_at);
  return out;
}

function bucketScore(bucket: AgentRuntimeStatsBucket): number {
  return bucket.attempts
    + bucket.successes
    + bucket.deliveries
    + bucket.failures
    + bucket.errors
    + bucket.total_duration_ms
    + bucket.successful_duration_ms;
}

function normalizeRunStatus(
  result: { status?: unknown; success?: unknown; aborted?: unknown; errored?: unknown } = {},
): AgentRunStatus {
  const rawStatus = typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
  if (rawStatus === 'success' || rawStatus === 'failure' || rawStatus === 'error') return rawStatus;
  if (result.aborted || result.errored) return 'error';
  if (result.success === false) return 'failure';
  return 'success';
}

function updatedAtMs(value: string | undefined): number {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function newerUpdatedAt(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return updatedAtMs(b) >= updatedAtMs(a) ? b : a;
}

function pickDeviceBucket(a: AgentRuntimeStatsBucket, b: AgentRuntimeStatsBucket): AgentRuntimeStatsBucket {
  const at = updatedAtMs(a.updated_at);
  const bt = updatedAtMs(b.updated_at);
  if (bt > at) return b;
  if (at > bt) return a;
  return bucketScore(b) >= bucketScore(a) ? b : a;
}

export function normalizeAgentRuntimeStatsFile(raw: unknown): AgentRuntimeStatsFile {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const devices: Record<string, AgentRuntimeStatsBucket> = {};
  const rawDevices = obj.devices && typeof obj.devices === 'object' && !Array.isArray(obj.devices)
    ? obj.devices as Record<string, unknown>
    : {};
  for (const [deviceId, value] of Object.entries(rawDevices)) {
    const id = String(deviceId || '').trim();
    if (!id) continue;
    const bucket = normalizeAgentRuntimeStatsBucket(value);
    if (bucketHasData(bucket)) devices[id] = bucket;
  }

  const flat = normalizeAgentRuntimeStatsBucket(obj);
  const baseline = obj.baseline
    ? normalizeAgentRuntimeStatsBucket(obj.baseline)
    : (Object.keys(devices).length ? emptyAgentRuntimeStatsBucket() : flat);

  return materializeAgentRuntimeStatsFile(baseline, devices, newerUpdatedAt(flat.updated_at, baseline.updated_at));
}

export function materializeAgentRuntimeStatsFile(
  baseline: AgentRuntimeStatsBucket,
  devices: Record<string, AgentRuntimeStatsBucket>,
  updatedAt?: string,
): AgentRuntimeStatsFile {
  let totals = normalizeAgentRuntimeStatsBucket(baseline);
  const cleanDevices: Record<string, AgentRuntimeStatsBucket> = {};
  for (const [deviceId, rawBucket] of Object.entries(devices || {})) {
    const id = String(deviceId || '').trim();
    if (!id) continue;
    const bucket = normalizeAgentRuntimeStatsBucket(rawBucket);
    if (!bucketHasData(bucket)) continue;
    cleanDevices[id] = bucket;
    totals = addBuckets(totals, bucket);
  }
  const finalUpdatedAt = newerUpdatedAt(updatedAt, totals.updated_at);
  return {
    version: 2,
    baseline: normalizeAgentRuntimeStatsBucket(baseline),
    devices: cleanDevices,
    attempts: totals.attempts,
    successes: totals.successes,
    deliveries: totals.deliveries,
    failures: totals.failures,
    errors: totals.errors,
    total_duration_ms: totals.total_duration_ms,
    successful_duration_ms: totals.successful_duration_ms,
    ...(finalUpdatedAt ? { updated_at: finalUpdatedAt } : {}),
  };
}

export function recordAgentRuntimeStatsForDevice(
  raw: unknown,
  deviceId: string,
  result: { duration_ms?: unknown; durationMs?: unknown; success?: unknown; aborted?: unknown; errored?: unknown; status?: unknown } = {},
  nowIso: string,
): AgentRuntimeStatsFile {
  const id = String(deviceId || '').trim() || 'unknown-device';
  const current = normalizeAgentRuntimeStatsFile(raw);
  const device = normalizeAgentRuntimeStatsBucket(current.devices[id]);
  const durationMs = coerceCounter(result.duration_ms ?? result.durationMs);
  const status = normalizeRunStatus(result);
  const success = status === 'success';
  const failure = status === 'failure';
  const error = status === 'error';
  const nextDevice: AgentRuntimeStatsBucket = {
    attempts: device.attempts + 1,
    successes: device.successes + (success ? 1 : 0),
    deliveries: device.deliveries + (success ? 1 : 0),
    failures: device.failures + (failure ? 1 : 0),
    errors: device.errors + (error ? 1 : 0),
    total_duration_ms: device.total_duration_ms + durationMs,
    successful_duration_ms: device.successful_duration_ms + (success ? durationMs : 0),
    updated_at: nowIso,
  };
  return materializeAgentRuntimeStatsFile(current.baseline, {
    ...current.devices,
    [id]: nextDevice,
  }, nowIso);
}

export function mergeAgentRuntimeStatsFiles(local: unknown, remote: unknown): AgentRuntimeStatsFile {
  const l = normalizeAgentRuntimeStatsFile(local);
  const r = normalizeAgentRuntimeStatsFile(remote);
  const devices: Record<string, AgentRuntimeStatsBucket> = {};
  const ids = new Set([...Object.keys(l.devices), ...Object.keys(r.devices)]);
  for (const id of ids) {
    const hasLocal = Object.prototype.hasOwnProperty.call(l.devices, id);
    const hasRemote = Object.prototype.hasOwnProperty.call(r.devices, id);
    if (hasLocal && hasRemote) devices[id] = pickDeviceBucket(l.devices[id], r.devices[id]);
    else devices[id] = hasLocal ? l.devices[id] : r.devices[id];
  }
  return materializeAgentRuntimeStatsFile(
    maxBuckets(l.baseline, r.baseline),
    devices,
    newerUpdatedAt(l.updated_at, r.updated_at),
  );
}
