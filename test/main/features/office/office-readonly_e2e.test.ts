import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Row = {
  id: string; error?: string;
  logs: Array<{ scope: string; level: string; args: unknown[] }>;
  browserLogs: Array<{ level: string; message: string }>;
  commands: Array<{ verb: string; code: number; stderr: string; stdoutChars: number }>;
  renderErrors: Array<{ page: string; message: string }>;
};
// OfficeCLI is bundled for desktop macOS/Windows, not Linux hosts.
describe.skipIf(!['darwin', 'win32'].includes(process.platform))('real Office review lifecycle', () => {
  let root: string;
  let rows: Row[];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-readonly-e2e-'));
    const env = { ...process.env, ORKAS_WORKSPACE_ROOT: path.join(root, 'data') };
    fs.mkdirSync(env.ORKAS_WORKSPACE_ROOT);
    delete env.ELECTRON_RUN_AS_NODE;
    const output = path.join(root, 'results.json');
    const logs = await promisify(execFile)(require('electron'), [
      path.resolve('test/fixtures/office/readonly-review.cjs'), process.cwd(), output,
    ], { env, timeout: 150_000, maxBuffer: 256 * 1024 });
    // Even an otherwise empty Electron app emits one console CRLF on Windows.
    expect(process.platform === 'win32' ? ['', '\r\n'] : ['']).toContain(logs.stdout);
    expect(logs.stderr).toBe('');
    rows = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(rows.map(row => row.id)).toEqual([
      'combined-review', 'partial-page-retry', 'cancel-after-check', 'invalid-document', 'edit-then-review',
      'xlsx-render', 'pptx-render',
    ]);
  }, 160_000);

  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it.each([
    ['combined-review', 'checks and renders a foreign DOCX without changing its revision'],
    ['partial-page-retry', 'retains the successful page, preserves the source and recovers after an absent page'],
    ['cancel-after-check', 'preserves the source and can render again after cancellation following a real check'],
    ['invalid-document', 'rejects invalid OpenXML without rendering or changing the source'],
    ['edit-then-review', 'saves an intentional edit, preserves the original and reviews the new revision'],
    ['xlsx-render', 'renders a real workbook with no browser warnings or source mutation'],
    ['pptx-render', 'renders a real presentation with no browser warnings or source mutation'],
  ])('%s: %s', (id) => {
    const row = rows.find(item => item.id === id)!;
    expect(row.error, JSON.stringify({ commands: row.commands, renderErrors: row.renderErrors, logs: row.logs })).toBeUndefined();
    expect(row.commands.length).toBeGreaterThan(0);
    expect(row.commands.every(command => command.stderr === '')).toBe(true);
    expect(row.browserLogs).toEqual([]);
    const warnings = id === 'partial-page-retry' || id === 'cancel-after-check' ? 1 : 0;
    expect(row.logs).toHaveLength(warnings);
    expect(row.renderErrors).toHaveLength(warnings);
    if (id === 'partial-page-retry') expect(row.renderErrors[0]).toMatchObject({ page: '99', message: expect.stringContaining('E_OFFICE_RENDER_PAGE_UNAVAILABLE') });
    if (id === 'cancel-after-check') expect(row.renderErrors[0].message).toContain('E_OFFICE_ABORTED');
    for (const log of row.logs) {
      expect(log).toMatchObject({ scope: 'office-tools', level: 'warn' });
      expect(log.args[0]).toBe('render error');
    }
    const failures = row.commands.filter(command => command.code !== 0);
    if (id === 'invalid-document') {
      expect(failures).toHaveLength(1);
      expect(failures[0].verb).toBe('validate');
    } else expect(failures).toEqual([]);
  });
});
