import { spawn } from 'node:child_process';
import { bundledFfmpegPaths } from './bundled-runtime';
import { killProcessTree } from '../../core-agent/src/sandbox/executor';

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export function ttsWavConversionAvailable(format: string): boolean {
  return ['wav', 'pcm'].includes(format) || (['mp3', 'opus'].includes(format) && !!bundledFfmpegPaths().ffmpeg);
}

function pcmFromWav(audio: Buffer): Buffer | undefined {
  if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let validFormat = false;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > audio.length - start) return undefined;
    const kind = audio.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ' && size >= 16) validFormat = audio.readUInt16LE(start) === 1
      && audio.readUInt16LE(start + 2) === 1 && audio.readUInt32LE(start + 4) === 24000
      && audio.readUInt16LE(start + 14) === 16;
    if (kind === 'data') return validFormat && size > 0 && size % 2 === 0 ? audio.subarray(start, start + size) : undefined;
    offset = start + size + (size % 2);
  }
  return undefined;
}

/** Gemini unary audio is a 24kHz mono PCM WAV. Conversion changes the container
 * only; the provider transcript and synthesis controls remain untouched. */
export async function convertTtsWav(audio: Buffer, format: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  if (signal?.aborted) return undefined;
  const pcm = pcmFromWav(audio);
  if (!pcm) return undefined;
  if (format === 'wav') return audio;
  if (format === 'pcm') return pcm;
  const bin = bundledFfmpegPaths().ffmpeg;
  if (!bin || !['mp3', 'opus'].includes(format)) return undefined;
  return new Promise(resolve => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-vn',
      '-c:a', format === 'mp3' ? 'libmp3lame' : 'libopus', '-f', format === 'mp3' ? 'mp3' : 'opus', 'pipe:1'],
    { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (value?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value);
    };
    const abort = () => { try { killProcessTree(child, 'SIGKILL'); } catch { /* Already exited. */ } finish(); };
    const timer = setTimeout(abort, 30_000); timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      if ((bytes += chunk.length) > MAX_AUDIO_BYTES) { abort(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => finish());
    child.on('close', code => finish(code === 0 && bytes ? Buffer.concat(chunks, bytes) : undefined));
    child.stdin.end(audio);
  });
}
