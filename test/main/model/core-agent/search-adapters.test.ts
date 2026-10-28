import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), candidates: [] as any[], builtin: vi.fn() }));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error }),
}));

vi.mock('../../../../src/main/features/users', () => ({getActiveUserId:()=> 'synthetic-search-user'}));
vi.mock('../../../../src/main/features/search_auth', () => ({listSearchProfiles:()=>h.candidates}));
vi.mock('#core-agent',()=>({defineTool:(tool:any)=>tool,runBuiltinWebSearch:(...args:any[])=>h.builtin(...args)}));

import {
  runSearchAdapter,
  SearchAccountError,
  SEARCH_PROVIDER_LABEL,
  searchAdaptersByProvider,
} from '../../../../src/main/model/core-agent/search-adapters';

beforeEach(() => { vi.resetModules(); h.warn.mockReset(); h.error.mockReset(); h.candidates=[]; h.builtin.mockReset().mockResolvedValue({content:'Independent fallback evidence'}); });
afterEach(() => {
  vi.unstubAllGlobals();
  expect(h.error).not.toHaveBeenCalled();
});

describe('open-source BYO search adapters', () => {
  it('labels the official provider with its concrete service', () => {
    expect(SEARCH_PROVIDER_LABEL['orkas-api']).toBe('Orkas · Search');
  });

  it('uses the public Orkas search contract without a capabilities request', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Orkas', url: 'https://orkas.ai/docs', snippet: 'Official result' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'orkas-a',
      provider: 'orkas-api',
      apiKey: 'orkas-user-key',
      label: 'Orkas',
      createdAt: 0,
    }, 'public api', 4, {
      conversationId: 'conv_123',
      turnId: 'turn-456',
    });

    expect(result.results).toEqual([
      { title: 'Orkas', url: 'https://orkas.ai/docs', snippet: 'Official result' },
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(
      'https://orkas.ai/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer orkas-user-key',
          'X-Orkas-Conversation-Id': 'conv_123',
          'X-Orkas-Turn-Id': 'turn-456',
        }),
      }),
    );
    expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'public api',
      max_results: 4,
    });
  });

  it('normalizes Tavily results and bounds the requested count', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: 'One', url: 'https://example.test/one', content: 'First result' },
        { title: 'No URL', content: 'ignored' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'tavily-a',
      provider: 'tavily',
      apiKey: 'user-owned-key',
      label: 'Tavily',
      createdAt: 0,
    }, 'query', 100);

    expect(result).toEqual({
      provider: 'tavily',
      results: [{ title: 'One', url: 'https://example.test/one', snippet: 'First result' }],
    });
    expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body))).toMatchObject({
      query: 'query',
      max_results: 20,
    });
  });

  it('uses the user-owned Serper key only in the provider request header', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      organic: [{ title: 'Result', link: 'https://example.test', snippet: 'Snippet' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    await runSearchAdapter({
      id: 'serper-a',
      provider: 'serper',
      apiKey: 'user-owned-key',
      label: 'Serper',
      createdAt: 0,
    }, 'query', 3);

    expect(fetchStub).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-KEY': 'user-owned-key' }),
      }),
    );
  });

  it('fails closed for an unknown provider without making a network request', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(runSearchAdapter({
      id: 'unknown-a',
      provider: 'unknown',
      apiKey: 'user-owned-key',
      label: 'Unknown',
      createdAt: 0,
    }, 'query', 1)).rejects.toThrow('no search adapter registered');
    expect(fetchStub).not.toHaveBeenCalled();
    expect(Object.keys(searchAdaptersByProvider).sort()).toEqual([
      'baidu-ai-search',
      'brave-search',
      'deepseek',
      'keenable',
      'metaso',
      'orkas-api',
      'serper',
      'tavily',
    ]);
  });

  it('searches Keenable without a key and reads the result text from snippet', async () => {
    const pageText = `Line one of the page.\n\n  Line two.  ${'word '.repeat(200)}`;
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: 'Keenable', url: 'https://example.test/k', description: '', snippet: pageText },
        { title: 'No URL', description: '', snippet: 'ignored' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'keenable-a',
      provider: 'keenable',
      apiKey: '',
      label: 'default',
      createdAt: 0,
    }, 'keyless query', 50);

    expect(SEARCH_PROVIDER_LABEL.keenable).toBe('Keenable');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.keenable.ai/v1/search/public');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Keenable-Title': 'Orkas',
    });
    expect(JSON.parse(String(init.body))).toEqual({ query: 'keyless query', max_results: 20 });
    expect(result.provider).toBe('keenable');
    expect(result.results).toHaveLength(1);
    const [hit] = result.results;
    expect(hit).toMatchObject({ title: 'Keenable', url: 'https://example.test/k' });
    expect(hit.snippet.startsWith('Line one of the page. Line two. word word')).toBe(true);
    expect(hit.snippet).not.toMatch(/\n/);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.snippet.length).toBeLessThanOrEqual(501);
  });

  it('sends a user-owned Keenable key to the keyed endpoint only in its header', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Keyed', url: 'https://example.test/keyed', description: '', snippet: 'Short text' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await runSearchAdapter({
      id: 'keenable-b',
      provider: 'keenable',
      apiKey: ' user-owned-key ',
      label: 'default',
      createdAt: 0,
    }, 'query', 3);

    expect(fetchStub).toHaveBeenCalledWith(
      'https://api.keenable.ai/v1/search',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'X-Keenable-Title': 'Orkas',
          'X-API-Key': 'user-owned-key',
        },
      }),
    );
    expect(String((fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].body)).not.toContain('user-owned-key');
    expect(result.results).toEqual([
      { title: 'Keyed', url: 'https://example.test/keyed', snippet: 'Short text' },
    ]);
  });

  it('reports a Keenable HTTP failure with its status for the fallback chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"Too Many Requests"}', { status: 429 })));

    await expect(runSearchAdapter({
      id: 'keenable-c',
      provider: 'keenable',
      apiKey: '',
      label: 'default',
      createdAt: 0,
    }, 'query', 1)).rejects.toThrow('Keenable 429: {"detail":"Too Many Requests"}');
  });
});

describe('search transfer deadlines', () => {
  it.each(['orkas-api', 'tavily', 'serper', 'brave-search', 'baidu-ai-search', 'metaso', 'deepseek', 'keenable'])('keeps the %s deadline active while reading the response body', async (provider) => {
    vi.useFakeTimers();
    try {
      let responseSignal: AbortSignal | undefined;
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        responseSignal = init.signal;
        return new Response(new ReadableStream({ start(controller) {
          responseSignal!.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
        } }));
      }));
      const pending = runSearchAdapter({ id: 'test', provider, apiKey: 'fixture', label: '', createdAt: 0 } as any, 'query', 1);
      const outcome = pending.then(() => 'success', () => 'failed');
      await vi.advanceTimersByTimeAsync(provider === 'deepseek' ? 60_001 : 30_001);
      expect(responseSignal?.aborted).toBe(true);
      expect(await outcome).toBe('failed');
    } finally { vi.useRealTimers(); }
  });

});

describe('configured DeepSeek search', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  // Independent protocol oracle: https://api-docs.deepseek.com/api/search/.
  it('returns model-readable overseas evidence using one standalone authenticated search', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [
      { title: 'NASA mission', url: 'https://www.nasa.gov/mission/', snippet: 'Short display text', summary: 'Detailed source evidence for the model.', content: '' },
      { title: 'European source', url: 'https://www.esa.int/', snippet: 'Available short evidence', summary: '' },
    ] })));
    vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    const result = await runSearchAdapter({ provider: 'deepseek', apiKey: 'fixture-key' } as any,
      'space missions lang:en', 8);
    expect(result).toEqual({ provider: 'deepseek', results: [
      { title: 'NASA mission', url: 'https://www.nasa.gov/mission/', snippet: 'Detailed source evidence for the model.' },
      { title: 'European source', url: 'https://www.esa.int/', snippet: 'Available short evidence' },
    ] });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer fixture-key' });
    expect(JSON.parse(init.body)).toEqual({ query: 'space missions lang:en', count: 8, need_content: false });
  });

  it.each([127, 128, 129])('preserves Unicode query semantics at the %s-character boundary', async length => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    const query = '🌏'.repeat(length);
    const operation = runSearchAdapter({ provider: 'deepseek', apiKey: 'fixture-key' } as any, query, 5);
    if (length <= 128) {
      await expect(operation).resolves.toEqual({ provider: 'deepseek', results: [] });
      expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).query).toBe(query);
    } else {
      await expect(operation).rejects.toThrow('128');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each([401, 402, 403, 429, 500])('preserves HTTP %s failure without replay or exposing upstream content', async status => {
    const fetch = vi.fn(async () => new Response('private-query fixture-key', { status }));
    vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter, SearchAccountError } = await import('../../../../src/main/model/core-agent/search-adapters');
    const error = await runSearchAdapter({ provider: 'deepseek', apiKey: 'fixture-key' } as any, 'public query', 8).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(String(status));
    expect(error.message).not.toMatch(/private-query|fixture-key/);
    expect(error instanceof SearchAccountError).toBe([401, 402, 403].includes(status));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['{}', '{"results":{}}', 'not JSON'])('does not report a malformed upstream response as no matches (%s)', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({ provider: 'deepseek', apiKey: 'fixture-key' } as any, 'public query', 8))
      .rejects.toThrow('invalid response');
  });

  it('bounds the network wait and does not retry a timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    const operation = runSearchAdapter({ provider: 'deepseek', apiKey: 'fixture-key' } as any, 'public query', 8).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await operation).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('configured Metaso request contract', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // Endpoint/body oracle: the official playground's generated request source
  // https://metaso.cn/search-api/playground. Its official MCP listing also
  // declares size as an integer. Legacy response mappings remain compatible.
  it.each([[0, 1], [50, 20]])('uses the official endpoint with bounded count %s', async (count, expected) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 'Source', link: 'https://example.test/source', snippet: 'Evidence' }] })));
    vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    expect(await runSearchAdapter({ provider: 'metaso', apiKey: 'fixture-key' } as any, 'research', count))
      .toEqual({ provider: 'metaso', results: [{ title: 'Source', url: 'https://example.test/source', snippet: 'Evidence' }] });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe('https://metaso.cn/api/v1/search');
    expect(init.headers.Authorization).toBe('Bearer fixture-key');
    expect(JSON.parse(init.body)).toEqual({ q: 'research', scope: 'webpage', size: expected, includeSummary: false });
  });

  it('does not report an authentication failure as an empty search or replay it', async () => {
    const fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })); vi.stubGlobal('fetch', fetch);
    const { runSearchAdapter } = await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({ provider: 'metaso', apiKey: 'fixture-key' } as any, 'research', 5)).rejects.toThrow('Metaso 401');
    expect(fetch).toHaveBeenCalledOnce();
  });
});


describe('configured DeepSeek failure diagnostics', () => {
  beforeEach(() => { h.warn.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it.each([401,429,502])('records HTTP %s without query, key or provider prose', async status => {
    const fetch = vi.fn(async()=>new Response('PRIVATE_ERROR PRIVATE_KEY PRIVATE_QUERY',{status}));
    vi.stubGlobal('fetch',fetch);
    const {runSearchAdapter}=await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({provider:'deepseek',apiKey:'PRIVATE_KEY'} as any,'PRIVATE_QUERY',8)).rejects.toThrow(String(status));
    expect(fetch).toHaveBeenCalledOnce();
    const [message,data]=h.warn.mock.calls.at(-1)!;
    expect(message).toBe('search provider result');
    expect(data).toMatchObject({provider:'deepseek',result:'failure',reason:'http_error',phase:'after_response',status_code:status});
    expect(data.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof data.search_ref).toBe('string');
    expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/PRIVATE_/);
  });
  it('distinguishes a DNS failure before headers using only structured causes',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('PRIVATE_ERROR /private/path',{cause:{code:'ENOTFOUND'}});}));
    const {runSearchAdapter}=await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({provider:'deepseek',apiKey:'fixture'} as any,'query',8)).rejects.toThrow();
    expect(h.warn.mock.calls.at(-1)?.[1]).toMatchObject({reason:'dns_error',phase:'before_response',status_code:0});
    expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/PRIVATE_ERROR|private\/path/);
  });
  it('keeps HTTP 200 and the body phase when the full-body deadline expires',async()=>{
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>new Response(new ReadableStream({start(controller){
      init.signal.addEventListener('abort',()=>controller.error(init.signal.reason));
    }}))));
    const {runSearchAdapter}=await import('../../../../src/main/model/core-agent/search-adapters');
    const operation=runSearchAdapter({provider:'deepseek',apiKey:'fixture'} as any,'query',8).catch(e=>e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await operation).toBeInstanceOf(Error);
    expect(h.warn.mock.calls.at(-1)?.[1]).toMatchObject({reason:'deadline_timeout',phase:'after_response',status_code:200});
  });
  it('keeps the original failure when an error accessor or diagnostic sink throws',async()=>{
    const original=new Error('fixture transport failure');
    Object.defineProperty(original,'code',{get(){throw new Error('PRIVATE_ERROR');}});
    const fetch=vi.fn(async()=>{throw original;}); vi.stubGlobal('fetch',fetch);
    h.warn.mockImplementationOnce(()=>{throw new Error('PRIVATE_ERROR');});
    const {runSearchAdapter}=await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({provider:'deepseek',apiKey:'fixture'} as any,'query',8)).rejects.toBe(original);
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.warn.mock.calls.at(-1)?.[1]).toMatchObject({reason:'transport_error',status_code:0});
  });
  it('records validation failure rather than transport failure for malformed data',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('PRIVATE_ERROR')));
    const {runSearchAdapter}=await import('../../../../src/main/model/core-agent/search-adapters');
    await expect(runSearchAdapter({provider:'deepseek',apiKey:'fixture'} as any,'query',8)).rejects.toThrow('invalid response');
    expect(h.warn.mock.calls.at(-1)?.[1]).toMatchObject({reason:'invalid_response',phase:'response_validation',status_code:200});
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('PRIVATE_ERROR');
  });
});


describe('public search query and response bounds', () => {
  it.each(['orkas-api', 'deepseek', 'serper', 'brave-search', 'baidu-ai-search', 'metaso', 'tavily'])('rejects over-limit Unicode input before %s dispatch', async provider => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(runSearchAdapter({provider, apiKey:'fixture'} as any, '🌏'.repeat(provider === 'tavily' ? 401 : 129), 8)).rejects.toThrow(String(provider === 'tavily' ? 400 : 128));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['deepseek',128], ['tavily',400]] as const)('sends the complete trimmed %s Unicode query', async(provider,length)=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({results:[]}))); vi.stubGlobal('fetch',fetch);
    const query='🌏'.repeat(length);
    await runSearchAdapter({provider,apiKey:'fixture'} as any,'  '+query+'  ',3);
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).query).toBe(query);
  });
  it.each(['deepseek','tavily'])('rejects unsafe result URLs and bounds %s evidence',async provider=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({results:[
      {url:'javascript:alert(1)',summary:'unsafe',content:'unsafe'},
      {url:'https://user:password@example.org',summary:'secret',content:'secret'},
      {title:'Valid',url:'https://example.org/a',summary:'DS evidence',snippet:'Short',content:'TV evidence'},
      {title:'Extra',url:'https://example.org/b',summary:'extra',content:'extra'}
    ]}))));
    expect((await runSearchAdapter({provider,apiKey:'fixture'} as any,'query',1)).results).toEqual([
      {title:'Valid',url:'https://example.org/a',snippet:provider==='deepseek'?'DS evidence':'TV evidence'}
    ]);
  });
  it.each(['orkas-api','deepseek','tavily','serper','brave-search','baidu-ai-search','metaso'])('caps the %s body before parsing',async provider=>{
    const cancelled=vi.fn(); let sent=false;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(2_000_001));}},cancel:cancelled}))));
    await expect(runSearchAdapter({provider,apiKey:'fixture'} as any,'query',8)).rejects.toThrow('too large');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each([401,402,403,429,500])('Tavily HTTP %s is safe, typed and not retried',async status=>{
    const fetch=vi.fn(async()=>new Response('PRIVATE_KEY PRIVATE_QUERY',{status})); vi.stubGlobal('fetch',fetch);
    const error=await runSearchAdapter({provider:'tavily',apiKey:'PRIVATE_KEY'} as any,'query',8).catch(error=>error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain(String(status));
    expect(error.message).not.toContain('PRIVATE_');
    expect(error instanceof SearchAccountError).toBe([401,402,403].includes(status));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uses only the Tavily Authorization header for the user key',async()=>{
    const fetch=vi.fn(async()=>new Response(JSON.stringify({results:[]})));vi.stubGlobal('fetch',fetch);
    await runSearchAdapter({provider:'tavily',apiKey:'fixture-key'} as any,'query',8);
    const [,init]=fetch.mock.calls[0] as any;
    expect(init.headers.Authorization).toBe('Bearer fixture-key');
    expect(JSON.parse(init.body)).toEqual({query:'query',max_results:8,search_depth:'basic'});
  });
  it.each(['{}','{"results":{}}','not JSON'])('does not turn malformed Tavily data into empty matches (%s)',async body=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)));
    await expect(runSearchAdapter({provider:'tavily',apiKey:'fixture'} as any,'query',8)).rejects.toThrow('invalid response');
  });
});


describe('configured public search through the real adapter and tool',()=>{
  it('uses the existing credential cooldown after rejected DeepSeek credentials, retaining free fallback',async()=>{
    h.candidates=[{id:'deepseek',provider:'deepseek',apiKey:'fixture-key'}];
    const fetch=vi.fn(async()=>new Response('PRIVATE_UPSTREAM',{status:401}));vi.stubGlobal('fetch',fetch);
    const {createWebSearchOverrideTool}=await import('../../../../src/main/model/core-agent/search-tools');
    const tool=await createWebSearchOverrideTool();
    for(const query of ['first public query','second public query']){
      const result=await tool.execute({query},{} as any);
      expect(result.isError).not.toBe(true);expect(result.content).toContain('Independent fallback evidence');
      expect(result.content).not.toContain('PRIVATE_UPSTREAM');
    }
    expect(fetch).toHaveBeenCalledOnce();expect(h.builtin).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls.filter(([message])=>message==='search provider result')).toHaveLength(1);
    expect(h.warn.mock.calls.filter(([message])=>message==='paid search failed; trying next provider')).toHaveLength(1);
  });
  it('preserves a short Unicode query when Tavily fails and DeepSeek succeeds',async()=>{
    h.candidates=[{id:'tavily',provider:'tavily',apiKey:'first'},{id:'deepseek',provider:'deepseek',apiKey:'second'}];
    const fetch=vi.fn(async(url)=>String(url).includes('tavily')?new Response('unavailable',{status:503}):new Response(JSON.stringify({results:[{url:'https://example.org',summary:'Recovered source'}]})));
    vi.stubGlobal('fetch',fetch);
    const {createWebSearchOverrideTool}=await import('../../../../src/main/model/core-agent/search-tools');
    const query='🌏'.repeat(128);const result=await(await createWebSearchOverrideTool()).execute({query},{} as any);
    expect(result.isError).not.toBe(true);expect(result.content).toContain('Recovered source');
    expect(fetch).toHaveBeenCalledTimes(2);expect(h.builtin).not.toHaveBeenCalled();
    for(const [,init] of fetch.mock.calls as any)expect(JSON.parse(init.body).query).toBe(query);
  });
  it('stops before an incompatible second configured provider without rewriting a valid first-provider query',async()=>{
    h.candidates=[{id:'tavily',provider:'tavily',apiKey:'first'},{id:'deepseek',provider:'deepseek',apiKey:'second'}];
    const fetch=vi.fn(async()=>new Response('unavailable',{status:503}));vi.stubGlobal('fetch',fetch);
    const {createWebSearchOverrideTool}=await import('../../../../src/main/model/core-agent/search-tools');
    const query='🌏'.repeat(200);const result=await(await createWebSearchOverrideTool()).execute({query},{} as any);
    expect(result.isError).toBe(true);expect(result.content).toContain('128');
    expect(fetch).toHaveBeenCalledOnce();expect(h.builtin).not.toHaveBeenCalled();
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).query).toBe(query);
  });
});
