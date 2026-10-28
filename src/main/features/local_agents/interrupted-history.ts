/** Display-only recovery of an interrupted CLI run. Canonical/model history,
 * execution status and CLI resumption never depend on this projection. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { userLocalAgentRunsDir } from '../../paths';
import { readJsonlPageWithOffsets } from '../../storage';
import { redactPaths } from '../../util/redact';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import type { GroupMessage } from '../group_chat/visibility';
import type { HistoryProcessPart } from '../conversation-process-cache';
import { processTextChunks } from '../conversation-process-cache';
import { CodexFileCitationStreamFilter } from './public-output';

type Item = NonNullable<GroupMessage['process']>[number];
type Candidate = { record: GroupMessage; actorId: string; actorResolved: boolean;
  users: Map<string, number>; settled: boolean; invalid: boolean };
type Run = { directory: string; cid: string; agentId: string; cli: string;
  startedAt: string; endedAt?: string; durationMs?: number; currentMessageId?: string };
const MAX_LINE_BYTES = 16 * 1024 * 1024;

async function openRegular(file: string): Promise<fsp.FileHandle> {
  // O_NOFOLLOW is absent on Windows; lstat rejects links on both platforms.
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid CLI archive');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const after = await handle.stat();
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
    await handle.close(); throw new Error('Changed CLI archive');
  }
  return handle;
}

/** Ignore an incomplete crash tail, while keeping each complete line before
 * it. A damaged oversized line cannot make buffers grow with the whole run. */
async function* archiveEvents(file: string, snapshot: (stat: fs.Stats) => void): AsyncGenerator<Record<string, any>> {
  const handle = await openRegular(file);
  const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  let chunks: Buffer[] = [], bytes = 0, oversized = false;
  try {
    snapshot(await handle.stat());
    for await (const block of stream) {
      let start = 0;
      while (start < block.length) {
        const newline = block.indexOf(10, start);
        const end = newline < 0 ? block.length : newline;
        const chunk = block.subarray(start, end);
        bytes += chunk.length;
        if (bytes > MAX_LINE_BYTES) { oversized = true; chunks = []; }
        if (!oversized) chunks.push(chunk);
        if (newline < 0) break;
        if (!oversized && bytes) {
          let event;
          try { event = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { /* damaged line */ }
          if (event && typeof event === 'object' && !Array.isArray(event)) yield event;
        }
        chunks = []; bytes = 0; oversized = false; start = newline + 1;
      }
    }
  } finally { stream.destroy(); await handle.close(); }
}

async function archiveRuns(userId: string, cid: string, actors: Set<string>): Promise<Run[]> {
  const root = userLocalAgentRunsDir(userId);
  const runs: Run[] = [];
  let entries;
  try { entries = await fsp.opendir(root); } catch { return runs; }
  for await (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{12}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    let handle;
    try {
      handle = await openRegular(path.join(directory, 'meta.json'));
      if ((await handle.stat()).size > 4 * 1024 * 1024) continue;
      const meta = JSON.parse(await handle.readFile('utf8'));
      if (meta.cid !== cid || !actors.has(meta.agentId)
          || !['codex', 'claude', 'opencode', 'openclaw', 'hermes'].includes(meta.cli)) continue;
      runs.push({ directory, cid: meta.cid, agentId: meta.agentId, cli: meta.cli,
        startedAt: meta.startedAt, endedAt: meta.endedAt, durationMs: meta.durationMs,
        currentMessageId: meta.currentMessageId });
    } catch { /* Expired or incomplete diagnostic archives are optional. */ }
    finally { await handle?.close(); }
  }
  return runs;
}

function collectTrigger(record: GroupMessage, candidate: Candidate): void {
  if (candidate.settled) return;
  if (candidate.record.source_message_id) {
    // New receipts retain the exact causal input, including an Agent dispatch.
    // Other user messages and older replies cannot substitute for that input.
    if (record.id === candidate.record.source_message_id) {
      const ts = Date.parse(record.ts);
      if (Number.isFinite(ts)) candidate.users.set(record.id, ts);
      else candidate.invalid = true;
      candidate.settled = true;
    }
    return;
  }
  if (!candidate.actorResolved) {
    // Startup falls back to Commander when the running roster was lost. The
    // nearest structured question or single user destination can identify the
    // actual actor; do not infer it from prose or search older completed work.
    candidate.actorResolved = true;
    if (record.cli_question && record.turn_id && record.from !== 'user') candidate.actorId = record.from;
    else if (record.from === 'user' && record.to?.length === 1 && record.to[0] !== 'user') {
      candidate.actorId = record.to[0];
    }
    if (candidate.actorId === candidate.record.from) {
      candidate.invalid = true; candidate.settled = true; return;
    }
  }
  if (record.from === candidate.actorId && (record.system_kind === 'reply_interrupted'
      || record.source_message_id || record.process?.length || record.process_parts?.length)) {
    // Official replies/already-saved trails close the preceding attempt.
    // An async question with no terminal receipt does not end a CLI run.
    candidate.settled = true;
  } else if (record.from === 'user') {
    const ts = Date.parse(record.ts);
    if (!record.id || !Number.isFinite(ts)) { candidate.invalid = true; candidate.settled = true; }
    else candidate.users.set(record.id, ts);
  }
}

async function recoverRun(run: Run, store: (items: Item[]) => HistoryProcessPart | undefined, includeProcess = true): Promise<{
  parts: HistoryProcessPart[]; durationMs?: number; lastWrittenAt?: number;
}> {
  const parts: HistoryProcessPart[] = [];
  let durationMs: number | undefined, lastWrittenAt: number | undefined, hasEvents = false;
  let batch: Item[] = [];
  const flush = () => {
    if (!batch.length) return;
    const part = store(batch);
    if (part) parts.push(part);
    batch = [];
  };
  const addText = (text: string) => {
    // Only explicit public commentary is restored. Unfinished answers remain
    // absent from the notice body and private reasoning is never replayed.
    for (const chunk of processTextChunks(text)) {
      batch.push({ type: 'progress', text: chunk,
        event: { stream: 'assistant', data: { phase: 'commentary' } } });
      if (batch.length >= 200) flush();
    }
  };
  const filter = run.cli === 'codex' ? new CodexFileCitationStreamFilter() : null;
  let commentary = '';
  const flushText = () => {
    if (filter) commentary += filter.flush();
    if (commentary) addText(commentary);
    commentary = '';
  };
  for await (const event of archiveEvents(path.join(run.directory, 'events.jsonl'), stat => {
    lastWrittenAt = stat.mtimeMs;
  })) {
    hasEvents = true;
    // A terminal from an earlier attempt cannot time work appended after it.
    durationMs = event.type === 'done' && typeof event.durationMs === 'number'
      && Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : undefined;
    if (!includeProcess) continue;
    if (event.type === 'text-delta') {
      if (event.phase === 'commentary' && typeof event.text === 'string') {
        commentary += filter ? filter.push(event.text) : event.text;
        if (commentary.length >= 16 * 1024) { addText(commentary); commentary = ''; }
      } else flushText();
      continue;
    }
    flushText();
    if (event.heartbeat === true || event.type === 'idle') continue;
    if (event.type === 'thinking') {
      // Old diagnostic archives may predate runner-side raw-thought removal.
      // A summary already passed the public runner boundary; never copy text.
      batch.push({ type: 'event', event: { stream: 'cli', data: {
        type: 'thinking', chars: Number(event.chars) || 0,
        ...(typeof event.summary === 'string' ? { summary: redactPaths(sanitizeLogTextForUpload(event.summary))
          .replace(/\s+/g, ' ').trim().slice(0, 2048) } : {}),
      } } });
    } else if (['tool-event', 'file-change', 'status', 'permission-request',
      'stderr-line', 'raw-line', 'log', 'media-output'].includes(event.type)) {
      batch.push({ type: 'event', event: { stream: 'cli', data: event } });
    }
    if (batch.length >= 200) flush();
  }
  flushText(); flush();
  return { parts, durationMs, ...(hasEvents ? { lastWrittenAt } : {}) };
}

function runTiming(run: Run, noticeEnd: number, recovered?: Awaited<ReturnType<typeof recoverRun>>): {
  duration: number; estimated: boolean;
} | undefined {
  const start = Date.parse(run.startedAt);
  const span = Date.parse(run.endedAt || '') - start;
  let duration = typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0
    ? run.durationMs : span;
  let estimated = false;
  if (!Number.isFinite(duration) && !run.endedAt) {
    if (recovered?.durationMs != null) duration = recovered.durationMs;
    else if (recovered?.lastWrittenAt != null) {
      duration = recovered.lastWrittenAt - start;
      estimated = true;
    }
  }
  return Number.isFinite(duration) && duration >= 0 && start + duration <= noticeEnd
    ? { duration, estimated } : undefined;
}

function hasInterruptionClock(record: GroupMessage): boolean {
  return !!record.process?.some(item => {
    const event = item.event;
    const data = event?.data as Record<string, unknown> | undefined;
    return event?.stream === 'runtime' && data?.phase !== 'segment_end' && data?.phase !== 'retrying'
      && typeof data?.duration_ms === 'number' && Number.isFinite(data.duration_ms) && data.duration_ms >= 0;
  });
}

function noticeEndUpperBound(ts: string): number {
  // nowIso/localIsoAt persist whole seconds, whereas CLI archives retain
  // milliseconds. A receipt at :24 can follow a run ending at :24.602.
  // Only widen that explicit timestamp shape; precise receipts stay precise.
  const secondPrecision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(ts);
  return Date.parse(ts) + (secondPrecision ? 999 : 0);
}

/** `before` names the byte start of this selected page, so a notice whose
 * trigger is on the previous page does not require a whole-chat scan. */
export async function restoreInterruptedCliHistory(
  userId: string, sourceFile: string, records: GroupMessage[], before: number | null,
  store: (items: Item[]) => HistoryProcessPart | undefined,
): Promise<GroupMessage[]> {
  const candidates: Candidate[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.system_kind !== 'reply_interrupted' || record.deleted_at || hasInterruptionClock(record)) continue;
    const attempts: Candidate[] = [{ record, actorId: record.from, actorResolved: true,
      users: new Map(), settled: false, invalid: false }];
    // Keep the original sender's recovery first. A delegated question must
    // not replace that actor's own archive when both runs are evidenced.
    if (record.from === 'commander' && !record.turn_id && !record.source_message_id
        && !record.process?.length && !record.process_parts?.length) {
      attempts.push({ record, actorId: record.from, actorResolved: false,
        users: new Map(), settled: false, invalid: false });
    }
    for (const candidate of attempts) {
      for (let n = index - 1; n >= 0 && !candidate.settled; n--) collectTrigger(records[n], candidate);
      candidates.push(candidate);
    }
  }
  if (!candidates.length) return records;
  let cursor = before;
  while (cursor && candidates.some(candidate => !candidate.settled)) {
    const page = await readJsonlPageWithOffsets<GroupMessage>(sourceFile, 10, cursor);
    for (let n = page.entries.length - 1; n >= 0; n--) {
      for (const candidate of candidates) {
        collectTrigger(page.entries[n].record, candidate);
      }
    }
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  if (!candidates.some(candidate => !candidate.invalid && candidate.users.size)) return records;
  const runs = await archiveRuns(userId, path.basename(sourceFile, '.jsonl'), new Set(candidates.map(c => c.actorId)));
  const recovered = new Map<string, GroupMessage>();
  for (const { record, actorId, users, invalid } of candidates) {
    if (invalid || !users.size || recovered.has(record.id)) continue;
    const end = noticeEndUpperBound(record.ts);
    const earliestUser = Math.min(...users.values());
    const latestUser = Math.max(...users.values());
    const matches = runs.filter(run => run.agentId === actorId
      && (!record.source_message_id || run.currentMessageId === record.source_message_id)
      // Cross-actor fallback requires the exact original trigger. Legacy time
      // windows alone cannot prove which actor owned a generic startup notice.
      && (actorId === record.from || !!run.currentMessageId)
      && Date.parse(run.startedAt) >= (run.currentMessageId ? users.get(run.currentMessageId) ?? Infinity : earliestUser)
      && Date.parse(run.startedAt) <= end
      && (!run.endedAt || (Date.parse(run.endedAt) >= latestUser && Date.parse(run.endedAt) <= end)));
    // A legacy archive has no trigger identity. Ambiguity must not show work
    // from another run as if it belonged to this interrupted reply.
    if (!matches.length || (matches.length > 1
      && (matches.some(run => !run.currentMessageId) || new Set(matches.map(run => run.currentMessageId)).size !== 1))) continue;
    try {
      const parts: HistoryProcessPart[] = [];
      const savedProcess = !!(record.process?.length || record.process_parts?.length);
      const intervals: { start: number; end: number }[] = [];
      let estimated = false, allTimed = true;
      for (const run of matches.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
        let timing = runTiming(run, end);
        // A saved trail needs only its missing clock. Finalized metadata avoids
        // rereading a potentially large archive or appending duplicate process.
        if (!savedProcess || !timing) {
          try {
            const recoveredRun = await recoverRun(run, store, !savedProcess);
            parts.push(...recoveredRun.parts);
            timing = runTiming(run, end, recoveredRun);
          } catch (error) { if (!timing) throw error; }
        }
        if (!timing) { allTimed = false; continue; }
        estimated ||= timing.estimated;
        const start = Date.parse(run.startedAt);
        intervals.push({ start, end: start + timing.duration });
      }
      // Add evidenced execution intervals, excluding gaps between attempts and
      // downtime before startup. Overlapping archives must not double the clock.
      let duration = 0, coveredEnd = -Infinity;
      for (const interval of intervals) {
        duration += Math.max(0, interval.end - Math.max(interval.start, coveredEnd));
        coveredEnd = Math.max(coveredEnd, interval.end);
      }
      const runtime: Item[] = allTimed && intervals.length
        ? [{ type: 'event', event: { stream: 'runtime', data: {
          phase: 'interrupted', duration_ms: Math.round(duration), ...(estimated ? { duration_estimated: true } : {}),
        } } }]
        : [];
      if (parts.length || runtime.length) recovered.set(record.id, { ...record,
        ...(runtime.length ? { process: [...(record.process || []), ...runtime] } : {}),
        ...(parts.length ? { process_parts: parts.map(part => 'ref' in part ? { ...part, message_id: record.id } : part) } : {}) });
    } catch { /* Missing archive/cache must not hide the interruption notice. */ }
  }
  return records.map(record => recovered.get(record.id) || record);
}
