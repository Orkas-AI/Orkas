import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/local-cli-mcp-server.cjs');
const permissions = require('../../../../bin/local-cli-permissions.cjs');

it('completes real Lark authorization after bot denial without replaying a message or clearing the bot advisory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-lark-recovery-e2e-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const cli = path.join(root, 'npx-cli.cjs');
  const trace = path.join(root, 'calls.jsonl');
  const grants = path.join(root, 'grants.json');
  const marker = path.join(root, 'integrity.json');
  const manifest = adapter.MANIFESTS.lark;
  const samples = require('./fixtures/lark-cli-1.0.93.json').samples;
  fs.writeFileSync(marker, JSON.stringify(manifest));
  fs.writeFileSync(grants, JSON.stringify(['offline_access']));
  fs.writeFileSync(cli, [
    "const fs = require('node:fs');",
    `const samples = ${JSON.stringify(samples)};`,
    `const trace = ${JSON.stringify(trace)}, grants = ${JSON.stringify(grants)};`,
    'const args = process.argv.slice(5);',
    "fs.appendFileSync(trace, JSON.stringify(args) + '\\n');",
    "const scope = JSON.parse(fs.readFileSync(grants, 'utf8'));",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({identities:{user:{available:true,verified:true,scope:scope.join(' ')}}}));",
    "} else if (args[0] === 'auth' && args[1] === 'login') {",
    "  fs.writeFileSync(grants, JSON.stringify(args[args.indexOf('--scope') + 1].split(' ')));",
    "} else if (args[0] === 'im' && args[1] === '+messages-send' && !args.includes('--help')) {",
    "  const identity = args[args.indexOf('--as') + 1];",
    "  if (identity === 'bot' || !scope.includes('im:message.send_as_user')) {",
    "    process.stderr.write(JSON.stringify({ok:false,identity, error: identity === 'bot' ? {type:'api',code:230013} : {type:'authorization',subtype:'missing_scope',missing_scopes:['im:message.send_as_user']}}));",
    '    process.exitCode = 2;',
    "  } else process.stdout.write(JSON.stringify({ok:true,data:{message_id:'explicit-retry'}}));",
    '} else {',
    '  const sample = samples.find(s => JSON.stringify(s.args) === JSON.stringify(args));',
    '  if (!sample) process.exit(9);',
    '  process.stdout.write(sample.stdout); process.stderr.write(sample.stderr); process.exitCode = sample.status;',
    '}',
  ].join('\n'));
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const env = {
    ORKAS_LOCAL_CLI_PROVIDER: 'lark', ORKAS_LOCAL_CLI_BRAND: 'feishu',
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package, ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable, ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_RUNTIME_DIR: root, ORKAS_LOCAL_CLI_WORK_DIR: work,
    ORKAS_LOCAL_CLI_PROFILE: 'recovery-e2e', ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1',
    ORKAS_LOCAL_CLI_NPX_CLI: cli, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker, ORKAS_NODE: node,
  };
  const transport = new StdioClientTransport({ command: node,
    args: [path.resolve('bin/local-cli-mcp-server.cjs')], env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', data => { diagnostics += String(data); });
  const client = new Client({ name: 'lark-recovery-regression', version: '1.0.0' });
  const send = (identity: string) => client.callTool({ name: 'execute_high_impact', arguments: {
    action: 'im.+messages-send', parameters: { user_id: 'fixture-recipient', text: 'fixture', as: identity },
  } });
  const parse = (value: any) => JSON.parse(value.content[0].text);
  try {
    await client.connect(transport);
    for (const identity of ['bot', 'user']) {
      const denied = await send(identity);
      expect(denied.isError).toBe(true);
      expect(parse(denied).provider_error.recovery).toBe(identity === 'bot' ? 'check_bot_availability' : 'reauthorize');
    }
    const authorized = spawnSync(node, [path.resolve('bin/local-cli-auth.cjs')], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    expect(authorized.error).toBeUndefined();
    expect(authorized.status).toBe(0);
    expect(authorized.stderr).toBe('');
    expect(authorized.stdout).toBe('[Orkas] Authorization complete. You can close this terminal.\n');
    const pending = permissions.readPermissionRequest(env);
    expect(pending).toMatchObject({ scopes: [], access_issues: [
      { identity: 'bot', code: 230013, recovery: 'check_bot_availability' },
    ] });
    expect(JSON.parse(fs.readFileSync(grants, 'utf8'))).toEqual(['im:message.send_as_user', 'offline_access']);
    const callsBeforeRetry = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(callsBeforeRetry.filter(args => args[0] === 'im' && !args.includes('--help'))).toHaveLength(2);
    expect(callsBeforeRetry.filter(args => args[0] === 'auth' && args[1] === 'login')).toHaveLength(1);
    const retried = await send('user');
    expect(retried.isError).not.toBe(true);
    expect(parse(retried).result.data.message_id).toBe('explicit-retry');
    expect(permissions.readPermissionRequest(env)).toEqual(pending);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
    expect(diagnostics).toBe('');
  }
});

// Real adapter/stdio/process lifecycle with synthetic provider protocol fixtures.
// This proves operation isolation, not live provider consent or schema compatibility.
it.each(['dingtalk', 'wecom'])('keeps %s reads usable across a business denial and adapter restart without login or replay', async provider => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-permission-e2e-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const trace = path.join(root, 'calls.jsonl');
  const cli = path.join(root, 'npx-cli.cjs');
  const marker = path.join(root, 'integrity.json');
  const manifest = adapter.MANIFESTS[provider];
  fs.writeFileSync(marker, JSON.stringify(manifest));
  const denial = provider === 'dingtalk'
    ? { success: false, code: 'PAT_NO_PERMISSION', data: { scope: 'doc.content:read', uri: 'https://private.invalid/consent' } }
    : { error: { type: 'PermissionError', message: 'private provider detail' } };
  fs.writeFileSync(cli, [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(5);',
    `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === 'schema' || args.includes('--schema')) {",
    "  process.stdout.write(JSON.stringify({ effect: 'read', parameters: {} }));",
    "} else if (args[0] === 'doc') {",
    `  process.stderr.write(JSON.stringify(${JSON.stringify(denial)})); process.exitCode = 4;`,
    "} else if (args[0] === 'contact') {",
    "  process.stdout.write(JSON.stringify({ success: true, data: { fixture: 'allowed-read' } }));",
    "} else { process.stderr.write('Unexpected command'); process.exitCode = 9; }",
  ].join('\n'));
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const env = {
    ORKAS_LOCAL_CLI_PROVIDER: provider,
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_RUNTIME_DIR: root, ORKAS_LOCAL_CLI_WORK_DIR: work,
    ORKAS_LOCAL_CLI_PROFILE: 'permission-e2e', ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1',
    ORKAS_LOCAL_CLI_NPX_CLI: cli, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
    ORKAS_NODE: node,
  };
  const parse = (value: any) => JSON.parse(value.content[0].text);
  try {
    for (const restart of [false, true]) {
      const transport = new StdioClientTransport({ command: node,
        args: [path.resolve('bin/local-cli-mcp-server.cjs')], env, stderr: 'pipe' });
      let diagnostics = '';
      transport.stderr?.on('data', data => { diagnostics += String(data); });
      const client = new Client({ name: 'permission-regression', version: '1.0.0' });
      try {
        await client.connect(transport);
        if (!restart) {
          const denied = await client.callTool({ name: 'execute_read', arguments: { action: 'doc.get' } });
          expect(denied.isError).toBe(true);
          expect(parse(denied)).toMatchObject({ error_code: 'connector_permission_denied', provider_error: { recovery: 'reauthorize' } });
          expect(JSON.stringify(denied)).not.toContain('private');
        }
        const pending = permissions.readPermissionRequest(env);
        expect(pending).toMatchObject({ reauthorize: true });
        const allowed = await client.callTool({ name: 'execute_read', arguments: {
          action: provider === 'wecom' ? 'contact.get-user' : 'contact.get',
        } });
        expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
        expect(parse(allowed).result.data.fixture).toBe('allowed-read');
        expect(permissions.readPermissionRequest(env)).toEqual(pending);
      } finally {
        await client.close();
        expect(diagnostics).toBe('');
      }
    }
    const calls: string[][] = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const business = calls.filter(args => args[0] !== 'schema' && !args.includes('--schema'));
    expect(business.map(args => args[0])).toEqual(['doc', 'contact', 'contact']);
    expect(calls.some(args => ['auth', 'pat', 'config'].includes(args[0]))).toBe(false);
    expect(fs.readdirSync(work)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
