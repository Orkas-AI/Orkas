import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({videos:[] as any[],images:[] as any[]}));
vi.mock('../../../src/main/features/auth',()=>({loadVideoProfiles:()=>h.videos}));
vi.mock('../../../src/main/features/image_gen',()=>({listOpenImageGenCandidates:()=>h.images}));
import { buildVideoProductionQuoteSegments, checkVideoProductionServices, videoProductionQuotePayloadSegments } from '../../../src/main/features/video_production_services';
const video=(id='own',provider='doubao',model='doubao-seedance-2-5-260628',extra={})=>({id,provider,model,apiKey:'private-fixture-key',label:'Fixture',createdAt:1,...extra});
const image=(entryId:string,supportsEdit=true)=>({entry:{entryId,profileId:'shared-key',provider:'openai',apiKey:'private-fixture-key'},capability:{api:'openai',model:'gpt-image-2',supportsEdit}});
beforeEach(()=>{h.videos=[];h.images=[];vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Availability checks must not call a remote service')}));});

afterEach(()=>vi.unstubAllGlobals());

describe('VideoStudio public service availability preflight',()=>{
 it.each(['1080p','4k'])('refuses an overlong chosen Cloud shot before authorizing availability at %s',async resolution=>{
  const { privateKey }=generateKeyPairSync('rsa',{modulusLength:2048});
  const apiKey=JSON.stringify({type:'service_account',project_id:'video-project',client_email:'video@video-project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})});
  h.videos=[video('chosen','google-cloud','veo-3.1-generate-001',{apiKey}),video('fallback')];
  const intent={segment_id:'v',kind:'video' as const,prompt:'A continuous thirty-second shot',duration:30,resolution};
  const before=JSON.stringify(intent);
  await expect(checkVideoProductionServices([intent],undefined,'chosen')).rejects.toMatchObject({videoParameters:{reason:expect.stringContaining('duration')}});
  expect(JSON.stringify(intent)).toBe(before);expect(fetch).not.toHaveBeenCalled();
 });
 it('reports missing services without inventing a balance or contacting a server',async()=>{
  const result=await checkVideoProductionServices([{segment_id:'shot',kind:'video',prompt:'Private request'}]);
  expect(result).toMatchObject({sufficient:false,external_billing_estimate_available:false,unavailable_segment_ids:['shot']});
  expect(result).not.toHaveProperty('in_app_credits_required_milli');
  expect(result).not.toHaveProperty('available_credits');expect(result).not.toHaveProperty('expected_credits');expect(fetch).not.toHaveBeenCalled();
 });
 it('discloses direct billing for both configured image and video services',async()=>{
  h.videos=[video()];h.images=[image('image')];
  const result=await checkVideoProductionServices([{segment_id:'v',kind:'video',prompt:'A lake'},{segment_id:'i',kind:'image',prompt:'A lamp'}]);
  expect(result).toMatchObject({sufficient:true,externally_billed_segment_ids:['v','i'],unavailable_segment_ids:[]});expect(fetch).not.toHaveBeenCalled();
 });
 it('matches the chosen video service instead of the saved first service, without changing order',async()=>{
  h.videos=[video('first'),video('chosen','minimax','MiniMax-H3-Lite')];const before=JSON.stringify(h.videos);
  const result=await checkVideoProductionServices([{segment_id:'v',kind:'video',prompt:'A lake',duration:2,resolution:'720p',generate_audio:false}],undefined,'chosen');
  expect(result.segments[0]).toMatchObject({provider:'minimax',duration:4,resolution:'768p',generate_audio:true,billing_mode:'external'});expect(JSON.stringify(h.videos)).toBe(before);expect(fetch).not.toHaveBeenCalled();
 });
 it('does not quote another service when the selected service was removed',async()=>{
  h.videos=[video()];await expect(checkVideoProductionServices([{segment_id:'v',kind:'video',prompt:'A lake'}],undefined,'removed')).rejects.toThrow('E_VIDEO_ROUTE_UNAVAILABLE');expect(fetch).not.toHaveBeenCalled();
 });
 it('uses the exact image entry rather than a shared credential identity',async()=>{
  h.images=[image('first',false),image('chosen',true)];
  const result=await checkVideoProductionServices([{segment_id:'i',kind:'image',prompt:'A lamp',reference_images:['/private/lamp.png']}],undefined,undefined,'chosen');
  expect(result).toMatchObject({sufficient:true,externally_billed_segment_ids:['i']});
  const unavailable=await checkVideoProductionServices([{segment_id:'i',kind:'image',prompt:'A lamp',reference_images:['/private/lamp.png']}],undefined,undefined,'first');
  expect(unavailable).toMatchObject({sufficient:false,unavailable_segment_ids:['i']});expect(fetch).not.toHaveBeenCalled();
 });
 it('retains the public Orkas API as a configured user-key service',async()=>{
  h.videos=[video('api','orkas-api','orkas-video')];
  expect(await checkVideoProductionServices([{segment_id:'v',kind:'video',prompt:'A lake'}],undefined,'api')).toMatchObject({sufficient:true,externally_billed_segment_ids:['v']});expect(fetch).not.toHaveBeenCalled();
 });
 it.each([{duration:31},{reference_image_urls:Array(31).fill('https://example.invalid/reference.png')}])('rejects unsupported requests before dispatch or fallback: %j',async args=>{
  h.videos=[video(),video('fallback','minimax','MiniMax-H3-Lite')];await expect(checkVideoProductionServices([{segment_id:'v',kind:'video',prompt:'A lake',...args}])).rejects.toThrow('E_VIDEO_PRODUCTION_VIDEO_PARAMETERS_INVALID');expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps prompts, keys and reference identities out of returned preflight payloads',()=>{
  h.videos=[video()];h.images=[image('image')];
  const intents=[{segment_id:'v',kind:'video' as const,prompt:'private-prompt',reference_video_paths:['/private/input.mp4']},{segment_id:'i',kind:'image' as const,prompt:'private-prompt',reference_images:['/private/lamp.png'],reference_image_urls:['https://private.invalid/photo.png']}];
  const payload=videoProductionQuotePayloadSegments(intents);expect(payload).toMatchObject([{segment_id:'v',kind:'video',provider:'doubao'},{segment_id:'i',kind:'image',reference_images:['reference-1','reference-2']}]);
  expect(JSON.stringify(payload)).not.toMatch(/private-prompt|private-fixture-key|\/private\/|private.invalid/);
 });
 it('preserves caller-owned intent objects and rejects an already cancelled check',async()=>{
  h.videos=[video()];const intent={segment_id:'v',kind:'video' as const,prompt:'A lake',duration:2};const before=JSON.stringify(intent);buildVideoProductionQuoteSegments([intent]);expect(JSON.stringify(intent)).toBe(before);
  const controller=new AbortController();controller.abort();await expect(checkVideoProductionServices([intent],controller.signal)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});
