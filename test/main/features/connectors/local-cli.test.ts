import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';

import { describe, expect, it, vi } from 'vitest';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

const interactiveMocks = vi.hoisted(() => ({
  start: vi.fn(() => ({ session_id: 'local-cli-auth-session', status: 'running' })),
  wait: vi.fn(async () => ({
    session_id: 'local-cli-auth-session', status: 'exited', exit_code: 0, output: '',
  })),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: { openExternal: vi.fn(async () => undefined) },
}));
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  }),
}));
vi.mock('../../../../src/main/util/bundled-runtime', () => ({
  bundledNodeExecutable: () => '/opt/orkas/runtime/node',
  bundledNpxCli: () => '/opt/orkas/runtime/lib/node_modules/npm/bin/npx-cli.js',
}));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({
  buildChildProxyEnvironment: vi.fn(async () => ({ HTTPS_PROXY: 'http://proxy.test' })),
}));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({
  startInteractiveCliSession: interactiveMocks.start,
  waitInteractiveCliSession: interactiveMocks.wait,
}));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import {
  authorizeLocalCli,
  checkLocalCliPermissions,
  installLocalCli,
  LOCAL_CLI_MANIFESTS,
  localCliInstallStatus,
  localCliMissingPermissions,
  localCliProfileName,
  localCliRuntimeDir,
  localCliTransport,
  openLocalCliAuthorizationUrl,
  removeLocalCliAuthorization,
} from '../../../../src/main/features/connectors/local-cli';
import { userLocalConfigDir } from '../../../../src/main/paths';

const require = createRequire(import.meta.url);

function seedInstalled(uid: string, entry: NonNullable<ReturnType<typeof findCatalogEntry>>): string {
  const config = entry.local_cli!;
  const runtimeDir = localCliRuntimeDir(uid, entry.id);
  const packageDir = path.join(
    runtimeDir,
    'npm-cache',
    '_npx',
    'test-install',
    'node_modules',
    ...config.package_name.split('/'),
  );
  const binPath = path.join(packageDir, 'bin', `${config.executable}.js`);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: config.package_name,
    version: config.package_version,
    bin: { [config.executable]: `bin/${config.executable}.js` },
  }));
  fs.writeFileSync(path.join(runtimeDir, '.orkas-cli-integrity.json'), JSON.stringify({
    package: `${config.package_name}@${config.package_version}`,
    integrity: config.package_integrity,
  }));
  return runtimeDir;
}

describe('official local CLI connector runtime', () => {
  it('projects missing DingTalk OAuth and PAT scopes without exposing authorization data', () => {
    const uid = 'dingtalk-permission-projection';
    const runtime = localCliRuntimeDir(uid, 'dingtalk');
    fs.mkdirSync(runtime, { recursive: true });
    try {
      fs.writeFileSync(path.join(runtime, '.orkas-user-permissions.json'), JSON.stringify({
        profile: localCliProfileName(uid, 'dingtalk'), reauthorize: true,
        scopes: ['mail:send'], pat_scopes: ['chat.message:send'], admin_required: false,
      }));
      expect(localCliMissingPermissions(uid, 'dingtalk')).toEqual(['chat.message:send', 'mail:send']);
    } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
  });

  it('does not start an old-account permission check after switching accounts during proxy setup', async () => {
    const entry = findCatalogEntry('feishu')!;
    const uid = 'permission-switch-check';
    const directory = seedInstalled(uid, entry);
    const proxy = await import('../../../../src/main/util/proxy-dispatcher');
    const { notifyUserSwitch } = await import('../../../../src/main/features/user-switch-hooks');
    let finish!: (value: Record<string, string>) => void;
    vi.mocked(proxy.buildChildProxyEnvironment).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const runner = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    try {
      const checking = checkLocalCliPermissions(uid, entry, true, runner);
      notifyUserSwitch(uid, 'next-account');
      finish({});
      await checking;
      expect(runner).not.toHaveBeenCalled();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('checks installed Lark permissions on demand, coalesces repeated page opens and supports an explicit refresh', async () => {
    const entry = findCatalogEntry('feishu')!;
    const uid = 'permission-page-check';
    const directory = seedInstalled(uid, entry);
    let finish!: () => void;
    const runner = vi.fn(async (options: any) => {
      expect(options.env.ORKAS_LOCAL_CLI_CHECK_PERMISSIONS_ONLY).toBe('1');
      expect(options.timeoutMs).toBe(60_000);
      expect(options.args).toEqual([expect.stringContaining('local-cli-auth.cjs')]);
      await new Promise<void>(resolve => { finish = resolve; });
      return { exitCode: 0, stderr: '' };
    });
    try {
      expect(runner).not.toHaveBeenCalled();
      const first = checkLocalCliPermissions(uid, entry, false, runner);
      const second = checkLocalCliPermissions(uid, entry, false, runner);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
      finish();
      await Promise.all([first, second]);
      await checkLocalCliPermissions(uid, entry, false, runner);
      expect(runner).toHaveBeenCalledOnce();
      const refreshed = checkLocalCliPermissions(uid, entry, true, runner);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
      const afterConsent = checkLocalCliPermissions(uid, entry, true, runner);
      finish();
      await refreshed;
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(3));
      finish();
      await afterConsent;
      await checkLocalCliPermissions('not-installed', entry, true, runner);
      await checkLocalCliPermissions(uid, findCatalogEntry('wecom')!, true, runner);
      expect(runner).toHaveBeenCalledTimes(3);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('derives deterministic account+connector-isolated profiles and device-local paths', () => {
    expect(localCliProfileName('account-a', 'feishu')).toMatch(/^orkas-[a-f0-9]{16}$/);
    expect(localCliProfileName('account-a', 'feishu')).toBe(localCliProfileName('account-a', 'feishu'));
    expect(localCliProfileName('account-a', 'feishu')).not.toBe(localCliProfileName('account-b', 'feishu'));
    expect(localCliProfileName('account-a', 'feishu')).not.toBe(localCliProfileName('account-a', 'lark'));
    expect(localCliRuntimeDir('account-a', 'wecom')).toBe(
      path.join(userLocalConfigDir('account-a'), 'connector-cli', 'wecom'),
    );
    expect(() => localCliRuntimeDir('account-a', '../escape')).toThrow('invalid local CLI catalog id');
  });

  it('expires the page-check cache without scheduling background checks or borrowing another account result', async () => {
    const entry = findCatalogEntry('feishu')!;
    const accounts = ['permission-ttl-a', 'permission-ttl-b'];
    const directories = accounts.map(uid => seedInstalled(uid, entry));
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runner = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const authCalls = interactiveMocks.start.mock.calls.length;
    try {
      await checkLocalCliPermissions(accounts[0], entry, false, runner);
      now += 59_999;
      await checkLocalCliPermissions(accounts[0], entry, false, runner);
      expect(runner).toHaveBeenCalledOnce();
      await checkLocalCliPermissions(accounts[1], entry, false, runner);
      expect(runner).toHaveBeenCalledTimes(2);
      now += 1;
      expect(runner).toHaveBeenCalledTimes(2);
      await checkLocalCliPermissions(accounts[0], entry, false, runner);
      expect(runner).toHaveBeenCalledTimes(3);
      expect(interactiveMocks.start).toHaveBeenCalledTimes(authCalls);
    } finally {
      clock.mockRestore();
      directories.forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
    }
  });

  it.each(['disconnect', 'account-switch'])('aborts a running permission check and queued refresh on %s', async mode => {
    const entry = findCatalogEntry('feishu')!;
    const uid = `permission-running-${mode}`;
    const directory = seedInstalled(uid, entry);
    let signal!: AbortSignal;
    const runner = vi.fn(async (options: any) => {
      signal = options.signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: 1, stderr: '' };
    });
    try {
      const checking = checkLocalCliPermissions(uid, entry, false, runner);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
      const queued = checkLocalCliPermissions(uid, entry, true, runner);
      if (mode === 'disconnect') await removeLocalCliAuthorization(uid, entry);
      else (await import('../../../../src/main/features/user-switch-hooks')).notifyUserSwitch(uid, 'next-account');
      await Promise.all([checking, queued]);
      expect(signal.aborted).toBe(true);
      expect(runner).toHaveBeenCalledOnce();
      if (mode === 'disconnect') expect(fs.existsSync(directory)).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('materializes the governed adapter with pinned official package metadata and isolated auth env', () => {
    const entry = findCatalogEntry('feishu');
    expect(entry).toBeTruthy();
    const transport = localCliTransport('account-a', entry!);
    expect(transport).toMatchObject({
      kind: 'stdio',
      command: '/opt/orkas/runtime/node',
      args: [path.resolve(__dirname, '../../../../bin/local-cli-mcp-server.cjs')],
      cwd: path.join(userLocalConfigDir('account-a'), 'connector-cli', 'feishu'),
      env: {
        ORKAS_LOCAL_CLI_PROVIDER: 'lark',
        ORKAS_LOCAL_CLI_BRAND: 'feishu',
        ORKAS_LOCAL_CLI_PACKAGE: '@larksuite/cli@1.0.93',
        ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: LOCAL_CLI_MANIFESTS.lark.package_integrity,
        ORKAS_LOCAL_CLI_INTEGRITY_MARKER: path.join(
          userLocalConfigDir('account-a'), 'connector-cli', 'feishu', '.orkas-cli-integrity.json',
        ),
        ORKAS_LOCAL_CLI_WORK_DIR: path.join(
          userLocalConfigDir('account-a'), 'connector-cli', 'feishu', 'work',
        ),
        ORKAS_LOCAL_CLI_PROFILE: localCliProfileName('account-a', 'feishu'),
        ORKAS_LOCAL_CLI_NPX_CLI: '/opt/orkas/runtime/lib/node_modules/npm/bin/npx-cli.js',
        ORKAS_BUNDLED_NODE: '/opt/orkas/runtime/node',
        LARKSUITE_CLI_CONFIG_DIR: path.join(userLocalConfigDir('account-a'), 'connector-cli', 'feishu'),
        NPM_CONFIG_CACHE: path.join(
          userLocalConfigDir('account-a'), 'connector-cli', 'feishu', 'npm-cache',
        ),
      },
    });
    expect(transport.kind === 'stdio' ? transport.env?.ELECTRON_RUN_AS_NODE : undefined).toBeUndefined();
  });

  it('keeps TS catalog pins and both separately spawned helpers in lockstep', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, {
        package: string; integrity: string; executable: string; domains: readonly string[];
      }>;
    };
    const adapter = require('../../../../bin/local-cli-mcp-server.cjs') as typeof helper;
    for (const [provider, manifest] of Object.entries(LOCAL_CLI_MANIFESTS)) {
      for (const spawned of [helper, adapter]) {
        expect(spawned.MANIFESTS[provider]).toMatchObject({
          package: `${manifest.package_name}@${manifest.package_version}`,
          integrity: manifest.package_integrity,
          executable: manifest.executable,
          domains: [...manifest.allowed_domains],
        });
      }
    }
  });

  it('passes only domains accepted by the pinned Lark CLI auth command', () => {
    // Captured from `@larksuite/cli@1.0.93 auth login --help`. Keep this independent
    // from the three runtime manifests so an unsupported shared entry cannot pass lockstep tests.
    const supportedDomains = new Set([
      'application', 'approval', 'apps', 'attendance', 'base', 'calendar', 'contact',
      'docs', 'drive', 'event', 'im', 'mail', 'markdown', 'mindnotes', 'minutes', 'note',
      'okr', 'sheets', 'slides', 'task', 'vc', 'wiki', 'all',
    ]);

    expect(LOCAL_CLI_MANIFESTS.lark.allowed_domains).not.toContain('whiteboard');
    expect(LOCAL_CLI_MANIFESTS.lark.allowed_domains.every((domain) => supportedDomains.has(domain)))
      .toBe(true);
  });

  it('requests the documented Xero read scopes for every exposed report family', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { login: (env: NodeJS.ProcessEnv) => string[][] }>;
    };
    const login = helper.MANIFESTS.xero.login({ ORKAS_LOCAL_CLI_PROFILE: 'fixture-profile' })
      .find((args) => args[0] === 'login')!;
    const scopes = login[login.indexOf('--scope') + 1].split(' ');
    // Independent provider contract: https://developer.xero.com/documentation/guides/oauth2/scopes/
    // These report endpoints have read-only scopes; names without .read do not exist.
    expect(scopes.filter((scope) => scope.startsWith('accounting.reports.')).sort()).toEqual([
      'accounting.reports.aged.read',
      'accounting.reports.balancesheet.read',
      'accounting.reports.profitandloss.read',
      'accounting.reports.trialbalance.read',
    ]);
  });

  it('reuses an already verified Lark user without opening either authorization step', async () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { login: (env: NodeJS.ProcessEnv) => string[][] }>;
      authorizeLark: (
        node: string,
        npxCli: string,
        manifest: { login: (env: NodeJS.ProcessEnv) => string[][] },
        env: NodeJS.ProcessEnv,
        dependencies: {
          execute: ReturnType<typeof vi.fn>;
          profileConfigured: ReturnType<typeof vi.fn>;
          authorizationReady: ReturnType<typeof vi.fn>;
        },
      ) => Promise<void>;
    };
    const execute = vi.fn(async () => undefined);
    const profileConfigured = vi.fn(() => true);
    const authorizationReady = vi.fn(() => true);

    await helper.authorizeLark('/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.lark, {
      ORKAS_LOCAL_CLI_PROFILE: 'orkas-profile',
      ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(['docs']),
    }, { execute, profileConfigured, authorizationReady });

    expect(authorizationReady).toHaveBeenCalledOnce();
    expect(profileConfigured).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a verified Lark user postcondition when auth login itself exits nonzero', async () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { login: (env: NodeJS.ProcessEnv) => string[][] }>;
      authorizeLark: (
        node: string,
        npxCli: string,
        manifest: { login: (env: NodeJS.ProcessEnv) => string[][] },
        env: NodeJS.ProcessEnv,
        dependencies: {
          execute: ReturnType<typeof vi.fn>;
          profileConfigured: ReturnType<typeof vi.fn>;
          authorizationReady: ReturnType<typeof vi.fn>;
        },
      ) => Promise<void>;
    };
    const execute = vi.fn(async () => {
      throw new Error('official CLI exited with 3');
    });
    const profileConfigured = vi.fn(() => true);
    const authorizationReady = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const env = {
      ORKAS_LOCAL_CLI_PROFILE: 'orkas-profile',
      ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(['docs']),
    };

    await expect(helper.authorizeLark(
      '/runtime/node',
      '/runtime/npx-cli.js',
      helper.MANIFESTS.lark,
      env,
      { execute, profileConfigured, authorizationReady },
    )).resolves.toBeUndefined();

    expect(profileConfigured).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith([
      'auth', 'login', '--profile', 'orkas-profile', '--domain', 'docs',
    ]);
    expect(authorizationReady).toHaveBeenCalledTimes(2);
  });

  it('requires structured verified-user state from the pinned Lark status command', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, {
        package: string;
        verify: (env: NodeJS.ProcessEnv) => string[];
      }>;
      larkAuthorizationReady: (
        node: string,
        npxCli: string,
        manifest: { package: string; verify: (env: NodeJS.ProcessEnv) => string[] },
        env: NodeJS.ProcessEnv,
        runner: ReturnType<typeof vi.fn>,
      ) => boolean;
    };
    const env = {
      ORKAS_LOCAL_CLI_PROFILE: 'orkas-profile',
      ORKAS_LOCAL_CLI_WORK_DIR: '/runtime/work',
    };
    const runner = vi.fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ identities: { bot: { verified: true } } }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          identities: { user: { available: true, verified: true } },
        }),
      });

    expect(helper.larkAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.lark, env, runner,
    )).toBe(false);
    expect(helper.larkAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.lark, env, runner,
    )).toBe(true);
    expect(runner).toHaveBeenLastCalledWith(
      '/runtime/node',
      [
        '/runtime/npx-cli.js', '--offline', '-y', helper.MANIFESTS.lark.package,
        'auth', 'status', '--profile', 'orkas-profile', '--verify', '--json',
      ],
      expect.objectContaining({
        cwd: '/runtime/work',
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  });

  it('requires DingTalk authenticated state as well as a successful status command', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { package: string; verify: string[] }>;
      dingtalkAuthorizationReady: (
        node: string,
        npxCli: string,
        manifest: { package: string; verify: string[] },
        env: NodeJS.ProcessEnv,
        runner: ReturnType<typeof vi.fn>,
      ) => boolean;
    };
    const env = { ORKAS_LOCAL_CLI_WORK_DIR: '/runtime/work' };
    const runner = vi.fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ success: true, authenticated: false }),
      })
      .mockReturnValueOnce({
        // DWS 1.0.61 writeAuthStatusJSON returns the encoder result; a successful
        // status command exits zero even when authenticated is false.
        status: 0,
        stdout: JSON.stringify({ success: true, authenticated: true }),
      });

    expect(helper.dingtalkAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.dingtalk, env, runner,
    )).toBe(false);
    expect(helper.dingtalkAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.dingtalk, env, runner,
    )).toBe(true);
    expect(runner).toHaveBeenLastCalledWith(
      '/runtime/node',
      [
        '/runtime/npx-cli.js', '--offline', '-y', helper.MANIFESTS.dingtalk.package,
        'auth', 'status', '--format', 'json',
      ],
      expect.objectContaining({ cwd: '/runtime/work', encoding: 'utf8', windowsHide: true }),
    );
  });

  it('verifies WeCom through the structured identity response instead of status text', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { package: string; verify: string[] }>;
      wecomAuthorizationReady: (
        node: string,
        npxCli: string,
        manifest: { package: string; verify: string[] },
        env: NodeJS.ProcessEnv,
        runner: ReturnType<typeof vi.fn>,
      ) => boolean;
    };
    const env = { ORKAS_LOCAL_CLI_WORK_DIR: '/runtime/work' };
    const runner = vi.fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ error: { code: 893999 } }),
      })
      .mockReturnValueOnce({
        // WeCom's CLI reference defines exit zero as success; a payload alone
        // cannot turn a failed identity command into verification.
        status: 0,
        stdout: JSON.stringify({ extra_identity_context: 'verified identity context' }),
      });

    expect(helper.wecomAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.wecom, env, runner,
    )).toBe(false);
    expect(helper.wecomAuthorizationReady(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.wecom, env, runner,
    )).toBe(true);
    expect(runner).toHaveBeenLastCalledWith(
      '/runtime/node',
      [
        '/runtime/npx-cli.js', '--offline', '-y', helper.MANIFESTS.wecom.package,
        'identity', 'whoami',
      ],
      expect.objectContaining({ cwd: '/runtime/work', encoding: 'utf8', windowsHide: true }),
    );
  });

  it('accepts single-step CLI authorization only when its structured postcondition is true', async () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { login: (env: NodeJS.ProcessEnv) => string[][] }>;
      authorizeSingleStep: (
        node: string,
        npxCli: string,
        manifest: { login: (env: NodeJS.ProcessEnv) => string[][] },
        env: NodeJS.ProcessEnv,
        authorizationReady: ReturnType<typeof vi.fn>,
        dependencies: {
          execute: ReturnType<typeof vi.fn>;
          authorizationReady: ReturnType<typeof vi.fn>;
        },
      ) => Promise<void>;
    };
    const loginError = new Error('official CLI exited with 3');
    const execute = vi.fn(async () => { throw loginError; });
    const readyAfterLogin = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(helper.authorizeSingleStep(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.dingtalk, {}, vi.fn(),
      { execute, authorizationReady: readyAfterLogin },
    )).resolves.toBeUndefined();
    // v1.0.61 DeviceFlowProvider otherwise opens the same URL independently of Orkas.
    expect(execute).toHaveBeenCalledWith(['auth', 'login', '--device', '--no-browser']);

    const neverReady = vi.fn().mockReturnValue(false);
    await expect(helper.authorizeSingleStep(
      '/runtime/node', '/runtime/npx-cli.js', helper.MANIFESTS.dingtalk, {}, vi.fn(),
      { execute: vi.fn(async () => undefined), authorizationReady: neverReady },
    )).rejects.toThrow('did not produce a verified identity');
  });

  it.each(['dingtalk', 'wecom', 'feishu', 'lark', 'xero'])('starts %s authorization with connector UI, direct argv and explicit proxy settings', async (id) => {
    const entry = findCatalogEntry(id);
    expect(entry).toBeTruthy();
    interactiveMocks.start.mockClear();
    interactiveMocks.wait.mockClear();

    const runtimeDir = seedInstalled('account-a', entry!);
    try {
      await authorizeLocalCli('account-a', entry!);

      expect(interactiveMocks.start).toHaveBeenCalledWith(expect.objectContaining({
        uid: 'account-a',
        command: '/opt/orkas/runtime/node',
        args: [path.resolve(__dirname, '../../../../bin/local-cli-auth.cjs')],
        purpose: expect.any(String),
        presentation: id === 'xero' ? 'connector_input' : 'browser_auth',
        sandboxEnv: expect.objectContaining({
          HTTPS_PROXY: 'http://proxy.test',
          ORKAS_LOCAL_CLI_MESSAGE_START: expect.any(String),
          ORKAS_LOCAL_CLI_MESSAGE_DONE: expect.any(String),
        }),
      }));
      expect(interactiveMocks.wait).toHaveBeenCalledWith('account-a', 'local-cli-auth-session');
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('preserves the official organization denial after browser consent without retaining the transcript', async () => {
    const entry = findCatalogEntry('dingtalk')!;
    const runtimeDir = seedInstalled('account-auth-denial', entry);
    // Public error envelope emitted by dws 1.0.61 after the browser reports success.
    const reason = '该组织尚未开启 CLI 数据访问权限，请联系管理员开启';
    interactiveMocks.wait.mockResolvedValueOnce({
      session_id: 'local-cli-auth-session', status: 'error', exit_code: 1,
      output: `private transcript\n${JSON.stringify({ error: {
        category: 'auth', code: 2, message: `device authorization failed: ${reason}`,
      } }, null, 2)}\n[Orkas] official CLI exited with 2\n`,
    });
    try {
      await expect(authorizeLocalCli('account-auth-denial', entry)).rejects.toMatchObject({
        code: 'local_cli_authorization_failed',
        authorization_detail: expect.stringContaining(`device authorization failed: ${reason}`),
      });
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('does not surface an old provider error after success or intentional cancellation', async () => {
    const entry = findCatalogEntry('dingtalk')!;
    const runtimeDir = seedInstalled('account-auth-terminal', entry);
    const output = JSON.stringify({ error: { category: 'auth', code: 2, message: 'Earlier failure' } });
    try {
      interactiveMocks.wait.mockResolvedValueOnce({
        session_id: 'local-cli-auth-session', status: 'exited', exit_code: 0, output,
      });
      await expect(authorizeLocalCli('account-auth-terminal', entry)).resolves.toBeUndefined();
      interactiveMocks.wait.mockResolvedValueOnce({
        session_id: 'local-cli-auth-session', status: 'closed', exit_code: 1, output,
      });
      const failure = await authorizeLocalCli('account-auth-terminal', entry).catch(error => error);
      expect(failure.code).toBe('user_cancelled');
      expect(failure.authorization_detail).toBeUndefined();
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('still reports failure when the provider exits without any error output', async () => {
    const helperPath = path.resolve(__dirname, '../../../../bin/local-cli-auth.cjs');
    const { MANIFESTS } = require(helperPath);
    const manifest = MANIFESTS.dingtalk;
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-silent-cli-'));
    const work = path.join(runtime, 'work');
    fs.mkdirSync(work);
    const provider = path.join(runtime, 'provider.cjs');
    fs.writeFileSync(provider, "if (process.argv.includes('login')) process.exitCode = 2; else process.stdout.write('{}');");
    const marker = path.join(runtime, '.orkas-cli-integrity.json');
    fs.writeFileSync(marker, JSON.stringify({ package: manifest.package, integrity: manifest.integrity }));
    const realProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    try {
      const result = realProcess.spawnSync(process.execPath, [helperPath], {
        env: {
          ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_NODE: TEST_NODE,
          ORKAS_LOCAL_CLI_PROVIDER: 'dingtalk', ORKAS_LOCAL_CLI_NPX_CLI: provider,
          ORKAS_LOCAL_CLI_RUNTIME_DIR: runtime, ORKAS_LOCAL_CLI_WORK_DIR: work,
          ORKAS_LOCAL_CLI_PACKAGE: manifest.package, ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
          ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
          ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
          ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker, ORKAS_LOCAL_CLI_INSTALL_ONLY: '0',
        },
        encoding: 'utf8', timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('official CLI exited with 2');
      expect(result.stdout).not.toContain('Authorization complete.');
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('opens a validated official authorization URL and rejects look-alikes before reaching the OS', async () => {
    const openExternal = vi.mocked(shell.openExternal);
    openExternal.mockClear();

    await expect(openLocalCliAuthorizationUrl(
      'https://open.feishu.cn/page/cli?user_code=FEISHU-42',
    )).resolves.toBeUndefined();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(
      'https://open.feishu.cn/page/cli?user_code=FEISHU-42',
    );

    await expect(openLocalCliAuthorizationUrl(
      'https://open.feishu.cn.evil.test/page/cli?user_code=FEISHU-42',
    )).rejects.toMatchObject({ code: 'local_cli_auth_url_invalid' });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('requires the exact Orkas-managed package, version, executable, and integrity marker', () => {
    const entry = findCatalogEntry('wecom');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-status', 'wecom');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    try {
      expect(localCliInstallStatus('account-status', entry!)).toMatchObject({
        installed: false,
        runtime_ready: true,
        package_name: '@wecom/cli',
        package_version: '1.2.0',
        executable: 'wecom-cli',
      });
      seedInstalled('account-status', entry!);
      expect(localCliInstallStatus('account-status', entry!).installed).toBe(true);

      const packageJson = path.join(
        runtimeDir, 'npm-cache', '_npx', 'test-install', 'node_modules', '@wecom', 'cli', 'package.json',
      );
      const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
      parsed.version = '1.2.1';
      fs.writeFileSync(packageJson, JSON.stringify(parsed));
      expect(localCliInstallStatus('account-status', entry!).installed).toBe(false);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('installs into the isolated cache before authorization and coalesces exact status', async () => {
    const entry = findCatalogEntry('dingtalk');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-install', 'dingtalk');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    const runner = vi.fn(async (options: { env: Record<string, string> }) => {
      expect(options.env).toMatchObject({
        ORKAS_LOCAL_CLI_INSTALL_ONLY: '1',
        NPM_CONFIG_CACHE: path.join(runtimeDir, 'npm-cache'),
        HTTPS_PROXY: 'http://proxy.test',
      });
      seedInstalled('account-install', entry!);
      return { exitCode: 0, stderr: '' };
    });
    try {
      await expect(installLocalCli('account-install', entry!, { runHelper: runner }))
        .resolves.toMatchObject({ installed: true, executable: 'dws' });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('maps registry verification failures to a stable renderer-safe install code', async () => {
    const entry = findCatalogEntry('wecom');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-install-error', 'wecom');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    try {
      await expect(installLocalCli('account-install-error', entry!, {
        runHelper: async () => ({
          exitCode: 1,
          stderr: '[Orkas] unable to verify the official CLI package integrity; secret diagnostics omitted',
        }),
      })).rejects.toMatchObject({ code: 'local_cli_install_registry_unavailable' });
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('terminates the installed helper process tree when installation times out', async () => {
    const entry = findCatalogEntry('wecom')!;
    const runtimeDir = localCliRuntimeDir('account-timeout', entry.id);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-timeout-'));
    const pidFile = path.join(fixtureDir, 'grandchild.pid');
    const grandchildScript = [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentScript = [
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const realProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let parent: ReturnType<typeof spawn> | undefined;
    let grandchildPid = 0;
    vi.mocked(spawn).mockImplementation((command: any, args: any, options: any) => {
      if (parent) return realProcess.spawn(command, args, options);
      parent = realProcess.spawn(process.execPath, ['-e', parentScript], {
        ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      return parent;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = installLocalCli('account-timeout', entry).catch((error) => error);
    try {
      await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 5_000 });
      grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      vi.useRealTimers();
      expect.soft(result).toMatchObject({ code: 'local_cli_install_timeout' });
      await vi.waitFor(() => {
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      }, { timeout: 1_000 });
    } finally {
      vi.useRealTimers();
      if (!grandchildPid && fs.existsSync(pidFile)) grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already terminated */ } }
      try { parent?.kill('SIGKILL'); } catch { /* already terminated */ }
      await pending;
      vi.mocked(spawn).mockReset().mockImplementation(() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child as any;
      });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('refuses to open authorization when the governed local package is absent', async () => {
    const entry = findCatalogEntry('wecom');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-missing', 'wecom');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    interactiveMocks.start.mockClear();

    await expect(authorizeLocalCli('account-missing', entry!)).rejects.toMatchObject({
      code: 'local_cli_install_required',
    });
    expect(interactiveMocks.start).not.toHaveBeenCalled();
  });

  it('verifies the registry integrity before trusting an official package marker', () => {
    const helper = require('../../../../bin/local-cli-auth.cjs') as {
      MANIFESTS: Record<string, { package: string; integrity: string }>;
      verifyRegistryIntegrity: (
        node: string,
        npxCli: string,
        manifest: { package: string; integrity: string },
        env: NodeJS.ProcessEnv,
        runner: ReturnType<typeof vi.fn>,
      ) => void;
      writeIntegrityMarker: (
        manifest: { package: string; integrity: string },
        env: NodeJS.ProcessEnv,
      ) => void;
    };
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-integrity-'));
    const npxCli = path.join(runtimeDir, 'npx-cli.js');
    fs.writeFileSync(npxCli, '');
    fs.writeFileSync(path.join(runtimeDir, 'npm-cli.js'), '');
    const marker = path.join(runtimeDir, '.orkas-cli-integrity.json');
    const manifest = helper.MANIFESTS.wecom;
    const workDir = path.join(runtimeDir, 'work');
    fs.mkdirSync(workDir);
    const env = {
      ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
      ORKAS_LOCAL_CLI_WORK_DIR: workDir,
      ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
    };
    const runner = vi.fn(() => ({
      status: 0, stdout: JSON.stringify(manifest.integrity), stderr: '', error: undefined,
    }));
    try {
      helper.verifyRegistryIntegrity('/runtime/node', npxCli, manifest, env, runner);
      expect(runner).toHaveBeenCalledWith(
        '/runtime/node',
        [path.join(runtimeDir, 'npm-cli.js'), 'view', manifest.package, 'dist.integrity', '--json'],
        expect.objectContaining({ cwd: workDir, windowsHide: true }),
      );
      helper.writeIntegrityMarker(manifest, env);
      expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({
        package: manifest.package,
        integrity: manifest.integrity,
      });

      const tampered = vi.fn(() => ({
        status: 0, stdout: JSON.stringify('sha512-tampered'), stderr: '', error: undefined,
      }));
      expect(() => helper.verifyRegistryIntegrity('/runtime/node', npxCli, manifest, env, tampered))
        .toThrow(/does not match/);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('keeps the event loop responsive while awaiting provider logout before local cleanup', async () => {
    const entry = findCatalogEntry('wecom')!;
    const runtimeDir = seedInstalled('account-responsive', entry);
    const realProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const args = ['-e', 'setTimeout(() => {}, 100)'];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    vi.mocked(spawnSync).mockImplementationOnce(() => realProcess.spawnSync(process.execPath, args, { env }));
    vi.mocked(spawn).mockImplementationOnce(() => realProcess.spawn(process.execPath, args, { env }));
    let heartbeat = false;
    let retainedDuringLogout = false;
    const timer = setTimeout(() => {
      heartbeat = true;
      retainedDuringLogout = fs.existsSync(runtimeDir);
    }, 0);
    try {
      await removeLocalCliAuthorization('account-responsive', entry);
      expect(heartbeat).toBe(true);
      expect(retainedDuringLogout).toBe(true);
      expect(fs.existsSync(runtimeDir)).toBe(false);
    } finally {
      clearTimeout(timer);
      vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' } as any);
      vi.mocked(spawn).mockReset().mockImplementation(() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child as any;
      });
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('logs out through shell-free pinned argv and removes only the connector-owned directory', async () => {
    const entry = findCatalogEntry('wecom');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-a', 'wecom');
    seedInstalled('account-a', entry!);
    fs.writeFileSync(path.join(runtimeDir, 'credential-marker'), 'device-local');
    const mockedSpawn = vi.mocked(spawn);
    mockedSpawn.mockClear();

    await removeLocalCliAuthorization('account-a', entry!);

    expect(mockedSpawn).toHaveBeenCalledWith(
      '/opt/orkas/runtime/node',
      [
        '/opt/orkas/runtime/lib/node_modules/npm/bin/npx-cli.js',
        '--offline',
        '-y',
        '@wecom/cli@1.2.0',
        'auth',
        'logout',
      ],
      expect.objectContaining({
        cwd: runtimeDir,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      }),
    );
    expect(fs.existsSync(runtimeDir)).toBe(false);
    expect(fs.existsSync(path.dirname(runtimeDir))).toBe(true);
  });

  it('removes only the deterministic Xero profile after official logout', async () => {
    const entry = findCatalogEntry('xero');
    expect(entry).toBeTruthy();
    const runtimeDir = localCliRuntimeDir('account-a', 'xero');
    seedInstalled('account-a', entry!);
    const mockedSpawn = vi.mocked(spawn);
    mockedSpawn.mockClear();

    await removeLocalCliAuthorization('account-a', entry!);

    const prefix = [
      '/opt/orkas/runtime/lib/node_modules/npm/bin/npx-cli.js',
      '--offline',
      '-y',
      '@xeroapi/xero-command-line@0.0.7',
    ];
    const profile = localCliProfileName('account-a', 'xero');
    expect(mockedSpawn).toHaveBeenNthCalledWith(
      1, '/opt/orkas/runtime/node', [...prefix, 'logout', '--profile', profile],
      expect.objectContaining({ cwd: runtimeDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
    );
    expect(mockedSpawn).toHaveBeenNthCalledWith(
      2, '/opt/orkas/runtime/node', [...prefix, 'profile', 'remove', profile],
      expect.objectContaining({ cwd: runtimeDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }),
    );
    expect(fs.existsSync(runtimeDir)).toBe(false);
  });

  it.each(['nonzero exit', 'spawn error'])('keeps exact local cleanup authoritative after a logout %s', async (failure) => {
    const entry = findCatalogEntry('wecom')!;
    const runtimeDir = seedInstalled('account-logout-failure', entry);
    const siblingDir = localCliRuntimeDir('account-logout-failure', 'dingtalk');
    fs.mkdirSync(siblingDir, { recursive: true });
    const retained = path.join(siblingDir, 'credential-marker');
    fs.writeFileSync(retained, 'sibling-credential');
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => failure === 'spawn error'
        ? child.emit('error', new Error('provider diagnostic'))
        : child.emit('close', 1));
      return child as any;
    });
    try {
      await expect(removeLocalCliAuthorization('account-logout-failure', entry)).resolves.toBeUndefined();
      expect(fs.existsSync(runtimeDir)).toBe(false);
      expect(fs.readFileSync(retained, 'utf8')).toBe('sibling-credential');
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });
});
