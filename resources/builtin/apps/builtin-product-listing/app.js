/* The application owns drafts and review. Host services own tasks and credentials. */
(async function () {
    'use strict';
    const api = window.orkasApp, m = window.ListingModel, data = window.ListingStoreData, $ = id => document.getElementById(id);
    const areas = ['stores', 'creative'];
    // The nested creator reserves the same native gutter. Use its usable
    // column for both outer navigation and Stores, including overlay scrollbars.
    const alignColumns=()=>document.documentElement.style.setProperty('--creator-scrollbar-width',Math.max(0,innerWidth-document.body.clientWidth)+'px');
    alignColumns();window.addEventListener('resize',alignColumns);
    const fieldNames = ['name', 'sku', 'price', 'currency', 'sourceUrl', 'facts', 'remoteId'];
    let locale = 'en', dictionary = Object.fromEntries(window.ListingLocaleKeys.map((key, i) => [key, window.ListingLocaleRows.en.split('|')[i]])), index = [], products = new Map(), current = null, section = 'details', saving = Promise.resolve(), debounce, agents = [], stores = [], connections = [], active = false, polling = false;
    let reviewed = null, view = 'stores', editing = false, storesLoaded = false, storesError = false;
    let storeFilter = '', stateFilter = '';
    let overviewCache, selectedShop = '', overviewBusy = false, overviewFailure = false;
    const requirements = new Map(), removedProducts = new Set();
    let editorReturn = null;
    let deleting = false, deleteTarget = null, renameTarget = null, renaming = false;
    let composerOwner = '', noticeKey = '', noticeError = false;
    let returningFromConnectors = false, connectorRefreshPending = false;
    let mediaWorkspace=null,mediaReady=null;
    async function mediaProduct(id){
        if(removedProducts.has(id)||!index.some(p=>p.id===id))throw Error('DATA');
        if(!products.has(id)){const file=await api.appFiles.readText({path:'products/'+id+'.json',scope:'cloud'});if(!file)throw Error('DATA');products.set(id,validProduct(JSON.parse(file.text),id));}
        if(removedProducts.has(id)||!index.some(p=>p.id===id)){products.delete(id);throw Error('DATA');}
        return products.get(id);
    }
    window.CommerceMedia={
        labels:()=>Object.fromEntries(['noProduct','newProduct','missingProduct','associateProduct','filterProduct','allProducts','useForProduct','productReferences','saved','notSaved'].map(key=>[key,t(key)])),
        products:()=>index.map(({id,name})=>({id,name})),
        ready(controller){mediaWorkspace=controller;mediaReady?.resolve(controller);},
        async snapshot(id){
            const p=await mediaProduct(id),value=structuredClone({id:p.id,revision:p.revision,name:p.name,sku:p.sku,price:p.price,currency:p.currency,sourceUrl:p.sourceUrl,facts:p.facts,confirmed:p.confirmed,channel:p.channel,language:p.language,copy:p.copy});
            await save(p);if(removedProducts.has(id)||!index.some(row=>row.id===id))throw Error('DATA');return value;
        },
        async reference(id){
            const p=await mediaProduct(id),assets=p.assets.filter(a=>a.path&&['image','video'].includes(a.kind));
            const chosen=await pick('productReferences',assets.map(a=>({value:a.id,label:a.name})));if(!chosen)return null;
            const asset=assets.find(a=>a.id===chosen);if(!p.assets.includes(asset))throw Error('DATA');
            const file=await api.appFiles.readBase64({path:asset.path,scope:'cloud'});if(!file)throw Error('FILE');return{name:asset.name,base64:file.base64};
        },
        async assign(id,assets){
            if(!assets.length||assets.length>19)throw Error('DATA');
            const stored=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;
            if(!Array.isArray(stored?.assets)||assets.some(a=>!['image','video'].includes(a.kind)||!stored.assets.some(saved=>saved.id===a.id&&saved.path===a.path&&saved.kind===a.kind)))throw Error('DATA');
            const p=await mediaProduct(id),added=[];
            for(const a of assets){if(p.assets.some(saved=>saved.path===a.path))continue;const value={id:crypto.randomUUID(),path:a.path,name:a.name,kind:a.kind,selected:true,remoteUrl:'',materialId:a.id};p.assets.push(value);added.push(value);}
            if(!added.length)return;
            p.revision++;
            try{await save(p);if(removedProducts.has(id)||!index.some(row=>row.id===id))throw Error('DATA');}catch(error){p.assets=p.assets.filter(a=>!added.includes(a));throw error;}
            if(current===p&&view==='products'){renderContent();renderJob();}
        }
    };
    async function ensureMediaWorkspace(){
        if(mediaWorkspace){await mediaWorkspace.refresh();return mediaWorkspace;}
        if(!mediaReady){
            let resolve,reject;const promise=new Promise((done,failed)=>{resolve=done;reject=failed;});mediaReady={promise,resolve};
            const timer=setTimeout(()=>reject(Error('DATA')),15000);void promise.finally(()=>clearTimeout(timer)).catch(()=>{});
            $('media-workspace').src='creator/index.html';
        }
        try{return await mediaReady.promise;}catch(error){mediaReady=null;$('media-workspace').removeAttribute('src');throw error;}
    }
    async function createMedia(library=false){
        if(!current)return;
        if(!current.name.trim()&&!current.copy.title.trim()){notice('nameRequired',true);return;}
        const productId=current.id;
        const page=$('creative-page');if(page.inert)return;page.inert=true;page.setAttribute('aria-busy','true');
        try{await navigate('creative');const creator=await ensureMediaWorkspace();if(!await creator.open({productId,library}))notice('working');}
        finally{page.inert=false;page.setAttribute('aria-busy','false');}
    }
    // Paths from the host icon registry; the app runs in an isolated frame.
    const icons = {
        stores: '<circle cx="9" cy="20" r="1"></circle><circle cx="19" cy="20" r="1"></circle><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6"></path>',
        products: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><path d="M3.3 7 12 12l8.7-5"></path><path d="M12 22V12"></path>',
        creative: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M5 17l4.4-4.4a1.5 1.5 0 0 1 2.1 0L14 15l2-2a1.5 1.5 0 0 1 2.1 0L20 14.9"></path>',
        history: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline>',
        rename: '<path d="m16 3 5 5-12 12-6 1 1-6z"></path><path d="m14 5 5 5"></path>',
        search: '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>',
        next: '<path d="m9 6 6 6-6 6"></path>'
    };
    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        svg.innerHTML = icons[name];
        return svg;
    }
    const blobs = new Map();
    let mediaReads = Promise.resolve(), imageObserver = null;
    let videoElement = null;
    let viewEpoch = 0, mediaPage = 0;
    const t = key => dictionary[key] || key;
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined)
            element.textContent = text;
        if (className)
            element.className = className;
        return element;
    }
    function button(label, fn, kind) { const element = node('button', t(label), kind || ''); element.type = 'button'; element.addEventListener('click', () => Promise.resolve().then(fn).catch(fail)); return element; }
    function notice(key, error = false) { noticeKey=key;noticeError=error;$('notice').textContent = key?t(key):''; $('notice').className = error ? 'error' : ''; }
    function fail(error) {  notice('error', true); }
    function dirty(p = current, facts = false) {
        if (!p || removedProducts.has(p.id))
            return;
        p.revision++;
        if (facts)
            p.confirmed = false;
        $('save-state').textContent = '';
        clearTimeout(debounce);
        debounce = setTimeout(() => save(p).catch(error => {  notice('notSaved', true); }), 300);
    }
    async function save(p = current) {
        if (!p || removedProducts.has(p.id) || (!index.some(row => row.id === p.id) && !m.hasContent(p)))
            return;
        m.captureListing(p);
        const data = JSON.stringify(p), revision = p.revision, row = m.productRow(p, new Date().toISOString());
        const operation = saving.catch(() => { }).then(async () => {
            if(removedProducts.has(p.id))return;
            await api.appFiles.writeText({ path: 'products/' + p.id + '.json', text: data, scope: 'cloud' });
            const at = index.findIndex(x => x.id === p.id);
            if (at < 0)
                index.unshift(row);
            else
                index[at] = row;
            await api.storage.set({ key: 'listing-index-v1', value: index, scope: 'cloud' });
            if (current === p && p.revision === revision)
                $('save-state').textContent = t('saved');
            renderProducts();
        });
        saving = operation;
        return operation;
    }
    function validProduct(raw, id) {
        if (!raw || raw.id !== id || !Array.isArray(raw.jobs) || !Array.isArray(raw.assets) || !raw.copy || !Array.isArray(raw.versions) || !Array.isArray(raw.attempts))
            throw Error('DATA');
        return { ...m.product(id), ...raw };
    }
    async function withProductEditorPending(operation) {
        const editor = $('editor'), wasInert = editor.inert, wasBusy = editor.getAttribute('aria-busy');
        const focused = document.activeElement;
        // A picker closes before persistence finishes. Keep its old product
        // controls unavailable until the selected product is fully rendered.
        editor.inert = true;
        editor.setAttribute('aria-busy', 'true');
        try { return await operation(); }
        finally {
            editor.inert = wasInert;
            if (wasBusy === null) editor.removeAttribute('aria-busy');
            else editor.setAttribute('aria-busy', wasBusy);
            if (!wasInert && focused?.isConnected && document.activeElement === document.body)
                focused.focus();
        }
    }
    async function openProduct(id, destination = 'products', mediaSection) {
        if(!index.some(p=>p.id===id)||removedProducts.has(id))throw Error('DATA');
        return withProductEditorPending(async () => {
            clearTimeout(debounce);
            if (current)
                await save(current);
            if (!products.has(id)) {
                const file = await api.appFiles.readText({ path: 'products/' + id + '.json', scope: 'cloud' });
                if (!file)
                    throw Error('DATA');
                products.set(id, validProduct(JSON.parse(file.text), id));
            }
            current = products.get(id);
            view = destination;
            editing = true;
            section = mediaSection || (destination === 'creative' ? 'images' : destination === 'history' ? 'history' : 'details');
            mediaPage = 0;
            render();
            void poll();
        });
    }
    async function addProduct(data) {
        if (current) {
            await save(current);
            if(!index.some(row=>row.id===current.id))products.delete(current.id);
        }
        const p = m.product(crypto.randomUUID());
        p.language = locale;
        for (const key of fieldNames)
            if (typeof data?.[key] === 'string')
                p[key] = data[key];
        products.set(p.id, p);
        current = p;
        view = 'stores';
        editing = true;
        section = 'details';
        mediaPage = 0;
        await save(p);
        render();
        $('content').querySelector('input')?.focus();
    }
    function renderProducts() {
        $('filter-store').textContent = stores.find(store => store.id === storeFilter)?.name || t('allStores');
        $('filter-state').textContent = stateFilter ? t('listing_' + stateFilter) : t('allStates');
        const search = $('search').value.toLocaleLowerCase(), names = new Map(stores.map(store => [store.id, store.name]));
        $('products').replaceChildren();
        for (const item of index.filter(x => (x.name + ' ' + x.sku).toLocaleLowerCase().includes(search) && m.matchesStore(x, storeFilter, stateFilter))) {
            const row = node('div', undefined, 'product-row' + (current?.id === item.id ? ' active' : ''));
            row.dataset.productId=item.id;
            row.addEventListener('click',event=>{if(!event.target.closest('.product-rename'))void openProduct(item.id).catch(fail);});
            const name=node('div',undefined,'product-row-name'),open=node('button',undefined,'product-open'),rename=button('',()=>openRename(item.id),'product-rename');
            open.type='button';open.append(node('strong',item.name||t('newProduct')));
            rename.append(icon('rename'));rename.title=t('rename');rename.setAttribute('aria-label',t('rename')+' · '+(item.name||t('newProduct')));
            name.append(open,rename);
            const next=node('button',undefined,'product-next');next.type='button';next.setAttribute('aria-label',t('productInfo'));next.append(icon('next'));
            const date = node('time', new Date(item.updatedAt).toLocaleDateString(locale));
            date.dateTime = item.updatedAt;
            row.append(name, node('small', item.sku || '—'), node('span', listingSummary(item, names), 'listing-summary'), date, next);
            $('products').append(row);
        }
        $('product-count').textContent = String($('products').children.length) + ' / ' + index.length;
        $('empty').hidden = !!index.length;
        $('product-table').hidden = !index.length || !$('products').children.length;
        $('no-matches').hidden = !index.length || !!$('products').children.length;
    }
    async function openRename(id) {
        if(renaming||$('rename-dialog').open)return;
        const p=await mediaProduct(id);renameTarget=p;
        $('rename-input').value=p.name||p.copy.title||'';$('rename-error').textContent='';
        $('rename-dialog').showModal();$('rename-input').focus();$('rename-input').select();
    }
    $('rename-form').addEventListener('submit',async event=>{
        event.preventDefault();const p=renameTarget,value=$('rename-input').value.trim();if(!p||renaming)return;
        if(!value){$('rename-error').textContent=t('nameRequired');$('rename-input').focus();return;}
        renaming=true;$('rename-confirm').disabled=true;$('rename-cancel').disabled=true;$('rename-error').textContent='';
        const previousName=p.name;
        p.name=value;p.revision++;
        try{await save(p);if(current===p)$('product-title').textContent=value;$('rename-dialog').close();}
        catch(error){
            // A failed index write may follow a successful product-file write.
            // Restore both through the existing save queue, keeping the input
            // in the dialog for an explicit retry rather than a later autosave.
            p.name=previousName;p.revision++;
            try{await save(p);}catch(restoreError){}
            $('rename-error').textContent=t('notSaved');
        }
        finally{renaming=false;$('rename-confirm').disabled=false;$('rename-cancel').disabled=false;}
    });
    $('rename-cancel').addEventListener('click',()=>{if(!renaming)$('rename-dialog').close();});
    $('rename-dialog').addEventListener('cancel',event=>{if(renaming)event.preventDefault();});
    $('rename-dialog').addEventListener('close',()=>{const id=renameTarget?.id;renameTarget=null;[...$('products').children].find(row=>row.dataset.productId===id)?.querySelector('.product-rename')?.focus();});
    function field(label, value, onInput, wide = false, textarea = false) {
        const wrap = node('label', undefined, 'field' + (wide ? ' wide' : ''));
        wrap.append(node('span', t(label)));
        const input = node(textarea ? 'textarea' : 'input');
        if (textarea)
            input.rows = label === 'facts' ? 5 : 6;
        input.value = value || '';
        input.addEventListener('input', () => onInput(input.value));
        wrap.append(input);
        return wrap;
    }
    function pick(title, options) {
        return new Promise(resolve => {
            const dialog = $('picker');
            $('picker-title').textContent = t(title);
            $('picker-options').replaceChildren();
            let chosen = null;
            for (const option of options) {
                const b = button('', () => { chosen = option.value; dialog.close('chosen'); });
                b.textContent = option.label;
                b.disabled = !!option.disabled;
                $('picker-options').append(b);
            }
            dialog.addEventListener('close', () => resolve(chosen), { once: true });
            dialog.showModal();
        });
    }
    function choice(label, value, fn) { const wrap = node('div', undefined, 'field'); wrap.append(node('span', t(label))); const b = button('', fn); if (label === 'store') b.dataset.storeChoice = ''; b.textContent = value || t('choose'); wrap.append(b); return wrap; }
    function storeLabel(store) { return [store.name, store.platform, store.remoteShopId].filter(Boolean).join(' · '); }
    function listingSummary(row, names) {
        const listings = (row.listings || []).filter(item => !storeFilter || item.storeId === storeFilter);
        if (!listings.length) return t('noStore');
        return listings.map(item => (names.get(item.storeId) || t('store')) + ' · ' + t('listing_' + item.state)).join(' / ');
    }
    async function persistStores(next) {
        await api.storage.set({ key: 'listing-stores-v1', value: next, scope: 'cloud' });
        stores = next;
        renderStores();
        renderProducts();
    }
    async function refreshStores() {
        try {
            connections = await m.storeConnectors(args => api.connectors.list(args));
            storesLoaded = true;
            storesError = false;
            return connections;
        }
        catch (error) { storesError = true; throw error; }
        finally { renderStores(); }
    }
    async function connectorRead(connectorId, tool, args, signal) {
        if (!data.supported(connectorId)) throw Error('STORE_UNSUPPORTED');
        const reply = await api.tools.call({ name: 'call_connector_tool', arguments: { connector_id: connectorId, tool_name: tool, args } }, { signal });
        return m.unwrap(reply);
    }
    async function readOverview(key) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 120000);
        try {
            if (key === 'directory') {
                const available = await m.storeConnectors(args => api.connectors.list(args));
                if (available.length > 100) throw Error('STORE_LIMIT');
                const found = [], failures = [];
                for (const connection of available) {
                    if (controller.signal.aborted) throw Error('STORE_TIMEOUT');
                    try {
                        const capabilities = await connectorRead(connection.id, 'list_capabilities', {}, controller.signal);
                        const rows = data.shops(connection, capabilities);
                        if (found.length + rows.length > 100) throw Error('STORE_LIMIT');
                        found.push(...rows);
                    } catch (error) {
                        failures.push(connection.id);
                        
                    }
                }
                return { connections: available.map(item => ({ id: item.id, name: item.name })), shops: found, failures };
            }
            const store = stores.find(item => item.id === key);
            if (!store || !data.supported(store.connectorId) || !connections.some(item => item.id === store.connectorId)) throw Error('STORE_UNAVAILABLE');
            if (store.connectorId === 'shopify-admin') {
                const connection = connections.find(item => item.id === store.connectorId);
                const capabilities = await connectorRead(store.connectorId, 'list_capabilities', {}, controller.signal);
                if (!data.shops(connection, capabilities).some(item => item.remoteShopId === store.remoteShopId)) throw Error('STORE_UNAVAILABLE');
            }
            const report = await data.metrics(store, (action, parameters) => connectorRead(store.connectorId, 'execute_read', { action, parameters }, controller.signal), Date.now());
            return { report };
        } finally { clearTimeout(timeout); }
    }
    async function adoptDirectory(directory) {
        if (!directory) return;
        if (!Array.isArray(directory.connections) || !Array.isArray(directory.shops) || !Array.isArray(directory.failures)) throw Error('STORE_CACHE');
        const next = [...stores];
        for (const remote of directory.shops) {
            const at = next.findIndex(item => item.connectorId === remote.connectorId && item.remoteShopId === remote.remoteShopId);
            const record = m.storeRecord({ ...remote, id: at < 0 ? crypto.randomUUID() : next[at].id });
            if (at < 0) { if(next.length >= 100) throw Error('STORE_LIMIT'); next.push(record); }
            else next[at] = record;
        }
        if (JSON.stringify(next) !== JSON.stringify(stores)) await persistStores(next);
        if (!data.tabs(visibleShops(), locale).some(item => item.id === selectedShop)) selectedShop = visibleShops().length === 1 ? visibleShops()[0].id : '';
    }
    function visibleShops() { return stores.filter(store => data.supported(store.connectorId)); }
    async function refreshOverview(manual = false, discover = false) {
        if (!overviewCache || overviewBusy) return;
        overviewBusy = true; overviewFailure = false;
        $('refresh-stores').disabled = true; $('stores-page').setAttribute('aria-busy', 'true');
        renderStoreOverview();
        try {
            await refreshStores();
            await adoptDirectory(await overviewCache.refresh('directory', manual || discover));
            // Refresh the selected shop, or each shop once for the aggregate tab.
            const targets = visibleShops().filter(item => !selectedShop || item.id === selectedShop);
            for (const store of targets) {
                try { await overviewCache.refresh(store.id, manual); }
                catch(error) { overviewFailure = true;  }
            }
        } catch(error) { overviewFailure = true;  }
        finally {
            overviewBusy = false; $('refresh-stores').disabled = false; $('stores-page').setAttribute('aria-busy', 'false');
            renderStores();
            if (connectorRefreshPending) { connectorRefreshPending = false; void refreshOverview(false, true); }
        }
    }
    async function chooseStore() {
        const p = current, opener = document.activeElement;
        // Keep the previous shop's fields unavailable until the destination is rendered.
        const controls = [...$('content').querySelectorAll('input,textarea,button')].map(element => [element, element.disabled]);
        for (const [element] of controls) element.disabled = true;
        try {
            if (overviewCache) await adoptDirectory(await overviewCache.refresh('directory'));
            await refreshStores();
            if (!visibleShops().length) { notice('connectHint'); await navigate('stores'); return; }
            const selected = await pick('store', visibleShops().map(store => ({ value: store, label: storeLabel(store), disabled: !connections.some(item => item.id === store.connectorId) })));
            if (!selected || current !== p) return;
            await bindStore(p, selected);
            renderContent();
        } finally {
            for (const [element, disabled] of controls) if (element.isConnected) element.disabled = disabled;
            if (current === p && document.activeElement === document.body && !$('editor').hidden)
                (opener?.isConnected ? opener : $('content').querySelector('[data-store-choice]'))?.focus();
        }
    }
    async function bindStore(p, selected) {
        m.bindStore(p, selected);
        dirty(p);
        await save(p);
    }
    async function navigate(destination) {
        if(!areas.includes(destination))return;
        if(view==='creative'&&mediaWorkspace)await mediaWorkspace.flush();
        clearTimeout(debounce);
        if (current) await save(current);
        if (destination === 'stores' && view === 'products' && editing && current) editorReturn = {id:current.id,section};
        view = destination;
        editing = false;
        section = view === 'creative' ? 'images' : view === 'history' ? 'history' : 'details';
        mediaPage = 0;
        notice('');
        render();
        $('main').scrollTop = 0;
        if (view === 'stores') void refreshOverview();
        if(view==='creative')await ensureMediaWorkspace();
    }
    async function chooseProduct() {
        if (!index.length) { await addProduct(); return; }
        const destination = view;
        const mediaSection=['images','video'].includes(section)?section:undefined;
        const id = await pick('chooseProduct', index.map(p => ({ value: p.id, label: (p.name || t('newProduct')) + (p.sku ? ' · ' + p.sku : '') })));
        if (id) await openProduct(id, destination,mediaSection);
    }
    function renderStores() {
        $('back-to-product').hidden = !editorReturn || (!products.has(editorReturn.id) && !index.some(row => row.id === editorReturn.id));
        const container = $('store-list');
        container.replaceChildren();
        const shown = visibleShops().filter(store => !selectedShop || store.id === selectedShop);
        if (!shown.length) {
            const empty = node('div', undefined, 'empty-state');
            const failed = storesError || overviewFailure || overviewCache?.get('directory')?.failed || overviewCache?.get('directory')?.data?.failures?.length;
            empty.append(icon('stores'), node('h2', t(overviewBusy ? 'working' : failed || connections.length ? 'discoveryUnavailable' : 'noStores')));
            if (!overviewBusy && (failed || connections.length)) empty.append(node('p', t('connectionRecovery')));
            container.append(empty);
        }
        if (storesError) container.append(node('p', t('storeRefreshFailed'), 'help'));
        const available = new Map(connections.map(connection => [connection.id, connection])), counts = new Map();
        for (const row of index) for (const id of new Set((row.listings || []).map(listing => listing.storeId))) counts.set(id, (counts.get(id) || 0) + 1);
        for (const store of shown) {
            const connection = available.get(store.connectorId);
            const card = node('article', undefined, 'store-card'), mark = node('span', undefined, 'store-mark');
            card.dataset.storeId = store.id;
            mark.append(icon('stores'));
            card.append(mark, node('h2', store.name), node('p', [store.platform, store.remoteShopId].filter(Boolean).join(' · '), 'help'));
            card.append(node('p', t(storesError ? 'connectionUnknown' : !storesLoaded ? 'working' : connection ? 'connectionAvailable' : 'connectionUnavailable'), 'connection-status'));
            const details = node('dl', undefined, 'store-details');
            for (const [key, value] of [['storeUrl', store.url], ['region', store.region], ['currency', store.currency], ['connection', connection?.name || store.connectionName || t('connectionUnavailable')], ['linkedProducts', String(counts.get(store.id) || 0)], ['lastChecked', store.checkedAt ? new Date(store.checkedAt).toLocaleString(locale) : t('notChecked')]]) { const detail = node('dd', value || '—'); detail.dir = key === 'storeUrl' || key === 'currency' ? 'ltr' : 'auto'; details.append(node('dt', t(key)), detail); }
            card.append(details);
            const abilities = node('p', undefined, 'help store-abilities');
            abilities.textContent = ['read'].map(key => t('cap_' + key) + ': ' + t(store.capabilities?.[key] === true ? 'supported' : store.capabilities?.[key] === false ? 'unsupported' : 'notChecked')).join(' · ');
            card.append(abilities);
            if (!connection || storesError) card.append(node('p', t('connectionRecovery'), 'help'));
            container.append(card);
        }
        renderStoreOverview();
    }
    function renderStoreOverview() {
        const tabStrip = $('store-tabs'), panel = $('store-overview');
        const tabs = data.tabs(visibleShops(), locale);
        tabStrip.hidden = !tabs.length;
        // Keep focused tabs intact while refreshing their data.
        if (tabStrip.dataset.signature !== JSON.stringify([locale, tabs.map(item => [item.id, item.name])])) {
            tabStrip.replaceChildren();
            for (const item of tabs) {
                const tab = button('', async () => { if(overviewBusy)return; selectedShop = item.id; renderStores(); await refreshOverview(); });
                tab.textContent = item.id ? item.name : t('allStores'); tab.dataset.shopTab = item.id;
                tabStrip.append(tab);
            }
            tabStrip.dataset.signature = JSON.stringify([locale, tabs.map(item => [item.id, item.name])]);
        }
        tabStrip.setAttribute('aria-label', t('stores'));
        for (const tab of tabStrip.querySelectorAll('button')) { tab.setAttribute('aria-current', tab.dataset.shopTab === selectedShop ? 'page' : 'false'); tab.disabled = overviewBusy; }
        const selected = visibleShops().filter(item => !selectedShop || item.id === selectedShop);
        panel.replaceChildren(); panel.hidden = !selected.length;
        const cached = selected.map(item => ({ store: item, cached: overviewCache?.get(item.id) }));
        const today = new Date().toISOString().slice(0,10);
        // Cached reports retain their original dates; yesterday is never relabelled as today.
        const reports = cached.map(item => item.cached?.data?.report).filter(item => data.validReport(item) && item.days.at(-1).date === today);
        const total = data.totals(reports, today), complete = reports.length === selected.length;
        const money = values => Object.entries(values).map(([currency,value]) => new Intl.NumberFormat(locale,{style:'currency',currency}).format(value)).join(' / ') || '—';
        const kpis = node('div', undefined, 'store-kpis');
        for (const [key,value] of [['sales30',money(total.sales)],['units30',reports.length?new Intl.NumberFormat(locale).format(total.units):'—'],['salesToday',money(total.todaySales)],['unitsToday',reports.length?new Intl.NumberFormat(locale).format(total.todayUnits):'—']]) {
            const card = node('article',undefined,'store-metric'); card.append(node('p',t(key)),node('strong',value)); kpis.append(card);
        }
        panel.append(kpis);
        if (!complete) panel.append(node('p', t('metricsIncomplete') + ' ' + reports.length + ' / ' + selected.length, 'help'));
        if (reports.length) {
            const charts = node('div', undefined, 'store-charts');
            for (const currency of [...new Set(reports.map(item => item.currency))]) {
                const subset = reports.filter(item => item.currency === currency);
                const days = subset[0].days.map((day,i) => ({date:day.date,value:subset.reduce((sum,report) => sum+report.days[i].sales,0)}));
                charts.append(storeChart(t('salesDaily') + ' · ' + currency, days));
            }
            charts.append(storeChart(t('unitsDaily'), reports[0].days.map((day,i) => ({date:day.date,value:reports.reduce((sum,report) => sum+report.days[i].units,0)}))));
            panel.append(charts, node('p',t('salesBasis'),'help'));
        }
        const stamps = cached.filter(item => data.validReport(item.cached?.data?.report)).map(item => item.cached.lastSuccess);
        if (!stamps.length && overviewCache?.get('directory')?.lastSuccess) stamps.push(overviewCache.get('directory').lastSuccess);
        const failed = overviewFailure || cached.some(item => item.cached?.failed) || overviewCache?.get('directory')?.failed || overviewCache?.get('directory')?.data?.failures?.length;
        $('store-updated').textContent = overviewBusy ? t('working') : (failed ? t('storeRefreshFailed') + ' · ' : '') + (stamps.length ? t('updated') + ' ' + new Date(Math.min(...stamps)).toLocaleString(locale) : t('notChecked'));
    }
    function storeChart(title, days) {
        const card = node('article',undefined,'store-chart'); card.append(node('h2',title));
        const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg');
        svg.setAttribute('viewBox','0 0 560 205'); svg.setAttribute('role','img'); svg.setAttribute('aria-label',title);
        const low=Math.min(0,...days.map(day=>day.value)), high=Math.max(1,...days.map(day=>day.value)), y=value=>170-(value-low)/(high-low)*145;
        for(let i=0;i<4;i++) { const value=low+(high-low)*i/3, line=document.createElementNS(ns,'path'); line.setAttribute('d','M 54 '+y(value)+' H 545'); line.setAttribute('class','chart-grid'); svg.append(line); const label=document.createElementNS(ns,'text'); label.setAttribute('x','48'); label.setAttribute('y',String(y(value)+4)); label.setAttribute('text-anchor','end'); label.textContent=new Intl.NumberFormat(locale,{notation:'compact',maximumFractionDigits:1}).format(value); svg.append(label); }
        const path=document.createElementNS(ns,'path'); path.setAttribute('d',days.map((day,i)=>(i?'L ':'M ')+(54+i*491/29)+' '+y(day.value)).join(' ')); path.setAttribute('class','chart-line'); svg.append(path);
        days.forEach((day,i)=>{const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',String(54+i*491/29));dot.setAttribute('cy',String(y(day.value)));dot.setAttribute('r','3');dot.setAttribute('class','chart-dot');const hint=document.createElementNS(ns,'title');hint.textContent=day.date+': '+new Intl.NumberFormat(locale).format(day.value);dot.append(hint);svg.append(dot);});
        for (const i of [0,14,29]) {const label=document.createElementNS(ns,'text');label.setAttribute('x',String(54+i*491/29));label.setAttribute('y','198');label.setAttribute('text-anchor',i===0?'start':i===29?'end':'middle');label.textContent=days[i].date.slice(5);svg.append(label);}
        card.append(svg); return card;
    }
    function render() {
        document.body.dataset.view = view;
        $('page-actions').hidden = view !== 'products' || editing;
        for (const b of $('workspace-nav').querySelectorAll('[data-view]')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
        $('stores-page').hidden = view !== 'stores';
        if (view === 'stores') renderStores();
        $('catalog').hidden = view !== 'products' || editing;
        $('creative-page').hidden = view !== 'creative';
        if(view==='products')renderProducts();
        $('editor').hidden = !current || view !== 'products' || !editing;
        cleanupMedia();
        if ($('editor').hidden)
            return;
        $('product-title').textContent = current.name || current.copy.title || t('newProduct');
        $('back-products').hidden = view !== 'products';
        $('switch-product').hidden = index.length<2;
        $('sections').replaceChildren();
        const sections = ['details', 'copy', 'media', 'listing'];
        $('sections').hidden = !sections.length;
        for (const s of sections) {
            const b = button(s==='details'?'productInfo':s, () => selectSection(s==='media'?'images':s));
            b.dataset.section = s;
            $('sections').append(b);
        }
        renderNav();
        renderContent();
        renderJob();
    }
    function selectSection(next){section=next;mediaPage=0;renderNav();renderContent();renderJob();void poll();}
    function closeProductMenu(focus=false){$('product-menu').hidden=true;$('product-more').setAttribute('aria-expanded','false');if(focus)$('product-more').focus();}
    function openProductMenu(last=false){
        const menu=$('product-menu'),trigger=$('product-more');$('delete-product').disabled=deleteBlocked();menu.hidden=false;trigger.setAttribute('aria-expanded','true');
        const r=trigger.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
        menu.style.left=Math.max(8,Math.min(locale==='ar'?r.left:r.right-width,innerWidth-width-8))+'px';menu.style.top=Math.max(8,r.bottom+height+8<=innerHeight?r.bottom+4:r.top-height-4)+'px';
        const items=[...menu.querySelectorAll('button:not(:disabled)')];items[last?items.length-1:0]?.focus();
    }
    function deleteBlocked(){return !current||active||current.jobs.some(job=>['submitting','submitted','running','saving','waiting_input','unknown'].includes(job.status));}
    async function deleteProduct(){
        const p=deleteTarget;if(!p||deleting||current!==p||deleteBlocked())return;
        deleting=true;$('delete-error').textContent='';$('delete-confirm').disabled=true;$('delete-cancel').disabled=true;$('editor').inert=true;clearTimeout(debounce);
        try{
            await save(p);removedProducts.add(p.id);
            const operation=saving.catch(()=>{}).then(async()=>{
                const next=index.filter(row=>row.id!==p.id);
                try{await api.storage.set({key:'listing-index-v1',value:next,scope:'cloud'});}catch(error){removedProducts.delete(p.id);throw error;}
                index=next;
            });saving=operation;await operation;
            products.delete(p.id);if(editorReturn?.id===p.id)editorReturn=null;for(const key of requirements.keys())if(key.startsWith(p.id+':'))requirements.delete(key);
            current=null;editing=false;composerOwner='';reviewed=null;render();$('delete-dialog').close();deleteTarget=null;notice('deleted');$('add-product').focus();
            // Shared sources, creator drafts, history and task receipts retain their own ownership.
            await api.appFiles.remove({path:'products/'+p.id+'.json',scope:'cloud'});
        }catch(error){if($('delete-dialog').open)$('delete-error').textContent=t('notSaved');else notice('error',true);}
        finally{deleting=false;$('delete-confirm').disabled=false;$('delete-cancel').disabled=false;$('editor').inert=false;}
    }
    $('product-more').addEventListener('click',()=>$('product-menu').hidden?openProductMenu():closeProductMenu(true));
    $('product-more').addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229||!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();openProductMenu(event.key==='ArrowUp');});
    $('product-menu').addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229)return;if(['Escape','Tab'].includes(event.key)){if(event.key==='Escape')event.preventDefault();closeProductMenu(true);return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=[...$('product-menu').querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();});
    document.addEventListener('pointerdown',event=>{if(!$('product-menu').contains(event.target)&&!$('product-more').contains(event.target))closeProductMenu();});
    window.addEventListener('resize',()=>closeProductMenu());window.addEventListener('scroll',event=>{if(!$('product-menu').contains(event.target))closeProductMenu();},true);
    $('delete-product').addEventListener('click',()=>{closeProductMenu();if(deleteBlocked())return;deleteTarget=current;$('delete-name').textContent=current.name||t('newProduct');$('delete-error').textContent='';$('delete-dialog').showModal();$('delete-cancel').focus();});
    $('delete-dialog').addEventListener('cancel',event=>{if(deleting)event.preventDefault();});
    $('delete-dialog').addEventListener('close',()=>{if(!deleting){deleteTarget=null;$('product-more').focus();}});
    $('delete-confirm').addEventListener('click',()=>deleteProduct());
    function updateGenerate() { $('generate').disabled = active; }
    function renderNav() {
        const owner = current.id + ':' + section;
        if (composerOwner !== owner) {
            if (composerOwner) requirements.set(composerOwner, $('requirements').value);
            $('requirements').value = requirements.get(owner) || '';
            composerOwner = owner;
        }
        for (const b of $('sections').children)
            b.setAttribute('aria-current', b.dataset.section === (['images','video'].includes(section)?'media':section==='history'?'listing':section) ? 'page' : 'false');
        $('review').hidden=!['listing','history'].includes(section);
        const legacy=section!=='copy';
        for(const selector of ['.assistant-title','.assistant > .help','.assistant > .field','.generation-actions'])document.querySelector(selector).hidden=legacy;
        if (['listing', 'history'].includes(section)||legacy) return;
        $('generate').textContent = t('action_' + section);
        $('assistant-title').textContent = t('action_' + section);
        $('assistant-description').textContent = t(section + 'Hint');
        $('requirements').placeholder = t('requirements');
        updateGenerate();
    }
    function cleanupMedia() {
        viewEpoch++;
        imageObserver?.disconnect();
        if (videoElement) {
            videoElement.pause();
            videoElement.removeAttribute('src');
            videoElement.load();
            videoElement = null;
        }
        for (const url of blobs.values())
            URL.revokeObjectURL(url);
        blobs.clear();
    }
    function renderContent() {
        cleanupMedia();
        if (!current || $('editor').hidden)
            return;
        const p = current, container = $('content');
        $('assistant-disclosure').hidden = section !== 'copy' && !visibleJob();
        document.querySelector('.assistant').hidden = section === 'history';
        document.body.dataset.panel = section;
        container.replaceChildren();
        if (section === 'details') {
            const grid = node('div', undefined, 'fields');
            for (const key of ['name', 'sourceUrl', 'facts']) {
                grid.append(field(key === 'sourceUrl' ? 'source' : key, p[key], value => {
                    p[key] = value;dirty(p, true);
                    if (key === 'name')$('product-title').textContent = value || t('newProduct');
                }, key === 'facts', key === 'facts'));
            }
            container.append(grid);
        }
        else if (section === 'copy') {
            const grid = node('div', undefined, 'fields');
            grid.append(field('name', p.copy.title, value => { p.copy.title = value; dirty(p); }, true), field('copy', p.copy.description, value => { p.copy.description = value; dirty(p); }, true, true), field('bullets', p.copy.bullets.join('\n'), value => { p.copy.bullets = value.split('\n').filter(Boolean); dirty(p); }, true, true));
            container.append(grid);
            if (p.versions.length) {
                const line = node('div', undefined, 'toolbar');
                line.append(button('versions', async () => {
                    const v = await pick('versions', p.versions.map((v, i) => ({ value: i, label: v.copy.title + ' · ' + new Date(v.createdAt).toLocaleString() })));
                    if (v !== null) {
                        p.copy = structuredClone(p.versions[v].copy);
                        dirty(p);
                        renderContent();
                    }
                }));
                container.append(line);
            }
        }
        else if (section === 'listing') {
            const identity = current.storeId && stores.find(store => store.id === current.storeId);
            const history=button('history',()=>selectSection('history'));history.dataset.section='history';container.append(history,choice('store', identity ? storeLabel(identity) : t('none'), chooseStore));
            container.append(button('importStore',importStore));
            if (identity) container.append(node('p', t('listing_' + (p.remoteState || 'unknown')), 'help'));
            const fields = node('div', undefined, 'fields');
            for (const key of ['sku', 'price', 'currency', 'remoteId']) fields.append(field(key, p[key], value => { p[key] = value; dirty(p); }));
            container.append(fields);
            container.append(node('p', t('listingHint'), 'help'));
        }
        else if (section === 'images' || section === 'video') {
            const actions = node('div', undefined, 'toolbar');
            const types=node('div',undefined,'section-tabs media-types');
            for(const type of ['images','video']){const tab=button(type,()=>selectSection(type));tab.dataset.section=type;tab.setAttribute('aria-current',type===section?'page':'false');types.append(tab);}
            container.append(types);
            const create=button('createMedia',()=>createMedia());create.id='create-media';const choose=button('chooseMedia',()=>createMedia(true));choose.id='choose-media';
            actions.append(create,choose,button('upload', upload));
            container.append(actions);
            const grid = node('div', undefined, 'media-grid');
            const assets = p.assets.filter(a => a.kind === (section === 'video' ? 'video' : 'image'));
            if (!assets.length) {
                const empty = node('div', undefined, 'empty-state media-empty');
                empty.append(icon('creative'), node('h2', t('noAssets')), node('p', t('mediaHint')));
                container.append(empty);
            }
            if (assets.length > 8) {
                const pages = node('div', undefined, 'toolbar');
                const prev = button('back', () => { mediaPage--; renderContent(); });
                prev.disabled = mediaPage === 0;
                const next = button('next', () => { mediaPage++; renderContent(); });
                next.disabled = (mediaPage + 1) * 8 >= assets.length;
                pages.append(prev, node('span', String(mediaPage + 1) + ' / ' + Math.ceil(assets.length / 8)), next);
                container.append(pages);
            }
            for (const asset of assets.slice(mediaPage * 8, (mediaPage + 1) * 8)) {
                const card = node('div', undefined, 'media-card'), media = node(asset.kind === 'video' ? 'video' : 'img');
                if (asset.kind === 'video')
                    media.controls = true;
                media.setAttribute('aria-label', asset.name);
                card.append(media, node('p', asset.name));
                if (asset.kind === 'video') {
                    media.preload = 'none';
                    card.append(button('preview', async () => {
                        if (videoElement && videoElement !== media) {
                            videoElement.pause();
                            videoElement.removeAttribute('src');
                            videoElement.load();
                        }
                        for (const url of blobs.values())
                            URL.revokeObjectURL(url);
                        blobs.clear();
                        videoElement = media;
                        const epoch = viewEpoch, url = await loadAsset(asset);
                        if (!url || videoElement !== media || epoch !== viewEpoch) return;
                        media.src = url;
                        try { await media.play(); }
                        catch (error) { if (epoch === viewEpoch) throw error; }
                    }));
                }
                else {
                    media.loading = 'lazy';
                    media.__asset = asset;
                    if (!imageObserver)
                        imageObserver = new IntersectionObserver(entries => {
                            for (const entry of entries)
                                if (entry.isIntersecting) {
                                    imageObserver.unobserve(entry.target);
                                    const target = entry.target;
                                    void loadAsset(target.__asset).then(url => {
                                        if (url && target.isConnected)
                                            target.src = url;
                                    }).catch(fail);
                                }
                        });
                    imageObserver.observe(media);
                }
                const check = node('input');
                check.type = 'checkbox';
                check.checked = asset.selected;
                check.addEventListener('change', () => { asset.selected = check.checked; dirty(p); });
                const label = node('label', undefined, 'check');
                label.append(check, node('span', t('selected')));
                card.append(label, field('publicUrl', asset.remoteUrl, v => { asset.remoteUrl = v; dirty(p); }), button('remove', async () => { p.assets = p.assets.filter(a => a.id !== asset.id); dirty(p); renderContent(); }));
                grid.append(card);
            }
            container.append(grid, node('p', t('localOnly'), 'help'));
        }
        else {
            container.append(button('listing',()=>selectSection('listing')));
            for (const attempt of [...p.attempts].reverse()) {
                const card = node('div', undefined, 'attempt');
                if (attempt.execution === 'agent') {
                    const job = p.jobs.find(x => x.requestId === (attempt.verificationRequestId || attempt.requestId));
                    const label = storeTaskLabel(job?.status || attempt.status);
                    card.append(node('strong', t(label)), node('p', (attempt.store?.name || attempt.snapshot.store?.name || connections.find(x => x.id === attempt.connectorId)?.name || attempt.connectorId) + ' · ' + t(attempt.operation === 'publish' ? 'publish' : 'draft')), node('p', attempt.snapshot.title || attempt.snapshot.name), node('p', t('storeResult')));
                    if (job?.text)
                        card.append(node('pre', job.text));
                    const actions = node('div', undefined, 'toolbar');
                    actions.append(button('open', () => api.presentTaskInput(job?.requestId || attempt.requestId, {title:t('waiting'),submit:t('send'),close:t('back'),cancel:t('cancel'),error:t('error')})), button('refresh', async () => { await refreshStoreJob(p, job || p.jobs.find(x => x.requestId === attempt.requestId)); renderContent(); }), button('verify', () => verifyStore(p, attempt)));
                    card.append(actions);
                    container.append(card);
                    continue;
                }
                card.append(node('strong', t(attempt.status === 'draft' ? 'draftSaved' : attempt.status === 'published' ? 'published' : attempt.status)), node('p', attempt.connectorId + ' · ' + new Date(attempt.createdAt).toLocaleString()), node('p', attempt.snapshot.title), node('p', attempt.remoteId || '—'));
                card.append(button('verify', async () => { await m.reconcile(attempt, (action, params, risk) => shopify(attempt.connectorId, action, params, risk), () => save(p)); await adoptRemote(p, attempt); renderContent(); }));
                container.append(card);
            }
            if (!p.attempts.length)
                container.append(node('div', t('noPublications'), 'empty-state'));
        }
    }
    async function readAsset(asset, epoch) {
        if (asset.remoteUrl && !asset.path)
            return asset.remoteUrl;
        if (blobs.has(asset.path))
            return blobs.get(asset.path);
        const data = await api.appFiles.readBase64({ path: asset.path, scope: 'cloud' });
        if (!data)
            throw Error('FILE');
        if (epoch !== viewEpoch)
            return null;
        const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
        const ext = asset.name.split('.').pop().toLowerCase(), types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
        const url = URL.createObjectURL(new Blob([bytes], { type: types[ext] || 'application/octet-stream' }));
        blobs.set(asset.path, url);
        return url;
    }
    function loadAsset(asset) { const epoch = viewEpoch; const pending = mediaReads.catch(() => { }).then(() => epoch === viewEpoch ? readAsset(asset, epoch) : null); mediaReads = pending; return pending; }
    async function upload() {
        const p = current;
        const selected = await api.files.pick();
        if (!selected)
            return;
        try {
            const ext = selected.name.split('.').pop().toLowerCase();
            if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'].includes(ext))
                throw Error('FILE');
            if (selected.size > (['mp4', 'mov', 'webm'].includes(ext) ? 200 : 20) * 1024 * 1024) {
                notice('mediaLimit', true);
                return;
            }
            const data = await api.files.readBase64({ handle: selected.handle }), id = crypto.randomUUID(), file = 'media/' + p.id + '/' + id + '.' + ext;
            await api.appFiles.writeBase64({ path: file, base64: data.base64, scope: 'cloud' });
            p.assets.push({ id, path: file, name: selected.name, kind: ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : 'image', selected: false, remoteUrl: '' });
            dirty(p);
            await save(p);
            if (current === p) renderContent();
        }
        finally {
            await api.files.release({ handle: selected.handle });
        }
    }
    async function importCsv() {
        const selected = await api.files.pick();
        if (!selected)
            return;
        try {
            const data = await api.files.readText({ handle: selected.handle }), rows = m.csv(data.text);
            for (const row of rows)
                await addProduct(row);
            notice('saved');
        }
        finally {
            await api.files.release({ handle: selected.handle });
        }
    }
    async function exportProduct() { await save(); await api.files.saveAs({ name: 'product-' + current.id + '.json', text: JSON.stringify(current, null, 2) }); }
    async function generate(kind) {
        if (!current || active)
            return;
        const p = current, taskKind = kind || (section === 'details' ? 'extract' : section === 'copy' ? 'copy' : section === 'video' ? 'video' : 'images');
        const brief = $('requirements').value, owner = composerOwner, instructions = brief.trim(), template = window.ListingRequests[taskKind];
        if (!instructions && !template) {
            $('requirements').focus();
            return;
        }
        const references = p.assets.filter(a => a.selected && a.path).map(a => a.path);
        if (references.length > 19) {
            notice('referenceLimit', true);
            return;
        }
        // Freeze input and its revision together before any asynchronous save.
        const revision = p.revision, name = p.name;
        const snapshot = JSON.stringify({ name: p.name, sku: p.sku, price: p.price, currency: p.currency, sourceUrl: p.sourceUrl, facts: p.facts, confirmed: p.confirmed, channel: p.channel, language: p.language, copy: p.copy, aspect: p.aspect, duration: p.duration, assets: p.assets.filter(a => a.selected).map(({ remoteUrl, name, kind }) => ({ remoteUrl, name, kind })) }, null, 2);
        active = true;
        $('generate').disabled = true;
        try {
            await save(p);
            const requestId = crypto.randomUUID(), snapshotPath = 'requests/' + requestId + '.json';
            await api.appFiles.writeText({ path: snapshotPath, scope: 'cloud', text: snapshot });
            const target = { copy: '173d4235a431', images: '814b61b027f0', video: '79df9cc89f5f', extract: '5a1d43c2f28a' }[taskKind], agentId = agents.some(a => a.id === target) ? target : 'commander';
            const job = { requestId, kind: taskKind, revision, status: 'submitting', text: '', outputs: [] };
            p.jobs.push(job);
            await save(p);
            renderJob();
            try {
                await api.tasks.start({ requestId, title: (name || t('newProduct')).slice(0, 120) + ' · ' + t(taskKind === 'extract' ? 'details' : taskKind), prompt: [template, instructions].filter(Boolean).join('\n\n'), agentId, files: [snapshotPath, ...references] });
                job.status = 'submitted';
                if (composerOwner === owner) {
                    if ($('requirements').value === brief) { $('requirements').value = ''; requirements.delete(owner); }
                }
                else if (requirements.get(owner) === brief) requirements.delete(owner);
            }
            catch (error) {
                
                job.status = 'unknown';
                notice('unknown', true);
            }
            await save(p);
            if (current === p) {
                renderJob();
                void poll();
            }
        }
        finally {
            active = false;
            updateGenerate();
        }
    }
    function latest() { return current?.jobs[current.jobs.length - 1]; }
    function visibleJob() {
        const kind = section === 'details' ? 'extract' : section;
        return current?.jobs.findLast(job => job.kind === kind || (['details','listing'].includes(section) && job.kind === 'store-import'));
    }
    function pollingJob() { return visibleJob() || latest(); }
    function renderJob() {
        const job = visibleJob();
        if(section!=='copy')$('assistant-disclosure').hidden=!job||section==='history';
        $('delete-product').disabled=deleteBlocked();$('delete-product').title=deleteBlocked()?t('deleteBusy'):'';
        const label = job?.kind?.startsWith('store-') ? storeTaskLabel(job.status) : !job ? '' : ['running', 'saving', 'submitted', 'submitting'].includes(job.status) ? 'working' : job.status === 'waiting_input' ? 'waiting' : job.status === 'stopped' ? 'cancel' : job.status === 'completed' && ['images', 'video'].includes(job.kind) && !job.outputs?.length ? 'noResults' : job.status;
        $('agent-status').textContent = label ? t(label) : '';
        $('open-task').hidden = job?.status !== 'waiting_input';
        $('stop-task').hidden = !job || !['running', 'saving', 'submitted', 'submitting', 'waiting_input'].includes(job.status);
        $('task-result').hidden = !job?.text;
        $('task-result').textContent = job?.text || '';
        $('content').querySelectorAll('.output-list').forEach(el => el.remove());
        if (job?.kind === 'store-import' && job.products?.length) {
            const list = node('div', undefined, 'toolbar output-list');
            list.append(button('importStore', () => receiveStoreProducts(job)));
            $('content').append(list);
        }
        if (job?.outputs?.length) {
            const list = node('div', undefined, 'toolbar output-list');
            for (const output of job.outputs)
                list.append(button('', () => receiveOutput(job, output)));
            [...list.children].forEach((b, i) => b.textContent = t('select') + ' · ' + job.outputs[i].name);
            $('content').append(list);
        }
    }
    async function poll() {
        const p = current, job = pollingJob();
        if (!p || !job || polling || document.hidden)
            return;
        polling = true;
        try {
            if (job.kind.startsWith('store-')) {
                const changed = await refreshStoreJob(p, job);
                if (current === p) {
                    if (section === 'history' && changed)
                        renderContent();
                    renderJob();
                }
                return;
            }
            const result = await api.tasks.get({ requestId: job.requestId });
            job.status = result.status;
            job.text = result.text;
            job.outputs = result.files.filter(file => /\.(?:png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(file.name));
            if (result.status === 'completed' && !job.received) {
                if (job.kind === 'copy')
                    m.acceptCopy(p, result.text, job.revision);
                if (job.kind === 'extract' && p.revision === job.revision) {
                    try {
                        const facts = m.json(result.text);
                        for (const key of ['name', 'sku', 'price', 'facts'])
                            if (!p[key] && typeof facts[key] === 'string')
                                p[key] = facts[key];
                        p.confirmed = false;
                    }
                    catch (error) {  }
                }
                job.received = true;
                await save(p);
                if (current === p && (section === 'copy' && job.kind === 'copy' || section === 'details' && job.kind === 'extract') && p.revision === job.revision)
                    renderContent();
            }
            if (current === p)
                renderJob();
        }
        catch (error) {
            
            if (current === p)
                notice('unknown', true);
        }
        finally {
            polling = false;
        }
    }
    async function receiveOutput(job, output) {
        const p = current;
        if (p.assets.some(a => a.outputId === output.id))
            return;
        const ext = output.name.split('.').pop().toLowerCase();
        if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm'].includes(ext))
            return;
        if (output.bytes > (['mp4', 'mov', 'webm'].includes(ext) ? 200 : 20) * 1024 * 1024) {
            notice('mediaLimit', true);
            return;
        }
        const result = await api.tasks.output({ requestId: job.requestId, outputId: output.id }), id = crypto.randomUUID(), file = 'media/' + p.id + '/' + id + '.' + ext;
        await api.appFiles.writeBase64({ path: file, scope: 'cloud', base64: result.base64 });
        p.assets.push({ id, path: file, name: output.name, outputId: output.id, kind: ['mp4', 'mov', 'webm'].includes(ext) ? 'video' : 'image', selected: false, remoteUrl: '' });
        dirty(p);
        await save(p);
        if (current === p) {
            renderContent();
            renderJob();
        }
    }
    const capabilities = new Map();
    async function shopify(connectorId, action, parameters, risk) {
        // Read-only compatibility for attempts created before connector-owned tasks.
        if (!connectorId || risk !== 'R')
            throw Error('STORE');
        if (!capabilities.has(connectorId)) {
            const raw = await api.tools.call({ name: 'call_connector_tool', arguments: { connector_id: connectorId, tool_name: 'list_capabilities', args: {} } });
            if (raw.isError)
                throw Error('STORE');
            const envelope = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw;
            if (envelope.provider !== 'shopify')
                throw Error('STORE');
            capabilities.set(connectorId, envelope);
        }
        const cap = capabilities.get(connectorId), spec = cap.actions.find(a => a.action === action);
        if (!spec || spec.risk !== risk)
            throw Error('PERMISSION');
        const lane = { R: 'execute_read', W: 'execute_write', H: 'execute_high_impact', D: 'execute_destructive' }[risk];
        return m.unwrap(await api.tools.call({ name: 'call_connector_tool', arguments: { connector_id: connectorId, tool_name: lane, args: { action, parameters } } }));
    }
    function storeTaskLabel(status) {
        return ['submitting', 'submitted', 'running', 'saving'].includes(status) ? 'working' : status === 'waiting_input' ? 'waiting' : status === 'completed' ? 'storeCompleted' : status === 'stopped' ? 'cancel' : ['failed', 'unknown'].includes(status) ? status : 'unknown';
    }
    async function startStoreOperation(p, operation, frozen = p, parent = null) {
        if (active)
            return;
        const request = m.storeRequest(frozen, operation);
        const references = ['draft', 'publish'].includes(operation) ? frozen.assets.filter(a => a.selected && a.path) : [];
        if (references.length > 19) {
            notice('referenceLimit', true);
            return;
        }
        active = true;
        updateGenerate();
        try {
            await refreshStores();
            if (!connections.some(x => x.id === request.connectorId)) {
                notice('reconnect', true);
                return;
            }
            const requestId = crypto.randomUUID(), snapshotPath = 'requests/' + requestId + '.json';
            await api.appFiles.writeText({ path: snapshotPath, scope: 'cloud', text: JSON.stringify(request, null, 2) });
            const job = { requestId, kind: 'store-' + operation, connectorId: request.connectorId, store: request.store || null, status: 'submitting', text: '', outputs: [], revision: p.revision };
            p.jobs.push(job);
            if (['draft', 'publish'].includes(operation))
                p.attempts.push({ id: crypto.randomUUID(), execution: 'agent', requestId, connectorId: request.connectorId, store: request.store || null, operation, snapshot: request.product, status: 'submitting', createdAt: new Date().toISOString() });
            if (parent)
                parent.verificationRequestId = requestId;
            await save(p);
            if ($('review-dialog').open)
                $('review-dialog').close();
            if (['draft', 'publish', 'verify'].includes(operation)) {
                view = 'stores';
                editing = true;
                section = 'history';
            }
            render();
            try {
                const result = await api.tasks.start({ requestId, title: (frozen.name || t('newProduct')).slice(0, 110) + ' · ' + t(operation === 'import' ? 'importStore' : operation), prompt: window.ListingStoreRequest, agentId: 'commander', files: [snapshotPath, ...references.map(a => a.path)] });
                job.status = result.status === 'rejected' ? 'failed' : result.status;
            }
            catch (error) {
                
                job.status = 'unknown';
                notice('unknown', true);
            }
            await save(p);
            await refreshStoreJob(p, job);
            if (current === p)
                render();
        }
        finally {
            active = false;
            updateGenerate();
        }
    }
    async function refreshStoreJob(p, job) {
        if (!job)
            return false;
        try {
            const result = await api.tasks.get({ requestId: job.requestId });
            const changed = job.status !== result.status || job.text !== result.text;
            job.status = result.status;
            job.text = result.text;
            if (job.kind === 'store-import' && job.status === 'completed' && (changed || !job.products)) {
                try {
                    job.products = m.storeProducts(result.text);
                }
                catch (error) {
                    
                    job.products = [];
                }
            }
            const attempt = p.attempts.find(x => x.requestId === job.requestId || x.verificationRequestId === job.requestId);
            const attemptChanged = attempt && attempt.status !== job.status;
            if (attempt)
                attempt.status = job.status;
            if (changed || attemptChanged) await save(p);
            return !!(changed || attemptChanged);
        }
        catch (error) {
            
            notice('unknown', true);
            return false;
        }
    }
    async function receiveStoreProducts(job) {
        const row = await pick('importStore', job.products.map(x => ({ value: x, label: x.name || x.title || x.id })));
        if (!row)
            return;
        return withProductEditorPending(async () => {
            await addProduct(row);
            Object.assign(current, { connectorId: job.connectorId, channel: job.store?.platform || '', remoteId: row.id, baseline: structuredClone(row), copy: { title: row.title, description: row.description, bullets: [] }, confirmed: false });
            if (job.store) { current.store = structuredClone(job.store); current.storeId = job.store.id; m.captureListing(current); }
            await save();
            render();
        });
    }
    async function importStore() {
        const p = current;
        if (!p.storeId)
            await chooseStore();
        if (!p.storeId)
            return;
        return startStoreOperation(p, 'import');
    }
    async function verifyStore(p, attempt) {
        return startStoreOperation(p, 'verify', m.verificationProduct(p, attempt), attempt);
    }
    async function review() {
        if (m.pendingStoreWrite(current)) {
            notice('unknown', true);
            view = 'stores';
            editing = true;
            section = 'history';
            render();
            return;
        }
        await save();
        const p = current;
        let s;
        try {
            s = m.storeReview(p);
        }
        catch (error) {
            
            notice('missing', true);
            return;
        }
        reviewed = structuredClone(p);
        if (!s) {
            notice('missing', true);
            return;
        }
        const wrap = $('review-content');
        wrap.replaceChildren();
        const dl = node('dl');
        for (const [label, value] of [['name', s.title || s.name], ['remoteId', s.remoteId || '—'], ['store', p.store ? storeLabel(p.store) : t('none')], ['channel', s.channel], ['sku', s.sku], ['price', s.price + ' ' + s.currency], ['copy', s.description], ['selected', s.assets.map(a => a.name).join(', ') || t('noAssets')]])
            dl.append(node('dt', t(label)), node('dd', value));
        wrap.append(dl, node('p', t(s.remoteId ? 'updateProduct' : 'newProduct'), 'help'));
        if (s.baseline) {
            wrap.append(node('p', s.baseline.title + ' → ' + s.title, 'help'));
        }
        if (s.assets.some(a => !a.remoteUrl))
            wrap.append(node('p', t('storeCapabilities'), 'help'));
        $('review-confirm').checked = false;
        $('store-draft').disabled = true;
        $('store-publish').disabled = true;
        $('review-dialog').showModal();
    }
    $('review-confirm').addEventListener('change', () => { const allowed = $('review-confirm').checked && !!reviewed?.storeId; $('store-publish').disabled = !allowed; $('store-draft').disabled = !allowed; });
    async function adoptRemote(p, a) {
        if (!a.remote)
            return;
        if (p.storeId && a.store?.id !== p.storeId) { await save(p); return; }
        p.remoteId = a.remote.id;
        p.remoteStatus = a.remote.status;
        p.baseline = { title: a.remote.title, descriptionHtml: a.remote.descriptionHtml, price: a.remote.variants.nodes[0].price, sku: a.remote.variants.nodes[0].sku, mediaCount: a.remote.media?.nodes?.length || 0 };
        if (a.mediaReady)
            for (const asset of p.assets)
                if (a.snapshot.assets.some(x => x.id === asset.id))
                    asset.boundTo = a.connectorId + ':' + a.remoteId;
        await save(p);
    }
    async function publish(mode) {
        if (!$('review-confirm').checked || active || !reviewed || reviewed.id !== current?.id)
            return;
        $('store-draft').disabled = true;
        $('store-publish').disabled = true;
        try {
            await startStoreOperation(current, mode, reviewed);
        }
        finally {
            if ($('review-dialog').open)
                $('review-confirm').checked = false;
        }
    }
    $('store-draft').addEventListener('click', () => publish('draft').catch(fail));
    $('store-publish').addEventListener('click', () => publish('publish').catch(fail));
    $('add-product').addEventListener('click', () => addProduct().catch(fail));
    $('first-product').addEventListener('click', () => addProduct().catch(fail));
    $('save').addEventListener('click', async () => {
        if(!current?.name.trim()&&!current?.copy.title.trim()){notice('nameRequired',true);return;}
        clearTimeout(debounce);$('save').disabled = true;
        try { await save();notice(''); }
        catch (error) { $('save-state').textContent='';notice('notSaved',true); }
        finally { $('save').disabled = false; }
    });
    $('back-to-product').addEventListener('click', async () => {
        const target=editorReturn;if(!target)return;
        try {
            const draft=products.get(target.id);
            if(draft&&!index.some(row=>row.id===target.id)&&!m.hasContent(draft)&&!removedProducts.has(target.id)){
                current=draft;view='products';editing=true;section=target.section;render();
            }else await openProduct(target.id,'products',target.section);
            editorReturn=null;
        }
        catch(error){fail(error);}
    });
    $('import-csv').addEventListener('click', () => importCsv().catch(fail));
    $('export').addEventListener('click', () => {closeProductMenu();exportProduct().catch(fail);});
    $('review').addEventListener('click', () => review().catch(fail));
    $('generate').addEventListener('click', () => generate().catch(fail));
    $('open-task').addEventListener('click', () => api.presentTaskInput(visibleJob().requestId, {title:t('waiting'),submit:t('send'),close:t('back'),cancel:t('cancel'),error:t('error')}).catch(fail));
    $('stop-task').addEventListener('click', () => api.tasks.cancel({ requestId: visibleJob().requestId }).then(poll).catch(fail));
    $('search').addEventListener('input', renderProducts);
    $('requirements').addEventListener('input', updateGenerate);
    $('back-products').addEventListener('click', () => navigate('products').catch(fail));
    $('switch-product').addEventListener('click', () => chooseProduct().catch(fail));
    $('clear-search').addEventListener('click', () => { $('search').value = ''; storeFilter = ''; stateFilter = ''; renderProducts(); $('search').focus(); });
    $('filter-store').addEventListener('click', () => pick('store', [{ value: '', label: t('allStores') }, ...stores.map(store => ({ value: store.id, label: storeLabel(store) }))]).then(id => { if (id !== null) { storeFilter = id; renderProducts(); } }).catch(fail));
    $('filter-state').addEventListener('click', () => pick('listingState', [{ value: '', label: t('allStates') }, ...['published', 'draft', 'unpublished', 'unknown'].map(state => ({ value: state, label: t('listing_' + state) }))]).then(state => { if (state !== null) { stateFilter = state; renderProducts(); } }).catch(fail));
    $('refresh-stores').addEventListener('click', () => refreshOverview(true));
    $('connect-store').addEventListener('click', async () => {
        $('connect-store').disabled = true;
        returningFromConnectors = true;
        try {
            if (typeof api.openConnectors === 'function') await api.openConnectors();
            else await api.call('__builtin.openConnectors', {});
            notice('');
        }
        catch (error) {
            returningFromConnectors = false;
            if (error?.code === 'E_METHOD') {  notice('connectRestart', true); }
            else fail(error);
        }
        finally { $('connect-store').disabled = false; }
    });
    window.addEventListener('focus', () => {
        void poll();
        if (returningFromConnectors && view === 'stores') {
            returningFromConnectors = false;
            if (overviewBusy) connectorRefreshPending = true;
            else void refreshOverview(false, true);
        }
        void api.host.getContext().then(async context => { if(context.language!==locale){applyLanguage(context.language);render();await mediaWorkspace?.refresh();} }).catch(error=>fail(error));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden)
        void poll(); });
    window.addEventListener('pagehide', () => {
        for (const url of blobs.values())
            URL.revokeObjectURL(url);
    });
    function applyLanguage(next) {
        locale = next;
        if (!window.ListingLocaleRows[locale])
            throw Error('LOCALE');
        dictionary = Object.fromEntries(window.ListingLocaleKeys.map((key, i) => [key, window.ListingLocaleRows[locale].split('|')[i]]));
        document.documentElement.lang = locale;
        document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
        document.title = t('title');
        notice(noticeKey,noticeError);if($('save-state').textContent)$('save-state').textContent=t('saved');
        for (const el of document.querySelectorAll('[data-t]'))
            el.textContent = t(el.dataset.t);
        for (const b of $('workspace-nav').querySelectorAll('[data-view]')) b.querySelector('span').textContent=t(b.dataset.view);
        $('search').placeholder=t('search');$('search').setAttribute('aria-label',t('search'));
        $('workspace-nav').setAttribute('aria-label',t('title'));$('sections').setAttribute('aria-label',t('details'));
        $('media-workspace').title=t('creative');$('product-more').setAttribute('aria-label',t('moreActions'));
        $('delete-product').title=deleteBlocked()?t('deleteBusy'):'';if($('delete-error').textContent)$('delete-error').textContent=t('notSaved');
    }
    try {
        const context = await api.host.getContext();
        applyLanguage(context.language);
        $('empty-icon').append(icon('products'));
        $('search-icon').append(icon('search'));
        $('assistant-icon').append(icon('creative'));
        $('product-more').innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
        $('workspace-nav').setAttribute('aria-label', t('title'));
        for (const area of areas) {
            const b = button('', () => navigate(area), 'nav-item');
            b.dataset.view = area;
            b.append(icon(area), node('span', t(area)));
            $('workspace-nav').append(b);
        }
        $('search').placeholder = t('search');
        $('search').setAttribute('aria-label', t('search'));
        $('sections').setAttribute('aria-label', t('details'));
        const stored = await api.storage.get({ key: 'listing-index-v1', scope: 'cloud' });
        if (stored.value !== null) {
            if (!Array.isArray(stored.value) || stored.value.some(x => !x || !(/^[a-zA-Z0-9_-]{1,64}$/).test(x.id)))
                throw Error('DATA');
            index = stored.value;
        }
        const savedStores = await api.storage.get({ key: 'listing-stores-v1', scope: 'cloud' });
        if (savedStores.value !== null) {
            if (!Array.isArray(savedStores.value) || savedStores.value.length > 100) throw Error('STORES');
            for (const store of savedStores.value) stores = m.addStore(stores, store);
        }
        const savedOverview = await api.storage.get({ key: 'listing-store-data-v1', scope: 'cloud' });
        overviewCache = data.createCache({ initial: savedOverview.value, read: readOverview, save: value => api.storage.set({ key: 'listing-store-data-v1', value, scope: 'cloud' }) });
        const directory = overviewCache.get('directory')?.data;
        if (directory) await adoptDirectory(directory);
        if (visibleShops().length === 1) selectedShop = visibleShops()[0].id;
        render();
        for (const id of ['add-product','first-product','import-csv']) $(id).disabled = false;
        // Entry may arrive while the initial private storage reads are pending.
        if (view === 'stores') void refreshOverview();
        void api.tasks.agents().then(result => { agents = result.agents; }).catch(error => fail(error));
        void refreshStores().then(() => { const choice = $('content').querySelector('[data-store-choice]'); if (choice && current) choice.textContent = stores.find(x => x.id === current.storeId)?.name || current.store?.name || t('none'); }).catch(error => fail(error));
        setInterval(() => {
            if (['running', 'saving', 'submitted', 'submitting', 'unknown', 'waiting_input'].includes(pollingJob()?.status))
                void poll();
        }, 5000);
    }
    catch (error) {
        
        notice('error', true);
        for (const id of ['add-product','first-product','import-csv']) $(id).disabled = true;
    }
})();
