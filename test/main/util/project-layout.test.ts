import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../src/main/paths';
import {
  conversationLayout,
  findProjectIdForConversation,
  projectIdForConversationHint,
} from '../../../src/main/util/project-layout';

const createdUsers: string[] = [];

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seedProject(uid: string, pid: string, rows: unknown[]): void {
  writeJson(paths.projectMetaFile(uid, pid), {
    project_id: pid,
    name: 'Project',
  });
  writeJson(paths.projectChatIndexFile(uid, pid), rows);
}

afterEach(() => {
  vi.useRealTimers();
  for (const uid of createdUsers.splice(0)) {
    fs.rmSync(paths.userRoot(uid), { recursive: true, force: true });
  }
});

describe('project layout conversation ownership', () => {
  it('treats an explicit null hint as global without falling back to project indexes', () => {
    const uid = 'layout-explicit-global';
    const cid = 'abcdef123456';
    const pid = '123456abcdef';
    createdUsers.push(uid);
    seedProject(uid, pid, [{ conversation_id: cid, project_id: pid }]);

    expect(projectIdForConversationHint(uid, cid, null)).toBeNull();
    expect(conversationLayout(uid, cid, null).messageFile)
      .toBe(path.join(paths.userChatsDir(uid), `${cid}.jsonl`));
  });

  it('resolves and caches the common global root before a duplicate project row', () => {
    const uid = 'layout-global-first';
    const cid = 'fedcba654321';
    const pid = '654321fedcba';
    createdUsers.push(uid);
    writeJson(path.join(paths.userChatsDir(uid), '_index.json'), [{ conversation_id: cid }]);
    seedProject(uid, pid, [{ conversation_id: cid, project_id: pid }]);

    expect(findProjectIdForConversation(uid, cid)).toBeNull();

    // Removing the source row after the first lookup proves that `null` is a
    // real cache entry rather than a miss that reopens all project indexes.
    writeJson(path.join(paths.userChatsDir(uid), '_index.json'), []);
    expect(findProjectIdForConversation(uid, cid)).toBeNull();
  });

  it('revalidates a negative cache entry after a project is created', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    const uid = 'layout-negative-ttl';
    const cid = 'a1b2c3d4e5f6';
    const pid = 'f6e5d4c3b2a1';
    createdUsers.push(uid);
    const globalIndex = path.join(paths.userChatsDir(uid), '_index.json');
    writeJson(globalIndex, [{ conversation_id: cid, project_id: pid }]);

    expect(findProjectIdForConversation(uid, cid)).toBeNull();
    seedProject(uid, pid, [{ conversation_id: cid, project_id: pid }]);
    expect(findProjectIdForConversation(uid, cid)).toBeNull();

    vi.advanceTimersByTime(2_001);
    expect(findProjectIdForConversation(uid, cid)).toBe(pid);
  });
});
