import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
let root:string,previous:string|undefined,service:any,deps:any,uid='user-a';
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'app-tasks-'));previous=process.env.ORKAS_WORKSPACE_ROOT;process.env.ORKAS_WORKSPACE_ROOT=root;vi.resetModules();
 deps={activeUser:()=>uid,create:vi.fn(async()=>({conversation_id:'conversation-one'})),send:vi.fn(async()=>({ok:true})),inspect:vi.fn(async()=>({status:'completed',text:'Draft result',files:[]})),cancel:vi.fn(async()=>{}),open:vi.fn(async()=>{})};
 const {AppTaskService}=await import('../../../src/main/features/web_apps/tasks');service=new AppTaskService(deps);});
afterEach(async()=>{uid='user-a';if(previous===undefined)delete process.env.ORKAS_WORKSPACE_ROOT;else process.env.ORKAS_WORKSPACE_ROOT=previous;await fs.rm(root,{recursive:true,force:true});});
const scope=()=>({userId:uid,key:'a'.repeat(64),signal:new AbortController().signal});
const input={requestId:'operation-one',title:'Cup copy',prompt:'Write the listing',agentId:'commander',files:[]};
it('exposes a bounded optional delivery contract without changing old SDK defaults or accepting extra authority',async()=>{
 const {METHODS}=await import('../../../src/main/features/web_apps/catalog');
 expect(METHODS['tasks.start'].input.parse(input)).toMatchObject({keepSession:false});
 for(const deliverable of ['image','video','audio','text'])expect(METHODS['tasks.start'].input.parse({...input,deliverable})).toHaveProperty('deliverable',deliverable);
 expect(()=>METHODS['tasks.start'].input.parse({...input,deliverable:'anything'})).toThrow();
 expect(()=>METHODS['tasks.start'].input.parse({...input,confirmedSpend:true})).toThrow();
});
it('keeps old receipts interactive after reopening and preserves text-only deliveries',async()=>{
 deps.inspect.mockResolvedValue({status:'waiting_input',text:'Choose a style',files:[]});deps.rejectInteraction=vi.fn();deps.respond=vi.fn(async()=>({handled:true}));
 await service.call(scope(),'tasks.start',input);
 const {createHash}=await import('node:crypto');const file=path.join(root,uid,'cloud/web_apps',scope().key,'tasks',createHash('sha256').update(input.requestId).digest('hex')+'.json');
 const receipt=JSON.parse(await fs.readFile(file,'utf8'));delete receipt.directDelivery;await fs.writeFile(file,JSON.stringify(receipt));
 await service.settle(scope(),input.requestId);expect(deps.rejectInteraction).not.toHaveBeenCalled();
 expect(await service.call(scope(),'tasks.respond',{requestId:input.requestId,kind:'text',text:'A caption'})).toEqual({handled:true});
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.inspect.mockResolvedValue({status:'completed',text:'A finished caption',files:[]});
 await service.settle(scope(),input.requestId);expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'completed',text:'A finished caption'});
});
it('keeps an explicit deliverable bound to the request and rejects a text-only media result without replay',async()=>{
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();
 await service.call(scope(),'tasks.start',{...input,deliverable:'video'});
 await expect(service.call(scope(),'tasks.start',{...input,deliverable:'image'})).rejects.toMatchObject({code:'E_CONFLICT'});
 await service.settle(scope(),input.requestId);
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'failed',error:{code:'E_OUTPUT_MISSING'}});
 expect(deps.send).toHaveBeenCalledOnce();expect(deps.cleanup).toHaveBeenCalledOnce();
});
it('rejects interactive waits only for newly admitted one-shot tasks and waits for cancellation to settle before cleanup',async()=>{
 deps.inspect.mockResolvedValue({status:'waiting_input',text:'Choose a style',files:[]});
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();deps.rejectInteraction=vi.fn(async()=>true);
 await service.call(scope(),'tasks.start',input);await service.settle(scope(),input.requestId);
 expect(deps.rejectInteraction).toHaveBeenCalledOnce();expect(deps.cleanup).not.toHaveBeenCalled();
 deps.inspect.mockResolvedValue({status:'stopped',text:'Choose a style',files:[]});await service.settle(scope(),input.requestId);
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'failed',error:{code:'E_INTERACTION_REQUIRED'}});
 expect(deps.cleanup).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();
});
it('binds an explicit media service to the task identity without changing legacy request fingerprints',async()=>{
 const media={kind:'video',serviceId:'b'.repeat(32)};
 await service.call(scope(),'tasks.start',{...input,media});
 await expect(service.call(scope(),'tasks.start',{...input,media:{...media,serviceId:'c'.repeat(32)}})).rejects.toMatchObject({code:'E_CONFLICT'});
 await expect(service.call(scope(),'tasks.start',input)).rejects.toMatchObject({code:'E_CONFLICT'});
 expect(deps.send).toHaveBeenCalledOnce();expect(deps.send.mock.calls[0][2].media).toEqual(media);
});
it('binds advisory output preferences to request identity, persists them across reopening and rejects changed retries',async()=>{
 const output={aspect:'9:16',format:'mp4'};
 await service.call(scope(),'tasks.start',{...input,deliverable:'video',output});
 await expect(service.call(scope(),'tasks.start',{...input,deliverable:'video',output:{...output,aspect:'16:9'}})).rejects.toMatchObject({code:'E_CONFLICT'});
 await expect(service.call(scope(),'tasks.start',{...input,deliverable:'video'})).rejects.toMatchObject({code:'E_CONFLICT'});
 await service.call(scope(),'tasks.start',{...input,deliverable:'video',output:{format:'mp4',aspect:'9:16'}});
 expect(deps.send).toHaveBeenCalledOnce();expect(deps.send.mock.calls[0][2].output).toEqual(output);
 deps.inspect.mockResolvedValue({status:'completed',text:'Result',files:[{id:'file',name:'video.mp4',bytes:16}]});deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);
 const {AppTaskService}=await import('../../../src/main/features/web_apps/tasks');await new AppTaskService(deps).settle(scope(),input.requestId);
 expect(deps.archive.mock.calls[0][6]).toEqual(output);
});
it.each([{aspect:'9:16'}, {format:'mp4'}, {duration:30}])('rejects incompatible or unsupported output authority before dispatch (%j)',async output=>{
 await expect(service.call(scope(),'tasks.start',{...input,deliverable:'audio',output})).rejects.toMatchObject({code:'E_INPUT'});expect(deps.send).not.toHaveBeenCalled();
});
it('keeps a retained session bound to its admitted media service and rejects a changed or omitted choice before another send',async()=>{
 deps.create.mockResolvedValue({conversation_id:'conversation-one',sessionId:'c'.repeat(32)});deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();
 const media={kind:'image',serviceId:'b'.repeat(32)},first=await service.call(scope(),'tasks.start',{...input,keepSession:true,media});await service.settle(scope(),input.requestId);
 await expect(service.call(scope(),'tasks.start',{...input,requestId:'changed',keepSession:true,sessionId:first.sessionId,media:{...media,serviceId:'d'.repeat(32)}})).rejects.toMatchObject({code:'E_CONFLICT'});
 await expect(service.call(scope(),'tasks.start',{...input,requestId:'omitted',keepSession:true,sessionId:first.sessionId})).rejects.toMatchObject({code:'E_CONFLICT'});expect(deps.send).toHaveBeenCalledOnce();
 await service.call(scope(),'tasks.start',{...input,requestId:'same',keepSession:true,sessionId:first.sessionId,media});expect(deps.send).toHaveBeenCalledTimes(2);
});
it('keeps one durable task after reopening and rejects changed retry inputs',async()=>{const first=await service.call(scope(),'tasks.start',input);expect(first.requestId).toBe(input.requestId);expect(await service.call(scope(),'tasks.start',input)).toEqual(first);expect(deps.send).toHaveBeenCalledOnce();expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'completed',text:'Draft result'});await expect(service.call(scope(),'tasks.start',{...input,prompt:'Different request'})).rejects.toMatchObject({code:'E_CONFLICT'});expect(deps.send).toHaveBeenCalledOnce();});
it('does not replay a dispatch with an uncertain result, and still reconnects to its task',async()=>{deps.send.mockRejectedValueOnce(new Error('connection ended'));await expect(service.call(scope(),'tasks.start',input)).rejects.toMatchObject({code:'E_TASK_UNCERTAIN'});expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'completed'});await service.call(scope(),'tasks.start',input);expect(deps.send).toHaveBeenCalledOnce();});
it('denies another app, an inactive account and cancelled admission without execution',async()=>{await service.call(scope(),'tasks.start',input);await expect(service.call({...scope(),key:'b'.repeat(64)},'tasks.get',{requestId:input.requestId})).rejects.toMatchObject({code:'E_TASK'});uid='user-b';await expect(service.call({...scope(),userId:'user-a'},'tasks.get',{requestId:input.requestId})).rejects.toMatchObject({code:'E_CLOSED'});const controller=new AbortController();controller.abort();await expect(service.call({...scope(),signal:controller.signal},'tasks.start',{...input,requestId:'new'})).rejects.toMatchObject({code:'E_CANCELLED'});expect(deps.send).toHaveBeenCalledOnce();});
it('continues an admitted task after detachment and never opens a normal task conversation',async()=>{await service.call(scope(),'tasks.start',input);expect(deps.cancel).not.toHaveBeenCalled();await service.call(scope(),'tasks.cancel',{requestId:input.requestId});expect(deps.cancel).toHaveBeenCalledWith(uid,'conversation-one');await expect(service.call(scope(),'tasks.open',{requestId:input.requestId})).rejects.toMatchObject({code:'E_UNAVAILABLE'});expect(deps.open).not.toHaveBeenCalled();});
it('rejects forged record identities and a symlinked task directory',async()=>{await service.call(scope(),'tasks.start',input);const other=path.join(root,'outside');await fs.mkdir(other);const folder=path.join(root,uid,'cloud/web_apps','b'.repeat(64));await fs.mkdir(folder,{recursive:true});await fs.symlink(other,path.join(folder,'tasks'),'dir');await expect(service.call({...scope(),key:'b'.repeat(64)},'tasks.start',input)).rejects.toMatchObject({code:'E_FILE'});expect(deps.send).toHaveBeenCalledOnce();});
it('reports rejected input separately from an uncertain dispatched operation',async()=>{
 const {TaskInputError}=await import('../../../src/main/features/web_apps/tasks');deps.send.mockRejectedValueOnce(new TaskInputError('E_FILE'));
 await expect(service.call(scope(),'tasks.start',input)).rejects.toMatchObject({code:'E_FILE'});
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'failed',error:{code:'E_FILE'}});expect(deps.inspect).not.toHaveBeenCalled();
});

it('admits one task when duplicate submissions overlap and survives a new service instance',async()=>{
 let entered!:()=>void,release!:()=>void;
 const sending=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 deps.send.mockImplementation(async()=>{entered();await gate;return{ok:true};});
 const first=service.call(scope(),'tasks.start',input);await sending;
 const duplicate=service.call(scope(),'tasks.start',input);release();
 expect(await first).toMatchObject({status:'submitted'});expect(await duplicate).toMatchObject({status:'submitted'});
 const {AppTaskService}=await import('../../../src/main/features/web_apps/tasks');
 const reopened=new AppTaskService(deps);
 expect(await reopened.call(scope(),'tasks.start',input)).toMatchObject({status:'submitted'});
 expect(await reopened.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({text:'Draft result'});
 expect(deps.create).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();
});

it('retains interrupted preparation as unknown after reopening instead of creating another task',async()=>{
 deps.create.mockRejectedValueOnce(new Error('Interrupted preparation'));
 await expect(service.call(scope(),'tasks.start',input)).rejects.toMatchObject({code:'E_TASK_UNCERTAIN'});
 const {AppTaskService}=await import('../../../src/main/features/web_apps/tasks'),reopened=new AppTaskService(deps);
 expect(await reopened.call(scope(),'tasks.start',input)).toMatchObject({status:'unknown'});
 expect(await reopened.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'unknown',files:[]});
 await expect(reopened.call(scope(),'tasks.cancel',{requestId:input.requestId})).rejects.toMatchObject({code:'E_TASK_UNCERTAIN'});
 expect(deps.create).toHaveBeenCalledOnce();expect(deps.send).not.toHaveBeenCalled();expect(deps.cancel).not.toHaveBeenCalled();
});

it('denies another app output access and discards an in-flight file response after an account switch',async()=>{
 await service.call(scope(),'tasks.start',input);
 let entered!:()=>void,release!:()=>void;
 const reading=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 deps.output=vi.fn(async()=>{entered();await gate;return{base64:'cHJpdmF0ZQ==',name:'image.png'};});
 const args={requestId:input.requestId,outputId:'b'.repeat(64)};
 await expect(service.call({...scope(),key:'c'.repeat(64)},'tasks.output',args)).rejects.toMatchObject({code:'E_TASK'});
 expect(deps.output).not.toHaveBeenCalled();
 const pending=service.call(scope(),'tasks.output',args),denied=expect(pending).rejects.toMatchObject({code:'E_CLOSED'});
 await reading;uid='user-b';release();await denied;
 uid='user-a';expect(await service.call(scope(),'tasks.output',args)).toEqual({base64:'cHJpdmF0ZQ==',name:'image.png'});
 expect(deps.send).toHaveBeenCalledOnce();
});

it('archives before cleanup without a page and reads the durable result after reopening',async()=>{
 deps.inspect.mockResolvedValue({status:'completed',text:'Final answer',files:[{id:'b'.repeat(64),name:'final.png',bytes:3}]});
 const order:string[]=[];
 deps.archive=vi.fn(async(_uid:any,_cid:any,result:any)=>{order.push('archive');return{...result,files:[{...result.files[0],path:'results/operation-one/final.png'}]};});
 deps.cleanup=vi.fn(async()=>{order.push('cleanup');});
 await service.call(scope(),'tasks.start',input);
 await service.settle(scope(),input.requestId);
 expect(order).toEqual(['archive','cleanup']);
 deps.inspect.mockRejectedValue(new Error('session removed'));
 const reopened=new (await import('../../../src/main/features/web_apps/tasks')).AppTaskService(deps);
 expect(await reopened.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'completed',text:'Final answer',files:[{path:'results/operation-one/final.png'}]});
 expect(deps.send).toHaveBeenCalledOnce();
 await reopened.settle(scope(),input.requestId);expect(deps.cleanup).toHaveBeenCalledOnce();
});

it('preserves execution data on archive failure and retries storage without redispatch',async()=>{
 deps.archive=vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async(_u:any,_c:any,result:any)=>result);
 deps.cleanup=vi.fn(async()=>{});
 await service.call(scope(),'tasks.start',input);
 await expect(service.settle(scope(),input.requestId)).rejects.toThrow('disk full');
 expect(deps.cleanup).not.toHaveBeenCalled();
 await service.settle(scope(),input.requestId);
 expect(deps.archive).toHaveBeenCalledTimes(2);expect(deps.cleanup).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();
});

it.each(['running','waiting_input','unknown'])('does not clean or archive a nonterminal task (%s)',async status=>{
 deps.inspect.mockResolvedValue({status,text:'',files:[]});deps.archive=vi.fn();deps.cleanup=vi.fn();
 await service.call(scope(),'tasks.start',input);await service.settle(scope(),input.requestId);
 expect(deps.archive).not.toHaveBeenCalled();expect(deps.cleanup).not.toHaveBeenCalled();
});

it('retries interrupted cleanup from the saved receipt without inspecting or executing again',async()=>{
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
 await service.call(scope(),'tasks.start',input);await expect(service.settle(scope(),input.requestId)).rejects.toThrow('busy');
 deps.inspect.mockRejectedValue(new Error('already removed'));
 const reopened=new (await import('../../../src/main/features/web_apps/tasks')).AppTaskService(deps);
 await reopened.settle(scope(),input.requestId);expect(deps.archive).toHaveBeenCalledOnce();expect(deps.cleanup).toHaveBeenCalledTimes(2);expect(deps.send).toHaveBeenCalledOnce();
});

it('keeps retained session data, serializes turns and rejects foreign session reuse',async()=>{
 deps.create.mockResolvedValue({conversation_id:'conversation-one',sessionId:'c'.repeat(32)});
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();
 const first=await service.call(scope(),'tasks.start',{...input,keepSession:true});expect(first.sessionId).toBe('c'.repeat(32));
 await expect(service.call(scope(),'tasks.start',{...input,requestId:'next',keepSession:true,sessionId:first.sessionId})).rejects.toMatchObject({code:'E_BUSY'});
 await service.settle(scope(),input.requestId);
 expect(deps.cleanup).not.toHaveBeenCalled();
 await service.call(scope(),'tasks.start',{...input,requestId:'next',keepSession:true,sessionId:first.sessionId});
 expect(deps.create).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledTimes(2);
 await expect(service.call({...scope(),key:'b'.repeat(64)},'tasks.start',{...input,requestId:'foreign',keepSession:true,sessionId:first.sessionId})).rejects.toMatchObject({code:'E_TASK'});
});

it.each(['failed','stopped'])('preserves confirmed partial outputs before cleaning a settled %s run',async status=>{
 deps.inspect.mockResolvedValue({status,text:'Partial work retained',files:[{id:'b'.repeat(64),name:'partial.png',bytes:3}]});
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>({...result,files:[{...result.files[0],path:'results/partial.png'}]}));deps.cleanup=vi.fn();
 await service.call(scope(),'tasks.start',input);await service.settle(scope(),input.requestId);
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status,files:[{name:'partial.png',path:'results/partial.png'}]});
 expect(deps.cleanup).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();
});

it('cancels an uncertain idle admission without replay, while cancellation never cleans running work',async()=>{
 deps.send.mockRejectedValueOnce(new Error('lost dispatch acknowledgement'));
 deps.inspect.mockResolvedValue({status:'running',text:'',files:[]});deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();
 await expect(service.call(scope(),'tasks.start',input)).rejects.toMatchObject({code:'E_TASK_UNCERTAIN'});
 await service.call(scope(),'tasks.cancel',{requestId:input.requestId});await service.settle(scope(),input.requestId);expect(deps.cleanup).not.toHaveBeenCalled();
 deps.inspect.mockResolvedValue({status:'unknown',text:'',files:[]});await service.settle(scope(),input.requestId);
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'stopped'});expect(deps.cleanup).toHaveBeenCalledOnce();expect(deps.send).toHaveBeenCalledOnce();
});

it('keeps execution on its admitting host while allowing archived results to be read elsewhere',async()=>{
 let host='a'.repeat(32);deps.hostId=vi.fn(async()=>host);
 deps.create.mockResolvedValue({conversation_id:'conversation-one',sessionId:'c'.repeat(32)});
 deps.archive=vi.fn(async(_u:any,_c:any,result:any)=>result);deps.cleanup=vi.fn();
 const first=await service.call(scope(),'tasks.start',{...input,keepSession:true});
 host='b'.repeat(32);
 await expect(service.call(scope(),'tasks.get',{requestId:input.requestId})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 await expect(service.call(scope(),'tasks.cancel',{requestId:input.requestId})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 await expect(service.call(scope(),'tasks.start',{...input,requestId:'foreign-host',keepSession:true,sessionId:first.sessionId})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 expect(deps.inspect).not.toHaveBeenCalled();expect(deps.cancel).not.toHaveBeenCalled();
 host='a'.repeat(32);await service.settle(scope(),input.requestId);host='b'.repeat(32);
 expect(await service.call(scope(),'tasks.get',{requestId:input.requestId})).toMatchObject({status:'completed',saved:true});expect(deps.send).toHaveBeenCalledOnce();
});
