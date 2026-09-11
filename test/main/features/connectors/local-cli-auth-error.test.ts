import { describe, expect, it } from 'vitest';
import { localCliAuthDiagnostic, sanitizeAuthorizationDetail } from '../../../../src/main/features/connectors/local-cli-auth-error';

describe('official CLI authorization error disclosure', () => {
  it('preserves new provider reasons without a phrase allowlist or leaking other envelope fields', () => {
    const message = 'Application access requires administrator approval for this workspace.';
    const output = `browser consent completed\n${JSON.stringify({ error: {
      category: 'auth', code: 2, message, hint: 'private account information',
      trace_id: 'private-trace', details: { access_token: 'private-token' },
    } }, null, 2)}\n[Orkas] official CLI exited with 2\n`;
    const diagnostic = localCliAuthDiagnostic(output);
    expect(diagnostic).toMatchObject({ category: 'auth', provider_exit_code: 2 });
    expect(diagnostic.detail).toContain(message);
    expect(diagnostic.detail).not.toMatch(/private account|private-trace|private-token/);
  });

  it('redacts credentials and private locations before displaying a bounded cause', () => {
    const message = [
      '\x1b[31mPermission denied\x1b[0m',
      'access_token=fixture-access; refreshToken: "fixture refresh secret"; appSecret=fixture-app;',
      'user_code=ABCD-EFGH; deviceCode: fixture-device; authCode=fixture-auth;',
      'Bearer fixture-bearer; https://login.example.test/callback?code=fixture-code&state=fixture-state',
      'Cannot read /Users/test/private credentials.json',
      'Cannot read C:\\Users\\fixture\\private credentials.json',
      'admin@example.test 13800138000',
      '-----BEGIN PRIVATE KEY-----\nfixture-pem\n-----END PRIVATE KEY-----',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fixtureSignature',
      '0123456789abcdef0123456789abcdef',
    ].join('\n');
    const detail = localCliAuthDiagnostic(JSON.stringify({ error: { category: 'auth', code: 2, message } })).detail;
    expect(detail).toContain('Permission denied');
    expect(detail).toContain('[redacted]');
    expect(detail).not.toMatch(/fixture|ABCD|EFGH|https:|Users|credentials\.json|admin@|13800138000|eyJ|0123456789abcdef|\x1b/);
    expect(sanitizeAuthorizationDetail(detail)).toBe(detail);
    expect(sanitizeAuthorizationDetail('Authorization failed. '.repeat(500)).length).toBe(1200);
    const unfinished = sanitizeAuthorizationDetail('Permission denied; password="unfinished private value');
    expect(unfinished).toContain('Permission denied');
    expect(unfinished).not.toMatch(/unfinished|private|value/);
  });

  it('shows failures in plain text, unfamiliar JSON and incomplete output without requiring a known error shape', () => {
    const reason = 'Workspace policy version 47 requires a new administrator review.';
    for (const output of [
      reason,
      JSON.stringify({ error: reason }),
      JSON.stringify({ result: { explanation: reason } }),
      `{"error":{"message":"${reason}`,
    ]) {
      const detail = localCliAuthDiagnostic(output).detail;
      expect(detail).toContain(reason);
    }
    expect(localCliAuthDiagnostic(' \n\x1b[0m').detail).toBe('');
  });

  it('keeps the terminal failure visible after lengthy progress and redacts plain-text credentials', () => {
    const reason = 'Approval service rejected this request because the review window has closed.';
    const output = `${'{"progress":"waiting"}\n'.repeat(100)}${reason}; access_token=fixture-secret`;
    const detail = localCliAuthDiagnostic(output).detail;
    expect(detail).toContain(reason);
    expect(detail).not.toContain('fixture-secret');
    expect(detail.length).toBeLessThanOrEqual(1200);
    expect(localCliAuthDiagnostic(`${'Waiting for approval. '.repeat(4000)}\n${reason}`).detail).toContain(reason);
  });

  it('does not rewrite a provider message using a provider-specific prefix rule', () => {
    const message = 'device authorization failed: a previously unseen account restriction';
    expect(localCliAuthDiagnostic(JSON.stringify({ error: { message } })).detail).toBe(message);
  });

  it('does not let an earlier structured message hide a subsequent plain-text failure', () => {
    const reason = 'Consent storage is unavailable; reconnect after the service recovers.';
    const output = `${JSON.stringify({ error: { message: 'Earlier attempt timed out' } })}\n${reason}`;
    expect(localCliAuthDiagnostic(output).detail).toContain(reason);
  });

  it('reads quoted braces and multiple complete records without confusing error metadata with a cause', () => {
    const message = 'Access to "{workspace}" is denied; contact the administrator.';
    expect(localCliAuthDiagnostic(`unrelated output\n${JSON.stringify({ success: false })}\n${JSON.stringify({
      error: { message, category: 'private-category', code: 'private-token' },
    }, null, 2)}`)).toEqual({ detail: message });
  });
});
