import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('user-owned Google Cloud video credentials', () => {
  it('signs a bounded Google OAuth assertion and renews an expired token without logging credentials', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const json = JSON.stringify({ type: 'service_account', project_id: 'video-project', client_email: 'video@video-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims, signature] = params.get('assertion')!.split('.');
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
      const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
      expect(body).toMatchObject({ iss: 'video@video-project.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform' });
      expect(body.exp - body.iat).toBe(3600);
      return Response.json({ access_token: `token-${fetch.mock.calls.length}`, expires_in: 3600, token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const { createVideoCloudCredentials } = await import('../../../src/main/features/video_cloud_auth');
      const credentials = createVideoCloudCredentials(json);
      expect(credentials.projectId).toBe('video-project');
      expect(await credentials.token()).toBe('token-1');
      expect(await credentials.token()).toBe('token-1');
      now += 3600_000;
      expect(await credentials.token()).toBe('token-2');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it.each(['{}', '{bad-json', JSON.stringify({ type: 'external_account', credential_source: { url: 'http://private.test' } })])('rejects invalid credential formats before contacting any URL', async value => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { createVideoCloudCredentials } = await import('../../../src/main/features/video_cloud_auth');
    expect(() => createVideoCloudCredentials(value)).toThrow('Google Cloud');
    expect(fetch).not.toHaveBeenCalled();
  });
});
