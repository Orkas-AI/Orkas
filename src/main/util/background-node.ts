import { bundledNodeExecutable } from './bundled-runtime';

export interface BackgroundNodeRuntime {
  executable: string;
  electronAsNode: boolean;
}

interface BackgroundNodeRuntimeOptions {
  bundledNode?: string;
  electronExecutable?: string;
  platform?: NodeJS.Platform;
  lookupBundledNode?: () => string | undefined;
}

/**
 * Resolve the runtime used by long-lived/headless Orkas helpers (MCP adapters,
 * CLI bridges, and bridge-launched skills).
 *
 * On macOS, never silently reuse the GUI Electron executable. Launching
 * `Orkas.app/Contents/MacOS/Electron` with `ELECTRON_RUN_AS_NODE=1` still gives
 * every helper the Orkas application identity, so App Data Protection can
 * present one privacy dialog per spawned helper. The packaged runtime gate and
 * the development prestart hook both guarantee a stock bundled Node binary.
 * Failing closed if that invariant is broken is preferable to recurring TCC
 * prompts.
 *
 * Windows/Linux retain the historical Electron-as-Node fallback so an
 * incomplete development checkout remains diagnosable on platforms without
 * the macOS privacy behavior.
 */
export function resolveBackgroundNodeRuntime(
  options: BackgroundNodeRuntimeOptions = {},
): BackgroundNodeRuntime {
  const bundledNode = options.bundledNode
    || (options.lookupBundledNode || bundledNodeExecutable)();
  if (bundledNode) {
    return { executable: bundledNode, electronAsNode: false };
  }

  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const err = new Error(
      'Bundled Node runtime is required for Orkas background helpers on macOS. '
      + 'Run the runtime preparation step and restart Orkas.',
    ) as Error & { code?: string };
    err.code = 'E_BACKGROUND_NODE_MISSING';
    throw err;
  }

  return {
    executable: options.electronExecutable || process.execPath,
    electronAsNode: true,
  };
}

/** Apply the runtime to a child env without leaking a stale Electron marker. */
export function withBackgroundNodeEnv(
  base: Record<string, string>,
  runtime: BackgroundNodeRuntime,
): Record<string, string> {
  const env: Record<string, string> = {
    ...base,
    ORKAS_NODE: runtime.executable,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (runtime.electronAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
    delete env.ORKAS_BUNDLED_NODE;
  } else {
    env.ORKAS_BUNDLED_NODE = runtime.executable;
  }
  return env;
}
