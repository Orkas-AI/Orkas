#!/usr/bin/env node
/**
 * CLI entry point for core-agent.
 *
 * Usage:
 *   npx tsx src/main.ts run "What is 2+2?"
 *   npx tsx src/main.ts chat --provider anthropic --model claude-sonnet-4-20250514
 *   npx tsx src/main.ts models --provider anthropic
 *   npx tsx src/main.ts memory status --dir ./memory
 *   npx tsx src/main.ts config
 *   npx tsx src/main.ts help
 */
import { CLI } from "./cli/index.js";

const cli = new CLI();
cli.run(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
