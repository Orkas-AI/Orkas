import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `PC/CLAUDE.md`: dependency direction is `ipc -> features -> model/util`,
 * and `util/` never imports `features/` or `model/`. Nothing enforced it —
 * `util/office-preview.ts` carried a static import of the OfficeCLI engine
 * for a month (M-D3) — so this gate reads every `src/main/util` module and
 * fails on a static import that resolves into either layer. A lazy
 * `require()` inside a function is the documented escape hatch for
 * boot-order cycles and is not what this checks.
 */

const MAIN_ROOT = path.join(__dirname, '..', '..', '..', 'src', 'main');
const UTIL_ROOT = path.join(MAIN_ROOT, 'util');
const FORBIDDEN_LAYERS: readonly string[] = ['features', 'model'];

const STATIC_IMPORT_RE = /^(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;

/** Static import specifiers of `source` (at `filePath`) that land inside a
 *  forbidden layer of `src/main`. */
function layerViolations(filePath: string, source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(filePath), specifier);
    const rel = path.relative(MAIN_ROOT, resolved).split(path.sep);
    if (rel[0] === '..') continue;
    if (FORBIDDEN_LAYERS.includes(rel[0])) {
      out.push(`${path.relative(MAIN_ROOT, filePath)} -> ${specifier}`);
    }
  }
  return out;
}

function utilModules(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return utilModules(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('main-process layer boundaries', () => {
  it('keeps util/ free of static imports from features/ and model/', () => {
    const files = utilModules(UTIL_ROOT);
    expect(files.length).toBeGreaterThan(20);
    const violations = files.flatMap((file) => layerViolations(file, fs.readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });

  it('detects a util module that reaches into features/ or model/ (negative control)', () => {
    const file = path.join(UTIL_ROOT, 'example.ts');
    expect(layerViolations(file, "import { runOfficeCli } from '../features/office/office_engine';\n"))
      .toEqual(['util/example.ts -> ../features/office/office_engine']);
    expect(layerViolations(file, "import type { Foo } from '../model/core-agent/runner';\n"))
      .toEqual(['util/example.ts -> ../model/core-agent/runner']);
    // Same-layer, parent-level and lazy references are allowed.
    expect(layerViolations(file, [
      "import { x } from './log-redact';",
      "import { createLogger } from '../logger';",
      "const account = require('../features/account');",
    ].join('\n'))).toEqual([]);
  });
});
