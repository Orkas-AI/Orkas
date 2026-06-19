import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('sync login guard', () => {
  it('does not ship the account-backed sync engine in the open build', () => {
    const root = process.cwd();
    expect(fs.existsSync(path.join(root, 'src', 'main', 'features', 'sync'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'main', 'features', 'account'))).toBe(false);
  });
});
