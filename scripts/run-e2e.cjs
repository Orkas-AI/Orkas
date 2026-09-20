#!/usr/bin/env node

// Desktop visibility belongs to this invocation, not an inherited shell or
// agent environment. Normalize before Playwright loads and forks its workers.
const args = process.argv.slice(2);
const endOfOptions = args.indexOf('--');
const debug = (endOfOptions < 0 ? args : args.slice(0, endOfOptions)).includes('--debug');
process.env.ORKAS_E2E_SHOW_WINDOW = debug ? '1' : '0';
process.env.ORKAS_E2E_HIDE_WINDOW = debug ? '0' : '1';
if (debug) process.env.PWDEBUG = '1';
else delete process.env.PWDEBUG;

// Playwright forces color in workers and strips it in the parent reporter.
// Translate NO_COLOR before loading Playwright so worker environments never
// contain conflicting controls, while the reporter retains plain output.
if (process.env.NO_COLOR !== undefined) {
  process.env.ORKAS_E2E_NO_COLOR = '1';
  process.env.FORCE_COLOR = '0';
  process.env.DEBUG_COLORS = '0';
  delete process.env.NO_COLOR;
}

require('playwright/lib/program').program.parse(process.argv);
