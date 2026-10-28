import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPublicKey, X509Certificate } from 'node:crypto';

/** Check the complete BER/DER envelope, independently of native crypto's
 * semantic validation (which may accept a prefix). Reads stay bounded by the
 * existing 64 KiB file limit; indefinite constructed values have a depth cap. */
function publicObjectEnd(bytes: Buffer, offset = 0, depth = 0): number {
  if (depth > 64 || offset + 2 > bytes.length) return -1;
  const tag = bytes[offset++];
  if ((tag & 0x1f) === 0x1f) {
    do { if (offset >= bytes.length) return -1; } while (bytes[offset++] & 0x80);
  }
  if (offset >= bytes.length) return -1;
  const first = bytes[offset++];
  if (first === 0x80) {
    if (!(tag & 0x20)) return -1;
    while (offset + 2 <= bytes.length) {
      if (bytes[offset] === 0 && bytes[offset + 1] === 0) return offset + 2;
      const end = publicObjectEnd(bytes, offset, depth + 1);
      if (end <= offset) return -1;
      offset = end;
    }
    return -1;
  }
  let size = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (offset + count > bytes.length) return -1;
    size = 0;
    for (let i = 0; i < count; i++) {
      size = size * 256 + bytes[offset++];
      if (size > bytes.length) return -1;
    }
  }
  return offset + size <= bytes.length ? offset + size : -1;
}

/** Content proof for the shipped credential-path policy, never a general path
 * grant. Bounded reads, no cache (a template may acquire secrets after a write).
 * Comments and trailing data are deliberately not accepted as public proof. */
export function isVerifiedPublicMaterial(file: string): boolean {
  const template = /^\.env\.(?:example|sample|template)$/i.test(path.basename(file));
  if (!/\.(?:pub|pem)$/i.test(file) && !template) return false;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > 64 * 1024) return false;
    if (st.size === 0) return template;
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) return false;
      const bytes = Buffer.alloc(64 * 1024 + 1);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (size !== st.size) return false;
      text = bytes.subarray(0, size).toString('utf8').trim();
    } finally { fs.closeSync(fd); }
    if (template) {
      return text.split(/\r?\n/).every(line => !line.trim()
        || /^(?:export )?[A-Za-z_][A-Za-z0-9_]*=(?:|""|''|\$\{[A-Za-z_][A-Za-z0-9_]*\}|"\$\{[A-Za-z_][A-Za-z0-9_]*\}")$/.test(line.trim()));
    }
    const pem = /^-----BEGIN (CERTIFICATE|PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/.exec(text);
    if (pem) {
      const bytes = Buffer.from(text.split(/\r?\n/).slice(1, -1).join(''), 'base64');
      if (bytes[0] !== 0x30 || publicObjectEnd(bytes) !== bytes.length) return false;
      if (pem[1] === 'CERTIFICATE') new X509Certificate(text);
      else createPublicKey(text);
      return true;
    }
    // OpenSSH's binary wire format: accept only complete ed25519 / RSA public
    // keys, with no options, comments, private data or additional records.
    const ssh = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})$/.exec(text);
    if (!ssh) return false;
    const bytes = Buffer.from(ssh[2], 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== ssh[2].replace(/=+$/, '')) return false;
    let offset = 0;
    const field = () => {
      if (offset + 4 > bytes.length) throw new Error('Invalid public key');
      const size = bytes.readUInt32BE(offset); offset += 4;
      if (!size || offset + size > bytes.length) throw new Error('Invalid public key');
      const value = bytes.subarray(offset, offset + size); offset += size; return value;
    };
    if (field().toString() !== ssh[1]) return false;
    if (ssh[1] === 'ssh-ed25519') { if (field().length !== 32) return false; }
    else { if (field().length > 8 || field().length < 128) return false; }
    return offset === bytes.length;
  } catch { return false; }
}
