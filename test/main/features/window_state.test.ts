import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electronMock = vi.hoisted(() => ({
  screen: {
    getAllDisplays: vi.fn(),
    getPrimaryDisplay: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  screen: electronMock.screen,
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-window-state-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  electronMock.screen.getAllDisplays.mockReturnValue([
    { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
  ]);
  electronMock.screen.getPrimaryDisplay.mockReturnValue({
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
  });
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function load() {
  const paths = await import('../../../src/main/paths');
  const state = await import('../../../src/main/features/window_state');
  return { paths, state };
}

describe('features/window_state', () => {
  it('uses the default bounds when no saved state exists', async () => {
    const { state } = await load();

    expect(state.restoreWindowState()).toEqual({
      bounds: { width: 1280, height: 800 },
      isMaximized: false,
    });
  });

  it('restores a visible saved position and size', async () => {
    const { paths, state } = await load();
    fs.writeFileSync(paths.WINDOW_STATE_FILE, JSON.stringify({
      x: 80,
      y: 60,
      width: 1100,
      height: 720,
      isMaximized: true,
    }));

    expect(state.restoreWindowState()).toEqual({
      bounds: { x: 80, y: 60, width: 1100, height: 720 },
      isMaximized: true,
    });
  });

  it('keeps the saved size but drops an off-screen position', async () => {
    const { paths, state } = await load();
    fs.writeFileSync(paths.WINDOW_STATE_FILE, JSON.stringify({
      x: 9000,
      y: 9000,
      width: 1000,
      height: 700,
    }));

    expect(state.restoreWindowState()).toEqual({
      bounds: { width: 1000, height: 700 },
      isMaximized: false,
    });
  });

  it('persists normal bounds for a maximized window', async () => {
    const { paths, state } = await load();
    const win = {
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1440, height: 900 })),
      getNormalBounds: vi.fn(() => ({ x: 100, y: 80, width: 1180, height: 760 })),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
    };

    state.saveWindowStateNow(win as never);

    expect(JSON.parse(fs.readFileSync(paths.WINDOW_STATE_FILE, 'utf8'))).toEqual({
      x: 100,
      y: 80,
      width: 1180,
      height: 760,
      isMaximized: true,
    });
  });
});
