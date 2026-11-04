import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const root = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents/79df9cc89f5f');
const agent = JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8'));
const workflow = String(agent.workflow ?? '');
const readSkillRoot = (id: string) => fs.readFileSync(path.join(root, 'skills', id, 'SKILL.md'), 'utf8');
const readSkillReference = (id: string, file: string) => fs.readFileSync(path.join(root, 'skills', id, 'references', file), 'utf8');
const readSkill = (id: string) => { const dir = path.join(root, 'skills', id, 'references'); return [readSkillRoot(id), ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.md')).sort().map(f=>fs.readFileSync(path.join(dir,f),'utf8')) : [])].join('\n'); };

describe('source final VideoStudio public instruction contracts', () => {
it('ends a production turn only at a review stop, delivery, user-only input, or a real boundary', () => {
    // 2026-10-31 matched drives: Sol reached direction, plan, preview and final
    // video in four turns; Luna read gate-control every turn yet ended 5 of 8
    // between reviews with "next I need to ...", the shape of the old
    // recovery-handoff standard. Standards are checked before every final
    // reply, so the valid stops live there and gate-control refers to them.
    const stopRule = ((agent.standards as string[]) ?? []).find((item) => /stops only at/i.test(item)) ?? '';
    for (const stop of ['direction', 'plan', 'paid-generation', 'preview', 'final-video', 'delivery', 'input only the user can give', 'quality/provider boundary']) {
      expect(stopRule).toContain(stop);
    }
    const stoppingTest = readSkill('gate-control').split('## Stopping test')[1].split('\n## ')[0];
    expect(stoppingTest).toMatch(/one of the review stops in the Delivery standards/);
    expect(stoppingTest).not.toMatch(/keyframe preview, or final\s+video/);
  });

it('distinguishes draft recovery from the new-production runbook without adding a tool gate', () => {
    const runbook = readSkillRoot('stage-compose').split('## Fast COMPOSE runbook')[1]
      .split('## Scene-by-scene authoring')[0];
    expect(runbook).toMatch(/sequence covers new production and unfinished authoring/i);
    expect(runbook).toMatch(/unchanged ready draft[\s\S]*existing media\/report[\s\S]*final review/i);
    expect(runbook).toContain('`current_draft`');
    expect(runbook).toMatch(/Changed inputs or missing\s+files need the corresponding repair/i);
    expect(runbook).toMatch(/For new production[\s\S]*composition\.doctor[\s\S]*composition\.prepare/);
    expect(runbook).not.toMatch(/On every new\/resumed production turn|doctor.*once that turn/);
  });

it('keeps result-dependent work sequential without prescribing benchmark call lists', () => {
    const gateControl = readSkillRoot('gate-control');
    expect(gateControl).toMatch(/Choose one result-aware execution horizon/);
    expect(gateControl).toMatch(/If one result decides the branch, stop the horizon/);
    expect(gateControl).toMatch(/Run the bundled resolver and obey/);
    expect(workflow).toMatch(/inspect branch-deciding results before continuing/);
    expect(gateControl).not.toMatch(/planning-only benchmark[\s\S]*as separate ordered steps/);
  });

it('times plan narration and captions on the finished video, not the source clips', () => {
    // 2026-10-30 benchmark (vid-plan-auto, gpt-6-luna, both samples): lines
    // after a composed opener were timed by stacking the clips' lengths, so
    // each ran 4-5 s ahead of its footage. Assembly places every line at its
    // start_sec on the finished video and its checks pass such a plan, so the
    // authoring skill must define that clock and bind each line to the segment
    // whose window the validator checks it against.
    const stagePlan = readSkillRoot('stage-plan');
    expect(stagePlan).toMatch(
      /caption `start_sec` is[^.]*finished video[^.]*earlier primary\s+segment[^.]*composed cards included[^.]*never a\s+source-clip time/i,
    );
    expect(stagePlan).toMatch(/timed line `\{text, segment_id, start_sec, target_sec\}`/);
    expect(stagePlan).toMatch(/`segment_id` names the primary segment the line plays over; validation rejects/);
  });

it('stops editing a plan once a plan check hands it to the user', () => {
    // After two repair passes in a turn, validate and promise_check return
    // requires_user_decision instead of a repair list. Step 4 otherwise says
    // to fix every error and to rebalance until the check passes, so each of
    // those two steps must say the hand-off wins.
    const stagePlan = readSkillRoot('stage-plan');
    const step4 = stagePlan.slice(stagePlan.indexOf('## Step 4'), stagePlan.indexOf('## Director judgment'));
    const handOff = 'If it hands the plan to the user (`requires_user_decision`), stop editing and present its findings instead.';
    const [validate, promise] = step4.split(/\n2\. /);
    expect(validate).toContain('--op validate');
    expect(validate).toContain(handOff);
    expect(promise).toContain('--op promise_check');
    expect(promise.split(/\n3\. /)[0]).toContain(handOff);
  });

it('copies supplied footage into the project once instead of retyping its attachment path', () => {
    // 2026-10-31 to 11-01 retests: all 21 mistyped attachment paths were later
    // retypes of a path already used correctly, none after the clip had been
    // copied into the project; both footage notes allowed passing the
    // attachment path directly. Every run read stage-edit before its first use.
    // Both notes name the raw/ every example reads from: when stage-edit said
    // "the project's raw/", two runs copied the clip into project/raw/ and raw/.
    for (const id of ['stage-edit', 'stage-plan']) {
      const note = readSkillRoot(id).match(/\*\*Where the (?:footage|material) comes from\.\*\*[^\n]*/)?.[0] || '';
      expect(note, id).toMatch(/Before (?:its )?first use, copy (?:it|each) once from (?:that|its) exact `path` into `raw\/`/);
      expect(note, id).toMatch(/then use the `raw\/` path in every later call and in the plan/);
      expect(note, id).not.toMatch(/or pass its attachment path/);
    }
  });

it('copies a rejected attachment path again from the list instead of asking for the upload again', () => {
    // 2026-11-01 retest: a later turn retyped the attachment path while copying
    // the clip again, got "No such file" and "outside scope", and asked the user
    // to upload the video again although the attachment list showed it. The list
    // is read from disk every turn, so a listed file can still be copied.
    const note = readSkillRoot('stage-edit').match(/\*\*Where the footage comes from\.\*\*[^\n]*/)?.[0] || '';
    expect(note).toMatch(/If a tool reports that path missing, copy it again from the attachment list/);
    expect(note).toMatch(/while the list shows the file, do not ask the user to upload it again/);
  });

it('limits production.edit to one generated clip before stage-edit says to call it', () => {
    // Productions of supplied footage with captions or title cards read this
    // section as their executor: 44 refused production.edit calls in 23 runs
    // of the 2026-10-31 retests. The boundary must precede the call.
    const edit = readSkillRoot('stage-edit');
    const section = (edit.match(/## Captions on an existing generated video\n([\s\S]*?)\n## /)?.[1] || '').trim();
    const call = section.indexOf('op:"production.edit"');
    expect(call).toBeGreaterThan(0);
    const scope = section.slice(0, call);
    expect(scope).toMatch(/`production\.edit` is only for caption changes to one completed\s+clip VideoStudio generated/);
    expect(scope).toMatch(/plan that cuts supplied footage[^.]*produced as described below or in stage-assemble/);
    // A follow-up still stays with its plan whatever the change.
    expect(section).toMatch(/^A follow-up on a video with a production plan stays with that plan/);
  });

it('keeps a named pre-assembly segment revision on the complete production preview', () => {
    const policy = readSkillReference('gate-control', 'assembled-productions.md');
    const revision = policy.split('**A user-requested change to one segment')[1]
      .split('- **Editing one segment')[0];
    expect(revision).toMatch(/Before assembly begins[\s\S]*re-capture (?:only )?that segment/i);
    expect(revision).toMatch(/reuse[\s\S]*unchanged[\s\S]*whole.production preview/i);
    expect(revision).toMatch(/one[\s\S]*go-ahead question[\s\S]*end the turn/i);
    expect(revision).toMatch(/never a separate\s+confirmation[\s\S]*change itself/i);
    expect(revision).not.toMatch(/After the go-ahead[\s\S]*continues without stopping/i);
    expect(readSkill('stage-assemble')).toMatch(/changed whole-video preview stops once before assembly/i);
  });
});
