/**
 * Hermes backend — speaks ACP via `hermes acp`. The minimal handshake
 * + session/update parsing lives in `_acp.ts`; this file just supplies
 * the CLI invocation + the env nudges Hermes needs in headless use
 * permission policy mapping.
 */

import { makeAcpBackend } from './_acp.js';

export const hermesBackend = makeAcpBackend({
  logName: 'local-agents:hermes',
  argv: ['acp'],
  clientName: 'orkas',
  extraEnv: opts => {
    if (opts.permissionPolicy === 'full_access') return { HERMES_YOLO_MODE: '1' };
    if (opts.permissionPolicy === 'ask') return { HERMES_YOLO_MODE: '0' };
    return {};
  },
});
