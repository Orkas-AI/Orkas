import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {it,expect} from 'vitest';
const require=createRequire(import.meta.url),codec=require('../../../../bin/local-api-credential-codec.cjs');
it('refreshes the existing grant, reads contacts, creates a list and restarts before deletion without replay',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-cc-journey-')),file=path.join(directory,'grant.enc'),key=crypto.randomBytes(32).toString('base64url'),preload=path.join(directory,'provider.cjs'),journal=path.join(directory,'requests.jsonl');
 codec.writeCredentialFile(file,key,{provider:'constant_contact',access_token:'old-token',refresh_token:'old-refresh',expires_at:0,client_id:'fixture-client',scope:'account_read contact_data campaign_data offline_access'});
 fs.writeFileSync(preload,`
 const fs=require('node:fs');global.fetch=async(raw,init)=>{
  const url=new URL(raw);fs.appendFileSync(process.env.FIXTURE_JOURNAL,JSON.stringify({path:url.pathname,method:init.method})+'\\n');
  if(url.href==='https://authz.constantcontact.com/oauth2/default/v1/token')return new Response(JSON.stringify({access_token:'rotated-access',refresh_token:'rotated-refresh',scope:'account_read contact_data campaign_data offline_access',expires_in:3600}));
  if(url.origin!=='https://api.cc.email'||init.headers.authorization!=='Bearer rotated-access')throw new Error('Unexpected wire authority');
  if(url.pathname==='/v3/contacts'&&init.method==='GET')return new Response(JSON.stringify({contacts:[{contact_id:'C1',email_address:{address:'fixture@example.invalid'}}]}));
  if(url.pathname==='/v3/contact_lists'&&init.method==='POST'){
   if(JSON.parse(init.body).name!=='Fixture list')throw new Error('Lost business field');return new Response(JSON.stringify({list_id:'L1',name:'Fixture list'}),{status:201});
  }
  if(url.pathname==='/v3/contacts/C1'&&init.method==='DELETE')return new Response(null,{status:204});
  throw new Error('Unexpected operation');
 };
 `);
 const clients:Client[]=[],stderr:string[]=[];
 async function connect(){const client=new Client({name:'cc-native-journey',version:'1'});clients.push(client);const transport=new StdioClientTransport({command:process.execPath,args:['--require',preload,path.resolve(__dirname,'../../../../bin/direct-commerce-mcp-server.cjs')],stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((r):r is [string,string]=>typeof r[1]==='string')),ELECTRON_RUN_AS_NODE:'1',ORKAS_LOCAL_API_PROVIDER:'constant_contact',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:'{}',FIXTURE_JOURNAL:journal}});transport.stderr?.on('data',d=>stderr.push(String(d)));await client.connect(transport);return client;}
 const parsed=(r:any)=>JSON.parse(r.content[0].text);
 try{
  const client=await connect(),description=await client.callTool({name:'describe_action',arguments:{action:'POST /contact_lists'}});expect(description.isError).not.toBe(true);expect(parsed(description).input_schema.properties.body).toBeTruthy();
  const read=await client.callTool({name:'execute_read',arguments:{action:'GET /contacts',parameters:{query:{limit:100}}}});expect(read.isError).not.toBe(true);expect(parsed(read).result.data.contacts[0].email_address.address).toBe('fixture@example.invalid');
  const created=await client.callTool({name:'execute_write',arguments:{action:'POST /contact_lists',parameters:{body:{name:'Fixture list'}}}});expect(created.isError).not.toBe(true);expect(parsed(created).result).toMatchObject({status:'acknowledged',data:{list_id:'L1'}});await client.close();
  const restarted=await connect(),args={action:'DELETE /contacts/{contact_id}',parameters:{path:{contact_id:'C1'}}};expect((await restarted.callTool({name:'execute_read',arguments:args})).isError).toBe(true);
  const removed=await restarted.callTool({name:'execute_destructive',arguments:args});expect(removed.isError).not.toBe(true);expect(parsed(removed).result).toEqual({data:null,status:'acknowledged'});
  expect(codec.readCredentialFile(file,key)).toMatchObject({access_token:'rotated-access',refresh_token:'rotated-refresh'});expect(fs.readFileSync(journal,'utf8').trim().split('\n').map(v=>JSON.parse(v).method)).toEqual(['POST','GET','POST','DELETE']);expect(JSON.stringify([description,read,created,removed])).not.toContain('rotated-access');
 }finally{await Promise.allSettled(clients.map(c=>c.close()));expect(stderr).toEqual([]);fs.rmSync(directory,{recursive:true,force:true});}
},20000);
