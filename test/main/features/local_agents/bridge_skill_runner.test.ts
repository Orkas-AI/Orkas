import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);
const { createBridgeSkillRunner, killProcessTree } = requireCjs('../../../../bin/bridge-skill-runner.cjs') as {
  createBridgeSkillRunner(options: {
    outputDir: string;
    nodePath: string;
    runnerPath: string;
    timeoutMs?: number;
    previewBytes?: number;
    hardOutputBytes?: number;
    killGraceMs?: number;
    settleMs?: number;
    shutdownSettleMs?: number;
  }): {
    run(input: {
      skillRef: string;
      scriptBase: string;
      args?: string[];
      skillDir: string;
    }): Promise<any>;
    read(input: {
      outputRef: string;
      stream: 'stdout' | 'stderr';
      offset?: number;
      limit?: number;
    }): any;
    shutdown(): Promise<void>;
  };
  killProcessTree(
    child: { pid?: number; kill(signal?: string): boolean },
    signal?: string,
    options?: Record<string, unknown>,
  ): void;
};

const tempDirs: string[] = [];

function fixture(source: string, options: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bridge-skill-runner-'));
  tempDirs.push(dir);
  const runnerPath = path.join(dir, 'runner.cjs');
  fs.writeFileSync(runnerPath, source, 'utf8');
  return createBridgeSkillRunner({
    outputDir: path.join(dir, 'output'),
    nodePath: process.execPath,
    runnerPath,
    ...options,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI bridge Skill runner', () => {
  it('does not expose MCP bridge credentials to Skill subprocesses', async () => {
    const previous = new Map<string, string | undefined>();
    const secrets = {
      ORKAS_BRIDGE_TOKEN: 'private-run-token',
      ORKAS_BRIDGE_SOCKET: '/private/bridge.sock',
      ORKAS_BRIDGE_ENV_FILE: '/private/bridge-env.json',
      ORKAS_BRIDGE_CAPABILITIES: 'connectors,chat.read',
      ORKAS_BRIDGE_SKILL_OUTPUT_DIR: '/private/skill-output',
    };
    for (const [key, value] of Object.entries(secrets)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    const runner = fixture(`
      const values = Object.fromEntries(
        Object.keys(process.env)
          .filter((key) => key.startsWith('ORKAS_BRIDGE_'))
          .map((key) => [key, process.env[key]]),
      );
      process.stdout.write(JSON.stringify({ values, skillDir: process.env.ORKAS_RUN_SKILL_DIR }));
    `);

    try {
      const result = await runner.run({
        skillRef: 'demo',
        scriptBase: 'run',
        skillDir: tempDirs[0],
      });
      expect(result.status).toBe('succeeded');
      expect(JSON.parse(result.stdout.text)).toEqual({
        values: {},
        skillDir: tempDirs[0],
      });
    } finally {
      await runner.shutdown();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps oversized UTF-8 output readable after the bounded preview', async () => {
    const expected = `${'你'.repeat(200)}END`;
    const expectedError = `${'错'.repeat(160)}ERR`;
    const runner = fixture(
      `process.stdout.write(${JSON.stringify(expected)}); process.stderr.write(${JSON.stringify(expectedError)});`,
      {
        previewBytes: 101,
        hardOutputBytes: 4096,
      },
    );

    const result = await runner.run({
      skillRef: 'demo',
      scriptBase: 'run',
      skillDir: tempDirs[0],
    });

    expect(result.status).toBe('succeeded');
    expect(result.outputLimitExceeded).toBe(false);
    expect(result.stdout.bytes).toBe(Buffer.byteLength(expected));
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.text).not.toContain('\ufffd');
    expect(result.outputRef).toMatch(/^[a-f0-9]{32}$/);

    let reconstructed = result.stdout.text;
    let offset = result.stdout.nextOffset;
    let done = false;
    while (!done) {
      const page = runner.read({
        outputRef: result.outputRef,
        stream: 'stdout',
        offset,
        limit: 101,
      });
      expect(page.text).not.toContain('\ufffd');
      expect(page.nextOffset).toBeGreaterThan(offset);
      reconstructed += page.text;
      offset = page.nextOffset;
      done = page.done;
    }
    expect(reconstructed).toBe(expected);

    let reconstructedError = result.stderr.text;
    offset = result.stderr.nextOffset;
    done = false;
    while (!done) {
      const page = runner.read({
        outputRef: result.outputRef,
        stream: 'stderr',
        offset,
        limit: 101,
      });
      expect(page.text).not.toContain('\ufffd');
      expect(page.nextOffset).toBeGreaterThan(offset);
      reconstructedError += page.text;
      offset = page.nextOffset;
      done = page.done;
    }
    expect(reconstructedError).toBe(expectedError);
  });

  it('separates the hard safety limit from preview truncation', async () => {
    const runner = fixture("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);", {
      timeoutMs: 5000,
      previewBytes: 100,
      hardOutputBytes: 1024,
      killGraceMs: 50,
      settleMs: 100,
    });

    const result = await runner.run({
      skillRef: 'demo',
      scriptBase: 'run',
      skillDir: tempDirs[0],
    });

    expect(result.status).toBe('output_limit');
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout).toMatchObject({
      bytes: 1024,
      truncated: true,
      sourceTruncated: true,
    });
    const retained = runner.read({
      outputRef: result.outputRef,
      stream: 'stdout',
      offset: 0,
      limit: 1024,
    });
    expect(retained).toMatchObject({ done: true, nextOffset: 1024, bytes: 1024 });
    expect(retained.text).toBe('x'.repeat(1024));
  });

  it('returns after timeout when a process tree ignores TERM and holds output open', async () => {
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const source = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      fs.writeFileSync(
        path.join(process.env.ORKAS_RUN_SKILL_DIR, 'timeout-pids.json'),
        JSON.stringify({ parent: process.pid, child: child.pid }),
      );
      process.stdout.write('started');
      setInterval(() => {}, 1000);
    `;
    const runner = fixture(source, {
      timeoutMs: 500,
      previewBytes: 100,
      hardOutputBytes: 4096,
      killGraceMs: 60,
      settleMs: 120,
    });
    const startedAt = Date.now();
    const marker = path.join(tempDirs[0], 'timeout-pids.json');
    let processTree: { parent: number; child: number } | null = null;

    try {
      const result = await runner.run({
        skillRef: 'demo',
        scriptBase: 'run',
        skillDir: tempDirs[0],
      });
      processTree = JSON.parse(fs.readFileSync(marker, 'utf8')) as {
        parent: number;
        child: number;
      };

      expect(result.status).toBe('timed_out');
      expect(result.timedOut).toBe(true);
      expect(result.stdout.text).toContain('started');
      expect(Date.now() - startedAt).toBeLessThan(2500);
      await waitFor(() => processTree !== null
        && !processIsAlive(processTree.parent)
        && !processIsAlive(processTree.child));
    } finally {
      if (processTree) {
        for (const pid of [processTree.parent, processTree.child]) {
          if (processIsAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
      }
    }
  });

  it('kills every active Skill process tree when shutdown is repeated', async () => {
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const source = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const label = process.argv[5];
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
        stdio: 'ignore',
      });
      fs.writeFileSync(
        path.join(process.env.ORKAS_RUN_SKILL_DIR, 'active-pids-' + label + '.json'),
        JSON.stringify({ parent: process.pid, child: child.pid }),
      );
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const runner = fixture(source, {
      timeoutMs: 5000,
      shutdownSettleMs: 500,
    });
    const markers = ['one', 'two'].map((label) => (
      path.join(tempDirs[0], `active-pids-${label}.json`)
    ));
    const runPromises = ['one', 'two'].map((label) => runner.run({
      skillRef: 'demo',
      scriptBase: 'run',
      args: [label],
      skillDir: tempDirs[0],
    }));
    const processTrees: Array<{ parent: number; child: number }> = [];

    try {
      await waitFor(() => markers.every((marker) => fs.existsSync(marker)));
      for (const marker of markers) {
        processTrees.push(JSON.parse(fs.readFileSync(marker, 'utf8')) as {
          parent: number;
          child: number;
        });
      }
      expect(processTrees.every(({ parent, child }) => (
        processIsAlive(parent) && processIsAlive(child)
      ))).toBe(true);

      await Promise.all([runner.shutdown(), runner.shutdown()]);
      const results = await Promise.all(runPromises);

      expect(results.map((result) => result.status)).toEqual(['aborted', 'aborted']);
      await waitFor(() => processTrees.every(({ parent, child }) => (
        !processIsAlive(parent) && !processIsAlive(child)
      )));
      expect(() => runner.run({
        skillRef: 'demo',
        scriptBase: 'run',
        skillDir: tempDirs[0],
      })).toThrow(/shutting down/);
    } finally {
      await runner.shutdown();
      for (const { parent, child } of processTrees) {
        for (const pid of [parent, child]) {
          if (processIsAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
      }
    }
  });

  it('rejects malformed, expired, and out-of-range continuation reads', async () => {
    const runner = fixture("process.stdout.write('abcdefgh');", {
      previewBytes: 4,
      hardOutputBytes: 64,
    });
    const result = await runner.run({
      skillRef: 'demo',
      scriptBase: 'run',
      skillDir: tempDirs[0],
    });
    expect(result.outputRef).toMatch(/^[a-f0-9]{32}$/);

    expect(() => runner.read({
      outputRef: '../private',
      stream: 'stdout',
    })).toThrow(/valid output_ref/);
    expect(() => runner.read({
      outputRef: '0'.repeat(32),
      stream: 'stdout',
    })).toThrow(/unavailable or expired/);
    expect(() => runner.read({
      outputRef: result.outputRef,
      stream: 'trace' as 'stdout',
    })).toThrow(/stream must be stdout or stderr/);
    expect(() => runner.read({
      outputRef: result.outputRef,
      stream: 'stdout',
      offset: -1,
    })).toThrow(/offset must be a non-negative integer/);
    expect(() => runner.read({
      outputRef: result.outputRef,
      stream: 'stdout',
      limit: 60_001,
    })).toThrow(/limit must be an integer from 1 to 60000/);
    expect(() => runner.read({
      outputRef: result.outputRef,
      stream: 'stdout',
      offset: result.stdout.bytes + 1,
    })).toThrow(/offset exceeds available Skill output/);
    expect(runner.read({
      outputRef: result.outputRef,
      stream: 'stdout',
      offset: result.stdout.bytes,
    })).toMatchObject({
      text: '',
      done: true,
      offset: result.stdout.bytes,
      nextOffset: result.stdout.bytes,
    });
  });

  it('targets the detached POSIX process group before the direct child', () => {
    const child = { pid: 321, kill: vi.fn(() => true) };
    const processKill = vi.fn();

    killProcessTree(child, 'SIGTERM', { platform: 'darwin', processKill });

    expect(processKill).toHaveBeenCalledWith(-321, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses taskkill tree termination on Windows', () => {
    const child = { pid: 654, kill: vi.fn(() => true) };
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnFn = vi.fn(() => killer);

    killProcessTree(child, 'SIGTERM', { platform: 'win32', spawnFn });

    expect(spawnFn).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/),
      ['/pid', '654', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
