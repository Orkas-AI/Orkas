import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/local-cli-mcp-server.cjs');
const samples = require('./fixtures/lark-cli-1.0.93.json').samples;

// Real MCP transport and a CLI fixture enforcing the pinned provider's file boundary.
// No credentials, provider account, or real recipient are used.
it('passes approved attachment bytes across stdio and offers scope recovery without replaying a send', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-attachment-e2e-'));
  const work = path.join(root, 'work');
  const approved = path.join(root, 'approved');
  fs.mkdirSync(work);
  fs.mkdirSync(approved);
  const source = path.join(approved, 'handoff 宇涛.md');
  const bytes = Buffer.from('Handoff\n\u0000literal $(value)');
  fs.writeFileSync(source, bytes);
  const cli = path.join(root, 'npx-cli.cjs');
  const trace = path.join(root, 'sends.jsonl');
  const marker = path.join(root, 'integrity.json');
  fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.lark));
  fs.writeFileSync(cli, [
    "const fs = require('node:fs'), path = require('node:path');",
    `const samples = ${JSON.stringify(samples)};`,
    'const args = process.argv.slice(5);',
    "if (args[0] === 'im' && args[1] === '+messages-send' && !args.includes('--help')) {",
    "  const file = args[args.indexOf('--file') + 1];",
    "  if (path.isAbsolute(file) || file.split(/[\\\\/]/).includes('..')) process.exit(4);",
    "  const configRelative = path.relative(fs.realpathSync(process.env.LARKSUITE_CLI_CONFIG_DIR), fs.realpathSync(file));",
    "  if (configRelative === '' || (!configRelative.startsWith('..' + path.sep) && configRelative !== '..' && !path.isAbsolute(configRelative))) {",
    "    process.stderr.write(JSON.stringify({ ok: false, error: { type: 'validation', subtype: 'invalid_argument', message: 'input is inside the CLI config directory, which is protected by the built-in denylist' } }));",
    '    process.exit(2);',
    '  }',
    `  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, cwd: process.cwd(), bytes: fs.readFileSync(file).toString('base64') }) + '\\n');`,
    "  if (args[args.indexOf('--user-id') + 1] === 'ou_denied') {",
    "    process.stderr.write(JSON.stringify({ ok: false, identity: 'user', missing_scopes: ['im:message.send_as_user'], error: { type: 'authorization', subtype: 'missing_scope', message: 'private provider details' } }));",
    '    process.exitCode = 2;',
    "  } else process.stdout.write(JSON.stringify({ ok: true, data: { message_id: 'message-fixture' } }));",
    '} else {',
    '  const sample = samples.find(s => JSON.stringify(s.args) === JSON.stringify(args));',
    '  if (!sample) process.exit(3);',
    '  process.stdout.write(sample.stdout); process.stderr.write(sample.stderr); process.exitCode = sample.status;',
    '}',
  ].join('\n'));
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const env = {
    ORKAS_LOCAL_CLI_PROVIDER: 'lark',
    ORKAS_LOCAL_CLI_PACKAGE: adapter.MANIFESTS.lark.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: adapter.MANIFESTS.lark.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: adapter.MANIFESTS.lark.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(adapter.MANIFESTS.lark.domains),
    ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([approved]),
    ORKAS_LOCAL_CLI_RUNTIME_DIR: root, ORKAS_LOCAL_CLI_WORK_DIR: work,
    LARKSUITE_CLI_CONFIG_DIR: root,
    ORKAS_LOCAL_CLI_PROFILE: 'attachment-e2e', ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1',
    ORKAS_LOCAL_CLI_NPX_CLI: cli, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
    ORKAS_NODE: node,
  };
  const transport = new StdioClientTransport({ command: node,
    args: [path.resolve('bin/local-cli-mcp-server.cjs')], env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (data) => { diagnostics += String(data); });
  const client = new Client({ name: 'attachment-regression', version: '1.0.0' });
  const parse = (value: any) => JSON.parse(value.content[0].text);
  try {
    await client.connect(transport);
    const description = parse(await client.callTool({ name: 'describe_action', arguments: { action: 'im.+messages-send' } }));
    expect(description.schema.inputSchema.properties.file.description).toContain('absolute local path in Orkas-approved roots');
    expect(description.schema.inputSchema.properties.file.description).not.toContain('absolute paths and .. are rejected');
    expect(description.schema.inputSchema.properties.audio.description).toContain('Opus');
    for (const recipient of ['ou_fixture', 'ou_denied']) {
      const result = await client.callTool({ name: 'execute_high_impact', arguments: {
        action: 'im.+messages-send', parameters: { user_id: recipient, file: source, as: 'user', idempotency_key: recipient },
      } });
      if (recipient === 'ou_fixture') {
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(parse(result).result.data.message_id).toBe('message-fixture');
      } else {
        expect(result.isError).toBe(true);
        expect(parse(result).provider_error).toMatchObject({ identity: 'user', recovery: 'reauthorize' });
        expect(JSON.stringify(result)).not.toContain('private provider');
      }
    }
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Buffer.from(call.bytes, 'base64')).toEqual(bytes);
      expect(path.basename(call.args[call.args.indexOf('--file') + 1])).toBe(path.basename(source));
      expect(fs.existsSync(call.cwd)).toBe(false);
    }
    expect(fs.readdirSync(work)).toEqual([]);
    expect(require('../../../../bin/local-cli-lark.cjs').readPermissionRequest(env)?.scopes)
      .toEqual(['im:message.send_as_user']);
    expect(fs.readFileSync(source)).toEqual(bytes);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
    expect(diagnostics).toBe('');
  }
});
