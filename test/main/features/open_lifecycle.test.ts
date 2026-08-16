import { describe, expect, it } from 'vitest';

import {
  OpenLifecycleState,
  openLifecycleRequestBody,
  startOpenLifecycleTracking,
  type OpenLifecycleRecord,
} from '../../../src/main/features/open_lifecycle';


class FakeApp {
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): void {
    const group = this.listeners.get(event) || new Set<() => void>();
    group.add(listener);
    this.listeners.set(event, group);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) || []) listener();
  }
}

describe('OpenLifecycleState', () => {
  it('emits only real cold-start, foreground, background, and quit transitions', () => {
    const records: OpenLifecycleRecord[] = [];
    const state = new OpenLifecycleState((record) => records.push(record));

    state.start();
    state.start();
    state.enterForeground();
    state.leaveForeground('background');
    state.leaveForeground('background');
    state.enterForeground();
    state.enterForeground();
    state.leaveForeground('quit');

    expect(records).toEqual([
      { event: 'enter', trigger: 'cold_start' },
      { event: 'leave', trigger: 'background' },
      { event: 'enter', trigger: 'foreground' },
      { event: 'leave', trigger: 'quit' },
    ]);
  });

  it('keeps the public request body closed to three fields', () => {
    expect(openLifecycleRequestBody('12345678', {
      event: 'enter',
      trigger: 'cold_start',
    })).toEqual({
      uid: '12345678',
      event: 'enter',
      trigger: 'cold_start',
    });
  });

  it('settles blur before leaving and removes every listener on stop', () => {
    const app = new FakeApp();
    const records: OpenLifecycleRecord[] = [];
    const timers: Array<() => void> = [];
    let focused = true;
    const stop = startOpenLifecycleTracking({
      app,
      getActiveUserId: () => 'unused',
      hasFocusedWindow: () => focused,
      emit: (record) => records.push(record),
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    });

    app.emit('browser-window-blur');
    timers.shift()?.();
    expect(records).toEqual([{ event: 'enter', trigger: 'cold_start' }]);

    focused = false;
    app.emit('browser-window-blur');
    timers.shift()?.();
    app.emit('browser-window-focus');
    app.emit('before-quit');
    app.emit('before-quit');

    expect(records).toEqual([
      { event: 'enter', trigger: 'cold_start' },
      { event: 'leave', trigger: 'background' },
      { event: 'enter', trigger: 'foreground' },
      { event: 'leave', trigger: 'quit' },
    ]);

    stop();
    app.emit('browser-window-focus');
    expect(records).toHaveLength(4);
  });

  it('does not register or emit in synthetic launch modes', () => {
    const app = new FakeApp();
    const records: OpenLifecycleRecord[] = [];
    startOpenLifecycleTracking({
      app,
      getActiveUserId: () => 'unused',
      hasFocusedWindow: () => true,
      enabled: false,
      emit: (record) => records.push(record),
    });

    app.emit('browser-window-focus');
    app.emit('before-quit');
    expect(records).toEqual([]);
  });
});
