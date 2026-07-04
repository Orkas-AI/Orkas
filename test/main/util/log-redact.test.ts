import { describe, expect, it } from 'vitest';
import { logErrorSummary, maskId, safeUrlAction } from '../../../src/main/util/log-redact';

describe('log-redact', () => {
  it('masks opaque account and local ids while preserving anonymous', () => {
    expect(maskId('anonymous')).toBe('anonymous');
    expect(maskId('7242')).toBe('72***42');
    expect(maskId('D69540E0-CF31-424C-9318-30231197EA39')).toBe('D695...EA39');
    expect(maskId('')).toBe('');
  });

  it('strips query and hash secrets from URLs', () => {
    expect(safeUrlAction('app://auth/callback?exchange_code=secret&state=s')).toBe('app://auth/callback');
    expect(safeUrlAction('https://orkas.ai/views/login/login.html#d=device&state=s')).toBe('https://orkas.ai/views/login/login.html');
  });

  it('does not echo non-url arguments such as local paths', () => {
    expect(safeUrlAction('/Users/test/Orkas?token=secret')).toBe('<non-url>');
  });

  it('summarizes errors without logging message text', () => {
    const summary = logErrorSummary(new Error('private prompt fragment sk-secret1234567890'));

    expect(summary).toEqual(expect.objectContaining({
      name: 'Error',
      message_chars: 'private prompt fragment sk-secret1234567890'.length,
    }));
    expect(summary).toHaveProperty('message_hash');
    expect(JSON.stringify(summary)).not.toContain('private prompt fragment');
    expect(JSON.stringify(summary)).not.toContain('sk-secret1234567890');
  });
});
