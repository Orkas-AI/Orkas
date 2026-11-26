/**
 * Reading a file outside a tool's own roots follows the user's local-access setting, the
 * same way the file tools do (`gatePathAccess` in file-tools.ts):
 *
 * - `workspace_approval` keeps work to the workspace and attachments: refused;
 * - `all_files_approval` (the default) reads anywhere, asking first for a sensitive path
 *   (Desktop, Documents, Downloads, keys and credentials), with the folder grant the
 *   standard prompt offers;
 * - `all_files_auto` reads anywhere without asking.
 *
 * Only the user's own files: Orkas's data folder (other conversations' attachments, other
 * projects, settings) stays outside, whatever the setting, as it was for these tools.
 * Only reads: a tool still writes inside its own roots.
 */
import type { ToolContext } from '#core-agent';
import { localAccessAllowsOutsideWorkspace, localAccessRequiresSensitiveApproval } from '../../features/permissions';
import { locationOnlyRead, sensitivePathReasons } from '../../features/local_access_policy';
import { isPathAllowed, resolveSandboxRoot } from '../../util/path-sandbox';
import { WS_ROOT } from '../../paths';
import { requestBashDecision } from './bash-permissions';

export interface OutsideReadRequest {
  userId: string;
  cid?: string;
  agentId?: string;
  agentName?: string;
  /** The tool's own readable roots; a path inside them needs nothing more. */
  roots: readonly string[];
  abs: string;
  /** The operation the approval prompt names, as the file tools name theirs, e.g. "video.import". */
  operation: string;
  ctx?: ToolContext;
}

export type OutsideReadResult =
  | { ok: true }
  | { ok: false; code: 'E_PATH_OUT_OF_SCOPE' | 'E_SENSITIVE_PATH_DENIED'; message: string };

function waitingProgress(ctx: ToolContext | undefined, operation: string): (elapsedMs: number) => void {
  return (elapsedMs: number) => {
    ctx?.emitProgress?.({
      phase: 'permission',
      message: `Waiting for user approval for ${operation}`,
      data: { heartbeat: true, userAction: true, elapsedMs, timeoutMs: elapsedMs + 60_000 },
    });
  };
}

/** The setting as it stands; when it cannot be read, the workspace-only answer. */
function accessSetting(): { outside: boolean; ask: boolean } {
  try {
    return { outside: localAccessAllowsOutsideWorkspace(), ask: localAccessRequiresSensitiveApproval() };
  } catch {
    return { outside: false, ask: true };
  }
}

export async function gateOutsideRead(request: OutsideReadRequest): Promise<OutsideReadResult> {
  const { abs, roots, operation } = request;
  if (roots.length && isPathAllowed(abs, roots)) return { ok: true };
  if (isPathAllowed(abs, [WS_ROOT])) {
    return {
      ok: false,
      code: 'E_PATH_OUT_OF_SCOPE',
      message: `${abs} is in Orkas's own data, such as another conversation or project, not in this conversation's files. Ask the user to attach it.`,
    };
  }
  const setting = accessSetting();
  if (!setting.outside) {
    return {
      ok: false,
      code: 'E_PATH_OUT_OF_SCOPE',
      message: `${abs} is outside this conversation's files, and the access setting only allows workspace files. Ask the user to attach it, or to allow files outside the workspace in Settings.`,
    };
  }
  if (!setting.ask) return { ok: true };
  // This is already outside the real readable roots. Check both the name
  // supplied by the user and its filesystem destination before granting access.
  let subject = abs;
  let reasons = sensitivePathReasons(subject, 'read');
  if (!reasons.length) {
    const resolved = resolveSandboxRoot(abs);
    if (resolved === abs) return { ok: true };
    subject = resolved;
    reasons = sensitivePathReasons(subject, 'read');
  }
  if (!reasons.length) return { ok: true };
  const folderRead = locationOnlyRead(subject);
  const decision = await requestBashDecision({
    uid: request.userId,
    cid: request.cid ?? '',
    agentId: request.agentId ?? '',
    agentName: request.agentName ?? request.agentId ?? '',
    command: '',
    operation,
    subject,
    reasons,
    ...(folderRead ? { folderRead } : {}),
    onWaiting: waitingProgress(request.ctx, operation),
  });
  if (decision !== 'deny') return { ok: true };
  return {
    ok: false,
    code: 'E_SENSITIVE_PATH_DENIED',
    message: `the user declined to allow ${operation} on a sensitive path: ${abs}. Do not retry or work around it.`,
  };
}
