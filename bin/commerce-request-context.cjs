'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const requestSignal = new AsyncLocalStorage();

function withRequestSignal(signal, operation) {
  return requestSignal.run(signal, operation);
}

// Diagnose at the IO boundary before privacy wrappers replace the exception.
// A user-supplied cancellation reason is never a diagnostic string.
function requestFailureCode(error, deadline) {
  if (requestSignal.getStore()?.aborted) return 'E_TOOL_CALL_CANCELLED';
  if (deadline?.aborted || error?.name === 'TimeoutError') return 'E_TOOL_CALL_TIMEOUT';
  if (error?.name === 'AbortError') return 'E_TOOL_CALL_CANCELLED';
  return 'E_TOOL_CALL_NETWORK';
}

function httpFailureCode(status) {
  if (status === 401 || status === 403) return 'E_TOOL_CALL_AUTH';
  if (status === 429) return 'E_TOOL_CALL_RATE_LIMIT';
  if (status === 408 || status === 504) return 'E_TOOL_CALL_TIMEOUT';
  if (status >= 400 && status < 500) return 'E_BAD_INPUT';
  return 'E_TOOL_CALL_UPSTREAM';
}

function credentialOperation(operation) {
  return async (...args) => {
    requestSignal.getStore()?.throwIfAborted();
    // A rotating grant can serve other requests and must reach durable storage
    // once started. Keep its existing provider timeout; each waiting request
    // checks its own cancellation again before issuing any business request.
    return requestSignal.run(undefined, () => operation(...args));
  };
}

// Keep cancellation scoped to one MCP request across token acquisition and the
// provider-specific helpers. Standalone authorization calls retain their timeout.
function requestFetch(url, init = {}, fetchImpl = globalThis.fetch) {
  const ownerSignal = requestSignal.getStore();
  ownerSignal?.throwIfAborted();
  const signal = ownerSignal
    ? AbortSignal.any([ownerSignal, ...(init.signal ? [init.signal] : [])])
    : init.signal;
  return fetchImpl(url, { ...init, signal });
}

module.exports = { withRequestSignal, credentialOperation, requestFetch, requestFailureCode, httpFailureCode };
