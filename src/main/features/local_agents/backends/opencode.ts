/**
 * OpenCode CLI backend.
 *
 * `opencode run --print` runs non-interactively and prints the model
 * reply to stdout. The prompt is read from stdin. Model is selected
 * via `--model provider/name` when supplied (matches the format the
 * `opencode models` subcommand prints — same shape we'd surface in
 * future dynamic-discovery support).
 */

import { makeTextBackend } from './_text.js';

export const opencodeBackend = makeTextBackend({
  logName: 'local-agents:opencode',
  buildArgs(opts) {
    const args = ['run', '--print'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.customArgs && opts.customArgs.length) args.push(...opts.customArgs);
    return args;
  },
  promptOnStdin: true,
});
