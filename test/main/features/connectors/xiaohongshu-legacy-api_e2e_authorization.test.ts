import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url), codec = require('../../../../bin/local-api-credential-codec.cjs');

it('preserves legacy merchant authorization and exposes full orders and partial transfers through real MCP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xhs-journey-'));
  const file = path.join(dir, 'grant.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(dir, 'provider.cjs'), journal = path.join(dir, 'wire.jsonl');
  const grant = { provider: 'xiaohongshu_ark', app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { app_key_fingerprint: crypto.createHash('sha256').update('fixture-app').digest('hex').slice(0, 16) } };
  codec.writeCredentialFile(file, key, grant);
  fs.writeFileSync(preload, `
const fs=require('node:fs'),crypto=require('node:crypto');global.fetch=async(raw,init)=>{
const u=new URL(raw),h=init.headers;if(u.origin!=='https://ark.xiaohongshu.com'||h['app-key']!=='fixture-app'||u.pathname.includes('common_controller'))throw Error('Wrong merchant authority');
const q={...Object.fromEntries(u.searchParams),'app-key':h['app-key'],timestamp:h.timestamp};const sign=crypto.createHash('md5').update(u.pathname+'?'+Object.keys(q).sort().map(k=>k+'='+q[k]).join('&')+'fixture-secret').digest('hex');if(sign!==h.sign)throw Error('Wrong signature');
fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:u.pathname,method:init.method})+'\\n');let data;
if(u.pathname==='/ark/open_api/v1/items/lite')data={hits:[]};
else if(u.pathname==='/ark/open_api/v0/packages/P1')data={package_id:'P1',receiver_name:'Buyer',receiver_phone:'138****1234',receiver_address:'Approved address',id_number:'310100000000000001'};
else if(u.pathname==='/ark/open_api/v0/packages/transfer_batches'&&init.method==='POST'){const p=JSON.parse(init.body);if(p.packages.length!==2||p.packages[1].package_id!=='P2')throw Error('Wrong submitted packages');data={total:2,success_count:1,batch:'TPS100',error_msgs:{P2:'private diagnostic'}};}
else throw Error('Unexpected request');return new Response(JSON.stringify({success:true,error_code:0,data}));};`);
  const clients: Client[] = [], stderr: string[] = [];
  async function connect() {
    const c = new Client({ name: 'xhs-journey', version: '1' }); clients.push(c);
    const t = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((r): r is [string, string] => typeof r[1] === 'string')), ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'xiaohongshu_ark', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: '{}', FIXTURE_JOURNAL: journal } });
    t.stderr?.on('data', d => stderr.push(String(d))); await c.connect(t); return c;
  }
  const parsed = (r: any) => JSON.parse(r.content[0].text);
  try {
    const c = await connect(); expect((await c.listTools()).tools).toHaveLength(6);
    const schema = parsed(await c.callTool({ name: 'describe_action', arguments: { action: 'orders.list_latest' } }));
    expect(schema.input_schema.properties.query.required).toEqual(['order_time_from', 'order_time_to']);
    expect((await c.callTool({ name: 'execute_read', arguments: { action: 'orders.list_latest', parameters: {} } })).isError).toBe(true);
    expect((await c.callTool({ name: 'execute_read', arguments: { action: 'orders.export', parameters: { package_id: 'P1' } } })).isError).toBe(true);
    const order = await c.callTool({ name: 'execute_high_impact', arguments: { action: 'orders.export', parameters: { package_id: 'P1' } } });
    expect(order.isError).not.toBe(true);
    expect(parsed(order).result).toMatchObject({ receiver_name: 'Buyer', receiver_phone: '138****1234', receiver_address: 'Approved address', id_number: '310100000000000001' });
    const partial = await c.callTool({ name: 'execute_high_impact', arguments: { action: 'transfer_batches.create', parameters: { packages: [{ package_id: 'P1', weight: 1 }, { package_id: 'P2', weight: 2 }] } } });
    expect(partial.isError).toBe(true); expect(parsed(partial).result.status).toBe('partial_or_failed');
    expect(parsed(partial).result.data.error_msgs).toEqual({ P2: '[provider diagnostic omitted]' });
    expect(JSON.stringify(partial)).not.toContain('private diagnostic');
    await c.close(); const restarted = await connect();
    expect((await restarted.callTool({ name: 'execute_read', arguments: { action: 'products.list_lite', parameters: {} } })).isError).not.toBe(true);
    const wire = fs.readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(wire.filter(r => r.path.endsWith('/transfer_batches'))).toHaveLength(1);
    expect(wire.filter(r => r.path.endsWith('/packages/P1'))).toHaveLength(1);
    expect(codec.readCredentialFile(file, key)).toEqual(grant); expect(stderr).toEqual([]);
  } finally { await Promise.allSettled(clients.map(c => c.close())); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20000);
