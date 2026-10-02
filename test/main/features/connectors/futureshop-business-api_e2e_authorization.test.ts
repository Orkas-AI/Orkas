import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url), codec = require('../../../../bin/local-api-credential-codec.cjs');

// Real child, credential file and shared 1/s limiter. Only DNS and merchant HTTP are fixtures;
// the durable merchant journal exposes duplicate spending, missing writes and restart behavior.
it('uses all futureshop contracts through the existing six tools, preserves partial outcomes and distinct destructive approval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-futureshop-native-'));
  const file = path.join(dir, 'credentials.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(dir, 'provider.cjs'), journal = path.join(dir, 'journal.jsonl'), state = path.join(dir, 'state.json');
  const origin = 'https://issued.example.com'; fs.writeFileSync(state, JSON.stringify({ member: null }));
  const credentials = { provider: 'futureshop', client_id: 'fixture-client', client_secret: 'fixture-secret', shop_key: 'fixture-shop-key', identity: { fingerprint: crypto.createHash('sha256').update(JSON.stringify([origin, 'fixture-client', 'fixture-secret', 'fixture-shop-key'])).digest('hex') } };
  codec.writeCredentialFile(file, key, credentials);
  fs.writeFileSync(preload, `
    const fs=require('node:fs');require('node:dns').promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
    const reply=x=>new Response(JSON.stringify(x));
    global.fetch=async(raw,init)=>{
      const url=new URL(raw),route=url.pathname;if(url.origin!=='https://issued.example.com'||init.headers['X-SHOP-KEY']!=='fixture-shop-key')throw Error('Wrong binding');
      fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({route,method:init.method,time:Date.now()})+'\\n');
      if(route==='/oauth/token')return reply({access_token:'fixture-token',expires_in:3600});
      if(init.headers.authorization!=='Bearer fixture-token')throw Error('Wrong authorization');
      if(route==='/admin-api/v1/products')return reply({productList:[]});
      if(route==='/admin-api/v1/adjustpoints'){
        const body=JSON.parse(init.body);if(body.expirationDateStatus!=='NOT_EXTEND'||body.pointList.length!==2)throw Error('Incomplete points request');
        return reply({status:'failed',errors:[{code:'ErrorsPresent',message:'private provider detail'}],results:[{status:'success',memberId:'9',name:'Retail',apiId:'api0000000000001'},{status:'failed',memberId:'10',name:'Retail',code:'MemberNotFound',message:'private provider detail'}]});
      }
      if(route==='/admin-api/v1/orders/ORDER1')return new Response('{"orderNo":"ORDER1","id":9007199254740993,"purchaser":{"mail":"buyer@example.test","address":"Tokyo"},"access_token":"fixture-token"}');
      const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));
      if(route==='/admin-api/v1/member'&&init.method==='POST'){
        if(init.body!==undefined||url.searchParams.get('registrationPointsEnabled')!=='NO'||url.searchParams.get('password')!=='new&password')throw Error('Wrong member encoding');
        state.member={memberId:'9',mail:url.searchParams.get('mail')};fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return reply({status:'success',memberId:'9'});
      }
      if(route==='/admin-api/v1/member/9'&&init.method==='DELETE'){state.member=null;fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return reply({status:'success'});}
      if(route==='/admin-api/v1/member'&&init.method==='GET')return reply({memberList:state.member?[state.member]:[]});
      throw Error('Unexpected provider request');
    };
  `);
  const clients: Client[] = [], stderr: string[] = [];
  const connect = async () => {
    const client = new Client({ name: 'futureshop-native-journey', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((r): r is [string, string] => typeof r[1] === 'string')), ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'futureshop', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ api_origin: origin }), FIXTURE_JOURNAL: journal, FIXTURE_STATE: state } });
    transport.stderr?.on('data', data => stderr.push(String(data))); await client.connect(transport); return client;
  };
  const parsed = (result: any) => JSON.parse(result.content[0].text);
  try {
    const client = await connect(); expect((await client.listTools()).tools).toHaveLength(6);
    const capabilities = parsed(await client.callTool({ name: 'list_capabilities', arguments: {} })); expect(capabilities.actions).toHaveLength(28);
    const description = parsed(await client.callTool({ name: 'describe_action', arguments: { action: 'futureshop.points.adjust' } })); expect(description.input_schema.properties.body.properties).toHaveProperty('expirationDateStatus');
    const parameters = { body: { expirationDateStatus: 'NOT_EXTEND', pointList: [{ memberId: '9', name: 'Retail', points: 10 }, { memberId: '10', name: 'Retail', points: 10 }] } };
    expect((await client.callTool({ name: 'execute_read', arguments: { action: 'futureshop.points.adjust', parameters } })).isError).toBe(true);
    const partial = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'futureshop.points.adjust', parameters } }); expect(partial.isError).toBe(true); expect(parsed(partial).result).toMatchObject({ status: 'partial_or_failed', results: [{ status: 'success', apiId: 'api0000000000001' }, { status: 'failed', code: 'MemberNotFound' }] }); expect(JSON.stringify(partial)).not.toContain('private provider');
    const order = await client.callTool({ name: 'execute_read', arguments: { action: 'futureshop.orders.get', parameters: { path: { orderNo: 'ORDER1' } } } }); expect(parsed(order).result.data.purchaser.mail).toBe('buyer@example.test'); expect(parsed(order).result.data.id).toBe('9007199254740993'); expect(parsed(order).result.data).not.toHaveProperty('access_token');
    const created = await client.callTool({ name: 'execute_high_impact', arguments: { action: 'futureshop.members.create', parameters: { query: { mail: 'buyer@example.test', registrationPointsEnabled: 'NO', password: 'new&password' } } } }); expect(created.isError).not.toBe(true); expect(parsed(created).result.memberId).toBe('9');
    expect((await client.callTool({ name: 'execute_high_impact', arguments: { action: 'futureshop.members.delete', parameters: { path: { memberId: '9' } } } })).isError).toBe(true);
    const deleted = await client.callTool({ name: 'execute_destructive', arguments: { action: 'futureshop.members.delete', parameters: { path: { memberId: '9' } } } }); expect(deleted.isError).not.toBe(true);
    await client.close(); const resumed = await connect();
    const after = await resumed.callTool({ name: 'execute_read', arguments: { action: 'futureshop.members.search', parameters: { query: { memberId: '9' } } } }); expect(parsed(after).result.data.memberList).toEqual([]);
    const calls = fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(x => x.route === '/admin-api/v1/adjustpoints')).toHaveLength(1); expect(calls.filter(x => x.method === 'DELETE')).toHaveLength(1); expect(calls.filter(x => x.route === '/oauth/token')).toHaveLength(2);
    for (let i = 1; i < calls.length; i++) if (calls[i].route !== '/oauth/token') expect(calls[i].time - calls[i - 1].time).toBeGreaterThanOrEqual(990);
    expect(stderr).toEqual([]); expect(fs.readFileSync(file, 'utf8')).not.toContain('fixture-secret'); expect(JSON.stringify([capabilities, description, partial, order, created, deleted, after])).not.toContain('fixture-token');
  } finally { await Promise.allSettled(clients.map(client => client.close())); fs.rmSync(dir, { recursive: true, force: true }); }
}, 25000);
