import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool } from '#core-agent';

/**
 * Guard for B4 (parallel-safety audit): a tool may set `executionMode:'parallel'`
 * ONLY if running several of it concurrently in one tool-use batch is safe — no
 * shared mutable state, no ordering dependence, no concurrency-unsafe resource.
 * For these read-tool factories that means side-effect-free reads.
 *
 * `library` IS in the set: its search action embeds on the shared ONNX embedder
 * singleton, but concurrent calls are safe (verified by reading fastembed@2.1.0:
 * embed() keeps state local + already calls the tokenizer concurrently within a
 * batch; onnxruntime run() is concurrency-safe on a shared session). The
 * CLAUDE.md ONNX rule is about multiple SESSIONS, not concurrent run() on one.
 *
 * Until G4's executionMode bug was fixed (wrapToolWithCap dropped the flag), these
 * never actually ran concurrently; now they do, so this allowlist is load-bearing.
 * If you add/remove a parallel mark, update PARALLEL_ALLOWLIST AND justify the
 * concurrency safety in review. The bar is the same for all: write/edit/delete/
 * bash/pdf/generate/connector-call tools MUST stay sequential.
 *
 * Not built here (reviewed separately): run_worker / dispatch_to are
 * parallel-but-side-effectful, safe by construction (distinct sessions +
 * dispatchSlots cap + lock-serialized member-seed/jsonl-append) — asserted in
 * bus-integration; web_fetch / web_search are core-agent builtins.
 */

const UID = '12345678';
const CID = 'c0a1b2c3d4e5';

// The reviewed set of read tools safe to run concurrently. library is included
// (concurrent embed on the shared ONNX session is safe — see header).
const PARALLEL_ALLOWLIST = [
  'chat_history',
  'grep_files', 'library', 'list_files', 'read_files', 'search_files',
].sort();

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-parallel-safety-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parallel-safety: executionMode:parallel ⊆ reviewed side-effect-free tools', () => {
  async function buildReadTools(): Promise<AgentTool[]> {
    const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
    const { createChatHistoryTool } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const { createLibraryTool } = await import('../../../../src/main/model/core-agent/kb-tools');
    return [
      ...createFileTools({ userId: UID, cid: CID }),
      createChatHistoryTool({ userId: UID }),
      createLibraryTool({ userId: UID }),
    ];
  }

  it('the PC read-tool factories mark EXACTLY the reviewed safe set parallel', async () => {
    const tools = await buildReadTools();
    const parallel = tools
      .filter((t) => t.executionMode === 'parallel')
      .map((t) => t.name)
      .sort();
    // Exact match: a new parallel mark on a write/side-effectful tool, or
    // re-marking library, fails here and forces a safety review.
    expect(parallel).toEqual(PARALLEL_ALLOWLIST);
  });

  it('library is parallel (concurrent search embeds on the shared ONNX session are safe)', async () => {
    const tools = await buildReadTools();
    const library = tools.find((t) => t.name === 'library');
    expect(library, 'library should be registered').toBeTruthy();
    expect(library!.executionMode).toBe('parallel');
  });

  it('every write / side-effectful read-factory tool is NOT parallel', async () => {
    const tools = await buildReadTools();
    // Anything not in the allowlist must be sequential (default).
    const offenders = tools
      .filter((t) => t.executionMode === 'parallel' && !PARALLEL_ALLOWLIST.includes(t.name))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});
