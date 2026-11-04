/** One synchronous read/modify/atomic-write owner for machine identity and desktop preferences. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEVICE_FILE } from '../paths';
export function readDeviceRecord(): Record<string, any> {
  let raw: string;
  try { raw = fs.readFileSync(DEVICE_FILE, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const record = JSON.parse(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new SyntaxError('Invalid device record');
  return record;
}
export function updateDeviceRecord(update: (record: Record<string, any>) => Record<string, any>, recoverInvalidIdentity = false): void {
  let record: Record<string, any>;
  try { record = readDeviceRecord(); }
  catch (error) { if (recoverInvalidIdentity && error instanceof SyntaxError) record = {}; else throw error; }
  const next = update(record);
  fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
  const tmp = `${DEVICE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, DEVICE_FILE);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
