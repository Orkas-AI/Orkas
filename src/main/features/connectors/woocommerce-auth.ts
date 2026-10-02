/** WooCommerce application-auth endpoint; the desktop alone can decrypt relay keys. */
import { generateKeyPair, privateDecrypt, type KeyObject } from 'node:crypto';
import { fetchAndReadWithTimeout, throwIfAborted } from '../../util/abort';
import { withCommonHeaders } from '../api_common';
import { startLocalApiBrowserOAuth } from './oauth-dcr';
import { LOCAL_API_REDIRECT_URI } from './oauth-redirect';

const RELAY_BASE = new URL('../woocommerce/auth/', LOCAL_API_REDIRECT_URI).href;

async function readJson(url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
  const { body } = await fetchAndReadWithTimeout(url, { ...init, redirect: 'error' }, 60_000, signal,
    'Authorization request timed out; connect again', async response => {
      if (!response.ok) throw new Error('Could not verify the store connection');
      // Keep both the timeout and body bound active while reading a shop response.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Could not verify the store connection');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error('Could not verify the store connection');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Could not verify the store connection');
      return value;
    });
  throwIfAborted(signal);
  return body;
}

export function authorizeWooCommerce(
  catalogId: string, storeUrl: string, opts: { attemptId?: string },
): Promise<Record<string, unknown>> {
  let privateKey: KeyObject;
  let expectedState: string;
  return startLocalApiBrowserOAuth(catalogId, async (state, _redirect, signal) => {
    expectedState = state;
    const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
      generateKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey, key) => {
        if (error) reject(error); else resolve({ publicKey, privateKey: key });
      });
    });
    throwIfAborted(signal);
    privateKey = pair.privateKey;
    const result = await readJson(`${RELAY_BASE}start`, {
      method: 'POST', headers: withCommonHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ state, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) }),
    }, signal);
    if (result.code !== 0 || typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket)) {
      throw new Error('Could not start store authorization; connect again');
    }
    const url = new URL(`${storeUrl}/wc-auth/v1/authorize`);
    url.search = new URLSearchParams({
      app_name: 'Orkas', scope: 'read_write', user_id: result.ticket,
      callback_url: `${RELAY_BASE}callback`, return_url: `${RELAY_BASE}return?lang=${encodeURIComponent(state.split('_')[1])}`,
    }).toString();
    return url.href;
  }, async (encrypted, signal) => {
    throwIfAborted(signal);
    if (!privateKey || !/^[A-Za-z0-9+/]{342}==$/.test(encrypted)) throw new Error('Invalid store authorization');
    const credentials = JSON.parse(privateDecrypt({
      key: privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from(expectedState),
    }, Buffer.from(encrypted, 'base64')).toString('utf8'));
    if (!/^ck_[a-fA-F0-9]{40}$/.test(credentials?.consumer_key || '')
        || !/^cs_[a-fA-F0-9]{40}$/.test(credentials?.consumer_secret || '')) throw new Error('Invalid store authorization');
    const { consumer_key, consumer_secret } = credentials;
    const status = await readJson(`${storeUrl}/wp-json/wc/v3/system_status`, {
      headers: { accept: 'application/json', authorization: `Basic ${Buffer.from(`${consumer_key}:${consumer_secret}`).toString('base64')}` },
    }, signal);
    const environment = status.environment as Record<string, unknown> | undefined;
    if (typeof environment?.site_url !== 'string' || typeof environment?.version !== 'string') {
      throw new Error('Could not verify the store connection');
    }
    return { consumer_key, consumer_secret };
  }, opts);
}
