'use strict';

// Pause only a synthetic Worker's cache publication, after its process files
// exist. This makes clear/build races observable without changing their bytes.
const { workerData } = require('node:worker_threads');
if (workerData?.historyPublishGate) {
  const gate = new Int32Array(workerData.historyPublishGate);
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const mkdir = fsp.mkdir;
  let paused = false;
  const pause = () => {
    paused = true;
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    if (Atomics.wait(gate, 1, 0, 15_000) === 'timed-out') throw new Error('History publication test gate timed out');
  };
  fsp.mkdir = async function (file, ...args) {
    if (!workerData.historyPartialCache && !paused && /^[a-f0-9]{32}$/.test(path.basename(String(file)))
      && path.basename(path.dirname(String(file))) === 'conversation-history') {
      pause();
    }
    return mkdir.call(this, file, ...args);
  };
  if (workerData.historyPartialCache) {
    const write = fsp.writeFile;
    fsp.writeFile = async function(file, bytes, ...args) {
      if (!paused && /^latest-page-v12\.json\..+\.tmp$/.test(path.basename(String(file)))) {
        await write.call(this, file, Buffer.from(bytes).subarray(0, 7), ...args);
        pause();
      }
      return write.call(this, file, bytes, ...args);
    };
  }
}
