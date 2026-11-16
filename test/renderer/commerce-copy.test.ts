import {describe,it,expect} from 'vitest';
const model=require('../../resources/builtin/apps/builtin-content-workbench/model.js');

describe('Commerce copy in the shared creation workspace',()=>{
 it('sends authored core content and chosen references to ContentWriter as text without a product or media settings',()=>{
  const work=model.draft('copy','zh');work.brief='500 ml travel mug. Write a concise product introduction for commuters.';work.assetIds=['reference'];
  const source=model.asset({id:'reference',name:'mug.png',path:'media/reference.png',bytes:12});
  const request=model.request(work,[source],'copy-request');
  expect(request.agentId).toBe('173d4235a431');expect(request.prompt).toBe(work.brief);expect(request.media).toBeUndefined();
  expect(request.brief).toMatchObject({kind:'copy',settings:{format:'txt'},sources:[{id:'reference',name:'mug.png',file:'reference.png'}]});expect(request.files).toEqual(['media/reference.png']);
  expect(request.brief.settings).not.toHaveProperty('aspect');expect(request.brief.settings).not.toHaveProperty('duration');expect(request.brief).not.toHaveProperty('product');
  expect(()=>model.request({...work,brief:' '},[source],'empty')).toThrow('REQUEST');
 });
 it('reopens independent copy, image and video drafts while preserving legacy media records and product context',()=>{
  const copy=model.draft('copy','zh'),image=model.draft('image','en'),video=model.draft('video','en');copy.brief='Core copy facts';image.brief='Image draft';video.brief='Video draft';video.settings.duration=47;
  const prior={...image,id:'legacy-image',productId:'existing-product'};
  const index=model.readIndex({schemaVersion:1,works:[{id:prior.id,kind:'image',title:'Prior creation'}],assets:[],drafts:{copy,image,video}});
  expect(index.drafts.copy.brief).toBe('Core copy facts');expect(index.drafts.image.brief).toBe('Image draft');expect(index.drafts.video.settings.duration).toBe(47);
  expect(model.readWork(prior,prior.id).productId).toBe('existing-product');index.drafts.copy.brief='New wording';expect(copy.brief).toBe('Core copy facts');
  expect(model.outputFormats(copy)).toEqual(['txt']);expect(model.historyRows([...index.works,{id:'copy-result',kind:'copy',title:'Generated copy'}],'copy').map((row:any)=>row.id)).toEqual(['copy-result']);
 });
 it('reuses copy source material without replacing the image draft or replaying its completed task',()=>{
  const copy={...model.draft('copy','en'),id:'copy-work',brief:'Core content',jobs:[{requestId:'copy-request',status:'completed',outputs:[]}],results:[{assetId:'saved-copy'}]};
  const before=JSON.stringify(copy),next=model.reuse(copy,'saved-copy','image','en');
  expect(next).toMatchObject({kind:'image',assetIds:['saved-copy'],sourceWorkId:'copy-work',jobs:[],results:[]});expect(next.settings.format).toBe('png');expect(JSON.stringify(copy)).toBe(before);
 });
});
