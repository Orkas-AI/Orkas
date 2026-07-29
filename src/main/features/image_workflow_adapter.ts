import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { fetchAndReadWithTimeout } from '../util/abort';
import { isPathAllowed } from '../util/path-sandbox';
import { writeImageAssetBuffer } from './image_assets';

export type ImageWorkflowEngine = 'comfyui' | 'invokeai' | 'automatic1111' | 'iopaint';

export interface PreparedImageWorkflow {
  engine: ImageWorkflowEngine;
  workflow_path: string;
  payload: Record<string, unknown>;
  mode?: string;
  output_node_id?: string;
  output_index: number;
}

export interface ImageWorkflowRunResult {
  engine: ImageWorkflowEngine;
  dispatch_id: string;
  output_path: string;
  output_node_id?: string;
  remote_output_id: string;
  format: string;
  width: number;
  height: number;
  channels: number;
  bytes: number;
  generation_calls: 1;
}

export class ImageWorkflowError extends Error {
  readonly code: string;
  readonly dispatched: boolean;
  readonly terminal: boolean;
  readonly dispatchId?: string;

  constructor(code: string, message: string, options: { dispatched?: boolean; terminal?: boolean; dispatchId?: string } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ImageWorkflowError';
    this.code = code;
    this.dispatched = options.dispatched === true;
    this.terminal = options.terminal !== false;
    this.dispatchId = options.dispatchId;
  }
}

interface WorkflowHostConfig {
  engine: ImageWorkflowEngine;
  baseUrl: URL;
  headers: Record<string, string>;
  secretValues: string[];
}

const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpv6 = normalized.includes(':');
  return normalized === 'localhost'
    || normalized === '::1'
    || (isIpv6 && (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')))
    || isPrivateIpv4(normalized);
}

export function validateImageWorkflowBaseUrl(raw: string, engine: ImageWorkflowEngine): URL {
  let url: URL;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new ImageWorkflowError('E_IMAGE_WORKFLOW_CONFIG', `${engine} base URL is invalid.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_CONFIG', `${engine} base URL must use HTTP or HTTPS.`);
  if (url.username || url.password || url.search || url.hash) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_CONFIG', `${engine} base URL must not contain credentials, query parameters, or a fragment.`);
  if (url.protocol === 'http:' && !isLocalHttpHost(url.hostname)) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_CONFIG', `${engine} requires HTTPS outside localhost or a private network.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function configuredHost(engine: ImageWorkflowEngine): WorkflowHostConfig | null {
  const baseRaw = engine === 'comfyui'
    ? process.env.ORKAS_COMFYUI_BASE_URL
    : engine === 'invokeai'
      ? process.env.ORKAS_INVOKEAI_BASE_URL
      : engine === 'automatic1111'
        ? process.env.ORKAS_AUTOMATIC1111_BASE_URL
        : process.env.ORKAS_IOPAINT_BASE_URL;
  if (!String(baseRaw || '').trim()) return null;
  const baseUrl = validateImageWorkflowBaseUrl(String(baseRaw), engine);
  const token = String(engine === 'comfyui'
    ? process.env.ORKAS_COMFYUI_API_KEY
    : engine === 'invokeai'
      ? process.env.ORKAS_INVOKEAI_API_TOKEN
      : engine === 'automatic1111'
        ? process.env.ORKAS_AUTOMATIC1111_API_AUTH
        : process.env.ORKAS_IOPAINT_API_TOKEN || '').trim();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    if (engine === 'comfyui') headers['X-API-Key'] = token;
    else if (engine === 'automatic1111') headers.Authorization = `Basic ${Buffer.from(token, 'utf8').toString('base64')}`;
    else headers.Authorization = `Bearer ${token}`;
  }
  return { engine, baseUrl, headers, secretValues: token ? [token] : [] };
}

export function assertImageWorkflowHostConfigured(engine: ImageWorkflowEngine): void {
  if (!configuredHost(engine)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_NOT_CONFIGURED', `${engine} is not configured by the host.`);
}

function endpoint(config: WorkflowHostConfig, route: string): string {
  const base = config.baseUrl.toString().replace(/\/+$/, '');
  return `${base}/${route.replace(/^\/+/, '')}`;
}

function sanitizeHostMessage(config: WorkflowHostConfig, value: unknown): string {
  let message = String(value || 'workflow request failed');
  const sensitiveHeaders = Object.entries(config.headers)
    .filter(([name]) => /authorization|api[-_]?key/i.test(name))
    .map(([, value]) => value);
  const secrets = [config.baseUrl.toString(), ...sensitiveHeaders, ...config.secretValues]
    .flatMap((item) => /^(?:Bearer|Basic) /.test(item) ? [item, item.slice(item.indexOf(' ') + 1)] : [item])
    .filter((item) => item.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  return message;
}

async function readLimitedBuffer(response: Response, limit: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_RESPONSE_LIMIT', `${label} exceeds ${limit} bytes.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_RESPONSE_LIMIT', `${label} exceeds ${limit} bytes.`);
  return buffer;
}

async function requestBuffer(
  config: WorkflowHostConfig,
  route: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  limit = MAX_JSON_RESPONSE_BYTES,
): Promise<{ response: Response; buffer: Buffer }> {
  return await fetchAndReadWithTimeout(
    endpoint(config, route),
    {
      ...init,
      redirect: 'error',
      headers: { ...config.headers, ...(init.headers as Record<string, string> || {}) },
    },
    timeoutMs,
    signal,
    `image workflow request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
    async (response) => await readLimitedBuffer(response, limit, 'image workflow response'),
  ).then(({ response, body }) => ({ response, buffer: body }));
}

async function requestJson(
  config: WorkflowHostConfig,
  route: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  limit = MAX_JSON_RESPONSE_BYTES,
): Promise<unknown> {
  const { response, buffer } = await requestBuffer(config, route, init, timeoutMs, signal, limit);
  if (!response.ok) {
    const detail = sanitizeHostMessage(config, buffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 2_048));
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_API', `${config.engine} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  try { return JSON.parse(buffer.toString('utf8')) as unknown; }
  catch { throw new ImageWorkflowError('E_IMAGE_WORKFLOW_API', `${config.engine} returned invalid JSON.`); }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeOutputIndex(value: unknown): number {
  const number = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 255) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_INPUT', 'output_index must be an integer from 0 to 255.');
  return number;
}

async function readProjectImageDataUrl(projectDirAbs: string, rawPath: unknown, label: string): Promise<string> {
  const value = String(rawPath || '').trim();
  if (!value) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', `${label} is required.`);
  const absPath = path.resolve(projectDirAbs, value);
  if (!isPathAllowed(absPath, [projectDirAbs])) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_PATH', `${label} must stay inside the image project.`);
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile()) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_MISSING', `${label} is not a file.`);
  if (stat.size > MAX_INPUT_IMAGE_BYTES) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_LIMIT', `${label} exceeds ${MAX_INPUT_IMAGE_BYTES} bytes.`);
  const extension = path.extname(absPath).toLowerCase();
  const mime = extension === '.png' ? 'image/png'
    : extension === '.webp' ? 'image/webp'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : null;
  if (!mime) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', `${label} must be PNG, JPEG, or WebP.`);
  return `data:${mime};base64,${(await fs.readFile(absPath)).toString('base64')}`;
}

export async function prepareImageWorkflow(input: {
  engine: ImageWorkflowEngine;
  projectDirAbs: string;
  workflowAbsPath: string;
  outputNodeId?: string;
  outputIndex?: number;
}): Promise<PreparedImageWorkflow> {
  if (!['comfyui', 'invokeai', 'automatic1111', 'iopaint'].includes(input.engine)) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_INPUT', 'engine must be comfyui, invokeai, automatic1111, or iopaint.');
  }
  const projectDirAbs = path.resolve(input.projectDirAbs);
  const workflowAbsPath = path.resolve(input.workflowAbsPath);
  if (!isPathAllowed(workflowAbsPath, [projectDirAbs])) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_PATH', 'workflow_path must stay inside the image project.');
  const stat = await fs.stat(workflowAbsPath).catch(() => null);
  if (!stat?.isFile()) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_MISSING', 'workflow_path is not a file.');
  if (stat.size > MAX_WORKFLOW_BYTES) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_LIMIT', `workflow JSON exceeds ${MAX_WORKFLOW_BYTES} bytes.`);
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(workflowAbsPath, 'utf8')); }
  catch { throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'workflow_path must contain valid JSON.'); }
  if (!record(parsed)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'workflow JSON must be an object.');

  let payload: Record<string, unknown>;
  let fileOutputNodeId: string | undefined;
  let fileOutputIndex: number | undefined;
  if (input.engine === 'comfyui') {
    const candidate = record(parsed.workflow)
      ? parsed.workflow
      : record(parsed.prompt)
        ? parsed.prompt
        : Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'output_node_id' && key !== 'output_index'));
    if (!Object.keys(candidate).length) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'ComfyUI API workflow is empty.');
    payload = { prompt: candidate, client_id: crypto.randomUUID() };
    fileOutputNodeId = typeof parsed.output_node_id === 'string' ? parsed.output_node_id.trim() : undefined;
    fileOutputIndex = parsed.output_index === undefined ? undefined : safeOutputIndex(parsed.output_index);
  } else if (input.engine === 'invokeai') {
    const request = record(parsed.request) ? parsed.request : parsed;
    if (record(request.batch)) {
      if (!record(request.batch.graph)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'InvokeAI batch.graph is required.');
      payload = structuredClone(request);
    } else {
      const graph = record(request.graph)
        ? request.graph
        : Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'output_node_id' && key !== 'output_index'));
      payload = {
        batch: {
          graph,
          runs: 1,
          origin: 'orkas-image-studio',
          destination: 'gallery',
        },
        prepend: false,
      };
    }
    fileOutputNodeId = typeof parsed.output_node_id === 'string' ? parsed.output_node_id.trim() : undefined;
    fileOutputIndex = parsed.output_index === undefined ? undefined : safeOutputIndex(parsed.output_index);
  } else if (input.engine === 'automatic1111') {
    const request = record(parsed.request) ? structuredClone(parsed.request) : structuredClone(parsed);
    for (const key of ['mode', 'request', 'init_image_paths', 'mask_path', 'output_index', 'init_images', 'mask']) delete request[key];
    for (const forbidden of ['script_name', 'script_args', 'alwayson_scripts']) {
      if (forbidden in request) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', `automatic1111 request.${forbidden} is not allowed.`);
    }
    const initPaths = Array.isArray(parsed.init_image_paths) ? parsed.init_image_paths : [];
    if (initPaths.length > 8) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_LIMIT', 'automatic1111 supports at most 8 init images per workflow request.');
    if (initPaths.length) request.init_images = await Promise.all(initPaths.map((item, index) => readProjectImageDataUrl(projectDirAbs, item, `init_image_paths[${index}]`)));
    if (parsed.mask_path !== undefined) request.mask = await readProjectImageDataUrl(projectDirAbs, parsed.mask_path, 'mask_path');
    const mode = String(parsed.mode || (initPaths.length ? 'img2img' : 'txt2img')).trim().toLowerCase();
    if (!['txt2img', 'img2img'].includes(mode)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'automatic1111 mode must be txt2img or img2img.');
    if (mode === 'img2img' && !Array.isArray(request.init_images)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_JSON', 'automatic1111 img2img requires init_image_paths.');
    payload = request;
    fileOutputIndex = parsed.output_index === undefined ? undefined : safeOutputIndex(parsed.output_index);
    return {
      engine: input.engine,
      workflow_path: workflowAbsPath,
      payload,
      mode,
      output_index: input.outputIndex === undefined ? fileOutputIndex ?? 0 : safeOutputIndex(input.outputIndex),
    };
  } else {
    const request = record(parsed.request) ? structuredClone(parsed.request) : {};
    request.image = await readProjectImageDataUrl(projectDirAbs, parsed.image_path, 'image_path');
    request.mask = await readProjectImageDataUrl(projectDirAbs, parsed.mask_path, 'mask_path');
    payload = request;
    fileOutputIndex = parsed.output_index === undefined ? undefined : safeOutputIndex(parsed.output_index);
    const outputIndex = input.outputIndex === undefined ? fileOutputIndex ?? 0 : safeOutputIndex(input.outputIndex);
    if (outputIndex !== 0) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_INPUT', 'iopaint output_index must be 0.');
    return { engine: input.engine, workflow_path: workflowAbsPath, payload, mode: 'inpaint', output_index: 0 };
  }
  const outputNodeId = String(input.outputNodeId || fileOutputNodeId || '').trim() || undefined;
  return {
    engine: input.engine,
    workflow_path: workflowAbsPath,
    payload,
    ...(outputNodeId ? { output_node_id: outputNodeId } : {}),
    output_index: input.outputIndex === undefined ? fileOutputIndex ?? 0 : safeOutputIndex(input.outputIndex),
  };
}

function capabilityFailureReason(error: unknown): string {
  if (error instanceof ImageWorkflowError) return error.code;
  if ((error as { name?: string })?.name === 'AbortError') return 'E_IMAGE_WORKFLOW_TIMEOUT';
  return 'E_IMAGE_WORKFLOW_UNAVAILABLE';
}

export async function imageWorkflowCapabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const engines = await Promise.all((['comfyui', 'invokeai', 'automatic1111', 'iopaint'] as const).map(async (engine) => {
    let config: WorkflowHostConfig | null;
    try { config = configuredHost(engine); }
    catch (error) {
      return [engine, { configured: true, available: false, executable: false, reason: capabilityFailureReason(error) }] as const;
    }
    if (!config) return [engine, { configured: false, available: false, executable: false }] as const;
    try {
      const route = engine === 'comfyui' ? 'system_stats'
        : engine === 'invokeai' ? 'api/v1/app/version'
          : engine === 'automatic1111' ? 'sdapi/v1/sd-models'
            : 'api/v1/server-config';
      const response = await requestJson(config, route, { method: 'GET' }, 3_000, signal);
      const version = engine === 'invokeai' && record(response) && typeof response.version === 'string'
        ? response.version
        : undefined;
      return [engine, {
        configured: true,
        available: true,
        executable: true,
        protocol: engine === 'comfyui' ? 'prompt-history-view'
          : engine === 'invokeai' ? 'queue-session-image'
            : engine === 'automatic1111' ? 'txt2img-img2img'
              : 'image-mask-inpaint',
        ...(version ? { version } : {}),
      }] as const;
    } catch (error) {
      return [engine, { configured: true, available: false, executable: false, reason: capabilityFailureReason(error) }] as const;
    }
  }));
  return {
    host_managed: true,
    agent_supplied_endpoints: false,
    engines: Object.fromEntries(engines),
  };
}

function deadlineTimeout(deadline: number): number {
  return Math.max(250, Math.min(15_000, deadline - Date.now()));
}

async function pollPause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('operation aborted');
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(new Error('operation aborted'));
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function findComfyOutput(history: unknown, dispatchId: string, nodeId: string | undefined, outputIndex: number): {
  nodeId: string;
  filename: string;
  subfolder: string;
  type: string;
} | null {
  if (!record(history)) return null;
  const item = record(history[dispatchId]) ? history[dispatchId] : history;
  if (!record(item) || !record(item.outputs)) return null;
  const nodeIds = nodeId ? [nodeId] : Object.keys(item.outputs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const currentNodeId of nodeIds) {
    const output = item.outputs[currentNodeId];
    if (!record(output) || !Array.isArray(output.images)) continue;
    const image = output.images[outputIndex];
    if (!record(image) || typeof image.filename !== 'string' || !image.filename) continue;
    return {
      nodeId: currentNodeId,
      filename: image.filename,
      subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
      type: typeof image.type === 'string' ? image.type : 'output',
    };
  }
  return null;
}

function comfyTerminalFailure(history: unknown, dispatchId: string): string | null {
  if (!record(history)) return null;
  const item = record(history[dispatchId]) ? history[dispatchId] : history;
  if (!record(item) || !record(item.status)) return null;
  const status = item.status;
  if (status.status_str === 'error') return 'ComfyUI workflow execution failed.';
  if (status.completed === true && record(item.outputs) && Object.keys(item.outputs).length === 0) return 'ComfyUI completed without an image output.';
  return null;
}

function collectImageNames(value: unknown, preferredNodeId?: string): string[] {
  const root = record(value) && preferredNodeId && record(value[preferredNodeId]) ? value[preferredNodeId] : value;
  const found: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 50_000) {
    const current = stack.pop()!;
    visited += 1;
    if (current.depth > 64) continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) stack.push({ value: current.value[index], depth: current.depth + 1 });
      continue;
    }
    if (!record(current.value)) continue;
    if (typeof current.value.image_name === 'string' && current.value.image_name.trim()) found.push(current.value.image_name.trim());
    const entries = Object.entries(current.value).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
    for (const [, child] of entries) stack.push({ value: child, depth: current.depth + 1 });
  }
  return [...new Set(found)];
}

async function downloadAndWrite(input: {
  config: WorkflowHostConfig;
  route: string;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof writeImageAssetBuffer>>> {
  const { response, buffer } = await requestBuffer(input.config, input.route, { method: 'GET', headers: { Accept: 'image/*' } }, input.timeoutMs, input.signal, MAX_IMAGE_RESPONSE_BYTES);
  if (!response.ok) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_DOWNLOAD', `${input.config.engine} image download returned HTTP ${response.status}.`);
  return await writeImageAssetBuffer({ projectDirAbs: input.projectDirAbs, outputAbsPath: input.outputAbsPath, buffer });
}

async function runComfyWorkflow(input: {
  config: WorkflowHostConfig;
  prepared: PreparedImageWorkflow;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<ImageWorkflowRunResult> {
  let submitted: unknown;
  try {
    submitted = await requestJson(input.config, 'prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.prepared.payload),
    }, Math.min(30_000, input.timeoutMs), input.signal);
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false });
  }
  const dispatchId = record(submitted) && typeof submitted.prompt_id === 'string' ? submitted.prompt_id : '';
  if (!dispatchId) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', 'ComfyUI did not return prompt_id.', { dispatched: true, terminal: false });
  const deadline = Date.now() + input.timeoutMs;
  try {
    while (Date.now() < deadline) {
      const history = await requestJson(input.config, `history/${encodeURIComponent(dispatchId)}`, { method: 'GET' }, deadlineTimeout(deadline), input.signal);
      const output = findComfyOutput(history, dispatchId, input.prepared.output_node_id, input.prepared.output_index);
      if (output) {
        const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type });
        let materialized: Awaited<ReturnType<typeof downloadAndWrite>>;
        try {
          materialized = await downloadAndWrite({
            config: input.config,
            route: `view?${query.toString()}`,
            projectDirAbs: input.projectDirAbs,
            outputAbsPath: input.outputAbsPath,
            timeoutMs: deadlineTimeout(deadline),
            signal: input.signal,
          });
        } catch (error) {
          throw new ImageWorkflowError('E_IMAGE_WORKFLOW_DOWNLOAD', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: true, dispatchId });
        }
        return {
          engine: 'comfyui', dispatch_id: dispatchId, output_path: materialized.output_path,
          output_node_id: output.nodeId, remote_output_id: output.filename,
          format: materialized.format, width: materialized.width, height: materialized.height,
          channels: materialized.channels, bytes: materialized.bytes, generation_calls: 1,
        };
      }
      const failure = comfyTerminalFailure(history, dispatchId);
      if (failure) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_FAILED', failure, { dispatched: true, terminal: true, dispatchId });
      await pollPause(input.pollIntervalMs, input.signal);
    }
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_TIMEOUT', 'ComfyUI workflow remains non-terminal; do not retry the same generation intent.', { dispatched: true, terminal: false, dispatchId });
  } catch (error) {
    if (error instanceof ImageWorkflowError && error.dispatched) throw error;
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false, dispatchId });
  }
}

async function runInvokeWorkflow(input: {
  config: WorkflowHostConfig;
  prepared: PreparedImageWorkflow;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<ImageWorkflowRunResult> {
  let submitted: unknown;
  try {
    submitted = await requestJson(input.config, 'api/v1/queue/default/enqueue_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.prepared.payload),
    }, Math.min(30_000, input.timeoutMs), input.signal);
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false });
  }
  const itemId = record(submitted) && Array.isArray(submitted.item_ids) ? Number(submitted.item_ids[0]) : NaN;
  if (!Number.isInteger(itemId) || itemId < 0) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', 'InvokeAI did not return an item id.', { dispatched: true, terminal: false });
  const dispatchId = String(itemId);
  const deadline = Date.now() + input.timeoutMs;
  try {
    while (Date.now() < deadline) {
      const item = await requestJson(input.config, `api/v1/queue/default/i/${itemId}`, { method: 'GET' }, deadlineTimeout(deadline), input.signal);
      if (!record(item)) throw new Error('InvokeAI returned an invalid queue item.');
      const status = String(item.status || '');
      if (status === 'failed' || status === 'canceled') {
        const detail = typeof item.error_message === 'string' ? sanitizeHostMessage(input.config, item.error_message.slice(0, 1_024)) : `queue item ${status}`;
        throw new ImageWorkflowError('E_IMAGE_WORKFLOW_FAILED', `InvokeAI ${detail}.`, { dispatched: true, terminal: true, dispatchId });
      }
      if (status === 'completed') {
        const session = record(item.session) ? item.session : {};
        const results = record(session.results) ? session.results : {};
        let preferredNodeId = input.prepared.output_node_id;
        if (preferredNodeId && record(session.source_prepared_mapping) && Array.isArray(session.source_prepared_mapping[preferredNodeId])) {
          preferredNodeId = String((session.source_prepared_mapping[preferredNodeId] as unknown[])[0] || preferredNodeId);
        }
        const names = collectImageNames(results, preferredNodeId);
        const imageName = names[input.prepared.output_index];
        if (!imageName) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', 'InvokeAI completed without the requested image output.', { dispatched: true, terminal: true, dispatchId });
        let materialized: Awaited<ReturnType<typeof downloadAndWrite>>;
        try {
          materialized = await downloadAndWrite({
            config: input.config,
            route: `api/v1/images/i/${encodeURIComponent(imageName)}/full`,
            projectDirAbs: input.projectDirAbs,
            outputAbsPath: input.outputAbsPath,
            timeoutMs: deadlineTimeout(deadline),
            signal: input.signal,
          });
        } catch (error) {
          throw new ImageWorkflowError('E_IMAGE_WORKFLOW_DOWNLOAD', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: true, dispatchId });
        }
        return {
          engine: 'invokeai', dispatch_id: dispatchId, output_path: materialized.output_path,
          ...(input.prepared.output_node_id ? { output_node_id: input.prepared.output_node_id } : {}),
          remote_output_id: imageName, format: materialized.format, width: materialized.width,
          height: materialized.height, channels: materialized.channels, bytes: materialized.bytes,
          generation_calls: 1,
        };
      }
      await pollPause(input.pollIntervalMs, input.signal);
    }
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_TIMEOUT', 'InvokeAI workflow remains non-terminal; do not retry the same generation intent.', { dispatched: true, terminal: false, dispatchId });
  } catch (error) {
    if (error instanceof ImageWorkflowError && error.dispatched) throw error;
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false, dispatchId });
  }
}

function decodeBase64Image(value: unknown, label: string): Buffer {
  const source = String(value || '').trim();
  const encoded = source.includes(',') ? source.slice(source.indexOf(',') + 1) : source;
  if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', `${label} is not a valid base64 image.`);
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_RESPONSE_BYTES) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_RESPONSE_LIMIT', `${label} exceeds the image response limit.`);
  return buffer;
}

async function runAutomatic1111Workflow(input: {
  config: WorkflowHostConfig;
  prepared: PreparedImageWorkflow;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ImageWorkflowRunResult> {
  const dispatchId = crypto.randomUUID();
  let response: unknown;
  try {
    response = await requestJson(input.config, `sdapi/v1/${input.prepared.mode || 'txt2img'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.prepared.payload),
    }, input.timeoutMs, input.signal, MAX_IMAGE_RESPONSE_BYTES);
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false, dispatchId });
  }
  if (!record(response) || !Array.isArray(response.images)) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', 'AUTOMATIC1111 completed without an images array.', { dispatched: true, terminal: true, dispatchId });
  }
  const encoded = response.images[input.prepared.output_index];
  if (typeof encoded !== 'string') {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', 'AUTOMATIC1111 completed without the requested image output.', { dispatched: true, terminal: true, dispatchId });
  }
  let materialized: Awaited<ReturnType<typeof writeImageAssetBuffer>>;
  try {
    materialized = await writeImageAssetBuffer({
      projectDirAbs: input.projectDirAbs,
      outputAbsPath: input.outputAbsPath,
      buffer: decodeBase64Image(encoded, 'AUTOMATIC1111 output'),
    });
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', (error as Error).message || String(error), { dispatched: true, terminal: true, dispatchId });
  }
  return {
    engine: 'automatic1111', dispatch_id: dispatchId, output_path: materialized.output_path,
    remote_output_id: `images[${input.prepared.output_index}]`, format: materialized.format,
    width: materialized.width, height: materialized.height, channels: materialized.channels,
    bytes: materialized.bytes, generation_calls: 1,
  };
}

async function runIopaintWorkflow(input: {
  config: WorkflowHostConfig;
  prepared: PreparedImageWorkflow;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ImageWorkflowRunResult> {
  const dispatchId = crypto.randomUUID();
  let response: Response;
  let buffer: Buffer;
  try {
    ({ response, buffer } = await requestBuffer(input.config, 'api/v1/inpaint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'image/*' },
      body: JSON.stringify(input.prepared.payload),
    }, input.timeoutMs, input.signal, MAX_IMAGE_RESPONSE_BYTES));
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_SUBMIT_UNCERTAIN', sanitizeHostMessage(input.config, (error as Error).message || String(error)), { dispatched: true, terminal: false, dispatchId });
  }
  if (!response.ok) {
    const detail = sanitizeHostMessage(input.config, buffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 2_048));
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_API', `IOPaint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`, { dispatched: true, terminal: true, dispatchId });
  }
  let materialized: Awaited<ReturnType<typeof writeImageAssetBuffer>>;
  try {
    materialized = await writeImageAssetBuffer({ projectDirAbs: input.projectDirAbs, outputAbsPath: input.outputAbsPath, buffer });
  } catch (error) {
    throw new ImageWorkflowError('E_IMAGE_WORKFLOW_OUTPUT', (error as Error).message || String(error), { dispatched: true, terminal: true, dispatchId });
  }
  return {
    engine: 'iopaint', dispatch_id: dispatchId, output_path: materialized.output_path,
    remote_output_id: String(response.headers.get('x-seed') || 'inpaint'), format: materialized.format,
    width: materialized.width, height: materialized.height, channels: materialized.channels,
    bytes: materialized.bytes, generation_calls: 1,
  };
}

export async function runImageWorkflow(input: {
  prepared: PreparedImageWorkflow;
  projectDirAbs: string;
  outputAbsPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<ImageWorkflowRunResult> {
  const config = configuredHost(input.prepared.engine);
  if (!config) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_NOT_CONFIGURED', `${input.prepared.engine} is not configured by the host.`);
  const projectDirAbs = path.resolve(input.projectDirAbs);
  const outputAbsPath = path.resolve(input.outputAbsPath);
  if (!isPathAllowed(outputAbsPath, [projectDirAbs])) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_PATH', 'output_path must stay inside the image project.');
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_INPUT', 'timeout_ms must be from 1000 to 1800000.');
  const pollIntervalMs = input.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(input.pollIntervalMs);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10_000) throw new ImageWorkflowError('E_IMAGE_WORKFLOW_INPUT', 'poll interval is invalid.');
  const common = { config, prepared: input.prepared, projectDirAbs, outputAbsPath, timeoutMs, pollIntervalMs, signal: input.signal };
  if (input.prepared.engine === 'comfyui') return await runComfyWorkflow(common);
  if (input.prepared.engine === 'invokeai') return await runInvokeWorkflow(common);
  if (input.prepared.engine === 'automatic1111') return await runAutomatic1111Workflow(common);
  return await runIopaintWorkflow(common);
}
