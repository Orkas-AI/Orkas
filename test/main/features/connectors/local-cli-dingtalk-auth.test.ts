import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const auth = require('../../../../bin/local-cli-auth.cjs');
const permissions = require('../../../../bin/local-cli-permissions.cjs');
const fixture = require('./fixtures/dingtalk-cli-1.0.61.json');
let root: string;
let env: Record<string, string>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dws-partial-auth-'));
  env = { ORKAS_LOCAL_CLI_PROVIDER: 'dingtalk', ORKAS_LOCAL_CLI_RUNTIME_DIR: root,
    ORKAS_LOCAL_CLI_PROFILE: 'partial-auth' };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function failure(payload: unknown = fixture.batch_product_not_found, exitCode = 1) {
  return Object.assign(new Error('synthetic official CLI failure'), {
    exitCode, stderr: JSON.stringify(payload), stdout: '',
  });
}
function executeWith(error: Error) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'auth') return undefined;
    throw error;
  });
}
function authorize(execute: ReturnType<typeof vi.fn>, ready = vi.fn(() => true)) {
  return auth.authorizeDingtalk('', '', auth.MANIFESTS.dingtalk, env,
    { execute, authorizationReady: ready });
}

it('connects a verified identity despite unsupported PAT products, preserving the gap across reconnects', async () => {
  expect(fixture.integrity).toBe(auth.MANIFESTS.dingtalk.integrity);
  for (let attempt = 0; attempt < 2; attempt++) {
    const execute = executeWith(failure());
    await expect(authorize(execute)).resolves.toBeUndefined();
    expect(permissions.readPermissionRequest(env)).toMatchObject({
      reauthorize: true, plan_missing: true, scopes: [], pat_scopes: [],
    });
    // Keep the reviewed domain policy; do not copy the test organization's 18-domain set.
    expect(execute.mock.calls).toEqual([
      [['auth', 'login', '--device', '--no-browser']],
      [['pat', 'chmod', '--domains', auth.MANIFESTS.dingtalk.domains.join(','),
        '--grant-type', 'permanent', '--yes', '--format', 'json'], 'tee'],
    ]);
    expect(fs.readFileSync(path.join(root, '.orkas-user-permissions.json'), 'utf8'))
      .not.toContain('synthetic unsupported batch product');
  }
});

it.each([
  ['missing receipt', Object.assign(failure(), { stderr: '' })],
  ['network failure', failure({ error: { ...fixture.batch_product_not_found.error, server_error_code: 'NETWORK_ERROR' } })],
  ['cancelled process', failure(fixture.batch_product_not_found, 130)],
  ['unknown process status', Object.assign(failure(), { exitCode: undefined })],
  ['wrong owner', failure({ error: { ...fixture.batch_product_not_found.error, server_key: 'chat' } })],
  ['wrong category', failure({ error: { ...fixture.batch_product_not_found.error, category: 'auth' } })],
  ['message look-alike', failure({ error: { code: 1, category: 'api', message: 'PAT_BATCH_PRODUCT_NOT_FOUND' } })],
  ['nested user data', failure({ data: fixture.batch_product_not_found })],
  ['wrong type', failure({ error: { ...fixture.batch_product_not_found.error, code: '1' } })],
  ['contradictory success', failure({ ...fixture.batch_product_not_found, success: true })],
  ['signalled process', Object.assign(failure(), { signal: 'SIGTERM' })],
  ['oversized diagnostic', failure({ error: { ...fixture.batch_product_not_found.error, message: 'x'.repeat(65536) } })],
])('rejects %s without inventing permission gaps or completing authorization', async (_name, error) => {
  const execute = executeWith(error as Error);
  await expect(authorize(execute)).rejects.toBe(error);
  expect(permissions.readPermissionRequest(env)).toBeNull();
  expect(execute.mock.calls.filter(([args]) => args[0] === 'pat')).toHaveLength(1);
});

it('does not accept a product-gap receipt after identity verification becomes unavailable', async () => {
  const ready = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(authorize(executeWith(failure()), ready)).rejects.toThrow('verified identity');
  expect(permissions.readPermissionRequest(env)?.plan_missing).toBe(true);
});

it('does not complete partial authorization when its permission gap cannot be persisted', async () => {
  const ledger = path.join(root, '.orkas-user-permissions.json');
  fs.mkdirSync(ledger);
  const error = failure();
  await expect(authorize(executeWith(error))).rejects.toBe(error);
  expect(fs.statSync(ledger).isDirectory()).toBe(true);
});

it.each(['user', 'pat'])('preserves an outstanding %s scope instead of reporting that reauthorization fixed it', async identity => {
  permissions.rememberPermissionRequest({ code: 'connector_permission_denied', provider_error: {
    identity, missing_scopes: [identity === 'user' ? 'Contact.User.Read' : 'chat.message:send'],
  } }, env);
  const before = permissions.readPermissionRequest(env);
  const error = failure();
  await expect(authorize(executeWith(error))).rejects.toBe(error);
  expect(permissions.readPermissionRequest(env)).toMatchObject({
    scopes: before.scopes, pat_scopes: before.pat_scopes || [], plan_missing: true,
  });
});

it('retains a newer denial arriving during the batch request instead of calling recovery complete', async () => {
  const error = failure();
  const execute = vi.fn(async (args: string[]) => {
    if (args[0] === 'auth') return;
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied', provider_error: {
      identity: 'pat', missing_scopes: ['mail:send'],
    } }, env);
    throw error;
  });
  await expect(authorize(execute)).rejects.toBe(error);
  expect(permissions.readPermissionRequest(env)).toMatchObject({ pat_scopes: ['mail:send'], plan_missing: true });
});

it('preserves a denial recorded during the final identity check', async () => {
  const error = failure();
  const ready = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => {
    permissions.rememberPermissionRequest({ code: 'connector_permission_denied', provider_error: {
      identity: 'pat', missing_scopes: ['mail:send'],
    } }, env);
    return true;
  });
  await expect(authorize(executeWith(error), ready)).rejects.toBe(error);
  expect(permissions.readPermissionRequest(env)).toMatchObject({ pat_scopes: ['mail:send'], plan_missing: true });
});
