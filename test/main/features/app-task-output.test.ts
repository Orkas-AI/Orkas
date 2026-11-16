import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AppOutputUnverifiedError, markPublishedOutputs, isAppDeliverable, isAppTextDeliverable } from '../../../src/main/features/web_apps/task-output';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-delivery-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it.each(['image', 'video', 'audio'] as const)('rejects text, empty and renamed fake %s outputs', async kind => {
  for (const [name, bytes] of [['reply.txt', 'A plan'], [kind === 'image' ? 'fake.png' : kind === 'video' ? 'fake.mp4' : 'fake.wav', 'Not media'], ['empty.mp4', '']]) {
    const file = path.join(root, name); await fs.writeFile(file, bytes);
    expect(await isAppDeliverable(file, kind)).toBe(false);
  }
});
it('accepts actual media streams and rejects a valid stream of the wrong requested type', async () => {
  const ffmpeg = bundledFfmpegPaths().ffmpeg!;
  for (const [name, args, kind] of [
    ['image.png', ['-f', 'lavfi', '-i', 'color=red:s=16x16', '-frames:v', '1'], 'image'],
    ['video.mp4', ['-f', 'lavfi', '-i', 'color=red:s=16x16:r=10:d=0.2', '-c:v', 'libx264'], 'video'],
    ['audio.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2'], 'audio'],
  ] as const) {
    const file = path.join(root, name), run = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, file], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(await isAppDeliverable(file, kind)).toBe(true);
    expect(await isAppDeliverable(file, kind === 'audio' ? 'video' : 'audio')).toBe(false);
  }
});
it('accepts usable design sources without imposing canvas or page proportions', async()=>{
 const svg=path.join(root,'design.svg'),pdf=path.join(root,'design.pdf'),psd=path.join(root,'design.psd');
 await fs.writeFile(svg,'<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="10000"/>');
 const {PDFDocument}=await import('pdf-lib');const document=await PDFDocument.create();document.addPage([400,500]);document.addPage([100,100]);await fs.writeFile(pdf,await document.save());
 const {writePsdBuffer}=await import('ag-psd');await fs.writeFile(psd,writePsdBuffer({width:400,height:500,children:[]}));
 for(const file of [svg,pdf,psd])expect(await isAppDeliverable(file,'image')).toBe(true);
});
it('validates raw JSON and subtitle syntax without mistaking a plan or fenced prose for the selected text format', () => {
  expect(isAppTextDeliverable('{"captions":[]}', 'json')).toBe(true);
  expect(isAppTextDeliverable('```json\n{}\n```', 'json')).toBe(false);
  expect(isAppTextDeliverable('1\n00:00:00,000 --> 00:00:01,000\nCaption', 'srt')).toBe(true);
  for (const text of ['The subtitles are complete.', '1\n00:00:02,000 --> 00:00:01,000\nCaption', '1\n00:00:00,000 --> 00:00:01,000']) expect(isAppTextDeliverable(text, 'srt')).toBe(false);
});
it('bounds text inspection, accepts ordinary text independently of syntax preference and honors cancellation before IO', async()=>{
 const text=path.join(root,'large.json');await fs.writeFile(text,' '.repeat(2*1024*1024+1));
 await expect(isAppDeliverable(text,'text')).rejects.toBeInstanceOf(AppOutputUnverifiedError);
 await fs.writeFile(text,'Ordinary transcript.');expect(await isAppDeliverable(text,'text')).toBe(true);
 expect(await isAppDeliverable(path.join(root,'absent.mp4'),'video',AbortSignal.abort())).toBe(false);
});

it('projects only authoritative published paths, preserving same-name files and absent legacy metadata',()=>{
  const files=[{path:'/run/final/audio.mp3',name:'audio.mp3'},{path:'/run/temp/audio.mp3',name:'audio.mp3'},{path:'/run/receipt.json',name:'receipt.json'}];
  expect(markPublishedOutputs(files,['/run/final/audio.mp3','/foreign/audio.mp3']).map(f=>f.published)).toEqual([true,false,false]);
  expect(markPublishedOutputs(files,[]).map(f=>f.published)).toEqual([false,false,false]);
  expect(markPublishedOutputs(files,undefined)).toEqual(files);
  expect(files.every(f=>!Object.hasOwn(f,'published'))).toBe(true);
});
