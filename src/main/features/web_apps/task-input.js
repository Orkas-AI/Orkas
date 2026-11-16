/* Shared built-in app input surface. The host's existing form and permission
 * owners validate all answers; no conversation history or host IPC is exposed. */
async function __orkasPresentTaskInput(api, requestId, labels) {
  if (document.getElementById('app-task-input')) return;
  const receipt = await api.tasks.get({requestId});
  const interaction = receipt.interactions?.[0], form = receipt.form;
  const question=!interaction&&!form&&receipt.status==='waiting_input';
  if (!interaction && !form && !question) return;
  const responseId=crypto.randomUUID();
  const node = (tag, text, cls) => {const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  const dialog=node('dialog',null,'modal modal-standard');dialog.id='app-task-input';dialog.setAttribute('aria-label',labels.title);
  dialog.style.cssText='width:min(600px,90vw);max-height:85vh;overflow:auto;padding:20px';
  const body=node('form');body.append(node('h2',form?.title||labels.title));
  const fields=node('div',null,'modal-body'), actions=node('footer',null,'modal-actions actions');
  actions.style.cssText='display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
  const values={}, read=[];
  const inputField=field=>{
    const row=node('div',null,'form-row');row.style.marginBottom='12px';const label=node('label',field.label||field.id);row.append(label);
    if(field.description)row.append(node('p',field.description,'help'));
    if(['select','multiselect'].includes(field.type)){
      const controls=[];
      for(const option of field.options||[]){const item=node('label'),control=node('input');control.type=field.type==='select'?'radio':'checkbox';control.name=field.id;control.value=option.value;control.checked=field.type==='select'?field.default===option.value:Array.isArray(field.default)&&field.default.includes(option.value);item.append(control,document.createTextNode(option.label||option.value));item.style.display='block';row.append(item);controls.push(control);}
      read.push(()=>{const chosen=controls.filter(c=>c.checked).map(c=>c.value);if(field.type==='multiselect')values[field.id]=chosen;else if(chosen.length)values[field.id]=chosen[0];});
    }else if(field.type==='file'){
      const input=node('input');input.type='file';input.multiple=!!field.multiple;if(field.accept)input.accept=field.accept;input.required=!!field.required;row.append(input);
      read.push(async()=>{const files=[];for(const file of Array.from(input.files||[])){
        const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>200*1024*1024)throw Error('LIMIT');let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        const ext=/\.[a-zA-Z0-9]{1,8}$/.exec(file.name)?.[0]||'.bin',path='inputs/'+crypto.randomUUID()+ext.toLowerCase();await api.appFiles.writeBase64({path,base64:btoa(binary),scope:'cloud'});files.push(path);
      }if(files.length)values[field.id]=field.multiple?files:files[0];});
    }else{
      const input=node(field.type==='textarea'?'textarea':'input',null,'form-input');input.id='app-task-field-'+field.id;label.htmlFor=input.id;
      if(field.type==='boolean'){input.type='checkbox';input.checked=field.default===true;read.push(()=>{values[field.id]=input.checked;});}
      else{if(field.type==='number'){input.type='number';input.step='any';if(field.min!==undefined)input.min=field.min;if(field.max!==undefined)input.max=field.max;}else if(field.type!=='textarea')input.type=field.secret?'password':'text';if(field.default!==undefined)input.value=String(field.default);if(field.placeholder)input.placeholder=field.placeholder;input.required=!!field.required;read.push(()=>{if(input.value!=='')values[field.id]=field.type==='number'?Number(input.value):input.value;});}
      row.append(input);
    }
    fields.append(row);
  };
  if(question){fields.append(node('p',receipt.text));inputField({id:'answer',label:labels.title,type:'textarea',required:true});}
  else if(form){for(const field of form.fields||[])inputField(field);}
  else if(interaction.kind==='local-agent:user-input'){
    for(const q of interaction.payload.questions||[])inputField({id:q.id,label:q.question||q.header,secret:q.isSecret,type:q.options?.length&&!q.isOther?(q.multiSelect?'multiselect':'select'):'text',description:q.isOther?q.options?.map(o=>o.label).join(' · '):undefined,options:q.options?.map(o=>({value:o.label,label:o.label+(o.description?' — '+o.description:'')})),required:true});
  }else{
    const p=interaction.payload;const preview=node('pre',p.command||p.preview||p.arguments_preview||p.subject||p.tool||p.path||'');preview.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';fields.append(preview);
    for(const fact of p.key_facts||[])fields.append(node('p',[fact.operation,fact.target,fact.detail].filter(Boolean).join(' · '),'help'));
  }
  const error=node('p',null,'error');error.setAttribute('role','alert');
  const close=node('button',labels.close,'btn'),submit=node('button',labels.submit,'btn btn-primary primary');close.type='button';submit.type='submit';
  close.onclick=()=>dialog.close();
  if(interaction&&interaction.kind!=='local-agent:user-input'){const deny=node('button',labels.cancel,'btn');deny.type='button';deny.onclick=async()=>{deny.disabled=true;try{await api.tasks.respond({requestId,kind:interaction.kind,interactionId:interaction.id,decision:'deny'});dialog.close();}catch(_){error.textContent=labels.error;deny.disabled=false;}};actions.append(deny);}
  actions.prepend(close);actions.append(submit);body.append(fields,error,actions);dialog.append(body);document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  body.onsubmit=async event=>{event.preventDefault();submit.disabled=true;close.disabled=true;
    try{for(const get of read)await get();const result=await api.tasks.respond({requestId,...question?{kind:'text',inputId:receipt.inputId,responseId,text:values.answer}:form?{kind:'form',messageId:form.messageId,formId:form.form_id,values}:{kind:interaction.kind,interactionId:interaction.id,decision:'allow_once',...read.length?{values}:{}}});if(result.handled===false)throw Error('STATE');dialog.close();}
    catch(_){error.textContent=labels.error;submit.disabled=false;close.disabled=false;}
  };
  dialog.showModal();
  if(interaction?.kind==='delete_file.confirmation_required')await api.tasks.respond({requestId,kind:interaction.kind,interactionId:interaction.id,visible:true});
}
