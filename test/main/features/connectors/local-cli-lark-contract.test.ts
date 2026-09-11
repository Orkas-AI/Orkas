import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/local-cli-mcp-server.cjs');
const fixture = require('./fixtures/lark-cli-1.0.93.json');
type Sample = { args: string[]; status: number; stdout: string; stderr: string };
const samples = fixture.samples as Sample[];

function envFor(root = os.tmpdir()) {
  const manifest = adapter.MANIFESTS.lark;
  return {
    ORKAS_LOCAL_CLI_PROVIDER: 'lark',
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_PROFILE: 'contract-profile',
    ORKAS_LOCAL_CLI_RUNTIME_DIR: root,
    ORKAS_LOCAL_CLI_WORK_DIR: path.join(root, 'work'),
    ORKAS_LOCAL_CLI_NPX_CLI: '/runtime/npx-cli.js',
    ORKAS_NODE: process.env.ORKAS_TEST_NODE || process.execPath,
    ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1',
  };
}

function sample(args: string[]) {
  const found = samples.find((entry) => JSON.stringify(entry.args) === JSON.stringify(args));
  if (!found) throw new Error(`Missing official CLI fixture: ${args.join(' ')}`);
  return found;
}

// Match the real provider protocol, never accept arbitrary `schema ...` as success.
function fixtureRunner(execute?: (args: string[]) => unknown, override?: (entry: Sample) => Sample) {
  return vi.fn((_command: string, args: string[]) => {
    expect(args.slice(1, 4)).toEqual(['--offline', '-y', fixture.package]);
    const cliArgs = args.slice(4);
    if (cliArgs.includes('--profile')) {
      if (!execute) throw new Error('Unexpected business execution');
      return { status: 0, stdout: JSON.stringify(execute(cliArgs)), stderr: '' };
    }
    const entry = sample(cliArgs);
    return override ? override(entry) : entry;
  });
}

async function call(name: string, args: object, runner: ReturnType<typeof fixtureRunner>) {
  return adapter.callTool(name, args, { runner, skipPackageIntegrityCheck: true }, envFor());
}

describe('Lark user journeys against the pinned official command contract', () => {
  it('keeps captured provider evidence tied to the reviewed CLI version', () => {
    expect(adapter.MANIFESTS.lark.package).toBe(fixture.package);
    expect(sample(['schema', 'docs']).status).toBe(2);
    expect(sample(['docs', '+fetch', '--help']).status).toBe(0);
  });

  it.each(adapter.MANIFESTS.lark.domains as string[])('discovers actual commands under the authorized %s domain', async (domain) => {
    const result = await call('list_capabilities', { path: domain }, fixtureRunner());
    expect(result.schema.length).toBeGreaterThan(0);
    expect(result.schema.every((entry: { name: string }) => entry.name.startsWith(`${domain} `))).toBe(true);
  });

  it.each([
    ['docs', '+fetch', { doc: 'doc-fixture', doc_format: 'markdown' }, ['--doc', 'doc-fixture', '--doc-format', 'markdown']],
    ['contact', '+search-user', { user_ids: 'ou_fixture', as: 'user' }, ['--user-ids', 'ou_fixture', '--as', 'user']],
    ['im', '+chat-messages-list', { chat_id: 'oc_fixture', page_size: '1', 'no-reactions': false }, ['--chat-id', 'oc_fixture', '--page-size', '1', '--no-reactions=false']],
    ['im', '+chat-list', { page_size: 1 }, ['--page-size', '1']],
    ['im', '+messages-search', { start: '2026-09-06T12:00:00+08:00', end: '2026-09-07T12:00:00+08:00', page_size: 50 },
      ['--start', '2026-09-06T12:00:00+08:00', '--end', '2026-09-07T12:00:00+08:00', '--page-size', '50']],
    ['base', '+record-list', { base_token: 'base_fixture', table_id: 'tbl_fixture', field_id: ['Budget, September', 'Date'] },
      ['--base-token', 'base_fixture', '--table-id', 'tbl_fixture', '--field-id', 'Budget, September', '--field-id', 'Date']],
  ])('discovers, describes and reads %s %s without an unnecessary approval lane', async (domain, command, parameters, flags) => {
    const execute = vi.fn((args: string[]) => {
      expect(args).toEqual([domain, command, ...flags as string[], '--profile', 'contract-profile', '--format', 'json']);
      return { ok: true, identity: 'user', data: { value: 'provider-result' } };
    });
    const runner = fixtureRunner(execute);
    const available = await call('list_capabilities', { path: domain }, runner);
    const action = available.schema.find((entry: { name: string }) => entry.name === `${domain} ${command}`).name;
    const described = await call('describe_action', { action }, runner);
    expect(described.risk).toBe('R');
    expect(described.schema.inputSchema.type).toBe('object');
    const result = await call('execute_read', { action: described.action, parameters }, runner);
    expect(result.result).toEqual({ ok: true, identity: 'user', data: { value: 'provider-result' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wiki.spaces.get_node', { params: { token: 'wiki-fixture' } }, ['wiki', 'spaces', 'get_node']],
    ['im.chat.members.get', { params: { chat_id: 'oc_fixture' } }, ['im', 'chat.members', 'get']],
  ])('preserves API reads and the provider resource token in %s', async (action, parameters, command) => {
    const runner = fixtureRunner((args) => {
      expect(args.slice(0, 3)).toEqual(command);
      expect(args.slice(3)).toEqual(['--params', JSON.stringify(parameters.params), '--profile', 'contract-profile', '--format', 'json']);
      return { ok: true, data: { id: 'record-fixture' } };
    });
    expect((await call('execute_read', { action, parameters }, runner)).result.data.id).toBe('record-fixture');
  });

  it('follows a returned API subgroup to its member-list action', async () => {
    const runner = fixtureRunner();
    const domain = await call('list_capabilities', { path: 'im' }, runner);
    const subgroup = domain.schema.find((entry: { name: string }) => entry.name === 'im chat.members');
    const methods = await call('list_capabilities', { path: subgroup.name }, runner);
    const action = methods.schema.find((entry: { name: string }) => entry.name === 'im chat.members get');
    expect((await call('describe_action', { action: action.name }, runner)).risk).toBe('R');
  });

  it.each([
    ['docs.+update', 'W', 'execute_write'],
    ['im.+messages-send', 'H', 'execute_high_impact'],
    ['docs.+resource-delete', 'D', 'execute_destructive'],
    ['vc.+meeting-end', 'H', 'execute_high_impact'],
  ])('keeps %s out of the read lane despite other read-related help text', async (action, risk, tool) => {
    const execute = vi.fn();
    const runner = fixtureRunner(execute);
    expect((await call('describe_action', { action }, runner)).risk).toBe(risk);
    await expect(call('execute_read', { action }, runner)).rejects.toThrow(tool);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { unknown: 'value' }, { doc: 12 }, { doc: 'x', doc_format: null },
    { doc: 'x', doc_format: 'markdown', 'doc-format': 'xml' }, { doc: 'x', profile: 'other' },
  ])('rejects invalid shortcut parameters before business execution: %j', async (parameters) => {
    const execute = vi.fn();
    await expect(call('execute_read', { action: 'docs.+fetch', parameters }, fixtureRunner(execute)))
      .rejects.toThrow(/parameter/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'conflicting', 'look-alike', 'prose-footer', 'wrong-command', 'group'])('rejects %s shortcut help without executing', async (variant) => {
    const execute = vi.fn();
    const runner = fixtureRunner(execute, (entry) => {
      let stdout = entry.stdout;
      if (variant === 'missing') stdout = stdout.replace('Risk: read\n', '');
      if (variant === 'unknown') stdout = stdout.replace('Risk: read', 'Risk: unknown');
      if (variant === 'conflicting') stdout = stdout.replace('Risk: read', 'Risk: read\nRisk: write');
      if (variant === 'look-alike') stdout = stdout.replace('Risk: read', '  Example: Risk: read');
      if (variant === 'prose-footer') stdout = stdout.replace('Risk: read', '') + '\nNotes:\n  Unrelated example\n\nRisk: read\n';
      if (variant === 'wrong-command') stdout = stdout.replace('lark-cli docs +fetch [flags]', 'lark-cli docs +update [flags]');
      if (variant === 'group') stdout = stdout.replace('lark-cli docs +fetch [flags]', 'lark-cli docs +fetch [flags]\n  lark-cli docs +fetch [command]');
      return { ...entry, stdout };
    });
    await expect(call('execute_read', { action: 'docs.+fetch' }, runner)).rejects.toThrow(/contract|schema/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts provider help on Windows and preserves the original underscore flag spelling', async () => {
    const runner = fixtureRunner((args) => {
      expect(args).toContain('--input_format');
      expect(args).not.toContain('--input-format');
      return { ok: true };
    }, (entry) => ({ ...entry, stdout: entry.stdout.replace(/\n/g, '\r\n') }));
    await call('execute_write', { action: 'docs.+whiteboard-update', parameters: { input_format: 'svg' } }, runner);
    const described = await call('describe_action', { action: 'sheets.+cells-get' }, runner);
    expect(described.risk).toBe('R');
    expect(described.schema.inputSchema.properties).toHaveProperty('range');
  });

  it.each(['wrong-action', 'missing-risk', 'group'])('rejects %s API schemas before a read can execute', async (variant) => {
    const execute = vi.fn();
    const runner = fixtureRunner(execute, (entry) => {
      const schema = JSON.parse(entry.stdout);
      if (variant === 'wrong-action') schema.name = 'im messages delete';
      if (variant === 'missing-risk') delete schema._meta.risk;
      if (variant === 'group') delete schema.inputSchema;
      return { ...entry, stdout: JSON.stringify(schema) };
    });
    await expect(call('execute_read', { action: 'wiki.spaces.get_node' }, runner)).rejects.toThrow(/contract/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, 2])('recognizes a structured failure on stdout with exit %s despite unrelated stderr', async (status) => {
    const runner = fixtureRunner(undefined, () => ({
      args: [], status, stderr: 'private provider diagnostic',
      stdout: JSON.stringify({ ok: false, error: { type: 'authorization', subtype: 'access_denied', message: 'private message' } }),
    }));
    const error = await call('describe_action', { action: 'docs.+fetch' }, runner).catch((error: Error) => error);
    expect(error.code).toBe('connector_permission_denied');
    expect(JSON.stringify(error)).not.toContain('private');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['validation', 'invalid_argument', 'local_cli_invalid_argument'],
    ['authorization', 'missing_scope', 'connector_permission_denied'],
    ['authentication', 'token_expired', 'connector_reconnect_required'],
    ['network', 'timeout', 'local_cli_network_failed'],
  ])('distinguishes %s/%s without exposing private provider diagnostics or replaying', async (type, subtype, code) => {
    const execute = vi.fn();
    const runner = fixtureRunner(execute, () => ({
      args: [], status: 2, stdout: '', stderr: JSON.stringify({ ok: false, error: {
        type, subtype, code: 99991679,
        message: 'private-user@example.test /Users/test/token.json unauthorized',
        hint: 'login with access_token=private-token',
      } }),
    }));
    const error = await call('describe_action', { action: 'docs.+fetch' }, runner).catch((error: Error) => error);
    expect(error.code).toBe(code);
    expect(error.message).not.toMatch(/private|\/Users\/|access_token/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves multiline content, repeated values and approved input-file boundaries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-lark-files-'));
    const approved = path.join(root, 'draft.md');
    fs.writeFileSync(approved, '# Contract fixture');
    try {
      const execute = vi.fn((args: string[]) => {
        expect(args).toContain(`@${approved}`);
        return { ok: true };
      });
      const args = { action: 'docs.+update', parameters: { doc: 'fixture-doc', command: 'append', content: `@${approved}` } };
      const runner = fixtureRunner(execute);
      const env = { ...envFor(root), ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]) };
      await adapter.callTool('execute_write', args, { runner, skipPackageIntegrityCheck: true }, env);
      await expect(adapter.callTool('execute_write', args, { runner, skipPackageIntegrityCheck: true }, {
        ...env, ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: '[]',
      })).rejects.toThrow(/outside/);
      expect(execute).toHaveBeenCalledTimes(1);

      const content = 'Line one\n$(literal) `literal`, "quoted"';
      const send = fixtureRunner((argv) => {
        expect(argv).toEqual(['im', '+messages-send', '--chat-id', 'oc_fixture', '--markdown', content,
          '--attachment', '"file_one,two"', '--attachment', '"file_three"',
          '--profile', 'contract-profile', '--format', 'json']);
        return { ok: true };
      });
      await call('execute_high_impact', { action: 'im.+messages-send', parameters: {
        chat_id: 'oc_fixture', markdown: content, attachment: ['file_one,two', 'file_three'],
      } }, send);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the destructive lane and provider confirmation flag only after the host selected that lane', async () => {
    const execute = vi.fn((args: string[]) => {
      expect(args).toContain('--yes');
      return { ok: true };
    });
    const runner = fixtureRunner(execute);
    const args = { action: 'im.messages.delete', parameters: { params: { message_id: 'om_fixture' } } };
    await expect(call('execute_read', args, runner)).rejects.toThrow(/execute_destructive/);
    expect(execute).not.toHaveBeenCalled();
    await call('execute_destructive', args, runner);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['malformed', 'unknown-category', 'unknown-subtype'])('keeps %s provider diagnostics private', async (variant) => {
    const runner = fixtureRunner(undefined, () => ({
      args: [], status: 2, stdout: '',
      stderr: variant === 'malformed' ? 'private-value unauthorized /private/path'
        : JSON.stringify({ ok: false, error: {
          type: variant === 'unknown-category' ? 'private-value' : 'validation',
          subtype: 'private-value', message: 'private-value', hint: 'private-value',
        } }),
    }));
    const error = await call('describe_action', { action: 'docs.+fetch' }, runner).catch((error: Error) => error);
    expect(error.message).not.toContain('private-value');
    expect(error.code).not.toBe('connector_reconnect_required');
    expect(JSON.stringify(error)).not.toContain('private-value');
  });

  it('completes document discovery/read and returns recoverable errors over the real MCP stdio boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-lark-stdio-'));
    fs.mkdirSync(path.join(root, 'work'));
    const cli = path.join(root, 'npx-cli.cjs');
    const marker = path.join(root, '.orkas-cli-integrity.json');
    const trace = path.join(root, 'calls.jsonl');
    fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.lark));
    fs.writeFileSync(cli, [
      "const fs = require('node:fs');",
      `const samples = ${JSON.stringify(samples)};`,
      'const args = process.argv.slice(5);',
      `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');`,
      "if (args[0] === 'auth' && args[1] === 'status') {",
      "  process.stdout.write(JSON.stringify({ authenticated: true }));",
      "} else if (args[0] === 'docs' && args[1] === '+fetch' && args.includes('--doc')) {",
      "  if (args[args.indexOf('--doc') + 1] === 'denied') {",
      "    process.stderr.write(JSON.stringify({ ok: false, error: { type: 'authorization', subtype: 'missing_scope', code: 99991679, message: 'private-author private-token' } }));",
      '    process.exitCode = 3;',
      '  } else process.stdout.write(JSON.stringify({ ok: true, data: { content: "Fixture document" } }));',
      '} else {',
      '  const found = samples.find(s => JSON.stringify(s.args) === JSON.stringify(args));',
      "  if (!found) { process.stderr.write('unrecognized fixture command'); process.exitCode = 2; }",
      '  else { process.stdout.write(found.stdout); process.stderr.write(found.stderr); process.exitCode = found.status; }',
      '}',
    ].join('\n'));
    const transport = new StdioClientTransport({
      command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: [path.resolve('bin/local-cli-mcp-server.cjs')], stderr: 'pipe',
      env: { ...envFor(root), ORKAS_LOCAL_CLI_NPX_CLI: cli, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker, ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '0' },
    });
    let diagnostics = '';
    transport.stderr?.on('data', (data) => { diagnostics += String(data); });
    const client = new Client({ name: 'lark-document-regression', version: '1.0.0' });
    const parse = (result: any) => JSON.parse(result.content[0].text);
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.find((tool) => tool.name === 'execute_read')?.annotations?.readOnlyHint).toBe(true);
      const discovery = parse(await client.callTool({ name: 'list_capabilities', arguments: { path: 'docs' } }));
      expect(discovery.schema).toContainEqual(expect.objectContaining({ name: 'docs +fetch' }));
      const described = parse(await client.callTool({ name: 'describe_action', arguments: { action: 'docs.+fetch' } }));
      expect(described.risk).toBe('R');
      const result = await client.callTool({ name: 'execute_read', arguments: { action: described.action, parameters: { doc: 'fixture' } } });
      expect(result.isError).not.toBe(true);
      expect(parse(result).result.data.content).toBe('Fixture document');
      const failure = await client.callTool({ name: 'execute_read', arguments: { action: described.action, parameters: { doc: 'denied' } } });
      expect(failure.isError).toBe(true);
      expect(parse(failure)).toMatchObject({ error_code: 'connector_permission_denied', provider_error: { type: 'authorization', subtype: 'missing_scope', code: 99991679 } });
      expect(JSON.stringify(failure)).not.toContain('private-');
      const recovered = await client.callTool({ name: 'execute_read', arguments: { action: described.action, parameters: { doc: 'fixture' } } });
      expect(recovered.isError).not.toBe(true);
      expect(parse(recovered).result.data.content).toBe('Fixture document');
      const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.filter((args: string[]) => args.includes('--doc'))).toHaveLength(3);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
      expect(diagnostics).toBe('');
    }
  });
});

// Opt-in native canary uses an already installed exact-version binary. It never
// installs software, opens real profiles, reads credentials, or calls business APIs.
const nativeCli = process.env.ORKAS_TEST_LARK_CLI_BIN;
describe.skipIf(!nativeCli)('installed official Lark CLI compatibility canary', () => {
  it('matches frozen discovery/help/schema contracts in an isolated configuration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-lark-canary-'));
    try {
      const env = { PATH: process.env.PATH || '', LARKSUITE_CLI_CONFIG_DIR: root, NO_UPDATE_NOTIFIER: '1' };
      const version = spawnSync(nativeCli!, ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
      expect(version.status).toBe(0);
      expect(version.stderr).toBe('');
      expect(version.stdout.trim()).toBe(`lark-cli version ${fixture.package.split('@').at(-1)}`);
      for (const expected of samples) {
        const actual = spawnSync(nativeCli!, expected.args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
        expect({ status: actual.status, stdout: actual.stdout.replace(/\r\n/g, '\n'), stderr: actual.stderr.replace(/\r\n/g, '\n') }, expected.args.join(' '))
          .toEqual({ status: expected.status, stdout: expected.stdout, stderr: expected.stderr });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
