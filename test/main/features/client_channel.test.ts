import { afterEach, describe, expect, it } from 'vitest';

import {
  currentClientChannel,
  resolveClientChannel,
} from '../../../src/main/features/client_channel';

const originalClientChannel = process.env.ORKAS_CLIENT_CHANNEL;
const originalLegacyChannel = process.env.ORKAS_CHANNEL;

afterEach(() => {
  if (originalClientChannel === undefined) delete process.env.ORKAS_CLIENT_CHANNEL;
  else process.env.ORKAS_CLIENT_CHANNEL = originalClientChannel;
  if (originalLegacyChannel === undefined) delete process.env.ORKAS_CHANNEL;
  else process.env.ORKAS_CHANNEL = originalLegacyChannel;
});

describe('client channel resolution', () => {
  it('always identifies the public application as open', () => {
    process.env.ORKAS_CLIENT_CHANNEL = 'prod';
    process.env.ORKAS_CHANNEL = 'prod';

    expect(resolveClientChannel()).toBe('open');
    expect(currentClientChannel()).toBe('open');
  });

  it('stays open without channel environment variables', () => {
    delete process.env.ORKAS_CLIENT_CHANNEL;
    delete process.env.ORKAS_CHANNEL;

    expect(resolveClientChannel()).toBe('open');
    expect(currentClientChannel()).toBe('open');
  });
});
