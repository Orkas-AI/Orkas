import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url), codec = require('../../../../bin/local-api-credential-codec.cjs');
const requirements = require('../../../../bin/shopify-setup-requirements.cjs');
// Real MCP child and encrypted client credentials. Provider IO alone is replaced;
// the journal proves lane rejection, one request per write and restart auth.
it('discovers a full Shopify input, reads variants, writes a reviewed product and surfaces partial failures through MCP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-shopify-journey-'));
  const file = path.join(directory, 'credentials.enc'), key = crypto.randomBytes(32).toString('base64url');
  const preload = path.join(directory, 'provider.cjs'), journal = path.join(directory, 'wire.jsonl');
  codec.writeCredentialFile(file, key, { provider: 'shopify', client_id: 'fixture-client', client_secret: 'fixture-secret' });
  fs.writeFileSync(preload, `
    const fs=require('node:fs');
    global.fetch=async(url,init)=>{
      if(url==='https://merchant.myshopify.com/admin/oauth/access_token'){
        fs.appendFileSync(process.env.FIXTURE_JOURNAL,'token\\n');
        return new Response(JSON.stringify({access_token:'fixture-token',scope:${JSON.stringify([...requirements.required_scopes, requirements.fulfillment_scopes_any_of[0]].join(','))},expires_in:86400}));
      }
      if(url!=='https://merchant.myshopify.com/admin/api/2026-07/graphql.json'||init.headers['x-shopify-access-token']!=='fixture-token')throw new Error('Unexpected authority');
      const body=JSON.parse(init.body);
      if(body.query.includes('shop{')){fs.appendFileSync(process.env.FIXTURE_JOURNAL,'identity\\n');return new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/1',name:'Merchant'}}}));}
      if(body.query.includes('productVariants(')){
        fs.appendFileSync(process.env.FIXTURE_JOURNAL,'variants\\n');
        return new Response(JSON.stringify({data:{productVariants:{nodes:[{id:'gid://shopify/ProductVariant/1',title:'Blue'}],pageInfo:{hasNextPage:true,endCursor:'next'}}}}));
      }
      if(body.query.includes('productSet(')){
        fs.appendFileSync(process.env.FIXTURE_JOURNAL,'write\\n');
        const input=Object.values(body.variables).find(v=>v&&typeof v==='object'&&v.title);
        if(!input||input.metafields[0].value!=='0')throw new Error('Lost complete input');
        return new Response(JSON.stringify({data:{productSet:{product:{id:'gid://shopify/Product/1',title:'Blue',status:'DRAFT'},userErrors:input.title==='partial'?[{field:['title'],message:'private detail',code:'INVALID_INPUT'}]:[]}}}));
      }
      throw new Error('Unexpected operation');
    };
  `);
  const clients: Client[] = [], stderr: string[] = [];
  const connect = async () => {
    const client = new Client({ name: 'shopify-contract-journey', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')], stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((r): r is [string, string] => typeof r[1] === 'string')), ELECTRON_RUN_AS_NODE: '1', ORKAS_LOCAL_API_PROVIDER: 'shopify', ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ shop_domain: 'merchant.myshopify.com' }), FIXTURE_JOURNAL: journal } });
    transport.stderr?.on('data', data => stderr.push(String(data))); await client.connect(transport); return client;
  };
  const content = (result: any) => JSON.parse(result.content[0].text);
  try {
    const client = await connect(); expect((await client.listTools()).tools).toHaveLength(6);
    const described = await client.callTool({ name: 'describe_action', arguments: { action: 'productSet' } });
    expect(content(described).input_schema.$defs.ProductSetInput.properties).toHaveProperty('metafields');
    const type = await client.callTool({ name: 'describe_action', arguments: { action: 'productSet', output_type: 'Product' } });
    expect(type.isError).not.toBe(true); expect(content(type).fields.variants.arguments.properties).toHaveProperty('first');
    const read = await client.callTool({ name: 'execute_read', arguments: { action: 'productVariants', parameters: { arguments: { first: 5, query: 'sku:BLUE' } } } });
    expect(read.isError).not.toBe(true); expect(content(read).result.data.productVariants.pageInfo).toEqual({ hasNextPage: true, endCursor: 'next' });
    const parameters = { arguments: { input: { title: 'Blue', metafields: [{ namespace: 'custom', key: 'count', type: 'number_integer', value: '0' }] } } };
    const denied = await client.callTool({ name: 'execute_read', arguments: { action: 'productSet', parameters } }); expect(denied.isError).toBe(true);
    const write = await client.callTool({ name: 'execute_destructive', arguments: { action: 'productSet', parameters } }); expect(write.isError).not.toBe(true); expect(content(write).result.status).toBe('acknowledged');
    await client.close(); const restarted = await connect(); parameters.arguments.input.title = 'partial';
    const partial = await restarted.callTool({ name: 'execute_destructive', arguments: { action: 'productSet', parameters } });
    expect(partial.isError).toBe(true); expect(content(partial).result).toMatchObject({ status: 'partial_or_failed', error_count: 1 });
    expect(fs.readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['token', 'identity', 'variants', 'write', 'token', 'write']); expect(stderr).toEqual([]);
    expect(JSON.stringify([described, read, denied, write, partial])).not.toContain('fixture-token');
  } finally { await Promise.allSettled(clients.map(client => client.close())); fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);
