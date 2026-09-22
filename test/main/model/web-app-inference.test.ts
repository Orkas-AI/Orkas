import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
let root: string, previous: string | undefined;
let requests: any[];
let events: any[];
let failing = false;
let cancelled: AbortController | null;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-app-model-'));
  previous=process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT=root;
  vi.resetModules(); requests=[]; failing=false; cancelled=null;
  events=[{type:'text_delta',text:'Hello'}, {type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}];
  vi.doMock('#core-agent',async()=>({...(await vi.importActual<any>('#core-agent')),
    createPiProvider:()=>({id:'openrouter',name:'Fixture',validateAuth:async()=>true,
      async *stream(input:any){requests.push(input);if(failing)throw new Error('fixture unavailable');for(const e of events){yield e;if(cancelled)cancelled.abort();}},
    }),
  }));
  const users=await import('../../../src/main/features/users'); users.activateUser('app-inference-owner');
  const auth=await import('../../../src/main/features/auth');
  const p=await auth.addApiKey('openrouter','sk-local-fixture','Fixture');
  await auth.addEntry({provider:'openrouter',model:'openrouter/auto',profileId:p.profileId});
});
afterEach(async()=>{vi.doUnmock('#core-agent');if(previous===undefined)delete process.env.ORKAS_WORKSPACE_ROOT;else process.env.ORKAS_WORKSPACE_ROOT=previous;await fs.rm(root,{recursive:true,force:true});});
describe('Web app governed pure inference',()=>{
  it('uses only explicit input and preserves streaming usage without an Agent session',async()=>{
    const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner'); const progress=vi.fn();
    expect(await generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},new AbortController().signal,progress)).toEqual({text:'Hello',usage:{inputTokens:2,outputTokens:1,totalTokens:3},stopReason:'end_turn'});
    expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({messages:[{role:'user',content:[{type:'text',text:'Greeting'}]}],tools:[],maxTokens:128});
    expect(requests[0].systemPrompt).toBeUndefined();expect(requests[0].sessionId).toBeUndefined();
    expect(progress).toHaveBeenCalledWith({type:'delta',text:'Hello'});
  });
  it('passes long input and caller output budgets through the existing model path', async () => {
    const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner');
    const prompt='a'.repeat(40000), output='b'.repeat(270000);
    events=[{type:'text_delta',text:output},{type:'message_end',stopReason:'end_turn'}];
    expect(await generateWebAppText('app-inference-owner',{prompt,maxTokens:8192},new AbortController().signal,()=>{})).toMatchObject({text:output});
    expect(requests[0]).toMatchObject({maxTokens:8192,messages:[{role:'user',content:[{type:'text',text:prompt}]}]});
    await generateWebAppText('app-inference-owner',{prompt:'Default'},new AbortController().signal,()=>{});
    expect(requests[1].maxTokens).not.toBe(1024);
    expect(requests[1].maxTokens).not.toBe(4096);
  });
  it('does not retry a failed generation or rotate to spend through another configuration',async()=>{
    failing=true;const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner');
    await expect(generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},new AbortController().signal,()=>{})).rejects.toThrow();expect(requests).toHaveLength(1);
  });
  it('rejects foreign accounts and pre-cancelled calls before contacting a provider',async()=>{
    const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner');const c=new AbortController();c.abort();
    await expect(generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},c.signal,()=>{})).rejects.toThrow('cancelled');
    await expect(generateWebAppText('foreign',{prompt:'Greeting',maxTokens:128},new AbortController().signal,()=>{})).rejects.toThrow('cancelled');expect(requests).toHaveLength(0);
  });
  it('does not convert interrupted or tool-bearing output to a completed app response',async()=>{
    const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner'); cancelled=new AbortController();
    await expect(generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},cancelled.signal,()=>{})).rejects.toThrow('cancelled');
    cancelled=null;events=[{type:'tool_use_start',id:'one',name:'bash'}];
    await expect(generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},new AbortController().signal,()=>{})).rejects.toThrow('tool request');
  });
  it('preserves token-limited text as explicitly incomplete and rejects a missing terminal event',async()=>{
    const {generateWebAppText}=await import('../../../src/main/model/core-agent/runner');
    events=[{type:'text_delta',text:'Partial'},{type:'message_end',stopReason:'max_tokens'}];
    expect(await generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},new AbortController().signal,()=>{})).toMatchObject({text:'Partial',stopReason:'max_tokens'});
    events=[{type:'text_delta',text:'Interrupted'}];
    await expect(generateWebAppText('app-inference-owner',{prompt:'Greeting',maxTokens:128},new AbortController().signal,()=>{})).rejects.toThrow('incomplete');
  });
});
