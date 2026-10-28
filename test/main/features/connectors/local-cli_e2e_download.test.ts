import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeMinimalDocx } from '../../../fixtures/make-minimal-docx';
import { docxBufferToMarkdown } from '../../../../src/main/util/extract-docx';

vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
import { McpConnection } from '../../../../src/main/features/connectors/mcp-client';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/local-cli-mcp-server.cjs');
const fixture = require('./fixtures/lark-cli-1.0.93.json');

it('downloads a readable document through the real MCP client without writing into CLI configuration or accepting output overrides', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-download-mcp-'));
  const config = path.join(root, 'config');
  const work = path.join(config, 'work');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(stage);
  const bytes = makeMinimalDocx({ paragraphs: ['Download regression document.'] });
  const trace = path.join(root, 'downloads.json');
  const cli = path.join(root, 'npx.cjs');
  const marker = path.join(config, 'integrity.json');
  fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.lark));
  fs.writeFileSync(cli, [
    "const fs = require('node:fs'), path = require('node:path');",
    'const args = process.argv.slice(5);',
    `const samples = ${JSON.stringify(fixture.samples)};`,
    "if (args[0] === 'im' && args[1] === '+messages-resources-download' && !args.includes('--help')) {",
    '  const cwd = fs.realpathSync(process.cwd()), config = fs.realpathSync(process.env.LARKSUITE_CLI_CONFIG_DIR);',
    "  if (cwd === config || cwd.startsWith(config + path.sep)) { process.stderr.write(JSON.stringify({ok:false,error:{type:'validation',subtype:'invalid_argument',message:'config directory is protected'}})); process.exit(2); }",
    `  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ cwd, args }));`,
    "  const saved = path.resolve('report 宇涛.docx');",
    `  const bytes = Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64');`,
    '  fs.writeFileSync(saved, bytes);',
    '  process.stdout.write(JSON.stringify({ok:true,identity:"user",data:{saved_path:saved,size_bytes:bytes.length}}));',
    '} else {',
    '  const sample = samples.find(sample => JSON.stringify(sample.args) === JSON.stringify(args));',
    '  if (!sample) process.exit(3);',
    '  process.stdout.write(sample.stdout); process.stderr.write(sample.stderr); process.exitCode = sample.status;',
    '}',
  ].join('\n'));
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const connection = new McpConnection('feishu', { kind: 'stdio', command: node,
    args: [path.resolve('bin/local-cli-mcp-server.cjs')], env: {
      ORKAS_LOCAL_CLI_PROVIDER: 'lark', ORKAS_LOCAL_CLI_PACKAGE: adapter.MANIFESTS.lark.package,
      ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: adapter.MANIFESTS.lark.integrity,
      ORKAS_LOCAL_CLI_EXECUTABLE: adapter.MANIFESTS.lark.executable,
      ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(adapter.MANIFESTS.lark.domains),
      ORKAS_LOCAL_CLI_RUNTIME_DIR: config, ORKAS_LOCAL_CLI_WORK_DIR: work,
      LARKSUITE_CLI_CONFIG_DIR: config, ORKAS_LOCAL_CLI_PROFILE: 'download-fixture',
      ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1', ORKAS_LOCAL_CLI_NPX_CLI: cli,
      ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker, ORKAS_NODE: node,
    } });
  const args = { action: 'im.+messages-resources-download', parameters: {
    message_id: 'om_fixture', file_key: 'file_fixture', type: 'file',
  } };
  try {
    await connection.connect();
    const missing: any = await connection.callTool('execute_write', args);
    expect(missing.isError).toBe(true);
    expect(fs.existsSync(trace)).toBe(false);
    const invalid: any = await connection.callTool('execute_write', args, { localFileOutputDirectory: work });
    expect(invalid.isError).toBe(true);
    expect(fs.existsSync(trace)).toBe(false);
    const overridden: any = await connection.callTool('execute_write', {
      ...args, parameters: { ...args.parameters, output: path.join(stage, 'override.docx') },
    }, { localFileOutputDirectory: stage });
    expect(overridden.isError).toBe(true);
    expect(fs.existsSync(trace)).toBe(false);
    const raw: any = await connection.callTool('execute_write', args, { localFileOutputDirectory: stage });
    expect(raw.isError, JSON.stringify(raw)).not.toBe(true);
    const saved = JSON.parse(raw.content[0].text).result.data.saved_path;
    expect(fs.readFileSync(saved)).toEqual(bytes);
    expect(await docxBufferToMarkdown(fs.readFileSync(saved))).toContain('Download regression document');
    const recorded = JSON.parse(fs.readFileSync(trace, 'utf8'));
    expect(recorded.cwd).toBe(fs.realpathSync(stage));
    expect(recorded.args).not.toContain('--output');
    expect(fs.readdirSync(work)).toEqual([]);
  } finally {
    await connection.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
