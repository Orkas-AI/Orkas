/* App-private drafts and media; normal Studio tasks own production and billing. */
(async function () {
    'use strict';
    const extension=window.ContentWorkspaceExtension||{},api=extension.api||window.orkasApp,m=window.ContentModel,$=id=>document.getElementById(id);
    const kinds=extension.kinds||m.defaultKinds;let productFilter='*',modelsConfigured=false;
    const KEY='content-index-v1',pending=['submitting','submitted','running','waiting_input','saving','unknown'];
    const glyphs={works:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',video:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',audio:'<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',document:'<path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6"/>'};
    let locale='en',dictionary=window.ContentLocales.en,index=m.readIndex(null),current=m.draft(kinds[0],'en'),opened=null,agents=[];
    let active=false,submitting=false,navigating=false,importing=false,debounce,saving=Promise.resolve(),mediaEpoch=0,mediaUrl=null,mediaAsset=null,confirmation=null;
    const works=new Map(),removedWorks=new Set(),moreFilesOpen=new Set(),serviceLists=new Map(),serviceLoads=new Map();
    const reading=new Set();let recordLimit=12,pollCursor=0,managing=false,noticeKey='',noticeError=false;
    let inLibrary=false,libraryFilter='all',libraryLimit=48,libraryTarget=kinds[0],libraryBusy=false,libraryEdit=null,libraryDetail=null;
    const librarySelection=new Set(),saveFeedback=new Map(),draftChanges=new WeakSet();let pickerToLibrary=false,pickerOwner=null,savedDraft=null;
    // Native discovery/storage must finish before the page can accept a draft.
    for(const el of document.querySelectorAll('button,input,textarea'))el.disabled=true;
    document.body.setAttribute('aria-busy','true');
    const t=key=>dictionary[key];
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
    function icon(kind){const el=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const[k,v]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))el.setAttribute(k,v);el.innerHTML=glyphs[kind]||glyphs.document;return el;}
    function notice(key,error=false){noticeKey=key;noticeError=error;$('notice').textContent=key?t(key):'';$('notice').className=error?'error':'';}
    function draftSaved(owner,revision){
        if(current!==owner||current.revision!==revision)return;
        if(draftChanges.has(owner)){draftChanges.delete(owner);savedDraft={owner,revision};$('save-state').textContent=t('saved');}
        if(noticeKey==='notSaved')notice('');
    }
    function renderSaveFeedback(){
        for(const el of document.querySelectorAll('[data-save-location]')){el.hidden=!saveFeedback.has(el.dataset.saveLocation);el.textContent=t('saved');}
    }
    function savedAt(location){
        clearTimeout(saveFeedback.get(location));
        saveFeedback.set(location,setTimeout(()=>{saveFeedback.delete(location);renderSaveFeedback();},4000));
        renderSaveFeedback();
    }
    function savedHint(location){
        const hint=node('span',t('saved'),'save-feedback');hint.dataset.saveLocation=location;hint.hidden=!saveFeedback.has(location);hint.setAttribute('role','status');return hint;
    }
    function failure(error){if(error?.code==='E_CLOSED')active=false;notice(error?.userMessageKey||(error?.message==='LIMIT'?'limit':'error'),true);}
    function button(key,fn,className){const b=node('button',t(key),className);b.type='button';b.addEventListener('click',()=>Promise.resolve().then(fn).catch(failure));return b;}
    function enqueue(fn){const op=saving.catch(()=>{}).then(fn);saving=op;return op;}
    function row(w){return{id:w.id,title:m.displayTitle(w),summary:w.brief.trim().slice(0,160)||w.title,kind:w.kind,...w.productId?{productId:w.productId}:{},updatedAt:w.updatedAt,status:w.jobs[0]?.status||'',...w.jobs[0]?.status==='failed'&&w.jobs[0].errorCode?{errorCode:w.jobs[0].errorCode}:{},failureText:plainFailure(m.failureText(w.jobs[0])).slice(0,320),assetIds:[...w.assetIds],resultAssetIds:w.results.map(r=>r.assetId),collectionPending:m.uncollected(w).length>0||m.needsReply(w),collectionError:!!w.collectionError,collectionFailures:w.collectionFailures||0,autoSaved:true};}
    async function writeIndex(){await api.storage.set({key:KEY,value:index,scope:'cloud'});}
    function persistIndex(){return enqueue(writeIndex);}
    async function persist(w){
        if(removedWorks.has(w.id))return;const frozen=JSON.parse(JSON.stringify(w));
        return enqueue(async()=>{
            if(removedWorks.has(frozen.id))return;await api.appFiles.writeText({path:'works/'+frozen.id+'.json',text:JSON.stringify(frozen),scope:'cloud'});if(removedWorks.has(frozen.id))return;
            const at=index.works.findIndex(x=>x.id===frozen.id);if(at<0)index.works.unshift(row(frozen));else index.works[at]=row(frozen);
            await writeIndex();draftSaved(w,frozen.revision);renderLists();
        });
    }
    function touch(authored=true){
        if(!active || current.jobs.length)return;
        if(authored)draftChanges.add(current);
        current.revision++;current.updatedAt=new Date().toISOString();$('save-state').textContent='';
        if(!current.id)index.drafts[current.kind]=JSON.parse(JSON.stringify(current));
        clearTimeout(debounce);debounce=setTimeout(()=>flush().catch(error=>{notice('notSaved',true);}),300);
    }
    async function flush(){
        clearTimeout(debounce);if(!active)throw Error('DATA');const owner=current,revision=current.revision;
        if(current.id&&!current.jobs.length)await persist(current);
        else if(!current.id){index.drafts[current.kind]=JSON.parse(JSON.stringify(current));await persistIndex();draftSaved(owner,revision);}
        else await saving;
    }

    async function saveDraft(w=current){
        if(!active || w.jobs.length) return;
        if(!w.id){if(index.works.length>=500)throw Error('LIMIT');w.id=crypto.randomUUID();w.createdAt=new Date().toISOString();works.set(w.id,w);delete index.drafts[w.kind];}
        w.updatedAt=new Date().toISOString();await persist(w);renderControls();
    }
    function hasContent(w){return !!(w.title.trim()||w.brief.trim()||w.assetIds.length);}
    function draft(kind){return index.drafts[kind]?JSON.parse(JSON.stringify(index.drafts[kind])):m.draft(kind,locale);}
    async function newWork(kind=current.kind){
        if(!kinds.includes(kind))return;
        if(navigating)return;navigating=true;renderControls();
        try{await flush();inLibrary=false;if(kind!==current.kind){recordLimit=12;}current=draft(kind);opened=null;}
        finally{navigating=false;render();window.scrollTo(0,0);}
    }
    function renderConfirmation(){
        if(!confirmation)return;const c=confirmation,dialog=$('confirm');
        dialog.querySelector('h2').textContent=t(c.title);$('confirm-text').textContent=(c.detail?c.detail+'\n':'')+t(c.message);
        const action=dialog.querySelector('[value="confirm"]');action.textContent=t(c.action);action.className=c.danger?'btn btn-danger':'btn btn-primary';
    }
    async function confirmAction(title,message,action,detail='',danger=false){
        const dialog=$('confirm');if(dialog.open)return false;
        confirmation={title,message,action,detail,danger};renderConfirmation();dialog.returnValue='cancel';
        const answer=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});dialog.showModal();});confirmation=null;return answer==='confirm';
    }
    async function storeDraft(next){
        await enqueue(async()=>{const previous=index.drafts[next.kind];index.drafts[next.kind]=JSON.parse(JSON.stringify(next));try{await writeIndex();}catch(error){if(previous)index.drafts[next.kind]=previous;else delete index.drafts[next.kind];throw error;}});
    }
    async function resetWork(){
        if(!active||submitting||navigating||managing||importing)return;
        navigating=true;renderControls();
        const next=m.draft(current.kind,locale);
        try{
            if(hasContent(current)&&!await confirmAction('reset','resetConfirm','reset'))return;
            clearTimeout(debounce);await storeDraft(next);
            current=next;opened=null;$('brief').style.removeProperty('height');$('save-state').textContent='';notice('');
        }finally{navigating=false;render();$('reset-work').focus();}
        $('brief').focus();
    }
    async function openWork(id){
        if(!active||managing||navigating)return;navigating=true;renderControls();
        try{await flush();if(opened?.id===id){opened=null;}else{opened=await loadWork(id);}}
        finally{navigating=false;render();}if(opened)void refresh(opened).catch(error=>{notice('error',true);});
    }
    async function loadWork(id){
        if(!works.has(id)){const stored=await api.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'});if(!stored)throw Error('DATA');works.set(id,m.readWork(JSON.parse(stored.text),id));}
        return works.get(id);
    }
    const selects=new Map();
    function select(id,options,value,label,disabled,onChange,placeholder=label){
        let control=selects.get(id);
        if(!control){control=window.ContentControls.mount($(id),{options,value,placeholder:label,ariaLabel:label});selects.set(id,control);}
        control.setAriaLabel(label);control.setOptions(options,{value,placeholder});control.onChange(value=>{try{onChange(value);}catch(error){failure(error);}});
        $(id).querySelector('button').disabled=disabled;
    }
    function editable(){return active&&!current.jobs.length&&!submitting&&!navigating&&!managing&&!libraryBusy;}
    function closeMaterialMenu(restoreFocus=false){
        $('material-menu').hidden=true;$('add-material').setAttribute('aria-expanded','false');if(restoreFocus)$('add-material').focus();
    }
    function openMaterialMenu(last=false){
        if($('add-material').disabled)return;
        const menu=$('material-menu'),trigger=$('add-material');menu.hidden=false;trigger.setAttribute('aria-expanded','true');
        const bounds=trigger.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
        const left=locale==='ar'?bounds.right-width:bounds.left;
        menu.style.left=Math.max(8,Math.min(left,window.innerWidth-width-8))+'px';
        menu.style.top=Math.max(8,bounds.bottom+height+8<=window.innerHeight?bounds.bottom+4:bounds.top-height-4)+'px';
        const items=[...menu.querySelectorAll('button:not(:disabled)')];items[last?items.length-1:0]?.focus();
    }
    function serviceLabel(service){return m.serviceLabel(service,locale);}
    async function configureModels(){
        if(!editable())return;
        const kind=current.kind;await flush();modelsConfigured=true;
        try{await api.configureModels(kind);}catch(error){modelsConfigured=false;throw error;}
    }
    function serviceAvailable(w){return !api.tasks.services||['txt','srt','json'].includes(w.settings.format)||!!w.settings.serviceId&&serviceLists.get(w.kind)?.services.some(s=>s.id===w.settings.serviceId&&s.available);}
    function loadServices(kind,force=false,refresh=false){
        if(kind==='copy')return;
        if(!active||!api.tasks.services||serviceLoads.has(kind)||!force&&serviceLists.has(kind))return serviceLoads.get(kind);
        const promise=api.tasks.services({kind,...refresh?{refresh:true}:{}}).then(result=>{serviceLists.set(kind,result);}).catch(error=>{if(error?.code==='E_CLOSED')active=false;serviceLists.set(kind,{...serviceLists.get(kind),services:serviceLists.get(kind)?.services||[],failed:true});}).finally(()=>{serviceLoads.delete(kind);renderControls();});
        serviceLoads.set(kind,promise);renderControls();return promise;
    }
    function renderServices(w,locked,textOnly){
        $('service-field').hidden=textOnly||!api.tasks.services;if($('service-field').hidden)return;
        const list=serviceLists.get(w.kind),loading=serviceLoads.has(w.kind),chosen=list?.services.find(s=>s.id===w.settings.serviceId),missing=!!w.settings.serviceId&&!chosen;
        const options=(list?.services||[]).map(s=>({value:s.id,label:serviceLabel(s),hint:s.available?t('configuredService'):t('serviceUnavailable'),disabled:!s.available}));
        if(missing)options.push({value:w.settings.serviceId,label:w.settings.serviceName||t('serviceUnavailable'),disabled:true});
        const label=t(w.kind==='audio'?'speechService':'service');$('service-label').textContent=label;
        if(typeof api.configureModels==='function')options.push({value:'configure-models',label:t('configureModels'),iconName:'settings',action:()=>{void configureModels().catch(failure);}});
        select('service',options,w.settings.serviceId||'',label,locked||loading||!options.length,value=>{if(!editable())return;const service=serviceLists.get(w.kind)?.services.find(s=>s.id===value&&s.available);if(!service)return;w.settings.serviceId=value;w.settings.serviceName=serviceLabel(service).slice(0,240);touch();renderControls();},w.settings.serviceName||label);
        $('refresh-services').disabled=locked||loading;$('refresh-services').textContent=t(loading?'loading':'refresh');$('refresh-services').setAttribute('aria-busy',String(loading));
        const message=loading?'':w.settings.serviceId&&!serviceAvailable(w)?'serviceUnavailable':list?.failed?'servicesUnavailable':'';
        $('service-state').textContent=message?t(message):'';$('service-state').hidden=!message;
        $('service-state').classList.toggle('error',message==='serviceUnavailable'||message==='servicesUnavailable');
        if(!list&&!loading)void loadServices(w.kind);
    }
    function renderControls(){
        const list=serviceLists.get(current.kind);if(editable()&&list&&!list.failed&&m.selectFirstService(current,list.services,locale))touch(false);
        const w=current,d=w.settings,locked=!editable();
        for(const id of ['brief','duration'])$(id).disabled=locked;
        $('upload').disabled=locked||importing||w.assetIds.length>=19;
        $('open-library').disabled=!active||navigating||managing||submitting||importing||libraryBusy;
        $('add-material').disabled=$('open-library').disabled;if($('add-material').disabled)closeMaterialMenu();$('material-picker').disabled=libraryLocked();
        $('reset-work').disabled=!active||submitting||navigating||managing||importing;
        for(const b of document.querySelectorAll('.media-tabs button'))b.disabled=!active||navigating||managing||importing||libraryBusy;
        $('submit').hidden=!!w.jobs.length;$('submit').disabled=locked||importing||!agents.some(a=>a.id===m.agents[w.kind])||!w.brief.trim()||!serviceAvailable(w);
        $('agent-state').textContent=agents.some(a=>a.id===m.agents[w.kind])?'':t(w.kind==='copy'?'copyAgentMissing':'agentMissing');
        $('refresh-agents').hidden=agents.some(a=>a.id===m.agents[w.kind]);
        for(const[key,values]of [['aspect',['any','1:1','4:5','9:16','16:9','3:2']],['format',m.outputFormats(w)]])select(key,values.map(value=>({value,label:value==='any'?t('any'):key==='format'?value.toUpperCase():value,iconName:key==='aspect'?'aspect-'+value.replace(':','-'):''})),d[key],t(key),locked,value=>{if(!editable())return;w.settings[key]=value;touch();renderControls();});
        $('duration').value=d.duration??'';$('duration').placeholder=t('any');
        const textOnly=['txt','srt','json'].includes(d.format);document.querySelector('.composer-tools').hidden=w.kind==='copy';$('format').parentElement.hidden=w.kind==='copy';$('aspect-field').hidden=w.kind==='audio'||textOnly;$('duration-field').hidden=w.kind!=='video'||textOnly;
        renderServices(w,locked,textOnly);
        renderAttachments(locked||importing);
        $('source-count').textContent=importing?t('importingMaterials'):w.assetIds.length?String(w.assetIds.length)+' / 19':'';
        renderLibraryControls();
    }
    function selectedProductAssets(){
        if(!librarySelection.size)return [];
        try{return m.libraryContent(index,[...librarySelection]).assetIds.map(id=>index.assets.find(a=>a.id===id));}catch{return [];}
    }
    function attachment(a,id){
        const chip=node('div',undefined,'chat-attach-chip');chip.dataset.id=id;
        const open=button('preview',()=>showMedia(a),'attachment-preview'),mark=node('span',undefined,'chat-attach-icon');mark.append(icon(a?.kind));if(a?.thumbnailPath)thumbnail(a,mark);
        const label=node('span',a?.name||t('fileMissing'),'chat-attach-label');label.title=a?.name||'';open.replaceChildren(mark,label);open.setAttribute('aria-label',t('preview')+' '+(a?.name||t('fileMissing')));open.disabled=!active||!a;chip.append(open);return chip;
    }
    function renderAttachments(locked){
        const host=$('selected-assets'),wanted=new Set(current.assetIds);
        for(const el of host.children)if(!wanted.has(el.dataset.id))el.remove();
        for(const id of current.assetIds){
            const a=index.assets.find(a=>a.id===id);let chip=[...host.children].find(el=>el.dataset.id===id);
            if(!chip){chip=attachment(a,id);const remove=button('remove',()=>{current.assetIds=current.assetIds.filter(x=>x!==id);touch();renderControls();},'chat-attach-remove');remove.textContent='×';chip.append(remove);host.append(chip);}
            chip.querySelector('.attachment-preview').setAttribute('aria-label',t('preview')+' '+(a?.name||t('fileMissing')));
            const remove=chip.querySelector('.chat-attach-remove');remove.disabled=locked;remove.setAttribute('aria-label',t('remove')+' '+(a?.name||t('fileMissing')));remove.title=t('remove');
        }
    }
    // Small, separately stored JPEGs avoid rereading full media on every render.
    const thumbCache=new Map();let thumbQueue=Promise.resolve();
    function thumbnail(a,host){
        let cached=thumbCache.get(a.id);
        if(!cached){cached=thumbQueue.then(async()=>{try{const reply=await api.appFiles.readBase64({path:a.thumbnailPath,scope:'cloud'});if(!reply||reply.base64.length>32768)throw Error('FILE');return URL.createObjectURL(new Blob([decode(reply.base64)],{type:'image/jpeg'}));}catch(error){return null;}});thumbQueue=cached.then(()=>{});thumbCache.set(a.id,cached);if(thumbCache.size>64){const first=thumbCache.keys().next().value;void thumbCache.get(first).then(url=>{if(url)URL.revokeObjectURL(url);});thumbCache.delete(first);}}
        void cached.then(url=>{if(!url||!host.isConnected)return;const img=node('img');img.src=url;img.alt=a.name;img.className='chat-attach-thumb';host.replaceChildren(img);});
    }
    async function makeThumbnail(a,base64){
        if(a.kind!=='image')return;
        const url=URL.createObjectURL(new Blob([decode(base64)],{type:a.name.toLowerCase().endsWith('.svg')?'image/svg+xml':''})),img=new Image();let timer;
        try{await Promise.race([new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('FILE'));img.src=url;}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('FILE')),10000);})]);const canvas=document.createElement('canvas'),scale=Math.min(1,80/Math.max(img.naturalWidth,img.naturalHeight));canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',0.75).split(',')[1];if(data.length>32768)throw Error('FILE');const path='thumbnails/'+a.id+'.jpg';await api.appFiles.writeBase64({path,base64:data,scope:'cloud'});a.thumbnailPath=path;}
        catch(error){}
        finally{clearTimeout(timer);img.src='';URL.revokeObjectURL(url);}
    }

    function plainFailure(value){const template=document.createElement('template');template.innerHTML=value;return template.content.textContent||'';}
    function taskFailure(job){return job?.errorCode==='E_OUTPUT_MISSING'?t('noOutput'):job?.errorCode==='E_OUTPUT_MISMATCH'?t('outputMismatch'):['E_OUTPUT_UNVERIFIED','E_INTERACTION_REQUIRED'].includes(job?.errorCode)?t('error'):'';}
    function renderTask(){
        const host=$('output-list'),w=opened,job=w?.jobs[0];
        const key=JSON.stringify([w?.id,w?.results,job?.outputs,job?.status,job?.text,job?.errorCode,w?.collectionError,locale]);if(host.dataset.work===key)return;
        const previous=host.querySelector('.result-tools'),previousId=host.dataset.record;
        if(previous&&previousId){if(previous.open)moreFilesOpen.add(previousId);else moreFilesOpen.delete(previousId);}
        const summaryFocused=previous?.querySelector('summary')===document.activeElement;
        host.dataset.work=key;host.dataset.record=w?.id||'';host.setAttribute('aria-label',t('results'));host.replaceChildren();
        if(!w)return;
        $('record-error').hidden=job?.status!=='failed';$('record-error').textContent=taskFailure(job)||plainFailure(m.failureText(job))||t(job?.errorCode==='E_FILE'?'fileMissing':job?.errorCode==='E_UNAVAILABLE'&&w.settings.serviceId?'serviceUnavailable':'error');
        const groups=m.resultGroups(w),pendingOutputs=m.uncollected(w),versions=new Map(),positions=new Map();
        for(const result of w.results)if(result.outputId)versions.set(result.outputId,(versions.get(result.outputId)||0)+1);
        const renderFile=(result,target)=>{
            const a=index.assets.find(a=>a.id===result.assetId);if(!a)return;
            const file=node('div',undefined,'result-file');file.dataset.assetId=a.id;const chip=attachment(a,a.id);if((versions.get(result.outputId)||0)>1){const version=(positions.get(result.outputId)||0)+1;positions.set(result.outputId,version);chip.querySelector('.chat-attach-label').textContent=a.name+' · '+version;chip.querySelector('.attachment-preview').setAttribute('aria-label',t('preview')+' '+a.name+' · '+version);}file.append(chip);
            const more=button('moreActions',()=>resultMenu(more,a),'result-menu-trigger');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.innerHTML=window.uiIconHtml('more-horizontal');more.setAttribute('aria-label',t('moreActions')+' '+a.name);file.append(savedHint('result:'+a.id),more);target.append(file);
        };
        const renderPending=(output,target)=>{const file=node('div',undefined,'result-file is-pending');file.append(icon(m.mediaKind(output.name)),node('span',output.name,'chat-attach-label'),node('span',t(w.collectionError?'resultSaveFailed':'savingResult'),'help'));target.append(file);};
        for(const result of groups.primary)renderFile(result,host);
        for(const output of pendingOutputs.filter(output=>m.outputPreferred(w,output)))renderPending(output,host);
        const otherPending=pendingOutputs.filter(output=>!m.outputPreferred(w,output)),otherCount=groups.other.length+otherPending.length;
        if(otherCount){
            const details=node('details',undefined,'result-tools'),summary=node('summary',t('moreFiles')+' · '+otherCount),files=node('div',undefined,'record-results');let populated=false;
            const populate=()=>{if(populated)return;populated=true;for(const result of groups.other)renderFile(result,files);for(const output of otherPending)renderPending(output,files);};
            details.open=moreFilesOpen.has(w.id);if(details.open)populate();details.append(summary,files);host.append(details);
            details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open){moreFilesOpen.add(w.id);populate();}else{moreFilesOpen.delete(w.id);if(details.contains(menuTrigger)){closeRecordMenu();summary.focus({preventScroll:true});}}});
            if(summaryFocused&&previousId===w.id)summary.focus({preventScroll:true});
        }
        $('no-output').hidden=!!host.children.length;
        $('no-output').textContent=t(pending.includes(job?.status)?'status_'+job.status:job?.status==='completed'?'noOutput':job?.status==='failed'?'status_failed':'draftStatus');
    }
    function visibleHistory(){return m.historyRows(index.works,current.kind).filter(r=>productFilter==='*'||(r.productId||'')===productFilter);}
    function removable(r){return !!r&&!pending.includes(r.status);}
    let menuTrigger=null;
    function closeRecordMenu(focus=false){$('record-menu').hidden=true;menuTrigger?.setAttribute('aria-expanded','false');menuTrigger?.closest('.is-menu-open')?.classList.remove('is-menu-open');if(focus&&menuTrigger?.isConnected)menuTrigger.focus();menuTrigger=null;}
    function showRecordMenu(trigger,items){
        closeMaterialMenu();closeRecordMenu();menuTrigger=trigger;trigger.setAttribute('aria-expanded','true');trigger.closest('.history-row,.result-file')?.classList.add('is-menu-open');const menu=$('record-menu');menu.replaceChildren();
        for(const item of items){const b=button(item.key,()=>{closeRecordMenu();return item.run();},'context-menu-item'+(item.danger?' is-danger':''));b.setAttribute('role','menuitem');b.tabIndex=-1;b.disabled=!!item.disabled;const mark=node('span',undefined,'context-menu-icon');mark.innerHTML=window.uiIconHtml(item.icon||'file');b.prepend(mark);menu.append(b);}
        menu.hidden=false;const r=trigger.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;menu.style.left=Math.max(8,Math.min(locale==='ar'?r.left:r.right-width,innerWidth-width-8))+'px';menu.style.top=Math.max(8,r.bottom+height+8<=innerHeight?r.bottom+4:r.top-height-4)+'px';menu.querySelector('button:not(:disabled)')?.focus();
    }
    function recordMenu(trigger,id){
        const r=index.works.find(r=>r.id===id);if(!r)return;
        showRecordMenu(trigger,[{key:'edit',icon:'edit-pencil',disabled:!active||managing||navigating||submitting||importing,run:()=>editRecord(id)},{key:'refresh',icon:'refresh',run:async()=>{const w=await loadWork(id);w.collectionFailures=0;await refresh(w);}},{key:'openTask',icon:'external',disabled:r.status!=='waiting_input',run:async()=>api.presentTaskInput((await loadWork(id)).jobs[0].requestId,{title:t('status_waiting_input'),submit:t('continue'),close:t('close'),cancel:t('cancel'),error:t('error')})},{key:'stop',icon:'square',disabled:!pending.includes(r.status),run:async()=>{const w=await loadWork(id);await api.tasks.cancel({requestId:w.jobs[0].requestId});await refresh(w);}},{key:'removeWork',icon:'trash',danger:true,disabled:!removable(r)||submitting||managing,run:()=>removeWork(id)}]);
    }
    function resultMenu(trigger,a){
        showRecordMenu(trigger,[{key:'useAsMaterial',icon:'plus',disabled:libraryLocked(),run:async()=>{if(libraryLocked())return;libraryTarget=current.kind;await useLibrary(['asset:'+a.id]);}},{key:'saveToLibrary',icon:'folder',disabled:libraryLocked(),run:()=>saveResultMaterial(a)},{key:'openFile',icon:'external',run:()=>api.appFiles.open({path:a.path,scope:'cloud'})},{key:'revealFile',icon:'folder',run:()=>api.appFiles.reveal({path:a.path,scope:'cloud'})}]);
    }
    async function saveResultMaterial(a){
        if(libraryLocked())return;libraryBusy=true;renderControls();
        try{
            await enqueue(async()=>{const previous=a.libraryHidden;a.libraryHidden=false;try{await writeIndex();}catch(error){if(previous!==undefined)a.libraryHidden=previous;else delete a.libraryHidden;throw error;}});
            notice('');savedAt('result:'+a.id);
        }finally{libraryBusy=false;renderControls();}
    }
    function renderLists(){
        const all=visibleHistory(),rows=all.slice(0,recordLimit),ids=new Set(rows.map(w=>w.id)),host=$('works-list'),existing=new Map([...host.children].map(el=>[el.dataset.id,el]));
        if(!opened||!ids.has(opened.id)){$('record-detail').hidden=true;if($('record-detail').parentElement!==document.querySelector('main'))document.querySelector('main').append($('record-detail'));}
        for(const el of [...host.children])if(!ids.has(el.dataset.id))el.remove();
        for(let at=0;at<rows.length;at++){
            const w=rows[at];let r=existing.get(w.id);
            if(!r){r=node('article',undefined,'history-row');r.dataset.id=w.id;r.addEventListener('click',event=>{if(event.target.closest('button,a,input,textarea,select,audio,video,summary,[contenteditable]')||window.getSelection()?.isCollapsed===false)return;void openWork(w.id).catch(failure);});const head=node('div',undefined,'record-head'),mark=node('span',undefined,'file-mark');mark.append(icon(w.kind));const main=node('div',undefined,'record-main'),text=button('expand',()=>openWork(w.id),'record-input-preview record-summary'),sources=node('div',undefined,'record-input-assets'),meta=node('div',undefined,'record-meta');meta.append(node('span','','record-status'),node('span','','record-result-count help'),node('time','','meta'));main.append(text,sources,meta,node('p','','record-failure-summary'));
                const more=button('moreActions',()=>recordMenu(more,w.id),'history-menu-trigger');more.innerHTML=window.uiIconHtml('more-horizontal');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');head.append(mark,main,more);r.append(head);host.append(r);}
            if(host.children[at]!==r)host.insertBefore(r,host.children[at]);
            const expanded=opened?.id===w.id,summary=r.querySelector('.record-summary'),status=r.querySelector('.record-status'),content=expanded?opened.brief||w.summary||w.title||t(w.kind):w.summary||w.title||t(w.kind);if(summary.textContent!==content)summary.textContent=content;if(expanded)summary.id='record-brief';else summary.removeAttribute('id');summary.title=t(expanded?'collapse':'expand');summary.setAttribute('aria-expanded',String(expanded));summary.setAttribute('aria-controls','record-detail');r.querySelector('.history-menu-trigger').setAttribute('aria-label',t('moreActions')+' '+(w.summary||w.title||t(w.kind)));const count=r.querySelector('.record-result-count');const resultCount=works.has(w.id)?works.get(w.id).results.length:w.resultAssetIds?.length||0;count.hidden=!resultCount;count.textContent=t('results')+' '+resultCount;
            r.classList.toggle('is-expanded',expanded);const failure=r.querySelector('.record-failure-summary');failure.textContent=taskFailure(works.get(w.id)?.jobs[0]||w)||plainFailure(m.failureText(works.get(w.id)?.jobs[0]))||w.failureText||'';failure.hidden=expanded||w.status!=='failed'||!failure.textContent;
            status.id=at===0?'job-status':'';status.setAttribute('role','status');status.textContent=w.collectionError?t('resultSaveFailed'):w.collectionPending?t('savingResult'):w.status?t('status_'+w.status):t('draftStatus');status.className='record-status'+(['submitting','submitted','running'].includes(w.status)?' is-pending':'');status.dataset.status=w.collectionError?'failed':w.status||'draft';r.querySelector('time').textContent=w.updatedAt?new Date(w.updatedAt).toLocaleString(locale):'';
            const sources=r.querySelector('.record-input-assets'),sourceKey=locale+':'+expanded+':'+(w.assetIds||[]).join(',');if(expanded)sources.id='record-assets';else sources.removeAttribute('id');if(sources.dataset.key!==sourceKey){sources.replaceChildren(...(w.assetIds||[]).slice(0,expanded?19:3).map(id=>attachment(index.assets.find(a=>a.id===id),id)));if(!expanded&&w.assetIds?.length>3)sources.append(button('expand',()=>openWork(w.id),'text-button'));sources.dataset.key=sourceKey;}
            if(expanded){const detail=$('record-detail');if(detail.parentElement!==r)r.append(detail);detail.hidden=false;}
        }
        if(menuTrigger&&!menuTrigger.isConnected)closeRecordMenu();renderTask();$('empty-works').hidden=!!all.length;$('work-count').textContent=String(all.length);$('show-more').hidden=rows.length>=all.length;$('show-more').disabled=!active||managing;
    }
    function render(){
        closeMaterialMenu();closeRecordMenu();
        document.body.setAttribute('aria-busy',String(!active));
        for(const el of document.querySelectorAll('button,input,textarea'))el.disabled=!active;
        document.documentElement.lang=locale;document.documentElement.dir=locale==='ar'?'rtl':'ltr';document.title=t('title');
        notice(noticeKey,noticeError);$('save-state').textContent=savedDraft?.owner===current&&savedDraft.revision===current.revision?t('saved'):'';
        for(const el of document.querySelectorAll('[data-t]'))el.textContent=t(el.dataset.t);renderSaveFeedback();
        for(const id of ['media-close','library-detail-close']){$(id).setAttribute('aria-label',t('close'));$(id).title=t('close');}$('add-material').innerHTML=window.uiIconHtml('plus');$('add-material').setAttribute('aria-label',t('upload'));$('add-material').title=t('upload');for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=window.uiIconHtml(el.dataset.icon);
        for(const b of document.querySelectorAll('.media-tabs button')){if(b.dataset.kind)b.hidden=!kinds.includes(b.dataset.kind);const chosen=inLibrary?b.id==='nav-library':b.dataset.kind===current.kind;b.setAttribute('aria-current',chosen?'page':'false');b.setAttribute('aria-selected',String(chosen));b.tabIndex=chosen?0:-1;if(b.dataset.kind)b.prepend(icon(b.dataset.kind));}
        const libraryMark=node('span');libraryMark.innerHTML=window.uiIconHtml('layers');$('nav-library').prepend(libraryMark);$('library-filters').setAttribute('aria-label',t('library'));
        document.querySelector('.media-tabs').setAttribute('aria-label',t('title'));document.body.dataset.media=current.kind;for(const control of selects.values())control.close();document.querySelector('.brief-panel').setAttribute('aria-label',t(current.kind==='copy'?'coreContent':'requirements'));$('brief').setAttribute('aria-label',t(current.kind==='copy'?'coreContent':'requirements'));
        $('create-page').setAttribute('aria-labelledby','nav-'+current.kind);
        $('create-page').hidden=inLibrary;$('library-page').hidden=!inLibrary;document.querySelector('.page-head').hidden=inLibrary;
        for(const el of document.querySelectorAll('[data-placeholder]'))el.placeholder=t(el.dataset.placeholder);
        $('page-title').textContent=t(current.kind+'Heading');$('page-description').textContent=t(current.kind+'Description');
        $('brief').value=current.brief;$('brief').placeholder=t(current.kind+'Placeholder');
        renderConfirmation();
        renderControls();renderLists();if(inLibrary)renderLibrary();renderLibraryEditor();
    }
    function clearMedia(){
        mediaEpoch++;for(const el of $('media-content').querySelectorAll('audio,video')){el.pause();el.removeAttribute('src');el.load();}
        $('media-content').replaceChildren();if(mediaUrl){URL.revokeObjectURL(mediaUrl);mediaUrl=null;}mediaAsset=null;
    }
    async function showMedia(a){
        if(!active||!a)return;
        const shared=null;clearMedia();mediaAsset=a;const epoch=mediaEpoch,dialog=$('media-preview'),host=$('media-content');
        $('media-name').textContent=a.name;$('media-retry').hidden=true;host.textContent=t('loading');if(!dialog.open)dialog.showModal();
        try{
            const ext=a.name.split('.').pop().toLowerCase(),text=['txt','md','json','srt','vtt'].includes(ext);
            if(a.kind==='document'&&!text){host.textContent=t('previewUnsupported');return;}
            if(text&&a.bytes>2*1024*1024){host.textContent=t('previewUnsupported');return;}
            const reply=shared?null:await api.appFiles.readBase64({path:a.path,scope:'cloud'});if(epoch!==mediaEpoch||!dialog.open)return;
            const bytes=shared?null:reply?.base64?decode(reply.base64):null;if(!shared&&!bytes)throw Error('FILE');
            if(text){host.replaceChildren(node('pre',new TextDecoder('utf-8',{fatal:true}).decode(bytes)));return;}
            const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',svg:'image/svg+xml',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',opus:'audio/ogg'};
            mediaUrl=URL.createObjectURL(shared||new Blob([bytes],{type:types[ext]}));const media=node(a.kind==='image'?'img':a.kind);media.src=mediaUrl;
            if(a.kind==='image')media.alt=a.name;else{media.controls=true;media.preload='metadata';}
            media.addEventListener('error',()=>{if(epoch===mediaEpoch&&dialog.open)mediaFailure(Error('FILE'));},{once:true});host.replaceChildren(media);
        }catch(error){if(epoch===mediaEpoch&&dialog.open)mediaFailure(error);}
    }
    function mediaFailure(error){$('media-content').textContent=t('previewFailed');$('media-retry').hidden=false;}
    function decode(base64){const text=atob(base64),bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes;}
    async function digest(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
    function libraryLocked(){return !active||libraryBusy||navigating||managing||submitting||importing;}
    function setLibraryFilter(value){
        if(value!==libraryFilter){librarySelection.clear();libraryFilter=value;}
    }
    function renderLibraryControls(){
        const locked=libraryLocked(),count=librarySelection.size;
        for(const id of ['add-prompt','library-upload','library-search','library-more','clear-selection'])$(id).disabled=locked;
        $('library-upload').textContent=t(importing&&inLibrary?'importingMaterials':'upload');
        $('nav-library').disabled=locked;$('library-selection').hidden=!count;
        $('library-selected-count').textContent=t('selectedMaterials').replace('{count}',String(count));
        $('remove-selection').disabled=locked||!count;$('save-selection').disabled=locked||count<2;$('save-selection').title=count<2?t('combinationMinimum'):'';$('use-selection').disabled=locked||!count;
        select('library-target',kinds.map(value=>({value,label:t(value)})),libraryTarget,t('useFor'),locked,value=>{libraryTarget=value;});
        for(const b of document.querySelectorAll('[data-filter]')){b.disabled=locked;b.setAttribute('aria-pressed',String(b.dataset.filter===libraryFilter));}
        for(const card of $('library-list').children){const check=card.querySelector('input');check.disabled=locked;check.checked=librarySelection.has(card.dataset.key);card.classList.toggle('is-selected',check.checked);for(const b of card.querySelectorAll('button'))b.disabled=locked;}
        extension.render?.({work:current,locked:locked||!editable(),inLibrary,selectedAssets:selectedProductAssets()});
    }
    async function openLibrary(){
        if(libraryLocked())return;navigating=true;renderControls();
        try{await flush();inLibrary=true;libraryTarget=current.kind;notice('');}
        finally{navigating=false;render();window.scrollTo(0,0);}
    }
    function libraryItems(){
        return [...index.library.map(e=>({...e,key:'entry:'+e.id})),...m.libraryAssets(index).map(a=>({...a,type:a.kind,key:'asset:'+a.id,assetIds:[a.id],brief:''}))];
    }
    function renderLibrary(){
        if(!inLibrary)return;
        const query=$('library-search').value.trim().toLocaleLowerCase(locale),assets=new Map(index.assets.map(a=>[a.id,a]));
        const rows=libraryItems().filter(e=>(libraryFilter==='all'||e.type===libraryFilter||libraryFilter==='copy'&&['prompt','document'].includes(e.type))&&(!query||(e.name+'\n'+e.brief).toLocaleLowerCase(locale).includes(query))).sort((a,b)=>(b.updatedAt||b.createdAt||'').localeCompare(a.updatedAt||a.createdAt||''));
        $('library-list').replaceChildren();
        for(const item of rows.slice(0,libraryLimit)){
            const card=node('div',undefined,'library-card');card.dataset.key=item.key;
            const check=node('input');check.type='checkbox';check.setAttribute('aria-label',t('selectMaterial')+' '+item.name);check.addEventListener('change',()=>{if(check.checked)librarySelection.add(item.key);else librarySelection.delete(item.key);renderLibraryControls();});
            const head=node('div',undefined,'library-card-head'),open=button('preview',()=>showLibraryItem(item),'library-preview'),mark=node('span',undefined,'library-mark');
            const first=item.type==='image'?item:assets.get(item.assetIds[0]);mark.append(icon(first?.kind||'document'));if(first?.thumbnailPath)thumbnail(first,mark);
            const title=node('strong',item.name);open.replaceChildren(mark,title);open.setAttribute('aria-label',t('preview')+' '+item.name);head.append(check,open);
            const summary=node('p',item.brief||t(item.type==='document'?'prompts':item.type),'library-summary');
            if(item.type==='bundle'){summary.textContent=[item.brief?t('prompts'):'',item.assetIds.length?t('filesCount').replace('{count}',String(item.assetIds.length)):''].filter(Boolean).join(' · ');}
            const actions=node('div',undefined,'library-card-actions');
            if(item.key.startsWith('entry:'))actions.append(button('edit',()=>openLibraryEditor(item.type,item,item),'text-button'));
            actions.append(button('remove',()=>removeLibraryItems([item.key]),'text-button danger'),button('useMaterial',()=>useLibrary([item.key]),'library-use'));
            const details=node('div',undefined,'library-card-summary');details.append(summary,savedHint(item.key));card.append(head,details,actions);$('library-list').append(card);
        }
        $('library-empty').hidden=!!rows.length;$('library-empty').textContent=t(query?'noMaterialsFound':'emptyLibrary');$('library-more').hidden=rows.length<=libraryLimit;
        renderLibraryControls();
    }
    async function showLibraryItem(item){
        if(libraryLocked())return;
        if(item.key.startsWith('asset:'))return showMedia(item);
        libraryDetail=item;$('library-detail-name').textContent=item.name;$('library-detail-brief').textContent=item.brief;$('library-detail-brief').hidden=!item.brief;
        $('library-detail-assets').replaceChildren(...item.assetIds.map(id=>attachment(index.assets.find(a=>a.id===id),id)));
        $('library-detail').showModal();
    }
    function openLibraryEditor(type,content={brief:'',assetIds:[]},entry=null){
        if(libraryLocked())return;
        if(type==='bundle'&&!entry&&m.materialCount(content)<2){const error=Error('COMBINATION');error.userMessageKey='combinationMinimum';throw error;}
        libraryEdit={textParts:content.textParts||1,existing:!!entry,id:entry?.id||crypto.randomUUID(),type,assetIds:[...content.assetIds],createdAt:entry?.createdAt||new Date().toISOString()};
        $('library-name').value=entry?.name||(content.brief.trim().split('\n')[0]||index.assets.find(a=>a.id===content.assetIds[0])?.name||'').slice(0,80);
        $('library-brief').value=content.brief;$('library-edit-error').textContent='';
        $('library-edit-assets').replaceChildren(...content.assetIds.map(id=>attachment(index.assets.find(a=>a.id===id),id)));
        renderLibraryEditor();$('library-editor').showModal();$('library-name').focus();$('library-name').select();
    }
    function renderLibraryEditor(){
        if(!libraryEdit)return;$('library-edit-title').textContent=t(index.library.some(e=>e.id===libraryEdit.id)?'edit':libraryEdit.type==='prompt'?'addPrompt':'saveBundle');
        for(const id of ['library-name','library-brief','library-save','library-edit-cancel'])$(id).disabled=libraryBusy||!active;
    }
    async function saveLibraryEntry(){
        if(!libraryEdit||libraryBusy||!active)return;
        if(!$('library-name').value.trim()||!$('library-brief').value.trim()&&!libraryEdit.assetIds.length){$('library-edit-error').textContent=t('materialRequired');return;}
        if(index.library.length>=1000&&!index.library.some(e=>e.id===libraryEdit.id)){ $('library-edit-error').textContent=t('limit');return;}
        const {textParts,existing,...fields}=libraryEdit,values={...fields,name:$('library-name').value.trim(),brief:$('library-brief').value,updatedAt:new Date().toISOString()};
        if(values.type==='bundle'&&!existing&&m.materialCount({...values,textParts})<2){$('library-edit-error').textContent=t('combinationMinimum');return;}
        const entry=m.libraryEntry(values);
        libraryBusy=true;renderControls();renderLibraryEditor();
        try{
            await enqueue(async()=>{const previous=index.library;index.library=[entry,...previous.filter(e=>e.id!==entry.id)];try{await writeIndex();}catch(error){index.library=previous;throw error;}});
            $('library-editor').close();libraryEdit=null;notice('');savedAt('entry:'+entry.id);if(inLibrary){setLibraryFilter(entry.type==='prompt'?'copy':entry.type);$('library-search').value='';libraryLimit=48;renderLibrary();}
        }catch(error){$('library-edit-error').textContent=t('notSaved');}
        finally{libraryBusy=false;renderControls();renderLibraryEditor();}
    }
    function saveSelection(){
        try{openLibraryEditor('bundle',m.libraryContent(index,[...librarySelection],true));}catch(error){error.userMessageKey=error.message==='COMBINATION'?'combinationMinimum':error.message==='SOURCE'?'fileMissing':'selectionLimit';throw error;}
    }
    async function useLibrary(keys=[...librarySelection]){
        if(libraryLocked()||!keys.length)return;
        let content;try{content=m.libraryContent(index,keys);}catch(error){error.userMessageKey=error.message==='SOURCE'?'fileMissing':'selectionLimit';throw error;}
        const base=libraryTarget===current.kind&&!current.jobs.length?current:draft(libraryTarget);
        navigating=true;renderControls();
        try{
            let next;try{next=m.applyLibrary(base,content);}catch(error){error.userMessageKey='selectionLimit';throw error;}
            await flush();await storeDraft(next);current=next;opened=null;inLibrary=false;librarySelection.clear();$('brief').style.removeProperty('height');notice('');
        }finally{navigating=false;renderControls();if(!inLibrary){render();window.scrollTo(0,0);$('brief').focus();}}
    }
    async function removeLibraryItems(keys){
        if(libraryLocked()||!keys.length)return;
        const selected=new Set(keys),items=libraryItems().filter(item=>selected.has(item.key));if(!items.length)return;
        libraryBusy=true;renderControls();
        try{
            const detail=items.length===1?items[0].name:t('selectedMaterials').replace('{count}',String(items.length));
            if(!await confirmAction('remove','removeMaterialConfirm','remove',detail,true))return;
            const entryIds=new Set(items.filter(item=>item.key.startsWith('entry:')).map(item=>item.id)),assetIds=new Set(items.filter(item=>item.key.startsWith('asset:')).map(item=>item.id));
            await enqueue(async()=>{
                const before=index.library,assets=index.assets.filter(a=>assetIds.has(a.id)).map(a=>({asset:a,hidden:a.libraryHidden}));
                index.library=before.filter(e=>!entryIds.has(e.id));for(const {asset}of assets)asset.libraryHidden=true;
                try{await writeIndex();}catch(error){index.library=before;for(const {asset,hidden}of assets){if(hidden===undefined)delete asset.libraryHidden;else asset.libraryHidden=hidden;}throw error;}
            });
            for(const item of items)librarySelection.delete(item.key);notice('');renderLibrary();
        }finally{libraryBusy=false;renderControls();}
    }
    async function addImportedMaterial(owner,file,read){
        // Validate metadata before decoding or allocating the selected file's bytes.
        if(index.assets.length>=1000||owner&&owner.assetIds.length>=19)throw Error('LIMIT');
        const id=crypto.randomUUID(),ext=file.name.split('.').pop().toLowerCase(),candidate=m.asset({id,name:file.name,path:'media/'+id+'.'+ext,bytes:file.size,createdAt:new Date().toISOString()});
        const base64=await read(),bytes=decode(base64);if(bytes.length!==candidate.bytes)throw Error('FILE');
        const hash=await digest(bytes);let a=index.assets.find(a=>a.digest===hash&&a.kind===candidate.kind);
        if(!a){
            a={...candidate,digest:hash};await api.appFiles.writeBase64({path:a.path,base64,scope:'cloud'});await makeThumbnail(a,base64);
            await enqueue(async()=>{index.assets.push(a);try{await writeIndex();}catch(error){index.assets=index.assets.filter(x=>x.id!==a.id);throw error;}});
        }else{
            // A matching index entry can outlive its device-local bytes or library card.
            // The explicit new selection restores those same bytes without another identity.
            await api.appFiles.writeBase64({path:a.path,base64,scope:'cloud'});
            if(a.libraryHidden||a.origin&&a.libraryHidden!==false)await enqueue(async()=>{const previous=a.libraryHidden;a.libraryHidden=false;try{await writeIndex();}catch(error){if(previous===undefined)delete a.libraryHidden;else a.libraryHidden=previous;throw error;}});
        }
        if(owner&&!owner.jobs.length&&!owner.assetIds.includes(a.id)){
            const before=[...owner.assetIds];owner.assetIds.push(a.id);const revision=++owner.revision;
            draftChanges.add(owner);if(current===owner)$('save-state').textContent='';
            try{if(owner.id)await persist(owner);else{index.drafts[owner.kind]=JSON.parse(JSON.stringify(owner));await persistIndex();}}
            catch(error){owner.assetIds=before;if(!owner.id)index.drafts[owner.kind]=JSON.parse(JSON.stringify(owner));throw error;}
            draftSaved(owner,revision);
        }
        renderControls();renderLists();
    }
    function importFile(toLibrary=false){
        if((toLibrary?libraryLocked():!editable())||importing)return;
        pickerToLibrary=toLibrary;pickerOwner=toLibrary?null:current;$('material-picker').value='';$('material-picker').click();
    }
    function readBrowserFile(file){
        return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const value=reader.result,at=typeof value==='string'?value.indexOf(','):-1;if(at<0||!value.slice(0,at).endsWith(';base64'))reject(Error('FILE'));else resolve(value.slice(at+1));};reader.onerror=reader.onabort=()=>reject(Error('READ'));reader.readAsDataURL(file);});
    }
    async function importMaterials(files,toLibrary=false,owner=toLibrary?null:current){
        if((toLibrary?libraryLocked():!editable())||importing||!toLibrary&&inLibrary){if(!toLibrary)notice('importingMaterials',true);return;}
        let failed=false;importing=true;renderControls();
        try{
            // Picker, clipboard and drop imports read one validated file at a time.
            for(const file of files){
                if(owner&&owner.assetIds.length>=19||index.assets.length>=1000){failed=true;break;}
                try{await addImportedMaterial(owner,file,()=>readBrowserFile(file));}
                catch(error){failed=true;}
            }
            if(toLibrary){setLibraryFilter('all');$('library-search').value='';renderLibrary();}
            notice(failed?'importMaterialsFailed':'',failed);
        }finally{importing=false;renderControls();}
    }
    function bindMaterialTransfer(){
        const area=document.querySelector('.brief-panel');
        const hasFiles=data=>!!data&&(data.files?.length||Array.from(data.types||[]).includes('Files'));
        const clear=()=>{area.classList.remove('is-dragover');$('drop-materials').hidden=true;};
        $('brief').addEventListener('paste',event=>{if(!event.clipboardData?.files?.length)return;event.preventDefault();void importMaterials(Array.from(event.clipboardData.files)).catch(failure);});
        for(const type of ['dragenter','dragover'])area.addEventListener(type,event=>{if(!hasFiles(event.dataTransfer))return;event.preventDefault();const allowed=editable()&&!importing&&!inLibrary;event.dataTransfer.dropEffect=allowed?'copy':'none';area.classList.toggle('is-dragover',allowed);$('drop-materials').hidden=!allowed;});
        area.addEventListener('dragleave',event=>{if(!area.contains(event.relatedTarget))clear();});
        area.addEventListener('drop',event=>{clear();if(!hasFiles(event.dataTransfer))return;event.preventDefault();void importMaterials(Array.from(event.dataTransfer.files)).catch(failure);});
        // A file that misses the composer must not navigate away from the draft.
        for(const type of ['dragover','drop'])window.addEventListener(type,event=>{
            if(!hasFiles(event.dataTransfer))return;
            if(type==='dragover'&&!event.defaultPrevented)event.dataTransfer.dropEffect='none';
            event.preventDefault();
        });
        window.addEventListener('blur',clear);window.addEventListener('dragend',clear);
    }
    async function adopt(w,name,base64,origin,savedPath){
        if(removedWorks.has(w.id))return;const bytes=decode(base64),hash=await digest(bytes);
        let a=index.assets.find(a=>a.origin?.requestId===origin.requestId&&a.origin.kind===origin.kind&&a.origin.outputId===origin.outputId&&a.digest===hash);
        if(!a){if(index.assets.length>=1000)throw Error('LIMIT');const id=crypto.randomUUID(),ext=m.mediaKind(name)?name.split('.').pop().toLowerCase():'bin';a=m.asset({id,name,path:savedPath||'media/'+id+'.'+ext,bytes:bytes.length,digest:hash,origin,libraryHidden:true,createdAt:new Date().toISOString()});if(!savedPath)await api.appFiles.writeBase64({path:a.path,base64,scope:'cloud'});await makeThumbnail(a,base64);if(removedWorks.has(w.id))return;index.assets.push(a);await persistIndex();}
        if(removedWorks.has(w.id))return;const prior=JSON.parse(JSON.stringify(w.results));m.accept(w,a);const result=w.results.find(r=>r.assetId===a.id&&r.requestId===origin.requestId);if(result&&origin.version)result.version=origin.version;w.updatedAt=new Date().toISOString();
        try{await persist(w);}catch(error){w.results=prior;throw error;}
    }
    async function collectOutputs(w){
        if(removedWorks.has(w.id))return;const job=w.jobs[0];if(!job||['submitting','submitted','running','saving','unknown'].includes(job.status))return;
        if((w.collectionFailures||0)>=3)return;
        const outputs=m.uncollected(w).slice(0,2),needsReply=m.needsReply(w);
        if(!outputs.length&&!needsReply&&!w.collectionError)return;
        try{
            for(const output of outputs){
                if(removedWorks.has(w.id))return;if(output.bytes>(m.mediaKind(output.name)==='image'?20:200)*1024*1024)throw Error('LIMIT');
                const result=await api.tasks.output({requestId:job.requestId,outputId:output.id});if(result.name!==output.name)throw Error('FILE');
                await adopt(w,output.name,result.base64,{requestId:job.requestId,outputId:output.id,...output.version?{version:output.version}:{}},output.path);
            }
            if(needsReply){const bytes=new TextEncoder().encode(job.text);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);await adopt(w,'reply.txt',btoa(binary),{requestId:job.requestId,kind:'reply'});}
            w.collectionError=false;w.collectionFailures=0;await persist(w);
        }catch(error){if(removedWorks.has(w.id))return;w.collectionError=true;w.collectionFailures=(w.collectionFailures||0)+1;await persist(w);}
    }
    async function start(){
        if(!editable()||!m.canStart(current)||!serviceAvailable(current))return;const w=current;
        if(!w.brief.trim()){notice('emptyBrief',true);return;}
        if(!agents.some(a=>a.id===m.agents[w.kind])){notice('agentMissing',true);return;}
        submitting=true;notice('');renderControls();renderLists();
        try{
            const requestId=crypto.randomUUID(),request=m.request(w,index.assets,requestId);
            if(extension.prepareRequest)Object.assign(request.brief,await extension.prepareRequest(w));await saveDraft(w);
            const briefPath='requests/'+requestId+'.json';await api.appFiles.writeText({path:briefPath,text:JSON.stringify(request.brief),scope:'cloud'});
            const job={requestId,status:'submitting',text:'',outputs:[]};w.jobs.push(job);
            try{await persist(w);}catch(error){
                // No task has been dispatched; restore an explicitly retryable draft.
                w.jobs=[];try{await persist(w);}catch(recovery){}throw error;
            }
            if(current===w){opened=null;current={...m.draft(w.kind,locale),...w.productId?{productId:w.productId}:{}};if(w.settings.serviceId){current.settings.serviceId=w.settings.serviceId;current.settings.serviceName=w.settings.serviceName;}index.drafts[w.kind]=JSON.parse(JSON.stringify(current));render();$('works-list').firstElementChild?.scrollIntoView({block:'nearest'});}
            try{await api.tasks.start({requestId,title:m.displayTitle(w)||t(w.kind),agentId:request.agentId,prompt:request.prompt,deliverable:['txt','srt','json'].includes(w.settings.format)?'text':w.kind,...request.output?{output:request.output}:{},...request.media?{media:request.media}:{},files:[briefPath,...request.files]});job.status='submitted';}
            catch(error){job.status='unknown';}
            await persist(w);if(opened===w)renderTask();void refresh(w).catch(failure);
        }finally{submitting=false;renderControls();renderLists();}
    }
    async function refresh(w=opened){
        const job=w?.jobs[0];if(!job||reading.has(w.id))return;reading.add(w.id);
        try{const before=JSON.stringify(job),result=await api.tasks.get({requestId:job.requestId});m.inspect(w,job,result);if(JSON.stringify(job)!==before){w.updatedAt=new Date().toISOString();await persist(w);}await collectOutputs(w);if(opened===w)renderTask();}
        finally{reading.delete(w.id);}
    }
    async function editRecord(id){
        if(!active||navigating||submitting||managing||importing)return;
        const source=await loadWork(id),next={...m.draft(source.kind,locale),brief:source.brief,settings:JSON.parse(JSON.stringify(source.settings)),assetIds:[...source.assetIds],sourceWorkId:source.id,...source.productId?{productId:source.productId}:{}};
        navigating=true;renderControls();try{if(hasContent(current)&&!await confirmAction('edit','replaceConfirm','edit'))return;await flush();await storeDraft(next);current=next;opened=null;}finally{navigating=false;render();}$('brief').scrollIntoView({block:'center'});$('brief').focus();
    }
    async function manageHistory(action){
        if(!active||managing||navigating||submitting)return;managing=true;renderControls();renderLists();
        try{await flush();await action();}finally{managing=false;renderControls();renderLists();}
    }
    async function removeWork(id){return manageHistory(async()=>{
        const record=index.works.find(w=>w.id===id);if(!removable(record))return;
        if(!await confirmAction('removeWork','removeConfirm','removeWork',record.title||t('works'),true))return;
        removedWorks.add(id);
        try{await enqueue(async()=>{const before=index.works;index.works=index.works.filter(x=>x.id!==id);try{await writeIndex();}catch(error){index.works=before;throw error;}});}catch(error){removedWorks.delete(id);throw error;}
        works.delete(id);moreFilesOpen.delete(id);
        if(current.id===id)current=draft(current.kind);if(opened?.id===id){opened=null;}
        notice('');render();await api.appFiles.remove({path:'works/'+id+'.json',scope:'cloud'});
    });}
    for(const b of document.querySelectorAll('[data-kind]'))b.addEventListener('click',()=>newWork(b.dataset.kind).catch(failure));
    bindMaterialTransfer();
    $('material-picker').addEventListener('change',()=>{const files=Array.from($('material-picker').files||[]),toLibrary=pickerToLibrary,owner=pickerOwner;$('material-picker').value='';pickerOwner=null;if(files.length)void importMaterials(files,toLibrary,owner).catch(failure);});
    $('brief').addEventListener('input',()=>{if(!editable())return;current.brief=$('brief').value;touch();$('submit').disabled=importing||!agents.some(a=>a.id===m.agents[current.kind])||!current.brief.trim()||!serviceAvailable(current);});
    document.querySelector('.media-tabs').addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229)return;const buttons=[...document.querySelectorAll('.media-tabs button')].filter(b=>!b.hidden),at=buttons.indexOf(event.target);if(at<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const step=(event.key==='ArrowRight'?1:-1)*(locale==='ar'?-1:1),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+step+buttons.length)%buttons.length;buttons[next].focus();buttons[next].click();});
    $('duration').addEventListener('input',()=>{const value=$('duration').value===''?null:Number($('duration').value);if(!editable()||value!==null&&(!Number.isInteger(value)||value<1||value>7200))return;current.settings.duration=value;touch();});
    $('duration').addEventListener('blur',()=>{$('duration').value=current.settings.duration??'';});
    const actions={'submit':start,'reset-work':resetWork,'upload':()=>{closeMaterialMenu();return importFile();},'nav-library':openLibrary,'open-library':()=>{closeMaterialMenu();return openLibrary();},'add-prompt':()=>openLibraryEditor('prompt'),'library-upload':()=>importFile(true),'save-selection':saveSelection,'remove-selection':()=>removeLibraryItems([...librarySelection]),'use-selection':()=>useLibrary()};
    for(const[id,fn]of Object.entries(actions))$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(failure));
    $('add-material').addEventListener('click',()=>{$('material-menu').hidden?openMaterialMenu():closeMaterialMenu(true);});
    $('add-material').addEventListener('keydown',event=>{if(event.isComposing||!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();openMaterialMenu(event.key==='ArrowUp');});
    $('material-menu').addEventListener('keydown',event=>{
        if(event.isComposing)return;
        if(event.key==='Escape'){event.preventDefault();closeMaterialMenu(true);return;}
        if(event.key==='Tab'){closeMaterialMenu(true);return;}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();const items=[...$('material-menu').querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
    });
    document.addEventListener('pointerdown',event=>{if(!$('material-menu').contains(event.target)&&!$('add-material').contains(event.target))closeMaterialMenu();});
    window.addEventListener('resize',()=>closeMaterialMenu());window.addEventListener('scroll',event=>{if(!$('material-menu').contains(event.target))closeMaterialMenu();},true);
    $('record-menu').addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==='Escape'){event.preventDefault();closeRecordMenu(true);return;}if(event.key==='Tab'){closeRecordMenu(true);return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=[...$('record-menu').querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();});
    document.addEventListener('pointerdown',event=>{if(!$('record-menu').contains(event.target)&&!menuTrigger?.contains(event.target))closeRecordMenu();});
    window.addEventListener('resize',()=>closeRecordMenu());window.addEventListener('scroll',event=>{if(!$('record-menu').contains(event.target))closeRecordMenu();},true);
    $('library-search').addEventListener('input',()=>{libraryLimit=48;renderLibrary();});
    for(const b of document.querySelectorAll('[data-filter]'))b.addEventListener('click',()=>{setLibraryFilter(b.dataset.filter);libraryLimit=48;renderLibrary();});
    $('clear-selection').addEventListener('click',()=>{librarySelection.clear();renderLibraryControls();});
    $('library-more').addEventListener('click',()=>{libraryLimit+=48;renderLibrary();});
    $('library-edit-form').addEventListener('submit',event=>{event.preventDefault();void saveLibraryEntry().catch(failure);});
    $('library-edit-cancel').addEventListener('click',()=>$('library-editor').close());
    $('library-editor').addEventListener('cancel',event=>{if(libraryBusy)event.preventDefault();});
    $('library-editor').addEventListener('close',()=>{libraryEdit=null;});
    $('library-detail-close').addEventListener('click',()=>$('library-detail').close());
    $('library-detail-edit').addEventListener('click',()=>{const item=libraryDetail;$('library-detail').close();openLibraryEditor(item.type,item,item);});
    $('library-detail-use').addEventListener('click',()=>{const key=libraryDetail.key;$('library-detail').close();void useLibrary([key]).catch(failure);});
    $('media-close').addEventListener('click',()=>$('media-preview').close());
    $('media-preview').addEventListener('close',clearMedia);
    $('media-retry').addEventListener('click',()=>showMedia(mediaAsset));
    $('show-more').addEventListener('click',()=>{recordLimit+=12;renderLists();});
    $('refresh-services').addEventListener('click',()=>{void loadServices(current.kind,true,true);renderControls();});
    $('refresh-agents').addEventListener('click',()=>api.tasks.agents().then(result=>{agents=result.agents;renderControls();}).catch(failure));
    window.addEventListener('pagehide',()=>{clearMedia();for(const entry of thumbCache.values())void entry.then(url=>{if(url)URL.revokeObjectURL(url);});thumbCache.clear();});
    async function language(){const context=await api.host.getContext();const next=context.language;if(window.ContentLocales[next]&&next!==locale){locale=next;dictionary=window.ContentLocales[locale];render();}}
    try{
        const context=await api.host.getContext();locale=window.ContentLocales[context.language]?context.language:'en';dictionary=window.ContentLocales[locale];
        index=m.readIndex((await api.storage.get({key:KEY,scope:'cloud'})).value);current=draft(kinds[0]);
        try{agents=(await api.tasks.agents()).agents;}catch(error){agents=[];}
        active=true;
        extension.ready?.({
            async open({kind,productId,library}={}){
                if(!editable()||importing)return false;
                await newWork(kind||current.kind);
                if(productId!==undefined){current.productId=productId;touch();await flush();}
                if(library)await openLibrary();else render();return true;
            },
            productId:()=>current.productId||'',
            owner:()=>current,
            associate(value){if(!editable()||importing)return;current.productId=value;touch();renderControls();},
            filter(value){if(value!==undefined){productFilter=value;recordLimit=12;renderLists();}return productFilter;},
            async importMaterial(file,owner=current){
                if(!editable()||importing||owner!==current)throw Error('SOURCE');
                importing=true;renderControls();
                // Native app-file reads are canonical base64. Validate the encoded
                // byte count before the importer allocates its one decoded buffer.
                const size=file.base64.length/4*3-(file.base64.endsWith('==')?2:file.base64.endsWith('=')?1:0);
                try{await addImportedMaterial(owner,{name:file.name,size},async()=>file.base64);}
                finally{importing=false;renderControls();}
            },
            async assign(run){
                if(libraryLocked())return;
                const selected=selectedProductAssets();if(!current.productId||!selected.length||selected.some(a=>!['image','video'].includes(a.kind)))throw Error('SOURCE');
                libraryBusy=true;renderControls();try{await run(selected.map(m.asset));}finally{libraryBusy=false;renderControls();}
            },
            fail:()=>notice('error',true),async refresh(){await language();renderControls();renderLists();},flush
        });
        render();
        let polling=false;setInterval(async()=>{if(!active||polling)return;polling=true;try{const rows=index.works.filter(w=>pending.includes(w.status)||(w.collectionPending||!w.autoSaved&&w.status==='completed')&&(w.collectionFailures||0)<3);for(let count=0;count<Math.min(8,rows.length)&&active;count++){const row=rows[(pollCursor+count)%rows.length];try{await refresh(await loadWork(row.id));}catch(error){notice('error',true);}}pollCursor=rows.length?(pollCursor+8)%rows.length:0;}finally{polling=false;}},5000);
        window.addEventListener('focus',()=>{if(active)void language().then(()=>{if(!inLibrary){const refresh=modelsConfigured;modelsConfigured=false;void loadServices(current.kind,true,refresh);renderControls();}}).catch(error=>failure(error));});
    }catch(error){active=false;render();notice('dataUnavailable',true);}
})();
