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
    // fake CLI reads one stdin line (the user message JSON) and then
    // emits its stream-json output. We can't EOF-wait the way a real
    // pipeline would (`cat > /dev/null`) because the backend now keeps
    // stdin open for the whole turn to handle control_request — same
    // contract real claude code has.
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
read prompt
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
# Stay alive long enough to be killed. We don't bother reading stdin
# here — the backend will write the prompt + later call stdin.end(),
# both no-ops once SIGTERM lands.
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

  it('accumulates assistant.message.usage and emits running status:usage events', async () => {
    // Two assistant blocks in sequence, each with its own usage
    // snapshot. We expect TWO status:usage events with cumulative
    // running totals (mirrors multica's per-model usage map but
    // collapsed to a single flat record).
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
read prompt
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"s-acc","cwd":"/x"}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"part 1"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":20}}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"part 2"}],"usage":{"input_tokens":10,"output_tokens":40,"cache_read_input_tokens":1100,"cache_creation_input_tokens":0}}}
{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":110,"output_tokens":90,"cache_read_input_tokens":2100,"cache_creation_input_tokens":20},"total_cost_usd":0.0234,"message":{"model":"claude-sonnet-4-6"}}
EOF
`);
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'go',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 3000,
    });
    const usageEvents = events.filter(e => e.type === 'status' && e.status === 'usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0].usage).toMatchObject({
      input: 100, output: 50, cacheRead: 1000, cacheCreate: 20, model: 'claude-sonnet-4-6',
    });
    // Second one should be the cumulative running total.
    expect(usageEvents[1].usage).toMatchObject({
      input: 110, output: 90, cacheRead: 2100, cacheCreate: 20,
    });
    // The terminal status:result still carries claude's authoritative
    // (already-summed) usage from the result record + the cost field.
    const resultStatus = events.find(e => e.type === 'status' && e.status === 'result');
    expect(resultStatus?.usage).toMatchObject({
      input: 110, output: 90, cacheRead: 2100, cacheCreate: 20, cost: 0.0234,
    });
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
  });

  it('auto-responds to control_request and surfaces a permission-request event', async () => {
    // fake CLI: reads the prompt, emits init + a control_request, then
    // reads ONE more line from stdin (our control_response) and only
    // then emits the terminal result. If the backend doesn't write the
    // response, the script blocks on its second `read` until the
    // 3-second test timeout fires — that's the silent-hang symptom
    // we're fixing.
    //
    // We tee the response we received to stderr so the test can assert
    // exactly what got written back to the CLI.
    const fake = writeShellExecutable(tmpDir, 'claude', `#!/bin/sh
read prompt
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-perm","cwd":"/x"}
{"type":"control_request","request_id":"req-42","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}
EOF
read response
echo "GOT_RESPONSE: $response" 1>&2
cat <<'EOF'
{"type":"result","subtype":"success","result":"ok"}
EOF
`);
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'run ls',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 3000,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('permission-request');
    const perm = events.find(e => e.type === 'permission-request');
    expect(perm).toMatchObject({ id: 'req-42', tool: 'Bash', autoDecided: 'allow', reason: 'bypass' });
    // Verify the response we wrote back is a valid control_response
    // referencing the same request_id (the fake CLI tees it to stderr).
    const stderrLines = events
      .filter(e => e.type === 'stderr-line')
      .map(e => (e as any).line as string);
    const responseEcho = stderrLines.find(l => l.startsWith('GOT_RESPONSE:'));
    expect(responseEcho).toBeDefined();
    expect(responseEcho).toMatch(/"control_response"/);
    expect(responseEcho).toMatch(/"req-42"/);
    expect(responseEcho).toMatch(/"behavior":"allow"/);
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
  });
});
