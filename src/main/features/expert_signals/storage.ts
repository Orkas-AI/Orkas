/**
 * Expert signals — storage layer.
 *
 * Append-only daily-rotated jsonl at `<uid>/local/signals/<yyyy-mm-dd>.jsonl`.
 * Sole writer/reader of those files; outer modules must go through
 * `emitSignal` / `querySignals` in `./index.ts`.
 *
 * Writes are fire-and-forget — a disk error logs `warn` and drops the
 * signal (NEVER throws into the caller, which is bus.ts turn-end).
 * Phase 0 has no redaction; phase 2 (consent toggle) will add it.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { signalsDailyFile, userSignalsDir } from '../../paths';
import { createLogger } from '../../logger';
import { getActiveUserId } from '../users';

import { Signal, SignalFilter, SignalInput } from './types';

const log = createLogger('expert-signals');

const QUERY_HARD_CAP = 10_000;
const QUERY_DEFAULT_LIMIT = 1000;

/** Build a Signal from input + stamped id/ts. Pure helper exposed so tests
 *  can produce deterministic records without going through emit. */
export function buildSignal(input: SignalInput, ts?: string): Signal {
  return {
    id: `sig_${crypto.randomUUID()}`,
    ts: ts || new Date().toISOString(),
    ...input,
  };
}

/** Append a single signal to today's jsonl. Fire-and-forget; errors are
 *  logged and swallowed. Caller (emit) must not await this — it returns void
 *  to make that obvious. */
export function appendSignal(uid: string, input: SignalInput): void {
  const signal = buildSignal(input);
  const file = signalsDailyFile(uid);
  fsp.mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.appendFile(file, JSON.stringify(signal) + '\n'))
    .catch((err) => {
      log.warn(`appendSignal failed uid=${uid} type=${input.type}: ${(err as Error).message}`);
    });
}

/** Read signals from one or more daily files and apply the filter. Scans
 *  date range [since, until); without those bounds it falls back to "today
 *  only" to keep memory bounded. */
export async function querySignals(filter: SignalFilter = {}): Promise<Signal[]> {
  const uid = getActiveUserId();
  const limit = Math.min(filter.limit || QUERY_DEFAULT_LIMIT, QUERY_HARD_CAP);
  const dates = _datesInRange(filter.since, filter.until);
  const out: Signal[] = [];

  for (const date of dates) {
    const file = signalsDailyFile(uid, date);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try { content = await fsp.readFile(file, 'utf8'); }
    catch (err) {
      log.warn(`querySignals read failed file=${file}: ${(err as Error).message}`);
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let sig: Signal;
      try { sig = JSON.parse(line) as Signal; }
      catch { continue; }      // corrupt line — skip (don't break the whole query)
      if (!_matches(sig, filter)) continue;
      out.push(sig);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** List of Date objects for each YYYY-MM-DD in [since, until). When both
 *  unset, returns `[today]` only. When one is set, the missing bound
 *  defaults to today. */
function _datesInRange(since?: string, until?: string): Date[] {
  const today = _atMidnight(new Date());
  if (!since && !until) return [today];
  const start = since ? _atMidnight(new Date(since)) : today;
  const end = until ? _atMidnight(new Date(until)) : today;
  const out: Date[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(new Date(d));
  }
  return out;
}

function _atMidnight(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function _matches(sig: Signal, f: SignalFilter): boolean {
  if (f.since && sig.ts < f.since) return false;
  if (f.until && sig.ts >= f.until) return false;
  if (f.types && f.types.length && !f.types.includes(sig.type)) return false;
  if (f.cid && sig.cid !== f.cid) return false;
  if (f.turn_id && sig.turn_id !== f.turn_id) return false;
  if (f.aid !== undefined && sig.aid !== f.aid) return false;
  return true;
}

/** Test seam: silence the warn log (used by unit tests to suppress IO errors
 *  on tmp dirs they tear down). Default no-op. */
export const _internals = {
  buildSignal, appendSignal,
  ensureDir: (uid: string) => fs.mkdirSync(userSignalsDir(uid), { recursive: true }),
};
