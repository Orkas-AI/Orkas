#!/usr/bin/env node

// Real-binary Office artifact smoke. This intentionally does not mock the
// engine: it exercises the checksum-pinned bundled OfficeCLI through the same
// create/batch/read/check/render primitives that back the core-agent tools.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';
import officeCliPin from './fetch-officecli.cjs';
import officeCliPolicy from '../bin/officecli-policy-gate.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..');
const expectedVersion = officeCliPin.VERSION.replace(/^v/, '');
const assetNames = officeCliPin.ASSETS;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function commandText(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function guardedOfficeCliInvocation(binary, args) {
  if (process.platform !== 'darwin') return { command: binary, args };
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', officeCliPolicy.MAC_OFFICECLI_SANDBOX_PROFILE, binary, ...args],
  };
}

function run(binary, args, options = {}) {
  const launch = guardedOfficeCliInvocation(binary, args);
  const result = spawnSync(launch.command, launch.args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    // The smoke must exercise the checksum-pinned binary exactly as the
    // production engine does. OfficeCLI otherwise self-updates even for
    // `--version`, which mutates the vendored asset before the artifact cases
    // run and can replace it with an unverified/incomplete upstream release.
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(binary)} ${args.join(' ')} failed (${result.status}):\n${commandText(result)}`);
  }
  return result;
}

async function batch(binary, file, operations, options = {}) {
  const payload = asciiJson(operations);
  const args = ['batch', file, '--stop-on-error', '--json'];
  const launch = guardedOfficeCliInvocation(binary, args);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(Buffer.from(payload, 'utf8'));
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(binary)} ${args.join(' ')} failed (${result.status}):\n${commandText(result)}`);
  }
  return result;
}

function closeFile(binary, file) {
  run(binary, ['close', file]);
}

function assertContains(output, expected, label) {
  assert(output.includes(expected), `${label} did not contain ${JSON.stringify(expected)}:\n${output}`);
}

function assertRenderedHtml(file, officeFile) {
  const html = fs.readFileSync(file, 'utf8');
  assert(html.length > 1_000, `${path.basename(officeFile)} rendered HTML is unexpectedly small (${html.length} chars)`);
  const ext = path.extname(officeFile).toLowerCase();
  const marker = ext === '.docx'
    ? /class=["'][^"']*\bpage\b/
    : ext === '.xlsx'
      ? /class=["'][^"']*\bsheet-content\b/
      : /class=["'][^"']*\bslide\b/;
  assert(marker.test(html), `${path.basename(officeFile)} rendered HTML is missing its layout marker`);
}

function validateAndInspect(binary, file, expectedText, renderedHtml, renderArgs = []) {
  run(binary, ['validate', file, '--json']);
  run(binary, ['view', file, 'issues', '--json']);
  const text = commandText(run(binary, ['view', file, 'text']));
  assertContains(text, expectedText, `${path.basename(file)} text view`);
  run(binary, ['view', file, 'html', '--page', '1', ...renderArgs, '-o', renderedHtml]);
  assertRenderedHtml(renderedHtml, file);
  closeFile(binary, file);
}

const platformKey = `${process.platform}-${process.arch}`;
const assetName = assetNames[platformKey];
if (!assetName) {
  console.log(`[office-artifact-smoke] skipped: unsupported host ${platformKey}`);
  process.exit(0);
}

const binary = path.join(pcRoot, 'resources', 'officecli', assetName);
assert(fs.existsSync(binary), `bundled OfficeCLI is missing: ${binary}; run npm run officecli:fetch first`);
if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);

const version = commandText(run(binary, ['--version']));
assert(version === expectedVersion, `OfficeCLI version mismatch: expected ${expectedVersion}, got ${version}`);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-artifact-smoke-'));
process.env.ORKAS_WORKSPACE_ROOT = path.join(tempDir, 'orkas-container');
fs.mkdirSync(process.env.ORKAS_WORKSPACE_ROOT, { recursive: true });
const officeToolsModule = await import('../src/main/model/core-agent/office-tools.ts');
const { createOfficeTools } = officeToolsModule.default || officeToolsModule;
const officeFixtureModule = await import('../eval/model-eval/regression/office-production-fixtures.ts');
const {
  inspectOfficeProductionArtifacts,
  seedOfficeProductionFixture,
} = officeFixtureModule.default || officeFixtureModule;
let failed = false;
try {
  const sourceDocx = path.join(tempDir, 'source-report.docx');
  const workingDocx = path.join(tempDir, 'source-report-edited.docx');
  const workbook = path.join(tempDir, 'customers.xlsx');
  const deck = path.join(tempDir, 'brief.pptx');

  run(binary, ['create', sourceDocx, '--locale', 'zh-CN', '--force', '--json']);
  await batch(binary, sourceDocx, [
    { command: 'add', parent: '/body', type: 'p', props: { text: '季度报告', style: 'Heading1' } },
    { command: 'add', parent: '/body', type: 'p', props: { text: '中文内容：进展正常。' } },
  ]);
  closeFile(binary, sourceDocx);
  const sourceHash = sha256(sourceDocx);
  const produced = new Set();
  const officeTools = createOfficeTools({
    userId: 'office-smoke',
    extraRoots: [tempDir],
    hasProducedPath: (absPath) => produced.has(path.resolve(absPath)),
    onFileWritten: (absPath) => { produced.add(path.resolve(absPath)); },
  });
  const editOffice = officeTools.find((tool) => tool.name === 'edit_office');
  const createXlsx = officeTools.find((tool) => tool.name === 'create_xlsx');
  assert(editOffice, 'edit_office tool is missing');
  assert(createXlsx, 'create_xlsx tool is missing');
  const editResult = await editOffice.execute({
    path: sourceDocx,
    operations: [
      { action: 'set', path: '/body/p[2]', props: { text: '中文内容：进展符合计划。' } },
    ],
    preview: false,
  }, { workingDir: tempDir, state: {} });
  assert(!editResult.isError, `edit_office failed: ${editResult.content}`);
  assert(fs.existsSync(workingDocx), 'edit_office did not create the expected working copy');
  assert(produced.has(workingDocx), 'edit_office did not register the working copy');
  assert(sha256(sourceDocx) === sourceHash, 'edit_office changed the source DOCX');

  const beforeRollback = sha256(workingDocx);
  const failedBatch = await batch(binary, workingDocx, [
    { command: 'set', path: '/body/p[2]', props: { text: '这段文字必须回滚。' } },
    { command: 'set', path: '/body/p[999]', props: { text: '无效路径' } },
  ], { allowFailure: true });
  closeFile(binary, workingDocx);
  assert(failedBatch.status !== 0, 'invalid atomic DOCX batch unexpectedly succeeded');
  assert(sha256(workingDocx) === beforeRollback, 'failed atomic DOCX batch changed the file');

  const createXlsxResult = await createXlsx.execute({
    path: workbook,
    sheets: [
      {
        name: '汇总',
        rows: [
          [{ value: '合计', bold: true }, { formula: 'SUM(数据!B2:B2)', format: '0.00' }],
        ],
        charts: [{
          type: 'column',
          dataRange: '数据!B1:B2',
          categories: '数据!A2:A2',
          title: '客户金额',
          anchor: 'D2:L18',
          legend: 'none',
          catTitle: '客户编号',
          axistitle: '金额（元）',
          axismin: 0,
          dataLabels: 'value',
          preset: 'corporate',
        }],
      },
      {
        name: '数据',
        rows: [
          [
            { value: '客户编号', bold: true },
            { value: '金额', bold: true },
          ],
          [
            { value: '00123', format: '@' },
            { value: 100, format: '0.00' },
          ],
        ],
      },
    ],
    preview: false,
  }, { workingDir: tempDir, state: {} });
  assert(!createXlsxResult.isError, `create_xlsx with native chart failed: ${createXlsxResult.content}`);
  assert(produced.has(workbook), 'create_xlsx did not register the charted workbook');

  const chart = commandText(run(binary, ['get', workbook, '/汇总/chart[1]', '--json']));
  assertContains(chart, '"chartType": "column"', 'native workbook chart');
  assertContains(chart, '"title": "客户金额"', 'native workbook chart title');
  const chartXml = new AdmZip(workbook).getEntries()
    .filter((entry) => /^xl\/(?:drawings\/)?charts\/chart\d+\.xml$/i.test(entry.entryName))
    .map((entry) => entry.getData().toString('utf8'))
    .join('\n');
  assert(
    /<c:min\s+val="0(?:\.0+)?"\s*\/?>/i.test(chartXml),
    'native workbook chart is missing the explicit zero value-axis minimum',
  );

  run(binary, ['create', deck, '--force', '--json']);
  await batch(binary, deck, [
    { command: 'add', parent: '/', type: 'slide', props: { title: '项目简报', text: '本季度进展正常' } },
    { command: 'add', parent: '/slide[1]', type: 'shape', props: { text: '下一步：按计划交付', x: '1in', y: '5in', width: '8in', height: '0.6in' } },
  ]);
  closeFile(binary, deck);

  validateAndInspect(
    binary,
    workingDocx,
    '中文内容：进展符合计划。',
    path.join(tempDir, 'report-page-1.html'),
    ['--render', 'html'],
  );
  validateAndInspect(
    binary,
    workbook,
    '00123',
    path.join(tempDir, 'workbook-sheet-1.html'),
  );
  validateAndInspect(
    binary,
    deck,
    '项目简报',
    path.join(tempDir, 'brief-slide-1.html'),
    ['--render', 'html'],
  );

  const fixtureScenarios = [
    'office-existing-contract-edit',
    'office-csv-to-workbook',
    'office-xlsm-macro-preservation',
    'office-existing-deck-cleanup',
    'office-mixed-delivery',
    'office-wps-proprietary-input',
    'office-pdf-page-edit',
  ];
  for (const scenarioId of fixtureScenarios) {
    const fixtureRoot = path.join(tempDir, 'production-fixtures', scenarioId);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const fixture = await seedOfficeProductionFixture(scenarioId, fixtureRoot);
    assert(fixture.baselineFiles.length > 0, `${scenarioId} did not seed a source fixture`);
    const inspection = await inspectOfficeProductionArtifacts(fixtureRoot, [], fixture);
    assert(
      inspection.features.includes('source-fixtures-preserved'),
      `${scenarioId} fixture changed during source-integrity inspection: ${inspection.evidence.join('; ')}`,
    );
  }

  console.log(`[office-artifact-smoke] PASS ${platformKey} OfficeCLI=${version} artifacts=3 production-fixtures=${fixtureScenarios.length} native-xlsx-chart=true tool-copy=true source-preserved=true atomic-rollback=true guarded-html-renders=3`);
} catch (error) {
  failed = true;
  console.error(`[office-artifact-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[office-artifact-smoke] artifacts preserved for diagnosis: ${tempDir}`);
  process.exitCode = 1;
} finally {
  if (!failed && process.env.ORKAS_KEEP_OFFICE_SMOKE_ARTIFACTS !== '1') {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } else if (!failed) {
    console.log(`[office-artifact-smoke] artifacts preserved: ${tempDir}`);
  }
}
