import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';import * as os from 'node:os';import * as path from 'node:path';
const state=vi.hoisted(()=>({available:true}));
vi.mock('../../../src/main/features/web_apps/media-services',()=>({resolveAppMediaService:async()=>{if(!state.available)throw Object.assign(Error('Unavailable'),{code:'E_UNAVAILABLE'});return{routeRef:'selected-service'};}}));
let root:string,previous:string|undefined;const uid='owner',cid='app_'+'a'.repeat(64)+'_once_'+'b'.repeat(32),selection={kind:'image' as const,serviceId:'c'.repeat(32)};
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'app-media-route-'));previous=process.env.ORKAS_WORKSPACE_ROOT;process.env.ORKAS_WORKSPACE_ROOT=root;vi.resetModules();state.available=true;(await import('../../../src/main/features/users')).activateUser(uid);});
afterEach(async()=>{if(previous===undefined)delete process.env.ORKAS_WORKSPACE_ROOT;else process.env.ORKAS_WORKSPACE_ROOT=previous;await fs.rm(root,{recursive:true,force:true});});
it('keeps a task-local service across reopen, ignores it for other media and never borrows a replacement',async()=>{
 const api=await import('../../../src/main/features/app_media_route');await api.saveAppMediaRoute(uid,cid,selection);
 expect(await api.appTaskMediaRoute(uid,cid,'image')).toBe('selected-service');expect(await api.appTaskMediaRoute(uid,cid,'audio')).toBeUndefined();
 state.available=false;await expect(api.appTaskMediaRoute(uid,cid,'image')).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 await api.saveAppMediaRoute(uid,cid,undefined);expect(await api.appTaskMediaRoute(uid,cid,'image')).toBeUndefined();
});
it('rejects corrupt or linked app routing data and foreign accounts without reading ordinary conversations',async()=>{
 const api=await import('../../../src/main/features/app_media_route');expect(await api.appTaskMediaRoute(uid,'normal','image')).toBeUndefined();
 await api.saveAppMediaRoute(uid,cid,selection);const file=path.join((await import('../../../src/main/paths')).appLocalConversationRoot(uid,cid)!,'media-route.json');
 await fs.writeFile(file,'{"version":1,"media":{"kind":"image","serviceId":"../forged"}}');await expect(api.appTaskMediaRoute(uid,cid,'image')).rejects.toMatchObject({code:'E_FILE'});
 await fs.rm(file);await fs.symlink(path.join(root,'outside'),file);await expect(api.saveAppMediaRoute(uid,cid,selection)).rejects.toMatchObject({code:'E_FILE'});
 (await import('../../../src/main/features/users')).activateUser('other');await expect(api.appTaskMediaRoute(uid,cid,'image')).rejects.toMatchObject({code:'E_CLOSED'});
});
