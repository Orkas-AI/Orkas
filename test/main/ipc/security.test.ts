import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isTrustedIpcSender,
  parseInvokeEnvelope,
  parseStreamEnvelope,
  parseStreamRequestId,
} from '../../../src/main/ipc/security';

const rendererUrl = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'index.html')).toString();

describe('IPC security envelope', () => {
  it('trusts only the exact local renderer entry', () => {
    expect(isTrustedIpcSender({ getURL: () => rendererUrl })).toBe(true);
    expect(isTrustedIpcSender({ getURL: () => `${rendererUrl}?boot=1#ready` })).toBe(true);
    expect(isTrustedIpcSender({ getURL: () => 'https://example.test/' })).toBe(false);
    expect(isTrustedIpcSender({ getURL: () => pathToFileURL('/tmp/index.html').toString() })).toBe(false);
    expect(isTrustedIpcSender({ getURL: () => 'file:///not%ZZvalid' })).toBe(false);
    expect(isTrustedIpcSender({})).toBe(false);
  });

  it('accepts only bounded channel names and object payloads', () => {
    expect(parseInvokeEnvelope({ channel: 'permissions.getLocalExec', payload: { ok: true } })).toEqual({
      channel: 'permissions.getLocalExec',
      payload: { ok: true },
    });
    expect(parseInvokeEnvelope({ channel: 'sync.status' })).toEqual({ channel: 'sync.status', payload: {} });
    for (const value of [
      null,
      [],
      { channel: '' },
      { channel: '../escape' },
      { channel: 'a'.repeat(129) },
      { channel: 'sync.status', payload: [] },
      { channel: 'sync.status', payload: 'bad' },
    ]) {
      expect(parseInvokeEnvelope(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('validates stream request ids independently from channels', () => {
    expect(parseStreamEnvelope({ requestId: 'rabc-1', channel: 'autoTasks.events', payload: {} })).toEqual({
      requestId: 'rabc-1',
      channel: 'autoTasks.events',
      payload: {},
    });
    expect(parseStreamEnvelope({ requestId: 'bad/id', channel: 'autoTasks.events' })).toBeNull();
    expect(parseStreamEnvelope({ requestId: 'r1', channel: 'bad channel' })).toBeNull();
    expect(parseStreamRequestId('rabc-1')).toBe('rabc-1');
    expect(parseStreamRequestId({})).toBe('');
  });
});
