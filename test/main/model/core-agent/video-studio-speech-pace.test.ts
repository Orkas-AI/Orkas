import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: function BrowserWindow() {},
  session: {},
}));

const UID = 'speech-pace-user';
const ENV_KEYS = ['ORKAS_WORKSPACE_ROOT', 'ORKAS_TTS_BASE_URL', 'ORKAS_TTS_API_KEY', 'ORKAS_TTS_MODEL', 'ORKAS_TTS_VOICE'] as const;
let root = '';
let workspace = '';
let previous: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-speech-pace-')));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data');
  // An environment-configured endpoint lists its one voice without a network call.
  process.env.ORKAS_TTS_BASE_URL = 'https://configured-speech.example.invalid/v1';
  process.env.ORKAS_TTS_API_KEY = 'test-key';
  process.env.ORKAS_TTS_MODEL = 'test-tts';
  process.env.ORKAS_TTS_VOICE = 'zh_tingting';
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const configured = userWorkspace.setWorkspacePath(UID, workspace);
  if (configured.ok === false) throw new Error(configured.error);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function capabilities(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { createVideoStudioTool } = await import('../../../../src/main/model/core-agent/video-studio-tool');
  const tool = createVideoStudioTool({ userId: UID });
  const result = await tool.execute({ op: 'speech.capabilities', ...input }, { workingDir: workspace, state: {} } as any);
  return JSON.parse(result.content);
}

// Live runs on 2026-11-17–19 wrote Chinese lines at about 5 characters a second against the 4.5
// the voices read, and generate_speech refused 27 of them as too long for their scenes.
describe('speech.capabilities pace', () => {
  it('says how many characters a scene holds in the language asked for, from the rates the length check uses', async () => {
    const zh = await capabilities({ language: 'zh-CN' });
    expect(zh).toMatchObject({ ok: true, requested_language: 'zh-CN' });
    expect(zh.pace).toBe('At speed 1, zh-CN narration runs about 4.5 characters a second, plus 0.28 s at each full stop and 0.12 s at each comma, so a 5 s scene holds about 20 characters. Write each line to fit its scene before generate_speech.');

    const { estimateNarrationDuration } = await import('../../../../src/main/util/narration-timing');
    // The 20 characters it names, with one comma and one full stop, fit 5 s; one more does not.
    expect(estimateNarrationDuration(`${'字'.repeat(10)}，${'字'.repeat(10)}。`).estimatedSec).toBeLessThanOrEqual(5);
    expect(estimateNarrationDuration(`${'字'.repeat(11)}，${'字'.repeat(11)}。`).estimatedSec).toBeGreaterThan(5);

    expect((await capabilities({ language: 'en-US' })).pace).toBe('At speed 1, en-US narration runs about 2.5 words a second, plus 0.28 s at each full stop and 0.12 s at each comma, so a 5 s scene holds about 11 words. Write each line to fit its scene before generate_speech.');
  });

  it('names no pace without a language', async () => {
    const all = await capabilities({});
    expect(all).toMatchObject({ ok: true });
    expect(all).not.toHaveProperty('pace');
  });
});
