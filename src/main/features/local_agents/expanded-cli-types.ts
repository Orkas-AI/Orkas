export const EXPANDED_LOCAL_CLI_TYPES = [
  'kimi', 'dsh', 'traecli', 'zcode', 'copilot', 'cursor', 'antigravity',
] as const;

export function isExpandedLocalCli(type: unknown): boolean {
  return typeof type === 'string' && (EXPANDED_LOCAL_CLI_TYPES as readonly string[]).includes(type);
}
