/* Pure records. The host remains the authority for tasks, files and spending. */
(function (root) {
    'use strict';
    const operations = Object.freeze({
        copy: [],
        image: ['image-create', 'image-poster', 'image-product', 'image-edit', 'image-set', 'image-diagram', 'image-document', 'image-layered', 'image-process'],
        video: ['video-finished', 'video-edit', 'video-script', 'video-localize', 'video-highlights', 'video-cleanup', 'video-subtitles'],
        audio: ['audio-create', 'audio-narration', 'audio-music', 'audio-transcript', 'audio-denoise', 'audio-enhance', 'audio-silence', 'audio-edit', 'audio-mix', 'audio-separate', 'audio-extract', 'audio-convert']
    });
    const defaultKinds = Object.freeze(['image','video','audio']);
    const agents = Object.freeze({ copy:'173d4235a431', image: '814b61b027f0', video: '79df9cc89f5f', audio: '5f890bd72ac4' });
    const formats = Object.freeze({ png:'image',jpg:'image',jpeg:'image',webp:'image',gif:'image',avif:'image',svg:'image',mp4:'video',webm:'video',mov:'video',mp3:'audio',wav:'audio',ogg:'audio',opus:'audio',m4a:'audio',flac:'audio',aac:'audio',txt:'document',md:'document',json:'document',srt:'document',vtt:'document',pdf:'document',psd:'document' });
    const statuses = ['submitting', 'submitted', 'running', 'waiting_input', 'saving', 'completed', 'failed', 'stopped', 'unknown'];
    const clone = value => JSON.parse(JSON.stringify(value));
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
    const mediaKind = name => formats[String(name).split('.').pop().toLowerCase()] || null;
    function settings(s) {
        if(s?.serviceId!==undefined&&s.serviceId!==''&&!/^[a-f0-9]{32}$/.test(s.serviceId))throw Error('SETTINGS');
        if(s?.serviceName!==undefined&&(typeof s.serviceName!=='string'||s.serviceName.length>240))throw Error('SETTINGS');
        if (!s || !['any','1:1','4:5','9:16','16:9','3:2'].includes(s.aspect) || s.duration!==null&&(!Number.isInteger(Number(s.duration)) || Number(s.duration)<1 || Number(s.duration)>7200) || typeof s.language!=='string' || s.language.length>20 || !['any','png','jpg','webp','pdf','psd','mp4','wav','mp3','flac','m4a','aac','ogg','opus','txt','srt','json'].includes(s.format)) throw Error('SETTINGS');
    }
    function outputFormats(w) {
        if(w.kind==='copy')return ['txt'];
        const values=w.kind==='image'?['png','jpg','webp','pdf','psd']:w.kind==='video'?['mp4','txt','srt']:['wav','mp3','flac','m4a','aac','ogg','opus','txt','srt','json'];
        return ['any',...values];
    }
    function draft(kind, language, service) {
        if (!Object.hasOwn(operations, kind)) throw Error('KIND');
        const settings={aspect:kind==='video'?'9:16':'4:5',duration:kind==='audio'?null:30,language:language||'en',format:kind==='copy'?'txt':kind==='audio'?'wav':kind==='image'?'png':'mp4'};
        if(service?.serviceId){settings.serviceId=service.serviceId;settings.serviceName=service.serviceName;}
        return { schemaVersion:1,id:'',title:'',kind,operation:'auto',brief:'',settings,assetIds:[],jobs:[],results:[],sourceWorkId:'',revision:0,createdAt:'',updatedAt:'' };
    }
    function serviceLabel(service, language, kind) {
        if(service.provider==='orkas-api'&&service.model==='orkas-tts-1')return 'Orkas·Voice';
        if(kind==='video')return service.name;
        return (service.label?service.label+' · ':'')+service.name;
    }
    function selectFirstService(work, services, language) {
        if(work.jobs.length||work.settings.serviceId||['txt','srt','json'].includes(work.settings.format))return false;
        const selected=services.find(service=>service.available);
        if(!selected)return false;
        work.settings.serviceId=selected.id;work.settings.serviceName=serviceLabel(selected,language,work.kind).slice(0,240);return true;
    }
    const savedResultPath = value => typeof value==='string'&&/^results\/[a-f0-9]{64}\/[a-f0-9]{16}-[a-f0-9]{16}(?:\.[a-zA-Z0-9]{1,15})?$/.test(value);
    const maxAssetBytes = kind => (kind==='image'?20:200)*1024*1024;
    // Validate the selected file name and size before reading its bytes.
    function importProblem(name, bytes) {
        const kind = mediaKind(name);
        if (!kind) return 'FORMAT';
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxAssetBytes(kind)) return 'SIZE';
        return '';
    }
    function asset(value) {
        const generated=validId(value?.origin?.requestId)&&/^[a-f0-9]{64}$/.test(value?.origin?.outputId);
        const kind = mediaKind(value?.name)||(generated?'document':null);
        if (!kind || !validId(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 512 || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > maxAssetBytes(kind)) throw Error('FILE');
        if (typeof value.path !== 'string' || !/^media\/[a-zA-Z0-9_-]{1,64}\.[a-z0-9]{1,8}$/.test(value.path)&&!savedResultPath(value.path)) throw Error('FILE');
        if (value.libraryHidden!==undefined&&typeof value.libraryHidden!=='boolean')throw Error('FILE');
        if (value.digest && !/^[a-f0-9]{64}$/.test(value.digest)) throw Error('FILE');
        if (value.thumbnailPath!==undefined && (kind!=='image'||value.thumbnailPath!=='thumbnails/'+value.id+'.jpg')) throw Error('FILE');
        return { ...clone(value),kind };
    }
    function readWork(value, id) {
        if(value?.productId!==undefined&&value.productId!==''&&!validId(value.productId))throw Error('DATA');
        if (!value || value.schemaVersion!==1 || value.id!==id || !validId(id) || !(value.operation==='auto'&&Object.hasOwn(operations,value.kind)||operations[value.kind]?.includes(value.operation)) || typeof value.title!=='string' || value.title.length>160 || typeof value.brief!=='string' || value.brief.length>40000 || !value.settings || !Array.isArray(value.assetIds) || value.assetIds.length>19 || !value.assetIds.every(validId) || !Array.isArray(value.jobs) || value.jobs.length>1 || !Array.isArray(value.results) || value.results.length>500) throw Error('DATA');
        for (const job of value.jobs) if (!validId(job.requestId) || !statuses.includes(job.status) || !Array.isArray(job.outputs)||job.errorCode!==undefined&&(typeof job.errorCode!=='string'||!/^E_[A-Z0-9_]{1,60}$/.test(job.errorCode))) throw Error('DATA');
        settings(value.settings);
        for (const r of value.results) if(!validId(r.assetId)||!validId(r.requestId)||(r.kind!=='reply'&&!/^[a-f0-9]{64}$/.test(r.outputId))||!/^[a-f0-9]{64}$/.test(r.digest))throw Error('DATA');
        return clone(value);
    }
    function readIndex(value) {
        if (value===null || value===undefined) return {schemaVersion:1,works:[],assets:[],drafts:{},library:[]};
        if (value.schemaVersion!==1 || !Array.isArray(value.works) || value.works.length>500 || !Array.isArray(value.assets) || value.assets.length>1000 || !value.drafts || typeof value.drafts!=='object' || Array.isArray(value.drafts)) throw Error('DATA');
        const ids = new Set();
        for (const row of value.works) {
            if (!row || !validId(row.id) || ids.has(row.id) || !Object.hasOwn(operations,row.kind) || typeof row.title!=='string' || row.title.length>160) throw Error('DATA');
            for(const field of ['failureText','replyExcerpt'])if(row[field]!==undefined&&(typeof row[field]!=='string'||row[field].length>320))throw Error('DATA');
            if(row.errorCode!==undefined&&(typeof row.errorCode!=='string'||!/^E_[A-Z0-9_]{1,60}$/.test(row.errorCode)))throw Error('DATA');
            if(row.summary!==undefined&&(typeof row.summary!=='string'||row.summary.length>160))throw Error('DATA');
            for(const [field,max]of [['assetIds',19],['resultAssetIds',500]])if(row[field]!==undefined&&(!Array.isArray(row[field])||row[field].length>max||!row[field].every(validId)))throw Error('DATA');
            if(row.status!==undefined&&row.status!==''&&!statuses.includes(row.status))throw Error('DATA');
            if(row.updatedAt!==undefined&&(typeof row.updatedAt!=='string'||row.updatedAt.length>128||row.updatedAt!==''&&!Number.isFinite(Date.parse(row.updatedAt))))throw Error('DATA');
            for(const field of ['collectionPending','collectionError','autoSaved','resultsFiltered'])if(row[field]!==undefined&&typeof row[field]!=='boolean')throw Error('DATA');
            if(row.collectionFailures!==undefined&&(!Number.isSafeInteger(row.collectionFailures)||row.collectionFailures<0))throw Error('DATA');
            ids.add(row.id);
        }
        const assets = value.assets.map(asset);
        if (new Set(assets.map(a=>a.id)).size!==assets.length) throw Error('DATA');
        for (const [kind,d] of Object.entries(value.drafts)) { if (!Object.hasOwn(operations,kind) || !d || d.kind!==kind || d.id!=='') throw Error('DATA');readWork({...d,id:'draft'},'draft'); }
        const library=value.library===undefined?[]:value.library;
        if(!Array.isArray(library)||library.length>1000)throw Error('DATA');
        const entries=library.map(libraryEntry);
        if(new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('DATA');
        return {...clone(value),assets,library:entries};
    }
    function libraryEntry(value) {
        if(!value||!validId(value.id)||!['prompt','bundle'].includes(value.type)||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.brief!=='string'||value.brief.length>40000||!Array.isArray(value.assetIds)||value.assetIds.length>19||!value.assetIds.every(validId)||new Set(value.assetIds).size!==value.assetIds.length)throw Error('DATA');
        if(value.type==='prompt'&&(!value.brief.trim()||value.assetIds.length)||!value.brief.trim()&&!value.assetIds.length)throw Error('DATA');
        return clone(value);
    }
    function libraryContent(index,keys,combination=false) {
        if(combination&&new Set(keys).size<2)throw Error('COMBINATION');
        const pieces=[],assetIds=[],assets=new Set(index.assets.map(a=>a.id)),entries=new Map(index.library.map(e=>[e.id,e]));
        for(const key of new Set(keys)){
            const [type,id]=key.split(':');let item;
            if(type==='asset'&&assets.has(id))item={brief:'',assetIds:[id]};
            else if(type==='entry')item=entries.get(id);
            if(!item)throw Error('SOURCE');
            if(item.brief.trim())pieces.push(item.brief);
            for(const assetId of item.assetIds){if(!assets.has(assetId))throw Error('SOURCE');if(!assetIds.includes(assetId))assetIds.push(assetId);}
        }
        const brief=pieces.join('\n\n');if(brief.length>40000||assetIds.length>19)throw Error('LIMIT');
        const content={brief,assetIds};
        if(combination){content.textParts=pieces.length;if(materialCount(content)<2)throw Error('COMBINATION');}
        return content;
    }
    function materialCount(content) {
        return new Set(content.assetIds).size+(content.brief.trim()?(content.textParts||1):0);
    }
    function applyLibrary(work,content) {
        const brief=content.brief.trim()?content.brief:work.brief;
        const assetIds=[...new Set([...work.assetIds,...content.assetIds])];
        if(brief.length>40000||assetIds.length>19)throw Error('LIMIT');
        return {...draft(work.kind,work.settings.language),operation:work.operation,settings:clone(work.settings),brief,assetIds,sourceWorkId:work.sourceWorkId||'',...work.productId?{productId:work.productId}:{}};
    }
    function request(work, assets, requestId) {
        if (!validId(requestId) || !Object.hasOwn(operations,work.kind) || typeof work.brief!=='string' || !work.brief.trim() || work.brief.length>40000 || !Array.isArray(work.assetIds) || work.assetIds.length>19 || new Set(work.assetIds).size!==work.assetIds.length) throw Error('REQUEST');
        const selected = work.assetIds.map(id=>{const found=assets.find(a=>a.id===id);if(!found)throw Error('SOURCE');return asset(found);});
        const s=work.settings;
        settings(s);
        // UI language is presentation, not an instruction about the output.
        const outputSettings={};
        if(s.format!=='any')outputSettings.format=s.format;
        if(s.aspect!=='any'&&(work.kind==='image'||work.kind==='video'&&!['txt','srt'].includes(s.format)))outputSettings.aspect=s.aspect;
        if(s.duration!==null&&work.kind==='video'&&!['txt','srt','json'].includes(s.format))outputSettings.duration=s.duration;
        const output={...outputSettings.aspect?{aspect:outputSettings.aspect}:{},...outputSettings.format?{format:outputSettings.format}:{}};
        return {requestId,agentId:agents[work.kind],prompt:work.brief,...Object.keys(output).length?{output}:{},...s.serviceId&&!['txt','srt','json'].includes(s.format)?{media:{kind:work.kind,serviceId:s.serviceId}}:{},files:selected.map(a=>a.path),brief:clone({schemaVersion:1,kind:work.kind,settings:outputSettings,sources:selected.map(a=>({id:a.id,name:a.name,file:a.path.split('/').pop()})),sourceWorkId:work.sourceWorkId||''})};
    }
    function inspect(work, job, result) {
        if (!result || (result.requestId && result.requestId!==job.requestId) || !statuses.includes(result.status) || !Array.isArray(result.files) || result.files.length>100 || (result.text!==undefined && typeof result.text!=='string')) throw Error('RECEIPT');
        const outputs=result.files.map(file=>{
            if (!file || !/^[a-f0-9]{64}$/.test(file.id) || typeof file.name!=='string' || !file.name || file.name.length>512 || !Number.isSafeInteger(file.bytes) || file.bytes<0) throw Error('RECEIPT');
            if(file.published!==undefined&&typeof file.published!=='boolean')throw Error('RECEIPT');
            if(file.version!==undefined&&!/^[a-f0-9]{64}$/.test(file.version))throw Error('RECEIPT');
            return {id:file.id,name:file.name,bytes:file.bytes,...file.published!==undefined?{published:file.published}:{},...file.version?{version:file.version}:{},...savedResultPath(file.path)?{path:file.path}:{}};
        });
        // Execution can finish before host archival validates its deliverable.
        // Keep polling until that final receipt is durable, including failures.
        job.status=result.saved===false&&['completed','failed','stopped'].includes(result.status)?'saving':result.status;
        job.text=(result.text||'').slice(0,40000);job.outputs=outputs;delete job.errorCode;if(job.status==='failed'&&/^E_[A-Z0-9_]{1,60}$/.test(result.error?.code))job.errorCode=result.error.code;
        return work;
    }
    // Publication and requested type only choose initial placement, never file retention.
    function outputPreferred(work, output) {
        if(typeof output.published==='boolean'||work.jobs?.[0]?.outputs.some(file=>typeof file.published==='boolean'))return output.published===true;
        const kind=mediaKind(output.name),format=work.settings.format;
        return ['txt','srt','json'].includes(format)?String(output.name).split('.').pop().toLowerCase()===format:kind===work.kind||work.kind==='image'&&['pdf','psd'].includes(String(output.name).split('.').pop().toLowerCase());
    }
    function resultGroups(work) {
        const outputs=new Map((work.jobs[0]?.outputs||[]).map(output=>[output.id,output])),primary=[],other=[];
        for(const result of work.results)(result.kind==='reply'||!outputs.has(result.outputId)||outputPreferred(work,outputs.get(result.outputId))?primary:other).push(result);
        return {primary,other};
    }
    function libraryAssets(index) { return index.assets.filter(a=>!a.libraryHidden&&(!a.origin||a.libraryHidden===false)); }
    function uncollected(work) {
        const job=work.jobs[0];if(!job)return [];
        return job.outputs.filter(output=>!work.results.some(r=>r.requestId===job.requestId&&r.outputId===output.id&&(!output.version||r.version===output.version)));
    }
    function needsReply(work) {
        const job=work.jobs[0];
        return !!(job?.status==='completed'&&!job.outputs.some(output=>mediaKind(output.name))&&job.text&&!work.results.some(result=>result.kind==='reply'));
    }
    function canStart(work) { return work.jobs.length===0; }
    function failureText(job) { return job?.status==='failed'&&typeof job.text==='string'?job.text.slice(0,40000).trim():''; }
    function failureContent(job) {
        const text=failureText(job);
        // The group-chat executor appends its own error pill after any reply.
        // Its optional private diagnostic belongs to chat, outside the app history.
        const host=/(?:^|\n\n)<span style="color:var\(--danger\)">([^<]*)(?:<\/span>|$)/.exec(text);
        if(!host)return {reply:text,notice:''};
        return {reply:text.slice(0,host.index).trimEnd(),notice:host[1]};
    }
    function displayTitle(work) { return (work.title.trim()||work.brief.trim()).slice(0,160); }
    function historyRows(rows,kind) { return rows.filter(r=>r.kind===kind).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')); }
    function accept(work, file) {
        const a=asset(file);
        if (!a.origin || !validId(a.origin.requestId) || (a.origin.kind!=='reply'&&!/^[a-f0-9]{64}$/.test(a.origin.outputId)) || !a.digest) throw Error('RESULT');
        if (work.results.some(r=>r.requestId===a.origin.requestId && r.kind===a.origin.kind && r.outputId===a.origin.outputId && r.digest===a.digest)) return false;
        if(work.results.length>=500)throw Error('LIMIT');
        work.results.push({assetId:a.id,...a.origin,digest:a.digest,receivedAt:a.createdAt});return true;
    }
    function reuse(work, assetId, kind, language) {
        if (!work.results.some(r=>r.assetId===assetId)) throw Error('SOURCE');
        return {...draft(kind,language),assetIds:[assetId],sourceWorkId:work.id,...work.productId?{productId:work.productId}:{}};
    }
    function edit(work, assetId) {
        const next=reuse(work,assetId,work.kind,work.settings.language);
        return {...next,operation:work.operation,brief:work.brief,settings:clone(work.settings)};
    }
    const api={importProblem,outputPreferred,resultGroups,libraryAssets,edit,uncollected,needsReply,operations,agents,defaultKinds,outputFormats,draft,serviceLabel,selectFirstService,asset,mediaKind,readWork,readIndex,request,inspect,canStart,failureText,failureContent,displayTitle,historyRows,accept,libraryEntry,libraryContent,materialCount,applyLibrary};
    api.reuse=reuse;
    if (typeof module==='object' && module.exports) module.exports=api;else root.ContentModel=Object.freeze(api);
})(typeof window==='object'?window:globalThis);
