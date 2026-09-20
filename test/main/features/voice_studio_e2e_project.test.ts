import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bundledRuntimeEnv, bundledNodeExecutable } from '../../../src/main/util/bundled-runtime';

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');

it('executes the packaged project script across independent processes, recovers audio, and exports timed speech', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-project-e2e-')));
  const env = { ...process.env, ...bundledRuntimeEnv() };
  const node = bundledNodeExecutable();
  expect(node, 'The shipped Node runtime is required; this case must not fetch one.').toBeTruthy();
  const project = path.join(root, 'voice-project.json');
  const plan = { schema_version: 1, roles: { reader: { route_ref: 'fixture', voice_ref: 'fixture-voice', language: 'en' } },
    segments: [{ id: 'line', role: 'reader', text: 'Hello.', gap_after_sec: 0.25 }] };
  const invoke = async (op: string, fields = {}) => {
    const request = path.join(root, 'request.json');
    await fs.writeFile(request, JSON.stringify({ project, ...fields }));
    const result = await exec(node!, [script, op, request], { env, timeout: 30000, maxBuffer: 1024 * 1024 });
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  try {
    await fs.writeFile(project, JSON.stringify(plan));
    const begun = await invoke('begin', { segment_id: 'line' });
    // Controlled synthesis boundary: make real audio without calling a paid API.
    const generated = await exec(env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', begun.request.output_path]);
    expect(generated.stderr).toBe('');
    expect((await invoke('status')).segments[0].status).toBe('uncertain');
    await invoke('record', { segment_id: 'line', key: begun.key });
    const result = await invoke('render', { format: 'wav' });
    expect(result.duration_sec).toBeCloseTo(1.25, 2);
    expect(result.captions_complete).toBe(true);
    const captions = await fs.readFile(path.join(root, result.files.find((f: string) => f.endsWith('.srt'))), 'utf8');
    expect(captions).toContain('00:00:00,000 --> 00:00:01,000\nHello.');
    plan.segments[0].gap_after_sec = 0.5;
    await fs.writeFile(project, JSON.stringify(plan));
    expect((await invoke('status')).segments[0]).toMatchObject({ status: 'ready', key: begun.key });
    const revised = await invoke('render');
    expect(revised.duration_sec).toBeCloseTo(1.5, 1);
    expect((await fs.stat(path.join(root, result.files[0]))).size).toBeGreaterThan(44);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60000);
