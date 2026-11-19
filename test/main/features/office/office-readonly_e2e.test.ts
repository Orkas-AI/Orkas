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
  commands: Array<{ verb: string; target?: string; code: number; stderr: string; stdoutChars: number; elapsedMs: number }>;
  measurement?: Record<string, unknown>;
  renderErrors: Array<{ page: string; message: string }>;
};
const SCENARIOS = [
  ['combined-review', 'checks and renders a foreign DOCX without changing its revision'],
  ['partial-page-retry', 'retains the successful page, preserves the source and recovers after an absent page'],
  ['cancel-after-check', 'preserves the source and can render again after cancellation following a real check'],
  ['invalid-document', 'rejects invalid OpenXML without rendering or changing the source'],
  ['edit-then-review', 'saves an intentional edit, preserves the original and reviews the new revision'],
  ['xlsx-render', 'renders requested positions 1, 3 and 4 of a real workbook without source mutation'],
  ['pptx-render', 'renders a real presentation with no browser warnings or source mutation'],
  ['edit-10-paragraphs', 'PF-09 preserves every paragraph through a small real edit and cleanup'],
  ['edit-1000-paragraphs', 'PF-09 preserves every paragraph through a large real edit and cleanup'],
  ['create-centered-footer', 'creates a real centered footer while preserving the source without one'],
  ['read-notes-foot', 'reads actual footnote content and native identity without source changes or a resident'],
  ['read-notes-end', 'reads actual endnote content and native identity without source changes or a resident'],
  ['read-notes-both', 'keeps footnotes and endnotes distinct in one default read'],
  ['read-notes-none', 'reports the native absence of both note parts without inventing content'],
  ['read-notes-many', 'reads every one of eighty native footnotes and keeps an endnote distinct'],
  ['creation-recovery-pptx', 'corrects one atomic native failure and never resurrects the deleted delivered deck'],
  ['ppt-crop-percentages', 'preserves percentage crop units including sub-one-percent edges in the actual package'],
  ['ppt-parameter-recovery', 'corrects rejected crop and anchor values once while retaining native editable chart data'],
  ['saved-before-record-docx', 'retains a readable saved DOCX and failure status after publication bookkeeping fails'],
  ['saved-before-record-xlsx', 'retains six sheets and an editable chart after publication bookkeeping fails'],
  ['saved-before-record-pptx', 'retains a validated deck and editable chart after publication bookkeeping fails'],
  ['ppt-native-production', 'creates a themed nondefault canvas with editable flow/sequence diagrams and custom objects, then validates and renders it'],
  ['ppt-native-recovery', 'rejects an unsupported native graph atomically and corrects the same creation with custom dimensions'],
  ['ppt-unit-contract', 'rejects fractional unitless coordinates before native dispatch and preserves explicit and raw EMU lengths'],
  ['ppt-native-append', 'preserves native placeholders and the source while appending complete pages atomically after a rollback'],
  ['create-docx-heading-outline', 'creates editable Word headings with their navigation levels'],
  ['read-tables', 'marks omitted Word table text as partial and provides a working native read path'],
  ] as const;

// OfficeCLI is bundled for desktop macOS/Windows, not Linux hosts.
describe.skipIf(!['darwin', 'win32'].includes(process.platform)).each([
  { cohort: 'review', cases: SCENARIOS.slice(0, 5) },
  { cohort: 'edit', cases: SCENARIOS.slice(5, 10) },
  { cohort: 'notes', cases: SCENARIOS.slice(10, 15) },
  { cohort: 'creation', cases: SCENARIOS.slice(15, 24) },
  { cohort: 'presentation', cases: SCENARIOS.slice(24, 25) },
  { cohort: 'docx-headings', cases: SCENARIOS.slice(25, 26) },
  { cohort: 'docx-tables', cases: SCENARIOS.slice(26) },
])('real Office review lifecycle ($cohort)', ({ cases }) => {
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
      JSON.stringify(cases.map(([id]) => id)),
    ], { env, timeout: 150_000, maxBuffer: 256 * 1024 });
    // Even an otherwise empty Electron app emits one console CRLF on Windows.
    expect(process.platform === 'win32' ? ['', '\r\n'] : ['']).toContain(logs.stdout);
    expect(logs.stderr).toBe('');
    rows = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(rows.map(row => row.id)).toEqual(cases.map(([id]) => id));
  }, 160_000);

  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it.each(cases)('%s: %s', (id) => {
    const row = rows.find(item => item.id === id)!;
    expect(row.error, JSON.stringify({ commands: row.commands, renderErrors: row.renderErrors, logs: row.logs })).toBeUndefined();
    expect(row.commands.length).toBeGreaterThan(0);
    // Native create reports its inferred locale as information; all other
    // stderr remains a failure, including every review/read command.
    expect(row.commands.every(command => command.stderr === '' || ((id === 'creation-recovery-pptx' || id.startsWith('ppt-') || id.startsWith('saved-before-record-'))
      && command.verb === 'create'
      && /^Note: locale '[A-Za-z0-9-]+' inferred from OS user culture\. Pass --locale to override\.\r?\n$/.test(command.stderr))),
    JSON.stringify(row.commands.filter(command => command.stderr))).toBe(true);
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
    if (row.measurement) console.log(id.startsWith('read-notes-') ? '[Office native read]' : id === 'xlsx-render' ? '[Office worksheet selection]' : id.startsWith('saved-before-record-') ? '[Office retained delivery]' : '[PF-09 native edit]', JSON.stringify({ ...row.measurement,
      commands: row.commands.map(command => ({ verb: command.verb, elapsedMs: command.elapsedMs })) }));
    const failures = row.commands.filter(command => command.code !== 0);
    if (id === 'invalid-document' || id === 'creation-recovery-pptx' || id === 'ppt-parameter-recovery' || id === 'ppt-native-recovery' || id === 'ppt-native-append') {
      expect(failures).toHaveLength(1);
      expect(failures[0].verb).toBe(id === 'invalid-document' ? 'validate' : 'batch');
    } else if (id.startsWith('read-notes-')) {
      const absent = id === 'read-notes-foot' ? ['/endnotes']
        : id === 'read-notes-end' ? ['/footnotes'] : id === 'read-notes-none' ? ['/footnotes', '/endnotes'] : [];
      expect(failures.map(({ verb, target, code }) => ({ verb, target, code }))).toEqual(
        absent.map(target => ({ verb: 'get', target, code: 1 })),
      );
    } else if (id === 'read-tables') {
      expect(failures.map(({ verb, target, code }) => ({ verb, target, code }))).toEqual(
        ['/footnotes', '/endnotes'].map(target => ({ verb: 'get', target, code: 1 })),
      );
    } else expect(failures).toEqual([]);
  });
});
