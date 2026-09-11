'use strict';

const { createHash, createPrivateKey, sign, constants } = require('node:crypto');

// eBay Key Management returns a base64 PKCS#8 private key and its public-key
// JWE. Both travel only through the existing encrypted local credential store.
function signingKey(credentials) {
  const privateKey = credentials.signing_private_key;
  const jwe = credentials.signing_key_jwe;
  if (!privateKey && !jwe) return null;
  try {
    if (typeof privateKey !== 'string' || privateKey.length > 4096
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKey)
        || typeof jwe !== 'string' || jwe.length > 4096
        || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}$/.test(jwe)) throw new Error();
    const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519'
        && !(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048)) throw new Error();
    return { key, jwe };
  } catch {
    // Crypto parser diagnostics must never expose supplied key material.
    throw new Error('invalid eBay signing credentials: provide both the base64 PKCS#8 private key and matching JWE');
  }
}

function refundSignatureHeaders(credentials, url, method, body) {
  const signing = signingKey(credentials);
  if (!signing) return {};
  const headers = { 'x-ebay-signature-key': signing.jwe };
  const components = [];
  if (body !== undefined) {
    headers['content-digest'] = `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`;
    components.push(['content-digest', headers['content-digest']]);
  }
  const target = new URL(url);
  components.push(['x-ebay-signature-key', signing.jwe], ['@method', method], ['@path', target.pathname], ['@authority', target.host]);
  const parameters = `(${components.map(([name]) => `"${name}"`).join(' ')});created=${Math.floor(Date.now() / 1000)}`;
  const base = components.map(([name, value]) => `"${name}": ${value}`)
    .concat(`"@signature-params": ${parameters}`).join('\n');
  const signature = sign(signing.key.asymmetricKeyType === 'ed25519' ? null : 'sha256', Buffer.from(base), {
    key: signing.key, ...(signing.key.asymmetricKeyType === 'rsa' ? { padding: constants.RSA_PKCS1_PADDING } : {}),
  });
  headers['signature-input'] = `sig1=${parameters}`;
  headers.signature = `sig1=:${signature.toString('base64')}:`;
  return headers;
}

module.exports = { signingKey, refundSignatureHeaders };
