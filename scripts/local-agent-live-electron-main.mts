import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This project is CommonJS. Keep the Electron entry in ESM and consume the
// TypeScript runner through the registered CommonJS loader, like the app does.
const require = createRequire(import.meta.url);
export function localAgentLiveArguments(argv: string[]): string[] {
  // Electron retains the entry after --disable-gpu in argv; Node does not.
  // Remove only this launcher's exact entry, preserving every user option.
  const host = fileURLToPath(new URL('./local-agent-live-electron-entry.mjs', import.meta.url));
  return argv[0] === host ? argv.slice(1) : argv;
}
export async function main(argv: string[]): Promise<number> {
  return require('./test-local-agents-live.ts').main(localAgentLiveArguments(argv));
}
