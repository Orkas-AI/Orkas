import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
const require = createRequire(import.meta.url);
const audio = require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root: string, project: string, prior: NodeJS.ProcessEnv;
beforeEach(async () => { prior = { ...process.env }; Object.assign(process.env, bundledRuntimeEnv()); root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-compose-'))); project = path.join(root, 'voice-project.json'); });
afterEach(async () => { process.env = prior; await fs.rm(root, { recursive: true, force: true }); });
function ff(args: string[]) { const p = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v', 'error', '-nostdin', ...args], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); expect(p.status, p.stderr.toString()).toBe(0); expect(p.stderr.length).toBe(0); return p.stdout; }
async function tone(file: string, hz: number, duration: number, extra: string[] = []) { ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${duration}`, ...extra, path.join(root, file)]); }
async function save(extra: any = {}) { await fs.writeFile(project, JSON.stringify({ schema_version: 3, roles: {}, segments: [{ id: 'voice', path: 'voice.wav' }], export: { format: 'wav', normalize_loudness: false }, ...extra })); }
const call = (op: string, fields = {}) => audio.execute(op, { project, ...fields });
async function render() { const result = await call('render'); const file = path.join(root, result.files[0]); return { result, file, pcm: ff(['-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']) }; }
function amp(b: Buffer, at: number, hz: number, seconds = .1) { const from = Math.round(at * 48000), n = Math.round(seconds * 48000); let re = 0, im = 0; for (let i = 0; i < n; i++) { const v = b.readFloatLE((from + i) * 4); re += v * Math.cos(2 * Math.PI * hz * i / 48000); im += v * Math.sin(2 * Math.PI * hz * i / 48000); } return Math.hypot(re, im) * 2 / n; }
it('places effects and two music tracks without interrupting narration', async () => {
  await tone('voice.wav', 660, 3); await tone('effect.wav', 1200, .3); await tone('music.wav', 220, 1); await tone('other.wav', 330, 1);
  await save({ tracks: [{ id: 'fx', kind: 'effect', path: 'effect.wav', at_sec: 1 }, { id: 'm1', kind: 'music', path: 'music.wav' }, { id: 'm2', kind: 'music', path: 'other.wav', at_sec: 2.5 }] });
  const before = await fs.readFile(project), { result, pcm } = await render(); expect(result.duration_sec).toBeCloseTo(3.5, 3);
  expect(amp(pcm, .3, 1200)).toBeLessThan(.0001); expect(amp(pcm, 1.1, 1200)).toBeGreaterThan(.1); expect(amp(pcm, 1.6, 1200)).toBeLessThan(.0001);
  expect(amp(pcm, .2, 660)).toBeCloseTo(amp(pcm, 1.1, 660), 3); expect(amp(pcm, 2.7, 330)).toBeGreaterThan(.01); expect(amp(pcm, 1.8, 330)).toBeLessThan(.0001); expect(await fs.readFile(project)).toEqual(before);
});
it('smooths loop boundaries and controls music-only fades', async () => {
  await tone('voice.wav', 660, 4, ['-af', 'volume=0']); await tone('music.wav', 223.25, .7);
  const track = { id: 'bg', kind: 'music', path: 'music.wav', duration_sec: 4, loop: true, volume: 1 };
  await save({ tracks: [track] }); const hard = await render();
  await save({ tracks: [{ ...track, loop_crossfade_sec: .1, fade_in_sec: .2, fade_out_sec: .4 }] }); const smooth = await render();
  const jump = (b: Buffer) => { let max = 0; for (let i = 1; i < b.length / 4; i++) max = Math.max(max, Math.abs(b.readFloatLE(i * 4) - b.readFloatLE((i - 1) * 4))); return max; };
  expect(jump(smooth.pcm)).toBeLessThan(jump(hard.pcm) * .3); expect(amp(smooth.pcm, .005, 223.25, .03)).toBeLessThan(.03); expect(amp(smooth.pcm, 3.93, 223.25, .04)).toBeLessThan(.03); expect(smooth.result.duration_sec).toBe(4); expect(await fs.readFile(hard.file)).toBeDefined();
});
it('crossfades supplied music while keeping narration gain unchanged', async () => {
  await tone('voice.wav', 660, 3); await tone('a.wav', 220, 2); await tone('b.wav', 330, 2);
  await save({ tracks: [{ id: 'a', kind: 'music', path: 'a.wav', volume: 1, fade_out_sec: 1 }, { id: 'b', kind: 'music', path: 'b.wav', at_sec: 1, volume: 1, fade_in_sec: 1 }] });
  const { pcm } = await render(); expect(amp(pcm, 1.45, 220)).toBeCloseTo(.0625, 2); expect(amp(pcm, 1.45, 330)).toBeCloseTo(.0625, 2); expect(amp(pcm, 1.45, 660)).toBeCloseTo(.125, 3);
});
it('anchors tracks after silence edits and excludes effects from the ducking key', async () => {
  await tone('voice.wav', 660, 4, ['-af', "volume='if(between(t,1,2),1,0)':eval=frame"]); await tone('music.wav', 220, 4); await tone('fx.wav', 1200, .4);
  await save({ processing: [{ type: 'silence', mode: 'edges', min_silence_sec: .3, padding_sec: 0 }], tracks: [{ id: 'fx', kind: 'effect', path: 'fx.wav', at_sec: 1.6 }, { id: 'bg', kind: 'music', path: 'music.wav', duration_sec: 3, volume: 1, duck: { release_ms: 20 } }] });
  const { pcm, result } = await render(); expect(result.duration_sec).toBeCloseTo(3, 2); expect(amp(pcm, 1.7, 1200)).toBeGreaterThan(.1); expect(amp(pcm, .3, 220) / amp(pcm, 1.7, 220)).toBeLessThan(.4); expect(amp(pcm, 1.7, 220)).toBeGreaterThan(.1); expect(result.captions_complete).toBe(false);
});
it.each([
  { tracks: [{ id: 'x', kind: 'effect', path: 'fx.wav', at_sec: -1 }] },
  { tracks: [{ id: 'x', kind: 'effect', path: 'fx.wav', duck: true }] },
  { tracks: [{ id: 'x', kind: 'music', path: 'fx.wav', loop_crossfade_sec: .2 }] },
  { tracks: [{ id: 'x', kind: 'music', path: 'fx.wav', duration_sec: Infinity }] },
  { tracks: [{ id: 'x', kind: 'music', path: 'fx.wav', at_sec: 14399, duration_sec: 2 }] },
  { tracks: Array.from({ length: 33 }, (_, i) => ({ id: String(i), kind: 'effect', path: 'fx.wav' })) },
  { schema_version: 2, tracks: [{ id: 'x', kind: 'effect', path: 'fx.wav' }] },
])('rejects invalid/over-budget composition without partial publish: %j', async change => {
  await tone('voice.wav', 660, 1); const source = await fs.readFile(path.join(root, 'voice.wav')); await save(change); await expect(call('render')).rejects.toBeDefined(); expect(await fs.readFile(path.join(root, 'voice.wav'))).toEqual(source); expect((await fs.readdir(root)).filter(p => p.startsWith('export-') || p.startsWith('.voice-render-') || p === '.voice-lock')).toEqual([]);
});
it('keeps conversion independent of missing composition and word timing files', async () => {
  await tone('voice.wav', 660, 1); await save({ tracks: [{ id: 'missing', kind: 'music', path: 'absent.wav' }], segments: [{ id: 'edited', path: 'voice.wav', word_edit: { transcript_path: 'missing.json', mode: 'remove', ranges: [{ first: 1, last: 1 }] } }] }); delete process.env.ORKAS_WHISPER_MODEL; expect((await call('convert', { input_path: 'voice.wav', format: 'flac' })).duration_sec).toBe(1);
});
it('cuts source-bound transcript selections and rejects stale timing', async () => {
  await tone('voice.wav', 660, 3); const source = await fs.readFile(path.join(root, 'voice.wav'));
  const t = { schema_version: 1, granularity: 'word', timing: 'estimated', source_sha256: createHash('sha256').update(source).digest('hex'), segments: [{ start_sec: 0, end_sec: 1, text: 'one' }, { start_sec: 1, end_sec: 2, text: 'two' }, { start_sec: 2, end_sec: 3, text: 'three' }] }; await fs.writeFile(path.join(root, 'words.json'), JSON.stringify(t));
  await save({ segments: [{ id: 'cut', path: 'voice.wav', word_edit: { transcript_path: 'words.json', mode: 'remove', ranges: [{ first: 1, last: 1 }] } }] });
  const { result, file } = await render(); expect(result.duration_sec).toBe(2); expect(result.captions_complete).toBe(false); expect(await fs.readFile(path.join(root, 'voice.wav'))).toEqual(source);
  await tone('changed.wav', 880, 3); await fs.copyFile(path.join(root, 'changed.wav'), path.join(root, 'voice.wav')); await expect(call('render')).rejects.toMatchObject({ code: 'E_TRANSCRIPT_STALE' }); expect(await fs.readFile(file)).toBeDefined();
});
it.each([{ first: -1, last: 0 }, { first: 2, last: 1 }, { first: 0, last: 99 }])('rejects invalid transcript selections: %j', async range => {
  await tone('voice.wav', 660, 1); const b = await fs.readFile(path.join(root, 'voice.wav'));
  await fs.writeFile(path.join(root, 'words.json'), JSON.stringify({ schema_version: 1, granularity: 'word', timing: 'estimated', source_sha256: createHash('sha256').update(b).digest('hex'), segments: [{ start_sec: 0, end_sec: .5, text: 'word' }] }));
  await save({ segments: [{ id: 'c', path: 'voice.wav', word_edit: { transcript_path: 'words.json', mode: 'keep', ranges: [range] } }] }); await expect(call('render')).rejects.toMatchObject({ code: 'E_WORD_EDIT' }); expect((await fs.readdir(root)).some(f => f.startsWith('export-'))).toBe(false);
});
it.each([{ language: 'en', file: 'jfk.wav' }, { language: 'zh', file: 'thchs30-D11_750.wav' }])('transcribes real $language word estimates and renders selected units', async input => {
  await fs.copyFile(path.resolve('test/fixtures/voice', input.file), path.join(root, 'voice.wav')); await save();
  const r = await call('transcribe', { input_path: 'voice.wav', language: input.language, granularity: 'word' }), transcript_path = r.files.find((f: string) => f.endsWith('.json'));
  const t = JSON.parse(await fs.readFile(path.join(root, transcript_path), 'utf8')); expect(t.granularity).toBe('word'); expect(t.timing).toBe('estimated'); expect(t.segments.length).toBeGreaterThan(5);
  const source = await call('probe', { input_path: 'voice.wav' }); t.segments.forEach((s: any, i: number) => { expect(s.end_sec).toBeGreaterThan(s.start_sec); expect(s.start_sec).toBeGreaterThanOrEqual(i ? t.segments[i - 1].end_sec : 0); expect(s.end_sec).toBeLessThanOrEqual(source.duration_sec + .05); });
  await save({ segments: [{ id: 'selection', path: 'voice.wav', word_edit: { transcript_path, mode: 'keep', ranges: [{ first: 1, last: 3 }] } }] }); const result = await render(); expect(result.result.duration_sec).toBeCloseTo(t.segments[3].end_sec - t.segments[1].start_sec, 3);
}, 60000);

it('applies word removal before speed/cleanup and preserves the retained waveform regions', async () => {
  // Three distinct frequencies expose a wrong cut even when duration is correct.
  ff(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-filter_complex','[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]','-map','[out]',path.join(root,'voice.wav')]);
  const b = await fs.readFile(path.join(root,'voice.wav'));
  await fs.writeFile(path.join(root,'words.json'),JSON.stringify({schema_version:1,granularity:'word',timing:'estimated',source_sha256:createHash('sha256').update(b).digest('hex'),segments:[{start_sec:0,end_sec:1,text:'first'},{start_sec:1,end_sec:2,text:'remove'},{start_sec:2,end_sec:3,text:'last'}]}));
  await save({segments:[{id:'cut',path:'voice.wav',word_edit:{transcript_path:'words.json',mode:'remove',ranges:[{first:1,last:1}]}}],processing:[{type:'highpass',frequency_hz:80}]});
  delete process.env.ORKAS_WHISPER_MODEL;
  const {pcm,result}=await render();expect(result.duration_sec).toBe(2);expect(amp(pcm,.2,330)).toBeGreaterThan(.1);expect(amp(pcm,1.2,880)).toBeGreaterThan(.1);expect(amp(pcm,1.2,660)).toBeLessThan(.001);
  const receipt=JSON.parse(await fs.readFile(path.join(root,result.files.find((f:string)=>f.endsWith('receipt.json'))),'utf8'));
  expect(receipt.word_edits[0].time_map).toEqual([{input_start_sec:0,input_end_sec:1,output_start_sec:0,output_end_sec:1},{input_start_sec:2,input_end_sec:3,output_start_sec:1,output_end_sec:2}]);
  expect(await fs.readFile(path.join(root,'voice.wav'))).toEqual(b);
});
it.each([
  { mode:'keep',ranges:[{first:0,last:0},{first:2,last:3}],frequencies:[330,660,880] },
  { mode:'remove',ranges:[{first:0,last:0},{first:2,last:2}],frequencies:[440,880] },
])('preserves order and content across disjoint word $mode selections',async selection=>{
  ff([...[330,440,660,880].flatMap(hz=>['-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=48000:duration=1`]),'-filter_complex','[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[out]','-map','[out]',path.join(root,'voice.wav')]);
  const source=await fs.readFile(path.join(root,'voice.wav'));
  const transcript={schema_version:1,granularity:'word',timing:'estimated',source_sha256:createHash('sha256').update(source).digest('hex'),segments:[0,1,2,3].map(i=>({text:String(i),start_sec:i,end_sec:i+1}))};
  await fs.writeFile(path.join(root,'words.json'),JSON.stringify(transcript));
  await save({segments:[{id:'selection',path:'voice.wav',word_edit:{transcript_path:'words.json',mode:selection.mode,ranges:selection.ranges}}]});
  const {result,pcm,file}=await render();expect(result.duration_sec).toBe(selection.frequencies.length);
  selection.frequencies.forEach((hz,i)=>{expect(amp(pcm,i+.2,hz)).toBeGreaterThan(.12);for(const other of [330,440,660,880].filter(f=>f!==hz))expect(amp(pcm,i+.2,other)).toBeLessThan(.001);});
  const previous=await fs.readFile(file);
  await save({segments:[{id:'empty',path:'voice.wav',word_edit:{transcript_path:'words.json',mode:'remove',ranges:[{first:0,last:3}]}}]});
  await expect(call('render')).rejects.toMatchObject({code:'E_WORD_EDIT'});
  expect(await fs.readFile(file)).toEqual(previous);expect(await fs.readFile(path.join(root,'voice.wav'))).toEqual(source);
  expect((await fs.readdir(root)).filter(n=>n.startsWith('.voice-render-')||n==='.voice-lock')).toEqual([]);
});
it('keeps mix headroom until final normalization rather than clipping overlapping tracks',async()=>{
  await tone('voice.wav',660,2);
  await save({segments:[{id:'voice',path:'voice.wav',volume:4}],tracks:[{id:'a',kind:'music',path:'voice.wav',volume:4},{id:'b',kind:'effect',path:'voice.wav',volume:4}],export:{format:'wav',normalize_loudness:true}});
  const {result,pcm}=await render();expect(result.duration_sec).toBe(2);
  const fundamental=amp(pcm,.5,660);expect(fundamental).toBeGreaterThan(.05);
  // Clipping the 1.5-peak intermediate creates an audible third harmonic;
  // loudness normalization afterward cannot remove that distortion.
  expect(amp(pcm,.5,1980)/fundamental).toBeLessThan(.002);
});
it('preserves untimed ASR punctuation without inventing another editable interval', () => {
  const words=require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/word-edits.js');
  expect(words.fromSegments([{start_sec:0,end_sec:.5,text:'你好'},{start_sec:.5,end_sec:.5,text:'，'},{start_sec:.5,end_sec:1,text:'世界'}],1)).toEqual([{start_sec:0,end_sec:.5,text:'你好，'},{start_sec:.5,end_sec:1,text:'世界'}]);
  expect(()=>words.fromSegments([{start_sec:0,end_sec:0,text:'no usable timing'}],1)).toThrow();
  expect(()=>words.fromSegments([{start_sec:0,end_sec:.6,text:'a'},{start_sec:.5,end_sec:1,text:'b'}],1)).toThrow();
});
it('refuses a non-media track and leaves no network or partial output', async () => {
  const {createServer}=await import('node:http'); let requests=0;
  const server=createServer((_req,res)=>{requests++;res.end('unexpected');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    await tone('voice.wav',660,1);const port=(server.address() as {port:number}).port;
    await fs.writeFile(path.join(root,'remote.m3u'),`#EXTM3U\n#EXTINF:1,x\nhttp://127.0.0.1:${port}/input.wav\n`);
    await save({tracks:[{id:'bad',kind:'music',path:'remote.m3u'}]});await expect(call('render')).rejects.toBeDefined();expect(requests).toBe(0);
    expect((await fs.readdir(root)).filter(n=>n.startsWith('export-')||n.startsWith('.voice-render-')||n==='.voice-lock')).toEqual([]);
  } finally {await new Promise<void>(r=>server.close(()=>r()));}
});
it('cancels a running track render, preserves earlier exports and can resume local work', async () => {
  await tone('voice.wav',660,1);await tone('bg.wav',220,30);await save();const first=await render(),before=await fs.readFile(first.file);
  await save({tracks:[{id:'bg',kind:'music',path:'bg.wav',duration_sec:60,loop:true,loop_crossfade_sec:.1}]});
  const abort=new AbortController(),pending=audio.execute('render',{project},abort.signal).then(()=>null,(e:any)=>e);
  let active=false;
  for(let i=0;i<300;i++){const dirs=(await fs.readdir(root)).filter(n=>n.startsWith('.voice-render-'));for(const d of dirs)if((await fs.readdir(path.join(root,d))).some(n=>n.startsWith('track-'))){active=true;break;}if(active)break;await new Promise(r=>setTimeout(r,5));}
  abort.abort();expect(active).toBe(true);expect(await pending).toMatchObject({code:'E_CANCELLED'});expect(await fs.readFile(first.file)).toEqual(before);
  expect((await fs.readdir(root)).filter(n=>n==='.voice-lock'||n.startsWith('.voice-render-'))).toEqual([]);
  await save({tracks:[{id:'bg',kind:'music',path:'bg.wav',duration_sec:1}]});expect((await render()).result.duration_sec).toBe(1);
});
it('keeps cached speech identity through track and transition changes', async () => {
  const plan:any={schema_version:3,roles:{n:{route_ref:'r',voice_ref:'v',language:'en'}},segments:[{id:'line',role:'n',text:'Keep this line.'}]};
  await fs.writeFile(project,JSON.stringify(plan));const begun=await call('begin',{segment_id:'line'});await tone(path.basename(begun.request.output_path),660,1);await call('record',{segment_id:'line',key:begun.key});
  await tone('bg.wav',220,1);plan.tracks=[{id:'bg',kind:'music',path:'bg.wav',fade_out_sec:.3}];await fs.writeFile(project,JSON.stringify(plan));
  expect((await call('status')).segments[0]).toMatchObject({key:begun.key,status:'ready'});await expect(call('begin',{segment_id:'line'})).rejects.toMatchObject({code:'E_ATTEMPT_EXISTS'});
});
it('requires explicit extraction before using media with several audio streams', async () => {
  await tone('voice.wav',660,1);await tone('second.wav',880,1);
  ff(['-i',path.join(root,'voice.wav'),'-i',path.join(root,'second.wav'),'-map','0:a','-map','1:a','-c:a','copy',path.join(root,'multi.mkv')]);
  await save({tracks:[{id:'ambiguous',kind:'music',path:'multi.mkv'}]});await expect(call('render')).rejects.toMatchObject({code:'E_COMPOSITION'});
  await expect(call('transcribe',{input_path:'multi.mkv',granularity:'word'})).rejects.toMatchObject({code:'E_AUDIO_TRACK'});
  expect((await fs.readdir(root)).some(n=>n.startsWith('transcript-')||n.startsWith('export-')||n.startsWith('.voice-render-'))).toBe(false);
});
it('rejects unsafe track aliases and a too-short source crossfade while preserving the previous export', async () => {
  await tone('voice.wav',660,1);await save();const previous=await render(),bytes=await fs.readFile(previous.file);
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'voice-track-outside-'));
  try {await fs.copyFile(path.join(root,'voice.wav'),path.join(outside,'track.wav'));await fs.symlink(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
    await save({tracks:[{id:'escape',kind:'music',path:'escape/track.wav'}]});await expect(call('render')).rejects.toMatchObject({code:'E_PATH'});
    await save({tracks:[{id:'badloop',kind:'music',path:'voice.wav',duration_sec:2,loop:true,loop_crossfade_sec:.5}]});await expect(call('render')).rejects.toMatchObject({code:'E_COMPOSITION'});
    expect(await fs.readFile(previous.file)).toEqual(bytes);expect((await fs.readdir(root)).some(n=>n.startsWith('.voice-render-')||n==='.voice-lock')).toBe(false);
  } finally {await fs.rm(outside,{recursive:true,force:true});}
});
it('bounds the whole schema-3 render and preserves progress when a later stage stalls', async () => {
  await tone('voice.wav',660,1);await tone('bg.wav',220,1);await save();const previous=await render(),bytes=await fs.readFile(previous.file);
  await save({tracks:[{id:'bg',kind:'music',path:'bg.wav'}]});
  const composition=require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/composition.js');
  let entered!:()=>void,aborted=false;const started=new Promise<void>(r=>{entered=r;});
  const spy=vi.spyOn(composition,'compose').mockImplementation(async (...args:any[])=>{
    const signal=args[5] as AbortSignal;expect(signal).toBeInstanceOf(AbortSignal);return new Promise((_r,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});entered();});
  });
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try {
    const pending=call('render'),rejected=expect(pending).rejects.toMatchObject({code:'E_TIMEOUT'});
    await started;await vi.advanceTimersByTimeAsync(29*60*1000);expect(aborted).toBe(false);await vi.advanceTimersByTimeAsync(60*1000);await rejected;expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);expect(await fs.readFile(previous.file)).toEqual(bytes);
    expect((await fs.readdir(root)).some(n=>n.startsWith('.voice-render-')||n==='.voice-lock')).toBe(false);
  } finally {spy.mockRestore();vi.useRealTimers();}
});

// A legal timing revision can arrive while rendering. The output may use only the
// transcript bytes whose identity the receipt attests, or refuse this attempt.
it('rejects a timing revision replaced after metadata read and preserves earlier exports', async () => {
  await tone('voice.wav', 660, 3);
  const source = await fs.readFile(path.join(root, 'voice.wav'));
  const timing = { schema_version: 1, granularity: 'word', timing: 'estimated',
    source_sha256: createHash('sha256').update(source).digest('hex'),
    segments: [{ start_sec: 0, end_sec: 1, text: 'first' }, { start_sec: 1, end_sec: 3, text: 'second' }] };
  const transcript = path.join(root, 'words.json');
  await fs.writeFile(transcript, JSON.stringify(timing));
  await save({ segments: [{ id: 'cut', path: 'voice.wav', word_edit: {
    transcript_path: 'words.json', mode: 'keep', ranges: [{ first: 0, last: 0 }] } }] });
  const prior = await render(), priorBytes = await fs.readFile(prior.file);
  const published = (await fs.readdir(root)).filter(name => name.startsWith('export-')).sort();
  const originalRead = fs.readFile.bind(fs);
  let replaced = false;
  const replacement = { ...timing, segments: [{ start_sec: 0, end_sec: 2, text: 'first' },
    { start_sec: 2, end_sec: 3, text: 'second' }] };
  const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
    const bytes = await (originalRead as any)(...args);
    if (!replaced && String(args[0]) === transcript) {
      replaced = true;
      await fs.writeFile(transcript, JSON.stringify(replacement));
    }
    return bytes;
  });
  try { await expect(call('render')).rejects.toMatchObject({ code: 'E_TRANSCRIPT_STALE' }); }
  finally { spy.mockRestore(); }
  expect(replaced).toBe(true);
  expect(await fs.readFile(prior.file)).toEqual(priorBytes);
  expect((await fs.readdir(root)).filter(name => name.startsWith('export-')).sort()).toEqual(published);
  expect((await fs.readdir(root)).some(name => name.startsWith('.voice-render-'))).toBe(false);
  // The current revision remains usable without retranscribing or changing the recording.
  const current = await render();
  expect(current.result.duration_sec).toBe(2);
  expect(await fs.readFile(path.join(root, 'voice.wav'))).toEqual(source);
});
