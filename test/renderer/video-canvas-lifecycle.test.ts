import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../../src/renderer/modules/video-canvas.js'), 'utf8');

// Transport rejection is tested before native IPC diagnostics are involved.
// Real-window rendering, refused reads and navigation races live in the E2Es.
function lifecycle() {
  const element = () => ({ hidden: true, classList: { toggle: vi.fn() }, setAttribute: vi.fn() });
  const toggle = element();
  const dot = element();
  const panel = element();
  const elements = new Map([
    ['video-canvas-toggle', toggle], ['video-canvas-update-dot', dot], ['video-canvas-panel', panel],
  ]);
  const warn = vi.fn();
  const error = vi.fn();
  const runtime: any = { orkas: { invoke: vi.fn() } };
  runInNewContext(source, {
    window: runtime,
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById: (id: string) => elements.get(id) ?? null,
    },
    t: (key: string) => key,
    createLogger: () => ({ warn, error }),
  });
  const reply = (name: string) => ({ ok: true, video_studio: true, productions: [{ dir: 'ad', name }] });
  return { runtime, toggle, dot, panel, warn, error, reply, invoke: runtime.orkas.invoke, canvas: runtime.VideoCanvas };
}

describe('video canvas transport recovery', () => {
  it('keeps the last successful baseline and unread reminder across rejected reads, then clears on opening', async () => {
    const { canvas, invoke, reply, toggle, dot, panel, warn, error } = lifecycle();
    invoke.mockResolvedValue(reply('Known content'));
    await canvas.probe('task-a');
    expect(toggle.hidden).toBe(false);
    expect(dot.hidden).toBe(true);

    invoke.mockRejectedValueOnce(new Error('Fixture transport unavailable'));
    await canvas.refresh();
    expect(toggle.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    invoke.mockResolvedValue(reply('New content'));
    await canvas.refresh();
    expect(dot.hidden).toBe(false);
    invoke.mockRejectedValueOnce(new Error('Fixture transport unavailable'));
    await canvas.refresh();
    expect(dot.hidden).toBe(false);
    expect(panel.hidden).toBe(true);

    await canvas.open('task-a');
    expect(panel.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(warn.mock.calls).toEqual([
      ['canvas read failed', { error_type: 'Error' }],
      ['canvas read failed', { error_type: 'Error' }],
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not carry another task into an initial read failure and recovers without a false update', async () => {
    const { canvas, invoke, reply, toggle, dot, warn, error } = lifecycle();
    invoke.mockResolvedValue(reply('Task A'));
    await canvas.probe('task-a');
    invoke.mockResolvedValue(reply('Task A changed'));
    await canvas.refresh();
    expect(dot.hidden).toBe(false);
    invoke.mockRejectedValueOnce(new Error('Fixture transport unavailable'));
    await canvas.probe('task-b');
    expect(toggle.hidden).toBe(true);
    expect(dot.hidden).toBe(true);
    invoke.mockResolvedValue(reply('Task B'));
    await canvas.refresh();
    expect(toggle.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith('canvas read failed', { error_type: 'Error' });
    expect(error).not.toHaveBeenCalled();
  });
});
