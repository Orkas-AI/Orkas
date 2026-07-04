/**
 * Logger unit tests.
 *
 * Scope:
 *   - `redact()` walks objects and masks sensitive-looking field names
 *     without touching stack traces or plain strings.
 *   - `sweepLogs()` drops files older than the retention window AND
 *     keeps total size under the cap. The live file is never deleted.
 *
 * Out of scope: electron-log's own transport behaviour (file I/O paths,
 * format templates) — those are exercised end-to-end at runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `redact` / `sweepLogs` don't touch the filesystem for logs themselves
// (sweepLogs reads `LOGS_DIR`, so we redirect workspace to a tempdir).

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-logger-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Force logger + paths modules to re-evaluate with the new env; without
  // this the `LOGS_DIR` constant keeps the stale path from an earlier suite.
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('logger › redact', () => {
  it('masks sensitive-looking field names at any depth', async () => {
    const { redact } = await import('../../src/main/logger');
    const out = redact({
      user: 'alice',
      apiKey: 'sk-secret',
      nested: {
        access_token: 'at-value',
        refresh_token: 'rt-value',
        plain: 'visible',
      },
      list: [{ token: 't1' }, { token: 't2' }],
    }) as any;
    expect(out.user).toBe('alice');
    expect(out.apiKey).toBe('***REDACTED***');
    expect(out.nested.access_token).toBe('***REDACTED***');
    expect(out.nested.refresh_token).toBe('***REDACTED***');
    expect(out.nested.plain).toBe('visible');
    expect(out.list[0].token).toBe('***REDACTED***');
    expect(out.list[1].token).toBe('***REDACTED***');
  });

  it('sanitizes non-sensitive string fields inside objects', async () => {
    const { redact } = await import('../../src/main/logger');
    const out = redact({
      url: 'https://example.test/oauth/callback?code=abc123&state=csrf456&ok=1',
      note: 'contact alice@example.com phone 13800138000',
      absPath: '/Users/test/Secret Project/report.pdf',
      relPath: 'cloud/contexts/private/customer-plan.md',
      user_id: 'ABCDEF1234567890',
      session_id: 'session-secret-value',
    }) as any;
    expect(out.url).toBe('https://example.test/oauth/callback?code=***&state=***&ok=1');
    expect(out.note).toBe('contact a***@example.com phone 138****8000');
    expect(out.absPath).toContain('<abs-path:');
    expect(out.relPath).toContain('<cloud-path:');
    expect(JSON.stringify(out)).not.toContain('/Users/alice');
    expect(JSON.stringify(out)).not.toContain('customer-plan.md');
    expect(out.user_id).toBe('ABCD...7890');
    expect(out.session_id).toBe('***REDACTED***');
  });

  it('masks PII field names (phone / mobile / email / username) but leaves name passthrough', async () => {
    const { redact } = await import('../../src/main/logger');
    const out = redact({
      phone: '13800138000',
      mobile: '+8613800138000',
      email: 'alice@example.com',
      username: 'alice',
      // `name` is intentionally NOT a redact key — too broad (agent.name etc).
      name: 'Alpha Agent',
      // PII-shaped fields nested in an array.
      contacts: [{ email: 'b@example.com', phone: '13900139000' }],
    }) as any;
    expect(out.phone).toBe('***REDACTED***');
    expect(out.mobile).toBe('***REDACTED***');
    expect(out.email).toBe('***REDACTED***');
    expect(out.username).toBe('***REDACTED***');
    expect(out.name).toBe('Alpha Agent');
    expect(out.contacts[0].email).toBe('***REDACTED***');
    expect(out.contacts[0].phone).toBe('***REDACTED***');
  });

  it('is case-insensitive on the key name', async () => {
    const { redact } = await import('../../src/main/logger');
    const out = redact({
      APIKEY: 'A',
      ApiKey: 'B',
      Secret: 'C',
      PASSWORD: 'D',
    }) as any;
    expect(out.APIKEY).toBe('***REDACTED***');
    expect(out.ApiKey).toBe('***REDACTED***');
    expect(out.Secret).toBe('***REDACTED***');
    expect(out.PASSWORD).toBe('***REDACTED***');
  });

  it('passes non-string primitives through unchanged and sanitizes strings', async () => {
    const { redact } = await import('../../src/main/logger');
    expect(redact('hello')).toBe('hello');
    expect(redact('token=secret-value contact alice@example.com')).toBe('token=*** contact a***@example.com');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('keeps Error shape but sanitizes message, stack, and custom fields', async () => {
    const { redact } = await import('../../src/main/logger');
    const err = Object.assign(new Error('request failed Authorization: Bearer abc.def'), {
      token: 'secret',
      url: 'https://example.test/cb?code=oauth-code&ok=1',
    });
    err.stack = 'Error: request failed Authorization: Bearer abc.def\n    at user alice@example.com';
    const out = redact(err) as Error & { token?: string; url?: string };
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(err);
    expect(out.message).toBe('request failed Authorization: Bearer ***');
    expect(out.stack).toContain('Authorization: Bearer ***');
    expect(out.stack).toContain('a***@example.com');
    expect(out.token).toBe('***REDACTED***');
    expect(out.url).toBe('https://example.test/cb?code=***&ok=1');
  });

  it('short-circuits circular references', async () => {
    const { redact } = await import('../../src/main/logger');
    const a: any = { name: 'root' };
    a.self = a;
    const out = redact(a) as any;
    expect(out.name).toBe('root');
    // The self-reference is replaced, not traversed forever.
    expect(out.self).toBe('[circular]');
  });
});

describe('logger › sweepLogs', () => {
  it('deletes files older than RETAIN_DAYS based on date prefix', async () => {
    const { sweepLogs } = await import('../../src/main/logger');
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const oldDate = '2026-01-01';    // far older than 7 days
    const recentDate = '2026-04-20'; // today (test-frozen)
    fs.writeFileSync(path.join(logsDir, `${oldDate}.log`), 'old');
    fs.writeFileSync(path.join(logsDir, `${recentDate}.log`), 'recent');

    const out = sweepLogs(new Date(`${recentDate}T12:00:00`));
    expect(out.removed).toContain(`${oldDate}.log`);
    expect(out.reason[`${oldDate}.log`]).toBe('age');
    expect(fs.existsSync(path.join(logsDir, `${oldDate}.log`))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, `${recentDate}.log`))).toBe(true);
  });

  it('keeps today\'s live file intact even if size cap would hit it', async () => {
    const { sweepLogs } = await import('../../src/main/logger');
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const today = '2026-04-20';
    const filePath = path.join(logsDir, `${today}.log`);
    // Write anything — sweep should skip today's file.
    fs.writeFileSync(filePath, 'x'.repeat(1024));

    const out = sweepLogs(new Date(`${today}T12:00:00`));
    expect(out.removed).not.toContain(`${today}.log`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('ignores non-log files in the logs directory', async () => {
    const { sweepLogs } = await import('../../src/main/logger');
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    fs.writeFileSync(path.join(logsDir, 'README.md'), '# keep me');
    fs.writeFileSync(path.join(logsDir, '2026-04-20.log'), 'live');

    const out = sweepLogs(new Date('2026-04-20T12:00:00'));
    expect(out.removed).toHaveLength(0);
    expect(fs.existsSync(path.join(logsDir, 'README.md'))).toBe(true);
  });
});

describe('logger › createLogger / logFromRenderer', () => {
  it('createLogger returns a 4-method scoped logger', async () => {
    const { createLogger } = await import('../../src/main/logger');
    const l = createLogger('test');
    expect(typeof l.info).toBe('function');
    expect(typeof l.warn).toBe('function');
    expect(typeof l.error).toBe('function');
    expect(typeof l.debug).toBe('function');
  });

  it('logFromRenderer does not throw on malformed payloads', async () => {
    const { logFromRenderer } = await import('../../src/main/logger');
    expect(() => logFromRenderer({} as any)).not.toThrow();
    expect(() => logFromRenderer({ level: 'bogus', module: 'x', message: 'hi' } as any)).not.toThrow();
    expect(() => logFromRenderer(undefined as any)).not.toThrow();
  });
});
