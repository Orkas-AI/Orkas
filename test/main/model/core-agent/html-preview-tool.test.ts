import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UID = 'html-preview-tool-user';
const CID = 'html-preview-tool-conversation';

let root: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-html-preview-tool-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('workspace_approval');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function buildTool(rendered: {
  ok: boolean;
  blockers?: string[];
} = { ok: true }) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const selected = userWorkspace.setWorkspacePath(UID, workspace);
  if (!selected.ok) throw new Error(selected.error);

  const feature = await import('../../../../src/main/features/html_preview');
  const render = vi.spyOn(feature, 'renderResponsiveHtmlPreview').mockResolvedValue({
    evidence: {
      ok: rendered.ok,
      entryPath: path.join(workspace, 'index.html'),
      blockedResourceCount: 0,
      blockedResourceSamples: [],
      blockers: rendered.blockers ?? [],
      warnings: [],
      viewports: [
        {
          name: 'desktop',
          width: 1440,
          height: 900,
          screenshotWidth: 1440,
          screenshotHeight: 900,
          readyState: 'complete',
          title: 'Preview',
          visibleTextChars: 12,
          scrollWidth: 1440,
          scrollHeight: 900,
          horizontalOverflowPx: 0,
          focusableCount: 1,
          headingCount: 1,
          missingAltCount: 0,
          failedImageCount: 0,
          layoutIssues: [],
          consoleErrors: [],
        },
        {
          name: 'mobile',
          width: 390,
          height: 844,
          screenshotWidth: 390,
          screenshotHeight: 844,
          readyState: 'complete',
          title: 'Preview',
          visibleTextChars: 12,
          scrollWidth: rendered.ok ? 390 : 418,
          scrollHeight: 844,
          horizontalOverflowPx: rendered.ok ? 0 : 28,
          focusableCount: 1,
          headingCount: 1,
          missingAltCount: 0,
          failedImageCount: 0,
          layoutIssues: [],
          consoleErrors: [],
        },
      ],
      screenshotCaptures: [
        { viewport: 'desktop', width: 1440, height: 900, captured: true },
        { viewport: 'mobile', width: 390, height: 844, captured: true },
      ],
      interactions: {
        viewport: 'desktop',
        downloadCandidates: ['Download resume'],
        formsFound: 1,
        formsSubmitted: 1,
        hashLinksChecked: 2,
        mailtoLinksChecked: 1,
        downloads: [{
          filename: 'resume.txt',
          mimeType: 'text/plain',
          totalBytes: 128,
          urlKind: 'blob',
        }],
        keyboard: {
          method: 'tab-key',
          focusableFound: 1,
          tabStopsVisited: 1,
          uniqueTabStopsVisited: 1,
          visibleFocusIndicators: 1,
          sequence: ['Contact'],
          failures: [],
        },
        failures: [],
      },
    },
    screenshots: [Buffer.from('desktop-png'), Buffer.from('mobile-png')],
  });

  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const tool = localTools.createLocalTools({ userId: UID, cid: CID })
    .find((candidate) => candidate.name === 'html_preview');
  if (!tool) throw new Error('html_preview tool missing');
  return {
    render,
    tool,
    workspace,
    context: { workingDir: workspace, state: {}, signal: undefined } as any,
  };
}

describe('html_preview tool', () => {
  it('always renders one desktop and one mobile viewport and returns both inline screenshots', async () => {
    const { render, tool, workspace, context } = await buildTool();
    const entry = path.join(workspace, 'index.html');
    fs.writeFileSync(entry, '<!doctype html><button>Contact</button>');

    const result = await tool.execute({ path: 'index.html' }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toEqual([
      { data: Buffer.from('desktop-png').toString('base64'), mediaType: 'image/png' },
      { data: Buffer.from('mobile-png').toString('base64'), mediaType: 'image/png' },
    ]);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      interactions: {
        formsSubmitted: 1,
        keyboard: {
          method: 'tab-key',
          uniqueTabStopsVisited: 1,
          visibleFocusIndicators: 1,
        },
        downloads: [{ filename: 'resume.txt', totalBytes: 128 }],
      },
      screenshotCaptures: [
        { viewport: 'desktop', width: 1440, height: 900, captured: true },
        { viewport: 'mobile', width: 390, height: 844, captured: true },
      ],
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ],
    });
    expect(render).toHaveBeenCalledWith(entry, [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]);
  });

  it('keeps screenshots and diagnostics visible while failing a rendered layout defect', async () => {
    const { tool, workspace, context } = await buildTool({
      ok: false,
      blockers: ['mobile: horizontal overflow is 28px'],
    });
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Wide</main>');

    const result = await tool.execute({ path: 'index.html' }, context);

    expect(result.isError).toBe(true);
    expect(result.images).toHaveLength(2);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      blockers: ['mobile: horizontal overflow is 28px'],
      interactions: {
        formsSubmitted: 1,
        downloads: [{ filename: 'resume.txt' }],
      },
      viewports: [{ name: 'desktop' }, { name: 'mobile', horizontalOverflowPx: 28 }],
    });
  });

  it('rejects invalid, missing, and out-of-workspace entries before starting the renderer', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>OK</main>');
    const outside = path.join(root, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html><main>Outside</main>');

    const invalidViewport = await tool.execute({
      path: 'index.html',
      mobile: { width: 768, height: 844 },
    }, context);
    const missing = await tool.execute({ path: 'missing.html' }, context);
    const outOfScope = await tool.execute({ path: outside }, context);

    expect(invalidViewport).toMatchObject({ isError: true });
    expect(invalidViewport.content).toContain('mobile.width');
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toContain('E_HTML_PREVIEW_NOT_FOUND');
    expect(outOfScope).toMatchObject({ isError: true });
    expect(outOfScope.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(render).not.toHaveBeenCalled();
  });
});
