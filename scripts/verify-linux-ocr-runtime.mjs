#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.platform !== 'linux') {
  console.log(`[linux-ocr-probe] skipped on ${process.platform}-${process.arch}`);
  process.exit(0);
}

const ownsWorkspace = !process.env.ORKAS_WORKSPACE_ROOT;
const workspace = process.env.ORKAS_WORKSPACE_ROOT
  || fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-linux-ocr-'));
process.env.ORKAS_WORKSPACE_ROOT = workspace;

try {
  const { _ensureOcrRuntimeForTest } = await import('../src/main/features/ocr_runtime.ts');
  const result = await _ensureOcrRuntimeForTest((event) => {
    if (!event.data?.heartbeat) console.log(`[linux-ocr-probe] ${event.phase}: ${event.message}`);
  });
  if (!result.ok) throw new Error(`${result.errorCode}: ${result.message}`);
  console.log(`[linux-ocr-probe] RapidOCR runtime verified (${result.installed ? 'installed' : 'reused'})`);
} catch (err) {
  console.error(`[linux-ocr-probe] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (ownsWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
}
