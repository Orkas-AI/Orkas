/**
 * Codex CLI backend.
 *
 * v1 keeps it simple: `codex exec` reads the prompt from stdin and
 * prints the assistant reply to stdout. We skip `app-server` mode
 * (which speaks JSON-RPC over stdio) for now — it's significantly more
 * complex and the simple text body is enough to round-trip a dispatch
 * back into the group chat. Step 7+ can swap to app-server when we
 * want tool-use visibility on the timeline.
 */

import { makeTextBackend } from './_text.js';

export const codexBackend = makeTextBackend({
  logName: 'local-agents:codex',
  // `codex exec -` reads the prompt from stdin (no model selector here
  // unless the user installed an account that requires it via login).
  // Model is appended only when the user explicitly picked one.
  buildArgs(opts) {
    const args = ['exec', '-'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
    return args;
  },
  promptOnStdin: true,
});
