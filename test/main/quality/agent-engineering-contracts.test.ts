import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

function walkSourceFiles(directory: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkSourceFiles(absolute));
    else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

describe('public runtime engineering contracts', () => {
  it('keeps every documented current-code entry point real', () => {
    const documentedSourcePaths = [
      'src/main/prompts/loader.ts',
      'src/main/prompts/chat_prompt_composer.ts',
      'src/main/features/group_chat/bus.ts',
      'src/main/features/agents.ts',
      'src/main/features/skills.ts',
      'src/main/model/core-agent/runner.ts',
      'src/main/model/core-agent/sdk-timeout-patch.ts',
      'src/main/features/local_agents/context.ts',
      'src/core-agent/src/agent/runner.ts',
      'src/core-agent/src/agent/repository-instructions.ts',
      'src/core-agent/src/agent/session.ts',
      'src/core-agent/src/agent/persistent-session.ts',
      'src/main/model/core-agent/session-store.ts',
      'src/core-agent/src/index.ts',
    ];
    for (const relative of documentedSourcePaths) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(true);
    }
  });

  it('enforces the current CommonJS-to-ESM core-agent import boundary', () => {
    const pcPackage = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { imports?: Record<string, string>; scripts?: Record<string, string> };
    const corePackage = JSON.parse(
      fs.readFileSync(path.join(root, 'src', 'core-agent', 'package.json'), 'utf8'),
    ) as { type?: string };
    expect(pcPackage.imports?.['#core-agent']).toBe('./src/core-agent/src/index.ts');
    expect(pcPackage.scripts?.typecheck)
      .toBe('npm run typecheck:main && npm run typecheck:core-agent');
    expect(pcPackage.scripts?.['typecheck:core-agent'])
      .toBe('tsc --noEmit -p src/core-agent/tsconfig.json');
    expect(corePackage.type).toBe('module');

    for (const absolute of walkSourceFiles(path.join(root, 'src', 'main'))) {
      const source = fs.readFileSync(absolute, 'utf8');
      const staticImports = source.match(/^\s*import\s+(?!\()[\s\S]*?;\s*$/gm) || [];
      const valueImports = staticImports.filter(
        (statement) => statement.includes("'#core-agent'")
          || statement.includes('"#core-agent"'),
      ).filter((statement) => !/^\s*import\s+type\b/.test(statement));
      expect(
        valueImports,
        `${path.relative(root, absolute)} must dynamically import #core-agent; only type imports may be static`,
      ).toEqual([]);
      expect(source).not.toMatch(/\brequire\s*\(\s*['"]#core-agent['"]\s*\)/);
    }
  });

  it('keeps core-agent persistence and auth logs free of paths and session ids', () => {
    const persistent = fs.readFileSync(
      path.join(root, 'src', 'core-agent', 'src', 'agent', 'persistent-session.ts'),
      'utf8',
    );
    const skillLoader = fs.readFileSync(
      path.join(root, 'src', 'core-agent', 'src', 'skills', 'loader.ts'),
      'utf8',
    );
    const authStore = fs.readFileSync(
      path.join(root, 'src', 'core-agent', 'src', 'auth', 'store.ts'),
      'utf8',
    );
    expect(persistent).not.toMatch(/(?:log|console)\.(?:debug|info|warn|error)[^\n]*(?:sessionFile|contextFile|getSessionId)/);
    expect(skillLoader).not.toMatch(/log\.warn[^\n]*(?:skillFile|\$\{dir\})/);
    expect(authStore).not.toContain('{ path: storePath }');
    expect(persistent).toContain('errorCodeForLog(err)');
    expect(skillLoader).toContain('errorCodeForLog(err)');
    expect(authStore).toContain('errorCodeForLog(err)');
  });
});
