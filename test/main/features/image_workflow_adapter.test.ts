import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ImageWorkflowError,
  imageWorkflowCapabilities,
  prepareImageWorkflow,
  runImageWorkflow,
  validateImageWorkflowBaseUrl,
} from '../../../src/main/features/image_workflow_adapter';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let root = '';
let projectDir = '';
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-workflow-'));
  projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  previousEnv = {
    ORKAS_COMFYUI_BASE_URL: process.env.ORKAS_COMFYUI_BASE_URL,
    ORKAS_COMFYUI_API_KEY: process.env.ORKAS_COMFYUI_API_KEY,
    ORKAS_INVOKEAI_BASE_URL: process.env.ORKAS_INVOKEAI_BASE_URL,
    ORKAS_INVOKEAI_API_TOKEN: process.env.ORKAS_INVOKEAI_API_TOKEN,
    ORKAS_AUTOMATIC1111_BASE_URL: process.env.ORKAS_AUTOMATIC1111_BASE_URL,
    ORKAS_AUTOMATIC1111_API_AUTH: process.env.ORKAS_AUTOMATIC1111_API_AUTH,
    ORKAS_IOPAINT_BASE_URL: process.env.ORKAS_IOPAINT_BASE_URL,
    ORKAS_IOPAINT_API_TOKEN: process.env.ORKAS_IOPAINT_API_TOKEN,
  };
  delete process.env.ORKAS_COMFYUI_BASE_URL;
  delete process.env.ORKAS_COMFYUI_API_KEY;
  delete process.env.ORKAS_INVOKEAI_BASE_URL;
  delete process.env.ORKAS_INVOKEAI_API_TOKEN;
  delete process.env.ORKAS_AUTOMATIC1111_BASE_URL;
  delete process.env.ORKAS_AUTOMATIC1111_API_AUTH;
  delete process.env.ORKAS_IOPAINT_BASE_URL;
  delete process.env.ORKAS_IOPAINT_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeWorkflow(name: string, value: unknown): string {
  const file = path.join(projectDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('image workflow adapter security', () => {
  it('allows local/private HTTP and requires HTTPS for public hosts', () => {
    expect(validateImageWorkflowBaseUrl('http://127.0.0.1:8188', 'comfyui').hostname).toBe('127.0.0.1');
    expect(validateImageWorkflowBaseUrl('http://192.168.1.10:9090', 'invokeai').hostname).toBe('192.168.1.10');
    expect(validateImageWorkflowBaseUrl('http://[fd00::1]:8080', 'iopaint').hostname).toBe('[fd00::1]');
    expect(validateImageWorkflowBaseUrl('https://image.example.com/api', 'comfyui').pathname).toBe('/api');
    expect(() => validateImageWorkflowBaseUrl('http://image.example.com', 'comfyui')).toThrow('requires HTTPS');
    expect(() => validateImageWorkflowBaseUrl('http://fcevil.example.com', 'comfyui')).toThrow('requires HTTPS');
    expect(() => validateImageWorkflowBaseUrl('http://fdomain.example.com', 'comfyui')).toThrow('requires HTTPS');
    expect(() => validateImageWorkflowBaseUrl('https://token@example.com', 'comfyui')).toThrow('must not contain credentials');
    expect(() => validateImageWorkflowBaseUrl('file:///tmp/server', 'invokeai')).toThrow('HTTP or HTTPS');
  });

  it('keeps workflow JSON inside the image project and strips envelope metadata', async () => {
    const workflow = writeWorkflow('comfy.json', {
      '3': { class_type: 'SaveImage', inputs: {} },
      output_node_id: '3',
      output_index: 0,
    });
    const prepared = await prepareImageWorkflow({ engine: 'comfyui', projectDirAbs: projectDir, workflowAbsPath: workflow });
    expect(prepared.output_node_id).toBe('3');
    expect(prepared.payload.prompt).toEqual({ '3': { class_type: 'SaveImage', inputs: {} } });

    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    await expect(prepareImageWorkflow({ engine: 'comfyui', projectDirAbs: projectDir, workflowAbsPath: outside }))
      .rejects.toThrow('workflow_path must stay inside');
  });

  it('requires project-local A1111 image bindings and rejects extension scripts', async () => {
    fs.writeFileSync(path.join(root, 'outside.png'), PNG_1X1);
    const outside = writeWorkflow('a1111-outside.json', {
      mode: 'img2img',
      init_image_paths: ['../outside.png'],
      request: { prompt: 'edit' },
    });
    await expect(prepareImageWorkflow({ engine: 'automatic1111', projectDirAbs: projectDir, workflowAbsPath: outside }))
      .rejects.toThrow('must stay inside the image project');

    const scripted = writeWorkflow('a1111-script.json', {
      mode: 'txt2img',
      request: { prompt: 'image', script_name: 'untrusted-extension' },
    });
    await expect(prepareImageWorkflow({ engine: 'automatic1111', projectDirAbs: projectDir, workflowAbsPath: scripted }))
      .rejects.toThrow('script_name is not allowed');
  });

  it('reports configured capability without exposing endpoint or token', async () => {
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    process.env.ORKAS_COMFYUI_API_KEY = 'super-secret';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ system: { os: 'linux' } }), { status: 200 }));
    const capabilities = await imageWorkflowCapabilities();
    const serialized = JSON.stringify(capabilities);
    expect(serialized).toContain('"executable":true');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('super-secret');
  });

  it('redacts a host that echoes its credential in an API error', async () => {
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    process.env.ORKAS_COMFYUI_API_KEY = 'echoed-secret';
    const workflow = writeWorkflow('redaction.json', { '1': { class_type: 'SaveImage', inputs: {} } });
    vi.stubGlobal('fetch', async () => new Response('denied X-API-Key=echoed-secret', { status: 401 }));
    const prepared = await prepareImageWorkflow({ engine: 'comfyui', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const promise = runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'never.png'), timeoutMs: 1_000 });
    await expect(promise).rejects.not.toThrow('echoed-secret');
    await expect(promise).rejects.toThrow('[redacted]');
  });
});

describe('image workflow adapter execution', () => {
  it('runs ComfyUI prompt/history/view, authenticates, and materializes a validated image', async () => {
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    process.env.ORKAS_COMFYUI_API_KEY = 'comfy-key';
    const workflow = writeWorkflow('comfy.json', {
      workflow: { '9': { class_type: 'SaveImage', inputs: {} } },
      output_node_id: '9',
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'prompt-1', number: 1 }), { status: 200 });
      if (url.endsWith('/history/prompt-1')) return new Response(JSON.stringify({
        'prompt-1': { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } },
      }), { status: 200 });
      if (url.includes('/view?')) return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png' } });
      throw new Error(`unexpected URL ${url}`);
    });
    const prepared = await prepareImageWorkflow({ engine: 'comfyui', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const result = await runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'result.png'), timeoutMs: 5_000, pollIntervalMs: 0 });

    expect(result).toMatchObject({ engine: 'comfyui', dispatch_id: 'prompt-1', output_node_id: '9', width: 1, height: 1, generation_calls: 1 });
    expect(fs.statSync(result.output_path).size).toBeGreaterThan(0);
    expect((calls[0]?.init.headers as Record<string, string>)['X-API-Key']).toBe('comfy-key');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ prompt: { '9': { class_type: 'SaveImage' } } });
  });

  it('runs the current InvokeAI enqueue/item/image protocol', async () => {
    process.env.ORKAS_INVOKEAI_BASE_URL = 'http://127.0.0.1:9090';
    process.env.ORKAS_INVOKEAI_API_TOKEN = 'invoke-token';
    const workflow = writeWorkflow('invoke.json', {
      graph: { id: 'graph-1', nodes: { save: { id: 'save', type: 'l2i' } }, edges: [] },
      output_node_id: 'save',
    });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer invoke-token');
      if (url.endsWith('/enqueue_batch')) return new Response(JSON.stringify({ item_ids: [42] }), { status: 201 });
      if (url.endsWith('/i/42')) return new Response(JSON.stringify({
        status: 'completed',
        session: {
          source_prepared_mapping: { save: ['save-prepared'] },
          results: { 'save-prepared': { type: 'image_output', image: { image_name: 'invoke.png' }, width: 1, height: 1 } },
        },
      }), { status: 200 });
      if (url.endsWith('/images/i/invoke.png/full')) return new Response(PNG_1X1, { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const prepared = await prepareImageWorkflow({ engine: 'invokeai', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const result = await runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'invoke-result.webp'), timeoutMs: 5_000, pollIntervalMs: 0 });

    expect(result).toMatchObject({ engine: 'invokeai', dispatch_id: '42', remote_output_id: 'invoke.png', format: 'webp', width: 1, height: 1 });
    expect(calls).toHaveLength(3);
  });

  it('runs an AUTOMATIC1111 img2img request with project-local references and host-only auth', async () => {
    process.env.ORKAS_AUTOMATIC1111_BASE_URL = 'http://127.0.0.1:7860';
    process.env.ORKAS_AUTOMATIC1111_API_AUTH = 'artist:secret';
    fs.writeFileSync(path.join(projectDir, 'source.png'), PNG_1X1);
    fs.writeFileSync(path.join(projectDir, 'mask.png'), PNG_1X1);
    const workflow = writeWorkflow('automatic1111.json', {
      mode: 'img2img',
      init_image_paths: ['source.png'],
      mask_path: 'mask.png',
      request: { prompt: 'replace only the masked object', denoising_strength: 0.4 },
    });
    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:7860/sdapi/v1/img2img');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('artist:secret').toString('base64')}`);
      submitted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ images: [PNG_1X1.toString('base64')], parameters: {}, info: '{}' }), { status: 200 });
    });
    const prepared = await prepareImageWorkflow({ engine: 'automatic1111', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const result = await runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'a1111-result.png'), timeoutMs: 5_000 });

    expect(result).toMatchObject({ engine: 'automatic1111', width: 1, height: 1, generation_calls: 1 });
    expect((submitted?.init_images as string[])[0]).toMatch(/^data:image\/png;base64,/);
    expect(submitted?.mask).toMatch(/^data:image\/png;base64,/);
  });

  it('runs IOPaint inpaint with project-local image and mask', async () => {
    process.env.ORKAS_IOPAINT_BASE_URL = 'http://127.0.0.1:8080';
    process.env.ORKAS_IOPAINT_API_TOKEN = 'iopaint-token';
    fs.writeFileSync(path.join(projectDir, 'source.png'), PNG_1X1);
    fs.writeFileSync(path.join(projectDir, 'mask.png'), PNG_1X1);
    const workflow = writeWorkflow('iopaint.json', {
      image_path: 'source.png',
      mask_path: 'mask.png',
      request: { prompt: '', hd_strategy: 'Crop', sd_keep_unmasked_area: true },
    });
    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:8080/api/v1/inpaint');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer iopaint-token');
      submitted = JSON.parse(String(init.body));
      return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png', 'x-seed': '42' } });
    });
    const prepared = await prepareImageWorkflow({ engine: 'iopaint', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const result = await runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'iopaint-result.webp'), timeoutMs: 5_000 });

    expect(result).toMatchObject({ engine: 'iopaint', remote_output_id: '42', format: 'webp', width: 1, height: 1 });
    expect(submitted?.image).toMatch(/^data:image\/png;base64,/);
    expect(submitted?.mask).toMatch(/^data:image\/png;base64,/);
  });

  it('marks a lost post-dispatch poll as uncertain so callers cannot retry blindly', async () => {
    process.env.ORKAS_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';
    const workflow = writeWorkflow('uncertain.json', { '1': { class_type: 'SaveImage', inputs: {} } });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'uncertain-1' }), { status: 200 });
      throw new Error('connection lost');
    });
    const prepared = await prepareImageWorkflow({ engine: 'comfyui', projectDirAbs: projectDir, workflowAbsPath: workflow });
    const promise = runImageWorkflow({ prepared, projectDirAbs: projectDir, outputAbsPath: path.join(projectDir, 'never.png'), timeoutMs: 1_000, pollIntervalMs: 0 });
    await expect(promise).rejects.toMatchObject<ImageWorkflowError>({
      code: 'E_IMAGE_WORKFLOW_UNCERTAIN',
      dispatched: true,
      terminal: false,
      dispatchId: 'uncertain-1',
    });
  });
});
