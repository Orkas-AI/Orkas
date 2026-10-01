import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const codec = require('../../../../bin/local-api-credential-codec.cjs');

it('recovers a rotating grant after closing the real MCP child during identity verification', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-rotation-shutdown-'));
  const file = path.join(directory, 'credentials.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(directory, 'provider-fixture.cjs'), marker = path.join(directory, 'identity-started');
  const counter = path.join(directory, 'refresh-count');
  codec.writeCredentialFile(file, key, { provider: 'kuaishou_shop', app_key: 'fixture-app', app_secret: 'fixture-secret',
    sign_secret: 'fixture-sign-secret', access_token: 'previous-access', refresh_token: 'previous-refresh', expires_at: 0,
    scope: 'user_base user_info merchant_user merchant_item merchant_order merchant_refund merchant_logistics',
    identity: { open_id: 'fixture-seller', shop_id: '123' } });
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    global.fetch = async raw => {
      const url = new URL(String(raw));
      if (url.pathname.endsWith('/refresh_token')) {
        const count = fs.existsSync(process.env.FIXTURE_COUNTER) ? Number(fs.readFileSync(process.env.FIXTURE_COUNTER, 'utf8')) : 0;
        fs.writeFileSync(process.env.FIXTURE_COUNTER, String(count + 1));
        return new Response(JSON.stringify({ result: 1, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh',
          expires_in: 7200, scopes: 'user_base user_info merchant_user merchant_item merchant_order merchant_refund merchant_logistics' } }));
      }
      if (process.env.FIXTURE_RECOVERY !== '1') {
        fs.writeFileSync(process.env.FIXTURE_MARKER, 'started');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      return new Response(JSON.stringify({ result: 1, data: { openId: 'fixture-seller', sellerId: 123, shopName: 'Fixture shop', shopType: 5 } }));
    };
  `);
  const children: Client[] = [];
  const stderr: string[] = [];
  async function connect(recovery: boolean) {
    const client = new Client({ name: 'rotation-recovery-fixture', version: '1' });
    children.push(client);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe',
      env: { ...Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => typeof row[1] === 'string')),
        ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'kuaishou_shop', ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
        ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: '{}', FIXTURE_COUNTER: counter,
        FIXTURE_MARKER: marker, FIXTURE_RECOVERY: recovery ? '1' : '0' } });
    transport.stderr?.on('data', data => stderr.push(String(data)));
    await client.connect(transport);
    return client;
  }
  try {
    const client = await connect(false);
    const pending = client.callTool({ name: 'execute_read', arguments: { action: 'products.list' } }).catch(error => error);
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 5000 });
    expect(codec.readCredentialFile(file, key).refresh_token).toBe('previous-refresh');
    expect(fs.existsSync(`${file}.rotation`)).toBe(true);
    await client.close();
    await pending;
    const restarted = await connect(true);
    const result = await restarted.callTool({ name: 'execute_read', arguments: { action: 'products.list' } });
    expect(result.isError).not.toBe(true);
    expect(codec.readCredentialFile(file, key).refresh_token).toBe('rotated-refresh');
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
    expect(fs.existsSync(`${file}.rotation`)).toBe(false);
    expect(stderr).toEqual([]);
  } finally {
    await Promise.allSettled(children.map(client => client.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
