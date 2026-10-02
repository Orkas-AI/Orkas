/** Copy one explicitly selected, conversation-scoped file into a todo. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathAllowed } from '../util/path-sandbox';
import { chatAttachmentDirForConversation } from '../util/project-layout';
import { getWorkspacePath } from './user_workspace';
import { getActiveUserId } from './users';
import { ALLOWED_EXTENSIONS } from './chat_attachments';
import { sanitiseTaskAttachmentName } from './project_task_record';
import { getTask, uploadTaskAttachment, TASK_ATTACHMENT_MAX_BYTES, type ProjectTask } from './project_tasks';

export async function addTaskAttachmentFromPath(
  uid: string, pid: string, cid: string, taskId: string, sourcePath: string,
  context: { sourceProjectId?: string; workingDir?: string } = {},
): Promise<{ ok: true; task: ProjectTask } | { ok: false; error: string }> {
  const fail = (error: string) => ({ ok: false as const, error });
  if (getActiveUserId() !== uid) return fail('account_changed');
  const task = await getTask(uid, pid, taskId);
  if (!task) return fail('task_not_found');
  const roots = [context.workingDir || getWorkspacePath(uid, context.sourceProjectId ?? pid),
    ...(cid ? [chatAttachmentDirForConversation(uid, cid)] : [])];
  if (!isPathAllowed(sourcePath, roots)) return fail('source_path must be inside the current workspace or conversation attachments');
  const name = path.basename(sourcePath);
  if (sanitiseTaskAttachmentName(name) !== name) return fail('invalid_attachment_name');
  if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) return fail('unsupported_attachment_type');
  // Preserve existing attachments even when their cached names outlive the file.
  if (task.attachments?.includes(name)) return fail('attachment_already_exists');

  let body: Buffer;
  try {
    const resolved = await fs.realpath(sourcePath);
    if (!isPathAllowed(resolved, roots)) return fail('attachment_source_out_of_scope');
    if (!(await fs.stat(resolved)).isFile()) return fail('attachment_source_must_be_file');
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return fail('attachment_source_must_be_file');
      if (stat.size > TASK_ATTACHMENT_MAX_BYTES) return fail('attachment_exceeds_200_MiB');
      // Read a fixed-size buffer so a concurrently growing file cannot exceed the cap.
      body = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
        if (!bytesRead) return fail('attachment_source_changed');
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return fail('attachment_source_changed');
    } finally { await handle.close(); }
  } catch { return fail('attachment_source_read_failed'); }

  if (getActiveUserId() !== uid) return fail('account_changed');
  if (!await getTask(uid, pid, taskId)) return fail('task_not_found');
  try {
    const saved = await uploadTaskAttachment(uid, pid, taskId, name, body, { overwrite: false });
    if (saved.ok === false) return saved;
    const updated = await getTask(uid, pid, taskId);
    return updated ? { ok: true, task: updated } : fail('task_not_found');
  } catch { return fail('attachment_save_failed'); }
}
