/**
 * Machine-global persistent installation identity.
 *
 * The id is shared across users through `<data>/device.json` and intentionally
 * does not depend on network interfaces, hostnames, accounts, or sessions.
 * Callers may provide a legacy seed while the machine-global file is first
 * created. Open installs generate the same durable random-id format without
 * any account dependency.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEVICE_FILE } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('machine-device');
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

let cachedDeviceId = '';

function logErrorRef(err: unknown): { code: string } {
  const rawCode = String((err as NodeJS.ErrnoException)?.code || '');
  const code = /^[A-Z0-9_]{1,40}$/.test(rawCode)
    ? rawCode
    : (err instanceof SyntaxError ? 'INVALID_JSON' : 'UNKNOWN');
  return { code };
}

function normalizeDeviceId(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!DEVICE_ID_RE.test(s)) return '';
  return s;
}

function freshDeviceId(): string {
  return randomUUID().replace(/-/g, '');
}

function readStoredDeviceId(): string {
  try {
    if (!fs.existsSync(DEVICE_FILE)) return '';
    const raw = fs.readFileSync(DEVICE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeDeviceId(parsed && parsed.device_id);
  } catch (err) {
    log.warn('machine device id read failed; rotating id', {
      error: logErrorRef(err),
    });
    return '';
  }
}

function writeStoredDeviceId(deviceId: string): void {
  const dir = path.dirname(DEVICE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${DEVICE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    const body = JSON.stringify({
      version: 1,
      device_id: deviceId,
      created_at: Date.now(),
    }, null, 2);
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DEVICE_FILE);
  } finally {
    // A failed rename (read-only path, directory collision, full disk) must
    // not accumulate machine-global identity temp files on every launch.
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* best-effort cleanup; the original persistence error wins */ }
  }
}

export function getDeviceId(legacySeed?: unknown): string {
  if (cachedDeviceId) return cachedDeviceId;
  const fileStored = readStoredDeviceId();
  const stored = fileStored || normalizeDeviceId(legacySeed);
  if (stored) {
    cachedDeviceId = stored;
    if (!fileStored) {
      try {
        writeStoredDeviceId(cachedDeviceId);
      } catch (err) {
        log.warn('machine device id backfill failed; using legacy seed', {
          error: logErrorRef(err),
        });
      }
    }
    return cachedDeviceId;
  }
  cachedDeviceId = freshDeviceId();
  try {
    writeStoredDeviceId(cachedDeviceId);
  } catch (err) {
    log.warn('machine device id persist failed; using in-memory id', {
      error: logErrorRef(err),
    });
  }
  return cachedDeviceId;
}

export function deviceIdFilePath(): string {
  return DEVICE_FILE;
}
