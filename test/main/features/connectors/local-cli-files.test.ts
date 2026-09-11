import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const testNode = process.env.ORKAS_TEST_NODE || process.execPath;
const adapter = require('../../../../bin/local-cli-mcp-server.cjs');
const lark = require('../../../../bin/local-cli-lark.cjs');
const auth = require('../../../../bin/local-cli-auth.cjs');
const permissions = require('../../../../bin/local-cli-permissions.cjs');
const samples = require('./fixtures/lark-cli-1.0.93.json').samples;
const contracts = require('./fixtures/local-cli-file-contracts.json').contracts;
// Captured from the pinned official binary in an isolated, unauthenticated home.
const uploadSchema = contracts['lark-upload'];
let root: string;
let allowed: string;
let source: string;
let outside: string;
const bytes = Buffer.from('Handoff fixture\n\u0000$(literal) 宇涛');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-file-contract-'));
  allowed = path.join(root, 'approved');
  fs.mkdirSync(allowed);
  source = path.join(allowed, 'handoff 宇涛.md');
  outside = path.join(root, 'outside.json');
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(outside, '{}');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function envFor(provider: string) {
  const manifest = adapter.MANIFESTS[provider];
  const runtime = path.join(root, provider);
  fs.mkdirSync(path.join(runtime, 'work'), { recursive: true });
  return {
    ORKAS_LOCAL_CLI_PROVIDER: provider,
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_RUNTIME_DIR: runtime,
    ORKAS_LOCAL_CLI_WORK_DIR: path.join(runtime, 'work'),
    ORKAS_LOCAL_CLI_PROFILE: 'file-contract',
    ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([allowed]),
    ORKAS_NODE: testNode,
    ORKAS_LOCAL_CLI_NPX_CLI: '/fixture/npx-cli.js',
  };
}
function ok(data: unknown) { return { status: 0, stdout: JSON.stringify(data), stderr: '' }; }
function runnerFor(execute: (args: string[], options: any) => unknown, provider = 'lark') {
  return vi.fn((_command: string, argv: string[], options: any) => {
    const args = argv.slice(4);
    if (args[0] === 'schema' || args.includes('--help') || args.includes('--schema')) {
      if (provider === 'wecom') return ok(contracts[args.includes('aibot') ? 'wecom-send' : 'wecom-upload']);
      if (provider === 'dingtalk') return ok(contracts[args.includes('sheet chart create') ? 'dingtalk-chart' : 'dingtalk-upload']);
      if (args.join(' ') === 'docs +media-insert --help') return { status: 0, stdout: contracts['lark-media-help'], stderr: '' };
      if (args.join(' ') === 'base +record-upload-attachment --help') return { status: 0, stdout: contracts['lark-array-help'], stderr: '' };
      if (args.join(' ') === 'schema im.files.create') return ok(uploadSchema);
      const sample = samples.find((entry: any) => entry.args.join(' ') === args.join(' '));
      if (!sample) throw new Error('Missing pinned CLI contract');
      return sample;
    }
    return execute(args, options);
  });
}
function stagedBytes(args: string[], options: any, flag: string, prefix = '') {
  const value = args[args.indexOf(flag) + 1];
  expect(value.startsWith(prefix)).toBe(true);
  const relative = value.slice(prefix.length);
  expect(path.isAbsolute(relative)).toBe(false);
  expect(relative.split(/[\\/]/)).not.toContain('..');
  expect(path.basename(relative)).toBe(path.basename(source));
  return fs.readFileSync(path.join(options.cwd, relative));
}

describe('local CLI attachment journeys and input boundaries', () => {
  it('uploads a declared file array with duplicate basenames without replacing either attachment', async () => {
    const other = path.join(allowed, 'other', path.basename(source));
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, 'second attachment');
    const execute = vi.fn((args: string[], options: any) => {
      const files = args.flatMap((arg, i) => arg === '--file' ? [args[i + 1]] : []);
      expect(files).toHaveLength(2);
      expect(new Set(files).size).toBe(2);
      expect(files.map(file => path.basename(file))).toEqual([path.basename(source), path.basename(source)]);
      expect(files.map(file => fs.readFileSync(path.join(options.cwd, file))))
        .toEqual([bytes, Buffer.from('second attachment')]);
      return ok({ ok: true });
    });
    const env = envFor('lark');
    await adapter.executeAction('W', { action: 'base.+record-upload-attachment', parameters: {
      base_token: 'base-fixture', table_id: 'tblFixture', record_id: 'recFixture', field_id: 'fldFixture', file: [source, other],
    } }, { runner: runnerFor(execute) }, env);
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it.each(['complete', 'cancel', 'deadline'])('keeps a transfer live only until its %s outcome and removes staging', async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const env = envFor('lark');
    const controller = new AbortController();
    const onProgress = vi.fn(async () => {});
    let finish: () => void = () => {};
    const execute = vi.fn(async (_args: string[], options: any) => {
      await new Promise<void>(resolve => {
        finish = resolve;
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return ok({ ok: true });
    });
    const pending = adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', file: source,
    } }, { runner: runnerFor(execute), signal: controller.signal, onProgress }, env).catch((error: Error) => error);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const initial = onProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      expect(onProgress.mock.calls.length).toBeGreaterThan(initial);
      if (outcome === 'complete') finish();
      else if (outcome === 'cancel') controller.abort();
      else await vi.advanceTimersByTimeAsync(600_000);
      const result = await pending;
      if (outcome === 'complete') expect(result).toMatchObject({ result: { ok: true } });
      else expect(result).toMatchObject({ code: outcome === 'cancel' ? 'E_TOOL_CALL_CANCELLED' : 'ETIMEDOUT' });
      expect(execute).toHaveBeenCalledOnce();
      expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
      const terminal = onProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onProgress.mock.calls.length).toBe(terminal);
    } finally { finish(); await pending; vi.useRealTimers(); }
  });

  it('uses the declared file carrier across document operations and preserves caption text that looks like a path', async () => {
    const execute = vi.fn((args: string[], options: any) => {
      expect(stagedBytes(args, options, '--file')).toEqual(bytes);
      expect(args[args.indexOf('--caption') + 1]).toBe('/help');
      return ok({ ok: true });
    });
    await adapter.executeAction('W', { action: 'docs.+media-insert', parameters: {
      doc: 'doc-fixture', file: source, caption: '/help',
    } }, { runner: runnerFor(execute) }, envFor('lark'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(['ordinary', 'transfer'])('gives %s execution its own bounded deadline', async (kind) => {
    const execute = vi.fn((_args: string[], options: any) => {
      expect(options.timeout).toBe(kind === 'transfer' ? 600_000 : 60_000);
      return ok({ ok: true });
    });
    await adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', ...(kind === 'transfer' ? { file: source } : { text: 'hello' }),
    } }, { runner: runnerFor(execute) }, envFor('lark'));
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['success', 'failure', 'cancel'])('sends the approved Lark attachment once and cleans staging on %s', async (outcome) => {
    const env = envFor('lark');
    const controller = new AbortController();
    let staging = '';
    const execute = vi.fn((args: string[], options: any) => {
      staging = options.cwd;
      expect(stagedBytes(args, options, '--file')).toEqual(bytes);
      const configRelative = path.relative(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, fs.realpathSync(staging));
      expect(configRelative === '..' || configRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configRelative)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(staging).mode & 0o777).toBe(0o700);
      expect(args.slice(args.indexOf('--as'), args.indexOf('--as') + 2)).toEqual(['--as', 'user']);
      expect(args).toContain('attachment-contract');
      if (outcome === 'cancel') controller.abort();
      return outcome === 'failure' ? { status: 2, stdout: '', stderr: 'private provider failure' }
        : ok({ ok: true, data: { message_id: 'message-fixture' } });
    });
    const pending = adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', file: source, as: 'user', idempotency_key: 'attachment-contract',
    } }, { runner: runnerFor(execute), signal: controller.signal }, env);
    if (outcome === 'success') await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    else await expect(pending).rejects.toThrow(outcome === 'cancel' ? /cancelled/ : /command failed/);
    expect(execute).toHaveBeenCalledOnce();
    expect(staging).not.toBe(env.ORKAS_LOCAL_CLI_WORK_DIR);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(bytes);
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it('uploads the native binary carrier, preserving file metadata and the provider key=value argv', async () => {
    const env = envFor('lark');
    const execute = vi.fn((args: string[], options: any) => {
      expect(stagedBytes(args, options, '--file', 'file=')).toEqual(bytes);
      const configRelative = path.relative(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, fs.realpathSync(options.cwd));
      expect(configRelative === '..' || configRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configRelative)).toBe(true);
      expect(JSON.parse(args[args.indexOf('--data') + 1])).toEqual({ file_type: 'stream', file_name: 'handoff 宇涛.md' });
      return ok({ ok: true, data: { file_key: 'file_fixture' } });
    });
    await adapter.executeAction('W', { action: 'im.files.create', parameters: {
      data: { file_type: 'stream', file_name: 'handoff 宇涛.md' }, file: { file: source },
    } }, { runner: runnerFor(execute) }, env);
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it.each(['outside', 'symlink', 'missing', 'directory', 'wrong-risk', 'aborted', 'unknown-binary-field'])(
    'prevents any upload or send with %s input and leaves no staging', async (failure) => {
      const env = envFor('lark');
      let input = source;
      if (failure === 'outside') input = outside;
      if (failure === 'symlink') { input = path.join(allowed, 'link.json'); fs.symlinkSync(outside, input); }
      if (failure === 'missing') input = path.join(allowed, 'missing');
      if (failure === 'directory') input = allowed;
      const controller = new AbortController();
      if (failure === 'aborted') controller.abort();
      const execute = vi.fn(() => ok({ ok: true }));
      const action = failure === 'unknown-binary-field' ? 'im.files.create' : 'im.+messages-send';
      const parameters = failure === 'unknown-binary-field' ? { file: { other: source } }
        : { user_id: 'ou_fixture', file: input };
      await expect(adapter.executeAction(failure === 'wrong-risk' ? 'R' : action === 'im.files.create' ? 'W' : 'H',
        { action, parameters }, { runner: runnerFor(execute), signal: controller.signal }, env)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
    },
  );

  it('rejects a source replaced between validation and opening without copying outside bytes', async () => {
    const env = envFor('lark');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...args) => {
      if (file === fs.realpathSync(source)) {
        fs.unlinkSync(source);
        fs.symlinkSync(outside, source);
      }
      return open(file, ...args);
    });
    const execute = vi.fn(() => ok({ ok: true }));
    await expect(adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', file: source,
    } }, { runner: runnerFor(execute) }, env)).rejects.toThrow(/prepared/);
    expect(execute).not.toHaveBeenCalled();
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it.each(['file_fixture', 'https://example.test/file.pdf'])('passes the remote Lark resource %s without local file access', async (file) => {
    const env = envFor('lark');
    const execute = vi.fn((args: string[]) => { expect(args).toContain(file); return ok({ ok: true }); });
    await adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', file,
    } }, { runner: runnerFor(execute) }, env);
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it.each(['/help', '@alice hello', '@所有人 hello'])('preserves literal Lark message text %s', async (text) => {
    const execute = vi.fn((args: string[]) => { expect(args).toContain(text); return ok({ ok: true }); });
    await adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', text,
    } }, { runner: runnerFor(execute) }, envFor('lark'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('sends a WeCom file media object without treating it as a path', async () => {
    const execute = vi.fn((args: string[]) => {
      expect(JSON.parse(args[args.indexOf('--json') + 1])).toEqual({ chat_id: 'chat-fixture', msg_type: 'file', file: { media_id: 'media-fixture' } });
      return ok({ ok: true });
    });
    await adapter.executeAction('H', { action: 'message.aibot.send', parameters: {
      chat_id: 'chat-fixture', msg_type: 'file', file: { media_id: 'media-fixture' },
    } }, { runner: runnerFor(execute, 'wecom') }, envFor('wecom'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(['wecom', 'dingtalk'])('preserves approved %s file uploads', async (provider) => {
    const execute = vi.fn((args: string[], options: any) => {
      const file = provider === 'wecom' ? JSON.parse(args[args.indexOf('--json') + 1]).file_path
        : args[args.indexOf('--file') + 1];
      expect(fs.readFileSync(path.join(options.cwd, file))).toEqual(bytes);
      return ok({ ok: true });
    });
    const env = envFor(provider);
    await adapter.executeAction('W', { action: provider === 'wecom' ? 'media.upload' : 'drive.upload',
      parameters: provider === 'wecom' ? { file_path: source } : { file: source },
    }, { runner: runnerFor(execute, provider) }, env);
    expect(execute).toHaveBeenCalledOnce();
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });

  it.each(['approved', 'outside', 'undeclared'])('controls DingTalk indirect input: %s', async (state) => {
    const execute = vi.fn((args: string[], options: any) => {
      expect(stagedBytes(args, options, '--properties', '@')).toEqual(bytes);
      return ok({ ok: true });
    });
    const env = envFor('dingtalk');
    const parameters = state === 'undeclared' ? { title: `@${outside}` }
      : { properties: `@${state === 'outside' ? outside : source}` };
    const pending = adapter.executeAction('W', { action: 'sheet.chart.create', parameters },
      { runner: runnerFor(execute, 'dingtalk') }, env);
    if (state === 'approved') { await pending; expect(execute).toHaveBeenCalledOnce(); }
    else { await expect(pending).rejects.toThrow(/outside|not declared/); expect(execute).not.toHaveBeenCalled(); }
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR)).toEqual([]);
  });
});

describe('reauthorization across business domains and CLI providers', () => {
  it.each(['lark', 'dingtalk', 'wecom'])('rejects failed %s identity checks even when stdout contains a previously valid identity', provider => {
    const env = envFor(provider);
    const payload = provider === 'lark'
      ? { identities: { user: { available: true, verified: true, scope: 'im:message.send_as_user' } } }
      : provider === 'dingtalk' ? { success: true, authenticated: true } : { extra_identity_context: 'fixture-identity' };
    const verify = auth[`${provider}AuthorizationReady`];
    for (const status of [1, null]) {
      expect(verify('', '', auth.MANIFESTS[provider], env, () => ({ ...ok(payload), status }))).toBe(false);
    }
    expect(verify('', '', auth.MANIFESTS[provider], env, () => ok(payload))).toBe(true);
  });

  it.each(['missing', 'invalid', 'unverified', 'nonzero'])('retains prior recovery after a %s Lark scope report', variant => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user',
      missing_scopes: ['im:message.send_as_user'] } }, env);
    const pending = permissions.readPermissionRequest(env);
    const user = { available: true, verified: variant !== 'unverified',
      scope: variant === 'missing' ? undefined : variant === 'invalid' ? ['im:message.send_as_user', '--unsafe'] : 'im:message.send_as_user' };
    expect(auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env,
      () => ({ ...ok({ identities: { user } }), status: variant === 'nonzero' ? 1 : 0 }))).toBe(false);
    expect(permissions.readPermissionRequest(env)).toEqual(pending);
  });

  it('does not clear a repeated same-scope denial with an older grant receipt or across profiles', () => {
    const env = envFor('dingtalk');
    const denied = { provider_error: { type: 'authorization', identity: 'pat', missing_scopes: ['chat.message:send'] } };
    permissions.rememberPermissionRequest(denied, env);
    const old = permissions.readPermissionRequest(env);
    permissions.rememberPermissionRequest(denied, env);
    const current = permissions.readPermissionRequest(env);
    expect(current.revision).not.toBe(old.revision);
    permissions.recordPatScopeGrant(env, old, ['chat.message:send']);
    expect(permissions.readPermissionRequest(env)).toEqual(current);
    const other = { ...env, ORKAS_LOCAL_CLI_PROFILE: 'different-account' };
    expect(permissions.readPermissionRequest(other)).toBeNull();
    permissions.clearPermissionRequest(other, current);
    expect(permissions.readPermissionRequest(env)).toEqual(current);
    expect(permissions.readPermissionRequest(envFor('wecom'))).toBeNull();
  });

  it('preserves the original provider error and pending record if persisting a newer denial fails', () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, env);
    const pending = permissions.readPermissionRequest(env);
    const failure = Object.assign(new Error('original failure'), { code: 'connector_permission_denied' });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('ENOSPC'); });
    expect(() => permissions.rememberPermissionRequest(failure, env)).not.toThrow();
    write.mockRestore();
    expect(failure.message).toBe('original failure');
    expect(permissions.readPermissionRequest(env)).toEqual(pending);
    expect(fs.readdirSync(env.ORKAS_LOCAL_CLI_RUNTIME_DIR).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it.each(['malformed', 'symlink', 'invalid-pat'])('ignores %s persisted recovery state without following external data', variant => {
    const env = envFor('dingtalk');
    const file = path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-user-permissions.json');
    const value = { profile: env.ORKAS_LOCAL_CLI_PROFILE, scopes: [], reauthorize: true,
      pat_scopes: variant === 'invalid-pat' ? ['--unsafe'] : ['chat.message:send'] };
    if (variant === 'symlink') {
      fs.writeFileSync(outside, JSON.stringify(value));
      fs.symlinkSync(outside, file);
    } else fs.writeFileSync(file, variant === 'malformed' ? '{' : JSON.stringify(value));
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('discovers missing send permission without logging in, preserves other grants and removes the notice after a confirmed grant', () => {
    const env = envFor('lark');
    let grant = 'docx:document:readonly offline_access';
    const runner = vi.fn((_node, argv) => {
      expect(argv.slice(4)).toEqual(['auth', 'status', '--profile', 'file-contract', '--verify', '--json']);
      return ok({ identities: { user: { available: true, verified: true, scope: grant } } });
    });
    expect(auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner)).toBe(true);
    expect(permissions.readPermissionRequest(env)?.scopes).toEqual(['im:message.send_as_user']);
    const pending = permissions.readPermissionRequest(env);
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)).toEqual(pending);
    grant += ' im:message.send_as_user';
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('keeps permission evidence on unavailable checks, unknown scopes and concurrent business denials', () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user', missing_scopes: ['docx:document:readonly'] } }, env);
    const original = permissions.readPermissionRequest(env);
    for (const result of [{ error: new Error('network') }, ok({ identities: { user: { available: true, verified: true } } })]) {
      expect(auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => result)).toBe(false);
      expect(permissions.readPermissionRequest(env)).toEqual(original);
    }
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => {
      permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, env);
      return ok({ identities: { user: { available: true, verified: true, scope: 'docx:document:readonly im:message.send_as_user' } } });
    });
    expect(permissions.readPermissionRequest(env)).toMatchObject({ unresolved_access: true });
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => ok({ identities: { user: {
      available: true, verified: true, scope: 'docx:document:readonly im:message.send_as_user',
    } } }));
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true });
  });

  it.each([
    ['dingtalk', { ok: false, outcome: 'failure', error: { type: 'auth', subtype: 'http_403', http_status: 403 } }],
    ['wecom', { error: { type: 'AuthError', code: 893201 } }],
    ['xero', { error: { message: 'Xero API error (403): Forbidden' } }],
    ['lark', { ok: false, error: { type: 'authorization' } }],
  ])('records %s permission failures at discovery without business execution or scope metadata', async (provider, payload) => {
    const env = envFor(provider as string);
    const runner = vi.fn(() => ({ status: 1, stdout: JSON.stringify(payload), stderr: '' }));
    await expect(adapter.inspectAction(provider === 'xero' ? 'contacts.list' : provider === 'dingtalk' ? 'doc.get' : provider === 'wecom' ? 'contact.get-user' : 'docs.+fetch', { runner }, env))
      .rejects.toMatchObject({ code: 'connector_permission_denied', provider_error: { recovery: 'reauthorize' } });
    expect(runner).toHaveBeenCalledOnce();
    expect(permissions.readPermissionRequest(env)).toMatchObject({ reauthorize: true, scopes: [] });
  });

  it.each([
    { status: 0, stdout: JSON.stringify({ ok: true, error: { type: 'permission_denied' } }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ error: { type: 'permission_denied' } }), stderr: '' },
    { status: 1, stdout: JSON.stringify({ error: { type: 'network', message: 'missing_scope forbidden 403' } }), stderr: '' },
    { status: 1, stdout: '', stderr: 'Permission denied: local file' },
    { status: 1, stdout: '', stderr: 'Xero API error (403): Forbidden', error: new Error('timeout') },
    { status: 0, stdout: JSON.stringify({ success: true, data: { error: { type: 'permission_denied' } } }), stderr: '' },
    { status: 1, stdout: 'prefix {"error":{"type":"permission_denied"}}', stderr: '' },
    { status: 1, stdout: JSON.stringify([{ error: { type: 'permission_denied' } }]), stderr: '' },
  ])('does not infer missing permissions from successful data, prose or transport failures: %#', result => {
    expect(permissions.structuredPermissionFailure(result, 'xero')).toBeNull();
  });

  it.each([
    { success: true, code: 'PAT_NO_PERMISSION' },
    { success: false, code: 'UNRELATED_FAILURE', data: { code: 'PAT_NO_PERMISSION' } },
    { success: false, data: { error: { type: 'permission_denied' } } },
  ])('does not treat DWS successful or nested business data as a permission channel: %#', payload => {
    expect(permissions.structuredPermissionFailure(ok(payload), 'dingtalk')).toBeNull();
  });

  it('recognizes the pinned Xero CLI status-bearing stderr protocol', () => {
    expect(permissions.structuredPermissionFailure({ status: 1, stdout: '', stderr: 'Error: Xero API error (403): Forbidden\n' }, 'xero'))
      .toMatchObject({ code: 'connector_permission_denied' });
  });

  it.each(['PAT_NO_PERMISSION', 'PAT_LOW_RISK_NO_PERMISSION', 'PAT_MEDIUM_RISK_NO_PERMISSION',
    'PAT_HIGH_RISK_NO_PERMISSION', 'PAT_ORG_POLICY_DENIED', 'PAT_SCOPE_AUTH_REQUIRED'])(
    'recognizes DWS permission channel %s without exposing its authorization URL', code => {
      const env = envFor('dingtalk');
      const result = { status: 4, stdout: '', stderr: JSON.stringify({ success: false, code, data: { uri: 'https://private.invalid/auth' } }) };
      const error = permissions.structuredPermissionFailure(result, 'dingtalk');
      permissions.rememberPermissionRequest(error, env);
      expect(error).toMatchObject({ code: 'connector_permission_denied', provider_error: { recovery: 'reauthorize' } });
      expect(JSON.stringify(error)).not.toContain('private.invalid');
      expect(permissions.readPermissionRequest(env)).not.toBeNull();
    },
  );

  it('still offers reauthorization when the accumulated scope list exceeds the bounded explicit request', () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user',
      missing_scopes: Array.from({ length: 51 }, (_, index) => `resource:scope${index}`),
    } }, env);
    expect(permissions.readPermissionRequest(env)).toMatchObject({ reauthorize: true, scopes: [] });
  });

  it.each([230013, 99991679])('retains Lark API permission code %s and offers reauthorization', code => {
    const env = envFor('lark');
    const error = lark.structuredFailure({ status: 1, stdout: JSON.stringify({ ok: false, error: { type: 'api', code } }), stderr: '' });
    permissions.rememberPermissionRequest(error, env);
    expect(error).toMatchObject({ code: 'connector_permission_denied', provider_error: { type: 'api', code, recovery: 'reauthorize' } });
    expect(permissions.readPermissionRequest(env)).toMatchObject({ reauthorize: true, scopes: [] });
  });

  function dwsDenied(env: any, code: string, data: unknown) {
    const error = permissions.structuredPermissionFailure({ status: 4, stdout: '',
      stderr: JSON.stringify({ success: false, code, data }) }, 'dingtalk');
    permissions.rememberPermissionRequest(error, env);
    return error;
  }

  it.each(['data', 'result'])('retries only outstanding DingTalk PAT scopes after a partial %s receipt', async envelope => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_BATCH_AUTH_PENDING', { scopes: ['chat.message:send', 'calendar.event:get'] });
    let granted = ['chat.message:send'];
    const execute = vi.fn(async (args: string[]) => args.includes('json')
      ? JSON.stringify({ success: true, [envelope]: { grantedScopes: granted } }) : undefined);
    const deps = { execute, authorizationReady: () => true };
    await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env, deps))
      .rejects.toThrow('permissions are still unavailable');
    expect(permissions.readPermissionRequest(env)?.pat_scopes).toEqual(['calendar.event:get']);
    granted = ['calendar.event:get'];
    execute.mockClear();
    await auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env, deps);
    expect(execute.mock.calls).toHaveLength(2);
    for (const [args] of execute.mock.calls) {
      expect(args).toContain('calendar.event:get');
      expect(args).not.toContain('chat.message:send');
      expect(args.slice(0, 2)).toEqual(['pat', 'chmod']);
    }
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it.each([
    ['plain success', JSON.stringify({ ok: true })],
    ['malformed JSON', '{'],
    ['missing receipt', undefined],
    ['failed grant', JSON.stringify({ success: false, data: { grantedScopes: ['chat.message:send'] } })],
    ['wrong case', JSON.stringify({ success: true, data: { grantedScopes: ['Chat.Message:Send'] } })],
    ['wrong shape', JSON.stringify({ success: true, data: { grantedScopes: 'chat.message:send' } })],
    ['unrelated grant', JSON.stringify({ success: true, data: { alreadyGrantedScopes: ['mail:send'] } })],
  ])('retains DingTalk recovery on %s instead of accepting identity success', async (_name, receipt) => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'chat.message:send' });
    const pending = permissions.readPermissionRequest(env);
    const execute = vi.fn(async (args: string[]) => args.includes('json') ? receipt : undefined);
    await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
      { execute, authorizationReady: () => true })).rejects.toThrow('permissions are still unavailable');
    expect(permissions.readPermissionRequest(env)).toMatchObject({ pat_scopes: pending.pat_scopes, scopes: [] });
    expect(execute.mock.calls.every(([args]) => args[0] === 'pat')).toBe(true);
  });

  it('stops before PAT grant when DingTalk identity renewal is cancelled or remains unverified', async () => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'chat.message:send' });
    const pending = permissions.readPermissionRequest(env);
    for (const cancel of [true, false]) {
      const execute = vi.fn(async () => { if (cancel) throw new Error('cancelled'); });
      await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
        { execute, authorizationReady: () => false })).rejects.toThrow(cancel ? 'cancelled' : 'verified identity');
      expect(execute.mock.calls).toEqual([[['auth', 'login', '--device', '--no-browser']]]);
      expect(permissions.readPermissionRequest(env)).toEqual(pending);
    }
  });

  it.each(['PAT_NO_PERMISSION', 'PAT_ORG_POLICY_DENIED'])('recovers a DingTalk scope after %s once the provider confirms access', async code => {
    const env = envFor('dingtalk');
    const error = dwsDenied(env, code, { scope: 'chat.message:send', uri: 'https://private.invalid', clientSecret: 'private' });
    expect(error.provider_error).toMatchObject({ identity: 'pat', missing_scopes: ['chat.message:send'] });
    expect(JSON.stringify(error)).not.toContain('private');
    const pending = permissions.readPermissionRequest(env);
    expect(pending).toMatchObject({ scopes: [], pat_scopes: ['chat.message:send'], unresolved_access: false });
    const execute = vi.fn(async (args: string[]) => args.includes('json')
      ? JSON.stringify({ success: true, data: { alreadyGrantedScopes: ['chat.message:send'] } }) : undefined);
    await auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env, { execute, authorizationReady: () => true });
    expect(execute.mock.calls.map(([args]) => args)).toEqual([
      ['pat', 'chmod', 'chat.message:send', '--grant-type', 'permanent', '--yes', '--format', 'table'],
      ['pat', 'chmod', 'chat.message:send', '--grant-type', 'permanent', '--yes', '--format', 'json'],
    ]);
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('preserves case-sensitive DingTalk OAuth identifiers and rejects CLI argument look-alikes', () => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_SCOPE_AUTH_REQUIRED', { identity: 'user', missingScope: 'Contact.User.Read' });
    dwsDenied(env, 'PAT_SCOPE_AUTH_REQUIRED', { identity: 'user', missingScope: 'Todo.Personal.Write' });
    expect(permissions.readPermissionRequest(env)?.scopes).toEqual(['Contact.User.Read', 'Todo.Personal.Write']);
    for (const scope of ['Contact.User.Read --other', '--scope', 'Contact.User.Read\\nOther', 'Contact.User.Read;command']) {
      expect(permissions.isScopeName(scope)).toBe(false);
    }
  });

  it.each(['bot', 'tenant', undefined])('does not convert DingTalk %s scope failures into user consent', identity => {
    const env = envFor('dingtalk');
    // DWS buildPATScopeJSON carries the affected identity separately from the
    // permission-channel code. Only explicit user scope evidence permits login scopes.
    const error = dwsDenied(env, 'PAT_SCOPE_AUTH_REQUIRED', { identity, missingScope: 'Contact.User.Read' });
    expect(error.provider_error.identity).not.toBe('user');
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true });
  });

  it('removes acknowledged PAT permissions while keeping a separate OAuth deficiency', async () => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_SCOPE_AUTH_REQUIRED', { identity: 'user', missingScope: 'mail:send' });
    dwsDenied(env, 'PAT_BATCH_AUTH_PENDING', { scopes: ['chat.message:send'] });
    const execute = vi.fn(async (args: string[]) => args.includes('json')
      ? JSON.stringify({ success: true, data: { grantedScopes: ['chat.message:send'] } }) : undefined);
    await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
      { execute, authorizationReady: () => true })).rejects.toThrow('permissions could not be verified');
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: ['mail:send'], pat_scopes: [] });
    expect(execute.mock.calls.every(([args]) => args[0] === 'pat')).toBe(true);
  });

  it.each(['cancel', 'partial', 'newer'])('keeps DingTalk permission recovery after %s', async mode => {
    const env = envFor('dingtalk');
    dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'chat.message:send' });
    const execute = vi.fn(async (args: string[]) => {
      if (mode === 'cancel') throw new Error('cancelled');
      if (mode === 'newer') dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'calendar.event:get' });
      return args.includes('json') ? JSON.stringify({ success: true, data: {
        grantedScopes: mode === 'partial' ? [] : ['chat.message:send'],
      } }) : undefined;
    });
    const result = auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env, { execute, authorizationReady: () => true });
    if (mode === 'newer') await result;
    else await expect(result).rejects.toThrow(mode === 'cancel' ? 'cancelled' : 'permissions are still unavailable');
    expect(permissions.readPermissionRequest(env)).not.toBeNull();
    expect(execute.mock.calls.every(([args]) => args[0] === 'pat')).toBe(true);
  });

  it.each(['PAT_SCOPE_AUTH_REQUIRED', 'PAT_ORG_POLICY_DENIED', 'PAT_NO_PERMISSION'])(
    'does not mistake identity login for restored DingTalk access: %s', async code => {
      const env = envFor('dingtalk');
      dwsDenied(env, code, code === 'PAT_SCOPE_AUTH_REQUIRED' ? { missingScope: 'mail:send' } : {});
      const execute = vi.fn(async () => undefined);
      await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
        { execute, authorizationReady: () => true })).rejects.toThrow();
      expect(permissions.readPermissionRequest(env)).not.toBeNull();
      expect(execute.mock.calls.length).toBe(code === 'PAT_ORG_POLICY_DENIED' ? 0 : 1);
    });

  it('keeps WeCom recovery after cancellation and identity-only reauthorization without replaying business calls', async () => {
    const env = envFor('wecom');
    const denied = { code: 'connector_permission_denied' };
    permissions.rememberPermissionRequest(denied, env);
    const execute = vi.fn(async () => { throw new Error('cancelled'); });
    await expect(auth.authorizeSingleStep('', '', auth.MANIFESTS.wecom, env, () => true, { execute }))
      .rejects.toThrow('cancelled');
    expect(permissions.readPermissionRequest(env)).not.toBeNull();
    execute.mockImplementation(async () => { permissions.rememberPermissionRequest(denied, env); });
    await expect(auth.authorizeSingleStep('', '', auth.MANIFESTS.wecom, env, () => true, { execute }))
      .rejects.toThrow('permissions could not be verified');
    const newer = permissions.readPermissionRequest(env);
    execute.mockImplementation(async () => undefined);
    await expect(auth.authorizeSingleStep('', '', auth.MANIFESTS.wecom, env, () => true, { execute }))
      .rejects.toThrow('permissions could not be verified');
    expect(permissions.readPermissionRequest(env)).toEqual(newer);
    expect(execute.mock.calls).toEqual(Array(3).fill([['auth', 'init', '--noninteractive', '--no-browser']]));
  });

  it('forces Lark authorization without missing scope names and preserves old grants through cancellation and retry', async () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, env);
    const oldScopes = ['im:message.send_as_user', 'offline_access'];
    const authorizationReady = vi.fn(() => true);
    const execute = vi.fn(async () => { throw new Error('cancelled'); });
    const deps = { execute, authorizationReady, authorizationScopes: () => oldScopes };
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, deps)).rejects.toThrow('cancelled');
    expect(permissions.readPermissionRequest(env)).not.toBeNull();
    execute.mockImplementation(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, deps)).rejects.toThrow('permissions could not be verified');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith([...auth.MANIFESTS.lark.login(env)[1], '--scope', oldScopes.join(' ')]);
    expect(authorizationReady).toHaveBeenLastCalledWith(oldScopes);
    expect(permissions.readPermissionRequest(env)).toMatchObject({ unresolved_access: true });
  });

  function permissionError(identity = 'user', subtype = 'missing_scope') {
    return lark.structuredFailure({ status: 2, stdout: '', stderr: JSON.stringify({
      ok: false, identity, missing_scopes: ['im:message.send_as_user'],
      error: { type: 'authorization', subtype, message: 'private provider message', hint: 'private hint' },
    }) });
  }

  it('keeps a Lark bot visibility denial after confirming the requested user scope', async () => {
    const env = envFor('lark');
    lark.rememberPermissionRequest(permissionError('bot'), env);
    lark.rememberPermissionRequest(permissionError('user'), env);
    const execute = vi.fn(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: () => true, authorizationScopes: () => ['offline_access'],
    })).rejects.toThrow('permissions could not be verified');
    expect(execute).toHaveBeenCalledExactlyOnceWith([
      'auth', 'login', '--profile', 'file-contract', '--scope', 'im:message.send_as_user offline_access',
    ]);
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => ok({ identities: { user: {
      available: true, verified: true, scope: 'im:message.send_as_user offline_access',
    } } }));
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true });
  });

  it.each(['missing_scope', 'token_scope_insufficient'])(
    'recovers %s across document, spreadsheet and API operations without replaying them', async (subtype) => {
      const env = envFor('lark');
      const operations = [
        ['docs.+fetch', 'docx:document:readonly'],
        ['sheets.+cells-get', 'sheets:spreadsheet:read'],
        ['wiki.spaces.get_node', 'wiki:wiki:readonly'],
      ];
      for (const [action, scope] of operations) {
        const execute = vi.fn(() => ({ status: 3, stdout: '', stderr: JSON.stringify({
          ok: false, identity: 'user', error: {
            type: 'authorization', subtype, missing_scopes: [scope],
          },
        }) }));
        await expect(adapter.executeAction('R', { action }, { runner: runnerFor(execute) }, env))
          .rejects.toMatchObject({ provider_error: { subtype, recovery: 'reauthorize' } });
        expect(execute).toHaveBeenCalledOnce();
      }
      const required = operations.map(([, scope]) => scope);
      expect(lark.readPermissionRequest(env)?.scopes).toEqual([...required].sort());
      const granted = new Set(['im:message.send_as_user', 'offline_access']);
      const execute = vi.fn(async (args: string[]) => {
        expect(args.slice(0, 5)).toEqual(['auth', 'login', '--profile', 'file-contract', '--scope']);
        const requested = args[5].split(' ');
        expect(new Set(requested)).toEqual(new Set([...required, ...granted]));
        requested.forEach(scope => granted.add(scope));
      });
      await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
        execute, authorizationReady: (scopes: string[] = []) => scopes.every(scope => granted.has(scope)),
        authorizationScopes: () => [...granted],
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(lark.readPermissionRequest(env)).toBeNull();
    },
  );

  it.each(['wrong-profile', 'invalid-scope', 'oversized', 'empty'])(
    'does not offer authorization from %s recovery state', (variant) => {
      const env = envFor('lark');
      const value = { profile: variant === 'wrong-profile' ? 'another-profile' : 'file-contract',
        scopes: variant === 'invalid-scope' ? ['docx:document:readonly --other']
          : variant === 'empty' ? [] : ['docx:document:readonly'],
        ...(variant === 'oversized' ? { padding: 'x'.repeat(20_000) } : {}),
      };
      fs.writeFileSync(path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-user-permissions.json'), JSON.stringify(value));
      expect(lark.readPermissionRequest(env)).toBeNull();
    },
  );

  it('preserves granted OAuth scopes that have no business-domain prefix', () => {
    const runner = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ identities: { user: {
      available: true, verified: true, scope: 'offline_access docx:document:readonly',
    } } }) }));
    expect(auth.larkUserScopes('', '', auth.MANIFESTS.lark, envFor('lark'), runner))
      .toEqual(['offline_access', 'docx:document:readonly']);
  });
  it('retains the missing user scope and explicitly requests it on reconnect while preserving normal login reuse', async () => {
    const env = envFor('lark');
    const error = permissionError();
    lark.rememberPermissionRequest(error, env);
    expect(error.provider_error.recovery).toBe('reauthorize');
    expect(JSON.stringify(error)).not.toContain('private');
    let granted = false;
    const execute = vi.fn(async (args: string[]) => {
      expect(args).toEqual(['auth', 'login', '--profile', 'file-contract', '--scope', 'docs:document:read im:message.send_as_user']);
      granted = true;
    });
    await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: (scopes: string[] = []) => !scopes.length || granted,
      authorizationScopes: () => ['docs:document:read'],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(lark.readPermissionRequest(env)).toBeNull();
    execute.mockClear();
    await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, { execute, authorizationReady: () => true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not mistake a valid old login for successful permission grant and retains a retry', async () => {
    const env = envFor('lark');
    lark.rememberPermissionRequest(permissionError(), env);
    const execute = vi.fn(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: (scopes: string[] = []) => !scopes.length,
      authorizationScopes: () => [],
    })).rejects.toThrow(/permissions are still unavailable/);
    expect(execute).toHaveBeenCalledOnce();
    expect(lark.readPermissionRequest(env)?.scopes).toEqual(['im:message.send_as_user']);
  });

  it('offers reauthorization without inventing scopes when the provider supplies no scope list', () => {
    const env = envFor('lark');
    const error = permissionError();
    delete error.provider_error.missing_scopes;
    lark.rememberPermissionRequest(error, env);
    expect(lark.readPermissionRequest(env)?.scopes).toEqual([]);
  });

  it.each([['bot', 'missing_scope'], ['bot', 'token_scope_insufficient'], ['', 'missing_scope'],
    ['user', 'app_scope_not_applied'], ['user', 'access_denied']])(
    'offers reauthorization for %s/%s without requiring IM scope metadata', (identity, subtype) => {
      const env = envFor('lark');
      lark.rememberPermissionRequest(permissionError(identity, subtype), env);
      expect(lark.readPermissionRequest(env)?.reauthorize).toBe(true);
      if (identity !== 'user') expect(lark.readPermissionRequest(env)?.scopes).toEqual([]);
    },
  );

  it('verifies requested scope membership as well as the user identity', () => {
    const env = envFor('lark');
    const runner = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ identities: { user: {
      available: true, verified: true, scope: 'im:message im:resource',
    } } }) }));
    expect(auth.larkAuthorizationReady('', '', auth.MANIFESTS.lark, env, runner)).toBe(true);
    expect(auth.larkAuthorizationReady('', '', auth.MANIFESTS.lark, env, runner, ['im:message.send_as_user'])).toBe(false);
  });
});
