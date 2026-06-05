/**
 * `generate_image` tool — produces an image with whatever image-gen-capable
 * api_key entry sits highest in the user's auth-profiles priority list.
 *
 * Permission gating: same as `bash` / `write_file` (`localExec.granted`).
 * Reuses `localExec` rather than introducing a parallel switch — the user's
 * mental model is "let this app touch my machine" and writing image bytes
 * to a workspace path is the same blast radius as `write_file`.
 *
 * Path scope: same sandbox as `read_file` / `write_file`
 * (active workspace ∪ current cid's attachment dir). `output_path` and every
 * `reference_images` entry pass through `util/path-sandbox.isPathAllowed`.
 *
 * On success fires `onFileWritten(absPath)` so the caller (chats.ts) can
 * surface a produced-files chip on the assistant message — same path the
 * other write tools use.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import { generateImage } from '../../features/image_gen';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDir } from '../../paths';
import { createLogger } from '../../logger';

const log = createLogger('image-gen-tool');

const DENY_MESSAGE =
  'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so command execution, file writes, PDFs, images, and local artifacts were not created. ' +
  'Ask the user to open Settings > Tool Execution Access and enable "Enable Tool Execution Access", then retry. ' +
  'Do not claim any file, PDF, image, or interactive app has already been created.';

export interface ImageGenToolOpts {
  userId: string;
  /** Conversation id — extends the path sandbox to allow writing into
   *  the conv's attachment dir (and reading reference images from it). */
  cid?: string;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat so workspace resolution picks up
   *  the project-scoped selection (per CLAUDE.md projects feature). */
  projectId?: string;
  /** Same contract as `local-tools.LocalToolsOpts.onFileWritten`. */
  onFileWritten?: (absPath: string) => void;
  /** Same contract as `local-tools.LocalToolsOpts.hasProducedPath`:
   *  caller-supplied predicate that returns true when this path was
   *  already written by the same caller this turn (refinement → overwrite
   *  in place). When false / absent, foreign collisions trigger uniquify. */
  hasProducedPath?: (absPath: string) => boolean;
}

function allowedRoots(opts: ImageGenToolOpts): string[] {
  const roots: string[] = [];
  try {
    const ws = getWorkspacePath(opts.userId, opts.projectId);
    if (ws) roots.push(ws);
  } catch (err) { log.warn(`resolve workspace: ${(err as Error).message}`); }
  if (opts.cid) {
    try { roots.push(chatAttachmentDir(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir: ${(err as Error).message}`); }
  }
  return roots;
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

export function createImageGenTool(opts: ImageGenToolOpts): AgentTool {
  return {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it to a file. '
      + 'Uses whichever provider in the user\'s configured API keys supports image generation '
      + '(currently OpenAI gpt-image, Google Gemini image, or Doubao Seedream). '
      + 'Optionally accepts reference images for editing or variations. '
      + 'After a successful call, present the result to the user with markdown: '
      + '`![<short alt>](chat-media://local/<absolute path returned>)`.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Image description. Be specific about subject, style, composition, lighting.',
        },
        output_path: {
          type: 'string',
          description:
            'Where to write the image. Absolute path or relative to the workspace. '
            + 'Must fall inside the workspace or the current conversation\'s attachment dir. '
            + 'Extension (.png/.jpg/.webp) is optional — added automatically based on the returned format. '
            + 'If the target already exists and was not written by you this turn, the basename is '
            + 'automatically suffixed (`-2 / -3 / ...`); the rename is surfaced in a `<file-renamed>` '
            + 'block in the tool result. Always use the saved path verbatim for any follow-up reads '
            + 'or markdown image links.',
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional absolute paths to reference images for editing/variations. '
            + 'Each must fall inside the same scope as `output_path`. Up to 4.',
        },
        size: {
          type: 'string',
          description: 'Provider size hint. One of: 1024x1024 (default), 1536x1024, 1024x1536, auto.',
        },
      },
      required: ['prompt', 'output_path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) {
        return { content: DENY_MESSAGE, isError: true } as ToolResult;
      }

      const prompt = String(input.prompt ?? '').trim();
      const outputPathRaw = String(input.output_path ?? '').trim();
      if (!prompt)         return { content: 'prompt is required', isError: true } as ToolResult;
      if (!outputPathRaw)  return { content: 'output_path is required', isError: true } as ToolResult;

      // Resolve the requested path, then run conflict-uniquify against
      // the caller's `hasProducedPath` predicate (if any). Done before
      // the sandbox check so the resolved path used for both the check
      // and the write is the same one returned in the tool result.
      const requestedAbs = resolveAbs(ctx, outputPathRaw);
      const isMine: (p: string) => boolean = opts.hasProducedPath
        ? (p) => opts.hasProducedPath!(p)
        : () => false;
      const { finalPath: outputAbs, renamed } = await uniquifyPath(requestedAbs, isMine);
      const roots = allowedRoots(opts);
      if (!isPathAllowed(outputAbs, roots)) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: output_path is outside the current scope (workspace + attachments): ${outputAbs}`,
          isError: true,
        } as ToolResult;
      }

      const referenceImages: string[] = Array.isArray(input.reference_images)
        ? (input.reference_images as unknown[]).map(String).filter(Boolean)
        : [];
      if (referenceImages.length > 4) {
        return { content: 'reference_images: at most 4 entries allowed', isError: true } as ToolResult;
      }
      const refAbs: string[] = [];
      for (const r of referenceImages) {
        const abs = resolveAbs(ctx, r);
        if (!isPathAllowed(abs, roots)) {
          return {
            content: `E_PATH_OUT_OF_SCOPE: reference image is outside the current scope: ${abs}`,
            isError: true,
          } as ToolResult;
        }
        if (!fs.existsSync(abs)) {
          return { content: `Reference image not found: ${abs}`, isError: true } as ToolResult;
        }
        refAbs.push(abs);
      }

      const sizeRaw = typeof input.size === 'string' ? input.size : undefined;

      const result = await generateImage({
        prompt,
        outputAbsPath: outputAbs,
        ...(refAbs.length ? { referenceImagePaths: refAbs } : {}),
        ...(sizeRaw ? { size: sizeRaw } : {}),
      });

      if (result.ok === false) {
        return { content: `[${result.errorCode}] ${result.message}`, isError: true } as ToolResult;
      }

      if (opts.onFileWritten) {
        try { opts.onFileWritten(result.path); }
        catch (err) { log.warn(`onFileWritten callback failed: ${(err as Error).message}`); }
      }

      const summary =
        `Image written to ${result.path} `
        + `(${result.width}x${result.height}, ${result.bytes} bytes, ${result.provider}/${result.model}). `
        + `Show it to the user with: ![<alt>](chat-media://local/${result.path})`;
      const content = renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary;
      return { content } as ToolResult;
    },
  };
}
