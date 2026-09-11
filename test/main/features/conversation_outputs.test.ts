// What the conversation info panel is allowed to claim the conversation produced.
//
// The user goal is "find the thing this conversation made and open it again".
// Three ways that used to fail:
//
//   - a `create_artifact` app existed only inside the bubble that made it,
//     because its bundle lives outside the workspace and no listing saw it;
//   - a file written outside the workspace arrived with no relative path and
//     was hung off the workspace tree root, reading as a workspace file;
//   - a produced file the model later deleted kept a row that opened nothing.
//
// The merge is the single place those are decided now, so it is tested against
// a controlled filesystem rather than through the panel.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_HISTORY_OUTPUTS,
  mergeConversationOutputs,
} from '../../../src/main/features/conversation_outputs';
import type { ConversationWorkspaceFileList } from '../../../src/main/features/conversation_files';
import { listArtifacts } from '../../../src/main/features/chat_artifacts';
import { artifactDirForConversation } from '../../../src/main/util/project-layout';

const ROOT = path.resolve(path.join(os.tmpdir(), 'orkas-outputs-root'));

function workspaceFile(relPath: string, bytes = 10, mtime = 1000) {
  return {
    path: path.join(ROOT, ...relPath.split('/')),
    relPath,
    name: relPath.split('/').pop() as string,
    bytes,
    mtime,
  };
}

function workspace(
  items: ReturnType<typeof workspaceFile>[],
  overrides: Partial<ConversationWorkspaceFileList> = {},
): ConversationWorkspaceFileList {
  return {
    root: ROOT,
    items,
    count: items.length,
    truncated: false,
    rootExists: true,
    ...overrides,
  };
}

/** Every path exists unless the case says otherwise. */
const allPresent = () => ({ bytes: 5, mtime: 2000 });

describe('conversation output merge', () => {
  it('lists an interactive app the workspace scan can never reach', () => {
    const result = mergeConversationOutputs({
      workspace: workspace([]),
      artifacts: [{
        artifactId: 'a_1234',
        title: 'Pricing calculator',
        agentId: 'commander',
        createdAt: '2026-08-25T00:00:00.000Z',
        bytes: 4096,
        mtime: 9000,
      }],
      producedPaths: [],
      statProducedFile: allPresent,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      origin: 'artifact',
      artifactId: 'a_1234',
      name: 'Pricing calculator',
      relPath: '',
      // Without the producing actor an interaction opened from the panel would
      // have nowhere to send its result.
      agentId: 'commander',
    });
    // No `path`: an artifact is a directory bundle, and handing the panel one
    // would send it to the file viewer instead of the `chat-app://` frame.
    expect(result.items[0].path).toBeUndefined();
  });

  it('separates a file written outside the workspace instead of faking a tree position', () => {
    const outside = path.resolve(path.join(os.tmpdir(), 'somewhere-else', 'TARGETS.md'));

    const result = mergeConversationOutputs({
      workspace: workspace([workspaceFile('notes/plan.md')]),
      artifacts: [],
      producedPaths: [outside],
      statProducedFile: allPresent,
    });

    const inside = result.items.find((item) => item.name === 'plan.md');
    const stray = result.items.find((item) => item.name === 'TARGETS.md');
    expect(inside).toMatchObject({ origin: 'workspace', relPath: 'notes/plan.md' });
    expect(stray).toMatchObject({ origin: 'outside', relPath: '', path: outside });
  });

  it('drops a produced file that no longer exists', () => {
    const gone = path.join(ROOT, 'deleted.md');

    const result = mergeConversationOutputs({
      workspace: workspace([]),
      artifacts: [],
      producedPaths: [gone],
      statProducedFile: (p) => (p === gone ? null : allPresent()),
    });

    expect(result.items).toEqual([]);
  });

  it('does not repeat a produced file the scan already returned', () => {
    const file = workspaceFile('report.md');

    const result = mergeConversationOutputs({
      workspace: workspace([file]),
      artifacts: [],
      producedPaths: [file.path, file.path],
      statProducedFile: allPresent,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ origin: 'workspace', relPath: 'report.md' });
  });

  it('recovers a workspace file the scan skipped, with its tree position', () => {
    // `listWorkspaceFiles` skips dot-prefixed entries, so this file exists in
    // the workspace but never appears in the scan. History is the only record.
    const hidden = path.join(ROOT, '.env.local');

    const result = mergeConversationOutputs({
      workspace: workspace([]),
      artifacts: [],
      producedPaths: [hidden],
      statProducedFile: allPresent,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      origin: 'workspace',
      relPath: '.env.local',
      path: hidden,
    });
  });

  it('reports truncation rather than silently dropping a long history', () => {
    const many = Array.from(
      { length: MAX_HISTORY_OUTPUTS + 5 },
      (_unused, index) => path.join(ROOT, 'out', `f${index}.md`),
    );

    const result = mergeConversationOutputs({
      workspace: workspace([]),
      artifacts: [],
      producedPaths: many,
      statProducedFile: allPresent,
    });

    expect(result.items).toHaveLength(MAX_HISTORY_OUTPUTS);
    expect(result.truncated).toBe(true);
  });

  it('keeps a truncated scan truncated', () => {
    const result = mergeConversationOutputs({
      workspace: workspace([workspaceFile('a.md')], { truncated: true }),
      artifacts: [],
      producedPaths: [],
      statProducedFile: allPresent,
    });

    expect(result.truncated).toBe(true);
  });
});

describe('artifact pool listing', () => {
  const uid = 'u_outputs_test';
  const cid = 'c_outputs_test';

  function writeBundle(artifactId: string, files: Record<string, string>): string {
    const dir = artifactDirForConversation(uid, cid, artifactId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  it('lists servable bundles and skips one with no entry point', () => {
    writeBundle('a_complete', {
      'index.html': '<!doctype html><title>Done</title>',
      '__orkas-meta.json': JSON.stringify({
        title: 'Budget sheet',
        agentId: 'commander',
        createdAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    // No index.html: `chat-app://` could not serve this either, so listing it
    // would offer the user a row that opens nothing.
    writeBundle('a_partial', { 'app.js': 'console.log(1)' });

    const listed = listArtifacts(uid, cid);

    expect(listed.map((a) => a.artifactId)).toEqual(['a_complete']);
    expect(listed[0]).toMatchObject({ title: 'Budget sheet', agentId: 'commander' });
    expect(listed[0].bytes).toBeGreaterThan(0);
  });

  it('returns nothing for a conversation that never made one', () => {
    expect(listArtifacts(uid, 'c_no_artifacts_here')).toEqual([]);
  });
});
