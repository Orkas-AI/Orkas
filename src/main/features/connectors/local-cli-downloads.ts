import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPathAllowed } from '../../util/path-sandbox';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';

const log = createLogger('connectors:local-cli-downloads');

/** Download receipts use the pinned Lark message-resource contract. Other
 * provider actions are left untouched; names alone do not authorize file IO. */
export function isLarkMessageDownload(name: string, args: Record<string, unknown>): boolean {
  return name === 'execute_write' && typeof args.action === 'string'
    && args.action.trim().split(/[. ]+/).join('.') === 'im.+messages-resources-download';
}

export async function receiveLocalCliDownload(
  userId: string,
  conversationId: string | undefined,
  invoke: (directory: string) => Promise<unknown>,
  assertActive: () => void,
): Promise<unknown> {
  if (!conversationId || conversationId.includes('/') || conversationId.includes('\\')
      || conversationId.includes('\0') || conversationId === '.' || conversationId === '..') {
    throw new Error('A current conversation is required to receive this download.');
  }
  assertActive();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-cli-download-')).catch(() => {
    throw new Error('A temporary directory could not be created for this download.');
  });
  try {
    assertActive();
    const raw = await invoke(directory);
    assertActive();
    if (raw && typeof raw === 'object' && (raw as { isError?: boolean }).isError) return raw;
    const receipt = raw as { content?: Array<{ type?: string; text?: string }> } | null;
    const text = receipt?.content?.find(part => part.type === 'text' && typeof part.text === 'string');
    let payload;
    try { payload = JSON.parse(text?.text || ''); }
    catch { throw new Error('The download did not return a valid file receipt.'); }
    const data = payload?.result?.data;
    const source = data?.saved_path;
    if (payload?.result?.ok !== true || typeof source !== 'string'
        || !Number.isSafeInteger(data?.size_bytes) || data.size_bytes < 0) {
      throw new Error('The download did not return a complete file receipt.');
    }
    const sourcePath = path.resolve(directory, source);
    if (!isPathAllowed(sourcePath, [directory])) throw new Error('The download returned a file outside its staging directory.');
    const stat = await fs.lstat(sourcePath).catch(() => {
      throw new Error('The downloaded file is unavailable.');
    });
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== data.size_bytes) {
      throw new Error('The downloaded file could not be verified.');
    }
    assertActive();
    // Reuse attachment locking, size/type limits, project layout, atomic
    // publication, collision handling and cloud-sync ownership.
    const attachments = await import('../chat_attachments');
    assertActive();
    const imported = await attachments.importAttachmentFromPath(userId, conversationId, sourcePath);
    if (!imported.ok) throw new Error('The downloaded file could not be saved as a conversation attachment.');
    const resolved = attachments.resolveAttachmentAbsPath(userId, conversationId, imported.info.name);
    if (!resolved.ok) throw new Error('The downloaded attachment could not be opened.');
    attachments.recordGeneratedAttachment(userId, conversationId, resolved.absPath);
    data.saved_path = resolved.absPath;
    data.size_bytes = imported.info.bytes;
    return {
      ...receipt,
      content: receipt!.content!.map(part => part === text ? { ...part, text: JSON.stringify(payload, null, 2) } : part),
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(error => {
      // Publication may already be durable. Cleanup must preserve the receipt
      // (or the provider's original failure), so callers never replay it.
      const { message_hash, message_chars } = logErrorSummary(error);
      log.warn('temporary download cleanup failed', { error: { message_hash, message_chars } });
    });
  }
}
