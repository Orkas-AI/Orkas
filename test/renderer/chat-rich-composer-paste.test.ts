import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadPasteRouter(projectId = '') {
  const uploads: Array<{ cid: string; files: unknown; source: string }> = [];
  const autoUploads: Array<{ files: unknown; source: string }> = [];
  const context: any = {
    DRAFT_CID: 'main_chat',
    currentCid: 'conversation-1',
    _projectDetailPid: projectId,
    _projectChatDraftCid: (pid: string) => `projchat-${pid}`,
    _chatAttachUpload: (cid: string, files: unknown, uploadSource: string) => {
      uploads.push({ cid, files, source: uploadSource });
    },
    window: {
      _autoUploadFilesFromComposer: (files: unknown, uploadSource: string) => {
        autoUploads.push({ files, source: uploadSource });
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('_chatRichUploadPasteFiles'), context);
  return {
    route: context._chatRichUploadPasteFiles as (inputId: string, files: unknown[]) => boolean,
    uploads,
    autoUploads,
  };
}

describe('chat rich composer attachment paste routing', () => {
  it('uploads one pasted file once when EditorView already owns the rich composer', () => {
    const input = Object.assign(new EventTarget(), { dataset: {}, matches: () => true });
    const uploads: unknown[] = [];
    const files = [{ name: 'clipboard.png' }];
    input.addEventListener('paste', event => {
      event.preventDefault();
      uploads.push(['conversation-1', files, 'paste']);
    });
    const context: any = {
      document: { querySelector: () => input },
      _chatAttachUpload: (...args: unknown[]) => uploads.push(args),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_bindChatPasteAttach'), context);
    context._bindChatPasteAttach('#chat-input', () => 'conversation-1');
    const event = new Event('paste', { cancelable: true });
    Object.assign(event, { clipboardData: { files } });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(uploads).toEqual([['conversation-1', files, 'paste']]);
  });

  it('keeps native textareas pasting files once and leaves plain text to the browser', () => {
    const input = Object.assign(new EventTarget(), { dataset: {}, matches: () => false });
    const uploads: unknown[] = [];
    const context: any = {
      document: { querySelector: () => input },
      _chatAttachUpload: (...args: unknown[]) => uploads.push(args),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_bindChatPasteAttach'), context);
    context._bindChatPasteAttach('#native-input', () => 'conversation-1');
    context._bindChatPasteAttach('#native-input', () => 'conversation-1');

    const paste = (files: unknown[]) => {
      const event = new Event('paste', { cancelable: true });
      Object.assign(event, { clipboardData: { files } });
      input.dispatchEvent(event);
      return event;
    };
    expect(paste([]).defaultPrevented).toBe(false);
    expect(uploads).toEqual([]);
    const files = [{ name: 'clipboard.png' }];
    expect(paste(files).defaultPrevented).toBe(true);
    expect(uploads).toEqual([['conversation-1', files, 'paste']]);
  });

  it('handles a project image paste through the active project draft attachment pool', () => {
    const router = loadPasteRouter('project-42');
    const files = [{ name: 'clipboard.png', type: 'image/png' }];

    expect(router.route('project-chat-input', files)).toBe(true);
    expect(router.uploads).toEqual([
      { cid: 'projchat-project-42', files, source: 'paste' },
    ]);
  });

  it('does not claim a project paste when there is no active project destination', () => {
    const router = loadPasteRouter();

    expect(router.route('project-chat-input', [{ name: 'clipboard.png' }])).toBe(false);
    expect(router.uploads).toEqual([]);
  });

  it('preserves the existing destinations for the other rich composers', () => {
    const router = loadPasteRouter('project-42');
    const files = [{ name: 'notes.txt' }];

    expect(router.route('new-chat-input', files)).toBe(true);
    expect(router.route('chat-input', files)).toBe(true);
    expect(router.route('auto-task-input', files)).toBe(true);
    expect(router.uploads.map((item) => item.cid)).toEqual(['main_chat', 'conversation-1']);
    expect(router.autoUploads).toEqual([{ files, source: 'paste' }]);
  });
});
