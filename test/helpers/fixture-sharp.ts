import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// Keep the independent fixture/pixel oracle in stock Node. Electron's Linux
// GLib symbols can corrupt libvips even when image assertions appear to pass.
export default function fixtureSharp(input: Buffer | string | object, options?: object) {
  const steps: Array<[string, unknown[]]> = [];
  async function run(output: string, outputOptions?: unknown): Promise<any> {
    const executable = process.env.ORKAS_TEST_NODE;
    if (!executable) throw new Error('The test launcher must provide its stock Node runtime.');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const payload = { input: Buffer.isBuffer(input) ? { fixtureBuffer: input.toString('base64') } : input,
      options, steps, output, outputOptions };
    const child = spawnSync(executable, ['-e', `
      const fs = require('node:fs'), sharp = require('sharp');
      const request = JSON.parse(fs.readFileSync(0, 'utf8'));
      async function run() {
        const input = request.input.fixtureBuffer === undefined ? request.input : Buffer.from(request.input.fixtureBuffer, 'base64');
        let image = sharp(input, request.options);
        for (const [method, args] of request.steps) image = image[method](...args);
        const result = await image[request.output](request.outputOptions);
        return Buffer.isBuffer(result) ? { fixtureBuffer: result.toString('base64') }
          : result.data ? { ...result, data: { fixtureBuffer: result.data.toString('base64') } } : result;
      }
      run().then(result => process.stdout.write(JSON.stringify(result)))
        .catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: path.resolve(__dirname, '../..'), input: JSON.stringify(payload), env,
      windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (child.error || child.status !== 0 || child.stderr.length) {
      throw new Error(`Fixture image process failed: ${child.error?.message || child.status}; ${child.stderr.toString()}`);
    }
    const result = JSON.parse(child.stdout.toString());
    if (result.fixtureBuffer !== undefined) return Buffer.from(result.fixtureBuffer, 'base64');
    if (result.data?.fixtureBuffer !== undefined) return { ...result, data: Buffer.from(result.data.fixtureBuffer, 'base64') };
    return result;
  }
  const pipeline = {
    png(options?: object) { steps.push(['png', options ? [options] : []]); return pipeline; },
    ensureAlpha() { steps.push(['ensureAlpha', []]); return pipeline; },
    raw() { steps.push(['raw', []]); return pipeline; },
    jpeg(options?: object) { steps.push(['jpeg', options ? [options] : []]); return pipeline; },
    toBuffer(options?: object) { return run('toBuffer', options); },
    metadata() { return run('metadata'); },
    toFile(file: string) { return run('toFile', file); },
  };
  return pipeline;
}
