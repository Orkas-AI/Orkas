/**
 * Pipe-backed interactive CLI sessions.
 *
 * This is for CLIs that need a short-lived stdin/stdout conversation during
 * an agent run: OAuth device/browser-code prompts, yes/no confirmations,
 * one-time setup commands, etc. It is intentionally not a full PTY yet; TUI
 * programs can be upgraded later with node-pty without changing the tool/UI
 * contract.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildSandboxEnv, decodeProcessOutput, killProcessTree } from '../../../core-agent/src/sandbox/executor';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('interactive-cli');

const OUTPUT_MAX_CHARS = 64 * 1024;
const COMMAND_PREVIEW_MAX = 800;
const PURPOSE_MAX = 120;
const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1000;
const USER_ACTION_MIN_REMAINING_MS = 10 * 60 * 1000;
const MIN_MAX_LIFETIME_MS = USER_ACTION_MIN_REMAINING_MS;
const HARD_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const EXITED_SESSION_KEEP_MS = 10 * 60 * 1000;
const INPUT_MAX_CHARS = 64 * 1024;

export type InteractiveCliStatus = 'running' | 'exited' | 'error' | 'closed';
export type InteractiveCliStream = 'stdout' | 'stderr';
export type InteractiveCliPromptKind = 'auth_code' | 'secret' | 'confirm' | 'generic';

export interface InteractiveCliSessionView {
  session_id: string;
  purpose?: string;
  command: string;
  cwd: string;
  status: InteractiveCliStatus;
  created_at: string;
  updated_at: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  output: string;
  urls: string[];
  prompt_kind?: InteractiveCliPromptKind;
  sensitive_hint?: boolean;
}

export interface StartInteractiveCliSessionOpts {
  uid: string;
  cid?: string;
  agentId?: string;
  agentName?: string;
  purpose?: string;
  command: string;
  cwd: string;
  sandboxEnv?: Record<string, string>;
  maxLifetimeMs?: number;
}

interface Session {
  id: string;
  uid: string;
  cid: string;
  agentId: string;
  agentName: string;
  purpose: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  child: ChildProcessWithoutNullStreams;
  status: InteractiveCliStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: string;
  output: string;
  urls: string[];
  sensitiveInputs: string[];
  promptKind?: InteractiveCliPromptKind;
  sensitiveHint?: boolean;
  lifetimeTimer: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

const _sessions = new Map<string, Session>();

let _broadcastOverride: ((channel: string, payload: unknown) => void) | null = null;
export function _setInteractiveCliBroadcastForTest(fn: ((channel: string, payload: unknown) => void) | null): void {
  _broadcastOverride = fn;
}

export function _resetInteractiveCliSessionsForTest(): void {
  for (const s of _sessions.values()) {
    try { killProcessTree(s.child, 'SIGKILL'); } catch { /* best effort */ }
    clearTimers(s);
  }
  _sessions.clear();
  _broadcastOverride = null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function boundedLifetimeMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_LIFETIME_MS;
  return Math.max(MIN_MAX_LIFETIME_MS, Math.min(HARD_MAX_LIFETIME_MS, Math.round(n)));
}

function commandPreview(command: string): string {
  const s = String(command || '');
  if (s.length <= COMMAND_PREVIEW_MAX) return s;
  return `${s.slice(0, COMMAND_PREVIEW_MAX)}...`;
}

function purposePreview(purpose: unknown): string {
  const s = String(purpose || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= PURPOSE_MAX) return s;
  return `${s.slice(0, PURPOSE_MAX)}...`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactOutput(input: string, sensitiveValues: readonly string[] = []): string {
  let out = String(input || '');
  for (const value of sensitiveValues) {
    if (!value || value.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), '[redacted]');
  }
  out = out.replace(/([?&#](?:code|access_token|refresh_token|id_token|token|client_secret)=)[^&\s"'<>]+/gi, '$1[redacted]');
  out = out.replace(/\b((?:access|refresh|id)[_-]?token\s*[:=]\s*)[^\s"'<>]+/gi, '$1[redacted]');
  out = out.replace(/\b((?:client_secret|api[_-]?key|authorization|password|passwd)\s*[:=]\s*)[^\s"'<>]+/gi, '$1[redacted]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]');
  return out;
}

function safeUrlForUser(raw: string): string | null {
  let s = String(raw || '').trim();
  while (/[),.;\]]$/.test(s)) s = s.slice(0, -1);
  if (!/^https?:\/\//i.test(s)) return null;
  if (/[?&#](?:code|access_token|refresh_token|id_token|token|client_secret)=/i.test(s)) return null;
  return s;
}

function detectUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = safeUrlForUser(m[0]);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

function detectPrompt(text: string): { kind: InteractiveCliPromptKind; sensitive: boolean } | null {
  const tail = String(text || '').slice(-1200);
  if (!tail.trim()) return null;
  if (
    /\b(?:enter|paste|input|provide|type)\b.{0,60}\b(?:verification|authorization|auth|device)\s+code\b/i.test(tail)
    || /\b(?:verification|authorization|auth|device)\s+code\s*[:?]\s*$/i.test(tail)
  ) {
    return { kind: 'auth_code', sensitive: true };
  }
  if (
    /\b(?:enter|paste|input|provide|type)\b.{0,60}\b(?:password|passcode|client\s+secret|secret|token|api\s*key|private\s+key)\b/i.test(tail)
    || /\b(?:password|passcode|client\s+secret|secret|token|api\s*key|private\s+key)\s*[:?]\s*$/i.test(tail)
  ) {
    return { kind: 'secret', sensitive: true };
  }
  if (/(press\s+enter|hit\s+enter|continue\?|continue\s+\[|y\/n|yes\/no|\[y\/n\])/i.test(tail)) {
    return { kind: 'confirm', sensitive: false };
  }
  if (/([?:]\s*)$/.test(tail)) return { kind: 'generic', sensitive: false };
  return null;
}

function broadcast(payload: Record<string, unknown>): void {
  if (_broadcastOverride) {
    _broadcastOverride('interactive-cli:event', payload);
    return;
  }
  try {
    // Lazy lookup avoids a static model -> ipc import cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('interactive-cli:event', payload);
  } catch { /* headless tests / early boot: session still works via tools */ }
}

function touch(s: Session): void {
  s.updatedAt = Date.now();
}

function installLifetimeTimer(s: Session, delayMs: number, message: string): void {
  s.lifetimeTimer = setTimeout(() => {
    appendOutput(s, 'stderr', message);
    killSession(s);
    finishSession(s, 'closed', { signal: 'timeout' });
  }, delayMs);
  if (typeof s.lifetimeTimer.unref === 'function') s.lifetimeTimer.unref();
}

function ensureUserActionLifetime(s: Session): void {
  if (s.status !== 'running') return;
  const now = Date.now();
  const target = Math.min(s.createdAt + HARD_MAX_LIFETIME_MS, now + USER_ACTION_MIN_REMAINING_MS);
  if (target <= s.expiresAt + 1000) return;
  clearTimeout(s.lifetimeTimer);
  s.expiresAt = target;
  installLifetimeTimer(
    s,
    Math.max(1, target - now),
    `\n[Orkas] Interactive CLI session timed out after waiting ${USER_ACTION_MIN_REMAINING_MS}ms for user action.\n`,
  );
}

function appendOutput(s: Session, stream: InteractiveCliStream, raw: Buffer | string): void {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const decoded = decodeProcessOutput(buf, process.platform, s.env);
  const text = redactOutput(decoded, s.sensitiveInputs);
  if (!text) return;
  s.output += text;
  if (s.output.length > OUTPUT_MAX_CHARS) s.output = s.output.slice(-OUTPUT_MAX_CHARS);
  let detectedUrl = false;
  for (const url of detectUrls(decoded)) {
    detectedUrl = true;
    if (!s.urls.includes(url)) s.urls.push(url);
    if (s.urls.length > 12) s.urls.shift();
  }
  const prompt = detectPrompt(decoded) || detectPrompt(s.output);
  if (prompt) {
    s.promptKind = prompt.kind;
    s.sensitiveHint = prompt.sensitive;
  }
  if (
    prompt
    || detectedUrl
    || /browser has been opened|opened to visit|complete the sign-in prompts|accounts\.google\.com\/o\/oauth2|redirect_uri=http/i.test(decoded)
  ) {
    ensureUserActionLifetime(s);
  }
  touch(s);
  broadcast({
    type: 'output',
    session_id: s.id,
    stream,
    text,
    urls: s.urls,
    prompt_kind: s.promptKind,
    sensitive_hint: !!s.sensitiveHint,
    status: s.status,
  });
  if (prompt) {
    broadcast({
      type: 'waiting_input',
      session_id: s.id,
      prompt_kind: prompt.kind,
      sensitive_hint: prompt.sensitive,
      urls: s.urls,
      status: s.status,
    });
  }
}

function clearTimers(s: Session): void {
  clearTimeout(s.lifetimeTimer);
  if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
  if (s.killTimer) clearTimeout(s.killTimer);
}

function scheduleCleanup(s: Session): void {
  if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
  s.cleanupTimer = setTimeout(() => {
    const current = _sessions.get(s.id);
    if (current === s && current.status !== 'running') {
      clearTimers(current);
      _sessions.delete(current.id);
    }
  }, EXITED_SESSION_KEEP_MS);
  if (typeof s.cleanupTimer.unref === 'function') s.cleanupTimer.unref();
}

function finishSession(
  s: Session,
  status: InteractiveCliStatus,
  patch: { exitCode?: number | null; signal?: NodeJS.Signals | string | null; error?: string } = {},
): void {
  if (s.status !== 'running') return;
  s.status = status;
  if ('exitCode' in patch) s.exitCode = patch.exitCode;
  if ('signal' in patch) s.signal = patch.signal;
  if (patch.error) s.error = patch.error;
  touch(s);
  clearTimeout(s.lifetimeTimer);
  if (s.killTimer) clearTimeout(s.killTimer);
  scheduleCleanup(s);
  broadcast({
    type: status,
    session_id: s.id,
    status: s.status,
    exit_code: s.exitCode ?? null,
    signal: s.signal ?? null,
    error: s.error,
    urls: s.urls,
  });
}

function killSession(s: Session, signal: NodeJS.Signals = 'SIGTERM'): void {
  try { killProcessTree(s.child, signal); } catch { /* best effort */ }
  if (s.killTimer) clearTimeout(s.killTimer);
  s.killTimer = setTimeout(() => {
    try { killProcessTree(s.child, 'SIGKILL'); } catch { /* best effort */ }
  }, 5000);
  if (typeof s.killTimer.unref === 'function') s.killTimer.unref();
}

function assertOwnSession(uid: string, sessionId: string): Session {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('missing session_id');
  const s = _sessions.get(id);
  if (!s || s.uid !== String(uid || '')) throw new Error('interactive CLI session not found');
  return s;
}

function viewOf(s: Session): InteractiveCliSessionView {
  return {
    session_id: s.id,
    ...(s.purpose ? { purpose: s.purpose } : {}),
    command: commandPreview(s.command),
    cwd: s.cwd,
    status: s.status,
    created_at: new Date(s.createdAt).toISOString(),
    updated_at: new Date(s.updatedAt).toISOString(),
    exit_code: s.exitCode ?? null,
    signal: s.signal ?? null,
    ...(s.error ? { error: s.error } : {}),
    output: s.output,
    urls: s.urls.slice(),
    ...(s.promptKind ? { prompt_kind: s.promptKind } : {}),
    ...(typeof s.sensitiveHint === 'boolean' ? { sensitive_hint: s.sensitiveHint } : {}),
  };
}

export function startInteractiveCliSession(opts: StartInteractiveCliSessionOpts): InteractiveCliSessionView {
  const command = String(opts.command || '').trim();
  if (!command) throw new Error('missing command');
  const cwd = path.resolve(String(opts.cwd || process.cwd()));
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* spawn will report */ }
  const env = buildSandboxEnv(opts.sandboxEnv ?? {});
  const shell = process.platform === 'win32' ? true : (process.env.SHELL || '/bin/bash');
  const child = spawn(command, {
    cwd,
    env,
    shell,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  const id = crypto.randomUUID();
  const maxLifetimeMs = boundedLifetimeMs(opts.maxLifetimeMs);
  const now = Date.now();
  const session: Session = {
    id,
    uid: String(opts.uid || ''),
    cid: String(opts.cid || ''),
    agentId: String(opts.agentId || ''),
    agentName: String(opts.agentName || ''),
    purpose: purposePreview(opts.purpose),
    command,
    cwd,
    env,
    child,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + maxLifetimeMs,
    output: '',
    urls: [],
    sensitiveInputs: [],
    lifetimeTimer: setTimeout(() => {}, maxLifetimeMs),
  };
  clearTimeout(session.lifetimeTimer);
  installLifetimeTimer(session, maxLifetimeMs, `\n[Orkas] Interactive CLI session timed out after ${maxLifetimeMs}ms.\n`);
  _sessions.set(id, session);

  child.stdout.on('data', (data: Buffer) => appendOutput(session, 'stdout', data));
  child.stderr.on('data', (data: Buffer) => appendOutput(session, 'stderr', data));
  child.stdin.on('error', (err) => {
    log.warn('interactive CLI stdin error', {
      session_id: maskId(session.id),
      user_id: maskId(session.uid),
      error: logErrorRef(err),
    });
  });
  child.on('error', (err) => {
    log.warn('interactive CLI start/runtime error', {
      session_id: maskId(session.id),
      user_id: maskId(session.uid),
      error: logErrorRef(err),
    });
    finishSession(session, 'error', { error: err.message });
  });
  child.on('close', (code, signal) => {
    finishSession(session, session.status === 'running' ? (code === 0 ? 'exited' : 'error') : session.status, {
      exitCode: code,
      signal: signal ?? null,
    });
  });

  broadcast({
    type: 'started',
    session_id: id,
    ...(session.purpose ? { purpose: session.purpose } : {}),
    command: commandPreview(command),
    cwd,
    status: 'running',
    agent_name: session.agentName,
    created_at: nowIso(),
  });
  log.info('interactive CLI session started', {
    session_id: maskId(id),
    user_id: maskId(session.uid),
    cid: maskId(session.cid),
    agent_id: maskId(session.agentId),
    command_chars: command.length,
  });
  return viewOf(session);
}

export function readInteractiveCliSession(uid: string, sessionId: string): InteractiveCliSessionView {
  return viewOf(assertOwnSession(uid, sessionId));
}

export function listInteractiveCliSessions(uid: string): InteractiveCliSessionView[] {
  const owner = String(uid || '');
  return Array.from(_sessions.values())
    .filter((s) => s.uid === owner)
    .map(viewOf);
}

export function sendInteractiveCliInput(
  uid: string,
  sessionId: string,
  input: string,
  opts: { addNewline?: boolean; sensitive?: boolean } = {},
): InteractiveCliSessionView {
  const s = assertOwnSession(uid, sessionId);
  if (s.status !== 'running') throw new Error(`interactive CLI session is not running (${s.status})`);
  const text = String(input ?? '');
  if (text.length > INPUT_MAX_CHARS) throw new Error('input too large');
  const payload = opts.addNewline === false ? text : `${text}\n`;
  if (opts.sensitive === true && text.trim()) {
    s.sensitiveInputs.push(text);
    if (s.sensitiveInputs.length > 20) s.sensitiveInputs.shift();
  }
  try {
    s.child.stdin.write(payload, 'utf8');
  } catch (err) {
    throw new Error(`failed to write stdin: ${(err as Error).message}`);
  }
  touch(s);
  broadcast({
    type: 'input_sent',
    session_id: s.id,
    status: s.status,
    sensitive: opts.sensitive === true,
  });
  log.info('interactive CLI input sent', {
    session_id: maskId(s.id),
    user_id: maskId(s.uid),
    chars: text.length,
    sensitive: opts.sensitive === true,
  });
  return viewOf(s);
}

export function closeInteractiveCliSession(uid: string, sessionId: string): InteractiveCliSessionView {
  const s = assertOwnSession(uid, sessionId);
  if (s.status === 'running') {
    killSession(s);
    finishSession(s, 'closed', { signal: 'user' });
  } else {
    scheduleCleanup(s);
  }
  return viewOf(s);
}
