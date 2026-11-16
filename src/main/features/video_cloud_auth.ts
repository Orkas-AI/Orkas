/** Service-account credentials supplied by the user, stored in the existing local secret store. */
import { createPrivateKey, sign } from 'node:crypto';
import { fetchAndReadWithTimeout } from '../util/abort';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function createVideoCloudCredentials(json: string, signal?: AbortSignal): { projectId: string; token: () => Promise<string> } {
  let account: any;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    if (json.length > 32_768) throw new Error();
    account = JSON.parse(json);
    if (account.type !== 'service_account' || !/^[a-zA-Z0-9-]{1,100}$/.test(account.project_id || '')
      || !/^[^\s@]{1,200}@[^\s@]{1,200}\.gserviceaccount\.com$/.test(account.client_email || '')
      || typeof account.private_key !== 'string'
      || (account.token_uri && account.token_uri !== TOKEN_URL)) throw new Error();
    key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
  } catch {
    throw new Error('Google Cloud requires a valid service-account JSON key with project_id, client_email and an RSA private_key.');
  }
  let access = '';
  let expiresAt = 0;
  return {
    projectId: account.project_id,
    async token() {
      if (access && Date.now() < expiresAt - 60_000) return access;
      const issued = Math.floor(Date.now() / 1000);
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
        iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: TOKEN_URL, iat: issued, exp: issued + 3600,
      })}`;
      const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
      const { body } = await fetchAndReadWithTimeout(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      }, 60_000, signal, 'Google Cloud authorization timed out.', async response => {
        if (!response.ok) throw new Error(`Google Cloud authorization failed (${response.status}). Check the service-account key and permissions.`);
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)
          || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Google Cloud returned an invalid authorization response.');
        return data;
      });
      access = body.access_token;
      expiresAt = Date.now() + Math.min(body.expires_in, 3600) * 1000;
      return access;
    },
  };
}
