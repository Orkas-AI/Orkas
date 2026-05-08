/**
 * Hermes backend — speaks ACP via `hermes acp`. The minimal handshake
 * + session/update parsing lives in `_acp.ts`; this file just supplies
 * the CLI invocation + the env nudges Hermes needs in headless use
 * (HERMES_YOLO_MODE=1 suppresses interactive permission prompts).
 */

import { makeAcpBackend } from './_acp.js';

export const hermesBackend = makeAcpBackend({
  logName: 'local-agents:hermes',
  argv: ['acp'],
  clientName: 'orkas',
  extraEnv: {
    // Without this Hermes drops to interactive permission prompts on
    // any tool call and the run just hangs waiting on stdin we never
    // send. We can flip back to user-confirmation later when we wire
    // permission prompts through the chat UI.
    HERMES_YOLO_MODE: '1',
  },
});
