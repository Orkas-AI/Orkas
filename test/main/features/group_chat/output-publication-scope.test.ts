import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Observe the delivery policy seam while checking which files the host may modify.

const inProcessFiles = vi.hoisted(() => ({
  paths: [] as string[],
  /** Subset of `paths` the tool reports as a write over a file that already
   *  existed — what edit_file / append_file / `apply_patch` update pass. */
  preExisting: [] as string[],
  /** Paths the model declares through `publish_outputs`. */
  publish: [] as string[],
  observed: [] as string[],
  accepted: [] as string[],
  output: 'done',
  afterRegistration: undefined as undefined | ((opts: any) => Promise<void>),
  afterPublication: undefined as undefined | ((opts: any) => Promise<void>),
}));
const cliFiles = vi.hoisted(() => ({ paths: [] as string[], declarations: [] as string[][], output: 'done' }));

// `onFileWritten` is the exact callback bus hands the in-process runner, and
// the real write_file / edit_file tools invoke it with the path they wrote.
// Calling it here reproduces that registration without executing real tools.
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    for (const p of inProcessFiles.paths) {
      await _opts?.onFileWritten?.(p, { preExisting: inProcessFiles.preExisting.includes(p) });
    }
    if (inProcessFiles.observed.length) {
      const { readProducedFileVersion } = await import('../../../../src/main/model/core-agent/task-file-ownership');
      for (const p of inProcessFiles.observed) await _opts?.onShellFileObserved?.(p, readProducedFileVersion(p));
    }
    await inProcessFiles.afterRegistration?.(_opts);
    if (inProcessFiles.publish.length) {
      inProcessFiles.accepted = await _opts?.onOutputsPublished?.([...inProcessFiles.publish]);
    }
    await inProcessFiles.afterPublication?.(_opts);
    yield { type: 'final', text: inProcessFiles.output };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

vi.mock('../../../../src/main/features/local_agents/runner', () => ({
  run: vi.fn(async (opts: any) => {
    if (cliFiles.paths.length) opts.onEvent({ type: 'file-change', paths: [...cliFiles.paths] });
    for (const paths of cliFiles.declarations) opts.onOutputsPublished(paths);
    opts.onEvent({ type: 'done', status: 'completed', output: cliFiles.output });
    return { runId: 'mock-run', status: 'completed', output: cliFiles.output };
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
let wsRoot: string;
let finalized: string[];
const TEST_UID = 'uWm';
const CLI_AGENT_ID = 'a11c0d1c0de1';
const CLI_AGENT_NAME = 'Coder';
const INPROC_AGENT_ID = 'b22d1e2d1df2';
const INPROC_AGENT_NAME = 'Writer';

function seedAgent(dir: string, id: string, name: string, runtime?: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: id,
    name,
    description: 'test agent',
    ...(runtime ? { runtime } : {}),
    created_at: 't', updated_at: 't',
  }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-output-scope-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  inProcessFiles.paths.length = 0;
  inProcessFiles.preExisting.length = 0;
  inProcessFiles.publish.length = 0;
  inProcessFiles.observed.length = 0;
  inProcessFiles.accepted.length = 0;
  inProcessFiles.output = 'done';
  inProcessFiles.afterRegistration = undefined;
  inProcessFiles.afterPublication = undefined;
  cliFiles.paths.length = 0;
  cliFiles.declarations.length = 0;
  cliFiles.output = 'done';
  finalized = [];

  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  const paths = await import('../../../../src/main/paths');
  seedAgent(paths.agentDir(TEST_UID, CLI_AGENT_ID), CLI_AGENT_ID, CLI_AGENT_NAME, { kind: 'cli', cli: 'claude' });
  seedAgent(paths.agentDir(TEST_UID, INPROC_AGENT_ID), INPROC_AGENT_ID, INPROC_AGENT_NAME);

  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  wsRoot = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsRoot, { recursive: true });
  userWorkspace.setWorkspacePath(TEST_UID, wsRoot);

  // Spy at the seam the guard protects: which paths reach the output policy.
  // Asserting here keeps the test independent of subscription tier.
  const hooks = await import('../../../../src/main/features/produced_output_hooks');
  hooks.registerProducedOutputHooks({
    finalizeFile: (absPath: string) => { finalized.push(absPath); },
  });
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 10_000) {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce for ${uid}/${cid}`);
}

function writeFileAt(abs: string, body: string): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

async function runTurn(agentName: string, cid: string, attachments?: string[], request = '改一下文件') {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${agentName} ${request}`, attachments });
  await waitForQuiescent(TEST_UID, cid);
  await bus.dropConv(TEST_UID, cid);
}

describe('produced-file finalization is scoped by the managed-root boundary', () => {
  it.each([false, true])('delivers an observed shell file only when explicitly selected: %s', async explicit => {
    const cid = `cid-observed-output-${explicit}`;
    const selected = writeFileAt(path.join(wsRoot, 'script-output.md'), 'selected bytes');
    const unselected = writeFileAt(path.join(wsRoot, 'parallel-output.md'), 'unselected bytes');
    const outside = writeFileAt(path.join(tmpDir, 'outside.md'), 'outside bytes');
    inProcessFiles.observed = [selected, unselected, outside];
    if (explicit) inProcessFiles.publish = [selected, outside];
    inProcessFiles.afterRegistration = async opts => expect(opts.hasProducedPath(selected)).toBe(false);
    await runTurn(INPROC_AGENT_NAME, cid);
    const { readMessages } = await import('../../../../src/main/features/group_chat');
    const expected = explicit ? [selected] : [];
    expect(inProcessFiles.accepted).toEqual(expected);
    expect((await readMessages(TEST_UID, cid)).flatMap(msg => msg.produced ?? [])).toEqual(expected);
    expect(finalized).toEqual([]);
    expect(fs.readFileSync(selected, 'utf8')).toBe('selected bytes');
    expect(fs.readFileSync(unselected, 'utf8')).toBe('unselected bytes');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
  });

  it.each(['before', 'after', 'reselected'] as const)('binds a shell delivery to the selected version: replacement %s', async phase => {
    const cid = `cid-shell-replaced-${phase}`;
    const file = writeFileAt(path.join(wsRoot, 'original.md'), 'shell output');
    const stable = writeFileAt(path.join(wsRoot, 'stable.md'), 'stable output');
    const replacement = writeFileAt(path.join(wsRoot, 'replacement.md'), 'different bytes from a concurrent writer');
    inProcessFiles.observed = [file, stable];
    inProcessFiles.publish = [file, stable];
    if (phase === 'before') inProcessFiles.afterRegistration = async () => { fs.renameSync(replacement, file); };
    else inProcessFiles.afterPublication = async opts => {
      fs.renameSync(replacement, file);
      const { readProducedFileVersion } = await import('../../../../src/main/model/core-agent/task-file-ownership');
      await opts.onShellFileObserved(file, readProducedFileVersion(file));
      if (phase === 'reselected') inProcessFiles.accepted = await opts.onOutputsPublished([file, stable]);
    };

    await runTurn(INPROC_AGENT_NAME, cid);
    const { readMessages } = await import('../../../../src/main/features/group_chat');
    expect(inProcessFiles.accepted).toEqual(phase === 'before' ? [stable] : [file, stable]);
    expect((await readMessages(TEST_UID, cid)).flatMap(msg => msg.produced ?? [])).toEqual(phase === 'reselected' ? [file, stable] : [stable]);
    expect(fs.readFileSync(file, 'utf8')).toBe('different bytes from a concurrent writer');
    expect(finalized).toEqual([]);
  });

  it('rechecks an observed output after finalizing a different deliverable', async () => {
    const cid = 'cid-shell-replaced-during-finalization';
    const shellFile = writeFileAt(path.join(wsRoot, 'script-output.md'), 'shell output');
    const hostFile = writeFileAt(path.join(wsRoot, 'host-output.md'), 'host output');
    inProcessFiles.observed = [shellFile];
    inProcessFiles.paths = [hostFile];
    inProcessFiles.publish = [shellFile, hostFile];
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    hooks.registerProducedOutputHooks({ finalizeFile: absPath => {
      finalized.push(absPath);
      fs.writeFileSync(shellFile, 'concurrent edit during finalization');
    } });

    await runTurn(INPROC_AGENT_NAME, cid);
    const { readMessages } = await import('../../../../src/main/features/group_chat');
    expect(inProcessFiles.accepted).toEqual([shellFile, hostFile]);
    expect(finalized).toEqual([hostFile]);
    expect((await readMessages(TEST_UID, cid)).flatMap(msg => msg.produced ?? [])).toEqual([hostFile]);
    expect(fs.readFileSync(shellFile, 'utf8')).toBe('concurrent edit during finalization');
  });

  it('preserves an externally edited host output and revokes automatic refinement', async () => {
    const file = writeFileAt(path.join(wsRoot, 'output.md'), 'host output');
    const stable = writeFileAt(path.join(wsRoot, 'stable.md'), 'stable output');
    inProcessFiles.paths = [file, stable];
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    hooks.registerProducedOutputHooks({ finalizeFile: absPath => {
      finalized.push(absPath);
      fs.appendFileSync(absPath, ' [finalized]');
    } });
    const refinement: boolean[] = [];
    inProcessFiles.afterRegistration = async opts => {
      refinement.push(opts.hasProducedPath(file));
      fs.writeFileSync(file, 'different bytes from an external writer');
      refinement.push(opts.hasProducedPath(file));
    };
    await runTurn(INPROC_AGENT_NAME, 'cid-changed-authority');
    expect(refinement).toEqual([true, false]);
    expect(finalized).toEqual([stable]);
    expect(fs.readFileSync(file, 'utf8')).toBe('different bytes from an external writer');
    expect(fs.readFileSync(stable, 'utf8')).toBe('stable output [finalized]');
  });
  it.each([false, true])('keeps ImageStudio layered drafts out of chat delivery, explicit=%s', async (explicit) => {
    const { IMAGE_STUDIO_AGENT_ID } = await import('../../../../src/main/model/core-agent/tool-catalog');
    const { agentDir } = await import('../../../../src/main/paths');
    const { registerImageStudioLayeredCandidates } = await import('../../../../src/main/features/image_studio_delivery');
    seedAgent(agentDir(TEST_UID, IMAGE_STUDIO_AGENT_ID), IMAGE_STUDIO_AGENT_ID, 'LayeredProof');
    const cid = `cid-layered-output-${explicit}`;
    const draft = writeFileAt(path.join(wsRoot, 'draft.psd'), 'candidate');
    const preview = writeFileAt(path.join(wsRoot, 'preview.png'), 'preview');
    const copy = writeFileAt(path.join(wsRoot, 'poster.png'), 'preview');
    const ordinary = writeFileAt(path.join(wsRoot, 'converted.png'), 'regular');
    await registerImageStudioLayeredCandidates(TEST_UID, cid, [draft, preview].map(file => {
      const st = fs.statSync(file);
      return { identity: `${st.dev}:${st.ino}:${st.birthtimeMs}`, size: st.size,
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    }));
    inProcessFiles.paths = [draft, preview, copy, ordinary];
    if (explicit) inProcessFiles.publish = [...inProcessFiles.paths];

    await runTurn('LayeredProof', cid);

    expect(finalized).toEqual([ordinary]);
    expect(fs.readFileSync(draft, 'utf8')).toBe('candidate');
    expect(fs.readFileSync(preview, 'utf8')).toBe('preview');
  });

  it.each(['publish', 'fallback', 'ordinary'] as const)(
    'requires a native ImageStudio PNG only for the explicit export request (%s)', async mode => {
      const { IMAGE_STUDIO_AGENT_ID } = await import('../../../../src/main/model/core-agent/tool-catalog');
      const { agentDir } = await import('../../../../src/main/paths');
      const { readMessages } = await import('../../../../src/main/features/group_chat');
      const { chatMediaLocalUrl } = await import('../../../../src/main/util/chat-media-url');
      const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
      seedAgent(agentDir(TEST_UID, IMAGE_STUDIO_AGENT_ID), IMAGE_STUDIO_AGENT_ID, 'ImageStudio');
      const cid = `cid-native-png-${mode}`;
      const candidate = writeFileAt(path.join(wsRoot, 'title.png'), 'edited raster');
      const note = writeFileAt(path.join(wsRoot, 'notes.md'), 'supporting notes');
      inProcessFiles.paths = [candidate, note];
      inProcessFiles.output = `![Title](${chatMediaLocalUrl(candidate)})`;
      if (mode !== 'fallback') inProcessFiles.afterRegistration = async opts => {
        const publish = createLocalTools({ userId: TEST_UID, cid, agentId: IMAGE_STUDIO_AGENT_ID,
          onOutputsPublished: opts.onOutputsPublished,
          imageStudioNativePngDelivery: opts.imageStudioNativePngDelivery,
        }).find(tool => tool.name === 'publish_outputs')!;
        const receipt = JSON.parse((await publish.execute({ paths: [candidate, note] }, { workingDir: wsRoot } as any)).content);
        if (mode === 'ordinary') expect(receipt).toMatchObject({ published: 2 });
        else expect(receipt).toMatchObject({
          status: 'incomplete', published: 1, blocked_candidates: [candidate],
          next_action: expect.stringContaining('project.export'),
        });
      };

      const request = '只替换标题，保持参考图尺寸并导出 PNG';
      await runTurn('ImageStudio', cid, undefined, mode === 'ordinary' ? request : `/export-png ${request}`);

      const reply = (await readMessages(TEST_UID, cid)).find(message => message.from === IMAGE_STUDIO_AGENT_ID);
      if (mode === 'ordinary') {
        expect(reply?.produced).toContain(candidate);
        expect(reply?.text).toContain(chatMediaLocalUrl(candidate));
        expect(reply?.failure_code).toBeUndefined();
      } else {
        expect(reply?.produced).not.toContain(candidate);
        expect(reply?.text).not.toContain(chatMediaLocalUrl(candidate));
        expect(reply?.failure_code).toBe('image_studio_native_png_missing');
      }
      expect(reply?.produced).toContain(note);
      expect(fs.readFileSync(candidate, 'utf8')).toBe('edited raster');
    },
  );

  it.each([false, true])('preserves copied reference bytes without exempting changed output, explicit publication=%s', async (publish) => {
    const cid = `cid-reference-copy-${publish}`;
    const attachments = await import('../../../../src/main/features/chat_attachments');
    const source = writeFileAt(path.join(tmpDir, 'input.mp4'), 'reference-video-bytes');
    const imported = await attachments.importAttachmentFromPath(TEST_UID, cid, source);
    if (!imported.ok) throw new Error(imported.error);
    const copy = writeFileAt(path.join(wsRoot, 'renamed.mp4'), 'reference-video-bytes');
    const output = writeFileAt(path.join(wsRoot, 'result.mp4'), 'generated-video-data!');
    expect(fs.statSync(copy).size).toBe(fs.statSync(output).size);
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    hooks.registerProducedOutputHooks({ finalizeFile: file => {
      finalized.push(file);
      fs.appendFileSync(file, '-finalized');
    } });
    inProcessFiles.paths = [copy, output];
    if (publish) inProcessFiles.publish = [copy, output];
    await runTurn(INPROC_AGENT_NAME, cid, [imported.info.name]);
    expect(finalized).toEqual([output]);
    expect(fs.readFileSync(copy, 'utf8')).toBe('reference-video-bytes');
    expect(fs.readFileSync(source, 'utf8')).toBe('reference-video-bytes');
    expect(fs.readFileSync(output, 'utf8')).toBe('generated-video-data!-finalized');
  });

  it('protects a reference reused on a later turn from durable session resources', async () => {
    const cid = 'cid-reference-later';
    const input = writeFileAt(path.join(tmpDir, 'source.mp4'), 'original footage');
    const copy = writeFileAt(path.join(wsRoot, 'later.mp4'), 'original footage');
    const result = writeFileAt(path.join(wsRoot, 'result.mp4'), 'edited footage');
    inProcessFiles.paths = [copy, result];
    inProcessFiles.afterRegistration = async opts => {
      const { getSession } = await import('../../../../src/main/model/core-agent/session-store');
      const session = await getSession(opts.sessionId);
      session.addHistoryResource({ kind: 'attachment', path: input, sourceTurnId: 1 });
    };
    await runTurn(INPROC_AGENT_NAME, cid);
    expect(finalized).toEqual([result]);
    expect(fs.readFileSync(copy, 'utf8')).toBe('original footage');
  });

  it.each(['absent', 'selected', 'empty'] as const)('uses native output citations only when explicit publication is absent: %s', async (declaration) => {
    const paths = await import('../../../../src/main/paths');
    seedAgent(paths.agentDir(TEST_UID, CLI_AGENT_ID), CLI_AGENT_ID, CLI_AGENT_NAME, { kind: 'cli', cli: 'codex' });
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, CLI_AGENT_ID, wsRoot);
    const report = writeFileAt(path.join(wsRoot, 'report.txt'), 'Final report');
    const preview = writeFileAt(path.join(wsRoot, 'preview.txt'), 'Prior preview');
    cliFiles.paths = [report, preview];
    cliFiles.output = 'Ready.\n:codex-file-citation{path="preview.txt" purpose="output"}';
    if (declaration === 'selected') cliFiles.declarations = [[report]];
    if (declaration === 'empty') cliFiles.declarations = [[]];
    await runTurn(CLI_AGENT_NAME, `cid-precedence-${declaration}`);
    expect(finalized).toEqual(declaration === 'absent' ? [preview] : declaration === 'selected' ? [report] : []);
    expect(fs.readFileSync(report, 'utf8')).toBe('Final report');
    expect(fs.readFileSync(preview, 'utf8')).toBe('Prior preview');
  });

  it.each([false, true])('CLI explicit publication replaces its selection, including empty=%s, without opting in unobserved files', async (clear) => {
    const report = writeFileAt(path.join(wsRoot, 'report.txt'), 'report');
    const preview = writeFileAt(path.join(wsRoot, 'preview.txt'), 'preview');
    const foreign = writeFileAt(path.join(wsRoot, 'user-owned.txt'), 'user bytes');
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, CLI_AGENT_ID, wsRoot);
    cliFiles.paths = [report, preview];
    cliFiles.declarations = [[preview], [report, foreign]];
    if (clear) cliFiles.declarations.push([]);
    await runTurn(CLI_AGENT_NAME, `cid-publish-${clear}`);
    expect(finalized).toEqual(clear ? [] : [report]);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('user bytes');
    expect(fs.readFileSync(preview, 'utf8')).toBe('preview');
  });
  it('in-process agent: workspace file is finalized, the user\'s repo file is not', async () => {
    const deliverable = writeFileAt(path.join(wsRoot, 'report.md'), '# Report\n');
    const source = writeFileAt(path.join(tmpDir, 'repo', 'README.md'), '# My project\n');
    inProcessFiles.paths = [deliverable, source];

    await runTurn(INPROC_AGENT_NAME, 'cid-inproc');

    expect(finalized).toContain(deliverable);
    // The twin of the CLI bug: an in-process agent handed an absolute path
    // reaches the user's tree just the same, and the old agent-type guard
    // never covered it.
    expect(finalized).not.toContain(source);
    expect(fs.readFileSync(source, 'utf8')).toBe('# My project\n');
  });

  it('coding CLI agent: the repo it was pointed at is not finalized', async () => {
    const repoDir = path.join(tmpDir, 'repo2');
    const source = writeFileAt(path.join(repoDir, 'prompt_template.md'), 'You are "$agent_name".\n');
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, CLI_AGENT_ID, repoDir);
    cliFiles.paths = [source];

    await runTurn(CLI_AGENT_NAME, 'cid-cli');

    expect(finalized).not.toContain(source);
    expect(fs.readFileSync(source, 'utf8')).toBe('You are "$agent_name".\n');
  });

  it('publishing a version-controlled workspace file does not opt it into stamping', async () => {
    // The reported case: the workspace is the user's own git repo, the agent
    // generates mockups into it, and `publish_outputs` shows them in the
    // bubble. Declaring an output is a presentation choice the model makes on
    // its own; it must not also authorise rewriting a file the user ships.
    const repoRoot = path.join(wsRoot, 'client-site');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    const tracked = writeFileAt(path.join(repoRoot, 'docs', 'login-preview.html'), '<html>login</html>\n');
    const untracked = writeFileAt(path.join(wsRoot, 'standalone-preview.html'), '<html>standalone</html>\n');
    inProcessFiles.paths = [tracked, untracked];
    inProcessFiles.publish = [tracked, untracked];

    await runTurn(INPROC_AGENT_NAME, 'cid-vcs-publish');

    // The control proves publication reached finalization at all, so the
    // assertion below cannot pass by the whole turn producing nothing.
    expect(finalized).toContain(untracked);
    expect(finalized).not.toContain(tracked);
    expect(fs.readFileSync(tracked, 'utf8')).toBe('<html>login</html>\n');
  });

  it('a file the agent only modified is not a produced deliverable', async () => {
    const edited = writeFileAt(path.join(wsRoot, 'notes.html'), '<html>mine</html>\n');
    const created = writeFileAt(path.join(wsRoot, 'summary.html'), '<html>generated</html>\n');
    inProcessFiles.paths = [edited, created];
    inProcessFiles.preExisting = [edited];

    await runTurn(INPROC_AGENT_NAME, 'cid-edit-only');

    expect(finalized).toContain(created);
    expect(finalized).not.toContain(edited);
    expect(fs.readFileSync(edited, 'utf8')).toBe('<html>mine</html>\n');
  });

  it('keeps stamping the attachment dir, which is managed but outside the workspace', async () => {
    const { chatAttachmentDirForConversation } = await import('../../../../src/main/util/project-layout');
    const cid = 'cid-att';
    const attDir = chatAttachmentDirForConversation(TEST_UID, cid);
    const attFile = writeFileAt(path.join(attDir, 'note.md'), '# Note\n');
    // Guards the naive fix: a bare "inside the workspace?" test would exempt
    // this, silently skipping finalization from a real Orkas deliverable.
    expect(attFile.startsWith(wsRoot)).toBe(false);
    inProcessFiles.paths = [attFile];

    await runTurn(INPROC_AGENT_NAME, cid);

    expect(finalized).toContain(attFile);
  });
});
