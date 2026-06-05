/**
 * `sanitizeLogTextForUpload` — fixtures pin both the shapes that MUST be
 * masked (set A) and the look-alike shapes that MUST be preserved (set B).
 * Follows PC/CLAUDE.md §9 "Hard rule for LLM-output text munging" — the
 * same rule applies to any text-processing util whose accepted-input matrix
 * could be widened over time.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeLogTextForUpload } from '../../../src/main/util/log-sanitize';

describe('sanitizeLogTextForUpload › set A (must be masked)', () => {
  it('masks Bearer token from raw Authorization header', () => {
    const out = sanitizeLogTextForUpload('Authorization: Bearer abc.def-123_XYZ');
    expect(out).toBe('Authorization: Bearer ***');
  });

  it('masks Bearer token inside a JSON-stringified blob', () => {
    const out = sanitizeLogTextForUpload('{"authorization":"Bearer eyJhbGc"}');
    expect(out).toBe('{"authorization":"***"}');
  });

  it('is case-insensitive on the Bearer scheme name (RFC 6750)', () => {
    const out = sanitizeLogTextForUpload('Cookie: bearer x.y.z');
    expect(out).toBe('Cookie: Bearer ***');
  });

  it('masks a JWT-shaped 3-segment token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-part';
    const out = sanitizeLogTextForUpload(`token=${jwt} expired`);
    expect(out).toBe('token=*** expired');
  });

  it('masks JWT-shaped text even without a token= prefix', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-part';
    const out = sanitizeLogTextForUpload(`raw ${jwt} expired`);
    expect(out).toBe('raw ***JWT*** expired');
  });

  it('masks secret-looking key=value fragments', () => {
    const out = sanitizeLogTextForUpload('refresh_token=rt-value session_id=sid-value uid=ABCDEF1234567890 ok=true');
    expect(out).toBe('refresh_token=*** session_id=*** uid=ABCD...7890 ok=true');
  });

  it('masks secret-looking JSON fields', () => {
    const out = sanitizeLogTextForUpload('{"access_token":"at-value","name":"visible"}');
    expect(out).toBe('{"access_token":"***","name":"visible"}');
  });

  it('masks sensitive URL query params while preserving harmless params', () => {
    const out = sanitizeLogTextForUpload('https://example.test/cb?code=abc&state=def&ok=1');
    expect(out).toBe('https://example.test/cb?code=***&state=***&ok=1');
  });

  it('masks signed object-storage URL query params', () => {
    const out = sanitizeLogTextForUpload('https://cos.test/file?q-ak=AKID&q-signature=sig&x-cos-security-token=tok&key=keep');
    expect(out).toBe('https://cos.test/file?q-ak=***&q-signature=***&x-cos-security-token=***&key=keep');
  });

  it('masks cloud-relative paths while keeping a stable diagnostic placeholder', () => {
    const out = sanitizeLogTextForUpload('failed to read cloud/contexts/private/customer-plan.md');
    expect(out).toContain('<cloud-path:');
    expect(out).not.toContain('customer-plan.md');
  });

  it('masks local absolute paths and file URLs', () => {
    const out = sanitizeLogTextForUpload(
      'open /Users/user/Secret Project/report.pdf then file:///Users/user/Secret Project/index.html',
    );
    expect(out).toContain('<abs-path:');
    expect(out).toContain('<file-url-path:');
    expect(out).not.toContain('/Users/user');
    expect(out).not.toContain('Secret Project');
  });

  it('masks Windows absolute paths', () => {
    const out = sanitizeLogTextForUpload('copy C:\\Users\\Alice\\Private\\token.txt failed');
    expect(out).toContain('<abs-path:');
    expect(out).not.toContain('Alice');
    expect(out).not.toContain('token.txt');
  });

  it('masks common provider token prefixes', () => {
    const out = sanitizeLogTextForUpload('key sk-test-placeholder');
    expect(out).toBe('key ***TOKEN***');
  });

  it('masks email to first-char + domain (Server mask_email parity)', () => {
    const out = sanitizeLogTextForUpload('user contacted alice.smith+test@orkas.ai today');
    expect(out).toBe('user contacted a***@orkas.ai today');
  });

  it('masks CN mobile to 138****8000 (Server mask_phone parity)', () => {
    const out = sanitizeLogTextForUpload('phone reported as 13800138000 in audit');
    expect(out).toBe('phone reported as 138****8000 in audit');
  });

  it('applies multiple patterns in a single pass', () => {
    const out = sanitizeLogTextForUpload(
      'Authorization: Bearer X; contact: a@b.io; phone 13800138000',
    );
    expect(out).toBe('Authorization: Bearer ***; contact: a***@b.io; phone 138****8000');
  });
});

describe('sanitizeLogTextForUpload › set B (must be preserved)', () => {
  it('leaves "BearerWord" (no whitespace after Bearer) untouched', () => {
    // word-boundary follower required — "Bearer" without trailing whitespace
    // is just a word in prose, not an auth header.
    const out = sanitizeLogTextForUpload('class BearerWord extends Auth');
    expect(out).toBe('class BearerWord extends Auth');
  });

  it('leaves a single base64url-looking segment (no JWT structure) untouched', () => {
    // "eyJfoo" by itself is not a JWT — needs three dot-separated segments.
    const out = sanitizeLogTextForUpload('payload prefix eyJfooBar after');
    expect(out).toBe('payload prefix eyJfooBar after');
  });

  it('leaves non-query code fields untouched', () => {
    const out = sanitizeLogTextForUpload('response code=200 status=ok');
    expect(out).toBe('response code=200 status=ok');
  });

  it('leaves a malformed email (1-char TLD) untouched', () => {
    const out = sanitizeLogTextForUpload('placeholder x@y.z user note');
    expect(out).toBe('placeholder x@y.z user note');
  });

  it('leaves a 10-digit number (not a CN mobile) untouched', () => {
    const out = sanitizeLogTextForUpload('order id 1380013800 retrieved');
    expect(out).toBe('order id 1380013800 retrieved');
  });

  it('leaves a 12-digit number (too long for a CN mobile) untouched', () => {
    const out = sanitizeLogTextForUpload('measurement 138001380001 ms');
    expect(out).toBe('measurement 138001380001 ms');
  });

  it('leaves a SHA-like 40-hex string untouched (avoids commit-sha false positives)', () => {
    const sha = 'd24a12b33252f4c2f0b8c4c8cb790b610268bce7104dc531';
    const out = sanitizeLogTextForUpload(`merge base ${sha} resolved`);
    expect(out).toBe(`merge base ${sha} resolved`);
  });

  it('leaves the word "phone" or "email" in prose untouched (positional value-only matchers)', () => {
    // The redact() layer handles named field MASKING for keys phone/email/
    // username via REDACT_KEYS; this util only matches value-shaped text.
    const out = sanitizeLogTextForUpload('field "phone" missing in payload');
    expect(out).toBe('field "phone" missing in payload');
  });
});

describe('sanitizeLogTextForUpload › edge cases', () => {
  it('returns empty input unchanged', () => {
    expect(sanitizeLogTextForUpload('')).toBe('');
  });

  it('handles multi-line text', () => {
    const input = 'line 1: Bearer XYZ\nline 2: a@b.io\nline 3: 13800138000';
    const out = sanitizeLogTextForUpload(input);
    expect(out).toBe('line 1: Bearer ***\nline 2: a***@b.io\nline 3: 138****8000');
  });

  it('masks every occurrence in a single string (global flag)', () => {
    const out = sanitizeLogTextForUpload('Bearer A then Bearer B');
    expect(out).toBe('Bearer *** then Bearer ***');
  });
});
