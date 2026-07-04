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
import * as path from 'node:path';
import { spawn } from 'node:child_process';

// Single source of truth for the bundled-node + npx + env (incl. the pinned
// HYPERFRAMES_SPEC). render/inspect, transcribe, and tts all share it so the
// hyperframes version can never drift between them.
import { HYPERFRAMES_SPEC, resolveHyperframesRunner, buildHyperframesEnv } from './hyperframes_runtime';
import { lintCompositionCraft, formatCraftFindings } from './video_craft_lint';
import { redactPaths } from './redact';
import { createLogger } from './logger-shim';

const log = createLogger('video-render');

/** Backstop kill for a wedged render that emits nothing. Long renders are
 *  legitimate, so this is generous; normal completion / user abort happen far
 *  sooner via ctx.signal. */
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;

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
}

export type RenderCompositionResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; errorCode: string; message: string };

function buildRenderArgs(p: RenderCompositionParams): string[] {
  const args = ['render', '--output', p.outputAbsPath];
  if (p.quality) args.push('--quality', p.quality);
  if (typeof p.fps === 'number') args.push('--fps', String(p.fps));
  if (p.format) args.push('--format', p.format);
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
    let stdoutBuf = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RENDER_TIMEOUT_MS);

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

    child.stdout?.on('data', (c: Buffer) => pumpProgress(c.toString('utf8')));
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
      if (timedOut) {
        finish({ ok: false, errorCode: 'E_RENDER_TIMEOUT', message: `Render timed out after ${RENDER_TIMEOUT_MS}ms.` });
        return;
      }
      if (p.signal?.aborted) {
        finish({ ok: false, errorCode: 'E_RENDER_ABORTED', message: 'Render aborted.' });
        return;
      }
      if (code !== 0) {
        const stderr = errChunks.join('').trim();
        const tail = stderr.slice(-1500);
        log.warn(`hyperframes render exited ${code}: ${redactPaths(tail.slice(-300))}`);
        return finish({
          ok: false,
          errorCode: 'E_RENDER_FAILED',
          message: `HyperFrames render failed (exit ${code}). ${tail || 'No diagnostic output.'}`,
        });
      }
      const st = await fs.stat(p.outputAbsPath).catch(() => null);
      if (!st || !st.isFile() || st.size === 0) {
        return finish({
          ok: false,
          errorCode: 'E_RENDER_NO_OUTPUT',
          message: `Render reported success but no output file was produced at ${p.outputAbsPath}.`,
        });
      }
      finish({ ok: true, path: p.outputAbsPath, bytes: st.size });
    });
  });
}

export type QaOp = 'lint' | 'inspect';

export type QaResult =
  | { ok: true; op: QaOp; findings: string }
  | { ok: false; errorCode: string; message: string };

/** Backstop for a wedged QA pass. `inspect` spawns headless Chrome to seek the
 *  timeline; a few minutes is generous. */
const QA_TIMEOUT_MS = 5 * 60 * 1000;

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
  p: { projectDirAbs: string; signal?: AbortSignal },
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
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => errOut.push(c.toString('utf8')));
    child.stdin?.end();
    const finish = (r: QaResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    child.on('error', (err: Error) => {
      if (p.signal?.aborted) return finish({ ok: false, errorCode: 'E_QA_ABORTED', message: `${op} aborted.` });
      finish({ ok: false, errorCode: 'E_QA_SPAWN', message: err.message });
    });
    child.on('close', async () => {
      if (timedOut) return finish({ ok: false, errorCode: 'E_QA_TIMEOUT', message: `${op} timed out.` });
      if (p.signal?.aborted) return finish({ ok: false, errorCode: 'E_QA_ABORTED', message: `${op} aborted.` });
      const findings = out.join('').trim();
      if (!findings) {
        const stderr = errOut.join('').trim().slice(-1000);
        return finish({ ok: false, errorCode: 'E_QA_NO_OUTPUT', message: `${op} produced no findings. ${stderr}` });
      }
      // Append advisory craft-threshold findings (pure static scan of the HTML).
      // Best-effort: a read failure must never fail the QA pass.
      let craft = '';
      try {
        const html = await fs.readFile(indexHtml, 'utf8');
        craft = formatCraftFindings(lintCompositionCraft(html));
      } catch { /* advisory only; ignore */ }
      finish({ ok: true, op, findings: craft ? `${findings}\n\n${craft}` : findings });
    });
  });
}
