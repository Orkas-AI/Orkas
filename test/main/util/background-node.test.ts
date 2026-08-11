import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveBackgroundNodeRuntime,
  withBackgroundNodeEnv,
} from '../../../src/main/util/background-node';

describe('background Node runtime', () => {
  it('prefers stock bundled Node and does not mark it as Electron', () => {
    expect(resolveBackgroundNodeRuntime({
      bundledNode: '/opt/orkas/runtime/node',
      electronExecutable: '/Applications/Orkas.app/Contents/MacOS/Orkas',
      platform: 'darwin',
    })).toEqual({
      executable: '/opt/orkas/runtime/node',
      electronAsNode: false,
    });
  });

  it('fails closed on macOS instead of launching the GUI executable', () => {
    expect(() => resolveBackgroundNodeRuntime({
      lookupBundledNode: () => undefined,
      electronExecutable: '/Applications/Orkas.app/Contents/MacOS/Orkas',
      platform: 'darwin',
    })).toThrowError(expect.objectContaining({ code: 'E_BACKGROUND_NODE_MISSING' }));
  });

  it('retains the historical Electron fallback outside macOS', () => {
    expect(resolveBackgroundNodeRuntime({
      lookupBundledNode: () => undefined,
      electronExecutable: '/opt/orkas/electron',
      platform: 'linux',
    })).toEqual({
      executable: '/opt/orkas/electron',
      electronAsNode: true,
    });
  });

  it('removes stale Electron markers from bundled-Node child environments', () => {
    expect(withBackgroundNodeEnv({
      ELECTRON_RUN_AS_NODE: '1',
      ORKAS_NODE: '/old/electron',
      KEEP: 'yes',
    }, {
      executable: '/opt/orkas/runtime/node',
      electronAsNode: false,
    })).toEqual({
      ORKAS_NODE: '/opt/orkas/runtime/node',
      ORKAS_BUNDLED_NODE: '/opt/orkas/runtime/node',
      KEEP: 'yes',
    });
  });

  it('removes stale bundled-Node markers when a non-macOS checkout uses the fallback', () => {
    expect(withBackgroundNodeEnv({
      ORKAS_BUNDLED_NODE: '/stale/node',
      KEEP: 'yes',
    }, {
      executable: '/opt/orkas/electron',
      electronAsNode: true,
    })).toEqual({
      ORKAS_NODE: '/opt/orkas/electron',
      ELECTRON_RUN_AS_NODE: '1',
      KEEP: 'yes',
    });
  });

  it('keeps every app-owned background launch path behind the runtime resolver', () => {
    const childLaunchFiles = [
      'src/main/features/connectors/apply-template.ts',
      'src/main/features/connectors/manager.ts',
      'src/main/features/local_agents/bridge.ts',
      'src/main/features/local_agents/runner.ts',
      'src/main/features/packages.ts',
      'src/main/model/core-agent/client.ts',
    ];
    const forbidden = [
      /ELECTRON_RUN_AS_NODE/,
      /command:\s*process\.execPath/,
      /ORKAS_NODE:\s*process\.execPath/,
      /spawn(?:Sync)?\(process\.execPath/,
    ];

    const violations = childLaunchFiles.flatMap((relativeFile) => {
      const source = fs.readFileSync(path.join(process.cwd(), relativeFile), 'utf8');
      return forbidden
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativeFile}: ${pattern.source}`);
    });
    expect(violations).toEqual([]);
  });
});
