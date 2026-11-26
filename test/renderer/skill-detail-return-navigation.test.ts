import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const searchSource = fs.readFileSync(path.join(root, 'src/renderer/modules/search.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
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

function loadNavigation(initialView: string, initialId = '') {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const classes = new Set<string>();
      elements.set(id, {
        style: {},
        scrollTop: 0,
        setAttribute: vi.fn(),
        classList: {
          add: (name: string) => { classes.add(name); },
          remove: (name: string) => { classes.delete(name); },
          toggle: (name: string, force?: boolean) => {
            const next = force === undefined ? !classes.has(name) : force;
            if (next) classes.add(name);
            else classes.delete(name);
            return next;
          },
          contains: (name: string) => classes.has(name),
        },
      });
    }
    return elements.get(id)!;
  };
  const setView = vi.fn();
  const selectSkillFile = vi.fn(async (source: string, id: string, filepath: string) => {
    context._selectedSkill = { source, id, filepath };
  });
  const invoke = vi.fn(async (..._args: unknown[]) => ({ discarded: true }));
  const context: any = {
    Object,
    currentView: initialView,
    currentCid: initialView === 'conversation' ? initialId : null,
    _projectDetailPid: initialView === 'project' ? initialId : '',
    _skillDetailReturnTarget: null,
    _skillEditMode: false,
    _skillEditSkillId: null,
    _selectedSkill: null,
    currentUserId: 'account-a',
    _skillDraftCleanups: new Map(),
    _skillDetailOwnerId: null,
    _skillPackageDraftId: null,
    _skillDraftEditedId: null,
    _isSkillPlatformSource: () => false,
    _flushSkillFieldSave: vi.fn(async () => true),
    window: { orkas: { invoke } },
    _skillSource: (source: string) => source,
    _skillChatCtrl: null,
    _updateEditButtonLabel: vi.fn(),
    _closeSkillRowMenu: vi.fn(),
    _dropSkillTreeCache: vi.fn(),
    _ensureSkillsSourceExpanded: vi.fn(async () => {}),
    loadSkills: vi.fn(async () => {}),
    selectSkillFile,
    setView,
    document: {
      getElementById: (id: string) => element(id),
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction(skillsSource, '_onSkillsBack'),
    extractFunction(skillsSource, '_recycleEmptySkillDetailDraft'),
    extractFunction(skillsSource, 'toggleSkillEditMode'),
    extractFunction(skillsSource, '_normalizeSkillDetailReturnTarget'),
    extractFunction(skillsSource, '_captureSkillDetailReturnTarget'),
    extractFunction(skillsSource, '_showSkillsGridView'),
    extractFunction(skillsSource, '_showSkillsDetailView'),
    extractFunction(skillsSource, 'openSkillDetail'),
    extractFunction(skillsSource, '_isSkillDetailReturnTargetCurrent'),
    extractFunction(skillsSource, '_returnFromSkillsDetailView'),
    extractFunction(skillsSource, '_resetSkillsDetailForNavigation'),
  ].join('\n'), context);
  return { context, element, invoke, selectSkillFile, setView };
}

describe('skill detail return navigation', () => {
  it('opens over the conversation and reveals the untouched entry page on Back', async () => {
    const { context, element, selectSkillFile, setView } = loadNavigation('conversation', 'conversation-a');

    await context.openSkillDetail('custom', 'skill-a');

    expect(setView).not.toHaveBeenCalled();
    expect(selectSkillFile).toHaveBeenCalledWith('custom', 'skill-a', 'SKILL.md', null);
    expect(context.currentView).toBe('conversation');
    expect(element('panel-skills').classList.contains('resource-detail-overlay')).toBe(true);
    expect(element('skills-detail-view').style.display).toBe('flex');

    context._returnFromSkillsDetailView();

    expect(setView).not.toHaveBeenCalled();
    expect(context.currentView).toBe('conversation');
    expect(element('panel-skills').classList.contains('resource-detail-overlay')).toBe(false);
    expect(element('skills-grid-view').style.display).toBe('flex');
    expect(element('skills-detail-view').style.display).toBe('none');
  });

  it('keeps the native Skills card flow inside the Skills tab', async () => {
    const { context, element, setView } = loadNavigation('skills');

    await context.openSkillDetail('custom', 'skill-a');
    context._returnFromSkillsDetailView();

    expect(setView).not.toHaveBeenCalled();
    expect(element('panel-skills').classList.contains('resource-detail-overlay')).toBe(false);
    expect(element('skills-grid-view').style.display).toBe('flex');
  });

  it.each(['back', 'navigation', 'another skill'])('requests cleanup of the exact old detail when leaving by %s', async (route) => {
    const { context, invoke } = loadNavigation('skills');
    await context.openSkillDetail('custom', 'old-import');
    if (route === 'back') context._onSkillsBack();
    else if (route === 'navigation') context._resetSkillsDetailForNavigation();
    else await context.openSkillDetail('custom', 'other-skill');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('skills.discardImportDraft', {
      id: 'old-import', ownerId: 'account-a',
    });
  });

  it('returns to the list on Done when the host recycled the placeholder', async () => {
    const { context, invoke, element } = loadNavigation('skills');
    await context.openSkillDetail('custom', 'old-import');
    context._skillEditMode = true;
    context._skillEditSkillId = 'old-import';
    await context.toggleSkillEditMode();
    expect(context._flushSkillFieldSave).toHaveBeenCalledWith({ validate: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('skills.discardImportDraft', {
      id: 'old-import', ownerId: 'account-a',
    });
    await vi.waitFor(() => expect(element('skills-grid-view').style.display).toBe('flex'));
  });

  it('leaves a locally edited draft alone even while autosave is pending', async () => {
    const { context, invoke } = loadNavigation('skills');
    await context.openSkillDetail('custom', 'changed');
    context._skillDraftEditedId = 'changed';
    context._onSkillsBack();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('finishes the edit without waiting for recycling and keeps a removed draft from reopening', async () => {
    const { context, selectSkillFile, invoke } = loadNavigation('skills');
    let finishCleanup!: () => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => {
      finishCleanup = () => resolve({ discarded: true });
    }));
    await context.openSkillDetail('custom', 'pending-import');
    context._skillEditMode = true;
    context._skillEditSkillId = 'pending-import';
    await context.toggleSkillEditMode();
    expect(context._skillEditMode).toBe(false);
    const renderCount = selectSkillFile.mock.calls.length;
    const reopen = context.openSkillDetail('custom', 'pending-import');
    finishCleanup();
    await reopen;
    expect(selectSkillFile).toHaveBeenCalledTimes(renderCount);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retains the original draft identity when leaving a package result after switching accounts', async () => {
    const { context, invoke } = loadNavigation('skills');
    await context.openSkillDetail('custom', 'package-draft');
    context._skillPackageDraftId = 'package-draft';
    context._selectedSkill = null;
    context.currentUserId = 'account-b';
    context._onSkillsBack();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('skills.discardImportDraft', {
      id: 'package-draft', ownerId: 'account-a',
    });
  });

  it('routes cross-page skill entries through the overlay helper and resets on navigation', () => {
    expect(searchSource).not.toContain("setView('skills');\n    const loader");
    expect(searchSource).toContain('await openSkillDetail(cached.source, cached.id)');
    expect(conversationSource).toContain("openSkillDetail('custom', sid)");
    expect(bootSource).toContain("_resetSkillsDetailForNavigation === 'function'");
    expect(styleSource).toContain('.panel.resource-detail-overlay');
  });
});
