/**
 * OpenClaw backend.
 *
 * In OpenClaw the model is bound to a pre-registered "agent" via
 * `openclaw agents add`; the run command picks the agent by name. We
 * pass `agent.runtime.model` (which is actually the agent name in the
 * OpenClaw world — see registry.listModels for openclaw) as the
 * positional argument when present.
 *
 * v1 takes the prompt on stdin and captures stdout as plain text.
 */

import { makeTextBackend } from './_text.js';

export const openclawBackend = makeTextBackend({
  logName: 'local-agents:openclaw',
  buildArgs(opts) {
    const args = ['run', '--prompt-stdin'];
    // openclaw uses `--agent <name>`; we re-use the model field as the
    // agent name when the user supplied one. Empty = let openclaw use
    // its current default.
    if (opts.model) args.push('--agent', opts.model);
    if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
    return args;
  },
  promptOnStdin: true,
});
