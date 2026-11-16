'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function spec() {
  const record = bytes => ({ bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const targets = {};
  for (const key of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64']) {
    const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
    bytes.writeUInt16LE(key.endsWith('arm64') ? 0xaa64 : 0x8664, 132);
    targets[key] = { files: { [`bin/${key.startsWith('win32') ? 'dcraw_emu.exe' : 'dcraw_emu'}`]: { ...record(bytes), executable: true, testBytes: bytes } } };
  }
  return { schema: 1, version: 'fixture', source: { name: 'source.tar.gz', ...record(Buffer.from('source')), testBytes: Buffer.from('source') },
    licenses: { LICENSE: { ...record(Buffer.from('license')), testBytes: Buffer.from('license') } }, targets };
}
function write(root, key) {
  const contract = spec(), dir = path.join(root, 'libraw', key), files = { ...contract.targets[key].files, ...contract.licenses, [contract.source.name]: contract.source };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value.testBytes, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'fixture');
  fs.writeFileSync(path.join(dir, '.orkas-libraw-ready.json'), JSON.stringify({ schema: 1, platformKey: key, version: contract.version,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { bytes: value.bytes, sha256: value.sha256 }])) }));
  return contract;
}
module.exports = { spec, write };
