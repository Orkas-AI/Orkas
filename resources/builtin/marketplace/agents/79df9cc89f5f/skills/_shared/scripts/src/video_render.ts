/**
 * video_render — local backend for the `render_composition` tool.
 *
 * Renders a HyperFrames HTML composition directory to an mp4/webm by running
 * the upstream `hyperframes` CLI on Orkas's bundled Node runtime. This is the
 * "方案 A (local)" backend; a future hosted backend (方案 B) plugs in behind the
 * same `renderComposition()` signature without touching the tool or skills.
 *
 * Spike-verified facts (see PC/docs/plans/video-agents-design-plan.md §12.1):
 *  - HyperFrames render REQUIRES system ffmpeg + ffprobe and bundles NEITHER.
 *    We point it at the bundled ffmpeg-static via HYPERFRAMES_FFMPEG_PATH /
 *    HYPERFRAMES_FFPROBE_PATH. When those aren't vendored yet (dev checkout),
 *    we leave the override unset so HyperFrames falls back to scanning common
 *    install dirs (the dev machine's system ffmpeg).
 *  - It uses puppeteer-core + @puppeteer/browsers and prefers system Chrome;
 *    only machines without Chrome download a managed Chromium (~180MB).
 *  - Child Chrome/worker processes do NOT inherit env automatically, so we pass
 *    a fully-composed env to the top spawn and let it propagate down.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

// Single source of truth for the bundled-node + npx + env (incl. the pinned
// HYPERFRAMES_SPEC). render/inspect, transcribe, and tts all share it so the
// hyperframes version can never drift between them.
import { HYPERFRAMES_SPEC, resolveHyperframesRunner, buildHyperframesEnv } from './hyperframes_runtime';
import { lintCompositionCraft, formatCraftFindings, type CraftFinding } from './video_craft_lint';
import { redactPaths } from './redact';
import { createLogger } from './logger-shim';

const log = createLogger('video-render');

/** Backstop kill for a wedged render that emits nothing. Long renders are
 *  legitimate, so this is generous; normal completion / user abort happen far
 *  sooner via ctx.signal. */
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
/** Constrained machines software-render frame-by-frame — far slower — so the
 *  outer watchdog and HyperFrames' own timeouts must not preempt a legitimately
 *  slow (but progressing) render. */
const CONSTRAINED_RENDER_TIMEOUT_MS = 40 * 60 * 1000;
const CONSTRAINED_PROTOCOL_TIMEOUT_MS = 15 * 60 * 1000; // vs hyperframes 5min default
const CONSTRAINED_PLAYER_READY_TIMEOUT_MS = 3 * 60 * 1000; // vs 45s default
const CONSTRAINED_BROWSER_TIMEOUT_MS = 3 * 60 * 1000; // vs 60s default
/** inspect/lint only expose --timeout (runtime init); bump it on slow machines. */
const CONSTRAINED_QA_INIT_TIMEOUT_MS = 30 * 1000; // vs 5s default

/** RAM at or below this (GB) trips the constrained render profile — matches
 *  HyperFrames' own low-memory auto-threshold so the two agree. */
export const LOW_RAM_GB = 8;
/** Cost heuristic marking a render infeasible under software rendering on a
 *  constrained machine within a reasonable budget. ~1080x1920@30s@30fps (~1863)
 *  is fine; 60s@60fps (~7452) is heavy. Keep the knobs here; log the decision. */
export const HEAVY_RENDER_COST = 3000;

/** True when this machine should use the low-memory render profile. `gpuMode`
 *  (from a prior attempt's output) forces it even on a high-RAM box. */
export function isConstrainedMachine(totalRamGB: number, observedGpuMode?: string): boolean {
  return totalRamGB <= LOW_RAM_GB || observedGpuMode === 'software';
}

/** Coarse render cost = frames × megapixels. Pure, unit-tested. */
export function estimateRenderCost(width: number, height: number, durationSec: number, fps: number): number {
  const frames = Math.max(1, durationSec) * Math.max(1, fps);
  const megapixels = Math.max(1, (width * height) / 1_000_000);
  return Math.round(frames * megapixels);
}

/** What to do with a heavy render on a constrained machine: a draft degrades
 *  (cheaper, still reviewable); a final never silently degrades — it fails fast
 *  with an actionable message instead of a long hang. */
export function renderCostDecision(opts: { constrained: boolean; costUnits: number; isFinal: boolean }): 'proceed' | 'degrade' | 'fail_fast' {
  if (!opts.constrained || opts.costUnits <= HEAVY_RENDER_COST) return 'proceed';
  return opts.isFinal ? 'fail_fast' : 'degrade';
}

/** Lower fps first (product decision). Returns a reduced fps, or the same value
 *  when it is already at/below the floor (caller then proceeds as-is). */
export function degradedFps(fps: number): number {
  if (fps > 30) return 30;
  return fps; // already ≤30; fps degrade exhausted
}

/** Error/crash tails were truncated to ~1000 chars, which hides the native V8
 *  crash backtrace weak/no-GPU machines produce. Keep a generous tail in the
 *  result; the full stdout+stderr is persisted to `logPath` when given. */
const RENDER_LOG_TAIL_CHARS = 8000;

/** HyperFrames QA emits no trace of its own; a heartbeat is the only liveness
 *  signal while headless Chrome seeks the timeline. */
const QA_PROGRESS_HEARTBEAT_MS = 15_000;

/** Machine + HyperFrames render facts parsed from the child's own output, so a
 *  failed/slow render is self-explaining (was it software-rendering? how much
 *  RAM? a native worker crash or a timeout?). */
export interface RenderDiagnostics {
  gpuMode?: 'hardware' | 'software' | 'unknown';
  workers?: string;
  protocolTimeoutMs?: number;
  playerReadyTimeoutMs?: number;
  browserTimeoutMs?: number;
  totalRamGB?: number;
  crashSignature?: 'native_worker_crash' | 'timeout' | null;
}

export function machineRamGB(): number {
  return Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
}

/** Parse HyperFrames' own `Pipeline started {...}` JSON and the gpu-probe line
 *  from the combined child output. Pure — unit-tested against real log lines. */
export function parseRenderDiagnostics(output: string): RenderDiagnostics {
  const d: RenderDiagnostics = {};
  const s = String(output || '');
  // The `Pipeline started {...}` line carries nested objects (e.g. "fps":{...}),
  // so take the whole line's first `{` .. last `}` rather than a lazy match.
  const line = s.split(/\r?\n/).find((l) => l.includes('Pipeline started') && l.includes('{'));
  if (line) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const j = JSON.parse(line.slice(start, end + 1)) as Record<string, unknown>;
        const gm = j.browserGpuMode;
        if (gm === 'hardware' || gm === 'software') d.gpuMode = gm;
        if (j.requestedWorkers != null) d.workers = String(j.requestedWorkers);
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        d.protocolTimeoutMs = num(j.protocolTimeoutMs) ?? num(j.protocolTimeout);
        d.playerReadyTimeoutMs = num(j.playerReadyTimeoutMs) ?? num(j.playerReadyTimeout);
        d.browserTimeoutMs = num(j.browserTimeoutMs) ?? num(j.browserTimeout);
      } catch { /* not the line we wanted */ }
    }
  }
  if (!d.gpuMode) {
    const m = s.match(/browserGpuMode\s*(?:auto\s*(?:→|->)\s*)?["']?(hardware|software)["']?/i);
    if (m) d.gpuMode = m[1].toLowerCase() as 'hardware' | 'software';
  }
  return d;
}

/** Classify a native crash vs a timeout from the child's stderr + exit code.
 *  `exit null` + V8 isolate/snapshot symbols is the weak-machine crash we saw. */
export function classifyRenderCrash(
  stderr: string,
  code: number | null,
  timedOut: boolean,
): 'native_worker_crash' | 'timeout' | null {
  if (timedOut) return 'timeout';
  const s = String(stderr || '');
  if (
    /NewIsolate|SnapshotData|MultiIsolatePlatform|v8::internal|Segmentation fault|SIGSEGV|SIGABRT|Fatal error/i.test(s)
    && code !== 0
  ) return 'native_worker_crash';
  return null;
}

/** Best-effort: persist the full combined child log to `logPath`. Never throws
 *  (a diagnostics write must not fail the render). Returns the path or null. */
async function writeRenderLog(logPath: string | undefined, combined: string): Promise<string | null> {
  if (!logPath) return null;
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});
    await fs.writeFile(logPath, combined, 'utf8');
    return logPath;
  } catch {
    return null;
  }
}

/** Compact human line for a failure message / report, from parsed diagnostics. */
function diagnosticsSummary(d: RenderDiagnostics): string {
  const parts: string[] = [];
  if (d.gpuMode) parts.push(`gpu=${d.gpuMode}`);
  if (typeof d.totalRamGB === 'number') parts.push(`ram=${d.totalRamGB}GB`);
  if (d.workers) parts.push(`workers=${d.workers}`);
  if (d.crashSignature) parts.push(`crash=${d.crashSignature}`);
  return parts.join(' ');
}

export type RenderQuality = 'draft' | 'standard' | 'high';
export type RenderFormat = 'mp4' | 'webm';

export interface RenderCompositionParams {
  /** Absolute path to the composition project dir (holds index.html). */
  projectDirAbs: string;
  /** Absolute path for the rendered output (.mp4 / .webm). */
  outputAbsPath: string;
  quality?: RenderQuality;
  fps?: number;
  format?: RenderFormat;
  /** Optional `data-composition-variables` overrides (object keyed by id). */
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string }) => void;
  /** When set, the full combined child stdout+stderr is written here for
   *  diagnosis (path-sandboxed by the caller). */
  logPath?: string;
  /** Low-memory / no-GPU render profile: pin 1 worker + bump timeouts so a slow
   *  software render finishes instead of crashing/timing out. */
  constrained?: boolean;
}

export type RenderCompositionResult =
  | { ok: true; path: string; bytes: number; diagnostics?: RenderDiagnostics; logPath?: string }
  | { ok: false; errorCode: string; message: string; diagnostics?: RenderDiagnostics; logPath?: string };

function buildRenderArgs(p: RenderCompositionParams): string[] {
  const args = ['render', '--output', p.outputAbsPath];
  if (p.quality) args.push('--quality', p.quality);
  if (typeof p.fps === 'number') args.push('--fps', String(p.fps));
  if (p.format) args.push('--format', p.format);
  if (p.constrained) {
    args.push(
      '--low-memory-mode',
      '--workers', '1',
      '--protocol-timeout', String(CONSTRAINED_PROTOCOL_TIMEOUT_MS),
      '--player-ready-timeout', String(CONSTRAINED_PLAYER_READY_TIMEOUT_MS),
      '--browser-timeout', String(CONSTRAINED_BROWSER_TIMEOUT_MS),
    );
  }
  if (p.variables && Object.keys(p.variables).length) {
    args.push('--variables', JSON.stringify(p.variables));
  }
  return args;
}

/** Parse a HyperFrames `[Render:trace]` JSON line into a coarse progress event. */
function parseTraceLine(line: string): { phase: string; message: string } | null {
  const idx = line.indexOf('[Render:trace]');
  if (idx === -1) return null;
  const jsonStart = line.indexOf('{', idx);
  if (jsonStart === -1) return null;
  try {
    const trace = JSON.parse(line.slice(jsonStart)) as { phase?: unknown; status?: unknown };
    const phase = typeof trace.phase === 'string' ? trace.phase : 'render';
    const status = typeof trace.status === 'string' ? trace.status : '';
    return { phase: `render.${phase}`, message: status ? `${phase} ${status}` : phase };
  } catch {
    return null;
  }
}

/**
 * Render `projectDirAbs` to `outputAbsPath`. Path-sandbox validation is the
 * caller's (the tool's) responsibility — this backend trusts the absolute
 * paths it receives.
 */
export async function renderComposition(p: RenderCompositionParams): Promise<RenderCompositionResult> {
  const runner = resolveHyperframesRunner();
  if (!runner) {
    return {
      ok: false,
      errorCode: 'E_RENDER_RUNTIME_MISSING',
      message: 'Bundled Node runtime not found; cannot run the HyperFrames renderer.',
    };
  }

  // Confirm the project dir has a composition entry before spawning.
  const indexHtml = path.join(p.projectDirAbs, 'index.html');
  try {
    const st = await fs.stat(indexHtml);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return {
      ok: false,
      errorCode: 'E_RENDER_NO_COMPOSITION',
      message: `No index.html found in composition dir: ${p.projectDirAbs}`,
    };
  }

  await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true }).catch(() => {});

  const env = buildHyperframesEnv();
  const args = [runner.npxCli, '--yes', HYPERFRAMES_SPEC, ...buildRenderArgs(p)];

  return new Promise<RenderCompositionResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runner.node, args, {
        cwd: p.projectDirAbs,
        env,
        ...(p.signal ? { signal: p.signal } : {}),
      });
    } catch (err) {
      resolve({ ok: false, errorCode: 'E_RENDER_SPAWN', message: (err as Error).message });
      return;
    }

    const errChunks: string[] = [];
    const outChunks: string[] = [];
    let stdoutBuf = '';
    let settled = false;
    let timedOut = false;

    const renderTimeoutMs = p.constrained ? CONSTRAINED_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, renderTimeoutMs);

    const pumpProgress = (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const ev = parseTraceLine(line);
        if (ev) p.onProgress?.(ev);
      }
    };

    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      outChunks.push(s);
      pumpProgress(s);
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      errChunks.push(s);
      pumpProgress(s); // hyperframes routes some [Render:trace] lines to stderr
    });
    child.stdin?.end();

    const finish = (r: RenderCompositionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on('error', (err: Error) => {
      // Abort surfaces here as an AbortError; report it as such, not a crash.
      if (p.signal?.aborted) {
        finish({ ok: false, errorCode: 'E_RENDER_ABORTED', message: 'Render aborted.' });
        return;
      }
      finish({ ok: false, errorCode: 'E_RENDER_SPAWN', message: err.message });
    });

    child.on('close', async (code: number | null) => {
      const stdout = outChunks.join('');
      const stderr = errChunks.join('').trim();
      const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
      const diagnostics: RenderDiagnostics = {
        ...parseRenderDiagnostics(combined),
        totalRamGB: machineRamGB(),
        crashSignature: classifyRenderCrash(stderr, code, timedOut),
      };
      const logPath = (await writeRenderLog(p.logPath, combined)) ?? undefined;
      const withDiag = (r: RenderCompositionResult): RenderCompositionResult =>
        ({ ...r, diagnostics, ...(logPath ? { logPath } : {}) });
      const summary = diagnosticsSummary(diagnostics);

      if (timedOut) {
        finish(withDiag({ ok: false, errorCode: 'E_RENDER_TIMEOUT', message: `Render timed out after ${renderTimeoutMs}ms.${summary ? ` [${summary}]` : ''}` }));
        return;
      }
      if (p.signal?.aborted) {
        finish(withDiag({ ok: false, errorCode: 'E_RENDER_ABORTED', message: 'Render aborted.' }));
        return;
      }
      if (code !== 0) {
        const tail = stderr.slice(-RENDER_LOG_TAIL_CHARS);
        log.warn(`hyperframes render exited ${code}: ${redactPaths(tail.slice(-300))}${summary ? ` [${summary}]` : ''}`);
        return finish(withDiag({
          ok: false,
          errorCode: 'E_RENDER_FAILED',
          message: `HyperFrames render failed (exit ${code}).${summary ? ` [${summary}]` : ''}${logPath ? ` Full log: ${logPath}.` : ''} ${tail || 'No diagnostic output.'}`,
        }));
      }
      const st = await fs.stat(p.outputAbsPath).catch(() => null);
      if (!st || !st.isFile() || st.size === 0) {
        return finish(withDiag({
          ok: false,
          errorCode: 'E_RENDER_NO_OUTPUT',
          message: `Render reported success but no output file was produced at ${p.outputAbsPath}.`,
        }));
      }
      finish(withDiag({ ok: true, path: p.outputAbsPath, bytes: st.size }));
    });
  });
}

export type QaOp = 'lint' | 'inspect';

export type QaResult =
  | { ok: true; op: QaOp; findings: string; diagnostics?: RenderDiagnostics; logPath?: string }
  | { ok: false; errorCode: string; message: string; diagnostics?: RenderDiagnostics; logPath?: string };

/** Backstop for a wedged QA pass. `inspect` spawns headless Chrome to seek the
 *  timeline; a few minutes is generous. */
const QA_TIMEOUT_MS = 5 * 60 * 1000;

function withStrictCraftFindings(findings: string, craftFindings: CraftFinding[]): string {
  const blockingFindings = craftFindings.filter((f) => f.code === 'FONT_TOO_SMALL');
  if (!blockingFindings.length) return findings;
  try {
    const parsed = JSON.parse(findings) as Record<string, unknown>;
    const existingIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const craftIssues = blockingFindings.map((f) => ({
      code: f.code,
      severity: 'error',
      selector: 'document',
      message: f.message,
      fixHint: 'Raise all readable text to the video-craft legibility floor before rendering.',
      source: 'video-craft',
    }));
    const add = craftIssues.length;
    const numberField = (key: string) => (typeof parsed[key] === 'number' ? parsed[key] as number : 0);
    parsed.ok = false;
    parsed.errorCount = numberField('errorCount') + add;
    parsed.issueCount = numberField('issueCount') + add;
    parsed.totalIssueCount = numberField('totalIssueCount') + add;
    parsed.issues = [...existingIssues, ...craftIssues];
    return JSON.stringify(parsed, null, 2);
  } catch {
    return `${findings}\n\n[craft] BLOCKING strict checks:\n${blockingFindings.map((f) => `  - ${f.code}: ${f.message}`).join('\n')}`;
  }
}

/**
 * Run a HyperFrames QA pass (`lint` structural / `inspect` visual) over the
 * composition dir and return its `--json` findings. `inspect` seeks the rendered
 * layout in headless Chrome and reports text overflow / off-canvas / clipping —
 * a real visual check the model can act on, unlike re-reading its own HTML. No
 * ffmpeg needed. The findings are the product, so they are returned regardless
 * of exit code (a non-zero exit just means issues were found).
 */
export async function qaComposition(
  op: QaOp,
  p: {
    projectDirAbs: string;
    signal?: AbortSignal;
    strictCraft?: boolean;
    onProgress?: (event: { phase: string; message: string }) => void;
    logPath?: string;
    constrained?: boolean;
  },
): Promise<QaResult> {
  const runner = resolveHyperframesRunner();
  if (!runner) {
    return { ok: false, errorCode: 'E_RENDER_RUNTIME_MISSING', message: 'Bundled Node runtime not found.' };
  }
  const indexHtml = path.join(p.projectDirAbs, 'index.html');
  const st = await fs.stat(indexHtml).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, errorCode: 'E_RENDER_NO_COMPOSITION', message: `No index.html in: ${p.projectDirAbs}` };
  }

  const env = buildHyperframesEnv();
  const args = [runner.npxCli, '--yes', HYPERFRAMES_SPEC, op, '--json'];
  // inspect/lint only expose --timeout (runtime init); a slow machine needs longer.
  if (p.constrained) args.push('--timeout', String(CONSTRAINED_QA_INIT_TIMEOUT_MS));

  return new Promise<QaResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(runner.node, args, { cwd: p.projectDirAbs, env, ...(p.signal ? { signal: p.signal } : {}) });
    } catch (err) {
      resolve({ ok: false, errorCode: 'E_QA_SPAWN', message: (err as Error).message });
      return;
    }
    const out: string[] = [];
    const errOut: string[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, QA_TIMEOUT_MS);
    const startedAtMs = Date.now();
    const heartbeat = p.onProgress
      ? setInterval(() => p.onProgress?.({ phase: `qa.${op}`, message: `${op} running (${Math.round((Date.now() - startedAtMs) / 1000)}s elapsed)` }), QA_PROGRESS_HEARTBEAT_MS)
      : null;
    (heartbeat as { unref?: () => void } | null)?.unref?.();
    let traceBuf = '';
    const pumpTrace = (chunk: string) => {
      if (!p.onProgress) return;
      traceBuf += chunk;
      let nl: number;
      while ((nl = traceBuf.indexOf('\n')) !== -1) {
        const line = traceBuf.slice(0, nl);
        traceBuf = traceBuf.slice(nl + 1);
        const ev = parseTraceLine(line);
        if (ev) p.onProgress?.(ev);
      }
    };
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => { const s = c.toString('utf8'); errOut.push(s); pumpTrace(s); });
    child.stdin?.end();
    const finish = (r: QaResult) => { if (settled) return; settled = true; clearTimeout(timer); if (heartbeat) clearInterval(heartbeat); resolve(r); };
    child.on('error', (err: Error) => {
      if (p.signal?.aborted) return finish({ ok: false, errorCode: 'E_QA_ABORTED', message: `${op} aborted.` });
      finish({ ok: false, errorCode: 'E_QA_SPAWN', message: err.message });
    });
    child.on('close', async (code: number | null) => {
      if (timedOut) return finish({ ok: false, errorCode: 'E_QA_TIMEOUT', message: `${op} timed out.` });
      if (p.signal?.aborted) return finish({ ok: false, errorCode: 'E_QA_ABORTED', message: `${op} aborted.` });
      const findings = out.join('').trim();
      if (!findings) {
        const stderrFull = errOut.join('').trim();
        const combined = out.join('') + (stderrFull ? `\n--- stderr ---\n${stderrFull}` : '');
        const diagnostics: RenderDiagnostics = {
          ...parseRenderDiagnostics(combined),
          totalRamGB: machineRamGB(),
          crashSignature: classifyRenderCrash(stderrFull, code, false),
        };
        const logPath = (await writeRenderLog(p.logPath, combined)) ?? undefined;
        const summary = diagnosticsSummary(diagnostics);
        return finish({
          ok: false,
          errorCode: 'E_QA_NO_OUTPUT',
          message: `${op} produced no findings.${summary ? ` [${summary}]` : ''}${logPath ? ` Full log: ${logPath}.` : ''} ${stderrFull.slice(-RENDER_LOG_TAIL_CHARS) || 'No diagnostic output.'}`,
          diagnostics,
          ...(logPath ? { logPath } : {}),
        });
      }
      // Append advisory craft-threshold findings (pure static scan of the HTML).
      // Best-effort: a read failure must never fail the QA pass.
      let craft = '';
      let finalFindings = findings;
      try {
        const html = await fs.readFile(indexHtml, 'utf8');
        const craftFindings = lintCompositionCraft(html);
        if (p.strictCraft) finalFindings = withStrictCraftFindings(findings, craftFindings);
        craft = formatCraftFindings(craftFindings, { strict: !!p.strictCraft });
      } catch { /* advisory only; ignore */ }
      finish({ ok: true, op, findings: craft ? `${finalFindings}\n\n${craft}` : finalFindings });
    });
  });
}
