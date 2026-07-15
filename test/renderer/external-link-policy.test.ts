import { describe, expect, it } from 'vitest';

import { safeExternalUserActionUrl } from '../../src/main/util/window-security';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _safeHref } = require('../../src/renderer/modules/utils.js') as {
  _safeHref: (value: string) => string;
};

describe('cross-layer external link policy', () => {
  it('keeps renderer and main allow-lists aligned for valid user-clicked links', () => {
    for (const value of [
      'https://example.com/path',
      'http://example.com/path',
      'mailto:alice@example.com',
      'tel:+8613800138000',
      'sms:+8613800138000',
      'callto:+1-555-0100',
      'xmpp:alice@example.com',
    ]) {
      expect(_safeHref(value), value).toBe(value);
      expect(safeExternalUserActionUrl(value), value).toBe(value);
    }
  });

  it('keeps private resources and ambiguous paths out of top-level links', () => {
    for (const value of [
      'chat-media://local/Users/test/note.txt',
      'chat-app://cid/a/b/index.html',
      'kb-file://kb/private.pdf',
      'blob:https://example.com/id',
      'file:///etc/passwd',
      './relative/path',
      '../relative/path',
      '/absolute/path',
    ]) {
      expect(_safeHref(value), value).toBe('');
      expect(safeExternalUserActionUrl(value), value).toBeNull();
    }
  });

  it('reserves hash anchors for renderer-local handling', () => {
    expect(_safeHref('#details')).toBe('#details');
    expect(safeExternalUserActionUrl('#details')).toBeNull();
  });
});
