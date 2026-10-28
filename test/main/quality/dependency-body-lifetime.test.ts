import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Exercise the installed parser over real loopback HTTP in a disposable child:
// GHSA-27r3-jxmh-p828 can emit an uncaught decoder error after parsing succeeds.
// An exception handler in the test process would hide that process-level failure.
function bodyProbe(mode: string) {
  const script = `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const zlib = require('node:zlib');
    const { once } = require('node:events');
    const { createHash } = require('node:crypto');
    const bodyParser = require(${JSON.stringify(require.resolve('body-parser'))});
    const onFinished = require(${JSON.stringify(require.resolve('on-finished'))});
    const mode = process.argv[1];
    const late = mode === 'late-deflate';
    const charset = mode === 'rejected-charset';
    const badJson = mode === 'bad-json';
    const gzipTail = mode === 'gzip-tail' || charset;
    const form = mode === 'form';
    const encoding = late ? 'deflate' : gzipTail || mode === 'gzip' ? 'gzip' : mode === 'brotli' ? 'br' : 'identity';
    const payload = Buffer.from(form ? 'tags%5B%5D=a&tags%5B%5D=b&name=%E4%B8%AD%E6%96%87' : badJson ? '{' : '{"a":1}');
    const compressed = encoding === 'gzip' ? zlib.gzipSync(payload) : encoding === 'deflate' ? zlib.deflateSync(payload) : encoding === 'br' ? zlib.brotliCompressSync(payload) : payload;
    const first = late || gzipTail ? Buffer.concat([compressed, Buffer.from([0])]) : compressed;
    const tail = Buffer.alloc(late ? 1024 : gzipTail ? 100 * 1024 : 0, 0x58);
    const expectedHash = createHash('sha256').update(first).update(tail).digest('hex');
    const parser = form ? bodyParser.urlencoded({ extended: true }) : bodyParser.json(charset ? { verify() {} } : {});
    let request;
    const server = http.createServer((req, res) => {
      const hash = createHash('sha256');
      req.pipe(hash);
      const rawDone = new Promise(resolve => hash.once('finish', () => resolve(hash.digest('hex'))));
      parser(req, res, error => {
        const finish = () => {
          res.statusCode = error ? error.status || 500 : 200;
          res.end(JSON.stringify({ body: req.body, type: error && error.type, hash: req.rawHash }));
        };
        const requestDone = new Promise(resolve => onFinished(req, resolve));
        Promise.all([rawDone, requestDone]).then(([digest]) => { req.rawHash = digest; finish(); });
        if (late) request.end(tail);
      });
    });
    const deadline = setTimeout(() => { process.stderr.write('probe deadline'); process.exit(2); }, 2000);
    (async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const response = await new Promise((resolve, reject) => {
          request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
            headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : charset ? 'application/json; charset=utf-999' : 'application/json',
              'Content-Encoding': encoding, 'Content-Length': first.length + tail.length } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
          });
          request.on('error', reject);
          if (late) request.write(first);
          else request.end(Buffer.concat([first, tail]));
        });
        assert.equal(response.status, charset ? 415 : badJson ? 400 : 200);
        if (charset || badJson) assert.equal(response.data.type, charset ? 'charset.unsupported' : 'entity.parse.failed');
        else assert.deepEqual(response.data.body, form ? { tags: ['a', 'b'], name: '中文' } : { a: 1 });
        assert.equal(response.data.hash, expectedHash);
        // Allow asynchronous zlib errors after the response to remain fatal,
        // matching the upstream regression's post-response observation window.
        await new Promise(resolve => setTimeout(resolve, 200));
        process.stdout.write(JSON.stringify({ status: response.status, rawBodyPreserved: true }));
      } finally {
        request?.destroy();
        await new Promise(resolve => server.close(resolve));
        clearTimeout(deadline);
      }
    })().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  return spawnSync(process.execPath, ['-e', script, mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024,
  });
}

describe('installed body-parser request lifetime', () => {
  it.each(['late-deflate', 'gzip-tail', 'rejected-charset', 'gzip', 'brotli', 'form', 'bad-json'])(
    'finishes %s without crashing or detaching another body consumer', mode => {
      const result = bodyProbe(mode);
      expect(result.error?.message).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        status: mode === 'rejected-charset' ? 415 : mode === 'bad-json' ? 400 : 200,
        rawBodyPreserved: true,
      });
    },
  );
});

// Exercise the application and both MCP consumers through their actual resolution.
// Oversized inputs must fail before per-element work allocates validation issues.
for (const owner of ['application', 'core', 'server']) {
  const sdkRequire = createRequire(owner === 'application' ? path.resolve('package.json')
    : path.resolve('node_modules', '@modelcontextprotocol', owner, 'package.json'));
  const { z } = sdkRequire('zod');
  describe(`MCP ${owner} constrained containers`, () => {
    it.each(['array', 'set', 'map'])('rejects an oversized %s before parsing its elements', kind => {
      let visited = 0;
      const element = z.number().transform((value: number) => { visited++; return value; });
      const schema = kind === 'array' ? z.array(element).max(2)
        : kind === 'set' ? z.set(element).max(2) : z.map(element, element).max(2);
      const input = Array.from({ length: 2048 }, (_, i) => i);
      const result = schema.safeParse(kind === 'array' ? input : kind === 'set' ? new Set(input) : new Map(input.map(i => [i, i])));
      expect(result.success).toBe(false);
      expect(result.error.issues).toEqual([expect.objectContaining({ code: 'too_big', path: [] })]);
      expect(visited).toBe(0);
    });

    it('preserves accepted containers and a transform before a later size check', () => {
      expect(z.array(z.number()).max(2).parse([1, 2])).toEqual([1, 2]);
      expect(z.set(z.number()).max(2).parse(new Set([1, 2]))).toEqual(new Set([1, 2]));
      expect(z.map(z.string(), z.number()).max(2).parse(new Map([['a', 1]]))).toEqual(new Map([['a', 1]]));
      expect(z.array(z.number()).overwrite((value: number[]) => value.slice(0, 2)).max(2).parse([1, 2, 3])).toEqual([1, 2]);
    });
  });
}
