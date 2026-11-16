import { expect, it } from 'vitest';
import { convertTtsWav, ttsWavConversionAvailable } from '../../../src/main/util/tts-audio';

function wav() {
  const data = Buffer.alloc(4800); const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
it('preserves WAV containers and extracts only PCM data', async () => {
  expect(await convertTtsWav(wav(), 'wav')).toEqual(wav());
  expect(await convertTtsWav(wav(), 'pcm')).toEqual(Buffer.alloc(4800));
});
it('uses the existing local media runtime for real MP3 and Opus encoding', async () => {
  expect(ttsWavConversionAvailable('mp3')).toBe(true);
  const mp3 = await convertTtsWav(wav(), 'mp3'); expect(mp3?.subarray(0, 3).toString()).toBe('ID3');
  const opus = await convertTtsWav(wav(), 'opus'); expect(opus?.subarray(0, 4).toString()).toBe('OggS');
});
it('does not encode invalid containers or start a cancelled conversion', async () => {
  expect(await convertTtsWav(Buffer.from('JSON error'), 'mp3')).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  expect(await convertTtsWav(wav(), 'mp3', controller.signal)).toBeUndefined();
});
