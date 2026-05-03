/**
 * End-to-end-ish smoke test for the claude backend without requiring
 * the real `claude` CLI installed. We synthesize a tiny shell script
 * that emits valid stream-json on stdout and then exits, then exercise
 * `claudeBackend.run` against it. Skipped on Windows where /bin/sh
 * isn't there — manual verification on Windows uses a real CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { claudeBackend } from '../../../../src/main/features/local_agents/backends/claude';

const isWindows = process.platform === 'win32';

function writeShellExecutable(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

describe('local_agents/backends/claude › end-to-end with fake CLI', () => {
  if (isWindows) {
    it.skip('(skipped on Windows)', () => { /* */ });
    return;
  }

  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-claude-e2e-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('parses a minimal completed conversation', async () => {
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
# Read stdin and discard — claude is invoked with --input-format stream-json.
cat > /dev/null
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-fake","cwd":"/x"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"world."}]}}
{"type":"result","subtype":"success","result":"Hello world.","total_cost_usd":0,"duration_ms":1}
EOF
`);
    const events: any[] = [];
    const ac = new AbortController();
    await claudeBackend.run({
      binPath: fake,
      prompt: 'hi',
      cwd: tmpDir,
      signal: ac.signal,
      onEvent: e => events.push(e),
      timeoutMs: 5000,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('process-info');
    expect(types).toContain('text-delta');
    expect(types[types.length - 1]).toBe('done');
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
    expect(done.output).toBe('Hello world.');
    expect(done.sessionId).toBe('sess-fake');
  });

  it('reports failed status when the CLI exits non-zero', async () => {
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
cat > /dev/null
echo "boom: model unavailable" 1>&2
exit 7
`);
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'hi', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 5000,
    });
    const done = events[events.length - 1];
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/exited with code 7|reported error/);
  });

  it('cancels mid-run via AbortSignal (SIGTERM)', async () => {
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
cat > /dev/null
# Stay alive long enough to be killed.
sleep 10
`);
    const events: any[] = [];
    const ac = new AbortController();
    const promise = claudeBackend.run({
      binPath: fake,
      prompt: 'hi', cwd: tmpDir,
      signal: ac.signal,
      onEvent: e => events.push(e),
      timeoutMs: 30_000,
    });
    setTimeout(() => ac.abort(), 100);
    await promise;
    const done = events[events.length - 1];
    expect(done.status).toBe('cancelled');
  });
});
