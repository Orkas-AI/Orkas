import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const codec=require('../../../../bin/local-api-credential-codec.cjs');

// Real MCP process, protocol and encrypted grant; only the merchant HTTP
// boundary is replaced. The journal detects replay and denied-lane side effects.
it('reads customers, creates a customer and deletes after MCP restart without widening the granted lane',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-square-journey-'));
 const file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url');
 const preload=path.join(dir,'provider.cjs'),journal=path.join(dir,'wire.jsonl');
 const grant={provider:'square',access_token:'fixture-square-token'};
 codec.writeCredentialFile(file,key,grant);
 fs.writeFileSync(preload,`
  const fs=require('node:fs');
  global.fetch=async(raw,init)=>{
   const url=new URL(raw);
   if(url.origin!=='https://connect.squareup.com' || init.headers.authorization!=='Bearer fixture-square-token' || init.headers['square-version']!=='2026-09-16')throw new Error('Unexpected merchant authority');
   fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
   if(url.pathname==='/v2/customers' && init.method==='GET')return new Response(JSON.stringify({customers:[{id:'C-1',email_address:'fixture@example.invalid'}],cursor:'PAGE-2'}));
   if(url.pathname==='/v2/customers' && init.method==='POST'){
    const p=JSON.parse(init.body);if(p.idempotency_key!=='REQUEST-1' || p.given_name!=='Fixture')throw new Error('Lost customer input');
    return new Response(JSON.stringify({customer:{id:'C-2',given_name:'Fixture'}}));
   }
   if(url.pathname==='/v2/customers/C-2' && init.method==='DELETE')return new Response('{}');
   throw new Error('Unexpected merchant operation');
  };
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){
  const client=new Client({name:'square-merchant-journey',version:'1'});clients.push(client);
  const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{
   ...Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>typeof row[1]==='string')),ELECTRON_RUN_AS_NODE:'1',
   ORKAS_LOCAL_API_PROVIDER:'square',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,
   ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({environment:'live'}),FIXTURE_JOURNAL:journal}});
  transport.stderr?.on('data',data=>stderr.push(String(data)));await client.connect(transport);return client;
 }
 const read=(result:any)=>JSON.parse(result.content[0].text);
 try{
  const client=await connect();
  const described=await client.callTool({name:'describe_action',arguments:{action:'POST /v2/customers'}});
  expect(described.isError).not.toBe(true);expect(read(described).input_schema.$defs.CreateCustomerRequest.properties.email_address).toBeTruthy();
  const result=await client.callTool({name:'execute_read',arguments:{action:'GET /v2/customers',parameters:{query:{limit:100}}}});
  expect(result.isError).not.toBe(true);expect(read(result).result.data).toMatchObject({customers:[{id:'C-1',email_address:'fixture@example.invalid'}],cursor:'PAGE-2'});
  const created=await client.callTool({name:'execute_write',arguments:{action:'POST /v2/customers',parameters:{body:{given_name:'Fixture',idempotency_key:'REQUEST-1'}}}});
  expect(created.isError).not.toBe(true);expect(read(created).result).toMatchObject({status:'acknowledged',data:{customer:{id:'C-2'}}});await client.close();
  const restarted=await connect(),args={action:'DELETE /v2/customers/{customer_id}',parameters:{path:{customer_id:'C-2'}}};
  expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);
  const deleted=await restarted.callTool({name:'execute_destructive',arguments:args});
  expect(deleted.isError).not.toBe(true);expect(read(deleted).result).toEqual({status:'acknowledged',data:{}});
  expect(codec.readCredentialFile(file,key)).toEqual(grant);
  expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line))).toEqual([{path:'/v2/customers',method:'GET'},{path:'/v2/customers',method:'POST'},{path:'/v2/customers/C-2',method:'DELETE'}]);
  expect(JSON.stringify([described,result,created,deleted])).not.toContain(grant.access_token);expect(stderr).toEqual([]);
 }finally{await Promise.allSettled(clients.map(c=>c.close()));fs.rmSync(dir,{recursive:true,force:true});}
},20000);
