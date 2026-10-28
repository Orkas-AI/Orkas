import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { fromSource, install } = require('../../helpers/source-map-literals.cjs');
const map = { version: 3, sources: ['original.ts'], names: [], mappings: 'AAAA' };
const comment = '//# sourceMappingURL=data:application/json;base64,';

describe('dependency error stack source maps', () => {
  it('preserves real inline maps and rejects malformed real comments', () => {
    expect(fromSource(comment + Buffer.from(JSON.stringify(map)).toString('base64')).toObject()).toEqual(map);
    expect(() => fromSource(comment + 'broken')).toThrow(SyntaxError);
  });

  it('ignores only string-contained false matches and keeps an earlier real map', () => {
    const template = 'const text = `\n' + comment + '${value}\n`;';
    expect(fromSource(template)).toBeNull();
    expect(fromSource(comment + Buffer.from(JSON.stringify(map)).toString('base64') + '\n' + template).toObject()).toEqual(map);
    expect(() => fromSource(comment + 'broken\n' + template)).toThrow(SyntaxError);
  });

  it('uses the repaired parser through Vitest while preserving genuine map errors', async () => {
    install();
    const { extractSourcemapFromFile } = await import('@vitest/utils/source-map/node');
    const template = 'const text = `\n' + comment + '${value}\n`;';
    // Vitest's external-file fallback returns an empty map for a missing filename.
    expect(extractSourcemapFromFile(template, '/dependency.js')).toEqual({ map: {} });
    expect(extractSourcemapFromFile(comment + Buffer.from(JSON.stringify(map)).toString('base64'), '/dependency.js')).toEqual({ map });
    expect(() => extractSourcemapFromFile(comment + 'broken', '/dependency.js')).toThrow(SyntaxError);
  });

  it('can report errors originating in both installed tsx register modules', () => {
    const directory = path.dirname(require.resolve('tsx/package.json'));
    const files = fs.readdirSync(path.join(directory, 'dist')).filter(file => /^register-.*\.(cjs|mjs)$/.test(file));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) expect(() => fromSource(fs.readFileSync(path.join(directory, 'dist', file), 'utf8'))).not.toThrow();
  });
});
