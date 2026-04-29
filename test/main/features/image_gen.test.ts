import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Tests cover the parts that *aren't* obvious from reading the code:
//   - pickImageGenProfile's filter/match contract (the OAuth-skip + capability
//     lookup is the whole point of the design — easy to regress)
//   - adapter request construction (URL / headers / body shape) via mock fetch
//   - PNG dimension parsing (guards the bytes->dimensions math)
// We deliberately do NOT test:
//   - happy-path generateImage end-to-end (would need real fs + provider) —
//     covered by manual smoke verification per docs/plans/image-gen.md
//   - JPEG/WebP dimension parsing — same parser pattern as PNG; one fixture
//     is enough to catch a busted readUInt32BE implementation

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

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────

function writeProfilesFile(profiles: Record<string, unknown>, entries: unknown[]): void {
  const dir = path.join(tmpDir, TEST_UID, 'local', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'auth-profiles.json'),
    JSON.stringify({ version: 3, profiles, entries }, null, 2),
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
      [entry('google', 'gemini-3-pro-preview', 'google:default', 'e1')],
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
    // The user's chat model on the openai entry (gpt-5.4) is irrelevant —
    // the capability map fixes the model to gpt-image-1.
    writeProfilesFile(
      {
        'anthropic:default': apiKeyProfile('anthropic', 'sk-ant-xxx'),
        'openai:default':    apiKeyProfile('openai',    'sk-openai-xxx'),
      },
      [
        entry('anthropic', 'claude-opus-4-7', 'anthropic:default', 'e1'),
        entry('openai',    'gpt-5.4',         'openai:default',    'e2'),
      ],
    );
    const m = await import('../../../src/main/features/image_gen');
    const picked = m.pickImageGenProfile();
    expect(picked).not.toBeNull();
    expect(picked!.entry.provider).toBe('openai');
    expect(picked!.entry.apiKey).toBe('sk-openai-xxx');
    expect(picked!.capability.model).toBe('gpt-image-1');
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
        entry('google', 'gemini-3-pro-preview', 'google:cli',    'e1'),
        entry('google', 'gemini-3-pro-preview', 'google:studio', 'e2'),
      ],
    );
    const m = await import('../../../src/main/features/image_gen');
    const picked = m.pickImageGenProfile();
    expect(picked!.entry.profileId).toBe('google:studio');
    expect(picked!.capability.model).toBe('gemini-2.5-flash-image-preview');
    expect(picked!.capability.api).toBe('gemini');
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
      const res = await m.callOpenAIImage({
        apiKey: 'sk-test',
        model: 'gpt-image-1',
        prompt: 'a red cube',
        size: '1024x1024',
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
      await m.callOpenAIImage({
        apiKey: 'sk-test',
        model: 'gpt-image-1',
        prompt: 'change the cube to blue',
        size: '1024x1024',
        referenceImages: [refBuf],
      });
      expect(captured.url).toBe('https://api.openai.com/v1/images/edits');
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
      // No explicit Content-Type — fetch sets multipart boundary itself.
      expect(headers['Content-Type']).toBeUndefined();
      // FormData round-trip is awkward to assert on directly; the URL +
      // header proof is enough to lock the routing decision.
      expect(captured.init?.body).toBeDefined();
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
      const res = await m.callGeminiImage({
        apiKey: 'AIza-test',
        model: 'gemini-2.5-flash-image-preview',
        prompt: 'a cat',
        size: '1024x1024',
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
