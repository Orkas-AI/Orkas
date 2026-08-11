/**
 * Bounded discovery of model and thinking controls exposed by local CLIs.
 *
 * The returned object is renderer-safe metadata only. Raw CLI output, config,
 * paths and provider errors never cross IPC. Missing overrides always mean
 * "use the CLI default"; this module does not mutate global CLI settings.
 */

import { createLogger } from '../../logger.js';
import { logErrorSummary } from '../../util/log-redact.js';
import { killProcessTree, LineSplitter, spawnCli, stripAnsi } from './backends/base.js';
import type { LocalCliEntry, LocalCliType } from './registry.js';

const log = createLogger('local-agents:runtime-options');
const DISCOVERY_TIMEOUT_MS = 20_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 30_000;
const MAX_MODELS = 200;
const MAX_THINKING_LEVELS = 32;

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
  is_default?: boolean;
  default_thinking_level?: string;
  thinking_levels?: LocalCliThinkingOption[];
}

export interface LocalCliRuntimeOptions {
  cli: LocalCliType;
  status: 'ready' | 'partial' | 'unavailable';
  default_model: string | null;
  default_thinking_level: string | null;
  models: LocalCliModelOption[];
  thinking_kind: LocalCliThinkingKind;
  thinking_levels: LocalCliThinkingOption[];
  can_select_model: boolean;
  can_select_thinking: boolean;
  allow_custom_model: boolean;
  allow_custom_thinking: boolean;
}

type CaptureResult = { ok: boolean; stdout: string; stderr: string };
type CachedOptions = { expiresAt: number; value: LocalCliRuntimeOptions };
const cache = new Map<string, CachedOptions>();

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
      ...(value.is_default ? { is_default: true } : {}),
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

export function mapCodexModelList(result: unknown): Pick<LocalCliRuntimeOptions,
  'models' | 'default_model' | 'default_thinking_level' | 'thinking_levels'
> {
  const root = result && typeof result === 'object' ? result as any : {};
  const rows = Array.isArray(root.data) ? root.data : (Array.isArray(root.models) ? root.models : []);
  const models = uniqueCodexModelsByLabel(uniqueModels(rows.map((row: any) => {
    const id = safeToken(row?.id ?? row?.model);
    return {
      id,
      label: safeLabel(row?.displayName ?? row?.name, id),
      is_default: row?.isDefault === true,
      default_thinking_level: safeToken(row?.defaultReasoningEffort),
      thinking_levels: uniqueThinking(Array.isArray(row?.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts : []),
    };
  })));
  const selected = models.find(model => model.is_default) || null;
  const thinkingLevels = uniqueThinking(models.flatMap(model => model.thinking_levels || []));
  return {
    models,
    default_model: selected?.id || null,
    default_thinking_level: selected?.default_thinking_level || null,
    thinking_levels: thinkingLevels,
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

async function codexModelList(entry: LocalCliEntry, cwd: string): Promise<unknown> {
  if (!entry.path) return null;
  return new Promise<unknown>((resolve) => {
    const child = spawnCli(entry.path!, ['app-server', '--listen', 'stdio://'], cwd);
    const splitter = new LineSplitter();
    let settled = false;
    let stdoutBytes = 0;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child, 'SIGTERM');
      resolve(value);
    };
    const send = (message: object) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
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
        } else if (message?.id === 2) {
          finish(message.error ? null : message.result);
        }
      });
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        clientInfo: { name: 'orkas', title: 'Orkas', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
    const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function baseOptions(cli: LocalCliType): LocalCliRuntimeOptions {
  return {
    cli,
    status: 'unavailable',
    default_model: null,
    default_thinking_level: null,
    models: [],
    thinking_kind: 'none',
    thinking_levels: [],
    can_select_model: false,
    can_select_thinking: false,
    allow_custom_model: false,
    allow_custom_thinking: false,
  };
}

async function discover(entry: LocalCliEntry, cwd: string): Promise<LocalCliRuntimeOptions> {
  const out = baseOptions(entry.type);
  if (!entry.available || !entry.path) return out;
  if (entry.type === 'claude') {
    const help = await captureCli(entry, ['--help'], cwd);
    out.status = help.ok ? 'ready' : 'partial';
    out.models = [
      { id: 'sonnet', label: 'Sonnet', is_alias: true },
      { id: 'opus', label: 'Opus', is_alias: true },
      { id: 'haiku', label: 'Haiku', is_alias: true },
    ];
    out.thinking_kind = 'effort';
    out.thinking_levels = uniqueThinking(['low', 'medium', 'high', 'xhigh', 'max']);
    out.can_select_model = help.ok && /--model\b/.test(help.stdout + help.stderr);
    out.can_select_thinking = help.ok && /--effort\b/.test(help.stdout + help.stderr);
    out.allow_custom_model = out.can_select_model;
    out.allow_custom_thinking = out.can_select_thinking;
    return out;
  }
  if (entry.type === 'codex') {
    const mapped = mapCodexModelList(await codexModelList(entry, cwd));
    Object.assign(out, mapped);
    out.status = mapped.models.length ? 'ready' : 'partial';
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
    out.can_select_model = help.ok && /--model\b/.test(help.stdout + help.stderr);
    out.can_select_thinking = help.ok && /--thinking\b/.test(help.stdout + help.stderr);
    out.allow_custom_model = out.can_select_model;
    out.allow_custom_thinking = out.can_select_thinking;
    return out;
  }
  if (entry.type === 'opencode') {
    const [models, help] = await Promise.all([
      captureCli(entry, ['models'], cwd),
      captureCli(entry, ['run', '--help'], cwd),
    ]);
    out.models = parseOpenCodeModels(models.stdout);
    out.status = models.ok || help.ok ? (models.ok && help.ok ? 'ready' : 'partial') : 'unavailable';
    out.thinking_kind = 'variant';
    out.can_select_model = help.ok && /--model\b/.test(help.stdout + help.stderr);
    out.can_select_thinking = help.ok && /--variant\b/.test(help.stdout + help.stderr);
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
  { force = false }: { force?: boolean } = {},
): Promise<LocalCliRuntimeOptions> {
  const key = `${entry.type}\u0000${entry.path || ''}\u0000${entry.version || ''}\u0000${cwd}`;
  const cached = cache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await discover(entry, cwd);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    log.warn('runtime option discovery failed', {
      cli: entry.type,
      error: logErrorSummary(err),
    });
    return baseOptions(entry.type);
  }
}
