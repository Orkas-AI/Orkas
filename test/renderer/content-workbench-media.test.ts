import {expect,it} from 'vitest';
const m=require('../../resources/builtin/apps/builtin-content-workbench/model.js');

it.each(['image','video','audio'])('keeps the %s service choice in its draft and sends it outside the authored prompt',kind=>{
 const w={...m.draft(kind,'en'),id:'chosen-service',brief:'Keep my exact wording.'};w.settings.serviceId='b'.repeat(32);w.settings.serviceName='Chosen service';
 const reopened=m.readWork(JSON.parse(JSON.stringify(w)),w.id),request=m.request(reopened,[],'request');
 expect(request.prompt).toBe('Keep my exact wording.');expect(request.media).toEqual({kind,serviceId:'b'.repeat(32)});expect(request.brief.settings).not.toHaveProperty('serviceId');
 expect(m.applyLibrary(reopened,{brief:'New text',assetIds:[]}).settings.serviceId).toBe('b'.repeat(32));
 expect(m.request({...w,settings:{...w.settings,serviceId:''}},[],'default')).not.toHaveProperty('media');
 expect(m.request({...w,settings:{...w.settings,format:'txt'}},[],'text')).not.toHaveProperty('media');
 expect(()=>m.request({...w,settings:{...w.settings,serviceId:'../forged'}},[],'forged')).toThrow();
});

it('keeps a failed generation explanation through save/reopen and clears it on authoritative recovery',()=>{
 const w={...m.draft('image','en'),id:'failed-work',brief:'Make a product picture.'},job={requestId:'failed-request',status:'running',text:'',outputs:[]};w.jobs=[job];
 m.inspect(w,job,{status:'failed',text:'The selected service is unavailable. Choose another service and try again.',files:[],error:{code:'E_UNAVAILABLE'}});
 expect(m.failureText(m.readWork(JSON.parse(JSON.stringify(w)),w.id).jobs[0])).toBe('The selected service is unavailable. Choose another service and try again.');
 expect(m.readWork(JSON.parse(JSON.stringify(w)),w.id).jobs[0].errorCode).toBe('E_UNAVAILABLE');
 const invalid=JSON.parse(JSON.stringify(w));invalid.jobs[0].errorCode='private provider body';expect(()=>m.readWork(invalid,w.id)).toThrow();
 m.inspect(w,job,{status:'completed',text:'Saved the picture.',files:[]});expect(m.failureText(job)).toBe('');expect(job).not.toHaveProperty('errorCode');
 expect(m.failureText({status:'failed',text:''})).toBe('');expect(m.failureText(undefined)).toBe('');
});

it.each(['image','video','audio'])('selects the first usable configured %s service once and preserves explicit choices',kind=>{
 const work=m.draft(kind,'zh'),first={id:'a'.repeat(32),provider:kind==='image'?'openai':kind==='video'?'doubao':'elevenlabs',model:'user-model',label:'My studio',name:'Configured model',managed:false,available:true},second={...first,id:'b'.repeat(32)};
 expect(m.selectFirstService(work,[], 'zh')).toBe(false);expect(work.settings).not.toHaveProperty('serviceId');
 expect(m.selectFirstService(work,[{...first,id:'c'.repeat(32),available:false},first,second],'zh')).toBe(true);
 expect(m.request({...work,brief:'Use this service.'},[],'first-service').media).toEqual({kind,serviceId:first.id});
 expect(m.selectFirstService(work,[second,first],'zh')).toBe(false);expect(work.settings.serviceId).toBe(first.id);
 expect(m.selectFirstService(work,[second],'zh')).toBe(false);expect(work.settings.serviceId).toBe(first.id);
});
it('preserves configured service labels without hosted product aliases',()=>{
 expect(m.serviceLabel({managed:false,label:'My studio',name:'GPT Image 2'},'en')).toBe('My studio · GPT Image 2');
 expect(m.serviceLabel({managed:false,name:'Configured speech'},'zh')).toBe('Configured speech');
});

it('names the public speech service Orkas·Voice without relabeling other configured providers',()=>{
 const voice={id:'d'.repeat(32),provider:'orkas-api',model:'orkas-tts-1',name:'orkas-tts-1',label:'Narration key',managed:false,available:true};
 for(const lang of ['zh','en','ar']){
  expect(m.serviceLabel(voice,lang)).toBe('Orkas·Voice');
  const work=m.draft('audio',lang);expect(m.selectFirstService(work,[voice],lang)).toBe(true);
  expect(work.settings.serviceName).toBe('Orkas·Voice');
  const reopened=m.readWork({...JSON.parse(JSON.stringify(work)),id:'voice-work'},'voice-work');
  expect(m.request({...reopened,brief:'Read my script.'},[],'voice-request').media).toEqual({kind:'audio',serviceId:voice.id});
 }
 expect(m.serviceLabel({...voice,provider:'custom'},'en')).toBe('Narration key · orkas-tts-1');
 expect(m.serviceLabel({...voice,model:'other-model',name:'Other model'},'en')).toBe('Narration key · Other model');
});
