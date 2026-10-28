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
      required: [],
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
    const properties = tool.inputSchema.properties as any;
    expect(tool.description).toContain('isolated browser');
    expect(properties.artifact_id.description).toContain('current conversation');
    expect(properties.target.description).toContain('Defaults to desktop');
    expect(properties.target.description).toContain('responsive only when viewport-dependent reflow is explicitly requested');
    expect(properties.screenshots.description).toContain('Defaults to false');
    expect(properties.screenshots.description).toContain('never invokes a separate vision API');
    expect(properties.interactions.description).toContain('Set false for visual-only UI review');
  });

  it('previews a newly created conversation app by its durable ID without a workspace copy', async () => {
    const { render, workspace, context, screenshots } = await buildTool();
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    let artifactId = '';
    const create = createLocalTools({
      userId: UID, cid: CID,
      artifactInteractionSmoke: async () => ({ ok: true, blockers: [], warnings: [] }),
      onArtifactCreated: (artifact) => { artifactId = artifact.id; },
    }).find(tool => tool.name === 'create_artifact')!;
    const created = await create.execute({
      files: [{ path: 'index.html', content: '<!doctype html><button>Preview</button><script src="__orkas/bridge.js"></script>' }],
    }, context);
    expect(created.isError).toBeUndefined();
    expect(artifactId).not.toBe('');
    expect(fs.existsSync(path.join(workspace, 'index.html'))).toBe(false);
    const preview = createLocalTools({ userId: UID, cid: CID }).find(tool => tool.name === 'html_preview')!;
    const result = await preview.execute({ artifact_id: artifactId, target: 'responsive', screenshots: true }, context);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, artifact_id: artifactId });
    expect(JSON.parse(result.content)).not.toHaveProperty('entryPath');
    const artifacts = await import('../../../../src/main/features/chat_artifacts');
    const entry = artifacts.resolveArtifactFilePath(UID, CID, artifactId, 'index.html');
    expect(entry.ok).toBe(true);
    expect(render).toHaveBeenCalledWith((entry as { absPath: string }).absPath,
      expect.arrayContaining([expect.objectContaining({ name: 'desktop' }), expect.objectContaining({ name: 'mobile' })]),
      {}, expect.objectContaining({ bridgeJavaScript: expect.any(String) }));
    expect(render.mock.calls[0][3]?.fileViewer).not.toBe(true);
    expect(fs.existsSync(path.join(path.dirname((entry as { absPath: string }).absPath), '__orkas', 'bridge.js'))).toBe(false);
    expect(result.content).not.toContain(root);
    await expectLosslessImageMatch(result.images![0], screenshots[0]);
  });

  it.each([
    {}, { artifact_id: '' }, { artifact_id: 123 }, { artifact_id: null },
    { artifact_id: 'app', path: 'index.html' }, { artifact_id: 'app', path: '' },
    { artifact_id: 'app', path: null },
  ])('rejects missing or ambiguous preview sources before rendering: %j', async (input) => {
    const { tool, render, context } = await buildTool();
    const result = await tool.execute(input, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_BAD_INPUT');
    expect(render).not.toHaveBeenCalled();
  });

  it.each(['other-conversation', 'other-user', 'missing', '../index.html', 'symlink-entry', 'symlink-directory'])(
    'does not render an inaccessible artifact (%s), even with broad local access', async (scenario) => {
      const { tool, render, context } = await buildTool();
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode('all_files_auto');
      const artifacts = await import('../../../../src/main/features/chat_artifacts');
      const uid = scenario === 'other-user' ? 'another-user' : UID;
      const cid = scenario === 'other-conversation' ? 'another-conversation' : CID;
      const created = await artifacts.createArtifact(uid, cid, '', {
        files: [{ path: 'index.html', content: '<!doctype html><button>Private app</button>' }],
      });
      if (!created.ok) throw new Error('fixture creation failed');
      const resolved = artifacts.resolveArtifactDir(uid, cid, created.artifactId);
      if (!resolved.ok) throw new Error('fixture resolution failed');
      if (scenario.startsWith('symlink')) {
        const outside = path.join(root, 'outside-app');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'index.html'), '<button>Private</button>');
        const target = scenario === 'symlink-entry' ? path.join(resolved.dirPath, 'index.html') : resolved.dirPath;
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync(scenario === 'symlink-entry' ? path.join(outside, 'index.html') : outside, target);
      }
      const artifactId = scenario === 'missing' ? 'unknown-app' : scenario === '../index.html' ? scenario : created.artifactId;
      const result = await tool.execute({ artifact_id: artifactId }, context);
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain(root);
      expect(render).not.toHaveBeenCalled();
    },
  );

  it('requires a conversation binding for artifact IDs', async () => {
    const { context, render } = await buildTool();
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tool = createLocalTools({ userId: UID }).find(tool => tool.name === 'html_preview')!;
    const result = await tool.execute({ artifact_id: 'app' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_NO_CONVERSATION');
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects an app after the active account changes', async () => {
    const { context, render, tool } = await buildTool();
    const artifacts = await import('../../../../src/main/features/chat_artifacts');
    const created = await artifacts.createArtifact(UID, CID, '', {
      files: [{ path: 'index.html', content: '<button>Private app</button>' }],
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const users = await import('../../../../src/main/features/users');
    users.activateUser('different-account');
    const result = await tool.execute({ artifact_id: created.artifactId }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_NO_CONVERSATION');
    expect(render).not.toHaveBeenCalled();
  });

  it('retains app layout failures and withholds screenshots without exposing its storage path', async () => {
    const { context, render, tool } = await buildTool({ ok: false, blockers: ['mobile: horizontal overflow is 28px'] });
    const artifacts = await import('../../../../src/main/features/chat_artifacts');
    const created = await artifacts.createArtifact(UID, CID, '', {
      files: [{ path: 'index.html', content: '<button>App with overflow</button>' }],
    });
    if (!created.ok) throw new Error('fixture creation failed');
    const result = await tool.execute({ artifact_id: created.artifactId, screenshots: true }, context);
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      artifact_id: created.artifactId, blockers: ['mobile: horizontal overflow is 28px'],
      visual_evidence: { attached: false, reason: 'deterministic_checks_failed' },
    });
    expect(result.content).not.toContain(root);
    render.mockRejectedValueOnce(new Error(`cannot load ${root}/private-artifact/index.html`));
    const failed = await tool.execute({ artifact_id: created.artifactId }, context);
    expect(failed.content).toContain('E_HTML_PREVIEW_FAILED');
    expect(failed.content).not.toContain(root);
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
    ], {}, { fileViewer: true });
  });

  it('returns inconclusive observations without a tool error and retains requested screenshots', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><button aria-pressed="true">Review</button>');
    const original = render.getMockImplementation()!;
    render.mockImplementation(async (...args) => {
      const result = await original(...args);
      result.evidence.warnings = ['interaction outcome is inconclusive'];
      result.evidence.interactions.warnings = ['enabled control produced no observable outcome: Review'];
      result.evidence.interactions.warningCount = 1;
      return result;
    });
    const result = await tool.execute({ path: 'index.html', screenshots: true }, context);
    expect(result.isError).toBeFalsy();
    expect(result.images).toHaveLength(1);
    expect(JSON.parse(result.content)).toMatchObject({ ok: true,
      warnings: ['interaction outcome is inconclusive'], interactions: { warningCount: 1,
        warnings: ['enabled control produced no observable outcome: Review'] } });
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
      { interactions: false, fileViewer: true },
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
    ], {}, { fileViewer: true });
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
    ], {}, { fileViewer: true });
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
    ], {}, { fileViewer: true });
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
    ], {}, { fileViewer: true });
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
    ], {}, { fileViewer: true });
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
    ], {}, { fileViewer: true });
  });

  it('preserves browser-unavailable as an infrastructure-specific result code', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>Preview</main>');
    render.mockRejectedValueOnce(new Error(
      'E_HTML_PREVIEW_BROWSER_UNAVAILABLE: Electron BrowserWindow is unavailable',
    ));

    const result = await tool.execute({ path: 'index.html' }, context);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/^E_HTML_PREVIEW_BROWSER_UNAVAILABLE:/);
  });

  it('rejects invalid, missing, and out-of-workspace entries before starting the renderer', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>OK</main>');
    const outside = path.join(root, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html><main>Outside</main>');

    const invalidViewport = await tool.execute({
      path: 'index.html',
      target: 'responsive',
      mobile: { width: 360.5, height: 844 },
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

  it('renders with default out-of-range viewport dimensions and preserves valid dimensions', async () => {
    const { render, tool, workspace, context } = await buildTool();
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><main>OK</main>');
    const result = await tool.execute({ path: 'index.html', target: 'responsive',
      desktop: { width: 100, height: 720 }, mobile: { width: 768, height: 10000 } }, context);
    expect(result.isError).toBeFalsy();
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][1]).toEqual([
      { name: 'desktop', width: 1440, height: 720 }, { name: 'mobile', width: 390, height: 844 },
    ]);
    for (const width of [null, 'wide', '100000', 360.5]) {
      expect((await tool.execute({ path: 'index.html', target: 'mobile', mobile: { width } }, context)).isError).toBe(true);
    }
    expect(render).toHaveBeenCalledOnce();
  });
});
