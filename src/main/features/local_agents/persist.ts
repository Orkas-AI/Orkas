/**
 * Persist a single CLI agent dispatch to disk.
 *
 * Layout per run:
 *   <uid>/local/file_cache/local-agent-runs/<runId>/
 *     ├── meta.json     ← run summary (status / timings / agent + cli ids)
 *     ├── prompt.txt    ← exact prompt fed to the CLI's stdin
 *     ├── events.jsonl  ← every LocalEvent as a JSON line
 *     └── output.txt    ← accumulated text-delta + final result body
 *
 * The runner calls `start` once before launching the backend, `append`
 * for each event the backend emits, and `finalize` after the backend's
 * terminal `done` event lands. Failures during persistence log + carry
 * on — losing a few diagnostic lines is better than failing the user's
 * task because file_cache is full.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { localAgentRunDir, userLocalAgentRunsDir } from '../../paths.js';
import { createLogger } from '../../logger.js';
import type { LocalEvent } from './backends/base.js';

const log = createLogger('local-agents:persist');

export interface RunMeta {
  runId: string;
  agentId: string;
  cid: string;
  cli: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'missing_cli';
  durationMs?: number;
  cliPath?: string;
  sessionId?: string;
  /** Final text body — same content as output.txt; duplicated here so a
   *  single read of meta.json suffices for run lists / debug pages. */
  output?: string;
  error?: string;
}

export interface RunHandle {
  runId: string;
  dir: string;
  /** Persisted prompt path, surfaced for tests / future "open run dir". */
  promptPath: string;
  eventsPath: string;
  outputPath: string;
  metaPath: string;
}

/** 12-hex-char run id; collisions in practice are nil at the volumes
 *  we expect (a few dispatches per minute) but we still re-roll on hit. */
function genRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export async function start(uid: string, init: Omit<RunMeta, 'runId' | 'startedAt'> & { prompt: string }): Promise<RunHandle> {
  await fsp.mkdir(userLocalAgentRunsDir(uid), { recursive: true });
  let runId = genRunId();
  while (fs.existsSync(localAgentRunDir(uid, runId))) runId = genRunId();
  const dir = localAgentRunDir(uid, runId);
  await fsp.mkdir(dir, { recursive: true });
  const meta: RunMeta = {
    runId,
    agentId: init.agentId,
    cid: init.cid,
    cli: init.cli,
    model: init.model,
    cliPath: init.cliPath,
    startedAt: new Date().toISOString(),
  };
  const handle: RunHandle = {
    runId,
    dir,
    promptPath: path.join(dir, 'prompt.txt'),
    eventsPath: path.join(dir, 'events.jsonl'),
    outputPath: path.join(dir, 'output.txt'),
    metaPath: path.join(dir, 'meta.json'),
  };
  try {
    await fsp.writeFile(handle.promptPath, init.prompt, 'utf8');
    await fsp.writeFile(handle.metaPath, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.writeFile(handle.eventsPath, '', 'utf8');
    await fsp.writeFile(handle.outputPath, '', 'utf8');
  } catch (err) {
    log.warn('persist start failed', { uid, runId, error: (err as Error).message });
  }
  return handle;
}

/** Append one event to events.jsonl. Synchronous fs is intentional —
 *  we want the line on disk before the next event arrives, and these
 *  files live on the user's local SSD. */
export function append(handle: RunHandle, event: LocalEvent): void {
  try {
    fs.appendFileSync(handle.eventsPath, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    log.warn('persist append failed', { runId: handle.runId, error: (err as Error).message });
  }
}

/** Append a chunk of body text to output.txt. */
export function appendOutput(handle: RunHandle, text: string): void {
  if (!text) return;
  try {
    fs.appendFileSync(handle.outputPath, text, 'utf8');
  } catch (err) {
    log.warn('persist appendOutput failed', { runId: handle.runId, error: (err as Error).message });
  }
}

/** Update meta.json with terminal status + write a final consolidated
 *  output if the runner has it (some runs only know it from the
 *  `done` event's `output` field, others streamed it incrementally). */
export async function finalize(handle: RunHandle, patch: Partial<RunMeta>): Promise<void> {
  try {
    const raw = await fsp.readFile(handle.metaPath, 'utf8');
    const meta = JSON.parse(raw) as RunMeta;
    Object.assign(meta, patch, {
      endedAt: new Date().toISOString(),
    });
    await fsp.writeFile(handle.metaPath, JSON.stringify(meta, null, 2), 'utf8');
    if (typeof patch.output === 'string' && patch.output.length > 0) {
      // Replace any partially-streamed output if the backend handed us
      // a complete body in `done`. Otherwise leave the streamed file
      // alone — appendOutput already accumulated it.
      const existing = await fsp.readFile(handle.outputPath, 'utf8').catch(() => '');
      if (!existing) await fsp.writeFile(handle.outputPath, patch.output, 'utf8');
    }
  } catch (err) {
    log.warn('persist finalize failed', { runId: handle.runId, error: (err as Error).message });
  }
}
