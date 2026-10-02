import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url), codec = require('../../../../bin/local-api-credential-codec.cjs');

// The real MCP process owns credentials, product visibility and approval lanes.
// Only Reloadly HTTP is replaced; the journal catches duplicate wallet spending.
it('discovers product-specific contracts, pays once through the high-impact lane and reconciles after child restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reloadly-journey-'));
  const file = path.join(dir, 'credentials.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(dir, 'provider.cjs'), journal = path.join(dir, 'journal.txt');
  codec.writeCredentialFile(file, key, { provider: 'reloadly', client_id: 'fixture-client', client_secret: 'fixture-secret' });
  fs.writeFileSync(preload, `
    const fs=require('node:fs');
    const record=value=>fs.appendFileSync(process.env.FIXTURE_JOURNAL,value+'\\n');
    global.fetch=async(url,init)=>{
      if(url==='https://auth.reloadly.com/oauth/token'){
        const body=JSON.parse(init.body);if(body.audience!=='https://giftcards-sandbox.reloadly.com')throw new Error('Wrong audience');
        record('token');return new Response(JSON.stringify({access_token:'fixture-token',expires_in:86400}));
      }
      if(!url.startsWith('https://giftcards-sandbox.reloadly.com/')||init.headers.authorization!=='Bearer fixture-token')throw new Error('Wrong authority');
      const route=new URL(url).pathname;
      if(route==='/accounts/balance'){record('balance');return new Response(JSON.stringify({balance:100,currencyCode:'USD'}));}
      if(route==='/products'){record('products');return new Response(JSON.stringify({content:[{productId:10,productName:'Global game credit'}],totalElements:1}));}
      if(route==='/orders'){
        const body=JSON.parse(init.body);
        if(body.unitPrice!==5.5||body.productAdditionalRequirements.userId!=='player-9'||body.countryCode!==undefined)throw new Error('Incomplete current purchase');
        record('purchase');return new Response(JSON.stringify({transactionId:3116,status:'SUCCESSFUL',customIdentifier:body.customIdentifier}));
      }
      if(route==='/reports/transactions/3116'){record('reconcile');return new Response(JSON.stringify({transactionId:3116,status:'SUCCESSFUL',customIdentifier:'order-001'}));}
      if(route==='/orders/transactions/3116/cards'){record('redeem');return new Response(JSON.stringify({cardNumber:'000123',pinCode:'BUSINESS-PIN',redemptionUrl:'https://gift.example/redeem'}));}
      throw new Error('Unexpected route');
    };
  `);
  const clients: Client[] = [], stderr: string[] = [];
  const connect = async () => {
    const client = new Client({ name: 'reloadly-contract-journey', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((r): r is [string, string] => typeof r[1] === 'string')), ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'reloadly', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ product: 'giftcards', environment: 'sandbox' }), FIXTURE_JOURNAL: journal } });
    transport.stderr?.on('data', data => stderr.push(String(data))); await client.connect(transport); return client;
  };
  const content = (result: any) => JSON.parse(result.content[0].text);
  try {
    const client = await connect(); expect((await client.listTools()).tools).toHaveLength(6);
    const catalog = content(await client.callTool({ name: 'list_capabilities', arguments: {} }));
    expect(catalog.actions.some((row: any) => row.action === 'giftcards.order-a-gift-card')).toBe(true);
    expect(catalog.actions.some((row: any) => row.action.startsWith('airtime.'))).toBe(false);
    const description = content(await client.callTool({ name: 'describe_action', arguments: { action: 'giftcards.order-a-gift-card' } }));
    expect(description.input_schema.properties.body.properties).toHaveProperty('productAdditionalRequirements');
    const read = await client.callTool({ name: 'execute_read', arguments: { action: 'giftcards.get-all-products', parameters: { query: { global: true, page: 1, size: 5 } } } });
    expect(content(read).result.data.totalElements).toBe(1);
    const parameters = { body: { productId: 10, quantity: 1, unitPrice: 5.5, senderName: 'Merchant', customIdentifier: 'order-001', productAdditionalRequirements: { userId: 'player-9' } } };
    const denied = await client.callTool({ name: 'execute_read', arguments: { action: 'giftcards.order-a-gift-card', parameters } }); expect(denied.isError).toBe(true);
    const wrongProduct = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'airtime.number-lookup-get', parameters: { path: { phone: '0123456789', countryCode: 'US' } } } }); expect(wrongProduct.isError).toBe(true);
    const purchase = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'giftcards.order-a-gift-card', parameters } }); expect(purchase.isError).not.toBe(true); expect(content(purchase).result.status).toBe('acknowledged');
    await client.close(); const resumed = await connect();
    const reconcile = await resumed.callTool({ name: 'execute_read', arguments: { action: 'giftcards.get-transaction-by-id', parameters: { path: { transactionId: '3116' } } } }); expect(content(reconcile).result.data.transactionId).toBe(3116);
    const redeem = await resumed.callTool({ name: 'execute_high_impact', arguments: { action: 'giftcards.get-a-redeem-code', parameters: { path: { transactionId: 3116 }, redemption_version: 2 } } }); expect(content(redeem).result.data.pinCode).toBe('BUSINESS-PIN');
    expect(fs.readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['token', 'balance', 'balance', 'products', 'balance', 'purchase', 'token', 'reconcile', 'redeem']);
    expect(stderr).toEqual([]); expect(JSON.stringify([catalog, description, purchase, reconcile, redeem])).not.toContain('fixture-token');
  } finally { await Promise.allSettled(clients.map(client => client.close())); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20000);
