import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { versionChatMediaLocalUrlsInText, versionedChatMediaLocalUrl } from '../../../src/main/util/chat-media-url';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { seedVoiceFixture, inspectVoiceFixture, voiceAcceptsLinkedAudio, voiceChecks, voiceTone, type VoiceTrace } from '../../../eval/model-eval/regression/voice-studio-fixtures';

const require = createRequire(import.meta.url);
const skill = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project');
const audio = require(path.join(skill, 'scripts/audio.js'));
let root: string, prior: NodeJS.ProcessEnv;
beforeEach(() => {
  prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv());
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-guidance-')));
});
afterEach(() => { process.env = prior; fs.rmSync(root, { recursive: true, force: true }); });

it('makes each private editing reference reachable without changing narration or conversion ownership', () => {
  const entry = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
  for (const name of ['timeline-mixing', 'word-editing', 'narration', 'media-delivery']) {
    expect(entry).toContain(`](references/${name}.md)`);
    expect(fs.existsSync(path.join(skill, 'references', `${name}.md`))).toBe(true);
  }
  for (const name of ['project-format', 'local-audio']) {
    const body = fs.readFileSync(path.join(skill, 'references', `${name}.md`), 'utf8');
    for (const link of ['timeline-mixing', 'word-editing']) expect(body).toContain(`](${link}.md)`);
  }
});

it('renders the saved revision returned by a colliding write and reports it for delivery', async () => {
  const id = 'voice-trim-edges';
  seedVoiceFixture(id, root);
  process.env.ORKAS_WORKSPACE_ROOT = root;
  const { activateUser } = await import('../../../src/main/features/users');
  const userId = 'voice-guidance-test';
  activateUser(userId);
  const { createLocalTools } = await import('../../../src/main/model/core-agent/local-tools');
  const { setWorkspacePath } = await import('../../../src/main/features/user_workspace');
  expect(setWorkspacePath(userId, root).ok).toBe(true);
  const dir = path.join(root, 'audio'), original = path.join(dir, 'voice-project.json');
  const source = path.join(dir, 'sources/recording.wav'), previous = path.join(dir, 'export-previous/audio.wav');
  const originalBytes = fs.readFileSync(original), sourceBytes = fs.readFileSync(source), previousBytes = fs.readFileSync(previous);
  const revision = { ...JSON.parse(originalBytes.toString()), schema_version: 2,
    processing: [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: .05 }], export: { format: 'wav' } };
  const write = createLocalTools({ userId }).find(tool => tool.name === 'write_file')!;
  const result = await write.execute({ path: original, content: JSON.stringify(revision) }, { workingDir: dir, state: {} });
  expect(result.isError, String(result.content)).toBeFalsy();
  const saved = String(result.content).match(/<file path="([^"]+)" total_bytes=/)?.[1];
  expect(saved).toBe(path.join(dir, 'voice-project-2.json'));

  const rendered = await audio.execute('render', { project: saved });
  const [delivered] = rendered.absolute_files;
  const published = [delivered, saved!];
  const check = (files: string[]) => voiceChecks(id, { toolCalls: [{ name: 'bash', isError: false }],
    voiceStudio: inspectVoiceFixture(id, root, files) } as any).filter(item => !item.pass).map(item => item.id);
  expect(check(published)).toEqual([]);
  expect(check([delivered, original])).toContain('acceptance:voice-project-replay');
  expect(check([delivered])).toContain('acceptance:voice-project-replay');
  const snapshot = rendered.absolute_files.find((file: string) => path.basename(file) === 'plan-snapshot.json');
  expect(check([delivered, snapshot])).toContain('acceptance:voice-project-replay');

  expect(rendered.project_path).toBe(saved);
  expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual(revision);
  expect(fs.readFileSync(original)).toEqual(originalBytes);
  expect(fs.readFileSync(source)).toEqual(sourceBytes);
  expect(fs.readFileSync(previous)).toEqual(previousBytes);
}, 30_000);

it('reopens the documented conversion project and reproduces the delivered PCM without changing the original edit', async () => {
  const body = fs.readFileSync(path.join(skill, 'references/media-delivery.md'), 'utf8');
  const projects = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map(match => JSON.parse(match[1])).filter(value => value.schema_version && value.segments?.length);
  expect(projects).toHaveLength(1);
  seedVoiceFixture('voice-recorded-preserve-zh', root);
  const dir = path.join(root, 'audio'), original = path.join(dir, 'voice-project.json');
  const originalBytes = fs.readFileSync(original), source = path.join(dir, 'sources/recording.wav');
  const sourceBytes = fs.readFileSync(source);
  const converted = await audio.execute('convert', { project: original, input_path: 'sources/recording.wav', format: 'wav' });
  const saved = path.join(dir, 'conversion-project.json');
  fs.writeFileSync(saved, JSON.stringify(projects[0]));
  // Reopen only the persisted project; no convert request or render override
  // may supply missing source references or export settings.
  const rendered = await audio.execute('render', { project: saved });
  const pcm = (file: string) => {
    const result = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i', file,
      '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status).toBe(0); expect(result.stderr.length).toBe(0);
    return result.stdout;
  };
  for (const result of [converted, rendered]) {
    expect(result.files.every((file: string) => !path.isAbsolute(file))).toBe(true);
    expect(result.absolute_files).toEqual(result.files.map((file: string) => path.join(dir, file)));
  }
  const [delivered] = converted.absolute_files;
  const [replay] = rendered.absolute_files;
  expect(pcm(replay)).toEqual(pcm(delivered)); expect(pcm(delivered)).toEqual(pcm(source));
  expect(rendered).toMatchObject({ sample_rate: 48000, channels: 1, duration_sec: 8 });
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, rendered.files.find((file: string) => file.endsWith('receipt.json'))), 'utf8'));
  expect(receipt.export).toMatchObject({ format: 'wav', sample_rate: 48000, channels: 1, bit_depth: 16, normalize_loudness: false });
  expect(fs.readFileSync(original)).toEqual(originalBytes); expect(fs.readFileSync(source)).toEqual(sourceBytes);
});

// Execute the actual documented project, then use frequency/PCM, preservation
// and fresh-project replay evidence independently of the example's prose.
it.each([
  ['timeline-mixing', 'voice-timed-overlays'],
  ['word-editing', 'voice-word-cut'],
])('delivers the requested audio from the %s example', async (reference, id) => {
  const file = path.join(skill, 'references', `${reference}.md`);
  expect(fs.existsSync(file)).toBe(true);
  const body = fs.readFileSync(file, 'utf8');
  const projects = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map(match => JSON.parse(match[1])).filter(value => value.schema_version === 3);
  expect(projects).toHaveLength(1);
  seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json');
  fs.writeFileSync(project, JSON.stringify(projects[0]));
  await audio.execute('render', { project });
  const checks = voiceChecks(id, { toolCalls: [{ name: 'bash', isError: false }],
    voiceStudio: inspectVoiceFixture(id, root) } as any);
  expect(checks.filter(check => !check.pass)).toEqual([]);
  expect(checks.some(check => check.id === 'acceptance:voice-project-replay')).toBe(true);
}, 30000);

import { enhancementCases, decodeEnhancement, enhancementMeasures } from '../../../eval/model-eval/regression/voice-enhancement-fixtures';
import { recordedCases } from '../../../eval/model-eval/regression/voice-recorded-fixtures';
import { deliveryCases } from '../../../eval/model-eval/regression/voice-delivery-fixtures';
import { publishedVoiceFiles } from '../../../eval/model-eval/regression/voice-output-evidence';

function trace(id: string, calls: any[] = [{ name: 'bash', isError: false }], published?: readonly string[]) { return { toolCalls: calls, voiceStudio: inspectVoiceFixture(id, root, published) } as VoiceTrace; }
const accepted = (id: string, t = trace(id)) => {
  const checks = voiceChecks(id, t);
  expect(checks.length).toBeGreaterThanOrEqual(4);
  return checks.every(check => check.pass);
};

// Portable source calibration exercises the shipped local audio owner and its independent PCM/file oracles.
it.each(deliveryCases)('calibrates delivery specifications, preserved levels and ducking against false completion: %s',async id=>{
  seedVoiceFixture(id,root);expect(accepted(id)).toBe(false);
  const project=path.join(root,'audio/voice-project.json'),p=JSON.parse(fs.readFileSync(project,'utf8'));
  if(id==='voice-music-duck'){p.music={path:'sources/music.wav',volume:1,duck:true};p.export={format:'wav',normalize_loudness:false};}
  if(id==='voice-export-spec')p.export={format:'wav',sample_rate:24000,channels:1,bit_depth:24};
  fs.writeFileSync(project,JSON.stringify(p));
  const r=await audio.execute(id==='voice-music-duck'||id==='voice-export-spec'?'render':['voice-extract-video','voice-extract-track'].includes(id)?'extract':'convert',{
    project,...(id==='voice-extract-track'?{input_path:'sources/multi.mkv',audio_stream:1}:id==='voice-extract-video'?{input_path:'sources/video.mkv'}:['voice-convert-preserve','voice-convert-isolated'].includes(id)?{input_path:'sources/recording.wav',format:'flac'}:{}),
  });
  const file=path.join(root,'audio',r.files[0]),bytes=fs.readFileSync(file);
  const observed=trace(id);expect(accepted(id,observed)).toBe(true);
  expect(accepted(id,{...observed,toolCalls:[]})).toBe(false);
  expect(accepted(id,{...observed,toolCalls:[...observed.toolCalls,{name:'generate_speech',isError:false}]})).toBe(false);
  // An unchanged input with a new extension must never pass as completed work.
  fs.copyFileSync(path.join(root,'audio/sources',id==='voice-extract-video'?'video.mkv':'recording.wav'),file);expect(accepted(id)).toBe(false);
  fs.writeFileSync(file,bytes);
  const ffmpeg=process.env.ORKAS_BUNDLED_FFMPEG!;
  const altered=path.join(root,'altered.wav');
  const change=spawnSync(ffmpeg,['-v','error','-nostdin','-i',file,'-af','volume=2','-c:a','pcm_s16le',altered],{timeout:30000});expect(change.status).toBe(0);
  fs.copyFileSync(altered,file);expect(accepted(id)).toBe(false);fs.writeFileSync(file,bytes);
  fs.writeFileSync(path.join(root,'audio/export-previous/audio.wav'),'changed');expect(accepted(id)).toBe(false);
},60000);

it('accepts different audible base music gains but rejects fixed or missing background instead of ducking',async()=>{
  const id='voice-music-duck';seedVoiceFixture(id,root);
  const project=path.join(root,'audio/voice-project.json'),p=JSON.parse(fs.readFileSync(project,'utf8'));
  p.export={format:'wav',normalize_loudness:false};
  for(const [volume,duck,expected] of [[.15,true,true],[1,true,true],[.15,false,false],[0,true,false]] as const){
    p.music={path:'sources/music.wav',volume,duck};fs.writeFileSync(project,JSON.stringify(p));
    const result=await audio.execute('render',{project});
    expect(accepted(id),JSON.stringify({volume,duck})).toBe(expected);
    fs.rmSync(path.dirname(path.join(root,'audio',result.files[0])),{recursive:true,force:true});
  }
},60000);

it.each(recordedCases)('calibrates human-recording completion, negation and false-output controls: %s', async id => {
  seedVoiceFixture(id, root); expect(accepted(id)).toBe(false);
  const project = path.join(root, 'audio/voice-project.json'), p = JSON.parse(fs.readFileSync(project, 'utf8'));
  p.schema_version = 2; p.processing = id === recordedCases[0] ? [{ type: 'denoise', strength: 'standard' }] : id === recordedCases[1] ? [{ type: 'highpass', frequency_hz: 80 }] : id === recordedCases[2] ? [{ type: 'compressor' }] : [];
  if (id === recordedCases[3]) p.export = { format: 'wav', channels: 1, normalize_loudness: false };
  fs.writeFileSync(project, JSON.stringify(p)); const r = await audio.execute('render', { project, format: 'wav' });
  expect(accepted(id), JSON.stringify(inspectVoiceFixture(id, root))).toBe(true);
  fs.writeFileSync(path.join(root, 'audio/000-unrelated.json'), '{');
  expect(accepted(id)).toBe(true);
  if (id === recordedCases[0] || id === recordedCases[1]) {
    const wrong = JSON.parse(JSON.stringify(p));
    if (id === recordedCases[0]) wrong.processing[0].strength = 'strong'; else wrong.processing[0].frequency_hz = 120;
    fs.writeFileSync(project, JSON.stringify(wrong)); expect(accepted(id)).toBe(false);
    fs.writeFileSync(project, JSON.stringify(p)); expect(accepted(id)).toBe(true);
  }
  expect(accepted(id, trace(id, []))).toBe(false);
  expect(accepted(id, trace(id, [{ name: 'bash', isError: false }, { name: 'generate_speech', op: 'separate', isError: true }]))).toBe(false);
  const file = path.join(root, 'audio', r.files[0]), bytes = fs.readFileSync(file);
  const draft=path.join(root,'audio/draft.wav');fs.writeFileSync(draft,voiceTone(8,1200));
  const selected=trace(id);selected.voiceStudio=inspectVoiceFixture(id,root,[file,project]);expect(accepted(id,selected)).toBe(true);
  selected.voiceStudio=inspectVoiceFixture(id,root,[draft]);expect(accepted(id,selected)).toBe(false);
  selected.voiceStudio=inspectVoiceFixture(id,root,[]);expect(accepted(id,selected)).toBe(false);fs.rmSync(draft);
  for (const wrong of [voiceTone(8), Buffer.alloc(44)]) { fs.writeFileSync(file, wrong); expect(accepted(id)).toBe(false); }
  fs.writeFileSync(file, bytes);
  if (id === recordedCases[1]) {
    const followUp = 'voice-recorded-rumble-zh-undo'; expect(accepted(followUp)).toBe(false);
    p.processing = []; p.export = { format: 'wav', channels: 1, normalize_loudness: false }; fs.writeFileSync(project, JSON.stringify(p));
    const undone=await audio.execute('render', { project, format: 'wav' }); expect(accepted(followUp)).toBe(true);
    const final=path.join(root,'audio',undone.files[0]),extra=path.join(root,'audio/retained-intermediate.wav');fs.writeFileSync(extra,voiceTone(8,1200));
    const selectedUndo=trace(followUp);selectedUndo.voiceStudio=inspectVoiceFixture(followUp,root,[final,project]);expect(accepted(followUp,selectedUndo)).toBe(true);
    selectedUndo.voiceStudio=inspectVoiceFixture(followUp,root,[file]);expect(accepted(followUp,selectedUndo)).toBe(false);fs.rmSync(extra);
    const preserved = inspectVoiceFixture(followUp, root)!.recorded!;
    expect(preserved.speech_correlation).toBeLessThan(.8); // Clean speech excludes the rumble the user asked to retain.
    expect(preserved.local_unchanged_correlation).toBeGreaterThan(.99);
    expect(preserved.speech_reference).toContain('actual input');
    fs.rmSync(file); expect(accepted(followUp)).toBe(false);
  } else if (id === recordedCases[3]) {
    // An unrequested rumble filter is acoustically plausible but violates the task.
    p.processing = [{ type: 'highpass' }]; fs.writeFileSync(project, JSON.stringify(p));
    expect(accepted(id)).toBe(false);
  }
}, 60000);
it.each(enhancementCases)('calibrates real enhancement and rejects no-op, unrelated audio, extra treatment and false execution: %s', async id => {
  seedVoiceFixture(id, root); expect(accepted(id)).toBe(false);
  const project = path.join(root, 'audio/voice-project.json'), p = JSON.parse(fs.readFileSync(project, 'utf8'));
  const steps = [{ type: 'highpass', frequency_hz: 80 }, { type: 'deesser', strength: 'standard' }, { type: 'compressor' }];
  p.schema_version = 2; p.processing = id === enhancementCases[3] ? steps : [steps[enhancementCases.indexOf(id)]];
  if (id === 'voice-deess') p.export = { format: 'wav', normalize_loudness: false };
  fs.writeFileSync(project, JSON.stringify(p));
  const r = await audio.execute('render', { project, format: 'wav' }), file = path.join(root, 'audio', r.files[0]);
  expect(accepted(id), JSON.stringify(enhancementMeasures(decodeEnhancement(file)))).toBe(true);
  const measured = inspectVoiceFixture(id, root)!.enhancement!;
  expect(measured.duration).toBe(6); expect(measured.voiced).toBeGreaterThan(.003);
  expect(measured.detail).toBeGreaterThan(.045);
  const sourceMeasure = inspectVoiceFixture(id, root)!.enhancementSource!;
  expect(sourceMeasure.detail).toBeCloseTo(.06667, 3);
  expect(sourceMeasure.dynamics).toBeCloseTo(12.5, 1);
  // A valid saved revision remains usable when the write tool preserved the
  // original name. An unrelated request JSON or old project is insufficient.
  const revision = path.join(root, 'audio/voice-project-2.json');
  fs.renameSync(project, revision);
  fs.writeFileSync(project, JSON.stringify({ schema_version: 1, roles: {}, segments: [{ id: 'recording', path: 'sources/recording.wav' }] }));
  expect(accepted(id)).toBe(true);
  fs.rmSync(revision); expect(accepted(id)).toBe(false);
  fs.writeFileSync(project, JSON.stringify(p));
  expect(accepted(id, trace(id, []))).toBe(false);
  expect(accepted(id, trace(id, [{ name: 'generate_speech', op: 'separation_capabilities', isError: false }, { name: 'bash', isError: false }]))).toBe(false);
  const bytes = fs.readFileSync(file);
  for (const wrong of [fs.readFileSync(path.join(root, 'audio/sources/recording.wav')), voiceTone(6, 880)]) {
    fs.writeFileSync(file, wrong); expect(accepted(id)).toBe(false);
  }
  fs.writeFileSync(file, bytes);
  if (id === 'voice-deess') {
    const lowpass = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-y', '-i', path.join(root, 'audio/sources/recording.wav'), '-af', 'lowpass=f=4000', '-c:a', 'pcm_s16le', file], { timeout: 60000, encoding: 'utf8' });
    expect(lowpass.status).toBe(0); expect(lowpass.stderr).toBe('');
    expect(accepted(id)).toBe(false); fs.writeFileSync(file, bytes);
  }
  p.processing.push({ type: 'silence', mode: 'edges' }); fs.writeFileSync(project, JSON.stringify(p)); expect(accepted(id)).toBe(false);
  p.processing.pop(); fs.writeFileSync(project, JSON.stringify(p));
  fs.writeFileSync(path.join(root, 'audio/export-previous/audio.wav'), 'overwritten'); expect(accepted(id)).toBe(false);
}, 60000);

it.each(['voice-local-mix', 'voice-revise-cached', 'voice-recover-recording'])('calibrates real audio acceptance and rejects dishonest completion: %s', async id => {
  seedVoiceFixture(id, root); expect(accepted(id)).toBe(false);
  const project = path.join(root, 'audio/voice-project.json');
  const p = JSON.parse(fs.readFileSync(project, 'utf8'));
  if (id === 'voice-local-mix') {
    p.segments = [{ id: 'first', path: 'sources/first.wav', start_sec: .5, end_sec: 1.5, gap_after_sec: .4 }, { id: 'second', path: 'sources/second.wav' }];
    p.music = { path: 'sources/music.wav', volume: .1 };
  } else if (id === 'voice-revise-cached') p.segments[1].speed = .5;
  fs.writeFileSync(project, JSON.stringify(p));
  if (id === 'voice-recover-recording') {
    const pending = (await audio.execute('status', { project })).segments[1];
    await audio.execute('record', { project, segment_id: 'second', key: pending.key });
  }
  const result = await audio.execute('render', { project, format: 'wav' });
  expect(inspectVoiceFixture(id, root)).toMatchObject({ decoded: true, contentMatched: true, sourcesPreserved: true, previousPreserved: true });
  expect(accepted(id)).toBe(true);
  const exported = path.join(root, 'audio', result.files[0]);
  const relocated = path.join(root, 'audio/exports/current'); fs.mkdirSync(relocated, { recursive: true });
  fs.renameSync(exported, path.join(relocated, 'audio.wav'));
  expect(accepted(id)).toBe(true);
  fs.renameSync(path.join(relocated, 'audio.wav'), exported);
  expect(accepted(id, trace(id, []))).toBe(false);
  expect(accepted(id, trace(id, [{ name: 'bash', isError: false }, { name: 'generate_speech', isError: true }]))).toBe(false);
  expect(accepted(id, trace(id, [{ name: 'bash', isError: false }, { name: 'generate_speech', op: 'capabilities', isError: false }]))).toBe(true);
  // A valid, correctly timed WAV with unrelated content cannot satisfy the oracle.
  fs.writeFileSync(path.join(root, 'audio', result.files[0]), voiceTone(id === 'voice-local-mix' ? 2.4 : id === 'voice-revise-cached' ? 3.2 : 2.2, 880));
  expect(accepted(id)).toBe(false);
}, 60000);
it('rejects empty recovery state and deleted inputs without crashing inspection', () => {
  const id = 'voice-recover-recording'; seedVoiceFixture(id, root);
  fs.writeFileSync(path.join(root, 'audio/.voice-state.json'), '{"attempts":{}}');
  expect(inspectVoiceFixture(id, root)?.recovered).toBe(false);
  fs.rmSync(path.join(root, 'audio'), { recursive: true });
  expect(inspectVoiceFixture(id, root)?.sourcesPreserved).toBe(false);
});
it('uses host publication state while rejecting user, dispatch, deleted and prose-only file claims',()=>{
  const final=path.join(root,'audio/final.wav');
  expect(publishedVoiceFiles([
    {from:'user',produced:[final]}, {from:'voice-studio',dispatch:true,produced:[final]},
    {from:'voice-studio',deleted_at:1,produced:[final]}, {from:'voice-studio',content:`Done: ${final}`},
  ])).toEqual([]);
  expect(publishedVoiceFiles([{from:'voice-studio',produced:[final,'relative.wav',null]}])).toEqual([final]);
});
it.each([{ end: 11, valid: true }, { end: 23.756, valid: false }])('checks subtitle bounds against the frozen recording, not just matching text ($end)', ({ end, valid }) => {
  const id = 'voice-transcribe-speech'; seedVoiceFixture(id, root);
  const text = fs.readFileSync(path.resolve('test/fixtures/voice/jfk.txt'), 'utf8').trim();
  fs.writeFileSync(path.join(root, 'audio/transcript.txt'), text);
  const seconds = Math.floor(end).toString().padStart(2, '0');
  const millis = Math.round((end % 1) * 1000).toString().padStart(3, '0');
  fs.writeFileSync(path.join(root, 'audio/transcript.srt'), `1\n00:00:00,000 --> 00:00:${seconds},${millis}\n${text}\n`);
  const observed = inspectVoiceFixture(id, root)!;
  expect(observed.transcript).toMatchObject({ sourceMatched: true, consistent: true, wer: 0, timed: valid });
  expect(accepted(id)).toBe(valid);
});
it('reports transcript source evidence without inventing an output digest',()=>{
  const id='voice-transcribe-speech';seedVoiceFixture(id,root);
  const text=fs.readFileSync(path.resolve('test/fixtures/voice/jfk.txt'),'utf8').trim();
  fs.writeFileSync(path.join(root,'audio/transcript.txt'),text);
  fs.writeFileSync(path.join(root,'audio/transcript.srt'),`1\n00:00:00,000 --> 00:00:11,000\n${text}\n`);
  let e=inspectVoiceFixture(id,root)!;
  expect(e.transcript).toMatchObject({sourceMatched:true,sourceBinding:'preserved-input-and-content',consistent:true,wer:0,timed:true});
  fs.writeFileSync(path.join(root,'audio/transcript.json'),JSON.stringify({text,source_sha256:'wrong-source',segments:[{text,start_sec:0,end_sec:11}]}));
  e=inspectVoiceFixture(id,root)!;
  expect(e.transcript).toMatchObject({sourceMatched:false,sourceBinding:'output-digest'});
  expect(accepted(id)).toBe(false);
});
it('calibrates missing input with observed inspection, preservation and no invented export', () => {
  const id = 'voice-missing-source'; seedVoiceFixture(id, root);
  expect(accepted(id)).toBe(true);
  expect(accepted(id, trace(id, []))).toBe(false);
  fs.mkdirSync(path.join(root, 'audio/export-invented'));
  fs.writeFileSync(path.join(root, 'audio/export-invented/audio.wav'), voiceTone(1));
  expect(accepted(id)).toBe(false);
  fs.rmSync(path.join(root, 'audio/export-invented'), { recursive: true });
  fs.writeFileSync(path.join(root, 'audio/transcript.txt'), 'invented words');
  expect(accepted(id)).toBe(false);
  fs.rmSync(path.join(root, 'audio/transcript.txt'));
  fs.writeFileSync(path.join(root, 'audio/sources/first.wav'), 'overwritten');
  expect(accepted(id)).toBe(false);
});

it('accepts a new topic-named production project while preserving the supplied audio directory', async () => {
  const id = 'voice-local-mix'; seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json');
  fs.writeFileSync(project, JSON.stringify({ schema_version: 1, segments: [
    { id: 'first', path: 'sources/first.wav', start_sec: .5, end_sec: 1.5, gap_after_sec: .4 },
    { id: 'second', path: 'sources/second.wav' },
  ], music: { path: 'sources/music.wav', volume: .1 } }));
  await audio.execute('render', { project, format: 'wav' });
  fs.renameSync(path.join(root, 'audio'), path.join(root, 'my-topic'));
  seedVoiceFixture(id, root);
  expect(accepted(id)).toBe(true);
  fs.rmSync(path.join(root, 'my-topic'), { recursive: true });
  expect(accepted(id)).toBe(false);
});

it.each(['voice-trim-edges', 'voice-compress-pauses', 'voice-denoise', 'voice-preserve-pauses', 'voice-revise-pauses'])('calibrates processing with real audio and rejects unchanged or empty results: %s', async id => {
  seedVoiceFixture(id, root); expect(accepted(id)).toBe(false);
  const project = path.join(root, 'audio/voice-project.json'), p = JSON.parse(fs.readFileSync(project, 'utf8'));
  p.schema_version = 2;
  p.processing = id === 'voice-trim-edges' ? [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: .05 }]
    : id === 'voice-denoise' ? [{ type: 'denoise', strength: 'standard' }]
    : id === 'voice-preserve-pauses' ? [] : [{ type: 'silence', mode: 'compress', min_silence_sec: .8, keep_sec: .3 }];
  fs.writeFileSync(project, JSON.stringify(p));
  let r = await audio.execute('render', { project, format: 'wav' });
  if (id === 'voice-revise-pauses') {
    expect(accepted(id)).toBe(true); p.processing[0].keep_sec = .6; fs.writeFileSync(project, JSON.stringify(p));
    r = await audio.execute('render', { project, format: 'wav' });
  }
  const finalId = id === 'voice-revise-pauses' ? 'voice-revise-pauses-follow-up' : id;
  expect(accepted(finalId)).toBe(true);
  expect(accepted(finalId, trace(finalId, []))).toBe(false);
  fs.writeFileSync(path.join(root, 'audio', r.files[0]), voiceTone(id === 'voice-denoise' ? 2 : id === 'voice-trim-edges' ? 3.5 : id === 'voice-compress-pauses' ? 3.1 : id === 'voice-revise-pauses' ? 3.4 : 4.2, 880));
  expect(accepted(finalId)).toBe(false);
}, 60000);
it.each(['voice-all-silent', 'voice-separate-offline'])('rejects fabricated exports for blocked processing: %s', id => {
  seedVoiceFixture(id, root); expect(accepted(id)).toBe(true);
  expect(accepted(id, trace(id, []))).toBe(false);
  fs.mkdirSync(path.join(root, 'audio/export-invented')); fs.writeFileSync(path.join(root, 'audio/export-invented/audio.wav'), voiceTone(1));
  expect(accepted(id)).toBe(false);
});
it('accepts a saved export-profile revision and rejects the unchanged prior profile alone',async()=>{
  const id='voice-export-spec';seedVoiceFixture(id,root);
  const project=path.join(root,'audio/voice-project.json'),revision=path.join(root,'audio/voice-project-2.json');
  const before=fs.readFileSync(project),p=JSON.parse(before.toString());
  p.export={format:'wav',sample_rate:24000,channels:1,bit_depth:24};fs.writeFileSync(revision,JSON.stringify(p));
  await audio.execute('render',{project:revision});
  expect(accepted(id)).toBe(true);
  fs.rmSync(revision);expect(accepted(id)).toBe(false);expect(fs.readFileSync(project)).toEqual(before);
});
it('rejects the wrong audio track and mixed tracks even when codec and duration are correct',async()=>{
  const id='voice-extract-track';seedVoiceFixture(id,root);const project=path.join(root,'audio/voice-project.json');
  const wrong=await audio.execute('extract',{project,input_path:'sources/multi.mkv',audio_stream:0});
  expect(accepted(id)).toBe(false);fs.rmSync(path.dirname(path.join(root,'audio',wrong.files[0])),{recursive:true,force:true});
  const correct=await audio.execute('extract',{project,input_path:'sources/multi.mkv',audio_stream:1});
  expect(accepted(id)).toBe(true);
  const file=path.join(root,'audio',correct.files[0]);fs.rmSync(file);
  const result=spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!,['-v','error','-nostdin','-i',path.join(root,'audio/sources/multi.mkv'),'-filter_complex','[0:a:0][0:a:1]amix=inputs=2:normalize=0[out]','-map','[out]','-c:a','pcm_s16le',file],{timeout:30000});
  expect(result.status,String(result.stderr)).toBe(0);expect(accepted(id)).toBe(false);
});
it('rejects treating a pure conversion as a render of the old edited project',async()=>{
  const id='voice-convert-isolated';seedVoiceFixture(id,root);const project=path.join(root,'audio/voice-project.json');
  const result=await audio.execute('render',{project,format:'flac'});expect(accepted(id)).toBe(false);
  fs.rmSync(path.dirname(path.join(root,'audio',result.files[0])),{recursive:true,force:true});
  await audio.execute('convert',{project,input_path:'sources/recording.wav',format:'flac'});expect(accepted(id)).toBe(true);
  const p=JSON.parse(fs.readFileSync(project,'utf8'));p.processing=[];fs.writeFileSync(project,JSON.stringify(p));expect(accepted(id)).toBe(false);
});

it.each(['voice-timed-overlays','voice-bgm-transitions','voice-word-cut'])('calibrates composition completion against mistimed, untouched and unrelated audio: %s',async id=>{
  seedVoiceFixture(id,root);expect(accepted(id)).toBe(false);
  const project=path.join(root,'audio/voice-project.json'),p=JSON.parse(fs.readFileSync(project,'utf8'));
  p.schema_version=3;p.export={format:'wav',normalize_loudness:false};
  if(id==='voice-timed-overlays')p.tracks=[{id:'fx',kind:'effect',path:'sources/effect.wav',at_sec:1},{id:'a',kind:'music',path:'sources/music.wav'},{id:'b',kind:'music',path:'sources/other.wav',at_sec:2}];
  if(id==='voice-bgm-transitions'){p.segments[0].volume=0;p.tracks=[{id:'bg',kind:'music',path:'sources/music.wav',duration_sec:4,loop:true,loop_crossfade_sec:.1,fade_in_sec:.2,fade_out_sec:.4,volume:1}];}
  if(id==='voice-word-cut')p.segments[0].word_edit={transcript_path:'words.json',mode:'remove',ranges:[{first:1,last:1}]};
  fs.writeFileSync(project,JSON.stringify(p));
  const r=await audio.execute('render',{project});const file=path.join(root,'audio',r.files[0]),bytes=fs.readFileSync(file),good=trace(id);
  expect(accepted(id,good),JSON.stringify(good.voiceStudio)).toBe(true);
  const draft=path.join(root,'audio/export-draft/audio.wav');fs.mkdirSync(path.dirname(draft));fs.writeFileSync(draft,voiceTone(4,1200));
  const selected=trace(id);selected.voiceStudio=inspectVoiceFixture(id,root,[file]);
  expect(accepted(id,selected),'retained intermediates are not additional final deliveries').toBe(true);
  selected.voiceStudio=inspectVoiceFixture(id,root,[draft]);expect(accepted(id,selected)).toBe(false);
  selected.voiceStudio=inspectVoiceFixture(id,root,[]);expect(accepted(id,selected)).toBe(false);
  fs.rmSync(path.dirname(draft),{recursive:true});
  // Same duration and sampled windows can hide a missing retained passage.
  if(id!=='voice-bgm-transitions'){
    const candidate=path.join(root,'broken.wav');
    const hole=id==='voice-word-cut'?'between(t,2.2,2.8)':'between(t,0.65,0.85)';
    const muted=spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!,['-v','error','-nostdin','-i',file,'-af',`volume=0:enable='${hole}'`,'-c:a','pcm_s16le',candidate],{timeout:30000});
    expect(muted.status,String(muted.stderr)).toBe(0);fs.writeFileSync(file,fs.readFileSync(candidate));fs.rmSync(candidate);
    expect(accepted(id),'a missing retained passage must fail even with the right duration').toBe(false);fs.writeFileSync(file,bytes);
  }
  const disguised=path.join(root,'lossless.flac');
  const encoded=spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!,['-v','error','-nostdin','-i',file,'-c:a','flac',disguised],{timeout:30000});
  expect(encoded.status,String(encoded.stderr)).toBe(0);fs.writeFileSync(file,fs.readFileSync(disguised));fs.rmSync(disguised);
  expect(accepted(id),'a decodable FLAC renamed WAV is not a WAV delivery').toBe(false);fs.writeFileSync(file,bytes);
  const broken=structuredClone(p);broken.segments[0].path='sources/missing.wav';fs.writeFileSync(project,JSON.stringify(broken));
  expect(accepted(id),'a broken source reference is not an editable project').toBe(false);fs.writeFileSync(project,JSON.stringify(p));
  if(id==='voice-bgm-transitions'){
    p.tracks[0].fade_in_sec=0;fs.writeFileSync(project,JSON.stringify(p));fs.rmSync(path.dirname(file),{recursive:true,force:true});
    const noFade=await audio.execute('render',{project});
    expect(accepted(id),'an omitted requested fade-in must fail').toBe(false);
    fs.rmSync(path.dirname(path.join(root,'audio',noFade.files[0])),{recursive:true,force:true});
    p.tracks[0].fade_in_sec=.2;fs.writeFileSync(project,JSON.stringify(p));fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,bytes);
  }
  expect(accepted(id,{...good,toolCalls:[]})).toBe(false);expect(accepted(id,{...good,toolCalls:[...good.toolCalls,{name:'generate_speech',op:'music',isError:false}]})).toBe(false);
  fs.copyFileSync(path.join(root,'audio/sources/recording.wav'),file);expect(accepted(id)).toBe(false);fs.writeFileSync(file,voiceTone(id==='voice-word-cut'?3:4,1200));expect(accepted(id)).toBe(false);fs.writeFileSync(file,bytes);
  if(id==='voice-timed-overlays')p.tracks[0].at_sec=1.5;
  if(id==='voice-bgm-transitions')p.tracks[0].loop_crossfade_sec=0;
  if(id==='voice-word-cut')p.segments[0].word_edit.ranges=[{first:0,last:0}];
  fs.writeFileSync(project,JSON.stringify(p));fs.rmSync(path.dirname(file),{recursive:true,force:true});await audio.execute('render',{project});expect(accepted(id)).toBe(false);
},30000);

it.each(['voice-timed-overlays', 'voice-bgm-transitions', 'voice-word-cut'])('requires a saved project that reproduces the delivered audio: %s', async id => {
  seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json'), p = JSON.parse(fs.readFileSync(project, 'utf8'));
  p.schema_version = 3; p.export = { format: 'wav', channels: 1, normalize_loudness: false };
  if (id === 'voice-timed-overlays') p.tracks = [{ id: 'fx', kind: 'effect', path: 'sources/effect.wav', at_sec: 1 }, { id: 'a', kind: 'music', path: 'sources/music.wav' }, { id: 'b', kind: 'music', path: 'sources/other.wav', at_sec: 2 }];
  if (id === 'voice-bgm-transitions') { p.segments[0].volume = 0; p.tracks = [{ id: 'bg', kind: 'music', path: 'sources/music.wav', duration_sec: 4, loop: true, loop_crossfade_sec: .1, fade_in_sec: .2, fade_out_sec: .4, volume: 1 }]; }
  if (id === 'voice-word-cut') p.segments[0].word_edit = { transcript_path: 'words.json', mode: 'remove', ranges: [{ first: 1, last: 1 }] };
  fs.writeFileSync(project, JSON.stringify(p));
  const result = await audio.execute('render', { project }), file = path.join(root, 'audio', result.files[0]);
  const delivered = fs.readFileSync(file), observed = () => {
    const t = trace(id); t.voiceStudio = inspectVoiceFixture(id, root, [file]); return t;
  };
  expect(accepted(id, observed())).toBe(true);
  // Keep the correct delivery untouched; every referenced source still exists.
  // Only the saved edit diverges, which reference-existence checks cannot catch.
  const stale = structuredClone(p);
  if (id === 'voice-timed-overlays') stale.tracks[0].at_sec = 1.5;
  if (id === 'voice-bgm-transitions') stale.tracks[0].fade_out_sec = 0;
  if (id === 'voice-word-cut') delete stale.segments[0].word_edit;
  fs.writeFileSync(project, JSON.stringify(stale));
  expect(accepted(id, observed()), 'a correct delivery cannot hide a stale saved edit').toBe(false);
  const revision = path.join(root, 'audio/voice-project-2.json'); fs.writeFileSync(revision, JSON.stringify(p));
  expect(accepted(id, observed()), 'a correct saved revision may coexist with the old project').toBe(true);
  const before = fs.readdirSync(path.join(root, 'audio')).sort();
  expect(accepted(id, observed())).toBe(true);
  expect(fs.readdirSync(path.join(root, 'audio')).sort()).toEqual(before);
  expect(fs.readFileSync(file).equals(delivered)).toBe(true);
  expect(fs.readFileSync(project, 'utf8')).toBe(JSON.stringify(stale));
}, 30000);

it('rejects an undo project whose gain differs from its correct published recording', async () => {
  const id = 'voice-recorded-rumble-zh', followUp = id + '-undo'; seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json'), p = JSON.parse(fs.readFileSync(project, 'utf8'));
  p.schema_version = 2; p.processing = [{ type: 'highpass', frequency_hz: 80 }];
  p.export = { format: 'wav', channels: 1, normalize_loudness: false };
  fs.writeFileSync(project, JSON.stringify(p)); await audio.execute('render', { project });
  p.processing = []; fs.writeFileSync(project, JSON.stringify(p));
  const result = await audio.execute('render', { project }), file = path.join(root, 'audio', result.files[0]);
  const observed = () => { const t = trace(followUp); t.voiceStudio = inspectVoiceFixture(followUp, root, [file, project]); return t; };
  expect(accepted(followUp, observed())).toBe(true);
  p.segments[0].volume = .5; fs.writeFileSync(project, JSON.stringify(p));
  expect(accepted(followUp, observed()), 'undo must remain reproducible at the delivered level').toBe(false);
}, 30000);

// Portable calibration from the frozen source; official-account evaluation remains outside this edition.
it.each(['voice-recorded-noise-en', 'voice-recorded-preserve-zh'])(
  'requires the published project revision rather than an unshared correct draft: %s', async id => {
    seedVoiceFixture(id, root);
    const base = path.join(root, 'audio'), original = path.join(base, 'voice-project.json');
    if (id === 'voice-recorded-preserve-zh') {
      const stale = JSON.parse(fs.readFileSync(original, 'utf8'));
      stale.export = { format: 'wav', channels: 2 };
      fs.writeFileSync(original, JSON.stringify(stale));
    }
    const before = fs.readFileSync(original), source = fs.readFileSync(path.join(base, 'sources/recording.wav'));
    const plan = JSON.parse(before.toString());
    plan.schema_version = 2;
    plan.processing = id === 'voice-recorded-noise-en' ? [{ type: 'denoise', strength: 'standard' }] : [];
    plan.export = { format: 'wav', sample_rate: 48000, channels: 1, bit_depth: 16, normalize_loudness: false };
    const revision = path.join(base, 'conversion-revision.json'); fs.writeFileSync(revision, JSON.stringify(plan));
    const result = await audio.execute('render', { project: revision }), file = path.join(base, result.files[0]);
    const observed = (attachments: string[]) => ({ toolCalls: [{ name: 'bash', isError: false }], voiceStudio: inspectVoiceFixture(id, root, attachments) }) as VoiceTrace;
    expect(accepted(id, observed([file, revision])), 'The published saved revision reproduces the current audio.').toBe(true);
    expect(accepted(id, observed([file, original])), 'A correct unshared draft cannot rescue the delivered stale project.').toBe(false);
    expect(accepted(id, observed([file])), 'Audio without the requested project is incomplete.').toBe(false);
    expect(accepted(id, observed([file, revision]))).toBe(true);
    expect(fs.readFileSync(original)).toEqual(before); expect(fs.readFileSync(path.join(base, 'sources/recording.wav'))).toEqual(source);
  }, 30000);

it('accepts the published conversion project in its own directory and rejects an outside project', async () => {
  const id = 'voice-recorded-preserve-zh'; seedVoiceFixture(id, root);
  const base = path.join(root, 'audio'), original = path.join(base, 'voice-project.json');
  const bytes = fs.readFileSync(original), source = fs.readFileSync(path.join(base, 'sources/recording.wav'));
  const plan = JSON.parse(bytes.toString());
  plan.export = { format: 'wav', sample_rate: 48000, channels: 1, bit_depth: 16, normalize_loudness: false };
  const dir = path.join(base, 'conversion-project'); fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources/recording.wav'), source);
  const revision = path.join(dir, 'voice-project.json'); fs.writeFileSync(revision, JSON.stringify(plan));
  const result = await audio.execute('render', { project: revision }), file = path.join(dir, result.files[0]);
  const observed = (projectFile: string) => ({ toolCalls: [{ name: 'bash', isError: false }], voiceStudio: inspectVoiceFixture(id, root, [file, projectFile]) }) as VoiceTrace;
  expect(accepted(id, observed(revision)), 'The delivered project owns its relative sources regardless of directory name.').toBe(true);
  const outside = path.join(root, 'outside-project.json'); fs.writeFileSync(outside, JSON.stringify(plan));
  expect(accepted(id, observed(outside))).toBe(false);
  expect(accepted(id, observed(original)), 'The original also replays the mono recording with the new source-aware default.').toBe(true);
  expect(fs.readFileSync(original)).toEqual(bytes); expect(fs.readFileSync(path.join(base, 'sources/recording.wav'))).toEqual(source);
}, 30000);

it('calibrates a multi-segment local revision against wrong gains, order, gaps, subtitles and duplicate synthesis', async () => {
  const id = 'voice-revise-multisegment'; seedVoiceFixture(id, root);
  expect(accepted(id)).toBe(false);
  const project = path.join(root, 'audio/voice-project.json');
  const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
  plan.segments[2].volume = .5; plan.segments[4].gap_after_sec = .35;
  fs.writeFileSync(project, JSON.stringify(plan));
  const result = await audio.execute('render', { project });
  const file = path.join(root, 'audio', result.files[0]);
  const bytes = fs.readFileSync(file);
  const attachments = result.files.map((f: string) => path.join(root, 'audio', f));
  const published = () => ({ toolCalls: [{ name: 'bash', isError: false }], voiceStudio: inspectVoiceFixture(id, root, attachments) }) as VoiceTrace;
  const good = published(); expect(accepted(id, good), JSON.stringify(good.voiceStudio)).toBe(true);
  expect(accepted(id, { ...good, toolCalls: [] })).toBe(false);
  expect(accepted(id, { ...good, toolCalls: [...good.toolCalls, { name: 'generate_speech', op: 'generate', isError: false }] })).toBe(false);
  expect(accepted(id, { ...good, voiceStudio: inspectVoiceFixture(id, root, []) })).toBe(false);
  expect(accepted(id, { ...good, voiceStudio: inspectVoiceFixture(id, root, [file]) }), 'An unshared subtitle file is not a delivered subtitle.').toBe(false);
  const srt = path.join(path.dirname(file), 'captions.srt'), captions = fs.readFileSync(srt);
  fs.writeFileSync(srt, captions.toString().replace('00:00:06,150', '00:00:06,000'));
  expect(accepted(id, published())).toBe(false); fs.writeFileSync(srt, captions);
  // Render plausible but wrong outputs through the real script. Restore the
  // correct saved plan so artifact checks cannot merely trust its settings.
  for (const mutate of [
    (p: any) => { p.segments[2].volume = 1; },
    (p: any) => { [p.segments[0], p.segments[1]] = [p.segments[1], p.segments[0]]; },
    (p: any) => { p.segments[4].gap_after_sec = .2; },
    (p: any) => { p.segments.pop(); },
  ]) {
    const wrong = structuredClone(plan); mutate(wrong); fs.writeFileSync(project, JSON.stringify(wrong));
    const candidate = await audio.execute('render', { project });
    fs.writeFileSync(project, JSON.stringify(plan));
    fs.copyFileSync(path.join(root, 'audio', candidate.files[0]), file);
    expect(accepted(id, published())).toBe(false);
    fs.rmSync(path.dirname(path.join(root, 'audio', candidate.files[0])), { recursive: true });
  }
  fs.writeFileSync(file, bytes); expect(accepted(id, published())).toBe(true);
}, 30000);

it('rejects global level changes in a de-essing-only delivery with otherwise correct spectral ratios', async () => {
  const id = 'voice-deess'; seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json');
  const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
  plan.schema_version = 2; plan.processing = [{ type: 'deesser', strength: 'standard' }];
  plan.export = { format: 'wav', normalize_loudness: false };
  fs.writeFileSync(project, JSON.stringify(plan));
  const result = await audio.execute('render', { project });
  const file = path.join(root, 'audio', result.files[0]), original = fs.readFileSync(file);
  expect(accepted(id), 'Requested de-essing without an unrelated level change').toBe(true);
  const altered = path.join(root, 'audio/.level-control.wav');
  for (const { gain, valid } of [{ gain: 1.0001, valid: true }, { gain: .5, valid: false }, { gain: 2, valid: false }]) {
    fs.writeFileSync(file, original);
    const change = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-y', '-i', file,
      '-af', `volume=${gain}`, '-c:a', 'pcm_s16le', altered], { timeout: 30000, encoding: 'utf8' });
    expect(change.status).toBe(0); expect(change.stderr).toBe('');
    fs.copyFileSync(altered, file); fs.rmSync(altered);
    expect(accepted(id), `Gain ${gain}: permit PCM rounding, reject unrelated level changes`).toBe(valid);
  }
  fs.writeFileSync(file, original); expect(accepted(id)).toBe(true);
}, 60000);

it('accepts the published transcript pair despite retained duplicates and rejects a bad selected pair', () => {
  const id = 'voice-transcribe-speech'; seedVoiceFixture(id, root);
  const text = fs.readFileSync(path.resolve('test/fixtures/voice/jfk.txt'), 'utf8').trim();
  const txt = path.join(root, 'audio/transcript.txt'), srt = path.join(root, 'audio/transcript.srt');
  fs.writeFileSync(txt, text); fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:11,000\n${text}\n`);
  const duplicate = path.join(root, 'audio/transcript-copy.txt'); fs.writeFileSync(duplicate, text);
  const observed = (files?: string[]) => ({ toolCalls: [{ name: 'bash', isError: false }], voiceStudio: inspectVoiceFixture(id, root, files) }) as VoiceTrace;
  expect(accepted(id, observed()), 'Identical retained text is not a second transcription.').toBe(true);
  fs.writeFileSync(duplicate, 'an unfinished draft');
  expect(accepted(id, observed([txt, srt])), 'Only the host-published pair is the deliverable.').toBe(true);
  expect(accepted(id, observed())).toBe(false);
  expect(accepted(id, observed([duplicate, srt]))).toBe(false);
  expect(accepted(id, observed([txt]))).toBe(false);
  expect(accepted(id, observed([]))).toBe(false);
  fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:24,000\n${text}\n`);
  expect(accepted(id, observed([txt, srt]))).toBe(false);
});

it('reopens the documented conversion project and reproduces the delivered PCM without changing the original edit', async () => {
  const body = fs.readFileSync(path.join(skill, 'references/media-delivery.md'), 'utf8');
  const projects = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map(match => JSON.parse(match[1])).filter(value => value.schema_version && value.segments?.length);
  expect(projects).toHaveLength(1);
  seedVoiceFixture('voice-recorded-preserve-zh', root);
  const dir = path.join(root, 'audio'), original = path.join(dir, 'voice-project.json');
  const originalBytes = fs.readFileSync(original), source = path.join(dir, 'sources/recording.wav');
  const sourceBytes = fs.readFileSync(source);
  const converted = await audio.execute('convert', { project: original, input_path: 'sources/recording.wav', format: 'wav' });
  const saved = path.join(dir, 'conversion-project.json');
  fs.writeFileSync(saved, JSON.stringify(projects[0]));
  // Reopen only the persisted project; no convert request or render override
  // may supply missing source references or export settings.
  const rendered = await audio.execute('render', { project: saved });
  const pcm = (file: string) => {
    const result = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', '-i', file,
      '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status).toBe(0); expect(result.stderr.length).toBe(0);
    return result.stdout;
  };
  for (const result of [converted, rendered]) {
    expect(result.files.every((file: string) => !path.isAbsolute(file))).toBe(true);
    expect(result.absolute_files).toEqual(result.files.map((file: string) => path.join(dir, file)));
  }
  const [delivered] = converted.absolute_files;
  const [replay] = rendered.absolute_files;
  expect(pcm(replay)).toEqual(pcm(delivered)); expect(pcm(delivered)).toEqual(pcm(source));
  expect(rendered).toMatchObject({ sample_rate: 48000, channels: 1, duration_sec: 8 });
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, rendered.files.find((file: string) => file.endsWith('receipt.json'))), 'utf8'));
  expect(receipt.export).toMatchObject({ format: 'wav', sample_rate: 48000, channels: 1, bit_depth: 16, normalize_loudness: false });
  expect(fs.readFileSync(original)).toEqual(originalBytes); expect(fs.readFileSync(source)).toEqual(sourceBytes);
});

it.each(['voice-revise-cached', 'voice-extract-video', 'voice-convert-isolated'])(
  'evaluates the published audio in a separately named project while preserving the original: %s', async id => {
    seedVoiceFixture(id, root);
    const original = path.join(root, 'audio');
    const revision = path.join(root, 'revised-project');
    fs.cpSync(original, revision, { recursive: true });
    const project = path.join(revision, 'voice-project.json');
    let result;
    if (id === 'voice-revise-cached') {
      const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
      plan.segments[1].speed = .5;
      fs.writeFileSync(project, JSON.stringify(plan));
      result = await audio.execute('render', { project, format: 'wav' });
    } else if (id === 'voice-extract-video') {
      result = await audio.execute('extract', { project, input_path: 'sources/video.mkv' });
    } else {
      result = await audio.execute('convert', { project, input_path: 'sources/recording.wav', format: 'flac' });
    }
    const file = path.join(revision, result.files[0]);
    const published = (...files: string[]) => trace(id, undefined, publishedVoiceFiles([{ from: 'voice-studio', produced: files }]));
    expect(accepted(id, published(file, project)), 'An independently correct delivered revision may use a sibling directory').toBe(true);
    expect(accepted(id, published(project)), 'An unpublished correct audio file cannot prove delivery').toBe(false);
    const wrong = path.join(revision, 'wrong' + path.extname(file));
    fs.writeFileSync(wrong, voiceTone(4, 220));
    expect(accepted(id, published(wrong, project)), 'An unrelated published file cannot borrow the unpublished waveform').toBe(false);
    const originalCopy = path.join(revision, 'sources', path.basename(file));
    fs.copyFileSync(file, originalCopy);
    expect(accepted(id, published(originalCopy, project)), 'A source asset cannot establish an export').toBe(false);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-other-workspace-'));
    try {
      const outsideFile = path.join(outside, path.basename(file));
      fs.copyFileSync(file, outsideFile);
      const alias = path.join(revision, 'outside-alias');
      fs.symlinkSync(outside, alias, 'junction');
      expect(accepted(id, published(outsideFile, path.join(alias, path.basename(file)), project)), 'Outside and symlink-escaped audio are ineligible').toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000,
);
it.each(['voice-preserve-pauses', 'voice-export-spec', 'voice-convert-preserve'])(
  'checks one published final audio file while ignoring unpublished verification renders: %s', async id => {
    seedVoiceFixture(id, root);
    const base = path.join(root, 'audio');
    const project = path.join(base, 'voice-project.json');
    let result;
    if (id === 'voice-export-spec') {
      const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
      plan.export = { format: 'wav', sample_rate: 24000, channels: 1, bit_depth: 24, normalize_loudness: false };
      fs.writeFileSync(project, JSON.stringify(plan));
      result = await audio.execute('render', { project });
    } else {
      result = await audio.execute('convert', {
        project, input_path: 'sources/recording.wav', format: id === 'voice-convert-preserve' ? 'flac' : 'wav',
      });
    }
    const file = path.join(base, result.files[0]);
    const verification = path.join(base, 'verification' + path.extname(file));
    fs.copyFileSync(file, verification);
    expect(accepted(id, trace(id, undefined, [file, project]))).toBe(true);
    expect(accepted(id, trace(id, undefined, [file, file, project]))).toBe(true);
    expect(accepted(id, trace(id, undefined, [file, verification, project]))).toBe(false);
    fs.writeFileSync(verification, voiceTone(4, 220));
    expect(accepted(id, trace(id, undefined, [verification, project])), 'An unpublished correct render cannot rescue a wrong delivery').toBe(false);
  }, 30_000,
);
it('verifies a playable final FLAC link when only its project is attached', async () => {
  const id = 'voice-convert-preserve';
  seedVoiceFixture(id, root);
  const project = path.join(root, 'audio', 'voice-project.json');
  const result = await audio.execute('convert', { project, input_path: 'sources/recording.wav', format: 'flac' });
  const file = path.join(root, 'audio', result.files[0]);
  const link = `[Play the FLAC](${versionedChatMediaLocalUrl(file)})`;
  const delivered = (text: string, from = 'voice-studio', produced = [project]) =>
    trace(id, undefined, publishedVoiceFiles([{ from, text, produced }], { root, actorId: 'voice-studio' }));
  expect(accepted(id, delivered(link))).toBe(true);
  expect(accepted(id, delivered(link, 'voice-studio', [project, file]))).toBe(true);
  expect(accepted(id, delivered('`' + link + '`'))).toBe(false);
  expect(accepted(id, delivered(versionedChatMediaLocalUrl(file)))).toBe(false);
  expect(accepted(id, delivered(link, 'user'))).toBe(false);
  expect(accepted(id, delivered(link, 'another-agent'))).toBe(false);
  fs.renameSync(file, file + '.saved');
  expect(accepted(id, delivered(link))).toBe(false);
}, 30_000);
it('accepts a recorded-audio project link when the saved revision reproduces the delivered WAV', async () => {
  const id = 'voice-recorded-rumble-zh', actorId = 'voice-studio';
  seedVoiceFixture(id, root);
  const base = path.join(root, 'audio');
  const initial = path.join(base, 'voice-project.json');
  const plan = JSON.parse(fs.readFileSync(initial, 'utf8'));
  const project = path.join(base, '声道修订 (2).json');
  fs.writeFileSync(project, JSON.stringify({
    ...plan, schema_version: 2, processing: [{ type: 'highpass', frequency_hz: 80 }], export: { format: 'wav' },
  }));
  const result = await audio.execute('render', { project });
  const file = path.join(base, result.files[0]);
  const wav = `[试听](${versionedChatMediaLocalUrl(file)})`;
  const revision = versionChatMediaLocalUrlsInText('[可修改项目](<audio/声道修订 (2).json>)', root);
  const message = (text: string, flags = {}, produced = [file]) => ({ from: actorId, text, produced, ...flags });
  const observed = (messages: Array<ReturnType<typeof message>>) => trace(id, undefined, publishedVoiceFiles(
    messages, voiceAcceptsLinkedAudio(id) ? { root, actorId, projectLinks: true } : undefined,
  ));
  const linked = observed([message(wav + '\n' + revision, {}, [])]);
  expect(linked.voiceStudio?.projectReplay).toMatchObject({ matched: true, maxSampleError: 0 });
  expect(accepted(id, linked)).toBe(true);
  expect(accepted(id, observed([message('', {}, [file, project])]))).toBe(true);
  expect(accepted(id, observed([message(`[Project](<${project}>)`)]))).toBe(true);
  const localAlias = path.join(root, 'linked-audio');
  fs.symlinkSync(base, localAlias, 'junction');
  const attachedProject = path.join(localAlias, path.basename(project));
  const alsoLinked = observed([message(revision, {}, [file, attachedProject])]);
  expect(alsoLinked.voiceStudio?.projectReplay).toMatchObject({ matched: true, candidates: 1 });
  const different = path.join(base, 'different-gain.json');
  fs.writeFileSync(different, JSON.stringify({
    ...JSON.parse(fs.readFileSync(project, 'utf8')), segments: [{ ...plan.segments[0], volume: 0.5 }],
  }));
  const wrong = observed([message(`[Project](${versionedChatMediaLocalUrl(different)})`)]);
  expect(wrong.voiceStudio?.projectReplay).toMatchObject({ matched: false, reason: 'no-match', attempted: 1 });
  expect(accepted(id, wrong)).toBe(false);
  for (const text of [
    '',
    `\`${revision}\``,
    versionedChatMediaLocalUrl(project),
    `[Project](${versionedChatMediaLocalUrl(initial)})`,
    `[Project](${versionedChatMediaLocalUrl(path.join(base, result.files.find((name: string) => name.endsWith('plan-snapshot.json'))))})`,
    `[Project](${versionedChatMediaLocalUrl(path.join(base, 'missing.json'))})`,
  ]) expect(accepted(id, observed([message(text)])), text).toBe(false);
  for (const flags of [{ from: 'user' }, { from: 'another-agent' }, { deleted_at: 1 }, { dispatch: true }]) {
    expect(accepted(id, observed([message('', {}, [file]), message(revision, flags, [])]))).toBe(false);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-project-link-outside-'));
  try {
    const foreign = path.join(outside, 'voice-project.json');
    fs.copyFileSync(project, foreign);
    const alias = path.join(base, 'foreign');
    fs.symlinkSync(outside, alias, 'junction');
    for (const target of [foreign, path.join(alias, path.basename(foreign))]) {
      const text = `[Project](${versionedChatMediaLocalUrl(target)})`;
      expect(publishedVoiceFiles([message(text)], { root, actorId, projectLinks: true })).toEqual([file]);
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}, 30_000);
it('rejects an edge-only trim with changed levels even when timing and all phrases match', async () => {
  const id = 'voice-trim-edges';
  seedVoiceFixture(id, root);
  const project = path.join(root, 'audio/voice-project.json');
  const plan = JSON.parse(fs.readFileSync(project, 'utf8'));
  plan.schema_version = 2;
  plan.processing = [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: .05 }];
  plan.export = { format: 'wav', normalize_loudness: false };
  fs.writeFileSync(project, JSON.stringify(plan));
  const preserved = await audio.execute('render', { project });
  const file = path.join(root, 'audio', preserved.files[0]);
  expect(accepted(id, trace(id, undefined, [file, project]))).toBe(true);
  const altered = path.join(root, 'audio', '.gain-control.wav');
  const change = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, [
    '-v', 'error', '-nostdin', '-i', file, '-af', 'volume=0.5', '-c:a', 'pcm_s16le', altered,
  ], { timeout: 30_000, encoding: 'utf8' });
  expect(change.status).toBe(0);
  expect(change.stderr).toBe('');
  fs.renameSync(altered, file);
  const adjusted = trace(id, undefined, [file, project]);
  expect(voiceChecks(id, adjusted).find(check => check.id === 'acceptance:voice-outcome')?.pass).toBe(false);
  expect(accepted(id, adjusted)).toBe(false);
}, 30_000);
