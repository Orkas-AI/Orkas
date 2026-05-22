/**
 * Sessions GC — startup-time sweep of `<uid>/{cloud,local}/sessions/`.
 *
 * Design lives upstream:
 *   - "Resumable" kinds (gconv / gmember / skill / agent) belong in
 *     cloud/sessions/ and are life-cycled with their owning entity (cid /
 *     sid / aid). Their normal cleanup path is the owning entity's delete
 *     (chats.deleteConversation / skills.deleteCustomSkill /
 *     agents.deleteCustomAgent). The sweep is a defense in depth for
 *     cid-bound orphans only — skill / agent orphans are explicitly NOT
 *     touched per user instruction (their per-entity delete already hooks
 *     evictSession + unlink).
 *   - "Ephemeral" kinds (extract-img / reflect / memory-extract / anon)
 *     are routed to `local/sessions/` by `session-store.resolveSessionPath`.
 *     They have no resumer, so we GC by mtime.
 *
 * Sweep targets (only these — everything else is left alone):
 *   1. cloud/sessions/  — ephemeral kinds that pre-date the routing change
 *                          (one-shot historical clean-up after the path
 *                          migration; the post-change code never writes
 *                          ephemeral kinds here).
 *   2. cloud/sessions/  — gconv / gmember orphans where the cid is no
 *                          longer in conversations._index.json (this was
 *                          the historical bug — dropConv removed members.json
 *                          before deleteConversation got to read it, leaking
 *                          every per-agent worker session).
 *   3. cloud/sessions/  — legacy prefix kinds (sub / organizer / conv);
 *                          new code doesn't write these and the legacy id
 *                          migrator in features/users.ts only renames live
 *                          ids, not the orphan files.
 *   4. local/sessions/  — mtime older than EPHEMERAL_AGE_MS.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { userSessionsDir, userLocalSessionsDir } from '../paths';
import { createLogger } from '../logger';
import { listConversations } from './chats';
import { isEphemeralSessionId } from '../model/core-agent/session-store';

const log = createLogger('sessions-sweep');

const EPHEMERAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days (matches logger / marketplace_cache)
const LEGACY_KINDS = new Set(['sub', 'organizer', 'conv']);

interface SweepResult {
  scanned: number;
  alien_uid: number;          // prefix doesn't match the active uid — session-store can never read these
  orphan_cid: number;         // gconv/gmember whose cid is no longer registered
  ephemeral_on_cloud: number; // ephemeral kinds that leaked into cloud/sessions/
  legacy: number;             // sub / organizer / conv leftovers
  local_aged_out: number;     // local/sessions/ files older than EPHEMERAL_AGE_MS
  errors: number;
}

// Pull the kind segment out of `<uid>-<kind>-<tail>`, accounting for
// multi-segment kinds (extract-img / memory-extract). Returns null when the
// id doesn't fit `<uid>-...` shape.
function classify(userId: string, baseName: string): { kind: string; cid?: string } | null {
  if (!baseName.startsWith(`${userId}-`)) return null;
  const tail = baseName.slice(userId.length + 1);
  if (!tail) return null;
  // Match against multi-segment kinds first (longest match wins) — order
  // matters: `extract-img-abc` would also start with `extract` (a non-kind
  // prefix), but we don't list `extract` as a kind anymore.
  for (const k of ['extract-img', 'memory-extract']) {
    if (tail.startsWith(`${k}-`)) return { kind: k };
  }
  // For gconv/gmember/skill/agent/reflect/anon and legacy sub/organizer/conv:
  // single-segment kind, the rest is the tail (cid / aid / sid / random).
  const dash = tail.indexOf('-');
  if (dash < 0) return { kind: tail };
  const kind = tail.slice(0, dash);
  const rest = tail.slice(dash + 1);
  if (kind === 'gconv') return { kind, cid: rest };
  if (kind === 'gmember') {
    // gmember tail is `<cid>-<aid>`. Split the cid out by taking everything
    // up to the LAST dash. (cids today are 12-hex and contain no dashes; the
    // last-dash split is robust to that and to any future cid shape.)
    const lastDash = rest.lastIndexOf('-');
    if (lastDash < 0) return { kind, cid: rest };
    return { kind, cid: rest.slice(0, lastDash) };
  }
  return { kind };
}

async function sweepCloud(userId: string, result: SweepResult): Promise<void> {
  const dir = userSessionsDir(userId);
  let names: string[];
  try { names = await fsp.readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`readdir cloud sessions: ${(err as Error).message}`);
    }
    return;
  }
  // Materialize the active cid set once — listConversations does a JSON
  // read; doing it per-file would be n× wasteful.
  const activeCids = new Set<string>();
  try {
    const convs = await listConversations(userId);
    for (const c of convs) activeCids.add(c.conversation_id);
  } catch (err) {
    log.warn(`listConversations failed; orphan-cid sweep degraded: ${(err as Error).message}`);
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    result.scanned++;
    const sid = name.slice(0, -'.jsonl'.length);

    // 1. Alien-uid prefix: the file lives under the active uid's sessions/
    //    dir but its session_id starts with a different uid. session-store's
    //    hard assertion (sessionFileFor: id MUST start with `<activeUid>-`)
    //    means these are unreachable from any code path — pure dead state.
    //    Historical cause on dev boxes: when the uid format moved from
    //    8-digit numeric to UUID, the data root carried over but sessions
    //    were never renamed; the 8-digit-prefix files persisted, taking up
    //    ~90% of the directory. Reading from them is impossible, so the
    //    safest treatment is to drop them.
    if (!sid.startsWith(`${userId}-`)) {
      try {
        await fsp.unlink(path.join(dir, name));
        result.alien_uid++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`unlink alien ${name}: ${(err as Error).message}`);
          result.errors++;
        }
      }
      continue;
    }

    const info = classify(userId, sid);
    if (!info) continue;
    let reason: keyof Pick<SweepResult, 'orphan_cid' | 'ephemeral_on_cloud' | 'legacy'> | null = null;
    if (isEphemeralSessionId(userId, sid)) {
      reason = 'ephemeral_on_cloud';
    } else if (LEGACY_KINDS.has(info.kind)) {
      reason = 'legacy';
    } else if ((info.kind === 'gconv' || info.kind === 'gmember') && info.cid && !activeCids.has(info.cid)) {
      reason = 'orphan_cid';
    }
    if (!reason) continue;
    try {
      await fsp.unlink(path.join(dir, name));
      result[reason]++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`unlink ${name}: ${(err as Error).message}`);
        result.errors++;
      }
    }
  }
}

async function sweepLocalByAge(userId: string, result: SweepResult, now: number): Promise<void> {
  const dir = userLocalSessionsDir(userId);
  let names: string[];
  try { names = await fsp.readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`readdir local sessions: ${(err as Error).message}`);
    }
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try { st = await fsp.stat(full); }
    catch { continue; }
    if (now - st.mtimeMs <= EPHEMERAL_AGE_MS) continue;
    try {
      await fsp.unlink(full);
      result.local_aged_out++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`unlink ${name}: ${(err as Error).message}`);
        result.errors++;
      }
    }
  }
}

/** Run the sweep for a specific uid. Logs a summary line at the end; safe
 *  to call from startup without awaiting (errors don't propagate). */
export async function sweepSessions(userId: string): Promise<SweepResult> {
  const t0 = Date.now();
  const result: SweepResult = {
    scanned: 0, alien_uid: 0, orphan_cid: 0, ephemeral_on_cloud: 0, legacy: 0,
    local_aged_out: 0, errors: 0,
  };
  await sweepCloud(userId, result);
  await sweepLocalByAge(userId, result, Date.now());
  const removed = result.alien_uid + result.orphan_cid + result.ephemeral_on_cloud
                + result.legacy + result.local_aged_out;
  if (removed > 0 || result.errors > 0) {
    log.info('sweep complete', {
      uid: userId,
      scanned: result.scanned,
      alien_uid: result.alien_uid,
      orphan_cid: result.orphan_cid,
      ephemeral_on_cloud: result.ephemeral_on_cloud,
      legacy: result.legacy,
      local_aged_out: result.local_aged_out,
      errors: result.errors,
      ms: Date.now() - t0,
    });
  }
  return result;
}
