import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { seedVoiceFixture, inspectVoiceFixture, voiceChecks, voiceTone, type VoiceTrace } from '../../../eval/model-eval/regression/voice-studio-fixtures';

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

function trace(id: string, calls: any[] = [{ name: 'bash', isError: false }]) { return { toolCalls: calls, voiceStudio: inspectVoiceFixture(id, root) } as VoiceTrace; }
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
  const selected=trace(id);selected.voiceStudio=inspectVoiceFixture(id,root,[file]);expect(accepted(id,selected)).toBe(true);
  selected.voiceStudio=inspectVoiceFixture(id,root,[draft]);expect(accepted(id,selected)).toBe(false);
  selected.voiceStudio=inspectVoiceFixture(id,root,[]);expect(accepted(id,selected)).toBe(false);fs.rmSync(draft);
  for (const wrong of [voiceTone(8), Buffer.alloc(44)]) { fs.writeFileSync(file, wrong); expect(accepted(id)).toBe(false); }
  fs.writeFileSync(file, bytes);
  if (id === recordedCases[1]) {
    const followUp = 'voice-recorded-rumble-zh-undo'; expect(accepted(followUp)).toBe(false);
    p.processing = []; fs.writeFileSync(project, JSON.stringify(p));
    const undone=await audio.execute('render', { project, format: 'wav' }); expect(accepted(followUp)).toBe(true);
    const final=path.join(root,'audio',undone.files[0]),extra=path.join(root,'audio/retained-intermediate.wav');fs.writeFileSync(extra,voiceTone(8,1200));
    const selectedUndo=trace(followUp);selectedUndo.voiceStudio=inspectVoiceFixture(followUp,root,[final]);expect(accepted(followUp,selectedUndo)).toBe(true);
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
  const observed = () => { const t = trace(followUp); t.voiceStudio = inspectVoiceFixture(followUp, root, [file]); return t; };
  expect(accepted(followUp, observed())).toBe(true);
  p.segments[0].volume = .5; fs.writeFileSync(project, JSON.stringify(p));
  expect(accepted(followUp, observed()), 'undo must remain reproducible at the delivered level').toBe(false);
}, 30000);
