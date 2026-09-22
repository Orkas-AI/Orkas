import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openclawBackend } from '../../../../src/main/features/local_agents/backends/openclaw';
import { prepareOpenclawBridge } from '../../../../src/main/features/local_agents/backends/openclaw-bridge';

vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
let root: string;
let source: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-openclaw-bridge-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  source = path.join(root, 'openclaw.json');
  fs.writeFileSync(source, JSON.stringify({ agents: { defaults: { workspace: root } }, mcp: { servers: {
    orkas: { command: 'old-command', args: ['old-arg'], env: { OLD_VALUE: 'keep-private' } },
    personal: { command: 'personal-command' },
  } } }));
  // A deterministic native CLI fixture: Node executes `config file` and
  // `agent ...` as distinct script entry points, using the real spawn path.
  fs.writeFileSync(path.join(root, 'config'), `process.stdout.write(${JSON.stringify(source)});`);
});
afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(root, { recursive: true, force: true });
});

function options(signal = new AbortController().signal) {
  return { binPath: TEST_NODE, cwd: root, prompt: 'Use the task tools', signal, timeoutMs: 5000,
    onEvent: (_event: any) => {}, bridge: { mcpConfigPath: path.join(root, 'run-mcp.json'),
      server: { command: TEST_NODE, args: ['bridge.cjs'], env: { ORKAS_BRIDGE_ENV_FILE: 'run-env.json' } } } };
}

describe('OpenClaw per-run bridge configuration', () => {
  it('keeps concurrent overlays distinct, preserves original settings and removes only its own files', async () => {
    const original = fs.readFileSync(source, 'utf8');
    const one = await prepareOpenclawBridge(options());
    const two = await prepareOpenclawBridge(options());
    try {
      expect(one.env.OPENCLAW_CONFIG_PATH).not.toBe(two.env.OPENCLAW_CONFIG_PATH);
      const config = JSON.parse(fs.readFileSync(one.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(config.$include[0]).toBe('openclaw.json');
      expect(JSON.parse(fs.readFileSync(path.join(root, config.$include[1]), 'utf8'))).toEqual({ mcp: { servers: { orkas: null } } });
      expect(config.mcp.servers.orkas).toEqual(options().bridge.server);
      expect(JSON.stringify(config)).not.toContain('keep-private');
      if (process.platform !== 'win32') expect(fs.statSync(one.env.OPENCLAW_CONFIG_PATH!).mode & 0o777).toBe(0o600);
      one.cleanup();
      expect(fs.existsSync(one.env.OPENCLAW_CONFIG_PATH!)).toBe(false);
      expect(fs.existsSync(two.env.OPENCLAW_CONFIG_PATH!)).toBe(true);
      expect(fs.readFileSync(source, 'utf8')).toBe(original);
    } finally { one.cleanup(); two.cleanup(); }
    expect(fs.readdirSync(root).filter(name => name.startsWith('.orkas-run-'))).toEqual([]);
  });

  it.each(['~', '$OPENCLAW_HOME'])('resolves the native %s config display prefix', async (prefix) => {
    const previous = process.env.OPENCLAW_HOME;
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    if (prefix === '$OPENCLAW_HOME') process.env.OPENCLAW_HOME = root;
    else delete process.env.OPENCLAW_HOME;
    fs.writeFileSync(path.join(root, 'config'), `process.stdout.write(${JSON.stringify(prefix + '/openclaw.json')});`);
    try {
      const prepared = await prepareOpenclawBridge(options());
      try {
        expect(path.dirname(prepared.env.OPENCLAW_CONFIG_PATH!)).toBe(root);
        expect(JSON.parse(fs.readFileSync(prepared.env.OPENCLAW_CONFIG_PATH!, 'utf8')).$include[0]).toBe('openclaw.json');
      } finally { prepared.cleanup(); }
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('supports a new native profile without an existing config and removes its overlay', async () => {
    fs.unlinkSync(source);
    const prepared = await prepareOpenclawBridge(options());
    try {
      const config = JSON.parse(fs.readFileSync(prepared.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(config.$include).toBeUndefined();
      expect(config.mcp.servers.orkas).toEqual(options().bridge.server);
      expect(fs.existsSync(source)).toBe(false);
    } finally { prepared.cleanup(); }
    expect(fs.existsSync(prepared.env.OPENCLAW_CONFIG_PATH!)).toBe(false);
  });

  it.each(['success', 'failure', 'cancel', 'timeout'] as const)('cleans the overlay after backend %s and preserves session arguments', async (outcome) => {
    fs.writeFileSync(path.join(root, 'agent'), `
      const fs = require('node:fs');
      fs.writeFileSync('observed.json', JSON.stringify({config:process.env.OPENCLAW_CONFIG_PATH,args:process.argv}));
      ${(outcome === 'cancel' || outcome === 'timeout') ? 'setInterval(() => {}, 1000);' : `process.stderr.write(JSON.stringify({payloads:[{text:'finished'}],meta:{}})); process.exitCode=${outcome === 'failure' ? 1 : 0};`}
    `);
    const controller = new AbortController();
    const events: any[] = [];
    const running = openclawBackend.run({ ...options(controller.signal), timeoutMs: outcome === 'timeout' ? 300 : 5000, resumeSessionId: 'existing-session', onEvent: event => events.push(event) });
    // Attach immediately so a setup failure is reported as a test failure, never an unhandled rejection.
    const settled = running.then(() => undefined, error => error as Error);
    if (outcome === 'cancel') {
      await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'observed.json'))).toBe(true));
      controller.abort();
    }
    expect(await settled).toBeUndefined();
    const observed = JSON.parse(fs.readFileSync(path.join(root, 'observed.json'), 'utf8'));
    expect(observed.args).toEqual(expect.arrayContaining(['--session-id', 'existing-session']));
    expect(observed.args.join(' ')).not.toContain(observed.config);
    expect(events.at(-1)).toMatchObject({ status: outcome === 'success' ? 'completed' : outcome === 'failure' ? 'failed' : outcome === 'timeout' ? 'timeout' : 'cancelled' });
    expect(fs.existsSync(observed.config)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(root).filter(name => name.startsWith('.orkas-run-'))).toEqual([]);
  });

  it.each(['invalid', 'timeout', 'cancel'] as const)('stops before agent execution on config probe %s', async (failure) => {
    fs.writeFileSync(path.join(root, 'config'), failure === 'invalid'
      ? "process.stderr.write('private config diagnostic'); process.exitCode=1;"
      : 'setInterval(() => {}, 1000);');
    fs.writeFileSync(path.join(root, 'agent'), "require('node:fs').writeFileSync('must-not-run', 'bad');");
    const controller = new AbortController();
    const running = openclawBackend.run({ ...options(controller.signal), timeoutMs: 150 });
    const rejection = expect(running).rejects.toThrow(/OpenClaw/);
    if (failure === 'cancel') controller.abort();
    await rejection;
    expect(fs.existsSync(path.join(root, 'must-not-run'))).toBe(false);
    expect(fs.readdirSync(root).filter(name => name.startsWith('.orkas-run-'))).toEqual([]);
  });
});
