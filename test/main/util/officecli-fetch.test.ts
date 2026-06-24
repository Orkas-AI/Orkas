import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-officecli-fetch-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runFetch(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'scripts', 'fetch-officecli.cjs'),
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('fetch-officecli.cjs', () => {
  it('fails check mode when the selected OfficeCLI binary is missing', () => {
    const r = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'fetch-officecli.cjs'),
      `--root=${tmpDir}`,
      '--platform=darwin-arm64',
      '--check',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain('officecli-mac-arm64 missing');
  });

  it('resumes an existing partial download with a Range request', async () => {
    const ranges: Array<string | undefined> = [];
    fs.writeFileSync(path.join(tmpDir, 'LICENSE'), 'Apache-2.0');
    fs.writeFileSync(path.join(tmpDir, 'officecli-mac-arm64.part'), 'abcd');

    const server = http.createServer((req, res) => {
      ranges.push(req.headers.range);
      expect(req.url).toBe('/officecli-mac-arm64');
      if (req.headers.range === 'bytes=4-') {
        res.writeHead(206, {
          'Content-Length': '6',
          'Content-Range': 'bytes 4-9/10',
        });
        res.end('efghij');
      } else {
        res.writeHead(200, { 'Content-Length': '10' });
        res.end('abcdefghij');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');

    try {
      const r = await runFetch([
        `--root=${tmpDir}`,
        '--platform=darwin-arm64',
      ], {
        OFFICECLI_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        OFFICECLI_FETCH_RETRIES: '0',
      });

      expect(r.status).toBe(1);
      expect(ranges).toEqual(['bytes=4-']);
      expect(`${r.stdout}\n${r.stderr}`).toContain('resuming officecli-mac-arm64 from 4 bytes');
      expect(`${r.stdout}\n${r.stderr}`).toContain('sha256 mismatch for officecli-mac-arm64');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
