import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactPaths } from '../../../src/main/util/redact';
import {
  fileToolBuildRef,
  logErrorRef,
  logErrorSummary,
  maskId,
  safeUrlAction,
  sanitizeLogText,
} from '../../../src/main/util/log-redact';

describe('log-redact', () => {
  it('identifies different file-tool builds without logging source bytes or inventing a partial build id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tool-build-'));
    const sources = [
      'src/main/model/core-agent/file-tools.ts', 'src/main/model/core-agent/local-tools.ts',
      'src/main/model/core-agent/read-tracker.ts', 'src/core-agent/src/tools/apply-patch.ts',
      'src/core-agent/src/tools/file-diagnostics.ts', 'src/core-agent/src/tools/base.ts',
      'src/core-agent/src/agent/runner.ts',
    ];
    try {
      for (const file of sources) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), 'synthetic private source');
      }
      const first = fileToolBuildRef(root);
      expect(first).toMatchObject({ status: 'complete', source_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(fileToolBuildRef(root)).toEqual(first);
      fs.appendFileSync(path.join(root, sources[0]), ' changed');
      expect(fileToolBuildRef(root).source_hash).not.toBe(first.source_hash);
      fs.unlinkSync(path.join(root, sources[1]));
      const incomplete = fileToolBuildRef(root);
      expect(incomplete).toEqual({ status: 'incomplete', unavailable_sources: 1 });
      expect(JSON.stringify([first, incomplete])).not.toContain(root);
      expect(JSON.stringify([first, incomplete])).not.toContain('private');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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

  it('redacts private absolute paths in structured error references', () => {
    const ref = logErrorRef(
      new Error("EEXIST: file already exists, mkdir '/Users/test/Private Clips/not-a-directory'"),
    );
    const serialized = JSON.stringify(ref);

    expect(serialized).toContain('<abs-path:');
    expect(serialized).not.toContain('/Users/test');
    expect(serialized).not.toContain('Private Clips');
    expect(serialized).not.toContain('not-a-directory');
  });

  it('preserves safe URLs adjacent to cloud paths while redacting secrets', () => {
    const text = sanitizeLogText(
      'failed cloud/agents/abc123/skills/private/SKILL.md via https://example.com/sync/sts?token=secret ghp_abcdefghijklmnopqrstuvwxyz',
    );

    expect(text).toContain('<cloud-path:');
    expect(text).toContain('https://example.com/sync/sts');
    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain('private/SKILL.md');
    expect(text).not.toContain('token=secret');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts local paths in subprocess stderr tails', () => {
    const out = redactPaths(
      "ffmpeg failed for /Users/user/Private Clips/demo.mov and C:\\Users\\user\\Videos\\secret.mp4",
    );

    expect(out).toContain('<path>');
    expect(out).not.toContain('/Users/user');
    expect(out).not.toContain('user\\Videos');
    expect(out).not.toContain('secret.mp4');
  });
});
