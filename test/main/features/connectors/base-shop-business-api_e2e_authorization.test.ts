import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url), codec = require('../../../../bin/local-api-credential-codec.cjs');

// Real MCP + encrypted rotating credential owner; only merchant HTTP is replaced.
// A persisted provider journal/state independently detects duplicate edits or lost authorization.
it('discovers full BASE contracts, refreshes once, edits variants and deletes through distinct risk lanes across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-base-native-'));
  const file = path.join(dir, 'credentials.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(dir, 'provider.cjs'), journal = path.join(dir, 'journal.jsonl'), state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ deleted: false, title: 'Original' }));
  codec.writeCredentialFile(file, key, { provider: 'base_shop', client_id: 'fixture-client', client_secret: 'fixture-secret', access_token: 'old-token', refresh_token: 'old-refresh', expires_at: 0, identity: { shop_id: 'fixture-shop', app_fingerprint: crypto.createHash('sha256').update('fixture-client').digest('hex') } });
  fs.writeFileSync(preload, `
    const fs=require('node:fs');const record=x=>fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify(x)+'\\n');
    const reply=x=>new Response(JSON.stringify(x));
    global.fetch=async(url,init)=>{
      const parsed=new URL(url),route=parsed.pathname,body=new URLSearchParams(init.body||'');
      if(parsed.origin!=='https://api.thebase.in')throw new Error('Wrong authority');
      if(route==='/1/oauth/token'){
        if(body.get('refresh_token')!=='old-refresh')throw new Error('Unexpected token replay');record({op:'refresh'});
        return reply({access_token:'new-token',refresh_token:'new-refresh',expires_in:86400});
      }
      if(init.headers.authorization!=='Bearer new-token')throw new Error('Old authorization');
      if(route==='/1/users/me')return reply({user:{shop_id:'fixture-shop',shop_name:'Merchant'}});
      const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));
      if(route==='/1/items/search')return reply({items:state.deleted?[]:[{item_id:1,title:state.title}]});
      if(route==='/1/items/edit'){
        if(body.get('variation_id[0]')!=='11'||body.get('variation_id[1]')!==''||body.get('variation_stock[1]')!=='0')throw new Error('Lost variant data');
        state.title=body.get('title');fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));record({op:'edit'});
        return reply({item:{item_id:1,title:state.title,variations:[{variation_id:11,variation:'Black',variation_stock:2},{variation_id:12,variation:'White',variation_stock:0}]}});
      }
      if(route==='/1/items/delete'){state.deleted=true;fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));record({op:'delete'});return reply({result:true});}
      if(route==='/1/orders/detail/ORDER_A')return reply({order:{unique_key:'ORDER_A',mail_address:'buyer@example.test',order_receiver:{address:'Tokyo'},payment:'creditcard'}});
      throw new Error('Unexpected route');
    };
  `);
  const clients: Client[] = [], stderr: string[] = [];
  const connect = async () => {
    const client = new Client({ name: 'base-shop-native-journey', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((r): r is [string, string] => typeof r[1] === 'string')), ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'base_shop', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: '{}', FIXTURE_JOURNAL: journal, FIXTURE_STATE: state } });
    transport.stderr?.on('data', data => stderr.push(String(data))); await client.connect(transport); return client;
  };
  const content = (result: any) => JSON.parse(result.content[0].text);
  try {
    const client = await connect(); expect((await client.listTools()).tools).toHaveLength(6);
    const catalog = content(await client.callTool({ name: 'list_capabilities', arguments: {} })); expect(catalog.actions).toHaveLength(27);
    expect(catalog.actions.some((a: any) => a.action === 'base.items.search')).toBe(true); expect(catalog.actions.some((a: any) => a.action === 'base.search')).toBe(false);
    const description = content(await client.callTool({ name: 'describe_action', arguments: { action: 'base.items.edit' } })); expect(description.input_schema.properties).toHaveProperty('barcode');
    const parameters = { item_id: 1, title: 'Updated', variation_id: [11, ''], variation: ['Black', 'White'], variation_stock: [2, 0] };
    const denied = await client.callTool({ name: 'execute_read', arguments: { action: 'base.items.edit', parameters } }); expect(denied.isError).toBe(true);
    const edit = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'base.items.edit', parameters } }); expect(edit.isError).not.toBe(true); expect(content(edit).result.data.item.title).toBe('Updated');
    const read = await client.callTool({ name: 'execute_read', arguments: { action: 'base.items.search', parameters: { q: 'Updated', limit: 10 } } }); expect(content(read).result.data.items[0].title).toBe('Updated');
    const wrongLane = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'base.items.delete', parameters: { item_id: 1 } } }); expect(wrongLane.isError).toBe(true);
    const deletion = await client.callTool({ name: 'execute_destructive', arguments: { action: 'base.items.delete', parameters: { item_id: 1 } } }); expect(deletion.isError).not.toBe(true);
    await client.close(); const resumed = await connect();
    const final = await resumed.callTool({ name: 'execute_read', arguments: { action: 'base.items.search', parameters: { q: 'Updated' } } }); expect(content(final).result.data.items).toEqual([]);
    const nativeOrder = await resumed.callTool({ name: 'execute_read', arguments: { action: 'base.orders.detail', parameters: { unique_key: 'ORDER_A' } } }); expect(content(nativeOrder).result.data.order.mail_address).toBe('buyer@example.test');
    const legacyOrder = await resumed.callTool({ name: 'execute_read', arguments: { action: 'orders.get', parameters: { unique_key: 'ORDER_A' } } }); expect(content(legacyOrder).result.data.order).not.toHaveProperty('mail_address');
    expect(codec.readCredentialFile(file, key).refresh_token).toBe('new-refresh'); expect(fs.readFileSync(file, 'utf8')).not.toContain('new-refresh');
    expect(fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line).op)).toEqual(['refresh', 'edit', 'delete']); expect(stderr).toEqual([]);
    expect(JSON.stringify([catalog, description, edit, nativeOrder])).not.toContain('new-token');
  } finally { await Promise.allSettled(clients.map(client => client.close())); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20000);
