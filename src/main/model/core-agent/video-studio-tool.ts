/**
 * VideoStudio-owned native runtime tool.
 *
 * This intentionally covers only the VideoStudio dependency points that need
 * to be native:
 * HTML composition render/lint/inspect and speech transcription. The rest of
 * VideoStudio's agent-private scripts stay script-owned.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import {
  draftComposition,
  inspectComposition,
  lintComposition,
  renderComposition,
  snapshotComposition,
  transcribeSpeech,
  type RenderFormat,
  type RenderQuality,
  type VideoStudioOp,
} from '../../features/video_studio';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDir } from '../../paths';
import { createLogger } from '../../logger';

const log = createLogger('video-studio-tool');

const DENY_MESSAGE =
  'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so VideoStudio native rendering/transcription was not run.';

export interface VideoStudioToolOpts {
  userId: string;
  cid?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  hasProducedPath?: (absPath: string) => boolean;
}

const OPS = new Set<VideoStudioOp>([
  'composition.lint',
  'composition.inspect',
  'composition.render',
  'composition.draft',
  'composition.snapshot',
  'speech.transcribe',
]);

function allowedRoots(opts: VideoStudioToolOpts): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try { push(getWorkspacePath(opts.userId)); }
  catch (err) { log.warn(`resolve workspace failed: ${(err as Error).message}`); }
  if (opts.projectId) {
    try { push(getWorkspacePath(opts.userId, opts.projectId)); }
    catch (err) { log.warn(`resolve project workspace failed: ${(err as Error).message}`); }
  }
  if (opts.cid) {
    try { push(chatAttachmentDir(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir failed: ${(err as Error).message}`); }
  }
  for (const root of opts.extraRoots || []) push(root);
  return roots;
}

function isProjectRelativePath(p: string): boolean {
  const first = p.replace(/\\/g, '/').split('/').find(Boolean);
  return first === 'project';
}

function defaultRoot(opts: VideoStudioToolOpts, ctx: ToolContext): string {
  if (ctx.workingDir) return ctx.workingDir;
  try { return getWorkspacePath(opts.userId, opts.projectId); }
  catch { return '.'; }
}

function resolvePath(ctx: ToolContext, opts: VideoStudioToolOpts, raw: string, roots: string[]): string {
  const value = String(raw || '').trim();
  if (path.isAbsolute(value)) return path.resolve(value);
  if (ctx.workingDir && isProjectRelativePath(value)) {
    const candidate = path.resolve(ctx.workingDir, value);
    if (isPathAllowed(candidate, roots)) return candidate;
  }
  return path.resolve(defaultRoot(opts, ctx), value);
}

function withExtension(absPath: string, ext: string): string {
  return path.extname(absPath) ? absPath : `${absPath}.${ext.replace(/^\./, '')}`;
}

async function ensureInputFile(absPath: string): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  return st && st.isFile() ? null : `input is not a file: ${absPath}`;
}

async function ensureInputDir(absPath: string): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  return st && st.isDirectory() ? null : `composition_dir is not a directory: ${absPath}`;
}

async function notifyWritten(opts: VideoStudioToolOpts, paths: Array<unknown>): Promise<void> {
  if (!opts.onFileWritten) return;
  const seen = new Set<string>();
  for (const value of paths) {
    if (typeof value !== 'string' || !value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try { await opts.onFileWritten(abs); }
    catch (err) { log.warn(`onFileWritten failed: ${(err as Error).message}`); }
  }
}

function resultContent(result: Record<string, unknown>, renamedNote = ''): string {
  return `${JSON.stringify(result, null, 2)}${renamedNote}`;
}

export function createVideoStudioTool(opts: VideoStudioToolOpts): AgentTool {
  return {
    name: 'video_studio',
    description:
      'VideoStudio-native runtime for HTML video compositions and speech transcription. Use composition.* for Orkas-native composition lint/inspect/draft/render/snapshot, and speech.transcribe for Orkas-native transcription. Marketplace min_app_version enforces app compatibility before this agent is installed.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [...OPS],
          description: 'Operation: composition.lint, composition.inspect, composition.render, composition.draft, composition.snapshot, or speech.transcribe.',
        },
        composition_dir: { type: 'string', description: 'Directory containing index.html for composition.* ops.' },
        output_path: { type: 'string', description: 'Output video path for composition.render/draft, or snapshot path for composition.snapshot.' },
        report_path: { type: 'string', description: 'Optional JSON report path for composition.draft.' },
        findings_path: { type: 'string', description: 'Optional findings JSON path for composition.inspect/draft.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality; draft uses lower fps/CRF.' },
        fps: { type: 'number', description: 'Frames per second, capped at 60.' },
        format: { type: 'string', enum: ['mp4', 'webm'], description: 'Output video format. Default mp4.' },
        variables: { type: 'object', description: 'Optional composition variables exposed as window.__ORKAS_VIDEO_VARIABLES__.' },
        input_path: { type: 'string', description: 'Input audio/video path for speech.transcribe.' },
        transcript_path: { type: 'string', description: 'Optional transcript JSON output path for speech.transcribe.' },
        model: { type: 'string', description: 'ASR model id/path. Backend-specific.' },
        language: { type: 'string', description: 'ASR language code, or auto.' },
        timestamps: { type: 'string', enum: ['segment', 'word'], description: 'ASR timestamp detail.' },
        allow_model_download: { type: 'boolean', description: 'Whether native ASR may download a missing model. Backend-specific.' },
      },
      required: ['op'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) {
        return { content: DENY_MESSAGE, isError: true } as ToolResult;
      }

      const op = String(input.op || '').trim() as VideoStudioOp;
      if (!OPS.has(op)) {
        return { content: `op must be one of: ${[...OPS].join(', ')}`, isError: true } as ToolResult;
      }

      const roots = allowedRoots(opts);

      if (op.startsWith('composition.')) {
        const compositionRaw = String(input.composition_dir || '').trim();
        if (!compositionRaw) return { content: 'composition_dir is required', isError: true } as ToolResult;
        const compositionDirAbs = resolvePath(ctx, opts, compositionRaw, roots);
        if (!isPathAllowed(compositionDirAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: composition_dir is outside scope: ${compositionDirAbs}`, isError: true } as ToolResult;
        }
        const dirErr = await ensureInputDir(compositionDirAbs);
        if (dirErr) return { content: dirErr, isError: true } as ToolResult;

        const format = input.format === 'webm' ? 'webm' as RenderFormat : 'mp4' as RenderFormat;
        const quality = (input.quality === 'standard' || input.quality === 'high' || input.quality === 'draft')
          ? input.quality as RenderQuality
          : undefined;
        const fps = typeof input.fps === 'number' ? input.fps : undefined;
        const variables = input.variables && typeof input.variables === 'object' && !Array.isArray(input.variables)
          ? input.variables as Record<string, unknown>
          : undefined;

        let outputAbsPath: string | undefined;
        let requestedOutput = '';
        let renamed = false;
        if (op === 'composition.render' || op === 'composition.draft') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required', isError: true } as ToolResult;
          requestedOutput = withExtension(resolvePath(ctx, opts, outputRaw, roots), format);
          if (!isPathAllowed(requestedOutput, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${requestedOutput}`, isError: true } as ToolResult;
          }
          const isMine = opts.hasProducedPath ? (p: string) => opts.hasProducedPath!(p) : () => false;
          const unique = await uniquifyPath(requestedOutput, isMine);
          outputAbsPath = unique.finalPath;
          renamed = unique.renamed;
        } else if (op === 'composition.snapshot') {
          const outputRaw = String(input.output_path || '').trim();
          if (!outputRaw) return { content: 'output_path is required for composition.snapshot', isError: true } as ToolResult;
          outputAbsPath = withExtension(resolvePath(ctx, opts, outputRaw, roots), 'png');
          if (!isPathAllowed(outputAbsPath, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope: ${outputAbsPath}`, isError: true } as ToolResult;
          }
        }

        const reportAbsPath = typeof input.report_path === 'string' && input.report_path.trim()
          ? resolvePath(ctx, opts, input.report_path, roots)
          : undefined;
        if (reportAbsPath && !isPathAllowed(reportAbsPath, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: report_path is outside scope: ${reportAbsPath}`, isError: true } as ToolResult;
        }
        const findingsAbsPath = typeof input.findings_path === 'string' && input.findings_path.trim()
          ? resolvePath(ctx, opts, input.findings_path, roots)
          : undefined;
        if (findingsAbsPath && !isPathAllowed(findingsAbsPath, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: findings_path is outside scope: ${findingsAbsPath}`, isError: true } as ToolResult;
        }

        const common = {
          compositionDirAbs,
          ...(outputAbsPath && op !== 'composition.snapshot' ? { outputAbsPath } : {}),
          ...(outputAbsPath && op === 'composition.snapshot' ? { snapshotAbsPath: outputAbsPath } : {}),
          ...(reportAbsPath ? { reportAbsPath } : {}),
          ...(findingsAbsPath ? { findingsAbsPath } : {}),
          ...(quality ? { quality } : {}),
          ...(typeof fps === 'number' ? { fps } : {}),
          format,
          ...(variables ? { variables } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (event: { phase: string; message: string; data?: Record<string, unknown> }) => ctx.emitProgress?.(event),
        };
        const result = op === 'composition.lint'
          ? await lintComposition(common)
          : op === 'composition.inspect'
            ? await inspectComposition(common)
            : op === 'composition.snapshot'
              ? await snapshotComposition(common)
              : op === 'composition.draft'
                ? await draftComposition(common)
                : await renderComposition(common);

        if (result.ok) {
          await notifyWritten(opts, [
            result.path,
            result.report_path,
            result.findings_path,
          ]);
        }
        const renameNote = renamed && outputAbsPath ? renderRenameSignal(requestedOutput, outputAbsPath) : '';
        return { content: resultContent(result, renameNote), isError: result.ok === false } as ToolResult;
      }

      const inputRaw = String(input.input_path || '').trim();
      if (!inputRaw) return { content: 'input_path is required for speech.transcribe', isError: true } as ToolResult;
      const inputAbsPath = resolvePath(ctx, opts, inputRaw, roots);
      if (!isPathAllowed(inputAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside scope: ${inputAbsPath}`, isError: true } as ToolResult;
      }
      const fileErr = await ensureInputFile(inputAbsPath);
      if (fileErr) return { content: fileErr, isError: true } as ToolResult;

      const transcriptAbsPath = typeof input.transcript_path === 'string' && input.transcript_path.trim()
        ? resolvePath(ctx, opts, input.transcript_path, roots)
        : undefined;
      if (transcriptAbsPath && !isPathAllowed(transcriptAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: transcript_path is outside scope: ${transcriptAbsPath}`, isError: true } as ToolResult;
      }
      const result = await transcribeSpeech({
        inputAbsPath,
        ...(transcriptAbsPath ? { transcriptAbsPath } : {}),
        ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
        ...(typeof input.language === 'string' && input.language.trim() ? { language: input.language.trim() } : {}),
        timestamps: input.timestamps === 'segment' ? 'segment' : 'word',
        allowModelDownload: input.allow_model_download === true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (event) => ctx.emitProgress?.(event),
      });
      if (result.ok) await notifyWritten(opts, [result.transcript_path]);
      return { content: resultContent(result), isError: result.ok === false } as ToolResult;
    },
  };
}
