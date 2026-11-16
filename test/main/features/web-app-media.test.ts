import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({images:[] as any[],videos:[] as any[],voices:[] as any[],user:'owner'}));
vi.mock('../../../src/main/features/image_gen',()=>({listOpenImageGenCandidates:()=>state.images}));
vi.mock('../../../src/main/features/video_gen',()=>({listVideoGenCandidates:()=>state.videos}));
vi.mock('../../../src/main/features/tts_auth',()=>({listUsableTtsProfiles:()=>state.voices}));
vi.mock('../../../src/main/features/auth',()=>({loadImageProfiles:()=>[],loadVideoProfiles:()=>[],loadTtsProfiles:()=>[]}));
vi.mock('../../../src/main/features/image_auth',()=>({listImageModelOptions:()=>[]}));
vi.mock('../../../src/main/features/video_auth',()=>({listVideoModelOptions:()=>[]}));
vi.mock('../../../src/main/features/users',()=>({getActiveUserId:()=>state.user}));
beforeEach(()=>{state.images=[];state.videos=[];state.voices=[];state.user='owner';});
afterEach(()=>vi.restoreAllMocks());

it('lists configured image and speech choices without credentials and resolves the exact selected identity',async()=>{
 const api=await import('../../../src/main/features/web_apps/media-services');
 state.images=[{entry:{entryId:'my-image',provider:'openai',model:'gpt-image',apiKey:'fixture-secret'},capability:{model:'gpt-image'}}];
 state.voices=[{id:'my-voice',provider:'openai',model:'tts-1',label:'Narration',apiKey:'fixture-secret',baseUrl:'https://private.fixture'}];
 const image=await api.listAppMediaServices('image'),voice=await api.listAppMediaServices('audio');
 expect(image.services).toMatchObject([{provider:'openai',model:'gpt-image',managed:false}]);expect(voice.services).toMatchObject([{model:'tts-1',label:'Narration'}]);
 expect(JSON.stringify([image,voice])).not.toContain('fixture-secret');expect(JSON.stringify(voice)).not.toContain('private.fixture');
 expect(await api.resolveAppMediaService('owner',{kind:'image',serviceId:image.services[0].id})).toMatchObject({profileId:'my-image',kind:'image'});
 await expect(api.resolveAppMediaService('owner',{kind:'audio',serviceId:image.services[0].id})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 state.images=[];await expect(api.resolveAppMediaService('owner',{kind:'image',serviceId:image.services[0].id})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
});

it('preserves configured public video ordering and service identities without writes or account routes',async()=>{
 const api=await import('../../../src/main/features/web_apps/media-services');
 const publicApi={entry:{id:'public-video',provider:'orkas-api',model:'orkas-video-1',label:'Orkas',apiKey:'fixture-secret'}},own={entry:{id:'own-video',provider:'doubao',model:'own-model',label:'My studio',apiKey:'fixture-secret'}};
 state.videos=[publicApi,own];const before=JSON.stringify(state.videos),first=await api.listAppMediaServices('video');
 expect(first.services.map(s=>[s.model,s.managed,s.available])).toEqual([['orkas-video-1',false,true],['own-model',false,true]]);
 expect(JSON.stringify(state.videos)).toBe(before);const chosen=await api.resolveAppMediaService('owner',{kind:'video',serviceId:first.services[0].id});expect(chosen.routeRef).toBe('public-video');
 state.videos=[own,publicApi];const reordered=await api.listAppMediaServices('video');expect(reordered.services.map(s=>s.model)).toEqual(['own-model','orkas-video-1']);expect(reordered.services[1].id).toBe(first.services[0].id);
 expect(JSON.stringify(reordered)).not.toContain('fixture-secret');state.videos=[own];await expect(api.resolveAppMediaService('owner',{kind:'video',serviceId:first.services[0].id})).rejects.toMatchObject({code:'E_UNAVAILABLE'});
 state.user='other';await expect(api.resolveAppMediaService('owner',{kind:'video',serviceId:first.services[0].id})).rejects.toMatchObject({code:'E_CLOSED'});
});
it('reports an oversized configuration instead of silently dropping selectable services',async()=>{
 const api=await import('../../../src/main/features/web_apps/media-services');state.images=Array.from({length:101},(_,i)=>({entry:{entryId:'image-'+i,provider:'openai'},capability:{model:'gpt-image'}}));
 await expect(api.listAppMediaServices('image')).rejects.toMatchObject({code:'E_LIMIT'});
});
