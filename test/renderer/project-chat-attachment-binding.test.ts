import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const projectDetailSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = projectDetailSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = projectDetailSource.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < projectDetailSource.length; i += 1) {
    if (projectDetailSource[i] === '{') depth += 1;
    else if (projectDetailSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return projectDetailSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('project chat attachment button', () => {
  it('opens the conversation attachment picker for the active project draft', () => {
    let clickHandler: ((event: { stopPropagation: () => void }) => void) | undefined;
    const pickAndUpload = vi.fn();
    const uploadToLibrary = vi.fn();
    const attachButton = {
      addEventListener: vi.fn((event: string, handler: typeof clickHandler) => {
        if (event === 'click') clickHandler = handler;
      }),
    };
    const context = {
      document: {
        getElementById: (id: string) => id === 'project-chat-attach-btn' ? attachButton : null,
        addEventListener: vi.fn(),
      },
      window: { addEventListener: vi.fn() },
      _projectDetailPid: 'project-42',
      _projectDetailMeta: null,
      _projectChatDraftCid: (projectId: string) => `projchat-${projectId}`,
      _chatAttachPickAndUpload: pickAndUpload,
      _uploadProjectFilesNative: uploadToLibrary,
      _bindProjectLibraryDetailDrop: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_initProjectDetailBindings'), context);
    (context as typeof context & { _initProjectDetailBindings: () => void })
      ._initProjectDetailBindings();

    expect(clickHandler).toBeTypeOf('function');
    clickHandler!({ stopPropagation: vi.fn() });

    expect(pickAndUpload).toHaveBeenCalledWith('projchat-project-42', 'picker');
    expect(uploadToLibrary).not.toHaveBeenCalled();
  });
});
