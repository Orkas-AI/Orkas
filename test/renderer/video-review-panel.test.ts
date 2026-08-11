// How the VideoStudio review drawer reads production state.
//
// The drawer's whole job is telling a user where their video got to and what
// it needs from them. Most claims are derived from four state facts and are
// asserted against the view model directly. One narrow fake-DOM harness below
// verifies that a media path the view model marks as awaiting review actually
// becomes a playable element; pure state assertions cannot prove that part.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const panelSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/video-review-panel.js'),
  'utf8',
);

class PanelTestElement {
  readonly tagName: string;
  children: PanelTestElement[] = [];
  className = '';
  textContent = '';
  hidden = false;
  src = '';
  private html = '';
  private readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    toggle: (name: string, force?: boolean) => {
      const enabled = force === undefined ? !this.classes.has(name) : force;
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
      return enabled;
    },
  };

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  appendChild(child: PanelTestElement): PanelTestElement {
    this.children.push(child);
    return child;
  }

  addEventListener(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  set innerHTML(value: string) {
    this.html = value;
    if (!value) this.children = [];
  }

  get innerHTML(): string {
    return this.html;
  }

  descendants(tagName: string): PanelTestElement[] {
    const wanted = tagName.toLowerCase();
    return this.children.flatMap((child) => [
      ...(child.tagName === wanted ? [child] : []),
      ...child.descendants(wanted),
    ]);
  }
}

async function renderPanelVideos(composition: Record<string, unknown>): Promise<PanelTestElement[]> {
  const elements = new Map<string, PanelTestElement>([
    ['video-review-panel-body', new PanelTestElement('div')],
    ['video-review-panel', new PanelTestElement('aside')],
    ['video-review-toggle', new PanelTestElement('button')],
  ]);
  const sandbox: Record<string, any> = {
    console,
    document: {
      readyState: 'complete',
      createElement: (tag: string) => new PanelTestElement(tag),
      getElementById: (id: string) => elements.get(id) || null,
    },
    orkas: {
      invoke: async () => ({ ok: true, panel: { compositions: [composition] } }),
    },
    createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    addEventListener() {},
    getLang: () => 'en',
    t: (key: string) => key,
    uiIconHtml: () => '',
    openChatFileViewer() {},
    Event: class {},
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(panelSource, context, { filename: 'video-review-panel.js' });
  await context.VideoReviewPanel.open('cid-video-review');
  return elements.get('video-review-panel-body')!.descendants('video');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const viewModel = require('../../src/renderer/modules/video-review-panel.js') as {
  compositionSteps: (comp: unknown) => { id: string; state: string }[];
  compositionPill: (
    steps: { id: string; state: string }[],
  ) => { tone: string; step: string; state: string } | null;
  pendingCount: (compositions: unknown[]) => number;
  compositionKey: (comp: unknown) => string;
  acceptsPanelResponse: (activeCid: string, requestedCid: string) => boolean;
  compositionTitle: (comp: unknown) => string;
  productionRef: (comp: unknown, all?: unknown[]) => string;
  mergeComposerInstruction: (input: {
    current?: string;
    full?: string;
    short?: string;
    production?: string;
  }) => { value: string; selectionStart: number };
};

const {
  compositionSteps,
  compositionPill,
  pendingCount,
  compositionKey,
  acceptsPanelResponse,
  compositionTitle,
  productionRef,
  mergeComposerInstruction,
} = viewModel;

function states(comp: unknown): Record<string, string> {
  return Object.fromEntries(compositionSteps(comp).map((step) => [step.id, step.state]));
}

describe('video review panel › production steps', () => {
  it('holds the keyframe preview waiting until assembly evidences the go-ahead', () => {
    // The run stops on the complete frame set before assembly (2026-08-06):
    // frames present with no draft yet means the user has the floor. The
    // go-ahead reply lives in chat, so the panel reads its consequence — any
    // draft — as passage.
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
    })).toEqual({ plan: 'done', preview: 'wait', narration: 'done', draft: 'todo' });
  });

  it('reads partial assembled capture as progress, not a question', () => {
    // The aggregate preview appears with the FIRST captured segment, but the
    // preview stop happens on the complete set — a drawer opened mid-capture
    // must not claim the run is waiting while the agent is still working.
    const half = {
      plan_approved: true,
      preview: { status: 'ready' },
      segments: [
        { segment_id: 's1', kind: 'composition', preview: { status: 'ready' } },
        { segment_id: 's2', kind: 'composition' },
      ],
    };
    expect(states(half)).toEqual({ plan: 'done', preview: 'todo', narration: 'todo', draft: 'todo' });
    // Same production, capture complete: now it genuinely waits. A media
    // segment has no frames to hold the stop open.
    expect(states({
      ...half,
      segments: [
        { segment_id: 's1', kind: 'composition', preview: { status: 'ready' } },
        { segment_id: 's2', kind: 'composition', preview: { status: 'ready' } },
        { segment_id: 's3', kind: 'media' },
      ],
    })).toEqual({ plan: 'done', preview: 'wait', narration: 'todo', draft: 'todo' });
  });

  it('shows a half-produced assembled narration as its own progress, never as done or nothing', () => {
    // Assembled narration is per line: the parent produces one file per planned
    // line, so an interrupted assembly has real audio and an unfinished step.
    // 'done' would say the voiceover is complete over a video that goes silent
    // partway; 'todo' renders as "not started" over produced, paid audio —
    // the original defect, which this surface re-created once (2026-08-08) by
    // mapping partial onto todo. Partial is its own state and carries counts.
    const assembled = {
      plan_approved: true,
      preview: { status: 'ready' },
      segments: [{ segment_id: 's1', kind: 'composition', preview: { status: 'ready' } }],
    };
    const partial = compositionSteps({
      ...assembled,
      narration: { status: 'partial', produced_lines: 2, planned_lines: 5, duration_sec: 3.5 },
    }).find((step) => step.id === 'narration');
    expect(partial).toMatchObject({ state: 'partial', detail: { n: 2, m: 5 } });
    // Counts are what the partial state renders; a record without them (older
    // main process) falls back to the pre-partial reading instead of showing
    // an empty "{n}/{m}" chip.
    expect(states({ ...assembled, narration: { status: 'partial', duration_sec: 3.5 } }).narration)
      .toBe('todo');
    expect(states({ ...assembled, narration: { status: 'materialized', duration_sec: 8 } }).narration)
      .toBe('done');
    // A production waiting on its preview still has exactly one asking step:
    // partial narration is progress, not a second question.
    const strip = compositionSteps({
      ...assembled,
      narration: { status: 'partial', produced_lines: 2, planned_lines: 5 },
    });
    expect(strip.filter((step) => step.state === 'wait')).toHaveLength(1);
  });

  it('still reads a legacy approved preview entry as done', () => {
    // State files written before the approval layer was removed carry
    // status:'approved'; they must not regress to another reading.
    expect(states({
      plan_approved: true,
      preview: { status: 'approved' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'ready' },
    })).toEqual({ plan: 'done', preview: 'done', narration: 'done', draft: 'wait' });
  });

  it('keeps the standalone final cut waiting until its confirmation is recorded', () => {
    // composition.approve_draft still exists for a standalone composition, so
    // "final video confirmation pending" is the one visible decision left
    // after the plan.
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'ready' },
    })).toEqual({ plan: 'done', preview: 'done', narration: 'done', draft: 'wait' });
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'approved' },
    })).toEqual({ plan: 'done', preview: 'done', narration: 'done', draft: 'done' });
  });

  it('reads an assembled production draft as evidence, not a pending decision', () => {
    // An assembled production confirms its finished video in chat; no record
    // reaches this panel. Its assembled draft is progress, and holding it at
    // "waiting for you" forever would be a question nobody asked.
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'ready' },
      segments: [{ segment_id: 's1' }],
    })).toEqual({ plan: 'done', preview: 'done', narration: 'done', draft: 'done' });
  });

  it('asks for the plan first and leaves later decisions not started', () => {
    // Several real decisions may be reachable at once; only the earliest may
    // read as waiting, so the user always knows which answer unblocks the run.
    expect(states({
      plan_approved: false,
      preview: { status: 'ready' },
    })).toEqual({ plan: 'wait', preview: 'todo', narration: 'todo', draft: 'todo' });
    // A draft on disk proves the preview was passed at some point, so that
    // step reports done even while the plan reading says unapproved — the
    // panel reports evidence, it does not re-litigate history.
    expect(states({
      plan_approved: false,
      preview: { status: 'ready' },
      draft: { status: 'ready' },
    })).toEqual({ plan: 'wait', preview: 'done', narration: 'todo', draft: 'todo' });
  });

  it('reads a production with nothing recorded yet', () => {
    expect(states({})).toEqual({ plan: 'wait', preview: 'todo', narration: 'todo', draft: 'todo' });
  });

  it('never reads candidate-tier evidence as progress', () => {
    // Frames and renders recorded by a QA-blocked op are shown in the drawer,
    // but capture never passed: the preview stop is not waiting, and a
    // blocked render is not a draft. Claiming either would tell the user the
    // run got further than it did (the 2026-08-06 shape).
    expect(states({
      plan_approved: true,
      preview: { status: 'candidate' },
      draft: { status: 'qa_blocked' },
    })).toEqual({ plan: 'done', preview: 'todo', narration: 'todo', draft: 'todo' });
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      segments: [
        { segment_id: 's1', kind: 'composition', preview: { status: 'candidate' } },
        { segment_id: 's2', kind: 'composition', preview: { status: 'ready' } },
      ],
    })).toEqual({ plan: 'done', preview: 'todo', narration: 'todo', draft: 'todo' });
  });

  it('reads a recorded delivered final as passage and delivery evidence', () => {
    // Assembly writes no per-segment gate state, so the plan's runtime final
    // record is what proves the video went out — and going out implies the
    // preview stop was passed.
    expect(states({
      plan_approved: true,
      preview: { status: 'ready' },
      draft: { status: 'ready' },
      final: { path: '/render/video.mp4' },
      segments: [{ segment_id: 's1', kind: 'composition', preview: { status: 'ready' } }],
    })).toEqual({ plan: 'done', preview: 'done', narration: 'todo', draft: 'done' });
  });
});

describe('video review panel › rendered media', () => {
  it('renders the standalone draft that is waiting for final confirmation', async () => {
    const base = {
      state_key: 'standalone-review',
      composition_dir: '/project/composition',
      display_name: 'project/composition',
      stage: 'draft_ready',
      updated_at_ms: 0,
      plan_approved: true,
      preview: { status: 'ready', frame_paths: [] },
      scenes: [],
    };

    // Positive control for the renderer harness: the existing assembled-final
    // branch already exposes a playable video.
    const finalVideos = await renderPanelVideos({
      ...base,
      final: { path: '/project/render/final.mp4' },
    });
    expect(finalVideos.map((video) => video.src)).toContain(
      'chat-media://local/project/render/final.mp4',
    );

    // A standalone final-confirmation stop carries the playable artifact in
    // draft.path rather than final.path. The user must be able to inspect that
    // exact artifact from the review surface that says it is waiting on them.
    const draftVideos = await renderPanelVideos({
      ...base,
      draft: { status: 'ready', path: '/project/render/draft.mp4' },
    });
    expect(draftVideos.map((video) => video.src)).toContain(
      'chat-media://local/project/render/draft.mp4',
    );
  });
});

describe('video review panel › collapsed status', () => {
  it('shows the decision the production needs over what it finished', () => {
    expect(compositionPill(compositionSteps({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'ready' },
    }))).toEqual({ tone: 'wait', step: 'draft', kind: 'decision', state: 'wait' });
  });

  it('surfaces the keyframe preview stop and labels evidence as generated', () => {
    // The pill carries the step kind so the label layer can say 已生成 for
    // work the host produced and reserve 已确认/待确认 for decisions.
    expect(compositionPill(compositionSteps({
      plan_approved: true,
      preview: { status: 'ready' },
    }))).toEqual({ tone: 'wait', step: 'preview', kind: 'decision', state: 'wait' });
    expect(compositionPill(compositionSteps({
      plan_approved: true,
      narration: { audio_path: '/a.mp3' },
    }))).toEqual({ tone: 'ok', step: 'narration', kind: 'evidence', state: 'done' });
    expect(compositionPill(compositionSteps({
      plan_approved: true,
      preview: { status: 'ready' },
      narration: { audio_path: '/a.mp3' },
      draft: { status: 'approved' },
    }))).toEqual({ tone: 'ok', step: 'draft', kind: 'decision', state: 'done' });
  });

  it('has nothing to show when no step is done or waiting', () => {
    expect(compositionPill([
      { id: 'plan', kind: 'decision', state: 'todo' },
      { id: 'preview', kind: 'decision', state: 'todo' },
    ])).toBeNull();
  });

  it('counts only the productions with a real decision pending', () => {
    expect(pendingCount([
      // Frames present, standalone final cut unconfirmed: waiting.
      { plan_approved: true, preview: { status: 'ready' }, draft: { status: 'ready' } },
      // Plan unapproved: waiting.
      { plan_approved: false },
      // Complete frames, no draft: the keyframe preview stop is waiting.
      { plan_approved: true, preview: { status: 'ready' } },
      // Capture still in progress on an assembled production: not waiting —
      // counting mid-capture progress would nag while the agent works.
      {
        plan_approved: true,
        preview: { status: 'ready' },
        segments: [
          { segment_id: 's1', kind: 'composition', preview: { status: 'ready' } },
          { segment_id: 's2', kind: 'composition' },
        ],
      },
      // Assembled draft present: preview passed, nothing waiting.
      { plan_approved: true, draft: { status: 'ready' }, segments: [{ segment_id: 's1' }] },
    ])).toBe(3);
    expect(pendingCount([])).toBe(0);
  });
});

describe('video review panel › title', () => {
  it('uses the recorded task title, trimmed', () => {
    expect(compositionTitle({
      task_title: '  做一条 60 秒的 Orkas 产品宣传片 ',
      display_name: 'videos/orkas-launch/project/composition',
    })).toBe('做一条 60 秒的 Orkas 产品宣传片');
  });

  it('falls back to the video directory, not the composition path', () => {
    expect(compositionTitle({ display_name: 'videos/orkas-launch/project/composition' }))
      .toBe('orkas-launch');
    expect(compositionTitle({ display_name: 'pricing-explainer/project/render' }))
      .toBe('pricing-explainer');
  });

  it('keeps the display name when every segment is scaffolding', () => {
    // The workspace root is itself the video directory here, so there is no
    // better name available; showing the path beats showing nothing.
    expect(compositionTitle({ display_name: 'project/composition' })).toBe('project/composition');
    expect(compositionTitle({ display_name: '' })).toBe('');
  });
});

describe('video review panel › identity', () => {
  it('keys a production by its state key so expansion survives a refresh', () => {
    expect(compositionKey({ state_key: 'abc', composition_dir: '/x', display_name: 'y' })).toBe('abc');
  });

  it('falls back to the composition directory, then the display name', () => {
    expect(compositionKey({ composition_dir: '/x', display_name: 'y' })).toBe('/x');
    expect(compositionKey({ display_name: 'y' })).toBe('y');
    expect(compositionKey({})).toBe('');
  });
});

describe('video review panel › async conversation ownership', () => {
  it('rejects a late response after navigation switches conversations', () => {
    expect(acceptsPanelResponse('conversation-b', 'conversation-a')).toBe(false);
  });

  it('accepts only a response for the still-active conversation', () => {
    expect(acceptsPanelResponse('conversation-a', 'conversation-a')).toBe(true);
    expect(acceptsPanelResponse('', 'conversation-a')).toBe(false);
    expect(acceptsPanelResponse('conversation-a', '')).toBe(false);
  });
});

// The panel prefills the composer instead of submitting, so reviewing several
// scenes means several clicks before one message is sent. Overwriting on each
// click made every earlier click — and anything the user typed after it —
// disappear, which capped the panel at one change per message. These cases pin
// the accumulation rules that replaced it.
describe('video review panel › composer instructions', () => {
  const VISUAL_S3 = { full: '修改视频「vids/social」场景 s3 的画面：', short: '场景 s3 的画面：' };
  const COPY_S5 = { full: '修改视频「vids/social」场景 s5 的文案：', short: '场景 s5 的文案：' };
  const PRODUCTION = 'vids/social';

  it('fills an empty composer with the full instruction, caret at the end', () => {
    const merged = mergeComposerInstruction({ current: '', ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(VISUAL_S3.full);
    expect(merged.selectionStart).toBe(VISUAL_S3.full.length);
  });

  it('appends a second scene without touching what the user already wrote', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝`;
    const merged = mergeComposerInstruction({ current, ...COPY_S5, production: PRODUCTION });
    expect(merged.value).toBe(`${current}\n${COPY_S5.short}`);
    expect(merged.selectionStart).toBe(merged.value.length);
  });

  it('names the production again when another video was named more recently', () => {
    // Dropping the name here would aim the instruction at whichever video the
    // previous line named — a silent edit to the wrong production.
    const current = `${VISUAL_S3.full}背景改成深蓝\n修改视频「vids/launch」场景 s1 的画面：换个开场`;
    const merged = mergeComposerInstruction({
      current,
      ...COPY_S5,
      production: PRODUCTION,
      otherProductions: ['vids/launch'],
    });
    expect(merged.value).toBe(`${current}\n${COPY_S5.full}`);
  });

  it('keeps the short form once this video is the one named most recently', () => {
    // Negative control for the rule above: the other production appears in the
    // message, but this one was named after it, so the list can stay compact.
    const current = `修改视频「vids/launch」场景 s1 的画面：换个开场\n${VISUAL_S3.full}背景改成深蓝`;
    const merged = mergeComposerInstruction({
      current,
      ...COPY_S5,
      production: PRODUCTION,
      otherProductions: ['vids/launch'],
    });
    expect(merged.value).toBe(`${current}\n${COPY_S5.short}`);
  });

  it('stays compact across a run of edits to the same video', () => {
    // The user's own wording between clicks must not push later entries back
    // to the long form; only another production may do that.
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}字太小\n再整体亮一点`;
    const merged = mergeComposerInstruction({
      current,
      full: '修改视频「vids/social」场景 s7 的画面：',
      short: '场景 s7 的画面：',
      production: PRODUCTION,
      otherProductions: [],
    });
    expect(merged.value).toBe(`${current}\n场景 s7 的画面：`);
  });

  it('names the production when the user opened with their own words', () => {
    const current = '这个视频整体节奏偏快';
    const merged = mergeComposerInstruction({ current, ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(`${current}\n${VISUAL_S3.full}`);
  });

  it('moves the caret to an entry already written instead of repeating it', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}`;
    const merged = mergeComposerInstruction({ current, ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(current);
    expect(merged.selectionStart).toBe(`${VISUAL_S3.full}背景改成深蓝`.length);
  });

  it('recognizes a repeated entry through the short form too', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}字太小`;
    const merged = mergeComposerInstruction({ current, ...COPY_S5, production: PRODUCTION });
    expect(merged.value).toBe(current);
    expect(merged.selectionStart).toBe(current.length);
  });

  it('does not leave a blank line behind trailing whitespace', () => {
    const merged = mergeComposerInstruction({
      current: `${VISUAL_S3.full}背景改成深蓝\n\n  `,
      ...COPY_S5,
      production: PRODUCTION,
    });
    expect(merged.value).toBe(`${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}`);
  });

  it('leaves the composer untouched when there is no instruction to add', () => {
    const merged = mergeComposerInstruction({ current: '已经写好的内容', full: '' });
    expect(merged.value).toBe('已经写好的内容');
    expect(merged.selectionStart).toBe('已经写好的内容'.length);
  });
});

// A prefilled instruction is something the user reads and sends, so it has to
// name the video the way the panel does. Quoting the workspace path left the
// composer holding `videos/x/project/compositions/s2_definition` — unreadable,
// and uncheckable against anything on screen.
describe('video review panel › how an instruction names a production', () => {
  it('names it by what the user asked for', () => {
    const comp = { state_key: 'a', task_title: '做一支产品宣传片', display_name: 'videos/promo/project' };
    expect(productionRef(comp, [comp])).toBe('做一支产品宣传片');
  });

  it('falls back to the video directory when no title was recorded', () => {
    const comp = { state_key: 'a', display_name: 'videos/promo/project/composition' };
    expect(productionRef(comp, [comp])).toBe('promo');
  });

  it('appends the path only when another production shares the title', () => {
    // Two videos answering to the same instruction is worse than a long one.
    const a = { state_key: 'a', task_title: '产品宣传片', display_name: 'videos/promo-a/project' };
    const b = { state_key: 'b', task_title: '产品宣传片', display_name: 'videos/promo-b/project' };
    expect(productionRef(a, [a, b])).toBe('产品宣传片 (videos/promo-a/project)');
    expect(productionRef(b, [a, b])).toBe('产品宣传片 (videos/promo-b/project)');
  });

  it('stays short when the other productions have different titles', () => {
    const a = { state_key: 'a', task_title: '产品宣传片', display_name: 'videos/promo/project' };
    const b = { state_key: 'b', task_title: '教程视频', display_name: 'videos/tutorial/project' };
    expect(productionRef(a, [a, b])).toBe('产品宣传片');
  });

  it('never returns nothing to quote', () => {
    expect(productionRef({ display_name: 'videos/promo' }, [])).toBe('promo');
    expect(productionRef({}, [])).toBe('');
  });
});
