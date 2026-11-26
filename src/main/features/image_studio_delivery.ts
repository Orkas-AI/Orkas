import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { userLocalRoot } from '../paths';
import { readJson, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import { readProducedFileVersion } from '../model/core-agent/task-file-ownership';
import { isPathAllowed, resolveSandboxRoot } from '../util/path-sandbox';

const MAX_VERSIONS = 512;
const MAX_STATE_BYTES = 256 * 1024;
const versionHashes = new Map<string, string>();

export const LAYERED_CANDIDATE_KIND = 'image-studio-layered-candidate';

/** Exact opt-in command on a user turn already addressed to ImageStudio. */
export function requestsImageStudioNativePng(text: string): boolean {
  const words = text.trimStart().split(/\s+/, 3);
  const command = words[0]?.toLowerCase() === '@imagestudio' ? 1 : 0;
  return words[command] === '/export-png' && !!words[command + 1];
}

/** Receipts are scoped to one actor turn and to a specific, unchanged file. */
export class ImageStudioNativePngDelivery {
  private readonly versions = new Map<string, string>();

  record(file: string, version: string): void {
    this.versions.set(path.resolve(file), version);
  }

  permits(file: string): boolean {
    return path.extname(file).toLowerCase() !== '.png' || this.isVerified(file);
  }

  isVerified(file: string): boolean {
    const version = this.versions.get(path.resolve(file));
    return version !== undefined && version === readProducedFileVersion(file);
  }
}

export interface LayeredFileVersion {
  identity: string;
  size: number;
  sha256: string;
}

interface LayeredDeliveryState {
  candidates: LayeredFileVersion[];
  exports: LayeredFileVersion[];
}

export function layeredFileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

export function isLayeredFileVersion(value: unknown): value is LayeredFileVersion {
  if (!value || typeof value !== 'object') return false;
  const { identity, size, sha256 } = value as Partial<LayeredFileVersion>;
  return typeof identity === 'string' && identity.length <= 80 && /^\d+:\d+:\d+(?:\.\d+)?$/.test(identity)
    && typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= 128 * 1024 * 1024
    && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256);
}

function statePath(uid: string, cid: string): string {
  const key = createHash('sha256').update(cid).digest('hex');
  return path.join(userLocalRoot(uid), 'image_studio', 'layered-delivery', `${key}.json`);
}

async function readState(file: string): Promise<LayeredDeliveryState> {
  const stats = await fs.stat(file).catch(() => undefined);
  if (!stats?.isFile() || stats.size > MAX_STATE_BYTES) return { candidates: [], exports: [] };
  const state = await readJson<Partial<LayeredDeliveryState>>(file);
  return {
    candidates: Array.isArray(state?.candidates) ? state.candidates.slice(-MAX_VERSIONS).filter(isLayeredFileVersion) : [],
    exports: Array.isArray(state?.exports) ? state.exports.slice(-MAX_VERSIONS).filter(isLayeredFileVersion) : [],
  };
}

async function registerVersions(file: string, field: keyof LayeredDeliveryState, versions: readonly LayeredFileVersion[]): Promise<void> {
  await fileEditLock(file).runExclusive(async () => {
    const state = await readState(file);
    const entries = new Map(state[field].map(version => [version.identity, version]));
    for (const version of versions) entries.set(version.identity, version);
    state[field] = [...entries.values()].slice(-MAX_VERSIONS);
    await writeJson(file, state);
  });
}

export async function registerImageStudioLayeredCandidates(uid: string, cid: string, versions: readonly LayeredFileVersion[]): Promise<void> {
  if (versions.length) await registerVersions(statePath(uid, cid), 'candidates', versions);
}

async function hashVersion(file: string, before: Stats): Promise<string | undefined> {
  const key = `${layeredFileIdentity(before)}:${before.size}:${before.ctimeMs}`;
  const cached = versionHashes.get(key);
  if (cached) return cached;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { end: before.size - 1 })) hash.update(chunk);
    const after = await fs.stat(file);
    if (layeredFileIdentity(after) === layeredFileIdentity(before) && after.size === before.size && after.ctimeMs === before.ctimeMs) {
      const digest = hash.digest('hex');
      versionHashes.set(key, digest);
      if (versionHashes.size > 128) versionHashes.delete(versionHashes.keys().next().value!);
      return digest;
    }
  } catch { /* The file disappeared or became unavailable during publication. */ }
  return undefined;
}

/** Called after the native exporter verifies the output and before the host publishes it. */
export async function registerImageStudioLayeredExport(uid: string, cid: string, output: string): Promise<void> {
  const file = statePath(uid, cid);
  const { candidates } = await readState(file);
  if (!candidates.length) return;
  const stats = await fs.stat(output);
  if (!candidates.some(candidate => candidate.size === stats.size)) return;
  const sha256 = await hashVersion(output, stats);
  if (!sha256) throw new Error('E_IMAGE_EXPORT_CHANGED: The exported file changed before publication. Export the current version again.');
  if (candidates.some(candidate => candidate.sha256 === sha256)) {
    await registerVersions(file, 'exports', [{ identity: layeredFileIdentity(stats), size: stats.size, sha256 }]);
  }
}

export async function partitionImageStudioLayeredOutputs(uid: string, cid: string, paths: string[], workingDir: string): Promise<{
  eligible: string[];
  candidates: string[];
}> {
  if (!paths.length) return { eligible: paths, candidates: [] };
  const state = await readState(statePath(uid, cid));
  if (!state.candidates.length) return { eligible: paths, candidates: [] };
  const identities = new Set(state.candidates.map(candidate => candidate.identity));
  const sizes = new Set(state.candidates.map(candidate => candidate.size));
  const hashes = new Set(state.candidates.map(candidate => candidate.sha256));
  const exported = new Map(state.exports.map(version => [version.identity, version.sha256]));
  const root = resolveSandboxRoot(workingDir);
  const eligible: string[] = [];
  const candidates: string[] = [];
  for (const file of paths) {
    if (!isPathAllowed(file, [root], { rootsResolved: true })) {
      eligible.push(file);
      continue;
    }
    const stats = await fs.stat(file).catch(() => undefined);
    if (!stats?.isFile()) continue;
    const identity = layeredFileIdentity(stats);
    if (identities.has(identity)) {
      candidates.push(file);
      continue;
    }
    // Copies have a new filesystem identity. Read only plausible PSD/PNG copies,
    // and let a separately verified native export contain the exact same bytes.
    if (sizes.has(stats.size) && /\.(png|psd)$/i.test(file)) {
      const sha256 = await hashVersion(file, stats);
      if (!sha256 || (hashes.has(sha256) && exported.get(identity) !== sha256)) {
        candidates.push(file);
        continue;
      }
    }
    eligible.push(file);
  }
  return { eligible, candidates };
}
