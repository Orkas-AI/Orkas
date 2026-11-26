/** Authorize native Chromium file selection; file bytes never enter host/model IPC. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WS_ROOT } from '../paths';
import { isPathAllowed, resolveSandboxRoot } from '../util/path-sandbox';
import { chatAttachmentDirForConversation, conversationLayout } from '../util/project-layout';
import { getWorkspacePath } from './user_workspace';
import { readConversationAuthoringDir } from './group_chat/conv_workspace';

export interface WebAssistUploadFile { name: string; path: string; directory: boolean }

export async function verifyWebAssistDirectoryFiles(
  userId: string, conversationId: string, directory: string, files: string[], signal: AbortSignal,
): Promise<void> {
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('invalid_upload_files');
    const relative = path.relative(directory, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('upload_outside_task');
    }
  }
  const selected = await loadWebAssistUploadFiles(userId, conversationId, files, signal);
  if (selected.some(file => file.directory)) throw new Error('upload_file_type');
}

export async function loadWebAssistUploadFiles(
  userId: string, conversationId: string, paths: unknown, signal?: AbortSignal,
): Promise<WebAssistUploadFile[]> {
  if (!Array.isArray(paths) || !paths.length
    || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('invalid_upload_files');
  const layout = conversationLayout(userId, conversationId);
  const roots = [getWorkspacePath(userId, layout.projectId || undefined),
    chatAttachmentDirForConversation(userId, conversationId), await readConversationAuthoringDir(userId, conversationId)].filter(Boolean).map(resolveSandboxRoot);
  const files: WebAssistUploadFile[] = [];
  for (const candidate of paths as string[]) {
    signal?.throwIfAborted();
    const real = await fs.promises.realpath(candidate);
    const allowed = isPathAllowed(candidate, roots, { rootsResolved: true });
    if (WS_ROOT && isPathAllowed(real, [WS_ROOT]) && !isPathAllowed(real, roots, { rootsResolved: true })) throw new Error('upload_outside_task');
    if (!allowed) throw new Error('upload_outside_task');
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('upload_file_type');
    if (stat.isDirectory()) {
      // Chromium traverses directory controls itself. Check metadata only so a
      // symlink inside an authorized directory cannot expose foreign files.
      const pending = [real];
      const visited = new Set<string>();
      while (pending.length) {
        signal?.throwIfAborted();
        const directory = pending.pop()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        for await (const entry of await fs.promises.opendir(directory)) {
          signal?.throwIfAborted();
          const child = path.join(directory, entry.name);
          // Non-symlink entries inherit the checked real parent. Only links
          // need another realpath/stat; ordinary files never load their bytes.
          if (entry.isDirectory()) { pending.push(child); continue; }
          if (entry.isFile()) continue;
          if (!entry.isSymbolicLink()) throw new Error('upload_file_type');
          const childReal = await fs.promises.realpath(child);
          if (!isPathAllowed(childReal, roots, { rootsResolved: true })) throw new Error('upload_outside_task');
          if (WS_ROOT && isPathAllowed(childReal, [WS_ROOT]) && !isPathAllowed(childReal, roots, { rootsResolved: true })) throw new Error('upload_outside_task');
          const childStat = await fs.promises.stat(childReal);
          if (childStat.isDirectory()) pending.push(childReal);
          else if (!childStat.isFile()) throw new Error('upload_file_type');
        }
      }
    }
    files.push({ name: path.basename(candidate), path: real, directory: stat.isDirectory() });
  }
  return files;
}
