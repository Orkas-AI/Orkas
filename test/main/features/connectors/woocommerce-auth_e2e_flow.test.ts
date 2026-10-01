import { createRequire } from 'node:module';
import { publicEncrypt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: browser.open } }));
vi.mock('../../../../src/main/features/account/server', () => ({ accountApiBase: () => 'https://orkas.test/api' }));
vi.mock('../../../../src/main/features/account/token_store', () => ({ getDeviceId: () => 'test-device' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (h: unknown) => h }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({
  encryptLocalSecret: (_ctx: unknown, value: string) => `TEST:${value}`,
  decryptLocalSecret: (_ctx: unknown, value: string) => value.slice(5),
}));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, localApiRuntimeDir, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl } from '../../../../src/main/features/connectors/oauth-dcr';

const require = createRequire(import.meta.url);
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const uid = 'woo-auth-flow-tests';
const entry = findCatalogEntry('woocommerce')!;
const store = 'https://shop.example.com/wordpress';
const ticket = 't'.repeat(43);
const credentials = { consumer_key: `ck_${'a'.repeat(40)}`, consumer_secret: `cs_${'b'.repeat(40)}` };
let registration: { state: string; public_key: string };
let ciphertext: string;
let fetchMock: ReturnType<typeof vi.fn>;

function stored() {
  const dir = localApiRuntimeDir(uid, entry.id);
  const key = fs.readFileSync(path.join(dir, 'credential-key.enc'), 'utf8').trim().slice(5);
  return codec.readCredentialFile(path.join(dir, 'credentials.enc'), key);
}
function ciphertextFor(state = registration.state) {
  return publicEncrypt({ key: registration.public_key, oaepHash: 'sha256', oaepLabel: Buffer.from(state) },
    Buffer.from(JSON.stringify(credentials))).toString('base64');
}
async function consent() {
  await vi.waitFor(() => expect(browser.open).toHaveBeenCalledOnce());
  const url = new URL(browser.open.mock.calls[0][0]);
  expect(url.origin + url.pathname).toBe(`${store}/wc-auth/v1/authorize`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    app_name: 'Orkas', scope: 'read_write', user_id: ticket,
    callback_url: 'https://orkas.ai/api/connectors/woocommerce/auth/callback',
    return_url: 'https://orkas.ai/api/connectors/woocommerce/auth/return?lang=en',
  });
  expect(url.href).not.toContain(credentials.consumer_key);
}
async function callback() {
  await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?status=success&exchange_code=one-time-code');
}

beforeEach(() => {
  browser.open.mockClear();
  ciphertext = '';
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/woocommerce/auth/start')) {
      registration = JSON.parse(String(init.body));
      return Response.json({ code: 0, ticket });
    }
    if (url.endsWith('/oauth/dcr-exchange')) {
      return Response.json({ code: 0, oauth_state: registration.state, oauth_code: ciphertext || ciphertextFor() });
    }
    expect(url).toBe(`${store}/wp-json/wc/v3/system_status`);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${credentials.consumer_key}:${credentials.consumer_secret}`).toString('base64')}`);
    return Response.json({ environment: { site_url: store, version: '10.0.0' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cancelDcrOAuth();
  removeLocalApiAuthorization(uid, entry);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WooCommerce owner authorization to encrypted local connection', () => {
  it('accepts only a store URL, verifies returned keys at that store, and saves no plaintext', async () => {
    const pending = authorizeLocalApi(uid, entry, { store_url: store });
    await consent();
    expect(fs.existsSync(path.join(localApiRuntimeDir(uid, entry.id), 'credentials.enc'))).toBe(false);
    await callback();
    await expect(pending).resolves.toEqual({ store_url: store });
    expect(stored()).toEqual({ provider: 'woocommerce', ...credentials });
    const file = fs.readFileSync(path.join(localApiRuntimeDir(uid, entry.id), 'credentials.enc'), 'utf8');
    expect(file).not.toContain(credentials.consumer_key);
    expect(file).not.toContain(credentials.consumer_secret);
    const count = fetchMock.mock.calls.length;
    await callback();
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it.each(['wrong-state', 'store-denied', 'invalid-store-response'])('keeps existing credentials after %s', async failure => {
    const old = { consumer_key: `ck_${'c'.repeat(40)}`, consumer_secret: `cs_${'d'.repeat(40)}` };
    await authorizeLocalApi(uid, entry, { store_url: store, ...old });
    const pending = authorizeLocalApi(uid, entry, { store_url: store });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'local_api_authorization_failed' });
    await consent();
    if (failure === 'wrong-state') ciphertext = ciphertextFor('other-state');
    else {
      const upstream = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) => url.endsWith('/system_status')
        ? failure === 'store-denied' ? new Response('Denied', { status: 401 }) : Response.json({ ok: true })
        : upstream(url, init));
    }
    await callback();
    await rejected;
    expect(stored()).toEqual({ provider: 'woocommerce', ...old });
    if (failure === 'wrong-state') expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/system_status'))).toBe(false);
  });

  it('cancels while preparing authorization without opening a late browser or saving keys', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementation(async () => new Promise<Response>(resolve => { release = resolve; }));
    const pending = authorizeLocalApi(uid, entry, { store_url: store });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    cancelDcrOAuth();
    release(Response.json({ code: 0, ticket }));
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    expect(browser.open).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(localApiRuntimeDir(uid, entry.id), 'credentials.enc'))).toBe(false);
  });

  it('does not save a late store response after the user cancels verification', async () => {
    let release!: (response: Response) => void;
    const upstream = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => url.endsWith('/system_status')
      ? new Promise<Response>(resolve => { release = resolve; }) : upstream(url, init));
    const pending = authorizeLocalApi(uid, entry, { store_url: store });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'user_cancelled' });
    await consent();
    const returning = callback();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    cancelDcrOAuth();
    release(Response.json({ environment: { site_url: store, version: '10.0.0' } }));
    await returning;
    await rejected;
    expect(fs.existsSync(path.join(localApiRuntimeDir(uid, entry.id), 'credentials.enc'))).toBe(false);
  });
});
