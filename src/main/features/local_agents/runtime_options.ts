/**
 * Bounded discovery of model, thinking, and permission controls exposed by
 * local CLIs.
 *
 * The returned object is renderer-safe metadata only. Raw CLI output, config,
 * paths and provider errors never cross IPC. Missing overrides always mean
 * "use the CLI default"; this module does not mutate global CLI settings.
 */

import * as fs from 'node:fs';

import { t } from '../../i18n.js';
import { createLogger } from '../../logger.js';
import { logErrorSummary } from '../../util/log-redact.js';
import { killProcessTree, LineSplitter, spawnCli, stripAnsi } from './backends/base.js';
import { CLAUDE_BARE_MIN_VERSION, cliVersionAtLeast } from './version.js';
import { codexNativeModelMinimum, compatibleCodexModels, compatibleCodexDefault } from './compatibility.js';
import {
  localCliPermissionPolicies,
  type LocalCliEntry,
  type LocalCliPermissionPolicy,
  type LocalCliType,
} from './registry.js';

const log = createLogger('local-agents:runtime-options');
const DISCOVERY_TIMEOUT_MS = 20_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 30_000;
const MAX_MODELS = 200;
const MAX_THINKING_LEVELS = 32;
const CLAUDE_MODEL_LIST_REQUEST_ID = 'orkas-list-models';
/** A build that answers this control request replies in well under a second;
 * one that ignores it holds the pipe open until it is killed, so this probe
 * gives up early instead of stalling the settings panel behind it. */
const CLAUDE_MODEL_LIST_TIMEOUT_MS = 8_000;
/** `--bare` keeps this capability probe from running the user's hooks, plugin
 * sync, keychain reads and CLAUDE.md discovery, and answers in ~0.25s instead
 * of ~1.5s. The probe never sends a user message, so no model call is billed. */
const CLAUDE_MODEL_LIST_ARGS = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--bare',
];
/** Builds that answer no model list still document these `--model` aliases. */
const CLAUDE_FALLBACK_MODELS: LocalCliModelOption[] = [
  { id: 'sonnet', label: 'Sonnet', is_alias: true },
  { id: 'opus', label: 'Opus', is_alias: true },
  { id: 'haiku', label: 'Haiku', is_alias: true },
];
const CLAUDE_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export type LocalCliThinkingKind = 'effort' | 'thinking' | 'variant' | 'none';

export interface LocalCliThinkingOption {
  id: string;
  label?: string;
}

export interface LocalCliModelOption {
  id: string;
  label: string;
  /** Stable CLI alias whose concrete provider model can change over time. */
  is_alias?: boolean;
  /** Concrete provider model this row runs right now, when the CLI reports
   * it. An alias resolves to whatever its family points at today; a pinned id
   * reports the model behind its context variant. */
  resolved_model?: string;
  is_default?: boolean;
  /** Present only when the CLI states the model takes no thinking level. */
  supports_thinking?: boolean;
  default_thinking_level?: string;
  thinking_levels?: LocalCliThinkingOption[];
}

export interface LocalCliRuntimeOptions {
  cli: LocalCliType;
  status: 'ready' | 'partial' | 'unavailable';
  default_model: string | null;
  /** Concrete model the CLI's own default resolves to right now, when the CLI
   * reports it. Selecting the default still sends no model flag. */
  default_model_resolved: string | null;
  default_thinking_level: string | null;
  models: LocalCliModelOption[];
  thinking_kind: LocalCliThinkingKind;
  thinking_levels: LocalCliThinkingOption[];
  can_select_model: boolean;
  can_select_thinking: boolean;
  allow_custom_model: boolean;
  allow_custom_thinking: boolean;
  permission_policies: LocalCliPermissionPolicy[];
  can_select_permission: boolean;
  /** Sole non-inherited policy for adapters that cannot pause for approval. */
  fixed_permission_policy: LocalCliPermissionPolicy | null;
}

type CaptureResult = { ok: boolean; stdout: string; stderr: string };
class OpenCodeHelpProbeError extends Error {
  constructor() {
    super(t('cli_agent.capability_probe_failed', { cli: 'OpenCode' }));
    this.name = 'OpenCodeHelpProbeError';
  }
}
type CachedOptions = { expiresAt: number; value: LocalCliRuntimeOptions };
const cache = new Map<string, CachedOptions>();
const helpCache = new Map<string, { identity: string; value: CaptureResult }>();
const helpInFlight = new Map<string, Promise<CaptureResult>>();

function optionsCacheKey(entry: LocalCliEntry, cwd: string): string {
  return `${entry.type}\u0000${entry.path || ''}\u0000${entry.fullVersion || entry.version || ''}\u0000${cwd}`;
}

/** Help text, and so the flag set, changes only with the binary. Same identity
 * as dispatch resolution: path, version, mtime and size. */
async function helpIdentity(entry: LocalCliEntry): Promise<string> {
  let stat = '';
  try {
    const st = await fs.promises.stat(entry.path || '');
    stat = `${st.mtimeMs}\u0000${st.size}`;
  } catch { /* path and version still identify the binary */ }
  return `${entry.path || ''}\u0000${entry.fullVersion || entry.version || ''}\u0000${stat}`;
}

/** Dispatch probes flags before every CLI task, so a result is kept for the
 * binary's lifetime rather than a TTL or a workspace. A failed probe is never
 * kept: the next caller retries it instead of replaying the failure. */
async function cliHelp(entry: LocalCliEntry, cwd: string, force = false, args: readonly string[] = ['--help']): Promise<CaptureResult> {
  const key = `${entry.type}\u0000${JSON.stringify(args)}`;
  const identity = await helpIdentity(entry);
  const flightKey = `${key}\u0000${identity}`;
  const pending = helpInFlight.get(flightKey);
  if (pending) return pending;
  const cached = helpCache.get(key);
  if (!force && cached?.identity === identity) return cached.value;
  const probe = captureCli(entry, [...args], cwd);
  helpInFlight.set(flightKey, probe);
  try {
    const value = await probe;
    if (value.ok) helpCache.set(key, { identity, value });
    return value;
  } finally { helpInFlight.delete(flightKey); }
}

/** Parse documented option syntax, not free-form task/model text. Capability
 * discovery supplements version boundaries and covers vendor backports. */
export function parseCliHelpFlags(text: string): string[] {
  const entries = text.split(/\r?\n/).flatMap(line => {
    const body = line.trimStart();
    // Parse documented option/usage syntax. Flags mentioned only in prose or
    // in another option's description do not establish this command's support.
    const syntax = /^Usage:/i.test(body) ? body
      : /^(?:-[A-Za-z],?\s+)?--[a-z]/.test(body) ? body.split(/\s{2,}/, 1)[0] : '';
    return syntax.match(/--[a-z][a-z0-9-]*(?=[\s,=<]|$)/g) || [];
  });
  return [...new Set(entries)];
}
function supportedFlags(help: CaptureResult): string[] {
  return help.ok ? parseCliHelpFlags(help.stdout + '\n' + help.stderr) : [];
}

export async function getLocalCliSupportedFlags(entry: LocalCliEntry, cwd: string, args: readonly string[] = ['--help']): Promise<string[]> {
  if (!entry.available || !entry.path) return [];
  const help = await cliHelp(entry, cwd, false, args);
  // Unknown OpenCode capabilities cannot safely select a private server.
  // Failed probes are not cached by cliHelp, so a later task can retry.
  if (entry.type === 'opencode' && !help.ok) throw new OpenCodeHelpProbeError();
  return supportedFlags(help);
}

function safeToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  return trimmed;
}

function safeLabel(value: unknown, fallback: string): string {
  const label = safeToken(value);
  return label || fallback;
}

function uniqueThinking(values: unknown[]): LocalCliThinkingOption[] {
  const out: LocalCliThinkingOption[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (out.length >= MAX_THINKING_LEVELS) break;
    const raw = value && typeof value === 'object'
      ? (value as any).reasoningEffort ?? (value as any).id ?? (value as any).value
      : value;
    const id = safeToken(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = value && typeof value === 'object'
      ? safeToken((value as any).label ?? (value as any).displayName)
      : '';
    out.push({ id, ...(label && label !== id ? { label } : {}) });
  }
  return out;
}

function uniqueModels(values: LocalCliModelOption[]): LocalCliModelOption[] {
  const out: LocalCliModelOption[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = safeToken(value.id);
    if (!id || seen.has(id) || out.length >= MAX_MODELS) continue;
    seen.add(id);
    out.push({
      id,
      label: safeLabel(value.label, id),
      ...(value.is_alias ? { is_alias: true } : {}),
      ...(safeToken(value.resolved_model) ? { resolved_model: safeToken(value.resolved_model) } : {}),
      ...(value.is_default ? { is_default: true } : {}),
      ...(value.supports_thinking === false ? { supports_thinking: false } : {}),
      ...(safeToken(value.default_thinking_level) ? {
        default_thinking_level: safeToken(value.default_thinking_level),
      } : {}),
      ...(value.thinking_levels?.length ? {
        thinking_levels: uniqueThinking(value.thinking_levels),
      } : {}),
    });
  }
  return out;
}

/** Codex may expose internal aliases and public model IDs with the same
 * displayName. Keep one visible row and prefer the public/canonical ID when
 * neither row is the active default. Other CLIs retain provider-qualified
 * same-name rows because those can represent genuinely different backends. */
function uniqueCodexModelsByLabel(values: LocalCliModelOption[]): LocalCliModelOption[] {
  const out: LocalCliModelOption[] = [];
  const indexByLabel = new Map<string, number>();
  const preference = (model: LocalCliModelOption): number => {
    if (model.is_default) return 2;
    return model.id.toLocaleLowerCase('en-US') === model.label.toLocaleLowerCase('en-US') ? 1 : 0;
  };
  for (const model of values) {
    const key = model.label.toLocaleLowerCase('en-US');
    const existingIndex = indexByLabel.get(key);
    if (existingIndex === undefined) {
      indexByLabel.set(key, out.length);
      out.push(model);
      continue;
    }
    if (preference(model) > preference(out[existingIndex])) out[existingIndex] = model;
  }
  return out;
}

function appendBounded(current: string, chunk: unknown): string {
  const remaining = OUTPUT_CAP_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + Buffer.from(String(chunk ?? '')).subarray(0, remaining).toString('utf8');
}

async function captureCli(
  entry: LocalCliEntry,
  args: string[],
  cwd: string,
): Promise<CaptureResult> {
  if (!entry.path) return { ok: false, stdout: '', stderr: '' };
  return new Promise<CaptureResult>((resolve) => {
    const child = spawnCli(entry.path!, args, cwd);
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const capture = (target: 'stdout' | 'stderr', chunk: unknown) => {
      outputBytes += Buffer.byteLength(String(chunk ?? ''));
      if (target === 'stdout') stdout = appendBounded(stdout, chunk);
      else stderr = appendBounded(stderr, chunk);
      if (outputBytes > OUTPUT_CAP_BYTES) {
        killProcessTree(child, 'SIGKILL');
        finish(false);
      }
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
      finish(false);
    }, DISCOVERY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Parse the first complete JSON value after optional CLI banner text. */
export function parseBannerJson(raw: string): unknown {
  const clean = stripAnsi(String(raw || '')).trim();
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (start < 0) {
      if (char !== '{' && char !== '[') continue;
      start = i;
      stack.push(char);
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;
    const expected = char === '}' ? '{' : '[';
    if (stack.at(-1) !== expected) {
      start = -1;
      stack.length = 0;
      continue;
    }
    stack.pop();
    if (stack.length === 0) {
      try { return JSON.parse(clean.slice(start, i + 1)); } catch {
        start = -1;
      }
    }
  }
  return null;
}

export function mapCodexModelList(result: unknown, config?: unknown): Pick<LocalCliRuntimeOptions,
  'models' | 'default_model' | 'default_thinking_level' | 'thinking_levels'
> {
  const root = result && typeof result === 'object' ? result as any : {};
  const effective = config && typeof config === 'object' ? (config as any).config : undefined;
  const configuredModel = safeToken(effective?.model);
  const configUnavailable = config === null;
  const rows = Array.isArray(root.data) ? root.data : (Array.isArray(root.models) ? root.models : []);
  const models = uniqueCodexModelsByLabel(uniqueModels(rows.map((row: any) => {
    const id = safeToken(row?.id ?? row?.model);
    return {
      id,
      label: safeLabel(row?.displayName ?? row?.name, id),
      is_default: !configUnavailable && (configuredModel ? id === configuredModel : row?.isDefault === true),
      default_thinking_level: safeToken(row?.defaultReasoningEffort),
      thinking_levels: uniqueThinking(Array.isArray(row?.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts : []),
    };
  })));
  const selected = models.find(model => model.is_default) || null;
  const thinkingLevels = uniqueThinking(models.flatMap(model => model.thinking_levels || []));
  return {
    models,
    default_model: configuredModel || selected?.id || null,
    default_thinking_level: safeToken(effective?.model_reasoning_effort) || selected?.default_thinking_level || null,
    thinking_levels: thinkingLevels,
  };
}

/** Strip the context-window variant suffix (`opus[1m]`) before comparing a
 * selectable value with the model it currently resolves to. */
function claudeModelBase(value: string): string {
  return value.replace(/\[[^\]]*\]$/, '').toLocaleLowerCase('en-US');
}

export function mapClaudeModelList(result: unknown): Pick<LocalCliRuntimeOptions,
  'models' | 'thinking_levels' | 'default_model_resolved'
> {
  const root = result && typeof result === 'object' ? result as any : {};
  const rows: any[] = Array.isArray(root.models) ? root.models : [];
  // `default` is whatever the CLI would pick on its own, which the empty
  // override already means. Keeping the row would offer the same choice twice,
  // so only the model it resolves to survives, as a label for that choice.
  const defaultRow = rows.find((row: any) => safeToken(row?.value) === 'default');
  // Only a build that advertises effort somewhere can be read as denying it on
  // one model; a build that reports nothing leaves every model unmarked.
  const reportsEffort = rows.some((row: any) => row?.supportsEffort === true
    || (Array.isArray(row?.supportedEffortLevels) && row.supportedEffortLevels.length > 0));
  const models = uniqueModels(rows
    .filter((row: any) => safeToken(row?.value) !== 'default')
    .map((row: any) => {
      const id = safeToken(row?.value);
      const resolved = safeToken(row?.resolvedModel);
      const levels = uniqueThinking(Array.isArray(row?.supportedEffortLevels)
        ? row.supportedEffortLevels : []);
      // A value that resolves to a different model follows whatever that
      // family points at today; a pinned model id stays on one version.
      const isAlias = !!id && !!resolved && claudeModelBase(id) !== claudeModelBase(resolved);
      return {
        id,
        label: safeLabel(row?.displayName, id),
        is_alias: isAlias,
        // Every row names the version it runs, so the picker states a model
        // instead of an unactionable "latest" or a bare family name. A display
        // name like "Fable" or "Opus (1M context)" carries no version itself.
        ...(resolved ? { resolved_model: resolved } : {}),
        // The CLI states effort support per model, so a model that takes none
        // must not inherit the levels its siblings advertise.
        supports_thinking: !reportsEffort || row?.supportsEffort === true || levels.length > 0,
        thinking_levels: levels,
      };
    }));
  return {
    models,
    default_model_resolved: safeToken(defaultRow?.resolvedModel) || null,
    thinking_levels: uniqueThinking(models.flatMap(model => model.thinking_levels || [])),
  };
}

export function mapOpenclawModels(statusRaw: string, listRaw: string): {
  models: LocalCliModelOption[];
  default_model: string | null;
} {
  const status = parseBannerJson(statusRaw) as any;
  const list = parseBannerJson(listRaw) as any;
  const defaultModel = safeToken(
    status?.defaultModel?.id ?? status?.defaultModel ?? status?.resolvedDefault?.id ?? status?.resolvedDefault,
  );
  const rows = Array.isArray(list)
    ? list
    : (Array.isArray(list?.models) ? list.models : (Array.isArray(list?.items) ? list.items : []));
  const models = uniqueModels(rows.map((row: any) => {
    const id = safeToken(row?.id ?? row?.key ?? row?.model ?? row?.ref);
    return {
      id,
      label: safeLabel(row?.displayName ?? row?.name ?? row?.label, id),
      is_default: !!defaultModel && id === defaultModel,
    };
  }));
  if (defaultModel && !models.some(model => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, label: defaultModel, is_default: true });
  }
  return { models: models.slice(0, MAX_MODELS), default_model: defaultModel || null };
}

export function parseOpenCodeModels(raw: string): LocalCliModelOption[] {
  return uniqueModels(stripAnsi(String(raw || '')).split(/\r?\n/).map(line => line.trim())
    .filter(line => /^[A-Za-z0-9._:@+-]+\/[A-Za-z0-9._:@+\/-]+$/.test(line))
    .map(id => ({ id, label: id })));
}

export function parseHermesDefaultModel(raw: string): string | null {
  for (const line of stripAnsi(String(raw || '')).split(/\r?\n/)) {
    const match = /^\s*Model:\s*(.+?)\s*$/.exec(line);
    const id = safeToken(match?.[1]);
    if (id) return id;
  }
  return null;
}

/** Ask Claude Code for the models it can run, over the stream-json control
 * protocol. Builds without that control request exit or stay silent, which the
 * caller reads as "keep the documented aliases". */
async function claudeModelList(entry: LocalCliEntry, cwd: string): Promise<unknown> {
  if (!entry.path) return null;
  return new Promise<unknown>((resolve) => {
    const child = spawnCli(entry.path!, CLAUDE_MODEL_LIST_ARGS, cwd);
    const splitter = new LineSplitter();
    let settled = false;
    let stdoutBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: unknown, closed = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // close has already released the process and its pipes. POSIX orphan
      // groups are reaped by spawnCli's exit handler; Windows needs a live PID.
      if (!closed) killProcessTree(child, 'SIGTERM');
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(String(chunk));
      if (stdoutBytes > OUTPUT_CAP_BYTES) return finish(null);
      splitter.push(String(chunk), line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.type !== 'control_response') return;
        const response = message.response;
        if (response?.request_id !== CLAUDE_MODEL_LIST_REQUEST_ID) return;
        finish(response?.subtype === 'success' ? response.response : null);
      });
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null, true));
    try {
      child.stdin.write(`${JSON.stringify({
        type: 'control_request',
        request_id: CLAUDE_MODEL_LIST_REQUEST_ID,
        request: { subtype: 'list_models' },
      })}\n`);
    } catch (_) {
      finish(null);
    }
    if (!settled) {
      timer = setTimeout(() => finish(null), CLAUDE_MODEL_LIST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

async function codexModelList(entry: LocalCliEntry, cwd: string, customArgs: readonly string[]): Promise<unknown> {
  if (!entry.path) return null;
  return new Promise<unknown>((resolve) => {
    const child = spawnCli(entry.path!, ['app-server', '--listen', 'stdio://', ...customArgs], cwd);
    const splitter = new LineSplitter();
    let settled = false;
    let stdoutBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let models: unknown;
    let config: unknown;
    let account: unknown;
    let modelsSettled = false;
    let configSettled = false;
    let accountRequested = false;
    let accountSettled = false;
    const finish = (value: unknown, closed = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!closed) killProcessTree(child, 'SIGTERM');
      resolve(value);
    };
    const send = (message: object) => {
      if (!settled && child.stdin.writable) {
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(null); }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(String(chunk));
      if (stdoutBytes > OUTPUT_CAP_BYTES) return finish(null);
      splitter.push(String(chunk), line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.id === 1 && !message.error) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({
            jsonrpc: '2.0', id: 2, method: 'model/list',
            params: { limit: MAX_MODELS, includeHidden: false },
          });
          // model/list.isDefault is the catalog recommendation. config/read
          // reports the actual inherited default for this invocation's cwd.
          send({ jsonrpc: '2.0', id: 3, method: 'config/read', params: { cwd, includeLayers: false } });
        } else if (message?.id === 1 && message.error) {
          finish(null);
        } else if (message?.id === 2) {
          models = message.error ? null : message.result;
          modelsSettled = true;
        } else if (message?.id === 3) {
          config = message.error ? null : message.result;
          configSettled = true;
        } else if (message?.id === 4) {
          account = message.error ? null : message.result;
          accountSettled = true;
        }
        if (modelsSettled && configSettled) {
          const effective = (config as any)?.config;
          const rows = Array.isArray((models as any)?.data) ? (models as any).data : [];
          const version = entry.fullVersion || entry.version || undefined;
          const needsAccount = (!effective?.model_provider || effective.model_provider === 'openai')
            && [effective?.model, ...rows.map((row: any) => row?.model || row?.id)]
              .some(model => codexNativeModelMinimum(model, version));
          if (needsAccount && !accountRequested) {
            accountRequested = true;
            send({ jsonrpc: '2.0', id: 4, method: 'account/read', params: { refreshToken: false } });
          } else if (!accountRequested || accountSettled) finish({ models, config, account });
        }
      });
    });
    child.on('error', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.on('close', () => finish(null, true));
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        clientInfo: { name: 'orkas', title: 'Orkas', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
    timer = setTimeout(() => finish(modelsSettled ? { models, config, account } : null), DISCOVERY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function baseOptions(cli: LocalCliType): LocalCliRuntimeOptions {
  const permissionPolicies = [...localCliPermissionPolicies(cli)];
  const fixedPermissionPolicy = permissionPolicies.length === 1
    && permissionPolicies[0] !== 'inherit'
    ? permissionPolicies[0]
    : null;
  return {
    cli,
    status: 'unavailable',
    default_model: null,
    default_model_resolved: null,
    default_thinking_level: null,
    models: [],
    thinking_kind: 'none',
    thinking_levels: [],
    can_select_model: false,
    can_select_thinking: false,
    allow_custom_model: false,
    allow_custom_thinking: false,
    permission_policies: permissionPolicies,
    can_select_permission: permissionPolicies.length > 1,
    fixed_permission_policy: fixedPermissionPolicy,
  };
}

async function discover(entry: LocalCliEntry, cwd: string, force: boolean, customArgs: readonly string[]): Promise<LocalCliRuntimeOptions> {
  const out = baseOptions(entry.type);
  if (!entry.available || !entry.path) return out;
  if (entry.type === 'claude') {
    const help = await cliHelp(entry, cwd, force);
    const flags = supportedFlags(help);
    // Never fall back to a non-bare probe on an older CLI: that would run
    // user hooks/plugins just to populate a settings picker.
    const canProbe = flags.includes('--bare')
      && cliVersionAtLeast(entry.fullVersion || entry.version, CLAUDE_BARE_MIN_VERSION);
    const advertised = mapClaudeModelList(canProbe ? await claudeModelList(entry, cwd) : null);
    out.status = help.ok ? 'ready' : 'partial';
    out.models = advertised.models.length
      ? advertised.models
      : uniqueModels(CLAUDE_FALLBACK_MODELS);
    out.default_model_resolved = advertised.default_model_resolved;
    out.thinking_kind = 'effort';
    out.thinking_levels = advertised.thinking_levels.length
      ? advertised.thinking_levels
      : uniqueThinking(CLAUDE_FALLBACK_EFFORTS);
    out.can_select_model = flags.includes('--model');
    out.can_select_thinking = flags.includes('--effort');
    out.allow_custom_model = out.can_select_model;
    out.allow_custom_thinking = out.can_select_thinking;
    return out;
  }
  if (entry.type === 'codex') {
    const probe = await codexModelList(entry, cwd, customArgs) as { models?: any; config?: any; account?: any } | null;
    if (probe?.account?.account?.type === 'chatgpt') {
      const version = entry.fullVersion || entry.version || undefined;
      const rows = Array.isArray(probe.models?.data) ? probe.models.data : [];
      probe.models = { ...probe.models, data: compatibleCodexModels(rows, version) };
      if (codexNativeModelMinimum(probe.config?.config?.model, version)) {
        const fallback = compatibleCodexDefault(rows, version);
        probe.config = { ...probe.config, config: { ...probe.config.config,
          model: fallback?.model || fallback?.id || null,
          model_reasoning_effort: fallback?.defaultReasoningEffort || null } };
      }
    }
    const mapped = mapCodexModelList(probe?.models, probe?.config ?? null);
    Object.assign(out, mapped);
    out.status = mapped.models.length && probe?.config ? 'ready' : 'partial';
    out.thinking_kind = 'effort';
    out.can_select_model = true;
    out.can_select_thinking = true;
    out.allow_custom_model = true;
    out.allow_custom_thinking = true;
    return out;
  }
  if (entry.type === 'openclaw') {
    const [status, list, help] = await Promise.all([
      captureCli(entry, ['models', 'status', '--json'], cwd),
      captureCli(entry, ['models', 'list', '--json'], cwd),
      captureCli(entry, ['agent', '--help'], cwd),
    ]);
    const mapped = mapOpenclawModels(status.stdout + status.stderr, list.stdout + list.stderr);
    Object.assign(out, mapped);
    out.status = status.ok || list.ok || help.ok ? (status.ok && list.ok && help.ok ? 'ready' : 'partial') : 'unavailable';
    out.thinking_kind = 'thinking';
    out.thinking_levels = uniqueThinking(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    out.can_select_model = supportedFlags(help).includes('--model');
    out.can_select_thinking = supportedFlags(help).includes('--thinking');
    out.allow_custom_model = out.can_select_model;
    out.allow_custom_thinking = out.can_select_thinking;
    return out;
  }
  if (entry.type === 'opencode') {
    const help = await captureCli(entry, ['run', '--help'], cwd);
    if (!help.ok) throw new OpenCodeHelpProbeError();
    // OpenCode 2 `models` otherwise starts a shared background service that
    // keeps running after discovery; 1.x has no `--standalone`.
    const models = await captureCli(entry,
      supportedFlags(help).includes('--standalone') ? ['models', '--standalone'] : ['models'], cwd);
    out.models = parseOpenCodeModels(models.stdout);
    out.status = models.ok || help.ok ? (models.ok && help.ok ? 'ready' : 'partial') : 'unavailable';
    out.thinking_kind = 'variant';
    out.can_select_model = supportedFlags(help).includes('--model');
    out.can_select_thinking = supportedFlags(help).includes('--variant');
    out.allow_custom_model = out.can_select_model;
    out.allow_custom_thinking = out.can_select_thinking;
    return out;
  }
  const status = await captureCli(entry, ['status'], cwd);
  const model = parseHermesDefaultModel(status.stdout + status.stderr);
  out.status = status.ok ? 'ready' : 'partial';
  out.default_model = model;
  out.models = model ? [{ id: model, label: model, is_default: true }] : [];
  out.can_select_model = true;
  out.allow_custom_model = true;
  return out;
}

export async function getLocalCliRuntimeOptions(
  entry: LocalCliEntry,
  cwd: string,
  { force = false, customArgs = [] }: { force?: boolean; customArgs?: readonly string[] } = {},
): Promise<LocalCliRuntimeOptions> {
  const key = `${optionsCacheKey(entry, cwd)}\u0000${JSON.stringify(customArgs)}`;
  const cached = cache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await discover(entry, cwd, force, customArgs);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    // Preserve a recoverable probe failure through IPC without caching it or
    // replacing it with defaults. Never expose raw CLI help/stderr.
    if (err instanceof OpenCodeHelpProbeError) {
      cache.delete(key);
      throw err;
    }
    log.warn('runtime option discovery failed', {
      cli: entry.type,
      error: logErrorSummary(err),
    });
    return baseOptions(entry.type);
  }
}
