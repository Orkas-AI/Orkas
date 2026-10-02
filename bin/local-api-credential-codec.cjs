'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'ORKAPI1:';

function parseKey(value) {
  const key = Buffer.from(String(value || ''), 'base64url');
  if (key.length !== 32) throw new Error('invalid local API credential key');
  return key;
}

function encryptPayload(keyValue, payload) {
  const key = Buffer.isBuffer(keyValue) ? keyValue : parseKey(keyValue);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.from(JSON.stringify({
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
  })).toString('base64url');
}

function decryptPayload(keyValue, value) {
  const key = Buffer.isBuffer(keyValue) ? keyValue : parseKey(keyValue);
  const text = String(value || '');
  if (!text.startsWith(PREFIX)) throw new Error('unsupported local API credential payload');
  const envelope = JSON.parse(Buffer.from(text.slice(PREFIX.length), 'base64url').toString('utf8'));
  const iv = Buffer.from(envelope.iv, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  const data = Buffer.from(envelope.data, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || data.length > 256 * 1024) {
    throw new Error('invalid local API credential payload');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

function readCredentialFile(file, keyValue) {
  return decryptPayload(keyValue, fs.readFileSync(file, 'utf8'));
}

function writeCredentialFile(file, keyValue, payload) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, `${encryptPayload(keyValue, payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    throw Object.assign(new Error('Local credentials could not be saved; check available storage'), { code: 'E_TOOL_CALL_UPSTREAM' });
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* Preserve the storage outcome without exposing paths. */ }
  }
}

const fingerprint = payload => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

function hasCredentialRotation(config) {
  if (!config.credentialFile) return false;
  const file = `${config.credentialFile}.rotation`;
  return fs.existsSync(file) && readCredentialFile(file, config.credentialKey).base === fingerprint(config.credentials);
}

// Keep an unverified rotated grant encrypted and separate from the active grant.
// A failed identity request or final write can resume with the candidate after restart;
// a replacement authorization invalidates the checkpoint through its base fingerprint.
async function rotateCredentialFile(config, acquire, verify) {
  const file = `${config.credentialFile}.rotation`;
  const base = fingerprint(config.credentials);
  let checkpoint;
  if (fs.existsSync(file)) {
    checkpoint = readCredentialFile(file, config.credentialKey);
    if (checkpoint.base !== base) {
      fs.rmSync(file, { force: true });
      checkpoint = undefined;
    }
  }
  if (!checkpoint || checkpoint.credentials.expires_at <= Date.now() + 60_000) {
    // An application may reopen after the candidate access token has expired.
    // Renew with its rotated refresh token, keeping the original binding and base.
    if (checkpoint) config.credentials = checkpoint.credentials;
    checkpoint = { base, credentials: await acquire() };
    writeCredentialFile(file, config.credentialKey, checkpoint);
  }
  const candidate = { ...config, credentials: checkpoint.credentials };
  await verify(candidate);
  // Never overwrite a newer authorization while the identity request was in flight.
  if (fingerprint(readCredentialFile(config.credentialFile, config.credentialKey)) !== base) {
    throw Object.assign(new Error('Authorization changed during refresh; reconnect'), { code: 'E_TOOL_CALL_AUTH' });
  }
  writeCredentialFile(config.credentialFile, config.credentialKey, candidate.credentials);
  fs.rmSync(file, { force: true });
  config.credentials = candidate.credentials;
  return candidate.credentials.access_token;
}

function invalidateCredentialFile(config) {
  if (!config.credentialFile || fs.existsSync(`${config.credentialFile}.rotation`)) return;
  const current = readCredentialFile(config.credentialFile, config.credentialKey);
  if (current.access_token && current.access_token === config.credentials.access_token && current.expires_at) {
    writeCredentialFile(config.credentialFile, config.credentialKey, { ...current, expires_at: 0 });
  }
}

module.exports = { PREFIX, parseKey, encryptPayload, decryptPayload, readCredentialFile, writeCredentialFile,
  rotateCredentialFile, invalidateCredentialFile, hasCredentialRotation };
