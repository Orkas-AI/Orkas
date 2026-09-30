import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn(), warn: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { installWindowCloseConfirmation } from '../../../src/main/features/window_close_confirmation';
import { setCurrentLang, SUPPORTED_LANGS, t } from '../../../src/main/i18n';

function fixture() {
  const win = new EventEmitter() as EventEmitter & { close(): void; isDestroyed(): boolean };
  let closed = false;
  let veto = false;
  const state = { active: true, quitting: false };
  win.isDestroyed = () => closed;
  win.close = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.emit('close', event);
    if (!event.defaultPrevented && !veto) closed = true;
  };
  installWindowCloseConfirmation(win as BrowserWindow, () => state.active, () => state.quitting);
  return { win, state, vetoClose: (value: boolean) => { veto = value; } };
}

beforeEach(() => {
  vi.resetAllMocks();
  setCurrentLang('en');
});

describe('closing the main window during task execution', () => {
  it('closes immediately when no tasks are running', () => {
    const { win, state } = fixture();
    state.active = false;
    win.close();
    expect(win.isDestroyed()).toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('keeps work and the window open on cancel, then allows an explicit close', async () => {
    const { win, state } = fixture();
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
    win.close();
    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
    expect(win.isDestroyed()).toBe(false);
    expect(state.active).toBe(true);
    expect(mocks.showMessageBox.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0 });
    win.close();
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true));
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('keeps one pending decision even if work finishes and close is clicked again', async () => {
    let respond!: (result: { response: number }) => void;
    mocks.showMessageBox.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const { win, state } = fixture();
    win.close();
    state.active = false;
    win.close();
    expect(win.isDestroyed()).toBe(false);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    respond({ response: 0 });
    await Promise.resolve();
    win.close();
    expect(win.isDestroyed()).toBe(true);
  });

  it.each(['sync', 'async'])('preserves the window after a %s dialog failure and permits retry', async (mode) => {
    if (mode === 'sync') mocks.showMessageBox.mockImplementationOnce(() => { throw new Error('Unavailable'); });
    else mocks.showMessageBox.mockRejectedValueOnce(new Error('Unavailable'));
    const { win } = fixture();
    win.close();
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());
    expect(win.isDestroyed()).toBe(false);
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    win.close();
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true));
  });

  it('does not interrupt an already-started app quit or update restart', () => {
    const { win, state } = fixture();
    state.quitting = true;
    win.close();
    expect(win.isDestroyed()).toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('ignores a late confirmation after the window has closed during app quit', async () => {
    let respond!: (result: { response: number }) => void;
    mocks.showMessageBox.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const { win, state } = fixture();
    const close = vi.spyOn(win, 'close');
    win.close();
    state.quitting = true;
    win.close();
    respond({ response: 1 });
    await Promise.resolve();
    expect(win.isDestroyed()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('asks again if another close handler vetoed the confirmed close', async () => {
    const { win, vetoClose } = fixture();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    vetoClose(true);
    win.close();
    await Promise.resolve();
    expect(win.isDestroyed()).toBe(false);
    vetoClose(false);
    win.close();
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true));
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('uses the current UI language when each dialog is opened', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    const { win } = fixture();
    for (const lang of SUPPORTED_LANGS) {
      setCurrentLang(lang);
      win.close();
      await Promise.resolve();
      const options = mocks.showMessageBox.mock.calls.at(-1)![1];
      expect(options.message).toBe(t('window.close_running_message'));
      expect(options.message).not.toContain('window.close_');
      expect(options.buttons).toEqual([t('common.cancel'), t('window.close_confirm')]);
    }
  });
});
