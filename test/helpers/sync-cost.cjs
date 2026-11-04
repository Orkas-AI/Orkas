'use strict';
// Test-only caller attribution. API duration includes OS cache/decoding; it is
// not a physical-disk counter. Nested append->write calls must not be summed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');

function profileSyncCosts(inScope) {
  const report = { fs: {}, syncFsMs: 0, hashMs: 0, hashCalls: 0, hashBytes: 0 };
  const restore = [];
  let depth = 0, active = true;
  for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync',
    'copyFileSync', 'renameSync', 'rmSync', 'mkdirSync', 'existsSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (!active || depth || !inScope(args[0])) return Reflect.apply(original, this, args);
      const stat = report.fs[name] ||= { calls: 0, ms: 0, bytes: 0, failures: 0 };
      const start = performance.now();
      let result, failed = false;
      depth++;
      try { result = Reflect.apply(original, this, args); return result; }
      catch (error) { failed = true; throw error; }
      finally {
        const elapsed = performance.now() - start; depth--;
        stat.calls++; stat.ms += elapsed; report.syncFsMs += elapsed;
        if (failed) stat.failures++;
        const value = name === 'readFileSync' ? result
          : name === 'writeFileSync' || name === 'appendFileSync' ? args[1] : null;
        if (!failed && (typeof value === 'string' || Buffer.isBuffer(value))) stat.bytes += Buffer.byteLength(value);
      }
    };
    restore.push(() => { fs[name] = original; });
  }
  const createHash = crypto.createHash;
  crypto.createHash = function (...args) {
    const hash = Reflect.apply(createHash, this, args);
    if (!active || args[0] !== 'sha256') return hash;
    report.hashCalls++;
    for (const name of ['update', 'digest']) {
      const original = hash[name];
      hash[name] = function (...values) {
        if (!active) return Reflect.apply(original, this, values);
        const start = performance.now();
        try { return Reflect.apply(original, this, values); }
        finally {
          report.hashMs += performance.now() - start;
          if (name === 'update') {
            const value = values[0];
            if (typeof value === 'string') report.hashBytes += Buffer.byteLength(value, values[1]);
            else if (ArrayBuffer.isView(value)) report.hashBytes += value.byteLength;
          }
        }
      };
    }
    return hash;
  };
  restore.push(() => { crypto.createHash = createHash; });
  syncBuiltinESMExports();
  return { report, stop() {
    if (!active) return report;
    active = false;
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
    return report;
  } };
}
module.exports = { profileSyncCosts };
