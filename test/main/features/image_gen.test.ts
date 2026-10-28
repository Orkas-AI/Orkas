import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Tests cover the parts that *aren't* obvious from reading the code:
//   - pickImageGenProfile's filter/match contract (the OAuth-skip + capability
//     lookup is the whole point of the design — easy to regress)
//   - adapter request construction (URL / headers / body shape) via mock fetch
//   - provider fallback and the bytes-on-disk success boundary
//   - PNG dimension parsing (guards the bytes->dimensions math)

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '99999999';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-imggen-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  const proxy = await import('../../../src/main/util/proxy-dispatcher');
  proxy._resetProxyRoutingForTests();
  vi.unstubAllGlobals();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────

function writeProfilesFile(
  profiles: Record<string, unknown>,
  entries: unknown[],
  imageProfiles?: unknown[],
): void {
  const dir = path.join(tmpDir, TEST_UID, 'local', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'auth-profiles.json'),
    JSON.stringify({
      version: imageProfiles ? 4 : 3,
      profiles,
      entries,
      ...(imageProfiles ? { imageProfiles } : {}),
    }, null, 2),
    'utf-8',
  );
}

function apiKeyProfile(provider: string, key: string, label = 'default') {
  return {
    type: 'api_key',
    provider,
    label,
    key,
    createdAt: 1000,
    lastUsed: 0,
  };
}

function oauthProfile(provider: string, label = 'default') {
  return {
    type: 'oauth',
    provider,
    label,
    access: 'tok-access',
    refresh: 'tok-refresh',
    expires: Date.now() + 3600_000,
    createdAt: 1000,
    lastUsed: 0,
  };
}

function entry(provider: string, model: string, profileId: string, entryId: string) {
  return { entryId, provider, model, profileId, lastUsed: 0, createdAt: 1000 };
}

// ── pickImageGenProfile ──────────────────────────────────────────────────

describe('image_gen › pickImageGenProfile', () => {
  it('returns null when no entries exist', async () => {
    writeProfilesFile({}, []);
    const m = await import('../../../src/main/features/image_gen');
    expect(m.pickImageGenProfile()).toBeNull();
  });

  it('returns null when only OAuth entries exist (even on capable provider)', async () => {
    // OAuth on an image-capable provider must NOT count — every OAuth surface
    // we ship is scope-restricted away from image generation. This is the
    // load-bearing invariant that prevents "I logged in, why doesn't it work".
    writeProfilesFile(
      { 'google:default': oauthProfile('google') },
      [entry('google', 'gemini-3.8-flash', 'google:default', 'e1')],
    );
    const m = await import('../../../src/main/features/image_gen');
    expect(m.pickImageGenProfile()).toBeNull();
  });

  it('returns null when only api-key entries on non-capable providers exist', async () => {
    // Anthropic has no image API at all — capability map deliberately omits it.
    writeProfilesFile(
      { 'anthropic:default': apiKeyProfile('anthropic', 'sk-ant-xxx') },
      [entry('anthropic', 'claude-opus-4-7', 'anthropic:default', 'e1')],
    );
    const m = await import('../../../src/main/features/image_gen');
    expect(m.pickImageGenProfile()).toBeNull();
  });

  it('picks first capable api-key entry, ignoring earlier non-capable entries', async () => {
    // Order matters: priority list says anthropic first, then openai. The
    // picker must skip anthropic (no image API) and land on openai (capable).
    // The user's chat model on the openai entry (gpt-5.5) is irrelevant —
    // the capability map fixes the model to gpt-image-1.
    writeProfilesFile(
      {
        'anthropic:default': apiKeyProfile('anthropic', 'sk-ant-xxx'),
        'openai:default':    apiKeyProfile('openai',    'sk-openai-xxx'),
      },
      [
        entry('anthropic', 'claude-opus-4-7', 'anthropic:default', 'e1'),
        entry('openai',    'gpt-6-astra',         'openai:default',    'e2'),
      ],
    );
    const m = await import('../../../src/main/features/image_gen');
    const picked = m.pickImageGenProfile();
    expect(picked).not.toBeNull();
    expect(picked!.entry.provider).toBe('openai');
    expect(picked!.entry.apiKey).toBe('sk-openai-xxx');
    expect(picked!.capability.model).toBe('gpt-image-2');
    expect(picked!.capability.api).toBe('openai');
  });

  it('skips OAuth google entry but picks api-key google entry further down', async () => {
    // Real-world failure mode: user has Gemini CLI logged in (OAuth) AND
    // an AI Studio API key configured. OAuth must lose to API key for
    // image gen, regardless of priority order.
    writeProfilesFile(
      {
        'google:cli':    oauthProfile('google', 'cli'),
        'google:studio': apiKeyProfile('google', 'AIza-xxx', 'studio'),
      },
      [
        entry('google', 'gemini-3.8-flash', 'google:cli',    'e1'),
        entry('google', 'gemini-3.8-flash', 'google:studio', 'e2'),
      ],
    );
    const m = await import('../../../src/main/features/image_gen');
    const picked = m.pickImageGenProfile();
    expect(picked!.entry.profileId).toBe('google:studio');
    expect(picked!.capability.model).toBe('gemini-nano-banana-2.1');
    expect(picked!.capability.api).toBe('gemini');
  });
});

describe('image_gen › Flash and Pro service choices', () => {
  it.each(['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628'])(
    'saves and selects %s without using the managed service', async model => {
      writeProfilesFile({}, [], []);
      const auth = await import('../../../src/main/features/image_auth');
      const m = await import('../../../src/main/features/image_gen');
      const result = auth.addImageProfile({ provider: 'doubao', model, apiKey: 'fixture-key' });
      expect(result.ok).toBe(true);
      expect(m.pickImageGenProfile()?.capability).toMatchObject({ api: 'doubao', model });
      expect(auth.listImageModelOptions('doubao').map(option => option.id)).toEqual([
        'doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628',
      ]);
    });

  it('uses Flash for an unversioned own-key service and keeps explicit saved Lite choices readable', async () => {
    writeProfilesFile({}, [], [{ id: 'old', provider: 'doubao', apiKey: 'fixture-key', label: 'old', createdAt: 1 }]);
    const m = await import('../../../src/main/features/image_gen');
    expect(m.pickImageGenProfile()?.capability.model).toBe('doubao-seedream-5-0-flash-260915');
    writeProfilesFile({}, [], [{ id: 'old', provider: 'doubao', model: 'doubao-seedream-5-0-lite-260128', apiKey: 'fixture-key', label: 'old', createdAt: 1 }]);
    expect(m.pickImageGenProfile()?.capability.model).toBe('doubao-seedream-5-0-lite-260128');
  });
});

describe('image_gen › generateImage', () => {
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it.each([
    ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
    ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
  ])('saves the selected %s profile and uses it for generation and editing', async (model, name) => {
    writeProfilesFile({}, [], [{
      id: 'legacy-openai', provider: 'openai', apiKey: 'sk-legacy', label: 'legacy', createdAt: 1,
    }]);
    const m = await import('../../../src/main/features/image_gen');
    const auth = await import('../../../src/main/features/image_auth');
    expect(m.pickImageGenProfile()?.capability.model).toBe('gpt-image-2');

    const options = auth.flattenImageProviderOptions(auth.listImageProviderOptions());
    const option = options.find((item) => item.model === model);
    expect(option).toMatchObject({
      id: `openai:${model}`, provider: 'openai', model, label: `OpenAI · ${name}`,
    });
    const added = auth.addImageProfile({
      provider: option!.provider, model: option!.model, apiKey: 'sk-selected', label: 'selected',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(auth.listImageProfiles()).toEqual([
      expect.objectContaining({ id: added.id, provider: 'openai', model }),
      expect.objectContaining({ id: 'legacy-openai' }),
    ]);

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const output = path.join(tmpDir, 'selected.png');
    await expect(m.generateImage({ prompt: 'a red cube', outputAbsPath: output })).resolves.toMatchObject({
      ok: true, provider: 'openai', model, path: output, width: 1, height: 1,
    });
    expect(fs.readFileSync(output)).toEqual(Buffer.from(PNG_B64, 'base64'));
    const [generationUrl, generationInit] = fetchMock.mock.calls[0];
    expect(generationUrl).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(generationInit.body as string)).toMatchObject({ model, n: 1, size: '1024x1024' });
    expect(generationInit.headers).toMatchObject({ Authorization: 'Bearer sk-selected' });

    const edited = path.join(tmpDir, 'edited.png');
    await expect(m.generateImage({
      prompt: 'change the cube to blue', outputAbsPath: edited, referenceImagePaths: [output],
    })).resolves.toMatchObject({ ok: true, provider: 'openai', model, path: edited });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [editUrl, editInit] = fetchMock.mock.calls[1];
    expect(editUrl).toBe('https://api.openai.com/v1/images/edits');
    const form = editInit.body as FormData;
    expect(form.get('model')).toBe(model);
    const references = form.getAll('image[]') as File[];
    expect(references).toHaveLength(1);
    expect(Buffer.from(await references[0].arrayBuffer())).toEqual(fs.readFileSync(output));
    expect(fs.readFileSync(edited)).toEqual(Buffer.from(PNG_B64, 'base64'));
  });

  it('rejects the ambiguous GPT Image 2.5 family name without saving a profile', async () => {
    writeProfilesFile({}, [], []);
    const auth = await import('../../../src/main/features/image_auth');
    expect(auth.addImageProfile({ provider: 'openai', model: 'gpt-image-2.5', apiKey: 'sk-test' })).toEqual({
      ok: false, error: 'unsupported image model "openai/gpt-image-2.5"',
    });
    expect(auth.listImageProfiles()).toEqual([]);
  });

  it('rejects a provider HTTP success with invalid bytes and falls back to the next configured provider', async () => {
    writeProfilesFile({}, [], [
      {
        id: 'image-openai',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'sk-openai',
        label: 'first',
        createdAt: 1,
      },
      {
        id: 'image-google',
        provider: 'google',
        model: 'gemini-3.1-flash-image-preview',
        apiKey: 'google-key',
        label: 'fallback',
        createdAt: 2,
      },
    ]);
    const attemptedUrls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      attemptedUrls.push(url);
      if (url.includes('api.openai.com')) {
        const htmlAsBase64 = Buffer.from('<html>upstream error</html>').toString('base64');
        return new Response(JSON.stringify({ data: [{ b64_json: htmlAsBase64 }] }), { status: 200 });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_B64 } }] } }],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const m = await import('../../../src/main/features/image_gen');
      const output = path.join(tmpDir, 'generated', 'fallback-result');
      const result = await m.generateImage({ prompt: 'a calm lake', outputAbsPath: output });

      expect(result).toMatchObject({
        ok: true,
        provider: 'google',
        path: `${output}.png`,
        width: 1,
        height: 1,
      });
      expect(attemptedUrls).toHaveLength(2);
      expect(fs.readFileSync(`${output}.png`)).toEqual(Buffer.from(PNG_B64, 'base64'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports provider failure and leaves no artifact when every HTTP-success payload is invalid', async () => {
    writeProfilesFile({}, [], [{
      id: 'image-openai',
      provider: 'openai',
      model: 'gpt-image-2',
      apiKey: 'sk-openai',
      label: 'only',
      createdAt: 1,
    }]);
    vi.stubGlobal('fetch', async () => {
      const htmlAsBase64 = Buffer.from('<html>not an image</html>').toString('base64');
      return new Response(JSON.stringify({ data: [{ b64_json: htmlAsBase64 }] }), { status: 200 });
    });

    try {
      const m = await import('../../../src/main/features/image_gen');
      const output = path.join(tmpDir, 'generated', 'invalid-result');
      const result = await m.generateImage({ prompt: 'a calm lake', outputAbsPath: output });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_API_ERROR',
        message: expect.stringMatching(/invalid or unsupported image bytes/i),
      });
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(`${output}.png`)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('redacts secrets and personal data from the final provider failure returned to the model', async () => {
    writeProfilesFile({}, [], [{
      id: 'image-openai',
      provider: 'openai',
      model: 'gpt-image-2',
      apiKey: 'sk-local-secret',
      label: 'only',
      createdAt: 1,
    }]);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      error: {
        message: 'denied',
        apiKey: 'sk-returned-secret-value',
        email: 'owner@example.test',
      },
    }), { status: 401 }));
    const output = path.join(tmpDir, 'must-not-exist.png');

    try {
      const m = await import('../../../src/main/features/image_gen');
      const result = await m.generateImage({ prompt: 'a calm lake', outputAbsPath: output });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_API_ERROR',
        message: expect.stringContaining('401'),
      });
      if (result.ok) return;
      expect(result.message).not.toContain('sk-returned-secret-value');
      expect(result.message).not.toContain('owner@example.test');
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not call a second provider when generated image bytes cannot be saved locally', async () => {
    writeProfilesFile({}, [], [
      {
        id: 'image-doubao',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-lite-260128',
        apiKey: 'doubao-key',
        label: 'primary',
        createdAt: 1,
      },
      {
        id: 'image-openai',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'sk-openai',
        label: 'fallback',
        createdAt: 2,
      },
    ]);
    let generationCount = 0;
    let fallbackCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        generationCount += 1;
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
      }
      if (url.includes('api.openai.com')) {
        fallbackCount += 1;
        throw new Error('replacement provider must not be dispatched');
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const blockedParent = path.join(tmpDir, 'parent-is-a-file');
    fs.writeFileSync(blockedParent, 'occupied');

    try {
      const m = await import('../../../src/main/features/image_gen');
      await expect(m.generateImage({
        prompt: 'one paid image',
        outputAbsPath: path.join(blockedParent, 'out.png'),
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'IO_ERROR',
      });
      expect(generationCount).toBe(1);
      expect(fallbackCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── callOpenAIImage (mock fetch) ─────────────────────────────────────────

describe('image_gen › callOpenAIImage', () => {
  it('hits /v1/images/generations with JSON body for text-only prompts', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      // Minimal valid PNG (1x1 black pixel) base64. Lets the response parser
      // succeed without us building a real PNG byte-by-byte.
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const m = await import('../../../src/main/features/image_gen');
      const progress: Array<{ phase: string; message: string }> = [];
      const res = await m.callOpenAIImage({
        apiKey: 'sk-test',
        model: 'gpt-image-1',
        prompt: 'a red cube',
        size: '1024x1024',
        onProgress: (event) => progress.push(event),
      });
      expect(captured.url).toBe('https://api.openai.com/v1/images/generations');
      expect(captured.init?.method).toBe('POST');
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(captured.init?.body as string);
      expect(body).toEqual({ model: 'gpt-image-1', prompt: 'a red cube', size: '1024x1024', n: 1 });
      expect(res.mimeType).toBe('image/png');
      expect(res.width).toBe(1);
      expect(res.height).toBe(1);
      expect(progress.map((e) => e.phase)).toEqual(['create_image', 'decode_image']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hits /v1/images/edits with multipart body when reference_images present', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
    });
    try {
      const m = await import('../../../src/main/features/image_gen');
      // PNG signature in a 1-byte payload so detectMimeType returns image/png
      const refBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const refPath = path.join(tmpDir, 'ref.png');
      fs.writeFileSync(refPath, refBuf);
      const progress: Array<{ phase: string; message: string }> = [];
      await m.callOpenAIImage({
        apiKey: 'sk-test',
        model: 'gpt-image-1',
        prompt: 'change the cube to blue',
        size: '1024x1024',
        referenceImagePaths: [refPath],
        onProgress: (event) => progress.push(event),
      });
      expect(captured.url).toBe('https://api.openai.com/v1/images/edits');
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      // No explicit Content-Type — fetch sets multipart boundary itself.
      expect(headers['Content-Type']).toBeUndefined();
      // FormData round-trip is awkward to assert on directly; the URL +
      // header proof is enough to lock the routing decision.
      expect(captured.init?.body).toBeDefined();
      expect(progress.map((e) => e.phase)).toEqual(['reference_load', 'create_image', 'decode_image']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws with provider status when the API returns an error', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('{"error":{"message":"organization must be verified"}}', { status: 403 }),
    );
    try {
      const m = await import('../../../src/main/features/image_gen');
      await expect(
        m.callOpenAIImage({ apiKey: 'sk-test', model: 'gpt-image-1', prompt: 'x', size: '1024x1024' }),
      ).rejects.toThrow(/OpenAI image API 403/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── callGeminiImage (mock fetch) ─────────────────────────────────────────

describe('image_gen › callGeminiImage', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  // Independent pixel/ratio pairs from Google's per-model GenerateContent tables.
  it.each([
    ['gemini-nano-banana-2.1', '2752x1536', { aspectRatio: '16:9', imageSize: '2K' }],
    ['gemini-nano-banana-2.1', '1536x12288', { aspectRatio: '1:8', imageSize: '4K' }],
    ['gemini-3.1-flash-image-preview', '512x512', { aspectRatio: '1:1', imageSize: '512' }],
    ['gemini-3-pro-image', '3584x4800', { aspectRatio: '3:4', imageSize: '4K' }],
    ['gemini-2.5-flash-image', '1344x768', { aspectRatio: '16:9' }],
  ] as const)('sends the exact supported %s size %s through its image adapter', async (model, size, imageConfig) => {
    writeProfilesFile({}, [], [{ id: 'google-size', provider: 'google', model, apiKey: 'fixture-key', label: 'Images', createdAt: 1 }]);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).generationConfig).toEqual({ responseModalities: ['IMAGE'], imageConfig });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }));
    });
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'size-result.png');
    if (model === 'gemini-nano-banana-2.1' || model === 'gemini-3.1-flash-image-preview') {
      expect(await m.generateImage({ prompt: 'a lake', size, outputAbsPath: output })).toMatchObject({ ok: true, width: 1, height: 1 });
      expect(fs.readFileSync(output)).toEqual(Buffer.from(PNG_B64, 'base64'));
    } else {
      expect((await m.callGeminiImage({ apiKey: 'fixture-key', model, size, prompt: 'a lake' })).buffer).toEqual(Buffer.from(PNG_B64, 'base64'));
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['gemini-nano-banana-2.1', '1920x1080'], ['gemini-nano-banana-2.1', '512x512'],
    ['gemini-3-pro-image', '512x2048'], ['gemini-2.5-flash-image', '2048x2048'],
    ['unknown-image-model', '1024x1024'],
  ])('rejects unsupported %s size %s before reference I/O and dispatch', async (model, size) => {
    writeProfilesFile({}, [], [{ id: 'google-size', provider: 'google', model, apiKey: 'fixture-key', label: 'Images', createdAt: 1 }]);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'rejected.png');
    const references = { referenceImagePaths: [path.join(tmpDir, 'missing.png')] };
    if (model === 'gemini-nano-banana-2.1') {
      expect(await m.generateImage({ prompt: 'a lake', size, outputAbsPath: output, ...references }))
        .toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false });
    }
    await expect(m.callGeminiImage({ apiKey: 'fixture-key', model, size, prompt: 'a lake', ...references })).rejects.toThrow(/Unsupported image size/);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(output)).toBe(false);
  });

  it('keeps auto dimensions absent when editing and preserves a real primary failure before an incompatible fallback', async () => {
    const model = 'gemini-nano-banana-2.1';
    const google = { id: 'google-size', provider: 'google', model, apiKey: 'fixture-key', label: 'Images', createdAt: 1 };
    writeProfilesFile({}, [], [google]);
    const ref = path.join(tmpDir, 'ref.png'); fs.writeFileSync(ref, Buffer.from(PNG_B64, 'base64'));
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig).toEqual({ responseModalities: ['IMAGE'] });
      expect(body.contents[0].parts).toHaveLength(2);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }));
    });
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    expect(await m.generateImage({ prompt: 'edit', size: 'auto', referenceImagePaths: [ref], outputAbsPath: path.join(tmpDir, 'auto.png') })).toMatchObject({ ok: true });
    (await import('../../../src/main/features/auth')).saveImageProfiles([
      { ...google, id: 'openai-first', provider: 'openai', model: 'gpt-image-2' }, google,
    ]);
    fetch.mockImplementation(async () => new Response('primary failed', { status: 500 }));
    const result = await m.generateImage({ prompt: 'a lake', size: '1920x1080', outputAbsPath: path.join(tmpDir, 'fallback.png') });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR' });
    expect(result).not.toHaveProperty('dispatched', false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  // Google announced retirement of the3.1image preview and publishes both
  // the same-generation GA ID and Nano Banana2.1 in generateContent docs.
  // Requester approved GA mapping for old profiles and2.1 as the new default.
  it.each([
    ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image'],
    ['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1'],
    [undefined, 'gemini-nano-banana-2.1'],
  ])('generates from saved Google configuration %s using %s without rewriting it', async (savedModel, upstreamModel) => {
    let profile = { id: 'saved-google', provider: 'google', model: savedModel, apiKey: 'fixture-key', label: 'My images', createdAt: 1 };
    if (savedModel === 'gemini-nano-banana-2.1') {
      writeProfilesFile({}, []);
      const imageAuth = await import('../../../src/main/features/image_auth');
        const options = imageAuth.flattenImageProviderOptions(imageAuth.listImageProviderOptions()).filter(p => p.provider === 'google');
      expect(options.map(p => ({ model: p.model, label: p.label }))).toEqual([
        { model: savedModel, label: 'Google · Nano Banana 2.1' },
        { model: 'gemini-3.1-flash-image-preview', label: 'Google · Nano Banana 2' },
      ]);
      const added = imageAuth.addImageProfile({ provider: 'google', apiKey: profile.apiKey, label: profile.label });
      expect(added.ok).toBe(true);
      const auth = await import('../../../src/main/features/auth');
      profile = auth.loadImageProfiles().find(p => p.id === (added as { id: string }).id)! as typeof profile;
      expect(profile.model).toBe(savedModel);
    } else if (savedModel) writeProfilesFile({}, [], [profile]);
    else writeProfilesFile({ 'google:studio': apiKeyProfile('google', 'fixture-key', 'studio') }, [entry('google', 'gemini-3.8-flash', 'google:studio', 'google-main')]);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${upstreamModel}:generateContent`);
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'fixture-key' });
      expect(JSON.parse(String(init?.body))).toEqual({ contents: [{ parts: [{ text: 'a quiet lake' }] }], generationConfig: { responseModalities: ['IMAGE'] } });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }));
    });
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'google-result.png');
    expect(await m.generateImage({ prompt: 'a quiet lake', outputAbsPath: output }))
      .toMatchObject({ ok: true, provider: 'google', model: savedModel || upstreamModel, path: output });
    expect(fs.readFileSync(output)).toEqual(Buffer.from(PNG_B64, 'base64'));
    expect(fetch).toHaveBeenCalledOnce();
    if (savedModel) {
      // The normal reader migrates plaintext fixtures into encrypted storage.
      const auth = await import('../../../src/main/features/auth');
      expect(auth.loadImageProfiles().find(p => p.id === profile.id)).toEqual(profile);
    }
  });

  it('hits generateContent with x-goog-api-key header and inline_data response', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: b64 } }] } }],
      }), { status: 200 });
    });
    try {
      const m = await import('../../../src/main/features/image_gen');
      const progress: Array<{ phase: string; message: string }> = [];
      const res = await m.callGeminiImage({
        apiKey: 'AIza-test',
        model: 'gemini-2.5-flash-image-preview',
        prompt: 'a cat',
        size: '1024x1024',
        onProgress: (event) => progress.push(event),
      });
      expect(captured.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent',
      );
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('AIza-test');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(captured.init?.body as string);
      expect(body.contents[0].parts[0]).toEqual({ text: 'a cat' });
      expect(body.generationConfig.responseModalities).toEqual(['IMAGE']);
      expect(res.mimeType).toBe('image/png');
      expect(res.width).toBe(1);
      expect(progress.map((e) => e.phase)).toEqual(['create_image', 'decode_image']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('also accepts camelCase inlineData / mimeType (newer Gemini API variant)', async () => {
    vi.stubGlobal('fetch', async () => {
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }],
      }), { status: 200 });
    });
    try {
      const m = await import('../../../src/main/features/image_gen');
      const res = await m.callGeminiImage({
        apiKey: 'AIza-test',
        model: 'gemini-2.5-flash-image-preview',
        prompt: 'a cat',
        size: '1024x1024',
      });
      expect(res.mimeType).toBe('image/png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws when no inline image data appears in any candidate part', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I cannot' }] } }] }), { status: 200 }),
    );
    try {
      const m = await import('../../../src/main/features/image_gen');
      await expect(
        m.callGeminiImage({ apiKey: 'k', model: 'gemini-2.5-flash-image-preview', prompt: 'x', size: '1024x1024' }),
      ).rejects.toThrow(/no inline image data/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('image_gen › callDoubaoImage', () => {
  // Official Flash/Pro sizes are exact requests, not hints to downgrade.
  it.each(['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'].flatMap(model => [
    [' 1K ', '1k'], ['1.5k', '1.5k'], ['2k', '2k'], ['', '2k'],
    ['960x960', '960x960'], ['1024x1024', '1024x1024'], ['2048x2048', '2048x2048'],
    ['2048x2257', '2048x2257'], ['1920x1920', '1920x1920'],
  ].map(([size, expected]) => [model, size, expected])))('preserves %s size %s as %s', async (model, size, expected) => {
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] })));
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    await m.callDoubaoImage({ apiKey: 'fixture-key', model, size, prompt: 'a quiet lake' });
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetch.mock.calls[0] as any)[1].body));
    expect(body.size).toBe(expected);
    expect(body).not.toHaveProperty('sequential_image_generation');
  });

  it.each(['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'].flatMap(model =>
    ['3k', '4k', '4096x4096', '959x960', '2048x2258', '4097x256', 'adaptive'].map(size => [model, size])))
  ('rejects unsupported %s size %s before reading references or calling a provider', async (model, size) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    await expect(m.callDoubaoImage({ apiKey: 'fixture-key', model, size, prompt: 'a lake',
      referenceImagePaths: [path.join(tmpDir, 'does-not-exist.png')] })).rejects.toThrow(/size.*1k.*1\.5k.*2k/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the actual legacy provider failure when an incompatible Flash fallback is skipped', async () => {
    writeProfilesFile({}, [], [
      { id: 'lite', provider: 'doubao', model: 'doubao-seedream-5-0-lite-260128', apiKey: 'fixture-key', label: 'lite', createdAt: 1 },
      { id: 'flash', provider: 'doubao', model: 'doubao-seedream-5-0-flash-260915', apiKey: 'fixture-key', label: 'flash', createdAt: 1 },
    ]);
    const fetch = vi.fn(async () => { throw new Error('fixture provider unavailable'); });
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    const result = await m.generateImage({ prompt: 'a lake', size: '4k', outputAbsPath: path.join(tmpDir, 'none.png') });
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'fixture provider unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns a non-dispatched input error instead of silently generating 2K or billing a fallback service', async () => {
    writeProfilesFile({}, [], [
      { id: 'flash', provider: 'doubao', model: 'doubao-seedream-5-0-flash-260915', apiKey: 'fixture-key', label: 'flash', createdAt: 1 },
      { id: 'fallback', provider: 'openai', model: 'gpt-image-2', apiKey: 'fixture-key', label: 'fallback', createdAt: 1 },
    ]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }] })));
    vi.stubGlobal('fetch', fetch);
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'not-generated.png');
    const result = await m.generateImage({ prompt: 'a lake', size: '4k', outputAbsPath: output });
    expect(result).toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false });
    expect(fetch).not.toHaveBeenCalled(); expect(fs.existsSync(output)).toBe(false);
  });

  it.each([
    ['adaptive', '2k'],
    ['1k', '2k'],
    ['AUTO', '2k'],
    ['not-a-size', '2k'],
    ['1024x1024', '2k'],
    ['1920x1919', '2k'],
    ['4097x4096', '2k'],
    [' 3K ', '3k'],
    ['1920x1920', '1920x1920'],
    ['4096x4096', '4096x4096'],
  ])('normalizes Seedream size %j to %j before provider dispatch', async (inputSize, expectedSize) => {
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body || '{}'));
      return new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), { status: 200 });
    });

    try {
      const m = await import('../../../src/main/features/image_gen');
      await m.callDoubaoImage({
        apiKey: 'doubao-key',
        model: 'doubao-seedream-5-0-lite-260128',
        prompt: 'a calm lake',
        size: inputSize,
      });

      expect(sentBody.size).toBe(expectedSize);
      expect(sentBody.size).not.toBe('adaptive');
      expect(sentBody.size).not.toBe('1k');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['doubao-seedream-5-0-lite-260128', true],
    ['doubao-seedream-5-0-pro-260628', false],
    ['doubao-seedream-5-0-flash-260915', false],
    ['doubao-seedream-4-5-251128', true],
  ] as const)('uses the supported single-image contract for %s', async (model, supportsSequential) => {
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const referencePath = path.join(tmpDir, 'reference.png');
    fs.writeFileSync(referencePath, Buffer.from(pngB64, 'base64'));
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body || '{}'));
      return new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), { status: 200 });
    });

    try {
      const m = await import('../../../src/main/features/image_gen');
      const result = await m.callDoubaoImage({
        apiKey: 'doubao-key',
        model,
        prompt: 'edit this image',
        size: '1024x1024',
        referenceImagePaths: [referencePath],
      });

      expect(result.mimeType).toBe('image/png');
      expect(sentBody).toMatchObject({
        model,
        prompt: 'edit this image',
        size: supportsSequential ? '2k' : '1024x1024',
        response_format: 'b64_json',
        output_format: 'jpeg',
        watermark: false,
      });
      // Ark rejects this field for Pro/Flash even when its value is disabled.
      if (supportsSequential) expect(sentBody.sequential_image_generation).toBe('disabled');
      else expect(sentBody).not.toHaveProperty('sequential_image_generation');
      expect(sentBody.image).toMatch(/^data:image\/png;base64,/);
      expect(sentBody.n).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a newly-published CDN 404 without replaying the Doubao generation POST', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    let generationCount = 0;
    let downloadCount = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        generationCount += 1;
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/eventual.png' }] }), { status: 200 });
      }
      if (url === 'https://cdn.test/eventual.png') {
        downloadCount += 1;
        return downloadCount === 1
          ? new Response('object not propagated yet', { status: 404 })
          : new Response(png, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.useFakeTimers();
    try {
      const m = await import('../../../src/main/features/image_gen');
      const pending = m.callDoubaoImage({
        apiKey: 'doubao-key',
        model: 'doubao-seedream-5-0-lite-260128',
        prompt: 'a calm lake',
        size: '1024x1024',
      });
      await vi.advanceTimersByTimeAsync(600);

      await expect(pending).resolves.toMatchObject({ buffer: png, sourceUrl: 'https://cdn.test/eventual.png' });
      expect(generationCount).toBe(1);
      expect(downloadCount).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('image_gen › callOrkasImage', () => {
  it('uses the public image contract without exposing a provider model id', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      return new Response(JSON.stringify({
        id: 'img_public_test',
        status: 'succeeded',
        data: [{ b64_json: b64 }],
      }), { status: 202 });
    });
    try {
      const m = await import('../../../src/main/features/image_gen');
      const res = await m.callOrkasImage({
        apiKey: 'orkas-user-key',
        model: 'orkas-image',
        prompt: 'a blue circle',
        size: '1024x1024',
        usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
      });

      expect(captured.url).toBe('https://orkas.ai/v1/images/generations');
      expect(captured.init?.method).toBe('POST');
      expect(captured.init?.headers).toMatchObject({
        Authorization: 'Bearer orkas-user-key',
        'Content-Type': 'application/json',
        'X-Orkas-Conversation-Id': 'conv_123',
        'X-Orkas-Turn-Id': 'turn-456',
      });
      const body = JSON.parse(String(captured.init?.body));
      expect(body).toEqual({
        prompt: 'a blue circle',
        size: '2k',
        response_format: 'url',
        async: true,
      });
      expect(body).not.toHaveProperty('model');
      expect(res).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── callOpenAIImage (mock fetch) ─────────────────────────────────────────

describe('image generation transfer and artifact boundaries', () => {
  const names = ['callOpenAIImage', 'callGeminiImage', 'callDoubaoImage', 'callOrkasImage'] as const;
  it.each(names)('%s cancels a response body after headers have arrived', async (name) => {
    const m = await import('../../../src/main/features/image_gen');
    const controller = new AbortController();
    let release!: (value: string) => void;
    let reading!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { reading = resolve; });
    const fetchStub = vi.fn(async (_url, init) => {
      const body = new Promise<string>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      return { ok: true, status: 200, text: () => { reading(); return body; }, json: () => { reading(); return body.then(JSON.parse); } };
    });
    vi.stubGlobal('fetch', fetchStub);
    const result = m[name]({ apiKey: 'fixture-key', model: name === 'callGeminiImage' ? 'gemini-nano-banana-2.1' : name === 'callDoubaoImage' ? 'doubao-seedream-5-0-flash-260915' : 'fixture', prompt: 'a circle', size: '1024x1024', signal: controller.signal })
      .then(() => 'success', (error) => error.message);
    try {
      await bodyStarted;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      release('{}');
      expect(await result).toMatch(/aborted/i);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { release?.('{}'); vi.unstubAllGlobals(); }
  });

  it.each(names)('%s rejects invalid decoded bytes despite an HTTP success', async (name) => {
    const m = await import('../../../src/main/features/image_gen');
    const invalid = Buffer.from('<html>upstream error</html>').toString('base64');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(name === 'callGeminiImage'
      ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: invalid } }] } }] }
      : { data: [{ b64_json: invalid }] }), { status: 200 }));
    try {
      await expect(m[name]({ apiKey: 'fixture-key', model: name === 'callGeminiImage' ? 'gemini-nano-banana-2.1' : name === 'callDoubaoImage' ? 'doubao-seedream-5-0-flash-260915' : 'fixture', prompt: 'a circle', size: '1024x1024' }))
        .rejects.toThrow(/invalid|unsupported|malformed/i);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not replay an uncertain public API generation through another provider', async () => {
    writeProfilesFile({}, [], [
      { id: 'public', provider: 'orkas-api', model: 'orkas-image', apiKey: 'fixture-key', label: 'public', createdAt: 1 },
      { id: 'fallback', provider: 'openai', model: 'gpt-image-2', apiKey: 'fixture-key', label: 'fallback', createdAt: 2 },
    ]);
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      throw new Error('fixture response interrupted after dispatch');
    });
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'uncertain.png');
    expect(await m.generateImage({ prompt: 'one image', outputAbsPath: output })).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR' });
    expect(requests).toEqual(['https://orkas.ai/v1/images/generations']);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('does not submit or write an already cancelled image generation', async () => {
    writeProfilesFile({ 'openai:default': apiKeyProfile('openai', 'fixture-key') }, [entry('openai', 'gpt-6-astra', 'openai:default', 'e1')]);
    const m = await import('../../../src/main/features/image_gen');
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const controller = new AbortController(); controller.abort();
    try {
      await expect(m.generateImage({ prompt: 'a circle', outputAbsPath: path.join(tmpDir, 'cancelled.png'), signal: controller.signal }))
        .resolves.toMatchObject({ ok: false, errorCode: 'BAD_INPUT', dispatched: false, message: expect.stringMatching(/aborted/i) });
      expect(fetchStub).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tmpDir, 'cancelled.png'))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('direct image delivery ownership', () => {
  it('does not switch providers when a direct image generation succeeds but its URL cannot be downloaded', async () => {
    writeProfilesFile({}, [], [
      {
        id: 'image-doubao',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-lite-260128',
        apiKey: 'doubao-key',
        label: 'primary',
        createdAt: 1,
      },
      {
        id: 'image-openai',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'sk-openai',
        label: 'fallback',
        createdAt: 2,
      },
    ]);
    let generationCount = 0;
    let downloadCount = 0;
    let fallbackCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        generationCount += 1;
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/direct.png' }] }), { status: 200 });
      }
      if (url === 'https://cdn.test/direct.png') {
        downloadCount += 1;
        throw new Error('temporary CDN connection reset');
      }
      if (url.includes('api.openai.com')) {
        fallbackCount += 1;
        throw new Error('replacement provider must not be dispatched');
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.useFakeTimers();
    try {
      const m = await import('../../../src/main/features/image_gen');
      const output = path.join(tmpDir, 'generated', 'direct-delivery-failed');
      const generation = m.generateImage({ prompt: 'a calm lake', outputAbsPath: output });
      const assertion = expect(generation).rejects.toThrow(/Do not submit another generation task.*connection reset/i);
      await vi.advanceTimersByTimeAsync(2_100);
      await assertion;
      expect(generationCount).toBe(1);
      expect(downloadCount).toBe(3);
      expect(fallbackCount).toBe(0);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(`${output}.png`)).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a direct generation post-dispatch when cancellation interrupts only its download backoff', async () => {
    writeProfilesFile({}, [], [
      {
        id: 'image-doubao',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-lite-260128',
        apiKey: 'doubao-key',
        label: 'primary',
        createdAt: 1,
      },
      {
        id: 'image-openai',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'sk-openai',
        label: 'fallback',
        createdAt: 2,
      },
    ]);
    const controller = new AbortController();
    let generationCount = 0;
    let downloadCount = 0;
    let fallbackCount = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        generationCount += 1;
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/cancelled.png' }] }), { status: 200 });
      }
      if (url === 'https://cdn.test/cancelled.png') {
        downloadCount += 1;
        throw new Error('temporary transfer failure');
      }
      if (url.includes('api.openai.com')) {
        fallbackCount += 1;
        throw new Error('replacement provider must not be dispatched');
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    vi.useFakeTimers();
    try {
      const m = await import('../../../src/main/features/image_gen');
      const output = path.join(tmpDir, 'generated', 'cancelled-delivery');
      const generation = m.generateImage({
        prompt: 'a calm lake',
        outputAbsPath: output,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(downloadCount).toBe(1);
      controller.abort(new Error('user cancelled'));

      await expect(generation).rejects.toThrow(/Do not submit another generation task.*aborted/i);
      expect(generationCount).toBe(1);
      expect(downloadCount).toBe(1);
      expect(fallbackCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.existsSync(`${output}.png`)).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

});

describe('public API task and legacy profile compatibility', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  it('keeps a saved Lite profile probe usable without adding it back to new choices', async () => {
    writeProfilesFile({}, [], [{ id: 'legacy', provider: 'doubao', model: 'doubao-seedream-5-0-lite-260128', apiKey: 'fixture-key', label: 'Saved', createdAt: 1 }]);
    const auth = await import('../../../src/main/features/image_auth');
    const before = auth.listImageProfiles();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'doubao-seedream-5-0-lite-260128', size: '2k', sequential_image_generation: 'disabled' });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    vi.stubGlobal('fetch', fetch);
    expect(await auth.testImageProfile('legacy')).toMatchObject({ ok: true, provider: 'doubao', model: 'doubao-seedream-5-0-lite-260128' });
    expect(auth.listImageProfiles()).toEqual(before);
    expect(auth.listImageModelOptions('doubao').map(item => item.id)).not.toContain('doubao-seedream-5-0-lite-260128');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps unsupported model-size failures typed before any reference or provider request', async () => {
    const m = await import('../../../src/main/features/image_gen');
    const { UnsupportedImageSizeError } = await import('../../../src/main/features/image_size');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const request of [
      m.callDoubaoImage({ apiKey: 'fixture-key', model: 'doubao-seedream-5-0-flash-260915', prompt: 'a circle', size: '4k', referenceImageUrls: ['https://reference.test/image.png'] }),
      m.callGeminiImage({ apiKey: 'fixture-key', model: 'gemini-nano-banana-2.1', prompt: 'a circle', size: '1920x1080', referenceImageUrls: ['https://reference.test/image.png'] }),
    ]) await expect(request).rejects.toBeInstanceOf(UnsupportedImageSizeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('polls the public API task to completion and downloads its result without another generation', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let polls = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method || 'GET' });
      if (url === 'https://orkas.ai/v1/images/generations') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ async: true, reference_images: [expect.stringMatching(/^data:image\/png;base64,/)] });
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('model');
        return new Response(JSON.stringify({ id: 'public /task', status: 'queued' }), { status: 202 });
      }
      if (url === 'https://orkas.ai/v1/images/generations/public%20%2Ftask') {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
        return new Response(JSON.stringify(++polls === 1 ? { status: 'running' } : { status: 'succeeded', data: [{ url: 'https://cdn.test/public.png' }] }));
      }
      expect(url).toBe('https://cdn.test/public.png');
      return new Response(png);
    });
    const m = await import('../../../src/main/features/image_gen');
    vi.useFakeTimers();
    try {
      const pending = m.callOrkasImage({ apiKey: 'fixture-key', model: 'orkas-image', prompt: 'a circle', size: '2k', referenceImages: [png] }).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(6_001);
      expect(await pending).toMatchObject({ value: { buffer: png, sourceUrl: 'https://cdn.test/public.png', width: 1, height: 1 } });
      expect(calls).toEqual([
        { url: 'https://orkas.ai/v1/images/generations', method: 'POST' },
        { url: 'https://orkas.ai/v1/images/generations/public%20%2Ftask', method: 'GET' },
        { url: 'https://orkas.ai/v1/images/generations/public%20%2Ftask', method: 'GET' },
        { url: 'https://cdn.test/public.png', method: 'GET' },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('cancels a public task poll wait without submitting another job', async () => {
    const calls = vi.fn(async () => new Response(JSON.stringify({ id: 'queued-task', status: 'queued' }), { status: 202 }));
    vi.stubGlobal('fetch', calls);
    const m = await import('../../../src/main/features/image_gen');
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const pending = m.callOrkasImage({ apiKey: 'fixture-key', model: 'orkas-image', prompt: 'a circle', size: '2k', signal: controller.signal }).then(() => 'success', error => error.message);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect(await pending).toMatch(/aborted/i);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('retains a public terminal failure without billing another configured provider', async () => {
    writeProfilesFile({}, [], [
      { id: 'public', provider: 'orkas-api', model: 'orkas-image', apiKey: 'fixture-key', label: 'public', createdAt: 1 },
      { id: 'fallback', provider: 'openai', model: 'gpt-image-2', apiKey: 'fixture-key', label: 'fallback', createdAt: 2 },
    ]);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(calls.length === 1 ? { id: 'failed-task', status: 'queued' } : { status: 'failed', error: { message: 'fixture task failed' } }));
    });
    const m = await import('../../../src/main/features/image_gen');
    const output = path.join(tmpDir, 'failed-task.png');
    vi.useFakeTimers();
    try {
      const pending = m.generateImage({ prompt: 'one image', outputAbsPath: output });
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await pending).toMatchObject({ ok: false, errorCode: 'PROVIDER_API_ERROR', message: expect.stringContaining('failed') });
      expect(calls).toEqual(['https://orkas.ai/v1/images/generations', 'https://orkas.ai/v1/images/generations/failed-task']);
      expect(fs.existsSync(output)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('mixed references across public adapters', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  it.each(['openai', 'gemini', 'doubao', 'orkas-api'] as const)(
    'preserves mixed reference roles in the actual %s generation request', async (provider) => {
      const { compileImagePromptContract, normalizeImageReferenceBindings } = await import('../../../src/main/features/image_prompt_contract');
      const bindings = normalizeImageReferenceBindings([
        { index: 0, role: 'identity', preserve: ['face'] },
        { index: 1, role: 'composition', preserve: ['layout'] },
        { index: 2, role: 'style', preserve: ['palette'] },
        { index: 3, role: 'content', preserve: ['objects'] },
      ], 4);
      const prompt = compileImagePromptContract('Combine the four references.', bindings, []);
      const png = Buffer.from(PNG_B64, 'base64');
      // Distinct PNG payloads let the request oracle detect swapped identities.
      const bytes = ['identity', 'composition', 'style', 'content'].map(label => Buffer.concat([png, Buffer.from(label)]));
      const paths = [path.join(tmpDir, 'identity.png'), path.join(tmpDir, 'composition.png')];
      paths.forEach((file, i) => fs.writeFileSync(file, bytes[i]));
      const urls = ['https://cdn.example/style.png', 'https://cdn.example/content.png'];
      const requests: RequestInit[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const reference = urls.indexOf(String(url));
        if (reference >= 0) return new Response(bytes[reference + 2]);
        if (init?.method !== 'POST') throw new Error('unexpected request');
        requests.push(init);
        if (provider === 'gemini') return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG_B64 } }] } }],
        }));
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const m = await import('../../../src/main/features/image_gen');
      const adapter = provider === 'openai' ? m.callOpenAIImage : provider === 'gemini' ? m.callGeminiImage
        : provider === 'doubao' ? m.callDoubaoImage : m.callOrkasImage;
      const result = await adapter({ apiKey: 'fixture-key', model: provider === 'gemini' ? 'gemini-nano-banana-2.1' : 'fixture-model', prompt, size: '1024x1024',
        referenceImagePaths: paths, referenceImageUrls: urls });

      expect(result.buffer).toEqual(png);
      expect(fetchMock).toHaveBeenCalledTimes(3); // Two reference downloads, one generation.
      expect(requests).toHaveLength(1);
      let sentBytes: Buffer[];
      if (provider === 'openai') {
        const body = requests[0].body as FormData;
        expect(body.get('prompt')).toBe(prompt);
        sentBytes = await Promise.all(body.getAll('image[]').map(async item => Buffer.from(await (item as Blob).arrayBuffer())));
      } else {
        const body = JSON.parse(requests[0].body as string);
        expect(provider === 'gemini' ? body.contents[0].parts[0].text : body.prompt).toBe(prompt);
        const payloads: string[] = provider === 'gemini'
          ? body.contents[0].parts.slice(1).map((part: { inline_data: { data: string } }) => part.inline_data.data)
          : (provider === 'doubao' ? body.image : body.reference_images).map((uri: string) => uri.split(',')[1]);
        sentBytes = payloads.map(data => Buffer.from(data, 'base64'));
      }
      expect(sentBytes).toEqual(bytes);

    },
  );

});
