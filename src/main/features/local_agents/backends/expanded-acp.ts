import { makeAcpBackend } from './_acp.js';

// Vendor commands and session support are independent of the login state.
// Each command negotiates ACP over stdio in the user's selected workspace.
export const kimiBackend = makeAcpBackend({
  logName: 'local-agents:kimi', cliName: 'Kimi Code', clientName: 'orkas',
  argv: ['acp'], resume: 'negotiated',
});
export const dshBackend = makeAcpBackend({
  logName: 'local-agents:dsh', cliName: 'DeepSeek Harness', clientName: 'orkas',
  argv: ['--profile', 'acp'], resume: 'negotiated',
});
export const traecliBackend = makeAcpBackend({
  logName: 'local-agents:traecli', cliName: 'TraeCode', clientName: 'orkas',
  argv: ['acp', 'serve'], resume: 'negotiated',
});
export const copilotBackend = makeAcpBackend({
  logName: 'local-agents:copilot', cliName: 'GitHub Copilot', clientName: 'orkas',
  argv: ['--acp', '--stdio'], resume: 'negotiated',
});
export const cursorBackend = makeAcpBackend({
  logName: 'local-agents:cursor', cliName: 'Cursor', clientName: 'orkas',
  argv: ['acp'], resume: 'negotiated',
});
export const antigravityBackend = makeAcpBackend({
  logName: 'local-agents:antigravity', cliName: 'Antigravity', clientName: 'orkas',
  argv: ['acp'], resume: 'negotiated',
});
