/**
 * Run a local CLI agent for one dispatch.
 *
 * Invariants:
 *   - Single spawn entry point for the whole project. `bus.ts` must
 *     route here; `features/*` must not call `child_process.spawn`
 *     directly for CLI agents.
 *   - Registry-owned pre-flight probing reuses the startup/UI probe only
 *     while the binary's on-disk identity is unchanged. The user might have
 *     upgraded or uninstalled it mid-conversation; a miss yields
 *     `done({status: 'missing_cli'})` before any persistence happens.
 *   - Persistence wraps every backend event so `events.jsonl` is the
 *     authoritative replay log. Output text is also appended to
 *     output.txt as it streams; the final body lands in meta.json.
 *   - The runner never throws on the happy path; failures are reported
 *     through the same `onEvent({type:'done', status:'failed', ...})`
 *     channel so the caller has a single completion contract.
 */

import * as fs from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../../logger.js';
import { AGENT_EXECUTION_MAX_MS, AGENT_EXECUTION_IDLE_MS, AgentActivityClock, type AgentTimeoutKind } from '../../util/agent-execution-budget.js';
import { chatMediaCidUrl } from '../../util/chat-media-url.js';
import { logErrorRef, logErrorSummary, logPathRef, maskId } from '../../util/log-redact.js';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize.js';
import { redactPaths } from '../../util/redact.js';
import {
  cachedCliFallbackCandidate,
  localCliCapabilities,
  localCliDefaultPermissionPolicy,
  noteCliCandidateFailure,
  noteCliCandidateSuccess,
  resolveCliForDispatch,
  type LocalCliEntry,
  type LocalCliPermissionPolicy,
  type LocalCliType,
} from './registry.js';
import { claudeBackend } from './backends/claude.js';
import { codexBackend } from './backends/codex.js';
import { openclawBackend } from './backends/openclaw.js';
import { opencodeBackend } from './backends/opencode.js';
import { hermesBackend } from './backends/hermes.js';
import {
  type LocalActiveRunIngress,
  type LocalBackend,
  type LocalEvent,
} from './backends/base.js';
import * as persist from './persist.js';
import * as cliPermissions from './cli_permissions.js';
import * as cliUserInput from './cli_user_input.js';
import { sessionToolResultsDir } from '../../paths.js';
import { maybeSpillToolResult, toolResultRefForPath } from '../../util/tool-result-cap.js';
import { isPathAllowed } from '../../util/path-sandbox.js';
import { conversationMessageReadFile } from '../../util/project-layout.js';
import { isCliResumeRejectedMessage } from './context.js';
import {
  LOCAL_AGENT_REMOTE_IMAGE_TIMEOUT_MS,
  LOCAL_AGENT_REMOTE_VIDEO_TIMEOUT_MS,
  LOCAL_AGENT_REMOTE_BATCH_TIMEOUT_MS,
  LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES,
  LOCAL_AGENT_REMOTE_TOTAL_MAX_BYTES,
  LOCAL_AGENT_REMOTE_MAX_ITEMS,
  LOCAL_AGENT_REMOTE_GLOBAL_MAX_ITEMS,
  LOCAL_AGENT_REMOTE_GLOBAL_MAX_BYTES,
  normalizedMediaMime,
  mediaKindHint,
  mediaExtensionHint,
  stableRemoteMediaName,
  inspectLocalAgentMedia,
  decodeLocalAgentMediaData,
  isPublicRemoteMediaIp,
  downloadLocalAgentMedia,
  decodeCodexGeneratedImageResult,
  type LocalAgentMediaDecodeResult,
  type SupportedMediaExtension,
} from './media.js';
export {
  decodeCodexGeneratedImageResult,
  type CodexGeneratedImageDecodeResult,
} from './media.js';
import type { BridgeCapability, BridgeHandle, CommanderHandoffRequest } from './bridge.js';
import { registerUserSwitchHook } from '../user-switch-hooks.js';
import { browserTaskRunId } from '../web_assist_lifecycle.js';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  resolveAttachmentAbsPath,
  saveGeneratedImageAttachment,
  saveGeneratedMediaCacheAttachment,
  saveGeneratedMediaAttachment,
} from '../chat_attachments.js';

const log = createLogger('local-agents:runner');

function bridgeToolKey(event: LocalEvent): string {
  if (event.type !== 'tool-event') return '';
  let tool = String(event.tool || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (tool.startsWith('mcp__orkas__')) tool = tool.slice('mcp__orkas__'.length);
  else if (tool.startsWith('orkas.')) tool = tool.slice('orkas.'.length);
  return tool;
}

function bridgeSkillRefFromToolEvent(event: LocalEvent): string {
  const tool = bridgeToolKey(event);
  if (!tool) return '';
  const input = event.input && typeof event.input === 'object' && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : {};
  if (tool === 'orkas_read_skill') return String(input.id || '').trim();
  if (tool === 'orkas_run_skill' && String(input.action || 'run').trim().toLowerCase() !== 'read') {
    return String(input.skill || '').trim();
  }
  return '';
}

function bridgeConnectorIdFromToolEvent(event: LocalEvent): string {
  if (bridgeToolKey(event) !== 'orkas_call_connector_tool') return '';
  const input = event.input && typeof event.input === 'object' && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : {};
  return String(input.connector_id || input.connectorId || '').trim();
}

/** Hard wall-clock cap for a single CLI dispatch — zombie insurance
 *  only. The hang detector is the idle-kill below, so this can be
 *  generous: healthy coding dispatches routinely pass 20 minutes
 *  (builds, model downloads, renders). The old 20-min value doubled as
 *  the hang detector and killed an actively-working 20-min claude turn
 *  (run 1dffe7c48d18). Override via ORKAS_LOCAL_AGENT_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = AGENT_EXECUTION_MAX_MS;

function resolveTimeoutMs(): number {
  const fallback = DEFAULT_TIMEOUT_MS;
  const raw = process.env.ORKAS_LOCAL_AGENT_TIMEOUT_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return fallback;
  return n;
}

/** Kill the CLI when it emits NO events for this long. This is the
 *  actual hang detector (vs the wall cap above). Long quiet stretches
 *  are real — a single Bash tool call sat silent ~10 min downloading a
 *  whisper model — so the default stays comfortably above them.
 *  Override via ORKAS_LOCAL_AGENT_IDLE_KILL_MS; 0 disables. */
const DEFAULT_IDLE_KILL_MS = AGENT_EXECUTION_IDLE_MS;

function resolveIdleKillMs(): number | undefined {
  const raw = process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (n <= 0) return undefined;          // explicit disable
      if (n >= 60_000) return n;             // floor guards against drumming kills
    }
  }
  return DEFAULT_IDLE_KILL_MS;
}

/** How long the runner waits without seeing user-visible backend activity
 *  before emitting an `idle` heartbeat. Content-free synthetic heartbeats
 *  count here while a known reasoning/tool item remains active, but they do
 *  not advance the separate real-activity clock used by the kill watchdog.
 *  The ticker below fires every `IDLE_TICK_MS`; the first emit happens once
 *  the visible-activity age exceeds this threshold. Default 90 s because a
 *  thinking turn between tool calls runs ~10-40 s — 90 s comfortably skips
 *  real activity and catches genuine stalls. */
const DEFAULT_IDLE_MS = 90 * 1000;
const DEFAULT_IDLE_TICK_MS = 30 * 1000;
/** Lower bound on user-supplied / backend-supplied idle thresholds so a
 *  misconfigured value can't drum the rail every second. Tests can
 *  shrink this through `ORKAS_LOCAL_AGENT_IDLE_MIN_MS` to exercise the
 *  heartbeat at a manageable speed; production never sets it. */
const MIN_IDLE_MS_DEFAULT = 30 * 1000;

function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function resolveIdleMs(backendHint: number | undefined): number {
  const minMs = envNum('ORKAS_LOCAL_AGENT_IDLE_MIN_MS') ?? MIN_IDLE_MS_DEFAULT;
  const candidates: Array<number | undefined> = [
    backendHint,
    envNum('ORKAS_LOCAL_AGENT_IDLE_MS'),
  ];
  for (const c of candidates) {
    if (c !== undefined && c >= minMs) return c;
  }
  return Math.max(DEFAULT_IDLE_MS, minMs);
}

function resolveIdleTickMs(idleMs: number): number {
  // Tick at most every 30 s; for very short thresholds (tests, or a
  // future short-idleMs backend) divide so the user sees ~3 pulses
  // before the threshold is reached.
  return Math.min(DEFAULT_IDLE_TICK_MS, Math.max(50, Math.floor(idleMs / 3)));
}

const BACKENDS: Partial<Record<LocalCliType, LocalBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
  opencode: opencodeBackend,
  hermes: hermesBackend,
};

const MAX_PUBLIC_DIAGNOSTIC_CHARS = 4_096;
const MAX_PUBLIC_THINKING_SUMMARY_CHARS = 2_048;
const MAX_PUBLIC_TOOL_PATH_CHARS = 512;
const MAX_PUBLIC_TOOL_INPUT_FILES = 64;
const MAX_PUBLIC_TOOL_INPUT_FIELDS = 64;

const TOOL_COMMAND_INPUT_KEYS = new Set(['command', 'cmd', 'script']);
const TOOL_WEB_INPUT_KEYS = new Set(['href', 'uri', 'url']);
const TOOL_PATH_INPUT_KEYS = new Set([
  'path', 'file', 'file_path', 'filePath', 'filename',
  'dir', 'directory', 'cwd',
  'output_path', 'outputPath', 'input_path', 'inputPath',
  'source_path', 'sourcePath', 'notebook_path', 'notebookPath',
]);
const TOOL_PRIVATE_BODY_KEYS = new Set([
  'body', 'code', 'content', 'contents', 'data', 'description', 'diff',
  'headers', 'html', 'input', 'instructions', 'markdown', 'messages',
  'newstring', 'newtext', 'oldstring', 'oldtext', 'output', 'patch',
  'payload', 'prompt', 'replace', 'replacement', 'result', 'schema',
  'source', 'systemprompt', 'template', 'text',
]);

function sanitizePublicDiagnostic(value: unknown): string {
  const sanitized = redactPaths(sanitizeLogTextForUpload(String(value ?? '')));
  return sanitized.length > MAX_PUBLIC_DIAGNOSTIC_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_DIAGNOSTIC_CHARS)}…`
    : sanitized;
}

/** Safe user-visible form of an authoritative CLI terminal error. The caller
 * may display this text verbatim; only secrets/paths and the size bound are
 * changed, never its meaning. */
export function sanitizePublicCliError(value: unknown): string {
  return sanitizePublicDiagnostic(value).trim();
}

/** Reasoning summaries are model-authored progress descriptions, distinct from
 * raw chain-of-thought. Keep the useful summary while applying the same secret
 * and absolute-path filtering as other public CLI diagnostics. */
export function sanitizePublicThinkingSummary(value: unknown): string {
  const sanitized = redactPaths(sanitizeLogTextForUpload(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > MAX_PUBLIC_THINKING_SUMMARY_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_THINKING_SUMMARY_CHARS)}…`
    : sanitized;
}

function compactToolInputKey(value: unknown): string {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isPrivateToolInputKey(key: string): boolean {
  const compact = compactToolInputKey(key);
  return TOOL_PRIVATE_BODY_KEYS.has(compact)
    || [
      'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'privatekey',
      'accesskey', 'clientsecret', 'secret', 'password', 'passwd',
      'credential', 'authorization', 'cookie', 'sessionid', 'signature',
      'token',
    ].some(part => compact === part || compact.endsWith(part));
}

type PublicToolPath = { value: string; ownershipSafe: boolean };

function boundedPublicToolPath(value: unknown, workingDir?: string): PublicToolPath | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(firstLine) || firstLine.startsWith('\\\\');
  const posixAbsolute = firstLine.startsWith('/');
  const windowsWorkingDir = typeof workingDir === 'string'
    && (/^[A-Za-z]:[\\/]/.test(workingDir) || workingDir.startsWith('\\\\'));
  const pathApi = windowsAbsolute || (!posixAbsolute && windowsWorkingDir) ? path.win32 : path.posix;
  const absolute = windowsAbsolute || (pathApi === path.posix && posixAbsolute);
  let publicPath = firstLine;
  let ownershipSafe = true;

  if (absolute) {
    const comparableCwd = typeof workingDir === 'string' && workingDir
      && pathApi.isAbsolute(workingDir)
      ? pathApi.normalize(workingDir)
      : '';
    const relative = comparableCwd
      ? pathApi.relative(comparableCwd, pathApi.normalize(firstLine))
      : '';
    const insideWorkingDir = !!relative
      && relative !== '..'
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative);
    ownershipSafe = insideWorkingDir;
    publicPath = insideWorkingDir ? relative : pathApi.basename(firstLine);
  } else {
    const normalized = pathApi.normalize(firstLine);
    const escapesWorkingDir = normalized === '..'
      || normalized.startsWith(`..${pathApi.sep}`)
      || normalized.startsWith('../')
      || normalized.startsWith('..\\');
    if (escapesWorkingDir) {
      ownershipSafe = false;
      publicPath = path.posix.basename(path.win32.basename(normalized));
    }
  }

  // Relative project paths are useful to the renderer and let the bus retain
  // exact multi-file ownership. Never retain an absolute machine path: paths
  // outside the active cwd collapse to a basename, while paths inside it are
  // expressed relative to that cwd.
  const sanitized = sanitizeLogTextForUpload(publicPath.replace(/\\/g, '/'))
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return {
    value: sanitized.slice(0, MAX_PUBLIC_TOOL_PATH_CHARS),
    ownershipSafe,
  };
}

function addPublicToolPath(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  workingDir?: string,
): void {
  const pathInfo = boundedPublicToolPath(value, workingDir);
  if (!pathInfo) return;
  if (pathInfo.ownershipSafe) {
    target[key] = pathInfo.value;
    return;
  }
  // A basename is still useful in the process rail, but it is not a trusted
  // locator for conversation ownership. Keep it under a display-only key that
  // the renderer understands and the bus deliberately ignores.
  if (typeof target.displayPath !== 'string') {
    target.displayPath = pathInfo.value;
    return;
  }
  const existing = Array.isArray(target.displayPaths)
    ? target.displayPaths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (target.displayPath !== pathInfo.value && !existing.includes(pathInfo.value)) {
    target.displayPaths = [...existing, pathInfo.value];
  }
}

const SENSITIVE_COMMAND_OPTION =
  '(?:--(?:api[-_]?key|x[-_]?api[-_]?key|x[-_]?auth[-_]?token|access[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?id|conversation[-_]?id|client[-_]?secret|private[-_]?key|password|passwd|pwd|secret|token|security[-_]?token|authorization|auth|credential|cookie|set[-_]?cookie|signature|header|user)|-[Hu])';
const SENSITIVE_COMMAND_OPTION_RE = new RegExp(
  `(^|\\s)(${SENSITIVE_COMMAND_OPTION})(\\s*=\\s*|\\s+)("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s;&|]+)`,
  'gi',
);
const SENSITIVE_COMMAND_ATTACHED_SHORT_OPTION_RE = new RegExp(
  `(^|\\s)(-[Hu])("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^\\s;&|]+)`,
  'gi',
);

function redactSeparatedCommandSecrets(value: string): string {
  return value
    .replace(SENSITIVE_COMMAND_OPTION_RE, (_match, prefix: string, flag: string, separator: string) => (
      `${prefix}${flag}${separator}***`
    ))
    // curl and similar CLIs also accept credentials/header values attached to
    // the short flag (`-uuser:pass`, `-H"Authorization: Bearer ..."`). These
    // are distinct argv shapes from the separated form above and must be
    // removed before a tool event can reach cloud-synced process history.
    .replace(SENSITIVE_COMMAND_ATTACHED_SHORT_OPTION_RE, (_match, prefix: string, flag: string) => (
      `${prefix}${flag}***`
    ))
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

function boundedPublicToolCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;
  // Preserve the executable and leaf filename the user needs to identify the
  // action, while removing machine-specific absolute prefixes before the
  // generic diagnostic sanitizer replaces them with opaque path markers.
  const withPublicPaths = firstLine
    .replace(/(["'])((?:\/(?!\/)|[A-Za-z]:[\\/])[^"'\r\n]+)\1/g, (_match, quote, rawPath) => {
      const leaf = path.posix.basename(path.win32.basename(String(rawPath).replace(/\\ /g, ' ')));
      return `${quote}${leaf}${quote}`;
    })
    .replace(/(^|[\s=(:,])((?:\/(?!\/)|[A-Za-z]:[\\/])(?:\\ |[^\s;&|<>()"'])+)/g, (_match, prefix, rawPath) => {
      const leaf = path.posix.basename(path.win32.basename(String(rawPath).replace(/\\ /g, ' ')));
      return `${prefix}${leaf}`;
    });
  const sanitized = sanitizePublicDiagnostic(redactSeparatedCommandSecrets(withPublicPaths))
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || undefined;
}

function boundedPublicToolWebTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return undefined;
  const sanitized = sanitizeLogTextForUpload(firstLine)
    // URL user-info can contain credentials but is not query-shaped, so the
    // shared sanitizer deliberately does not catch it.
    .replace(/^(https?:\/\/)[^/@\s]+@/i, '$1***@')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > MAX_PUBLIC_DIAGNOSTIC_CHARS
    ? `${sanitized.slice(0, MAX_PUBLIC_DIAGNOSTIC_CHARS)}…`
    : sanitized;
}

function sanitizePublicToolFiles(value: unknown, workingDir?: string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: unknown[] = [];
  for (const entry of value.slice(0, MAX_PUBLIC_TOOL_INPUT_FILES)) {
    const direct = boundedPublicToolPath(entry, workingDir);
    if (direct) {
      files.push(direct.ownershipSafe ? direct.value : { displayPath: direct.value });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of ['path', 'file', 'file_path', 'filePath', 'filename']) {
      addPublicToolPath(safe, key, source[key], workingDir);
    }
    if (Object.keys(safe).length) files.push(safe);
  }
  return files.length ? files : undefined;
}

function sanitizePublicToolInput(
  value: unknown,
  workingDir?: string,
  depth = 0,
): unknown {
  if (typeof value === 'string') return boundedPublicToolCommand(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return undefined;

  const source = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source).slice(0, MAX_PUBLIC_TOOL_INPUT_FIELDS)) {
    if (isPrivateToolInputKey(key)) continue;
    if (TOOL_COMMAND_INPUT_KEYS.has(key)) {
      const command = boundedPublicToolCommand(raw);
      if (command) safe[key] = command;
      continue;
    }
    if (TOOL_PATH_INPUT_KEYS.has(key)) {
      addPublicToolPath(safe, key, raw, workingDir);
      continue;
    }
    if (TOOL_WEB_INPUT_KEYS.has(key)) {
      const webTarget = boundedPublicToolWebTarget(raw);
      if (webTarget) safe[key] = webTarget;
      continue;
    }
    if (key === 'files') {
      const files = sanitizePublicToolFiles(raw, workingDir);
      if (files) safe.files = files;
      continue;
    }
    if (typeof raw === 'string') {
      const metadata = boundedPublicToolCommand(raw);
      if (metadata) safe[key] = metadata;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      safe[key] = raw;
    } else if (typeof raw === 'boolean') {
      safe[key] = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = sanitizePublicToolInput(raw, workingDir, depth + 1);
      if (nested && Object.keys(nested as Record<string, unknown>).length) safe[key] = nested;
    }
  }
  return safe;
}

/** Strip raw reasoning and machine diagnostics before events cross the runner
 * boundary. A backend may explicitly mark a model-authored reasoning summary;
 * it is bounded/redacted here while raw `text` is always removed. Persistence,
 * devtools archives, and the process rail receive only the allow-listed shape.
 * User-authored answer and tool result events remain intact because those are
 * intentional task output. */
export function redactPrivateLocalAgentEvent(event: LocalEvent, workingDir?: string): LocalEvent {
  if (!event) return event;
  if (event.type === 'thinking') {
    const rawChars = typeof event.text === 'string' ? event.text.length : Number(event.chars);
    const chars = Number.isFinite(rawChars) && rawChars > 0 ? Math.round(rawChars) : 0;
    const itemId = typeof event.itemId === 'string' && event.itemId
      ? event.itemId
      : undefined;
    const summary = sanitizePublicThinkingSummary(event.summary);
    return {
      type: 'thinking',
      chars,
      ...(summary ? { summary } : {}),
      ...(itemId ? { itemId } : {}),
      ...(event.heartbeat === true ? { heartbeat: true } : {}),
      ...(event.synthetic === true ? { synthetic: true } : {}),
    };
  }
  if (event.type === 'process-info') {
    const rawCommand = typeof event.cmd === 'string' ? event.cmd : '';
    const command = path.posix.basename(path.win32.basename(rawCommand));
    return {
      type: 'process-info',
      pid: event.pid,
      cmd: command || 'cli',
      argCount: Array.isArray(event.args) ? event.args.length : 0,
    };
  }
  if (event.type === 'tool-event') {
    const { input: _privateInput, ...rest } = event;
    const input = sanitizePublicToolInput(event.input, workingDir);
    return {
      ...rest,
      ...(input !== undefined ? { input } : {}),
      ...(typeof event.error === 'string'
        ? { error: sanitizePublicDiagnostic(event.error) }
        : {}),
    };
  }
  if (event.type === 'permission-request') {
    // Native approval prompts carry the full tool input (file bodies, shell
    // commands). Persisted history and the renderer need only the same
    // display-safe view the tool-event path exposes.
    const { input: _privateInput, ...rest } = event as LocalEvent & { input?: unknown };
    const input = sanitizePublicToolInput(_privateInput, workingDir);
    return { ...rest, ...(input !== undefined ? { input } : {}) } as LocalEvent;
  }
  if (event.type === 'stderr-line' || event.type === 'raw-line') {
    return { ...event, line: sanitizePublicDiagnostic(event.line) };
  }
  if (event.type === 'log') {
    return { ...event, message: sanitizePublicDiagnostic(event.message) };
  }
  if (event.type === 'status') {
    // Background-task descriptions and progress summaries are CLI-authored
    // free text that may quote commands and absolute paths. They cross the
    // same boundary as every other public diagnostic.
    return typeof event.message === 'string'
      ? { ...event, message: sanitizePublicDiagnostic(event.message) }
      : event;
  }
  if (event.type === 'idle') {
    if (!Array.isArray(event.waitingOn)) return event;
    const waitingOn = event.waitingOn.map((task) => {
      const entry = task && typeof task === 'object' ? task as Record<string, unknown> : {};
      return { ...entry, label: sanitizePublicDiagnostic(entry.label) };
    });
    return { ...event, waitingOn };
  }
  if (event.type === 'done') {
    return {
      ...event,
      ...(typeof event.error === 'string'
        ? { error: sanitizePublicDiagnostic(event.error) }
        : {}),
      ...(typeof event.stderrTail === 'string'
        ? { stderrTail: sanitizePublicDiagnostic(event.stderrTail) }
        : {}),
    };
  }
  return event;
}

/** CLIs with a supported MCP-config injection path (claude:
 *  `--mcp-config`; codex: `-c mcp_servers.…`). Others run without the
 *  bridge until an injection mechanism exists for them. */
function _bridgeSupported(cli: LocalCliType): boolean {
  return localCliCapabilities(cli).orkasBridge;
}

/** Appended to the CLI agent's system prompt when the bridge is live.
 * Runtime-generated (not a tracked prompt md). It is compiled from the exact
 * per-run capability manifest so an unavailable category is neither advertised
 * nor left to fail only after the model selects it. */
export function buildBridgeSystemPrompt(capabilities: readonly BridgeCapability[]): string {
  const granted = new Set(capabilities);
  const sentences = [
    'You are running inside Orkas, the user\'s agent workspace. An MCP server named "orkas" is connected with a run-scoped capability allowlist.',
  ];
  if (granted.has('skills.read') || granted.has('skills.run')) {
    sentences.push(
      'It lists and reads the user\'s granted Orkas skills (orkas_list_skills / orkas_read_skill)'
      + `${granted.has('skills.run') ? ' and can run their packaged scripts (orkas_run_skill)' : ''}.`,
    );
  }
  if (granted.has('memory.agent')) {
    sentences.push(
      'It can read and update only this Agent\'s durable Orkas memory with cross_session_memory; the Agent identity is fixed by the host.',
    );
  }
  if (granted.has('connectors')) {
    sentences.push(
      'It reaches the same connected services available to an ordinary Orkas group-chat Agent '
      + '(orkas_list_connector_tools / orkas_call_connector_tool); calls may wait for the user to approve a permission prompt in Orkas.',
    );
  }
  if (granted.has('kb.read')) {
    sentences.push('It browses and searches the granted knowledge base with library actions list / search / read.');
  }
  if (granted.has('chat.read')) {
    sentences.push(
      'It exposes chat_history actions search / read for quoted history from this conversation only. '
      + 'Use the conversation context supplied in the current prompt before these tools. Query only when exact needed context was omitted by the bounded '
      + 'history block or the user explicitly asks for a lookup. Use small pages with page mode latest, then follow the returned before hint. '
      + 'Use action=search only when a useful name, phrase, id, or fact is available.',
    );
  }
  if (granted.has('commander.handoff')) {
    sentences.push(
      'For Commander-only work—Orkas Agent or Skill mutation, cross-Agent orchestration, or a user decision outside this CLI capability— '
      + 'call orkas_handoff_to_commander with the concrete reason and continuation context, then end the turn. '
      + 'Do not emit Commander-only <agent> or <skill> mutation containers from a CLI reply.',
    );
  }
  sentences.push('Use only the registered bridge tools and prefer them when the task involves a granted Orkas capability or referenced context.');
  return sentences.join(' ');
}

type LocalToolRunCounter = {
  use: number;
  result: number;
  other: number;
};

type LocalToolTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  tool: string;
  phase: 'use' | 'result' | 'other';
  call_id?: string;
  is_error?: boolean;
  output_chars?: number;
  spilled?: boolean;
};

type LocalEventTimelineLogEntry = {
  seq: number;
  elapsedMs: number;
  event: string;
  detail?: string;
};

/** Did resuming this session consume the user's message without answering it?
 *
 *  A CLI resumed onto a session that was interrupted mid-flight can spend its
 *  turn digesting that half-written state and end without calling the model at
 *  all — the user's message goes in and nothing comes back, and the host would
 *  report "the model returned nothing". The message is simply gone.
 *
 *  Zero usage is the discriminator that makes this safe to act on: a model that
 *  chose to stay silent still burned tokens, so it is never mistaken for this.
 *  The stop record is what the recovery digest emits while clearing the old
 *  session's live work, and a fresh session cannot swallow a resumed input at
 *  all — together they keep an ordinary quiet turn from being resent.
 */
export function resumeConsumedTheTurn(observed: {
  attemptedResume: boolean;
  status?: string;
  outputChars: number;
  usageTokens: number;
  sawBackgroundStopped: boolean;
}): boolean {
  if (!observed.attemptedResume) return false;
  if (observed.status !== 'completed') return false;
  if (observed.outputChars > 0) return false;
  if (observed.usageTokens > 0) return false;
  return observed.sawBackgroundStopped;
}

/** Tokens a run actually spent, from the terminal event's usage. Unknown or
 *  malformed usage counts as spent so a quiet turn is never resent on a guess. */
export function runUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 1;
  const row = usage as Record<string, unknown>;
  let total = 0;
  let sawNumber = false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreate']) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) { total += Math.max(0, value); sawNumber = true; }
  }
  if (!sawNumber) {
    const cost = Number(row.cost);
    return Number.isFinite(cost) ? (cost > 0 ? 1 : 0) : 1;
  }
  return total;
}

export interface LocalAgentRunLogDiagnostics {
  startedAtMs: number;
  eventCount: number;
  eventTypes: Record<string, number>;
  textDeltaChars: number;
  thinkingChars: number;
  stderrLines: number;
  stderrChars: number;
  rawLines: number;
  rawChars: number;
  idleEvents: number;
  maxIdleStalledMs: number;
  permissionRequests: number;
  permissionAutoAllow: number;
  permissionAutoDeny: number;
  fileChangeEvents: number;
  fileChangePathCount: number;
  logLevels: Record<string, number>;
  toolEvents: number;
  toolResultEvents: number;
  spilledToolResults: number;
  toolCounts: Record<string, LocalToolRunCounter>;
  firstEventMs?: number;
  firstTextDeltaMs?: number;
  firstToolMs?: number;
  doneEventMs?: number;
  terminalStatus?: string;
  terminalError: boolean;
  usage?: Record<string, number>;
  toolTimeline: LocalToolTimelineLogEntry[];
  toolTimelineTruncated: number;
  eventTimeline: LocalEventTimelineLogEntry[];
  eventTimelineTruncated: number;
  textDeltaTimelineRecorded: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function safeUsageForLog(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const allowed = new Set([
    'input', 'output', 'total',
    'inputTokens', 'outputTokens', 'totalTokens',
    'cacheRead', 'cacheCreate', 'cacheWrite',
    'cacheReadTokens', 'cacheWriteTokens',
    'costUsd', 'totalCostUsd',
  ]);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const n = finiteNumber(raw);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createLocalAgentRunLogDiagnostics(nowMs = Date.now()): LocalAgentRunLogDiagnostics {
  return {
    startedAtMs: nowMs,
    eventCount: 0,
    eventTypes: {},
    textDeltaChars: 0,
    thinkingChars: 0,
    stderrLines: 0,
    stderrChars: 0,
    rawLines: 0,
    rawChars: 0,
    idleEvents: 0,
    maxIdleStalledMs: 0,
    permissionRequests: 0,
    permissionAutoAllow: 0,
    permissionAutoDeny: 0,
    fileChangeEvents: 0,
    fileChangePathCount: 0,
    logLevels: {},
    toolEvents: 0,
    toolResultEvents: 0,
    spilledToolResults: 0,
    toolCounts: {},
    terminalError: false,
    toolTimeline: [],
    toolTimelineTruncated: 0,
    eventTimeline: [],
    eventTimelineTruncated: 0,
    textDeltaTimelineRecorded: false,
  };
}

function noteElapsedOnce(target: LocalAgentRunLogDiagnostics, key: keyof LocalAgentRunLogDiagnostics, nowMs: number): void {
  if (target[key] !== undefined) return;
  (target as unknown as Record<string, unknown>)[key as string] = Math.max(0, nowMs - target.startedAtMs);
}

function localToolCounter(stats: LocalAgentRunLogDiagnostics, rawName: unknown): LocalToolRunCounter {
  const name = String(rawName || 'unknown').slice(0, 80) || 'unknown';
  if (!stats.toolCounts[name]) stats.toolCounts[name] = { use: 0, result: 0, other: 0 };
  return stats.toolCounts[name];
}

const MAX_TOOL_TIMELINE_LOG_ENTRIES = 80;
const MAX_EVENT_TIMELINE_LOG_ENTRIES = 120;

function safeToolNameForLog(rawName: unknown): string {
  return String(rawName || 'unknown').slice(0, 80) || 'unknown';
}

function safeLocalToolPhaseForLog(rawPhase: unknown): LocalToolTimelineLogEntry['phase'] {
  const phase = String(rawPhase || '');
  if (phase === 'use' || phase === 'result') return phase;
  return 'other';
}

function noteLocalToolTimelineForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs: number): void {
  if (stats.toolTimeline.length >= MAX_TOOL_TIMELINE_LOG_ENTRIES) {
    stats.toolTimelineTruncated += 1;
    return;
  }
  const phase = safeLocalToolPhaseForLog(e.phase);
  const entry: LocalToolTimelineLogEntry = {
    seq: stats.toolTimeline.length + stats.toolTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    tool: safeToolNameForLog(e.tool),
    phase,
  };
  const callId = e.callId;
  if (callId !== undefined && callId !== null && String(callId)) entry.call_id = maskId(callId);
  const isError = !!e.isError || !!e.error;
  if (isError) entry.is_error = true;
  if (phase === 'result') {
    if (typeof e.output === 'string') entry.output_chars = e.output.length;
    entry.spilled = !!(e.outputPath || e.outputRef);
  }
  stats.toolTimeline.push(entry);
}

function noteLocalEventTimelineForLog(
  stats: LocalAgentRunLogDiagnostics,
  event: string,
  nowMs: number,
  detail?: string,
): void {
  if (stats.eventTimeline.length >= MAX_EVENT_TIMELINE_LOG_ENTRIES) {
    stats.eventTimelineTruncated += 1;
    return;
  }
  stats.eventTimeline.push({
    seq: stats.eventTimeline.length + stats.eventTimelineTruncated + 1,
    elapsedMs: Math.max(0, nowMs - stats.startedAtMs),
    event,
    ...(detail ? { detail } : {}),
  });
}

function formatLocalEventTimelineEntryForLog(entry: LocalEventTimelineLogEntry): string {
  return [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.event,
    entry.detail,
  ].filter(Boolean).join(' ');
}

function formatLocalToolTimelineEntryForLog(entry: LocalToolTimelineLogEntry): string {
  const parts = [
    `#${entry.seq}`,
    `+${entry.elapsedMs}ms`,
    entry.tool,
    entry.phase,
  ];
  if (entry.call_id) parts.push(`call=${entry.call_id}`);
  if (entry.is_error !== undefined) parts.push(`error=${entry.is_error ? 'true' : 'false'}`);
  if (entry.output_chars !== undefined) parts.push(`output_chars=${entry.output_chars}`);
  if (entry.spilled !== undefined) parts.push(`spilled=${entry.spilled ? 'true' : 'false'}`);
  return parts.join(' ');
}

export function recordLocalAgentEventForLog(stats: LocalAgentRunLogDiagnostics, e: LocalEvent, nowMs = Date.now()): void {
  if (!stats || !e) return;
  stats.eventCount += 1;
  stats.eventTypes[e.type] = (stats.eventTypes[e.type] || 0) + 1;
  noteElapsedOnce(stats, 'firstEventMs', nowMs);

  switch (e.type) {
    case 'process-info':
      noteLocalEventTimelineForLog(stats, 'process_info', nowMs, `pid=${finiteNumber(e.pid) ?? 'unknown'}`);
      break;
    case 'text-delta':
      stats.textDeltaChars += typeof e.text === 'string' ? e.text.length : 0;
      noteElapsedOnce(stats, 'firstTextDeltaMs', nowMs);
      if (!stats.textDeltaTimelineRecorded) {
        stats.textDeltaTimelineRecorded = true;
        noteLocalEventTimelineForLog(stats, 'text_delta', nowMs, `chars=${typeof e.text === 'string' ? e.text.length : 0}`);
      }
      break;
    case 'thinking':
      {
        const rawChars = typeof e.text === 'string' ? e.text.length : Number(e.chars);
        const chars = Number.isFinite(rawChars) && rawChars > 0 ? Math.round(rawChars) : 0;
        stats.thinkingChars += chars;
        noteLocalEventTimelineForLog(stats, 'thinking', nowMs, `chars=${chars}`);
      }
      break;
    case 'stderr-line':
      stats.stderrLines += 1;
      stats.stderrChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.stderrLines === 1) noteLocalEventTimelineForLog(stats, 'stderr_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'raw-line':
      stats.rawLines += 1;
      stats.rawChars += typeof e.line === 'string' ? e.line.length : 0;
      if (stats.rawLines === 1) noteLocalEventTimelineForLog(stats, 'raw_line', nowMs, `chars=${typeof e.line === 'string' ? e.line.length : 0}`);
      break;
    case 'idle': {
      stats.idleEvents += 1;
      const stalledMs = finiteNumber(e.stalledMs) || 0;
      stats.maxIdleStalledMs = Math.max(stats.maxIdleStalledMs, stalledMs);
      noteLocalEventTimelineForLog(stats, 'idle', nowMs, `stalled_ms=${stalledMs}`);
      break;
    }
    case 'permission-request':
      stats.permissionRequests += 1;
      if (e.autoDecided === 'allow') stats.permissionAutoAllow += 1;
      if (e.autoDecided === 'deny') stats.permissionAutoDeny += 1;
      noteLocalEventTimelineForLog(
        stats,
        'permission_request',
        nowMs,
        `tool=${safeToolNameForLog(e.tool)} auto=${String(e.autoDecided || 'manual')}`,
      );
      break;
    case 'file-change':
      stats.fileChangeEvents += 1;
      stats.fileChangePathCount += Array.isArray(e.paths) ? e.paths.length : 0;
      noteLocalEventTimelineForLog(stats, 'file_change', nowMs, `paths=${Array.isArray(e.paths) ? e.paths.length : 0}`);
      break;
    case 'log': {
      const level = String(e.level || 'info').toLowerCase();
      stats.logLevels[level] = (stats.logLevels[level] || 0) + 1;
      noteLocalEventTimelineForLog(stats, 'log', nowMs, `level=${level}`);
      break;
    }
    case 'tool-event': {
      stats.toolEvents += 1;
      const counter = localToolCounter(stats, e.tool);
      const phase = String(e.phase || '');
      if (phase === 'use') counter.use += 1;
      else if (phase === 'result') {
        counter.result += 1;
        stats.toolResultEvents += 1;
        if (e.outputPath || e.outputRef) stats.spilledToolResults += 1;
      } else {
        counter.other += 1;
      }
      noteLocalToolTimelineForLog(stats, e, nowMs);
      noteLocalEventTimelineForLog(stats, 'tool_event', nowMs, `tool=${safeToolNameForLog(e.tool)} phase=${safeLocalToolPhaseForLog(e.phase)}`);
      noteElapsedOnce(stats, 'firstToolMs', nowMs);
      break;
    }
    case 'status':
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'status', nowMs, `status=${String(e.status || '')}`);
      break;
    case 'done':
      noteElapsedOnce(stats, 'doneEventMs', nowMs);
      stats.terminalStatus = typeof e.status === 'string' ? e.status : stats.terminalStatus;
      stats.terminalError = !!e.error;
      stats.usage = safeUsageForLog(e.usage) || stats.usage;
      noteLocalEventTimelineForLog(stats, 'done', nowMs, `status=${String(e.status || '')} error=${e.error ? 'true' : 'false'}`);
      break;
    default:
      break;
  }
}

export function summarizeLocalAgentRunForLog(stats: LocalAgentRunLogDiagnostics, nowMs = Date.now()): Record<string, unknown> {
  return {
    durationMs: Math.max(0, nowMs - stats.startedAtMs),
    eventCount: stats.eventCount,
    eventTypes: stats.eventTypes,
    textDeltaChars: stats.textDeltaChars,
    thinkingChars: stats.thinkingChars,
    stderrLines: stats.stderrLines,
    stderrChars: stats.stderrChars,
    rawLines: stats.rawLines,
    rawChars: stats.rawChars,
    idleEvents: stats.idleEvents,
    maxIdleStalledMs: stats.maxIdleStalledMs,
    permissionRequests: stats.permissionRequests,
    permissionAutoAllow: stats.permissionAutoAllow,
    permissionAutoDeny: stats.permissionAutoDeny,
    fileChangeEvents: stats.fileChangeEvents,
    fileChangePathCount: stats.fileChangePathCount,
    logLevels: stats.logLevels,
    toolEvents: stats.toolEvents,
    toolResultEvents: stats.toolResultEvents,
    spilledToolResults: stats.spilledToolResults,
    toolNames: Object.keys(stats.toolCounts).sort(),
    toolCounts: stats.toolCounts,
    toolTimeline: stats.toolTimeline.map(formatLocalToolTimelineEntryForLog),
    toolTimelineTruncated: stats.toolTimelineTruncated,
    eventTimeline: stats.eventTimeline.map(formatLocalEventTimelineEntryForLog),
    eventTimelineTruncated: stats.eventTimelineTruncated,
    firstEventMs: stats.firstEventMs,
    firstTextDeltaMs: stats.firstTextDeltaMs,
    firstToolMs: stats.firstToolMs,
    doneEventMs: stats.doneEventMs,
    terminalStatus: stats.terminalStatus,
    terminalError: stats.terminalError,
    usage: stats.usage,
  };
}

export function localAgentRunContextForLog(opts: {
  uid?: string;
  cid?: string;
  agentId?: string;
  projectId?: string;
  cli?: LocalCliType;
  customArgs?: readonly string[];
  resumeSessionId?: string;
  prompt?: string;
  systemPrompt?: string;
  resumeFallbackPrompt?: string;
  reuseSessionInstructions?: boolean;
  cwd?: string;
  runId?: string;
  cliAvailable?: boolean;
  cliVersion?: string | null;
  bridgeSupported?: boolean;
  timeoutMs?: number;
  idleKillMs?: number;
  idleMs?: number;
}): Record<string, unknown> {
  return {
    run_id: maskId(opts.runId),
    user_id: maskId(opts.uid),
    cid: maskId(opts.cid),
    agent_id: maskId(opts.agentId),
    project_id: maskId(opts.projectId),
    cli: opts.cli,
    cli_available: opts.cliAvailable,
    cli_version: opts.cliVersion || undefined,
    bridge_supported: opts.bridgeSupported,
    custom_arg_count: opts.customArgs?.length || 0,
    has_resume_session: !!opts.resumeSessionId,
    prompt_chars: String(opts.prompt || '').length,
    system_prompt_chars: String(opts.systemPrompt || '').length,
    resume_fallback_chars: String(opts.resumeFallbackPrompt || '').length,
    reuse_session_instructions: !!opts.reuseSessionInstructions,
    has_cwd: !!opts.cwd,
    cwd: opts.cwd ? logPathRef(opts.cwd) : undefined,
    timeout_ms: opts.timeoutMs,
    idle_kill_ms: opts.idleKillMs,
    idle_ms: opts.idleMs,
  };
}

export interface RunCliAgentOpts {
  uid: string;
  cid: string;
  agentId: string;
  /** Display name for permission dialogs; falls back to agentId. */
  agentName?: string;
  /** User-visible task title shown in external CLI permission dialogs. */
  conversationTitle?: string;
  /** Inbound conversation message that triggered this run. */
  currentMessageId: string;
  /** Conversation project scope, when the CLI turn belongs to a project. */
  projectId?: string;
  cli: LocalCliType;
  customArgs?: string[];
  modelOverride?: string;
  thinkingLevel?: string;
  /** Per-Agent policy. Missing means follow the CLI's native default. */
  permissionPolicy?: LocalCliPermissionPolicy;
  /** If set, the dispatch resumes a CLI-side session (claude
   *  `--resume <id>`) and the caller has already trimmed the prompt
   *  to "just the new turn" content — the CLI provides the prior
   *  context out of its own memory. The caller only sets this for a
   *  backend whose registry capability supports continuation. */
  resumeSessionId?: string;
  prompt: string;
  systemPrompt?: string;
  resumeFallbackPrompt?: string;
  reuseSessionInstructions?: boolean;
  cwd: string;
  signal: AbortSignal;
  deadlineAt?: number;
  /** Forwarded each backend event verbatim, after persistence. */
  onEvent: (e: LocalEvent) => void;
  /** Active native-turn ingress lifecycle. The runner forwards backend
   * readiness and guarantees a final clear even when a backend throws. */
  onActiveRunIngress?: (ingress: LocalActiveRunIngress | null) => void;
}

export interface RunCliAgentResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'missing_cli';
  output?: string;
  error?: string;
  cliError?: LocalCliEntry['error'];
  cliPath?: string;
  cliVersion?: string;
  commanderHandoff?: CommanderHandoffRequest;
  timeoutPhase?: 'foreground' | 'background';
  timeoutKind?: AgentTimeoutKind;
}

/** Active background phases held so app shutdown cannot orphan their detached
 *  CLI process groups. Their conversation turns remain active independently. */
const backgroundRuns = new Set<{
  stop: (reason: string) => void;
  untilProcessExit: Promise<void>;
}>();

interface BackgroundMediaDownload {
  uid: string;
  cid: string;
  reservedBytes: number;
  abort: (reason: string) => void;
  done: Promise<void>;
}

const backgroundMediaDownloads = new Map<string, BackgroundMediaDownload>();
let backgroundMediaReservedBytes = 0;

function linkedAbortSignal(...parents: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners = parents.map((parent) => {
    const onAbort = () => {
      const reason = (parent as AbortSignal & { reason?: unknown }).reason;
      if (!controller.signal.aborted) controller.abort(reason || new Error('operation aborted'));
    };
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
    return { parent, onAbort };
  });
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { parent, onAbort } of listeners) parent.removeEventListener('abort', onAbort);
    },
  };
}

function broadcastMaterializedRemoteMedia(payload: {
  uid: string;
  cid: string;
  remoteUrl: string;
  localUrl: string;
  kind: 'image' | 'video';
}): void {
  try {
    // Keep Electron and account state out of the runner's test/module-load
    // path. A stale account must never receive another user's signed URL.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const users = require('../users') as typeof import('../users');
    if (!users.hasActiveUser() || users.getActiveUserId() !== payload.uid) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('conversation:media_materialized', {
          user_id: payload.uid,
          conversation_id: payload.cid,
          remote_url: payload.remoteUrl,
          local_url: payload.localUrl,
          media_kind: payload.kind,
        });
      } catch { /* another live window can still receive the update */ }
    }
  } catch { /* app/window already gone */ }
}

registerUserSwitchHook('local-agent-media-downloads', (previousUid) => {
  for (const entry of backgroundMediaDownloads.values()) {
    if (entry.uid === previousUid) entry.abort('the active user changed');
  }
});

/** Stop media work owned by a conversation without delaying deletion. The
 * attachment writer's deletion lock remains the final guard against a response
 * that had already crossed its abort boundary. */
export function cancelBackgroundMediaForConversation(
  uid: string,
  cid: string,
  reason = 'the conversation was deleted',
): number {
  let cancelled = 0;
  for (const entry of backgroundMediaDownloads.values()) {
    if (entry.uid !== uid || entry.cid !== cid) continue;
    entry.abort(reason);
    cancelled += 1;
  }
  return cancelled;
}

/** End every active background run and wait, bounded. */
export async function stopBackgroundRuns(reason: string, deadlineMs = 5_000): Promise<number> {
  const entries = [...backgroundRuns];
  const mediaEntries = [...backgroundMediaDownloads.values()];
  const total = entries.length + mediaEntries.length;
  if (!total) return 0;
  log.info('stopping background local agent work', {
    reason,
    run_count: entries.length,
    media_count: mediaEntries.length,
  });
  for (const entry of entries) {
    try { entry.stop(reason); }
    catch (err) { log.warn('background run stop failed', { error: logErrorSummary(err) }); }
  }
  for (const entry of mediaEntries) entry.abort(reason);
  await Promise.race([
    Promise.all([
      ...entries.map(entry => entry.untilProcessExit),
      ...mediaEntries.map(entry => entry.done),
    ]),
    new Promise(resolve => { setTimeout(resolve, Math.max(0, deadlineMs)).unref?.(); }),
  ]);
  return total;
}


export async function run(opts: RunCliAgentOpts): Promise<RunCliAgentResult> {
  const executionStartedAt = Date.now();
  const backend = BACKENDS[opts.cli];
  const defaultPermissionPolicy = localCliDefaultPermissionPolicy(opts.cli);
  const requestedPermissionPolicy = opts.permissionPolicy || defaultPermissionPolicy;
  const permissionPolicy = localCliCapabilities(opts.cli).permissionPolicies.includes(
    requestedPermissionPolicy,
  ) ? requestedPermissionPolicy : defaultPermissionPolicy;
  let runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    resumeFallbackPrompt: opts.resumeFallbackPrompt,
    reuseSessionInstructions: opts.reuseSessionInstructions,
    cwd: opts.cwd,
    bridgeSupported: _bridgeSupported(opts.cli),
  });
  if (!backend) {
    log.warn('local agent backend missing', runLogContext);
    const err = `local CLI backend not implemented: ${opts.cli}`;
    opts.onEvent({ type: 'done', status: 'failed', error: err });
    return { runId: '', status: 'failed', error: err };
  }

  // Pre-flight probe. A user might have uninstalled the CLI between
  // create-time detection and now; probe reuse is gated on the binary's
  // on-disk identity, so a removed or changed binary still re-probes.
  let entry = await resolveCliForDispatch(opts.cli);
  if (!entry.available || !entry.path) {
    return _missing(opts, entry);
  }

  const timeoutMs = resolveTimeoutMs();
  const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, executionStartedAt + timeoutMs);
  const idleKillMs = resolveIdleKillMs();
  const idleThresholdMs = resolveIdleMs(undefined);

  const handle = await persist.start(opts.uid, {
    agentId: opts.agentId,
    cid: opts.cid,
    cli: opts.cli,
    cliPath: entry.path,
    prompt: opts.prompt,
  });
  cliPermissions.registerRun({
    uid: opts.uid,
    runId: handle.runId,
    agentId: opts.agentId,
    cli: opts.cli,
    permissionPolicy,
  });
  const startedAtMs = Date.now();
  const runDiagnostics = createLocalAgentRunLogDiagnostics(startedAtMs);
  const startedAtIso = new Date(startedAtMs).toISOString();
  runLogContext = localAgentRunContextForLog({
    uid: opts.uid,
    cid: opts.cid,
    agentId: opts.agentId,
    projectId: opts.projectId,
    cli: opts.cli,
    customArgs: opts.customArgs,
    resumeSessionId: opts.resumeSessionId,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    resumeFallbackPrompt: opts.resumeFallbackPrompt,
    reuseSessionInstructions: opts.reuseSessionInstructions,
    cwd: opts.cwd,
    runId: handle.runId,
    cliAvailable: entry.available,
    cliVersion: entry.version,
    bridgeSupported: _bridgeSupported(opts.cli),
    timeoutMs,
    idleKillMs,
    idleMs: idleThresholdMs,
  });
  log.info('local agent run start', runLogContext);

  // Wrapper writes events to disk before forwarding upstream so that
  // a renderer crash mid-run still leaves a complete jsonl trail.
  let streamedOutput = '';
  let terminal: {
    status: RunCliAgentResult['status'];
    output?: string;
    error?: string;
    sessionId?: string;
    timeoutPhase?: 'foreground' | 'background';
    timeoutKind?: AgentTimeoutKind;
    // Read to tell a turn the model never ran from one it chose to end quietly.
    usage?: unknown;
    failureKind?: string;
    retrySafe?: boolean;
  } | null = null;
  // CLI dispatch session id. The per-session spill dir is anchored on this
  // so sweep / read paths can find the file again.
  const cliSessionId = `cli-${opts.cli}-${handle.runId}`;
  const spillDir = sessionToolResultsDir(opts.uid, cliSessionId);
  const toolStartedAtByCallId = new Map<string, number>();
  const materializedMediaKeys = new Set<string>();
  let backgroundMediaQueue: Promise<void> = Promise.resolve();
  let remoteMediaScheduledCount = 0;
  let remoteMediaReservedBytes = 0;
  let remoteMediaDeadlineAt = 0;
  const activityClock = new AgentActivityClock();
  let lastVisibleActivityAt = Date.now();
  const bridgeSkillRefByCallId = new Map<string, string>();
  let bridge: BridgeHandle | null = null;
  let inspectResumeAttempt = !!(opts.resumeSessionId && opts.resumeFallbackPrompt);
  let resumeRejected = false;
  let resumeAttemptExecuted = false;
  // The recovery digest emits this while clearing the interrupted session's
  // live work; it is what separates a consumed turn from a quiet one.
  let sawBackgroundStopped = false;
  // Background tasks the CLI has open right now, keyed by task id. A task that
  // never finishes (a dev server, a watcher) keeps the CLI alive without a
  // result frame, so the run has no terminal boundary and the UI spins with no
  // stated reason. Naming the task turns that into a legible wait.
  const liveBackgroundTasks = new Map<string, string>();
  // A resumed turn's terminal is held until we know whether the resume answered
  // it. Wider than the recovery check below, which also needs a fallback prompt.
  let holdTerminalForResumeCheck = !!opts.resumeSessionId;
  const holdTerminalForCandidateFallback = true;
  let resendAttempted = false;
  let deferredDone: LocalEvent | null = null;
  const setTerminal = (e: LocalEvent) => {
    terminal = {
      status: (e.status as RunCliAgentResult['status']) || 'failed',
      output: typeof e.output === 'string' ? e.output : undefined,
      error: typeof e.error === 'string' ? e.error : undefined,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
      timeoutKind: e.timeoutKind === 'wall' || e.timeoutKind === 'idle' ? e.timeoutKind : undefined,
      timeoutPhase: e.timeoutPhase === 'background' ? 'background'
        : (e.timeoutPhase === 'foreground' ? 'foreground' : undefined),
      usage: e.usage,
      failureKind: typeof e.failureKind === 'string' ? e.failureKind : undefined,
      retrySafe: e.retrySafe === true,
    };
  };
  const materializeMediaItem = (
    raw: unknown,
  ): LocalAgentMediaDecodeResult => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'not_media' };
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.data === 'string' && item.data.trim()) {
      return decodeLocalAgentMediaData(item.data, item.mediaType);
    }
    if (typeof item.uri !== 'string' || !item.uri.trim()) return { ok: false, reason: 'not_media' };
    const uri = item.uri.trim();
    if (uri.toLowerCase().startsWith('data:')) {
      return decodeLocalAgentMediaData(uri, item.mediaType);
    }
    let candidate: string;
    try {
      if (uri.toLowerCase().startsWith('file:')) candidate = fileURLToPath(uri);
      else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return { ok: false, reason: 'unsupported_format' };
      else candidate = path.isAbsolute(uri) ? uri : path.resolve(opts.cwd, uri);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!isPathAllowed(candidate, [opts.cwd])) return { ok: false, reason: 'unsupported_format' };
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return { ok: false, reason: 'not_media' };
      const cap = mediaKindHint(item.mediaType, candidate) === 'video'
        ? LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES
        : MAX_IMAGE_ATTACHMENT_BYTES;
      if (stat.size > cap) return { ok: false, reason: 'too_large' };
      return inspectLocalAgentMedia(fs.readFileSync(candidate), item.mediaType, candidate);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  };
  const commitEvent = (e: LocalEvent): void => {
    const eventAtMs = Date.now();
    let generatedFileEvent: LocalEvent | null = null;
    // Every non-idle event is visible activity. Synthetic heartbeats therefore
    // keep a known active reasoning/tool item out of the user-facing
    // "unresponsive" state. They still do not prove that the CLI produced new
    // bytes, so only real protocol/process activity may slide the independent
    // hang deadline; otherwise a wedged Codex item could pulse forever.
    if (e.type !== 'idle') lastVisibleActivityAt = eventAtMs;
    if (e.type !== 'idle' && e.synthetic !== true) activityClock.progress();
    if (e.type === 'tool-event') {
      const callId = String(e.callId || '').trim();
      const phase = String(e.phase || '').toLowerCase();
      if (callId && phase === 'use' && !toolStartedAtByCallId.has(callId)) {
        toolStartedAtByCallId.set(callId, eventAtMs);
      } else if (callId && phase === 'result') {
        const startedAt = toolStartedAtByCallId.get(callId);
        const suppliedDuration = Number(e.durationMs);
        const hasSuppliedDuration = e.durationMs != null
          && Number.isFinite(suppliedDuration)
          && suppliedDuration >= 0;
        if (!hasSuppliedDuration && startedAt != null) {
          // Normalize per-call timing once at the runner boundary so every CLI
          // adapter gets the same live and persisted process presentation.
          e.durationMs = Math.max(0, eventAtMs - startedAt);
        }
        toolStartedAtByCallId.delete(callId);
      }
    }
    // Codex app-server returns `imageGeneration.result` as a bare Base64 PNG,
    // not a path. Materialize it into the active conversation's synced media
    // pool before the generic oversized-result spill can turn those bytes into
    // an opaque .txt diagnostic. The synthetic file event then enters the
    // same produced-file ownership path as native CLI writes.
    if (
      opts.cli === 'codex'
      && e.type === 'tool-event'
      && String(e.tool || '').toLowerCase() === 'image_generation'
      && String(e.phase || '').toLowerCase() === 'result'
    ) {
      const decoded = decodeCodexGeneratedImageResult(e.output);
      const callId = String(e.callId || '').trim();
      if (decoded.ok && callId && materializedMediaKeys.has(callId)) {
        e.output = 'Generated PNG image was already materialized for this tool call.';
      } else if (decoded.ok) {
        const saved = saveGeneratedImageAttachment(
          opts.uid,
          opts.cid,
          decoded.buffer,
          `codex-generated-image${decoded.extension}`,
        );
        if (saved.ok) {
          if (callId) materializedMediaKeys.add(callId);
          e.output = `Generated PNG image (${decoded.width}×${decoded.height}, ${decoded.buffer.length} bytes).`;
          generatedFileEvent = {
            type: 'file-change',
            paths: [saved.absPath],
            scope: 'conversation-media',
            source: 'image_generation',
            synthetic: true,
          };
        } else {
          e.output = 'Generated image could not be saved by Orkas.';
          e.error = 'generated_image_save_failed';
          log.warn('codex generated image save failed', {
            ...runLogContext,
            error: logErrorRef(new Error('error' in saved ? saved.error : 'unknown generated image save failure')),
          });
        }
      } else if ('reason' in decoded && decoded.reason !== 'not_image') {
        e.output = `Generated image result was rejected by Orkas (${decoded.reason}).`;
        e.error = `generated_image_${decoded.reason}`;
        log.warn('codex generated image rejected', {
          ...runLogContext,
          reason: decoded.reason,
        });
      }
    }
    // Tool-event result phase: spill oversized output to disk before
    // it lands in events.jsonl / the renderer stream. Above the estimated
    // inline-token budget the raw output bloats the persistence log and the
    // renderer memory; the spill keeps a bounded preview inline (matching
    // the in-process tool-result spill format) and exposes an opaque
    // content ref for click-to-expand. Backends don't know
    // about this — they always emit the full output.
    if (e.type === 'tool-event'
        && (e as any).phase === 'result'
        && Object.prototype.hasOwnProperty.call(e, 'output')) {
      const { output, outputPath } = maybeSpillToolResult({
        toolResultsDir: spillDir,
        toolName: String((e as any).tool || 'tool'),
        callId: String((e as any).callId || ''),
        output: (e as any).output,
      });
      // Rewrite in place so the persisted event and the forwarded
      // event match exactly — no divergence between disk replay and
      // live render.
      (e as any).output = output;
      if (outputPath) {
        // Conversation process events are cloud-synced. Persist only the
        // content-addressed opaque ref; the absolute machine-local path stays
        // behind the active-user IPC resolver.
        (e as any).outputRef = toolResultRefForPath(outputPath);
      }
    }
    recordLocalAgentEventForLog(runDiagnostics, e);
    persist.append(handle, e);
    if (e.type === 'text-delta' && typeof e.text === 'string') {
      streamedOutput += e.text;
      persist.appendOutput(handle, e.text);
    }
    if (e.type === 'done') {
      setTerminal(e);
    }
    opts.onEvent(e);
    if (generatedFileEvent) commitEvent(generatedFileEvent);
  };
  const scheduleRemoteMediaDownload = (args: {
    uri: string;
    declaredMime: unknown;
    sourceName: string;
    localName: string;
    extension: SupportedMediaExtension;
    kind: 'image' | 'video';
    source: string;
  }): boolean => {
    let parsed: URL;
    try { parsed = new URL(args.uri); }
    catch { return false; }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (
      parsed.protocol !== 'https:'
      || parsed.username || parsed.password
      || !hostname || hostname === 'localhost'
      || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || (isIP(hostname) && !isPublicRemoteMediaIp(hostname))
    ) {
      return false;
    }

    const existing = resolveAttachmentAbsPath(opts.uid, opts.cid, args.localName);
    if (existing.ok && existing.kind === args.kind) return true;
    const key = JSON.stringify([opts.uid, opts.cid, args.uri, args.localName]);
    if (backgroundMediaDownloads.has(key)) return true;

    const reservedBytes = args.kind === 'image'
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : LOCAL_AGENT_MEDIA_VIDEO_MAX_BYTES;
    if (
      remoteMediaScheduledCount >= LOCAL_AGENT_REMOTE_MAX_ITEMS
      || backgroundMediaDownloads.size >= LOCAL_AGENT_REMOTE_GLOBAL_MAX_ITEMS
      || backgroundMediaReservedBytes + reservedBytes > LOCAL_AGENT_REMOTE_GLOBAL_MAX_BYTES
      || remoteMediaReservedBytes + reservedBytes > LOCAL_AGENT_REMOTE_TOTAL_MAX_BYTES
    ) {
      return false;
    }
    remoteMediaScheduledCount += 1;
    remoteMediaReservedBytes += reservedBytes;
    backgroundMediaReservedBytes += reservedBytes;
    if (!remoteMediaDeadlineAt) remoteMediaDeadlineAt = Date.now() + LOCAL_AGENT_REMOTE_BATCH_TIMEOUT_MS;

    const controller = new AbortController();
    const linked = linkedAbortSignal(opts.signal, controller.signal);
    let entry!: BackgroundMediaDownload;
    const done = backgroundMediaQueue
      .catch(() => undefined)
      .then(async () => {
        if (linked.signal.aborted || Date.now() >= remoteMediaDeadlineAt) return;
        if (!fs.existsSync(conversationMessageReadFile(opts.uid, opts.cid, opts.projectId))) return;
        const cached = resolveAttachmentAbsPath(opts.uid, opts.cid, args.localName);
        if (cached.ok && cached.kind === args.kind) {
          broadcastMaterializedRemoteMedia({
            uid: opts.uid,
            cid: opts.cid,
            remoteUrl: args.uri,
            localUrl: chatMediaCidUrl(opts.cid, args.localName),
            kind: args.kind,
          });
          return;
        }
        const remainingMs = remoteMediaDeadlineAt - Date.now();
        if (remainingMs <= 0) return;
        const timeoutMs = Math.max(1, Math.min(
          args.kind === 'image' ? LOCAL_AGENT_REMOTE_IMAGE_TIMEOUT_MS : LOCAL_AGENT_REMOTE_VIDEO_TIMEOUT_MS,
          remainingMs,
        ));
        const decoded = await downloadLocalAgentMedia(
          args.uri,
          args.declaredMime,
          args.sourceName,
          linked.signal,
          args.kind,
          timeoutMs,
        );
        if (linked.signal.aborted) return;
        if (!decoded.ok || decoded.kind !== args.kind || decoded.extension !== args.extension) {
          const reason = 'reason' in decoded ? decoded.reason : 'container_mismatch';
          log.warn('local CLI remote media download rejected', {
            ...runLogContext,
            source: args.source,
            reason,
          });
          return;
        }
        const saved = await saveGeneratedMediaCacheAttachment(
          opts.uid,
          opts.cid,
          decoded.buffer,
          args.localName,
          args.kind,
        );
        if (!saved.ok) {
          const saveError = 'error' in saved ? saved.error : 'unknown media cache save failure';
          if (saveError !== 'conversation no longer exists') {
            log.warn('local CLI remote media cache save failed', {
              ...runLogContext,
              source: args.source,
              kind: args.kind,
              error: logErrorRef(new Error(saveError)),
            });
          }
          return;
        }
        broadcastMaterializedRemoteMedia({
          uid: opts.uid,
          cid: opts.cid,
          remoteUrl: args.uri,
          localUrl: chatMediaCidUrl(opts.cid, saved.info.name),
          kind: args.kind,
        });
      })
      .catch((error) => {
        if (!linked.signal.aborted) {
          log.warn('local CLI remote media background download failed', {
            ...runLogContext,
            source: args.source,
            error: logErrorRef(error),
          });
        }
      })
      .finally(() => {
        linked.cleanup();
        if (backgroundMediaDownloads.get(key) === entry) {
          backgroundMediaDownloads.delete(key);
          backgroundMediaReservedBytes = Math.max(0, backgroundMediaReservedBytes - entry.reservedBytes);
        }
      });
    entry = {
      uid: opts.uid,
      cid: opts.cid,
      reservedBytes,
      abort: (reason: string) => {
        if (!controller.signal.aborted) controller.abort(new Error(reason));
      },
      done,
    };
    backgroundMediaDownloads.set(key, entry);
    backgroundMediaQueue = done;
    return true;
  };

  const commitMediaOutput = (rawEvent: LocalEvent): void => {
    const source = typeof rawEvent.source === 'string' && rawEvent.source.trim()
      ? rawEvent.source.trim().slice(0, 40)
      : 'cli';
    const callId = typeof rawEvent.callId === 'string' ? rawEvent.callId.slice(0, 160) : '';
    const rawItems = Array.isArray(rawEvent.items) ? rawEvent.items.slice(0, 16) : [];
    const remoteItems: Array<Record<string, string>> = [];
    const fileEvents: LocalEvent[] = [];
    let rejectedCount = 0;
    let backgroundSkippedCount = 0;

    const safeStem = (raw: string, fallback: string): string => {
      let name = raw;
      try { name = decodeURIComponent(raw); } catch { /* keep encoded source */ }
      const base = path.basename(name.trim());
      return (path.basename(base, path.extname(base)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || fallback);
    };
    const saveDecoded = (
      decoded: Extract<LocalAgentMediaDecodeResult, { ok: true }>,
      requestedName: string,
    ): { absPath: string; name: string } | null => {
      const fallback = `${source.replace(/[^A-Za-z0-9_-]+/g, '-')}-generated-${decoded.kind}`;
      const stem = safeStem(requestedName, fallback);
      const saved = saveGeneratedMediaAttachment(
        opts.uid,
        opts.cid,
        decoded.buffer,
        `${stem}${decoded.extension}`,
        decoded.kind,
      );
      if (!saved.ok) {
        log.warn('local CLI media output save failed', {
          ...runLogContext,
          source,
          kind: decoded.kind,
          error: logErrorRef(new Error('error' in saved ? saved.error : 'unknown media save failure')),
        });
        return null;
      }
      fileEvents.push({
        type: 'file-change',
        paths: [saved.absPath],
        scope: 'conversation-media',
        source: 'cli_media_output',
        synthetic: true,
      });
      return { absPath: saved.absPath, name: saved.info.name };
    };

    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        rejectedCount += 1;
        continue;
      }
      const item = raw as Record<string, unknown>;
      const uri = typeof item.uri === 'string' ? item.uri.trim() : '';
      if (uri) {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const mediaType = normalizedMediaMime(item.mediaType);
            if (mediaType && !mediaType.startsWith('image/') && !mediaType.startsWith('video/')) {
              rejectedCount += 1;
              continue;
            }
            const key = `remote:${source}:${callId}:${uri}`;
            if (materializedMediaKeys.has(key)) continue;
            materializedMediaKeys.add(key);
            const explicitName = typeof item.name === 'string' && item.name.trim()
              ? path.basename(item.name.trim()).slice(0, 160)
              : '';
            const downloadName = explicitName || path.basename(parsed.pathname).slice(0, 160);
            const record: Record<string, string> = {
              uri: parsed.toString(),
              ...(mediaType ? { mediaType } : {}),
              ...(explicitName ? { name: explicitName } : {}),
            };
            const extension = mediaExtensionHint(mediaType, downloadName || parsed.pathname);
            const kind = mediaKindHint(mediaType, downloadName || parsed.pathname);
            if (extension && kind) {
              const localName = stableRemoteMediaName(parsed.toString(), extension);
              if (scheduleRemoteMediaDownload({
                uri: parsed.toString(),
                declaredMime: item.mediaType,
                sourceName: downloadName,
                localName,
                extension,
                kind,
                source,
              })) {
                record.localName = localName;
              } else {
                backgroundSkippedCount += 1;
              }
            } else {
              backgroundSkippedCount += 1;
            }
            remoteItems.push(record);
            continue;
          }
        } catch { /* local path or malformed URI; validation continues below */ }
      }
      const decoded = materializeMediaItem(item);
      if (!decoded.ok) {
        rejectedCount += 1;
        const reason = 'reason' in decoded ? decoded.reason : 'malformed';
        log.warn('local CLI media output rejected', { ...runLogContext, source, reason });
        continue;
      }
      const contentKey = [source, callId, decoded.buffer.length, decoded.buffer.subarray(0, 24).toString('base64')].join(':');
      if (materializedMediaKeys.has(contentKey)) continue;
      const requestedName = typeof item.name === 'string' ? path.basename(item.name.trim()) : '';
      const saved = saveDecoded(decoded, requestedName);
      if (!saved) {
        rejectedCount += 1;
        continue;
      }
      materializedMediaKeys.add(contentKey);
    }

    commitEvent({
      type: 'media-output',
      source,
      ...(callId ? { callId } : {}),
      items: remoteItems,
      materializedCount: fileEvents.length,
      scheduledCount: remoteItems.filter(item => !!item.localName).length,
      rejectedCount,
      ...(backgroundSkippedCount ? { backgroundSkippedCount } : {}),
    });
    for (const fileEvent of fileEvents) commitEvent(fileEvent);
  };
  const onEvent = (rawEvent: LocalEvent) => {
    if (rawEvent.type === 'media-output') {
      if (inspectResumeAttempt) resumeAttemptExecuted = true;
      commitMediaOutput(rawEvent);
      return;
    }
    if (rawEvent.type === 'tool-event') {
      const callId = String(rawEvent.callId || '').trim();
      const phase = String(rawEvent.phase || '').trim().toLowerCase();
      let skillRef = bridgeSkillRefFromToolEvent(rawEvent);
      if (phase === 'use' && callId && skillRef) bridgeSkillRefByCallId.set(callId, skillRef);
      if (!skillRef && callId) skillRef = bridgeSkillRefByCallId.get(callId) || '';
      const skillName = skillRef ? bridge?.getSkillDisplayName(skillRef) : null;
      if (skillName) rawEvent.skill_name = skillName;
      const connectorId = bridgeConnectorIdFromToolEvent(rawEvent);
      const connectorName = connectorId ? bridge?.getConnectorDisplayName(connectorId) : null;
      if (connectorName) rawEvent.connector_name = connectorName;
      if (phase === 'result' && callId) bridgeSkillRefByCallId.delete(callId);
    }
    const e = redactPrivateLocalAgentEvent(rawEvent, opts.cwd);
    if (inspectResumeAttempt) {
      if (
        (e.type === 'stderr-line' && isCliResumeRejectedMessage(e.line))
        || (e.type === 'done' && isCliResumeRejectedMessage(e.error))
      ) {
        resumeRejected = true;
      }
      if (e.type === 'done' && resumeRejected) e.resumeRejected = true;
      if (
        e.type === 'text-delta'
        || e.type === 'async-message'
        || e.type === 'tool-event'
        || e.type === 'media-output'
        || e.type === 'file-change'
        || e.type === 'permission-request'
        || (e.type === 'status' && e.status === 'running')
      ) {
        resumeAttemptExecuted = true;
      }
    }
    if (e.type === 'status' && e.status === 'background-stopped') sawBackgroundStopped = true;
    if (e.type === 'status' && typeof e.status === 'string' && e.status.startsWith('background-')) {
      const taskId = String(e.taskId || '').trim();
      if (taskId) {
        if (e.status === 'background-started' || e.status === 'background-running') {
          liveBackgroundTasks.set(taskId, String(e.message || e.taskType || '').trim());
        } else {
          liveBackgroundTasks.delete(taskId);
        }
      }
    }
    // Hold only the terminal marker until we know whether this resume was a
    // pre-execution stale-session rejection, or answered the user at all.
    // Diagnostic stderr/process rows remain visible; users still get exactly
    // one terminal event.
    if ((holdTerminalForResumeCheck || holdTerminalForCandidateFallback) && e.type === 'done') {
      deferredDone = e;
      setTerminal(e);
      return;
    }
    commitEvent(e);
  };

  // Idle ticker — purely informational; never kills the process itself.
  // Killing is the backend watchdog's job (idle-kill at `idleKillMs` +
  // wall cap, see resolveIdleKillMs/resolveTimeoutMs above); this
  // threshold sits far below the kill window so the user sees a steady
  // drumbeat ("○ no output for 30s" repeated) well before any kill,
  // rather than a single heartbeat that ages out.
  const idleTickMs = resolveIdleTickMs(idleThresholdMs);
  const idleTimer = setInterval(() => {
    if (terminal) return;  // run already finished, don't keep pulsing
    const stalledMs = Date.now() - lastVisibleActivityAt;
    if (stalledMs > idleThresholdMs) {
      const waitingOn = [...liveBackgroundTasks].map(([taskId, label]) => ({ taskId, label }));
      onEvent(waitingOn.length
        ? { type: 'idle', stalledMs, waitingOn }
        : { type: 'idle', stalledMs });
    }
  }, idleTickMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  // orkas-bridge (plan §D): per-run host exposing the user's Orkas
  // skills / connectors / KB to the CLI agent over a local socket. Bridge
  // failures never fail the dispatch — the CLI just runs without the
  // `orkas` MCP server, same as before the bridge existed.
  // Set when Claude enters a background phase. The backend promise and host
  // turn stay active; this marker is only for diagnostics and the app-shutdown
  // stop registry.
  let backgroundRunEntered = false;
  let backgroundTaskCount = 0;
  if (_bridgeSupported(opts.cli) && process.env.ORKAS_BRIDGE_DISABLED !== '1'
    && (opts.cli !== 'opencode' || opts.projectId || browserTaskRunId(opts.uid, opts.cid))) {
    try {
      const [{ startBridge }, { buildSkillSandboxEnv }] = await Promise.all([
        import('./bridge.js'),
        import('../../model/core-agent/client.js'),
      ]);
      bridge = await startBridge({
        uid: opts.uid,
        cid: opts.cid,
        agentId: opts.agentId,
        agentName: opts.agentName || opts.agentId,
        conversationTitle: opts.conversationTitle,
        cli: opts.cli,
        permissionPolicy,
        currentMessageId: opts.currentMessageId,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        workingDir: opts.cwd,
        runId: handle.runId,
        configDir: handle.dir,
        sandboxEnv: buildSkillSandboxEnv(opts.uid, opts.agentId),
        onPermissionWaitStart: () => activityClock.pause(),
        onPermissionWaiting: elapsedMs => onEvent({
          type: 'status',
          status: 'waiting-approval',
          elapsedMs,
          heartbeat: true,
          // Host-owned waiting marker, not backend activity: it must not slide
          // the idle-kill clock (same contract as the native permission wait).
          synthetic: true,
        }),
        preloadSkillDisplayNames: !!opts.resumeSessionId,
      });
      log.info('local agent bridge ready', runLogContext);
    } catch (err) {
      log.warn('bridge start failed — running without orkas MCP server', {
        ...runLogContext,
        error: logErrorRef(err),
      });
    }
  }

  const runBackendAttempt = async (attempt: {
    prompt: string;
    resumeSessionId?: string;
    reuseSessionInstructions?: boolean;
  }) => {
    try {
      if (Date.now() >= deadlineAt) {
        onEvent({
          type: 'done', status: 'timeout', timeoutKind: 'wall',
          error: 'Agent execution deadline reached before CLI dispatch',
          durationMs: Date.now() - executionStartedAt,
        });
        return;
      }
      await backend.run({
        binPath: entry.path,
        prompt: attempt.prompt,
        systemPrompt: opts.systemPrompt,
        resumeFallbackPrompt: opts.resumeFallbackPrompt,
        reuseSessionInstructions: attempt.reuseSessionInstructions,
        cwd: opts.cwd,
        customArgs: opts.customArgs,
        modelOverride: opts.modelOverride,
        thinkingLevel: opts.thinkingLevel,
        permissionPolicy,
        requestPermission: request => activityClock.waitForUser(() => cliPermissions.requestPermission({
          uid: opts.uid,
          cid: opts.cid,
          runId: handle.runId,
          agentId: opts.agentId,
          agentName: opts.agentName || opts.agentId,
          conversationTitle: opts.conversationTitle,
          cli: opts.cli,
          permissionPolicy,
          request,
          onWaiting: elapsedMs => onEvent({
            type: 'status',
            status: 'waiting-approval',
            elapsedMs,
            heartbeat: true,
            // Keeps the rail out of the "unresponsive" state but proves no
            // CLI activity; the prompt's own host deadline bounds the wait,
            // so the hang watchdog keeps its real-activity clock.
            synthetic: true,
          }),
        })),
        requestUserInput: request => activityClock.waitForUser(() => cliUserInput.requestUserInput({
          uid: opts.uid,
          cid: opts.cid,
          runId: handle.runId,
          agentId: opts.agentId,
          agentName: opts.agentName || opts.agentId,
          conversationTitle: opts.conversationTitle,
          cli: opts.cli,
          request,
          onWaiting: elapsedMs => onEvent({
            type: 'status',
            status: 'waiting-input',
            elapsedMs,
            heartbeat: true,
            synthetic: true,
          }),
        })),
        resumeSessionId: attempt.resumeSessionId,
        signal: opts.signal,
        onEvent,
        onActiveRunIngress: opts.onActiveRunIngress,
        onBackgroundRun: handle => {
          backgroundRunEntered = true;
          backgroundTaskCount = handle.liveTasks();
          const entry = { stop: handle.stop, untilProcessExit: handle.untilProcessExit };
          backgroundRuns.add(entry);
          void handle.untilProcessExit.then(() => {
            backgroundRuns.delete(entry);
          });
        },
        timeoutMs,
        deadlineAt,
        idleKillMs,
        // Real-activity clock for the backend's idle-kill watchdog. It excludes
        // self-emitted idle rows and synthetic backend heartbeats, so visible
        // progress can suppress false UI warnings without extending a wedged
        // process indefinitely.
        lastEventAt: activityClock.lastEventAt,
        onActivity: () => activityClock.progress(),
        ...(bridge ? {
          bridge: {
            mcpConfigPath: bridge.mcpConfigPath,
            server: {
              command: bridge.serverEnv.ORKAS_NODE,
              args: [`${bridge.serverEnv.ORKAS_PC_DIR}/bin/orkas-bridge.cjs`],
              env: bridge.serverEnv,
            },
            appendSystemPrompt: buildBridgeSystemPrompt(bridge.capabilities),
          },
        } : {}),
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      log.error('local agent backend threw', { ...runLogContext, error: logErrorSummary(err) });
      if (!terminal) {
        onEvent({ type: 'done', status: 'failed', error: msg });
      }
    } finally {
      // Fail closed on every path. Backends also clear at their authoritative
      // terminal event so the UI updates promptly; this covers throws, process
      // crashes, and future adapters that forget the lifecycle callback.
      try { opts.onActiveRunIngress?.(null); } catch { /* host already gone */ }
    }
  };

  let commanderHandoff: CommanderHandoffRequest | null = null;
  try {
    await runBackendAttempt({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      reuseSessionInstructions: opts.reuseSessionInstructions,
    });
    if (!terminal) {
      onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
    }
    const mayRecoverFresh = inspectResumeAttempt
      && resumeRejected
      && terminal?.status === 'failed'
      && !resumeAttemptExecuted
      && !opts.signal.aborted;
    if (mayRecoverFresh) {
      log.warn('local agent resume rejected before execution; retrying with bounded recovery', {
        ...runLogContext,
        recovery_prompt_chars: String(opts.resumeFallbackPrompt || '').length,
      });
      commitEvent({ type: 'status', status: 'resume-rejected' });
      inspectResumeAttempt = false;
      deferredDone = null;
      terminal = null;
      resumeRejected = false;
      await runBackendAttempt({
        prompt: opts.resumeFallbackPrompt!,
        reuseSessionInstructions: false,
      });
    }
    // The resume answered nothing and never called the model: it spent the turn
    // digesting an interrupted session and ate the user's message on the way
    // through. Send it once more rather than telling the user the model
    // returned nothing — the message is otherwise simply lost.
    const mayResend = !mayRecoverFresh
      && !resendAttempted
      && !opts.signal.aborted
      && resumeConsumedTheTurn({
        attemptedResume: !!opts.resumeSessionId,
        status: terminal?.status,
        outputChars: (terminal?.output || streamedOutput || '').length,
        usageTokens: runUsageTokens(terminal?.usage),
        sawBackgroundStopped,
      });
    if (mayResend) {
      log.warn('local agent resume consumed the turn without answering; resending once', {
        ...runLogContext,
      });
      resendAttempted = true;
      deferredDone = null;
      terminal = null;
      sawBackgroundStopped = false;
      await runBackendAttempt({
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        reuseSessionInstructions: opts.reuseSessionInstructions,
      });
    }

    // Reuse the already-probed CLI inventory when protocol setup or process
    // startup fails. The backend must explicitly prove replay is safe;
    // a task that may already have changed files or called tools is never
    // replayed silently under another binary.
    while (
      terminal?.status === 'failed'
      && terminal.retrySafe === true
      && (terminal.failureKind === 'cli_protocol' || terminal.failureKind === 'cli_spawn')
      && !opts.signal.aborted
      && streamedOutput.length === 0
      && toolStartedAtByCallId.size === 0
    ) {
      const failedEntry = entry;
      noteCliCandidateFailure(failedEntry);
      const fallback = cachedCliFallbackCandidate(failedEntry);
      if (!fallback?.path) break;

      entry = fallback;
      log.warn('CLI fallback selected', {
        ...runLogContext,
        from_version: failedEntry.fullVersion || failedEntry.version,
        to_version: entry.fullVersion || entry.version,
      });
      commitEvent({
        type: 'status',
        status: 'retrying',
        reason: 'cli-fallback',
        fromVersion: failedEntry.fullVersion || failedEntry.version,
        toVersion: entry.fullVersion || entry.version,
      });
      terminal = null;
      deferredDone = null;
      inspectResumeAttempt = false;
      holdTerminalForResumeCheck = false;
      resumeRejected = false;
      resumeAttemptExecuted = false;
      await runBackendAttempt({
        prompt: opts.resumeSessionId ? (opts.resumeFallbackPrompt || opts.prompt) : opts.prompt,
        reuseSessionInstructions: false,
      });
      if (!terminal) {
        onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
      }
    }
  } finally {
    cliPermissions.cancelForRun(handle.runId);
    cliUserInput.cancelForRun(handle.runId);
    if (bridge) {
      commanderHandoff = bridge.getCommanderHandoff();
      try { await bridge.close(); }
      catch (err) { log.warn('bridge close failed', { ...runLogContext, error: logErrorRef(err) }); }
    }
  }

  clearInterval(idleTimer);

  // Backends are required to emit a `done` — if missing, treat as
  // failure so callers don't hang on an absent terminal event.
  if (!terminal) {
    onEvent({ type: 'done', status: 'failed', error: 'backend exited without terminal event' });
    terminal = { status: 'failed', error: 'backend exited without terminal event' };
  }
  if (terminal.status === 'completed') {
    noteCliCandidateSuccess(entry);
  } else if (terminal.failureKind === 'cli_protocol' || terminal.failureKind === 'cli_spawn') {
    noteCliCandidateFailure(entry);
  }
  if (deferredDone) {
    const done = deferredDone;
    deferredDone = null;
    commitEvent(done);
  }

  const finalOutput = terminal.output ?? streamedOutput;
  const endedAtMs = Date.now();
  await persist.finalize(handle, {
    status: terminal.status,
    ...(entry.path ? { cliPath: entry.path } : {}),
    output: finalOutput,
    error: terminal.error,
    sessionId: terminal.sessionId,
    durationMs: endedAtMs - startedAtMs,
  });
  log.info('local agent run finish', {
    ...runLogContext,
    status: terminal.status,
    ...(backgroundRunEntered ? { background_run: true, background_tasks: backgroundTaskCount } : {}),
    output_chars: finalOutput?.length ?? 0,
    has_error: !!terminal.error,
    commander_handoff: !!commanderHandoff,
    error: terminal.error ? logErrorRef(new Error(terminal.error)) : undefined,
    duration_ms: endedAtMs - startedAtMs,
    diagnostics: summarizeLocalAgentRunForLog(runDiagnostics, endedAtMs),
  });
  return {
    runId: handle.runId,
    status: terminal.status,
    output: finalOutput,
    error: terminal.error,
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.fullVersion || entry.version } : {}),
    ...(terminal.timeoutPhase ? { timeoutPhase: terminal.timeoutPhase } : {}),
    ...(terminal.timeoutKind ? { timeoutKind: terminal.timeoutKind } : {}),
    ...(commanderHandoff ? { commanderHandoff } : {}),
  };
}

async function _missing(opts: RunCliAgentOpts, entry: LocalCliEntry): Promise<RunCliAgentResult> {
  const err = entry.errorDetail || `local CLI '${opts.cli}' is not installed or not on PATH`;
  log.warn('local agent cli missing', {
    ...localAgentRunContextForLog({
      uid: opts.uid,
      cid: opts.cid,
      agentId: opts.agentId,
      projectId: opts.projectId,
      cli: opts.cli,
      customArgs: opts.customArgs,
      resumeSessionId: opts.resumeSessionId,
      prompt: opts.prompt,
      cwd: opts.cwd,
      cliAvailable: entry.available,
      cliVersion: entry.version,
      bridgeSupported: _bridgeSupported(opts.cli),
    }),
    error: logErrorRef(new Error(err)),
  });
  opts.onEvent({
    type: 'done',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  });
  return {
    runId: '',
    status: 'missing_cli',
    error: err,
    cliError: entry.error || 'not_found',
    ...(entry.path ? { cliPath: entry.path } : {}),
    ...(entry.version ? { cliVersion: entry.version } : {}),
  };
}
