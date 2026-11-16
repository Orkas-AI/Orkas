'use strict';

const MAX_PIXELS = 4_194_304;
const MAX_PSD_BYTES = 134_217_728;

/** Validate the bounded private writer subset before decoding. Authoring and
 * layer/source verification stay in the Skill; the host compares this merged
 * preview with its current evidence without rewriting editable PSD bytes.
 * https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/ */
function decodePsdPreview(bytes, width, height) {
  const { initializeCanvas, readPsd } = require('ag-psd');
  const invalid = () => { throw new Error('E_IMAGE_PSD_INVALID: use a verified 8-bit RGB PSD candidate from the layered source.'); };
  let at = 0;
  const take = (size) => {
    if (!Number.isSafeInteger(size) || size < 0 || at + size > bytes.length) return invalid();
    const value = bytes.subarray(at, at + size); at += size; return value;
  };
  const u16 = () => take(2).readUInt16BE();
  const u32 = () => take(4).readUInt32BE();
  if (bytes.length > MAX_PSD_BYTES || take(4).toString('ascii') !== '8BPS' || u16() !== 1) return invalid();
  if (take(6).some(value => value !== 0)) return invalid();
  const channels = u16(), actualHeight = u32(), actualWidth = u32();
  if (channels < 3 || channels > 4 || actualWidth !== width || actualHeight !== height
    || width < 1 || height < 1 || width * height > MAX_PIXELS || u16() !== 8 || u16() !== 3) return invalid();
  take(u32()); take(u32());
  const sectionSize = u32(), sectionEnd = at + sectionSize;
  if (sectionSize < 6 || sectionEnd > bytes.length) return invalid();
  const layerSize = u32(), layerEnd = at + layerSize;
  if (layerEnd > sectionEnd || layerSize < 2) return invalid();
  const layerCount = Math.abs(take(2).readInt16BE());
  if (layerCount < 1 || layerCount > 128) return invalid();
  let pixels = 0;
  for (let i = 0; i < layerCount; i++) {
    const rect = take(16), h = rect.readInt32BE(8) - rect.readInt32BE(0), w = rect.readInt32BE(12) - rect.readInt32BE(4);
    if (w < 0 || h < 0 || w > 8192 || h > 8192 || (pixels += w * h) > 16_777_216) return invalid();
    const count = u16(); if (count > 5) return invalid();
    take(count * 6); take(12);
    const extra = u32(); if (extra > 131_072) return invalid();
    take(extra); if (at > layerEnd) return invalid();
  }
  try {
    initializeCanvas(() => { throw new Error('Unsupported PSD canvas'); },
      (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
    const document = readPsd(bytes, { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
    const data = document.imageData?.data;
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) return invalid();
    return data;
  } catch { return invalid(); }
}

module.exports = { decodePsdPreview, MAX_PSD_BYTES };
