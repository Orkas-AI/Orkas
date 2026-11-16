import { afterAll, expect, it } from 'vitest';
import { writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// These writes deliberately bypass process.stderr.write and the worker tap.
// They model Electron native output, an inherited child FD and late teardown.
it('completes while a native diagnostic bypasses the JavaScript stream tap', () => {
  writeSync(2, '[1106/105617.988660:ERROR:electron/shell/common/node_util.cc:76] CompileAndCall failed to evaluate electron script ');
  writeSync(2, '(electron/js2c/node_init): script execution has been terminated\n');
  expect(2 + 2).toBe(4);
});

it('completes after a child writes to the inherited stderr descriptor', () => {
  const child = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
    ['-e', "require('node:fs').writeSync(2, 'fixture-native-private-value /Users/test/private.txt\\n')"],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  expect(child.status).toBe(0);
});

afterAll(() => { writeSync(2, 'fixture native cleanup diagnostic\n'); });
