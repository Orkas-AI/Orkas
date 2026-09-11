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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${encryptPayload(keyValue, payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

module.exports = { PREFIX, parseKey, encryptPayload, decryptPayload, readCredentialFile, writeCredentialFile };
