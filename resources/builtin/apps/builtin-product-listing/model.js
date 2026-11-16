/* Product facts, reviewed versions and explicit Shopify acknowledgements. */
(function (root) {
    'use strict';
    const storeData = typeof module === 'object' && module.exports ? require('./store-data.js') : root.ListingStoreData;
    function product(id) { return { id, revision: 1, name: '', sku: '', price: '', currency: 'USD', sourceUrl: '', facts: '', confirmed: false, channel: '', language: 'en', connectorId: '', remoteId: '', remoteStatus: '', baseline: null, copy: { title: '', description: '', bullets: [] }, assets: [], versions: [], jobs: [], attempts: [], notes: '', aspect: '9:16', duration: '15' }; }
    function csv(text) {
        const rows = [];
        let row = [], value = '', quoted = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '"') {
                if (quoted && text[i + 1] === '"') {
                    value += '"';
                    i++;
                }
                else if (!quoted && value)
                    throw Error('CSV');
                else
                    quoted = !quoted;
            }
            else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
                row.push(value);
                value = '';
                if (c !== ',') {
                    if (c === '\r' && text[i + 1] === '\n')
                        i++;
                    if (row.some(Boolean))
                        rows.push(row);
                    row = [];
                }
            }
            else
                value += c;
        }
        if (quoted)
            throw Error('CSV');
        row.push(value);
        if (row.some(Boolean))
            rows.push(row);
        const headers = (rows.shift() || []).map(h => h.replace(/^\uFEFF/, '').trim());
        if (!headers.includes('name'))
            throw Error('CSV');
        if (rows.length > 500)
            throw Error('CSV');
        return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] || ''])));
    }
    function snapshot(p) {
        if (!p.name.trim() || !p.sku.trim() || !String(p.price).trim() || !Number.isFinite(Number(p.price)) || Number(p.price) < 0 || !(/^[A-Z]{3}$/).test(p.currency) || !p.copy.title.trim() || !p.copy.description.trim())
            return null;
        return structuredClone({ productId: p.id, revision: p.revision, name: p.name, sku: p.sku, price: String(p.price), currency: p.currency, facts: p.facts, title: p.copy.title, description: p.copy.description, bullets: p.copy.bullets, channel: p.channel, language: p.language, remoteId: p.remoteId, remoteStatus: p.remoteStatus, assets: p.assets.filter(a => a.selected && a.boundTo !== p.connectorId + ':' + p.remoteId), baseline: p.baseline });
    }
    function json(text) { const trimmed = text.trim(); return JSON.parse(trimmed.startsWith('```') ? trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '') : trimmed); }
    function acceptCopy(p, text, revision) {
        let v;
        try {
            v = json(text);
        }
        catch {
            return false;
        }
        if (!v || typeof v.title !== 'string' || typeof v.description !== 'string' || !Array.isArray(v.bullets) || !v.bullets.every(b => typeof b === 'string'))
            return false;
        const copy = { title: v.title, description: v.description, bullets: v.bullets };
        p.versions.push({ revision, copy, createdAt: new Date().toISOString() });
        if (p.revision !== revision)
            return false;
        p.copy = copy;
        return true;
    }
    function unwrap(raw) {
        if (!raw || raw.isError)
            throw Error('CONNECTOR');
        let body = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw;
        if (body.provider && body.result)
            body = body.result;
        if (!body || typeof body !== 'object')
            throw Error('CONNECTOR');
        return body;
    }
    function html(text) { return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).split('\n').map(line => '<p>' + line + '</p>').join(''); }
    const fields = () => [{ field: 'id' }, { field: 'title' }, { field: 'handle' }, { field: 'status' }, { field: 'descriptionHtml' }, { field: 'variants', arguments: { first: 2 }, children: [{ field: 'nodes', children: [{ field: 'id' }, { field: 'price' }, { field: 'sku' }] }] }, { field: 'media', arguments: { first: 20 }, children: [{ field: 'nodes', children: [{ field: 'status' }, { field: 'mediaContentType' }] }] }];
    function attempt(p, connectorId, mode, publicationId) {
        const s = snapshot(p);
        if (!s)
            throw Error('REVIEW');
        if (mode === 'publish' && !publicationId)
            throw Error('PUBLICATION');
        if (mode === 'draft' && s.remoteId && s.remoteStatus !== 'DRAFT')
            throw Error('LIVE_UPDATE');
        if (s.assets.some(a => !a.remoteUrl))
            throw Error('MEDIA_UPLOAD');
        return { id: crypto.randomUUID(), connectorId, mode, publicationId: publicationId || '', snapshot: s, handle: 'orkas-' + p.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(), remoteId: s.remoteId || '', step: s.remoteId ? 'update' : 'create', status: 'prepared', createdAt: new Date().toISOString(), log: [] };
    }
    async function publish(a, invoke, persist) {
        if (a.status !== 'prepared')
            throw Error('RECONCILE');
        async function write(step, action, parameters) {
            a.status = 'unknown';
            a.step = step;
            await persist();
            let result;
            try {
                result = await invoke(action, parameters, 'H');
            }
            catch (error) {
                throw error;
            }
            if (result.status !== 'acknowledged') {
                a.status = 'failed';
                await persist();
                throw Error('REJECTED');
            }
            a.log.push({ step, status: 'acknowledged', at: new Date().toISOString() });
            return result;
        }
        const s = a.snapshot;
        let remote;
        const body = { title: s.title, descriptionHtml: html(s.description) + (s.bullets.length ? '<ul>' + s.bullets.map(b => '<li>' + html(b) + '</li>').join('') + '</ul>' : '') };
        const media = s.assets.filter(x => x.remoteUrl).map(x => ({ originalSource: x.remoteUrl, mediaContentType: x.kind === 'video' ? 'VIDEO' : 'IMAGE', alt: s.title + ' · ' + x.name }));
        if (!a.remoteId) {
            const result = await write('create', 'productCreate', { arguments: { product: { ...body, handle: a.handle, status: 'DRAFT' }, ...(media.length ? { media } : {}) }, selection: [{ field: 'product', children: fields() }] });
            remote = result.data?.productCreate?.product;
            if (!remote?.id) {
                await persist();
                throw Error('RECONCILE');
            }
            a.remoteId = remote.id;
            a.variantId = remote.variants?.nodes?.[0]?.id;
            await persist();
        }
        else {
            const current = await invoke('product', { arguments: { id: a.remoteId }, selection: fields() }, 'R');
            remote = current.data?.product;
            if (!remote || remote.variants?.nodes?.length !== 1 || !s.baseline || remote.title !== s.baseline.title || remote.descriptionHtml !== s.baseline.descriptionHtml || remote.variants.nodes[0].price !== s.baseline.price || remote.variants.nodes[0].sku !== s.baseline.sku) {
                a.status = 'conflict';
                await persist();
                throw Error('CONFLICT');
            }
            a.variantId = remote.variants.nodes[0].id;
            await write('update', 'productUpdate', { arguments: { product: { id: a.remoteId, ...body }, ...(media.length ? { media } : {}) }, selection: [{ field: 'product', children: fields() }] });
        }
        if (!a.variantId)
            throw Error('RECONCILE');
        await write('variant', 'productVariantsBulkUpdate', { arguments: { productId: a.remoteId, variants: [{ id: a.variantId, price: s.price, inventoryItem: { sku: s.sku } }], allowPartialUpdates: false }, selection: [{ field: 'productVariants', children: [{ field: 'id' }, { field: 'price' }, { field: 'sku' }] }] });
        if (a.mode === 'publish') {
            await write('activate', 'productUpdate', { arguments: { product: { id: a.remoteId, status: 'ACTIVE' } }, selection: [{ field: 'product', children: [{ field: 'id' }, { field: 'status' }] }] });
            await write('publish', 'publishablePublish', { arguments: { id: a.remoteId, input: [{ publicationId: a.publicationId }] }, selection: [{ field: 'publishable', children: [{ field: '__typename' }] }] });
        }
        a.step = 'verify';
        a.status = 'submitted';
        await persist();
        return reconcile(a, invoke, persist);
    }
    async function reconcile(a, invoke, persist) {
        let remote;
        if (a.remoteId)
            remote = (await invoke('product', { arguments: { id: a.remoteId }, selection: fields().concat(a.publicationId ? [{ field: 'publishedOnPublication', arguments: { publicationId: a.publicationId } }] : []) }, 'R')).data?.product;
        else {
            const found = (await invoke('products', { arguments: { first: 10, query: 'handle:' + a.handle }, selection: [{ field: 'nodes', children: fields() }] }, 'R')).data?.products?.nodes;
            remote = found?.find(p => p.handle === a.handle);
        }
        if (!remote) {
            a.status = 'unknown';
            await persist();
            return a;
        }
        a.remoteId = remote.id;
        const variant = remote.variants?.nodes?.[0], s = a.snapshot;
        const media = remote.media?.nodes || [];
        const mediaReady = media.length >= (s.baseline?.mediaCount || 0) + s.assets.length && media.every(item => item.status === 'READY');
        const matches = mediaReady && remote.title === s.title && variant?.sku === s.sku && Number(variant?.price) === Number(s.price) && remote.descriptionHtml === html(s.description) + (s.bullets.length ? '<ul>' + s.bullets.map(b => '<li>' + html(b) + '</li>').join('') + '</ul>' : '');
        a.mediaReady = mediaReady;
        a.status = matches && (a.mode === 'draft' ? remote.status === 'DRAFT' : remote.status === 'ACTIVE' && remote.publishedOnPublication === true) ? (a.mode === 'draft' ? 'draft' : 'published') : 'partial';
        a.remote = remote;
        await persist();
        return a;
    }
    async function storeConnectors(page) {
        const connectors = new Map(), offsets = new Set();
        let offset = 0;
        for (let count = 0; count < 20; count++) {
            if (offsets.has(offset))
                throw Error('CONNECTORS');
            offsets.add(offset);
            const result = await page({ offset, limit: 50 });
            if (!Array.isArray(result.connectors))
                throw Error('CONNECTORS');
            for (const connector of result.connectors) {
                if (!connector || typeof connector.id !== 'string' || typeof connector.name !== 'string')
                    throw Error('CONNECTORS');
                if (storeData.supported(connector.id)) connectors.set(connector.id, connector);
            }
            if (result.nextOffset === null)
                return [...connectors.values()];
            if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset)
                throw Error('CONNECTORS');
            offset = result.nextOffset;
        }
        throw Error('CONNECTORS');
    }
    function storeRequest(p, operation) {
        if (!['import', 'draft', 'publish', 'verify'].includes(operation) || !p.connectorId)
            throw Error('STORE');
        if (p.storeId && (!p.store || p.store.id !== p.storeId || p.store.connectorId !== p.connectorId)) throw Error('STORE');
        if (['draft', 'publish'].includes(operation))
            storeReview(p);
        return structuredClone({ operation, connectorId: p.connectorId, ...(p.store ? { store: storeRecord(p.store) } : {}), product: operation === 'import' ? null : storeProduct(p) });
    }
    function storeReview(p) {
        if (!(p.name.trim() || p.copy.title.trim()))
            throw Error('REVIEW');
        return structuredClone(storeProduct(p));
    }
    function storeProduct(p) {
        return {
            productId: p.id, revision: p.revision, remoteId: p.remoteId, baseline: p.baseline,
            name: p.name, sku: p.sku, price: p.price, currency: p.currency, facts: p.facts,
            confirmed: p.confirmed, title: p.copy.title, description: p.copy.description,
            bullets: p.copy.bullets, channel: p.channel, language: p.language,
            assets: p.assets.filter(a => a.selected).map(({ name, kind, remoteUrl }) => ({ name, kind, remoteUrl }))
        };
    }
    function storeProducts(text) {
        const result = json(text);
        if (!result || !Array.isArray(result.products) || result.products.length > 20)
            throw Error('PRODUCTS');
        return result.products.map(raw => {
            if (!raw || !['string', 'number'].includes(typeof raw.id) || !String(raw.id).trim() || typeof raw.name !== 'string')
                throw Error('PRODUCTS');
            const row = { id: String(raw.id), name: raw.name };
            for (const key of ['sku', 'price', 'currency', 'facts', 'title', 'description']) {
                const value = raw[key] ?? '';
                if (typeof value !== 'string' && !(key === 'price' && typeof value === 'number' && Number.isFinite(value)))
                    throw Error('PRODUCTS');
                row[key] = String(value);
            }
            return row;
        });
    }
    const listingFields = ['sku', 'price', 'currency', 'language', 'channel', 'remoteId', 'remoteStatus', 'baseline', 'copy', 'checkedAt', 'remoteState'];
    function listingData(p) {
        return structuredClone(Object.fromEntries(listingFields.map(key => [key, p[key] ?? (key === 'checkedAt' ? null : key === 'remoteState' ? 'unknown' : '')])));
    }
    function storeRecord(raw) {
        if (!raw || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id || '')) throw Error('STORE');
        const result = { id: raw.id };
        for (const key of ['connectorId', 'remoteShopId', 'name', 'platform', 'url', 'region', 'currency']) {
            if (typeof raw[key] !== 'string' || raw[key].length > 512) throw Error('STORE');
            result[key] = raw[key].trim();
        }
        if (!result.connectorId || !result.remoteShopId || !result.name) throw Error('STORE');
        if (result.url) {
            const url = new URL(result.url);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('STORE');
            result.url = url.href;
        }
        if (result.currency && !/^[A-Z]{3}$/.test(result.currency)) throw Error('STORE');
        result.connectionName = typeof raw.connectionName === 'string' ? raw.connectionName.slice(0, 512) : '';
        result.capabilities = { read: null, import: null, draft: null, publish: null, unpublish: null };
        result.checkedAt = null;
        return result;
    }
    function addStore(stores, raw) {
        const store = storeRecord(raw);
        if (stores.some(item => item.id === store.id || item.connectorId === store.connectorId && item.remoteShopId === store.remoteShopId)) throw Error('STORE');
        if (stores.length >= 100) throw Error('STORE');
        return [...stores, store];
    }
    function captureListing(p) {
        if (p.storeId) {
            p.listings ||= {};
            Object.defineProperty(p.listings, p.storeId, { value: { ...listingData(p), storeId: p.storeId, connectorId: p.connectorId, remoteShopId: p.store?.remoteShopId || '' }, enumerable: true, configurable: true, writable: true });
        }
    }
    function bindStore(p, raw) {
        const store = storeRecord(raw);
        if (p.storeId === store.id) { if (p.store?.connectorId !== store.connectorId || p.store?.remoteShopId !== store.remoteShopId) throw Error('STORE'); p.store = store; return; }
        p.listingDefaults ||= listingData(p);
        if (!p.storeId && p.connectorId && !p.legacyListing) p.legacyListing = { ...listingData(p), connectorId: p.connectorId };
        captureListing(p);
        const saved = Object.hasOwn(p.listings || {}, store.id) ? p.listings[store.id] : null;
        if (saved && (saved.connectorId !== store.connectorId || saved.remoteShopId !== store.remoteShopId)) throw Error('STORE');
        Object.assign(p, structuredClone(saved || { ...p.listingDefaults, currency: store.currency || p.listingDefaults.currency, remoteId: '', remoteStatus: '', baseline: null, checkedAt: null, remoteState: 'unknown' }));
        p.storeId = store.id;
        p.store = store;
        p.connectorId = store.connectorId;
        if (!saved) p.channel = store.platform || store.name;
        captureListing(p);
    }
    function hasContent(p) {
        return ['name','sku','price','sourceUrl','facts','remoteId','storeId','connectorId'].some(key => String(p[key] || '').trim())
            || !!(p.copy.title.trim() || p.copy.description.trim() || p.copy.bullets.length || p.assets.length || p.jobs.length || p.versions.length || p.attempts.length);
    }
    function productRow(p, updatedAt) {
        captureListing(p);
        return { id: p.id, name: p.name.trim() || p.copy.title.trim(), sku: p.listingDefaults?.sku || p.sku, updatedAt, listings: Object.values(p.listings || {}).map(item => ({ storeId: item.storeId, connectorId: item.connectorId, remoteId: item.remoteId, state: ['published', 'draft', 'unpublished'].includes(item.remoteState) ? item.remoteState : 'unknown', checkedAt: item.checkedAt || null })) };
    }
    function matchesStore(row, storeId, state = '') {
        const listings = Array.isArray(row.listings) ? row.listings : [];
        return (!storeId && !state) || listings.some(item => (!storeId || item.storeId === storeId) && (!state || item.state === state));
    }
    function pendingStoreWrite(p) {
        return p.attempts.some(a => a.connectorId === p.connectorId && (!a.store || a.store.id === p.storeId) && (a.execution === 'agent'
            ? ['unknown', 'submitted', 'submitting', 'running', 'waiting_input'].includes(a.status)
            : ['unknown', 'submitted', 'failed'].includes(a.status) && !a.remote));
    }
    function verificationProduct(p, attempt) {
        const frozen = structuredClone(p), snapshot = structuredClone(attempt.snapshot);
        return Object.assign(frozen, snapshot, { store: structuredClone(attempt.store || null), storeId: attempt.store?.id || '', connectorId: attempt.connectorId,
            name: snapshot.name || snapshot.title, remoteId: attempt.remoteId || snapshot.remoteId || '', baseline: snapshot.baseline || null,
            copy: { title: snapshot.title, description: snapshot.description, bullets: snapshot.bullets || [] }, assets: snapshot.assets.map(a => ({ ...a, selected: true })) });
    }
    const api = { product, csv, snapshot, acceptCopy, unwrap, attempt, publish, reconcile, fields, json, storeConnectors, storeRequest, storeReview, storeProducts, storeRecord, addStore, bindStore, captureListing, hasContent, productRow, matchesStore, pendingStoreWrite, verificationProduct };
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    else
        root.ListingModel = api;
})(typeof window === 'object' ? window : globalThis);
