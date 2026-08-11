import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const UID = 'html-preview-tool-user';
const CID = 'html-preview-tool-conversation';

let root: string;
let previousWorkspaceRoot: string | undefined;

async function expectLosslessImageMatch(
  actual: { data: string; mediaType?: string },
  expected: Buffer,
) {
  expect(actual.mediaType).toBe('image/webp');
  const actualPixels = await sharp(Buffer.from(actual.data, 'base64')).ensureAlpha().raw().toBuffer();
  const expectedPixels = await sharp(expected).ensureAlpha().raw().toBuffer();
  expect(actualPixels).toEqual(expectedPixels);
}

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
  const screenshots = await Promise.all([
    sharp({
      create: {
        width: 144,
        height: 90,
        channels: 4,
        background: { r: 28, g: 88, b: 160, alpha: 1 },
      },
    }).png({ compressionLevel: 0 }).toBuffer(),
    sharp({
      create: {
        width: 39,
        height: 84,
        channels: 4,
        background: { r: 244, g: 168, b: 64, alpha: 1 },
      },
    }).png({ compressionLevel: 0 }).toBuffer(),
  ]);
  const baseResult = {
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
      visual_evidence: {
        attached: true,
        viewports: ['desktop', 'mobile'],
        policy: 'attached_only_after_runtime_dom_checks_passed',
      },
      interactions: {
        performed: true,
        viewport: 'desktop',
        controlsExercised: 2,
        stateChangesObserved: 1,
        artifactMessagesObserved: 0,
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
    screenshots,
  } as any;
  const render = vi.spyOn(feature, 'renderResponsiveHtmlPreview').mockImplementation(
    async (_entryPath, requestedViewports, _deps, options) => {
      const requestedNames = requestedViewports.map((viewport) => viewport.name);
      const selectedIndexes = requestedNames.map((name) => name === 'desktop' ? 0 : 1);
      const interactionEvidence = options?.interactions === false
        ? {
          ...baseResult.evidence.interactions,
          performed: false,
          controlsExercised: 0,
          stateChangesObserved: 0,
          artifactMessagesObserved: 0,
          downloadCandidates: [],
          formsFound: 0,
          formsSubmitted: 0,
          hashLinksChecked: 0,
          mailtoLinksChecked: 0,
          downloads: [],
          failures: [],
        }
        : baseResult.evidence.interactions;
      return {
        evidence: {
          ...baseResult.evidence,
          viewports: baseResult.evidence.viewports.filter(
            (viewport: { name: string }) => requestedNames.includes(viewport.name),
          ),
          screenshotCaptures: baseResult.evidence.screenshotCaptures.filter(
            (capture: { viewport: string }) => requestedNames.includes(capture.viewport),
          ),
          visual_evidence: {
            ...baseResult.evidence.visual_evidence,
            viewports: requestedNames,
          },
          interactions: {
            ...interactionEvidence,
            viewport: requestedNames[0],
          },
        },
        screenshots: selectedIndexes.map((index) => baseResult.screenshots[index]),
      };
    },
  );

  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const tool = localTools.createLocalTools({ userId: UID, cid: CID })
    .find((candidate) => candidate.name === 'html_preview');
  if (!tool) throw new Error('html_preview tool missing');
  return {
    render,
    screenshots,
    tool,
    workspace,
    context: { workingDir: workspace, state: {}, signal: undefined } as any,
  };
}

describe('html_preview tool', () => {
  it('publishes a desktop default while keeping responsive review opt-in in the model-facing schema', async () => {
    const { tool } = await buildTool();

    expect(tool.inputSchema).toMatchObject({
      required: ['path'],
      properties: {
        target: {
          default: 'desktop',
          enum: ['responsive', 'desktop', 'mobile'],
        },
        screenshots: {
          default: false,
          type: 'boolean',
        },
        interactions: {
          default: true,
          type: 'boolean',
        },
      },
    });
    expect(tool.description).toContain('target defaults to desktop');
    expect(tool.description).toContain('responsive only on a user multi-device request');
    expect(tool.description).toContain('screenshots defaults to false');
    expect(tool.description).toContain('set it false for visual-only UI review');
    expect(tool.description).toContain('never invokes a separate vision API');
  });

  it('returns deterministic evidence without model images by default', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Audit only</main>');

    const result = await tool.execute({ path: 'index.html' }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      viewports: [{ name: 'desktop' }],
      visual_evidence: {
        attached: false,
        reason: 'not_requested',
        policy: 'attach_only_when_requested_after_preview_checks_passed',
      },
    });
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'desktop', width: 1440, height: 900 },
    ]);
  });

  it('keeps visual review evidence while explicitly skipping control and form playback', async () => {
    const { render, tool, workspace, context } = await buildTool();
    const entry = path.join(workspace, 'index.html');
    fs.writeFileSync(entry, '<!doctype html><form><button type="submit">Sign in</button></form>');

    const result = await tool.execute({
      path: 'index.html',
      interactions: false,
      screenshots: true,
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      viewports: [{ name: 'desktop', consoleErrors: [] }],
      interactions: {
        performed: false,
        controlsExercised: 0,
        formsSubmitted: 0,
        keyboard: {
          method: 'tab-key',
          visibleFocusIndicators: 1,
        },
      },
      visual_evidence: {
        attached: true,
        viewports: ['desktop'],
      },
    });
    expect(render).toHaveBeenCalledWith(
      entry,
      [{ name: 'desktop', width: 1440, height: 900 }],
      {},
      { interactions: false },
    );
  });

  it('renders both viewports only for an explicitly responsive deliverable and returns both inline screenshots', async () => {
    const { render, screenshots, tool, workspace, context } = await buildTool();
    const entry = path.join(workspace, 'index.html');
    fs.writeFileSync(entry, '<!doctype html><button>Contact</button>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'responsive',
      screenshots: true,
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(2);
    for (const [index, image] of (result.images ?? []).entries()) {
      expect(image.mediaType).toBe('image/webp');
      const encoded = Buffer.from(image.data, 'base64');
      expect(encoded.length).toBeLessThan(screenshots[index].length);
      const sourcePixels = await sharp(screenshots[index]).ensureAlpha().raw().toBuffer();
      const encodedPixels = await sharp(encoded).ensureAlpha().raw().toBuffer();
      expect(encodedPixels).toEqual(sourcePixels);
    }
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

  it('returns deterministic diagnostics without model images when rendered checks fail', async () => {
    const { tool, workspace, context } = await buildTool({
      ok: false,
      blockers: ['mobile: horizontal overflow is 28px'],
    });
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Wide</main>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'responsive',
      screenshots: true,
    }, context);

    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      blockers: ['mobile: horizontal overflow is 28px'],
      interactions: {
        formsSubmitted: 1,
        downloads: [{ filename: 'resume.txt' }],
      },
      visual_evidence: {
        attached: false,
        reason: 'deterministic_checks_failed',
        policy: 'attach_only_after_requested_preview_checks_pass',
      },
      viewports: [{ name: 'desktop' }, { name: 'mobile', horizontalOverflowPx: 28 }],
    });
  });

  it('renders only the declared fixed target instead of paying for an irrelevant visual viewport', async () => {
    const { render, screenshots, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Desktop canvas</main>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'desktop',
      screenshots: true,
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    await expectLosslessImageMatch(result.images![0], screenshots[0]);
    expect(JSON.parse(result.content)).toMatchObject({
      viewports: [{ name: 'desktop' }],
      screenshotCaptures: [{ viewport: 'desktop' }],
      visual_evidence: { viewports: ['desktop'] },
    });
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'desktop', width: 1440, height: 900 },
    ]);
  });

  it('renders exactly one mobile screenshot for an explicitly mobile artifact', async () => {
    const { render, screenshots, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Mobile canvas</main>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'mobile',
      screenshots: true,
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    await expectLosslessImageMatch(result.images![0], screenshots[1]);
    expect(JSON.parse(result.content)).toMatchObject({
      viewports: [{ name: 'mobile' }],
      screenshotCaptures: [{ viewport: 'mobile' }],
      visual_evidence: { viewports: ['mobile'] },
    });
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'mobile', width: 390, height: 844 },
    ]);
  });

  it('defaults an omitted target to one lossless desktop screenshot', async () => {
    const { render, screenshots, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Fixed canvas</main>');

    const result = await tool.execute({ path: 'index.html', screenshots: true }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(1);
    await expectLosslessImageMatch(result.images![0], screenshots[0]);
    expect(JSON.parse(result.content)).toMatchObject({
      viewports: [{ name: 'desktop' }],
      screenshotCaptures: [{ viewport: 'desktop' }],
      visual_evidence: { viewports: ['desktop'] },
    });
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'desktop', width: 1440, height: 900 },
    ]);
  });

  it('rejects an unknown target instead of silently treating it as responsive', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Fixed canvas</main>');

    const result = await tool.execute({ path: 'index.html', target: 'tablet' }, context);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('must be responsive, desktop, or mobile when provided');
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects truthy strings so screenshot attachment cannot be enabled ambiguously', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Audit</main>');

    const result = await tool.execute({
      path: 'index.html',
      screenshots: 'true',
    }, context);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('`screenshots` must be a boolean');
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects ambiguous interaction-check inputs', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Audit</main>');

    const result = await tool.execute({
      path: 'index.html',
      interactions: 'false',
    }, context);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('`interactions` must be a boolean');
    expect(render).not.toHaveBeenCalled();
  });

  it('validates only the selected fixed viewport configuration', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Desktop canvas</main>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'desktop',
      mobile: { width: 768, height: 844 },
    }, context);

    expect(result.isError).toBeUndefined();
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'desktop', width: 1440, height: 900 },
    ]);
  });

  it('keeps responsive viewport order and applies both user-requested dimensions', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Responsive</main>');

    const result = await tool.execute({
      path: 'index.html',
      target: 'responsive',
      screenshots: true,
      desktop: { width: 1280, height: 720 },
      mobile: { width: 360, height: 780 },
    }, context);

    expect(result.isError).toBeUndefined();
    expect(result.images).toHaveLength(2);
    expect(render).toHaveBeenCalledWith(path.join(workspace, 'index.html'), [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'mobile', width: 360, height: 780 },
    ]);
  });

  it('rejects invalid, missing, and out-of-workspace entries before starting the renderer', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>OK</main>');
    const outside = path.join(root, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html><main>Outside</main>');

    const invalidViewport = await tool.execute({
      path: 'index.html',
      target: 'responsive',
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
