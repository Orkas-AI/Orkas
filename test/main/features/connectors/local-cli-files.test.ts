import { spawnSync } from 'node:child_process';
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
function fullLarkScopes(env: any, ...extra: string[]) { return [...new Set([...auth.larkRequiredScopes(env), ...extra])]; }
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

  it.each(['cancel', 'deadline'])('preserves %s during attachment staging before any business execution', async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const env = envFor('lark');
    const controller = new AbortController();
    const execute = vi.fn(() => ok({ ok: true }));
    const open = fs.promises.open.bind(fs.promises);
    const makeDirectory = fs.mkdtempSync.bind(fs);
    let staging = '';
    vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix: any, options: any) => {
      const directory = makeDirectory(prefix, options);
      if (String(prefix).includes('orkas-cli-input-')) staging = String(directory);
      return directory;
    });
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === fs.realpathSync(source)) {
        entered();
        await held;
      }
      return handle;
    });
    const pending = adapter.executeAction('H', { action: 'im.+messages-send', parameters: {
      user_id: 'ou_fixture', file: source,
    } }, { runner: runnerFor(execute), signal: controller.signal }, env).catch((error: Error) => error);
    try {
      await waiting;
      if (outcome === 'cancel') controller.abort();
      else await vi.advanceTimersByTimeAsync(600_000);
      release();
      expect(await pending).toMatchObject({ code: outcome === 'cancel' ? 'E_TOOL_CALL_CANCELLED' : 'ETIMEDOUT' });
      expect(execute).not.toHaveBeenCalled();
      expect(staging).not.toBe('');
      expect(fs.existsSync(staging)).toBe(false);
      expect(fs.readFileSync(source)).toEqual(bytes);
    } finally { release(); await pending; vi.useRealTimers(); }
  });

  it.each(['ordinary', 'transfer'])('gives %s execution its own bounded deadline', async (kind) => {
    const execute = vi.fn((_args: string[], options: any) => {
      expect(options.timeout).toBe(600_000);
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

  it.each(['unavailable', 'malformed', 'verified'])('reports %s permission verification through the real child entry point without authorizing', mode => {
    const baseEnv = envFor('lark');
    const env = { ...baseEnv, ORKAS_LOCAL_CLI_BRAND: 'feishu',
      ORKAS_LOCAL_CLI_INTEGRITY_MARKER: path.join(baseEnv.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-cli-integrity.json') };
    const npx = path.join(root, 'fake-npx.cjs');
    const calls = path.join(root, 'calls.json');
    fs.writeFileSync(npx, `const fs = require('node:fs');
if (!process.argv.includes('scopes')) fs.writeFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(2)));
if (process.env.FIXTURE_MODE === 'unavailable') process.exit(1);
process.stdout.write(process.env.FIXTURE_MODE === 'malformed' ? '{' : JSON.stringify({ identities: { user: { available: true, verified: true, scope: ${JSON.stringify(auth.larkRequiredScopes(env).join(' '))} } } }));`);
    auth.writeIntegrityMarker(auth.MANIFESTS.lark, env);
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user', missing_scopes: ['docx:document:readonly'] } }, env);
    const file = path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-user-permissions.json');
    const original = fs.readFileSync(file, 'utf8');
    const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath, [path.resolve(__dirname, '../../../../bin/local-cli-auth.cjs')], {
      env: { ...process.env, ...env, ORKAS_NODE: process.env.ORKAS_TEST_NODE || process.execPath,
        ORKAS_LOCAL_CLI_NPX_CLI: npx, ORKAS_LOCAL_CLI_CHECK_PERMISSIONS_ONLY: '1', ORKAS_LOCAL_CLI_INSTALL_ONLY: '0',
        FIXTURE_MODE: mode, FIXTURE_CALLS: calls }, encoding: 'utf8', timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(calls, 'utf8')).slice(3)).toEqual(['auth', 'status', '--profile', 'file-contract', '--verify', '--json']);
    expect(result.status).toBe(mode === 'verified' ? 0 : 1);
    if (mode === 'verified') expect(permissions.readPermissionRequest(env)).toBeNull();
    else {
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(result.stderr).toContain('permission verification unavailable');
    }
  });

  it('discovers missing send permission without logging in, preserves other grants and removes the notice after a confirmed grant', () => {
    const env = envFor('lark');
    let grant = fullLarkScopes(env, 'offline_access').filter(scope => scope !== 'im:message.send_as_user').join(' ');
    const runner = vi.fn((_node, argv) => {
      if (argv.includes('scopes')) return ok({ tokenType: 'user', userScopes: fullLarkScopes(env) });
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
      return ok({ identities: { user: { available: true, verified: true, scope: fullLarkScopes(env).join(' ') } } });
    });
    expect(permissions.readPermissionRequest(env)).toMatchObject({ unresolved_access: true });
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => ok({ identities: { user: {
      available: true, verified: true, scope: fullLarkScopes(env).join(' '),
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
      .rejects.toMatchObject({ code: 'connector_permission_denied', provider_error: {
        recovery: provider === 'lark' ? 'check_resource_access' : 'reauthorize',
      } });
    expect(runner).toHaveBeenCalledOnce();
    expect(permissions.readPermissionRequest(env)).toMatchObject({ reauthorize: true, scopes: [] });
    if (provider === 'lark') expect(permissions.structuredPermissionFailure(runner(), provider).message).not.toContain('reauthorize');
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

  it('retains a permission recovery entry when the accumulated Lark scope list exceeds the bounded request', () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user',
      missing_scopes: Array.from({ length: 257 }, (_, index) => `resource:scope${index}`),
    } }, env);
    expect(permissions.readPermissionRequest(env)).toMatchObject({ reauthorize: true, scopes: [],
      missing_scope_overflow: true, access_issues: [] });
  });

  it.each([230013, 99991679])('retains Lark API permission code %s with the applicable access recovery', code => {
    const env = envFor('lark');
    const error = lark.structuredFailure({ status: 1, stdout: JSON.stringify({ ok: false, error: { type: 'api', code } }), stderr: '' });
    permissions.rememberPermissionRequest(error, env);
    expect(error).toMatchObject({ code: 'connector_permission_denied', provider_error: { type: 'api', code,
      recovery: code === 230013 ? 'check_bot_availability' : 'check_resource_access' } });
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
    const grants = execute.mock.calls.filter(([args]) => args[0] === 'pat' && !args.includes('--dry-run'));
    expect(grants).toHaveLength(1);
    for (const [args, capture] of grants) {
      expect(args).toContain('calendar.event:get');
      expect(args).not.toContain('chat.message:send');
      expect(args.slice(0, 2)).toEqual(['pat', 'chmod']);
      expect(args.slice(-2)).toEqual(['--format', 'json']);
      expect(capture).toBe('tee');
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
    expect(execute.mock.calls.every(([args]) => ['auth', 'pat'].includes(args[0]))).toBe(true);
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
    expect(execute.mock.calls[0][0]).toEqual(['auth', 'login', '--device', '--no-browser']);
    const grants = execute.mock.calls.filter(([args]) => args[0] === 'pat' && !args.includes('--dry-run'));
    expect(grants).toHaveLength(1);
    for (const [args] of grants) expect(args).toEqual(expect.arrayContaining(['chat.message:send', '--domains', auth.MANIFESTS.dingtalk.domains.join(','), '--yes']));
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
    expect(execute.mock.calls.every(([args]) => ['auth', 'pat'].includes(args[0]))).toBe(true);
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
    expect(execute.mock.calls.every(([args]) => ['auth', 'pat'].includes(args[0]))).toBe(true);
  });

  it.each(['PAT_SCOPE_AUTH_REQUIRED', 'PAT_ORG_POLICY_DENIED', 'PAT_NO_PERMISSION'])(
    'does not mistake identity login for restored DingTalk access: %s', async code => {
      const env = envFor('dingtalk');
      dwsDenied(env, code, code === 'PAT_SCOPE_AUTH_REQUIRED' ? { missingScope: 'mail:send' } : {});
      const execute = vi.fn(async () => undefined);
      await expect(auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
        { execute, authorizationReady: () => true })).rejects.toThrow();
      expect(permissions.readPermissionRequest(env)).not.toBeNull();
      expect(execute.mock.calls[0][0]).toEqual(['auth', 'login', '--device', '--no-browser']);
    });

  it('keeps WeCom recovery after cancellation and identity-only reauthorization without replaying business calls', async () => {
    const env = envFor('wecom');
    const denied = { code: 'connector_permission_denied', provider_error: { type: 'authorization', connector_level: true } };
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

  it('preserves cancellation and old grants without mistaking unknown Lark access for an authorization failure', async () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, env);
    const oldScopes = fullLarkScopes(env, 'offline_access');
    const authorizationReady = vi.fn(() => true);
    const execute = vi.fn(async () => { throw new Error('cancelled'); });
    const deps = { execute, authorizationReady, authorizationScopes: () => oldScopes };
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, deps)).rejects.toThrow('cancelled');
    expect(permissions.readPermissionRequest(env)).not.toBeNull();
    execute.mockImplementation(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, deps)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(['--domain', '--scope', [...oldScopes].sort().join(' '), '--json']));
    expect(authorizationReady).toHaveBeenLastCalledWith();
    expect(permissions.readPermissionRequest(env)).toMatchObject({ unresolved_access: true });
  });

  function permissionError(identity = 'user', subtype = 'missing_scope') {
    return lark.structuredFailure({ status: 2, stdout: '', stderr: JSON.stringify({
      ok: false, identity, missing_scopes: ['im:message.send_as_user'],
      error: { type: 'authorization', subtype, message: 'private provider message', hint: 'private hint' },
    }) });
  }

  it('completes Lark user authorization while retaining the separate bot access advisory', async () => {
    const env = envFor('lark');
    lark.rememberPermissionRequest(permissionError('bot'), env);
    lark.rememberPermissionRequest(permissionError('user'), env);
    const execute = vi.fn(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: () => true, authorizationScopes: () => fullLarkScopes(env, 'offline_access'),
    })).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual(expect.arrayContaining(['auth', 'login', '--domain', '--scope', '--json']));
    expect(execute.mock.calls[0][0][execute.mock.calls[0][0].indexOf('--scope') + 1].split(' '))
      .toEqual(expect.arrayContaining(['im:message.send_as_user', 'calendar:calendar.event:read', 'offline_access']));
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true,
      access_issues: [{ identity: 'bot', recovery: 'check_app_permissions' }] });
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => ok({ identities: { user: {
      available: true, verified: true, scope: fullLarkScopes(env, 'offline_access').join(' '),
    } } }));
    expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true });
  });

  it('recovers a legacy stuck Lark record without treating unknown access as restored', async () => {
    const env = envFor('lark');
    fs.writeFileSync(path.join(env.ORKAS_LOCAL_CLI_RUNTIME_DIR, '.orkas-user-permissions.json'), JSON.stringify({
      profile: env.ORKAS_LOCAL_CLI_PROFILE, reauthorize: true, scopes: [], unresolved_access: true,
    }));
    const execute = vi.fn(async () => undefined);
    const deps = { execute, authorizationReady: () => true,
      authorizationScopes: () => fullLarkScopes(env, 'offline_access') };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, deps)).resolves.toBeUndefined();
      expect(permissions.readPermissionRequest(env)).toMatchObject({ scopes: [], unresolved_access: true,
        access_issues: [{ identity: 'unknown', recovery: 'check_resource_access' }] });
    }
    expect(execute.mock.calls.every(([args]: any) => args[0] === 'auth' && args[1] === 'login')).toBe(true);
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
        expect(args.slice(0, 4)).toEqual(['auth', 'login', '--profile', 'file-contract']);
        expect(args).toContain('--domain');
        const requested = args[args.indexOf('--scope') + 1].split(' ');
        expect(requested).toEqual(expect.arrayContaining([...required, ...granted]));
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
  it('requests full business permissions on explicit reconnect while preserving existing grants', async () => {
    const env = envFor('lark');
    const error = permissionError();
    lark.rememberPermissionRequest(error, env);
    expect(error.provider_error.recovery).toBe('reauthorize');
    expect(JSON.stringify(error)).not.toContain('private');
    let granted = false;
    const execute = vi.fn(async (args: string[]) => {
      expect(args).toEqual(expect.arrayContaining(['auth', 'login', '--domain', '--json']));
      expect(args[args.indexOf('--scope') + 1].split(' ')).toEqual(expect.arrayContaining(['docs:document:read', 'im:message.send_as_user', 'calendar:calendar.event:read']));
      granted = true;
    });
    await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: (scopes: string[] = []) => !scopes.length || granted,
      authorizationScopes: () => granted ? fullLarkScopes(env, 'docs:document:read') : ['docs:document:read'],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(lark.readPermissionRequest(env)).toBeNull();
    execute.mockClear();
    await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, { execute, authorizationReady: () => true, authorizationScopes: () => fullLarkScopes(env, 'docs:document:read') });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps a usable partial connection and missing permissions after completed consent without the grants', async () => {
    const env = envFor('lark');
    lark.rememberPermissionRequest(permissionError(), env);
    const execute = vi.fn(async () => undefined);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: (scopes: string[] = []) => !scopes.length,
      authorizationScopes: () => [],
    })).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(lark.readPermissionRequest(env)?.scopes).toEqual(expect.arrayContaining(['im:message.send_as_user', 'calendar:calendar.event:read']));
  });

  it('retains an unknown access advisory without inventing scopes when the provider supplies no scope list', () => {
    const env = envFor('lark');
    const error = permissionError();
    delete error.provider_error.missing_scopes;
    lark.rememberPermissionRequest(error, env);
    expect(lark.readPermissionRequest(env)?.scopes).toEqual([]);
    expect(error.provider_error.recovery).toBe('check_resource_access');
  });

  it.each([['bot', 'missing_scope'], ['bot', 'token_scope_insufficient'], ['', 'missing_scope'],
    ['user', 'app_scope_not_applied'], ['user', 'access_denied']])(
    'separates business access recovery for %s/%s from user consent', (identity, subtype) => {
      const env = envFor('lark');
      const error = permissionError(identity, subtype);
      lark.rememberPermissionRequest(error, env);
      const recovery = identity === 'bot' || subtype === 'app_scope_not_applied'
        ? 'check_app_permissions' : 'check_resource_access';
      expect(error.provider_error.recovery).toBe(recovery);
      expect(lark.readPermissionRequest(env)).toMatchObject({ scopes: [], access_issues: [{ recovery }] });
    },
  );

  it.each(['same-scope', 'bot-access'])('preserves a newer %s denial arriving during successful Lark authorization', async variant => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest(permissionError(), env);
    let newer;
    const execute = vi.fn(async () => {
      permissions.rememberPermissionRequest(permissionError(variant === 'same-scope' ? 'user' : 'bot'), env);
      newer = permissions.readPermissionRequest(env);
    });
    await auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, authorizationReady: () => true, authorizationScopes: () => fullLarkScopes(env, 'offline_access'),
    });
    expect(permissions.readPermissionRequest(env)).toEqual(newer);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('bounds repeated bot denials and retains their structured reason without provider prose', () => {
    const env = envFor('lark');
    for (let index = 0; index < 100; index++) {
      const error = lark.structuredFailure({ status: 1, stderr: '', stdout: JSON.stringify({
        ok: false, identity: 'bot', error: { type: 'api', code: 230013, message: `private-recipient-${index}` },
      }) });
      permissions.rememberPermissionRequest(error, env);
      expect(error.provider_error.recovery).toBe('check_bot_availability');
    }
    const pending = permissions.readPermissionRequest(env);
    expect(pending.access_issues).toEqual([{ identity: 'bot', recovery: 'check_bot_availability', code: 230013 }]);
    expect(JSON.stringify(pending)).not.toContain('private-recipient');
    expect(Buffer.byteLength(JSON.stringify(pending))).toBeLessThan(1024);
  });

  it.each(['calendar:calendar.event:read', 'docx:document:readonly', 'drive:file:download',
    'mail:user_mailbox.message:send', 'task:task:read'])(
    'detects missing %s before a business call and clears only after the verified grant', scope => {
      const env = envFor('lark');
      const granted = new Set(fullLarkScopes(env, 'offline_access'));
      granted.delete(scope);
      const runner = vi.fn((_node, argv) => {
        if (argv.includes('scopes')) return ok({ tokenType: 'user', userScopes: fullLarkScopes(env) });
        expect(argv.slice(4)).toEqual(['auth', 'status', '--profile', 'file-contract', '--verify', '--json']);
        return ok({ identities: { user: { available: true, verified: true, scope: [...granted] } } });
      });
      expect(auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner)).toBe(true);
      expect(permissions.readPermissionRequest(env)?.scopes).toEqual([scope]);
      granted.add(scope);
      auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
      expect(permissions.readPermissionRequest(env)).toBeNull();
    },
  );

  it('keeps the complete domain deficiency readable when no business scope was granted', () => {
    const env = envFor('lark');
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, () => ok({ identities: { user: {
      available: true, verified: true, scope: 'offline_access',
    } } }));
    const pending = permissions.readPermissionRequest(env);
    expect(pending.scopes).toEqual(expect.arrayContaining(['calendar:calendar.event:read', 'docx:document:readonly', 'im:message.send_as_user']));
    expect(pending.scopes.length).toBeGreaterThan(50);
    expect(Buffer.byteLength(JSON.stringify(pending))).toBeLessThan(16 * 1024);
  });

  it('clears a confirmed user-app restriction only when the official enabled-scope report verifies it', () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest(permissionError('user', 'app_scope_not_applied'), env);
    let enabled = fullLarkScopes(env).filter(scope => scope !== 'im:message.send_as_user');
    const runner = vi.fn((_node, argv) => argv.includes('scopes')
      ? ok({ tokenType: 'user', userScopes: enabled, appId: 'must-not-be-persisted' })
      : ok({ identities: { user: { available: true, verified: true, scope: fullLarkScopes(env) } } }));
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)?.access_issues).toMatchObject([{ recovery: 'check_app_permissions' }]);
    expect(JSON.stringify(permissions.readPermissionRequest(env))).not.toContain('must-not-be-persisted');
    enabled = fullLarkScopes(env);
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it.each(['complete', 'partial', 'cancel'])('runs full login after initialization creates a verified identity: %s', async outcome => {
    const env = envFor('lark');
    let identity = false;
    let scopes = ['offline_access'];
    const execute = vi.fn(async (args: string[]) => {
      if (args[0] === 'config') { identity = true; return; }
      expect(args).toContain('--domain');
      const requested = args[args.indexOf('--scope') + 1].split(' ');
      expect(requested).toEqual(expect.arrayContaining(['calendar:calendar.event:read', 'im:message.send_as_user', 'offline_access']));
      if (outcome === 'cancel') throw new Error('cancelled');
      scopes = outcome === 'partial' ? requested.filter(scope => scope !== 'calendar:calendar.event:read') : requested;
      if (outcome === 'partial') throw Object.assign(new Error('official CLI exited with 3'), {
        stdout: JSON.stringify({ event: 'authorization_complete', requested, granted: scopes }),
      });
    });
    const attempt = auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      execute, profileConfigured: () => false, authorizationReady: () => identity, authorizationScopes: () => scopes,
    });
    if (outcome === 'cancel') await expect(attempt).rejects.toThrow('cancelled');
    else await attempt;
    expect(execute.mock.calls.map(([args]) => args[0])).toEqual(['config', 'auth']);
    if (outcome === 'partial') expect(permissions.readPermissionRequest(env)?.scopes).toEqual(['calendar:calendar.event:read']);
    else expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('does not accept an incomplete authorization event as successful recovery of an old identity', async () => {
    const env = envFor('lark');
    permissions.rememberPermissionRequest(permissionError(), env);
    const original = permissions.readPermissionRequest(env);
    await expect(auth.authorizeLark('', '', auth.MANIFESTS.lark, env, {
      authorizationReady: () => true, authorizationScopes: () => ['offline_access'],
      execute: async () => { throw Object.assign(new Error('cancelled'), { stdout: '{"event":"authorization_complete"}' }); },
    })).rejects.toThrow('cancelled');
    expect(permissions.readPermissionRequest(env)).toEqual(original);
  });

  it('checks DingTalk full-domain permissions without granting and retains independent OAuth and newer denials', () => {
    const env = envFor('dingtalk');
    let complete = false;
    const runner = vi.fn((_node, argv) => {
      const args = argv.slice(4);
      expect(args).toEqual(expect.arrayContaining(['pat', 'chmod', '--domains', auth.MANIFESTS.dingtalk.domains.join(','), '--dry-run', '--format', 'json']));
      expect(args).not.toContain('--yes');
      return ok({ success: true, data: { allGranted: complete, selectedScopes: ['chat.message:send'], pendingScopes: [], skippedScopes: [] } });
    });
    expect(auth.checkDingtalkPermissions('', '', auth.MANIFESTS.dingtalk, env, runner)).toBe(true);
    expect(permissions.readPermissionRequest(env)).toMatchObject({ plan_missing: true });
    complete = true;
    auth.checkDingtalkPermissions('', '', auth.MANIFESTS.dingtalk, env, runner);
    expect(permissions.readPermissionRequest(env)).toBeNull();
    dwsDenied(env, 'PAT_SCOPE_AUTH_REQUIRED', { identity: 'user', missingScope: 'Contact.User.Read' });
    auth.checkDingtalkPermissions('', '', auth.MANIFESTS.dingtalk, env, runner);
    expect(permissions.readPermissionRequest(env)?.scopes).toEqual(['Contact.User.Read']);
    const before = permissions.readPermissionRequest(env);
    auth.checkDingtalkPermissions('', '', auth.MANIFESTS.dingtalk, env, (...args: any[]) => {
      dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'chat.message:send' });
      return runner(...args);
    });
    expect(permissions.readPermissionRequest(env)?.revision).not.toBe(before.revision);
    expect(permissions.readPermissionRequest(env)?.pat_scopes).toContain('chat.message:send');
  });

  it.each(['timeout', 'malformed', 'missing-status', 'invalid-scopes', 'null-scopes', 'request-preview', 'preview-with-status'])(
    'preserves DingTalk permission evidence when the full-domain plan is %s', mode => {
      const env = envFor('dingtalk');
      dwsDenied(env, 'PAT_NO_PERMISSION', { scope: 'chat.message:send' });
      const original = permissions.readPermissionRequest(env);
      // Pinned DWS 1.0.61 emits a local request preview for --dry-run. Even
      // success-shaped extra fields cannot turn a preview into grant evidence.
      const preview = { dry_run: true, note: 'execution skipped by --dry-run',
        request: { jsonrpc: '2.0', method: 'tools/call', params: {
          name: 'pat.batch_plan', arguments: { productCodes: ['calendar'], dryRun: true },
        } } };
      const result = mode === 'timeout' ? { error: new Error('timeout') }
        : mode === 'malformed' ? { status: 0, stdout: '{' }
          : mode === 'request-preview' ? ok(preview)
            : mode === 'preview-with-status' ? ok({ ...preview, success: true, data: { allGranted: true } })
          : ok({ success: true, data: { ...(mode === 'invalid-scopes' ? { allGranted: true, pendingScopes: ['--invalid'] } : mode === 'null-scopes' ? { allGranted: true, pendingScopes: null } : {}) } });
      expect(auth.checkDingtalkPermissions('', '', auth.MANIFESTS.dingtalk, env, () => result)).toBe(false);
      expect(permissions.readPermissionRequest(env)).toEqual(original);
    },
  );

  it.each(['complete', 'restricted', 'cancel'])('requests full DingTalk domain access on the first connection: %s', async outcome => {
    const env = envFor('dingtalk');
    let authenticated = false;
    const execute = vi.fn(async (args: string[]) => {
      if (args[0] === 'auth') { authenticated = true; return; }
      expect(args).toContain('--domains');
      expect(args[args.indexOf('--domains') + 1].split(',')).toEqual(expect.arrayContaining(['calendar', 'chat', 'doc', 'drive']));
      if (args.includes('--dry-run')) return JSON.stringify({ success: true, data: {
        allGranted: outcome === 'complete', pendingScopes: [], skippedScopes: [],
      } });
      if (outcome === 'cancel') throw new Error('cancelled');
      if (outcome === 'restricted') throw Object.assign(new Error('official CLI exited with 4'), {
        stderr: JSON.stringify({ success: false, code: 'PAT_ORG_POLICY_DENIED', data: { scope: 'chat.message:send' } }),
      });
      return args.includes('json') ? JSON.stringify({ success: true, data: { grantedScopes: ['chat.message:send'] } }) : undefined;
    });
    const attempt = auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env, {
      execute, authorizationReady: () => authenticated,
    });
    if (outcome === 'cancel') await expect(attempt).rejects.toThrow('cancelled');
    else await attempt;
    expect(execute.mock.calls[0][0]).toEqual(['auth', 'login', '--device', '--no-browser']);
    expect(execute.mock.calls.every(([args]) => ['auth', 'pat'].includes(args[0]))).toBe(true);
    if (outcome === 'restricted') expect(permissions.readPermissionRequest(env)).toMatchObject({ admin_required: true, plan_missing: true });
    else expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('records confirmed WeCom identity-discovery restrictions without treating network failure or identity success as grant proof', () => {
    const env = envFor('wecom');
    expect(auth.checkWecomPermissions('', '', auth.MANIFESTS.wecom, env,
      () => ({ error: new Error('timeout') }))).toBe(false);
    expect(permissions.readPermissionRequest(env)).toBeNull();
    expect(auth.checkWecomPermissions('', '', auth.MANIFESTS.wecom, env,
      () => ({ status: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'PermissionError' } }) }))).toBe(false);
    const pending = permissions.readPermissionRequest(env);
    expect(pending).toMatchObject({ reauthorize: true, identity_denied: true });
    expect(auth.checkWecomPermissions('', '', auth.MANIFESTS.wecom, env,
      () => ok({ extra_identity_context: 'verified-fixture-identity' }))).toBe(true);
    expect(permissions.readPermissionRequest(env)?.identity_denied).toBeUndefined();
    expect(permissions.readPermissionRequest(env)?.unresolved_access).toBe(true);
  });

  it('accepts declared API alternatives but keeps shortcut requirements exact', () => {
    const env = { ...envFor('lark'), ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: '["calendar"]' };
    const apiScopes = ['calendar:calendar:create', 'calendar:calendar:delete', 'calendar:calendar:read', 'calendar:calendar:update'];
    const grant = new Set(fullLarkScopes(env).filter(scope => !apiScopes.includes(scope)));
    grant.add('calendar:calendar');
    // Some API read contracts omit the broad scope and require a readonly alternative.
    grant.add('calendar:calendar:readonly');
    const runner = () => ok({ identities: { user: { available: true, verified: true, scope: [...grant] } } });
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)).toBeNull();
    grant.delete('calendar:calendar.event:read');
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)?.scopes).toEqual(['calendar:calendar.event:read']);
  });

  it('does not turn an absent Lark scope report into an empty grant or a full deficiency', () => {
    const env = envFor('lark');
    const runner = () => ok({ identities: { user: { available: true, verified: true } } });
    expect(auth.larkAuthorizationReady('', '', auth.MANIFESTS.lark, env, runner)).toBe(true);
    expect(auth.larkUserScopes('', '', auth.MANIFESTS.lark, env, runner)).toBeNull();
    expect(auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner)).toBe(false);
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('detects an app-disabled scope despite an unchanged valid user token, then clears it after app approval', () => {
    const env = envFor('lark');
    let enabled = fullLarkScopes(env).filter(scope => scope !== 'im:message.send_as_user');
    const runner = (_node: string, argv: string[]) => argv.includes('scopes')
      ? ok({ tokenType: 'user', userScopes: enabled })
      : ok({ identities: { user: { available: true, verified: true, scope: fullLarkScopes(env) } } });
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)?.access_issues).toEqual([
      { identity: 'user', recovery: 'check_app_permissions', scopes: ['im:message.send_as_user'] },
    ]);
    enabled = fullLarkScopes(env);
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, runner);
    expect(permissions.readPermissionRequest(env)).toBeNull();
  });

  it('preserves full-plan and overflow evidence when a newer unrelated denial arrives', () => {
    const dws = envFor('dingtalk');
    permissions.recordDingtalkPermissionCheck(dws, null, { complete: false, missing: [] }, auth.MANIFESTS.dingtalk.domains);
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, dws);
    expect(permissions.readPermissionRequest(dws)?.plan_missing).toBe(true);
    const env = envFor('lark');
    permissions.rememberPermissionRequest({ provider_error: { type: 'authorization', identity: 'user',
      missing_scopes: Array.from({ length: 257 }, (_, i) => `fixture:scope${i}`) } }, env);
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied' }, env);
    expect(permissions.readPermissionRequest(env)?.missing_scope_overflow).toBe(true);
  });

  it('keeps simultaneous full user/app deficiencies inside the existing ledger byte bound', () => {
    const env = envFor('lark');
    auth.checkLarkPermissions('', '', auth.MANIFESTS.lark, env, (_node: string, argv: string[]) => argv.includes('scopes')
      ? ok({ tokenType: 'user', userScopes: null, count: 0 })
      : ok({ identities: { user: { available: true, verified: true, scope: 'offline_access' } } }));
    const pending = permissions.readPermissionRequest(env);
    expect(pending.scopes).toEqual(expect.arrayContaining(['im:message.send_as_user', 'docx:document:readonly']));
    expect(pending.access_issues[0].scopes).toContain('calendar:calendar.event:read');
    expect(Buffer.byteLength(JSON.stringify(pending))).toBeLessThan(16 * 1024);
  });

  it('verifies requested scope membership as well as the user identity', () => {
    const env = envFor('lark');
    const runner = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ identities: { user: {
      available: true, verified: true, scope: 'im:message im:resource',
    } } }) }));
    expect(auth.larkAuthorizationReady('', '', auth.MANIFESTS.lark, env, runner)).toBe(true);
    expect(auth.larkAuthorizationReady('', '', auth.MANIFESTS.lark, env, runner, ['im:message.send_as_user'])).toBe(false);
  });
});
