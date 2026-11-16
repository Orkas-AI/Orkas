/* Composed with the maintained Content workspace; all state stays in Commerce. */
(function () {
    'use strict';
    const commerce=window.parent.CommerceMedia;
    if(!commerce)throw Error('DATA');
    const api=window.parent.orkasApp,$=id=>document.getElementById(id);
    window.orkasApp=api;
    const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='../creator.css';document.head.append(stylesheet);
    let controller,associated,libraryAssociated,filter,assign,reference,referenceLabel,productActions,feedback,feedbackKey='',feedbackStatus='';
    const node=(tag,id)=>{const el=document.createElement(tag);if(id)el.id=id;return el;};
    const labels=()=>commerce.labels();
    function select(host,control,options,value,label,disabled,onChange){
        if(!control)control=window.ContentControls.mount(host,{options,value,placeholder:label,ariaLabel:label});
        control.setOptions(options,{value});control.setAriaLabel(label);control.onChange(onChange);host.querySelector('button').disabled=disabled;return control;
    }
    function render(next){
        if(!controller)return;
        const l=labels(),products=commerce.products(),options=[{value:'',label:l.noProduct},...products.map(p=>({value:p.id,label:p.name||l.newProduct}))];
        const hasProductContext=products.length>0||!!next.work.productId;
        document.querySelector('.composer-tools').hidden=next.work.kind==='copy'&&!hasProductContext;
        $('product-association').parentElement.hidden=!hasProductContext;$('product-history-filter').parentElement.hidden=!hasProductContext;reference.hidden=!hasProductContext;
        const key=JSON.stringify([next.work.productId,next.selectedAssets.map(a=>a.id)]);if(key!==feedbackKey){feedbackStatus='';feedbackKey=key;}feedback.textContent=feedbackStatus?l[feedbackStatus]:'';
        if(next.work.productId&&!products.some(p=>p.id===next.work.productId))options.push({value:next.work.productId,label:l.missingProduct});
        associated=select($('product-association'),associated,options,next.work.productId||'',l.associateProduct,next.locked,value=>controller.associate(value));
        libraryAssociated=select($('library-product-association'),libraryAssociated,options,next.work.productId||'',l.associateProduct,next.locked,value=>controller.associate(value));
        const filters=[{value:'*',label:l.allProducts},{value:'',label:l.noProduct},...options.slice(1)];if(!filters.some(p=>p.value===controller.filter()))filters.push({value:controller.filter(),label:l.missingProduct});
        filter=select($('product-history-filter'),filter,filters,controller.filter(),l.filterProduct,next.locked,value=>controller.filter(value));
        $('product-association-label').textContent=l.associateProduct;$('product-history-label').textContent=l.filterProduct;
        productActions.hidden=!hasProductContext||!next.inLibrary||!next.selectedAssets.length;
        assign.textContent=l.useForProduct;assign.disabled=next.locked||!next.work.productId||!next.selectedAssets.length||next.selectedAssets.some(a=>!['image','video'].includes(a.kind));
        referenceLabel.textContent=l.productReferences;reference.disabled=next.locked||!next.work.productId;
        $('nav-audio').hidden=true;
    }
    window.ContentWorkspaceExtension={
        api,kinds:['copy','image','video'],
        async prepareRequest(work){return work.productId?{product:await commerce.snapshot(work.productId)}:{};},
        render,
        ready(value){
            controller=value;
            const bar=document.querySelector('.composer-tools .fields');bar.classList.add('commerce-settings');
            for(const[id,label]of [['product-association','product-association-label'],['product-history-filter','product-history-label']]){
                const field=node('div');field.className='field';const text=node('span',label),host=node('div',id);host.setAttribute('aria-labelledby',label);field.append(text,host);
                (id==='product-association'?bar:$('records').querySelector('.section-head')).append(field);
            }
            $('product-association').parentElement.classList.add('commerce-product-field');
            reference=node('button','product-references');reference.type='button';reference.className='context-menu-item';reference.setAttribute('role','menuitem');reference.tabIndex=-1;
            const referenceIcon=node('span');referenceIcon.className='context-menu-icon';referenceIcon.setAttribute('aria-hidden','true');referenceIcon.innerHTML=window.uiIconHtml('image');referenceLabel=node('span');reference.append(referenceIcon,referenceLabel);
            reference.addEventListener('click',async()=>{
                $('material-menu').hidden=true;$('add-material').setAttribute('aria-expanded','false');
                try{const owner=controller.owner(),file=await commerce.reference(controller.productId());if(file)await controller.importMaterial(file,owner);}
                catch(error){controller.fail();}
            });$('material-menu').append(reference);
            const target=node('div','library-product-association');
            assign=node('button','assign-product-media');assign.type='button';
            feedback=node('span','product-media-feedback');feedback.className='help';feedback.setAttribute('role','status');
            assign.addEventListener('click',async()=>{
                feedbackStatus='';feedback.textContent='';
                try{await controller.assign(async assets=>commerce.assign(controller.productId(),assets));feedbackStatus='saved';feedback.textContent=labels().saved;}
                catch(error){feedbackStatus='notSaved';feedback.textContent=labels().notSaved;}
            });productActions=node('div','library-product-actions');productActions.className='actions library-product-actions';productActions.hidden=true;productActions.append(target,assign,feedback);document.querySelector('.library-footer').append(productActions);
            commerce.ready(controller);
        }
    };
})();
