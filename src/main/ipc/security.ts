import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SRC_ROOT } from '../paths';

const MAX_CHANNEL_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_NAME_RE = /^[A-Za-z0-9._:-]+$/;

export interface IpcSenderLike {
  getURL?: () => string;
}

export interface IpcEnvelope {
  channel: string;
  payload: Record<string, unknown>;
}

function safeName(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name.length > maxLength || !SAFE_NAME_RE.test(name)) return '';
  return name;
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Only the packaged/dev renderer entry is allowed to reach privileged IPC. */
export function isTrustedIpcSender(sender: IpcSenderLike | null | undefined): boolean {
  if (!sender || typeof sender.getURL !== 'function') return false;
  try {
    const url = new URL(sender.getURL());
    if (url.protocol !== 'file:') return false;
    const candidate = path.resolve(fileURLToPath(url));
    const expected = path.resolve(SRC_ROOT, 'renderer', 'index.html');
    return candidate === expected;
  } catch {
    return false;
  }
}

export function parseInvokeEnvelope(value: unknown): IpcEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as { channel?: unknown; payload?: unknown };
  const channel = safeName(request.channel, MAX_CHANNEL_LENGTH);
  const payload = recordPayload(request.payload);
  return channel && payload ? { channel, payload } : null;
}

export function parseStreamEnvelope(value: unknown): (IpcEnvelope & { requestId: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as { requestId?: unknown; channel?: unknown; payload?: unknown };
  const requestId = safeName(request.requestId, MAX_REQUEST_ID_LENGTH);
  const invoke = parseInvokeEnvelope(request);
  return requestId && invoke ? { requestId, ...invoke } : null;
}

export function parseStreamRequestId(value: unknown): string {
  return safeName(value, MAX_REQUEST_ID_LENGTH);
}
