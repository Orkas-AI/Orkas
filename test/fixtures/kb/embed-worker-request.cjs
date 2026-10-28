// Exercise the worker protocol with fixture-only dependencies. An isolated
// process also releases Electron's native ASAR cache before fixture cleanup.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

function createWorkerSession(sourceFile, workerDir, modelDir) {
  let receive;
  const replies = new Map();
  vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
    __dirname: workerDir,
    require: createRequire(path.join(workerDir, 'kb-embed-worker.cjs')),
    process: {
      env: { ORKAS_EMBED_MODEL_DIR: modelDir },
      parentPort: {
        on: (_name, callback) => { receive = callback; },
        postMessage: message => replies.get(message.id)?.(message),
      },
      exit: () => { throw new Error('Worker exited before handling a request'); },
    },
  });
  assert.equal(typeof receive, 'function');
  return {
    async request(message) {
      let reply;
      const response = new Promise(resolve => { reply = resolve; });
      const timer = setTimeout(() => reply({ timedOut: true }), 2000);
      replies.set(message.id, reply);
      try {
        receive({ data: message });
        return await response;
      } finally {
        clearTimeout(timer);
        replies.delete(message.id);
      }
    },
  };
}

async function requestWorker(sourceFile, workerDir, modelDir) {
  return createWorkerSession(sourceFile, workerDir, modelDir).request({
    id: 17, type: 'embed', texts: ['first document', 'second document'],
  });
}

module.exports = { requestWorker, createWorkerSession };

if (require.main === module) {
  requestWorker(...process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result));
  }, error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
