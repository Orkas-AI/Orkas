import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NativeImage as ElectronNativeImage } from 'electron';
import { encodeImage } from '../util/sharp-runtime';

export type Issue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  disposition?: 'fatal' | 'blocking' | 'advisory';
  confidence?: 'high' | 'medium' | 'low';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
  sceneId?: string;
  role?: string;
  sampleTimeSec?: number;
  activeScene?: boolean;
  evidence?: Record<string, unknown>;
  /** Set when a user decision waived this finding; it stays visible in the
   * report as informational and no longer blocks. */
  waived_by_user?: boolean;
};

export type AudioTrack = {
  absPath: string;
  startSec: number;
  declaredDurationSec?: number;
  volume: number;
};

export type CompositionMeta = {
  htmlPath: string;
  html: string;
  rootAttrs: Record<string, string>;
  id: string;
  width: number;
  height: number;
  durationSec: number;
  audioTracks: AudioTrack[];
};

export type FrameSampleEvidence = {
  label: string;
  time_seconds: number;
  frame_index: number;
  path: string;
  hash: string;
  /** Set when the R0 video-track reuse path carried this sample over from the
   * provenance-matched prior render instead of capturing it live. */
  reused_from_prior_render?: boolean;
  perceptual_hash?: string;
  brightness: number;
  contrast: number;
  width: number;
  height: number;
  expected_scene_id?: string;
  visible_scene_ids?: string[];
  visible_roles?: string[];
  visible_text?: string;
  visible_elements?: VisibleSemanticElementEvidence[];
  /** Why the semantically interesting elements that are NOT visible failed the
   *  visibility test. The probe walks the ancestor chain and computes this to
   *  decide visibility at all; keeping it turns "scene x is not visible" from a
   *  verdict into a diagnosis. */
  hidden_elements?: HiddenSemanticElementEvidence[];
  capture_source_width?: number;
  capture_source_height?: number;
  capture_scale_factor?: number;
  capture_retry_count?: number;
};

/** Why one semantically interesting element did not render at a sampled time.
 *
 * 2026-08-07: `EXPECTED_SCENE_NOT_VISIBLE` cost 15.8 minutes of a 29.5-minute
 * production turn. The probe already measured the answer — it walks the
 * ancestor chain, reads `getComputedStyle`, and multiplies opacity — and then
 * returned a boolean, so the model spent seven QA rounds grepping, opening
 * frames, and guessing at CSS specificity to reconstruct it. */
export type HiddenSemanticElementEvidence = {
  /** Readable identity: `#id`, else `tag[data-scene-id=...]` / `tag[data-role=...]`. */
  selector: string;
  scene_id?: string;
  role?: string;
  reason:
    | 'display_none'
    | 'visibility_hidden'
    | 'transparent'
    | 'zero_size'
    | 'offscreen';
  /** The ancestor that caused it, when the element itself is not the cause. */
  blocked_by?: string;
  /** Cumulative opacity down to and including the blocking node. */
  computed_opacity?: number;
  cover_hero?: boolean;
};

export type VisibleSemanticElementEvidence = {
  scene_id?: string;
  role?: string;
  text?: string;
  text_transform?: string;
  cover_signal?: string;
  cover_hero?: boolean;
  width_ratio?: number;
  height_ratio?: number;
  area_ratio?: number;
  /** Viewport-relative origin. Present since the capture-contradiction check
   *  started asking whether an element's own region got painted. */
  left_ratio?: number;
  top_ratio?: number;
};

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export function dedupeInspectIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const deduped: Issue[] = [];
  for (const issue of issues) {
    const sample = typeof issue.sampleTimeSec === 'number' ? issue.sampleTimeSec.toFixed(2) : '';
    const key = [
      String(issue.code || '').toUpperCase(),
      issue.sceneId || '',
      issue.selector || '',
      sample,
      issue.message.replace(/^\[[\d.]+s\]\s*/, ''),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function perceptualHash(bitmap: Buffer, width: number, height: number): string {
  const cols = 16;
  const rows = 9;
  const stride = Math.max(1, Math.floor(bitmap.length / Math.max(1, width * height)));
  const values: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / rows));
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(width - 1, Math.floor(((col + 0.5) * width) / cols));
      const offset = Math.max(0, (y * width + x) * stride);
      const b = bitmap[offset] ?? 0;
      const g = bitmap[offset + 1] ?? b;
      const r = bitmap[offset + 2] ?? b;
      values.push((0.2126 * r) + (0.7152 * g) + (0.0722 * b));
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  let out = '';
  for (let i = 0; i < values.length; i += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      if ((values[i + bit] ?? 0) >= mean) nibble |= 1 << (3 - bit);
    }
    out += nibble.toString(16);
  }
  return out;
}

export function analyzeNativeImage(image: ElectronNativeImage): { hash: string; perceptual_hash: string; brightness: number; contrast: number; width: number; height: number } {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const pixelCount = Math.max(1, size.width * size.height);
  const stride = Math.max(1, Math.floor(bitmap.length / pixelCount));
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < bitmap.length; i += stride) {
    // Match the BGRA layout used by the frame encoder and perceptual hash.
    const b = bitmap[i] ?? 0;
    const g = bitmap[i + 1] ?? b;
    const r = bitmap[i + 2] ?? b;
    const y = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / pixelCount;
  const variance = Math.max(0, (sumSq / pixelCount) - mean * mean);
  return {
    hash: crypto.createHash('sha256').update(bitmap).digest('hex'),
    perceptual_hash: perceptualHash(bitmap, size.width, size.height),
    brightness: round2(mean),
    contrast: round2(Math.sqrt(variance)),
    width: size.width,
    height: size.height,
  };
}

export async function writeFrameContactSheet(
  evidenceDirAbs: string,
  samples: Array<Pick<FrameSampleEvidence, 'label' | 'time_seconds' | 'path'>>,
  opts: {
    /** Label cells with `sample.label` alone. A production sheet spans several
     *  compositions, where each cell's own timeline start says nothing useful
     *  and "@ 0s" on every cell would be false. */
    labelOnly?: boolean;
    columns?: number;
    /** 16:9 cell width; reference sheets use larger cells than QA sheets. */
    thumbWidth?: number;
    /** Cell height when frames are not 16:9. A portrait frame in a 16:9 cell comes
     *  out a third as wide, too small to read or to see a product in. */
    thumbHeight?: number;
  } = {},
): Promise<string> {
  const thumbW = opts.thumbWidth || 320;
  const thumbH = opts.thumbHeight || Math.round(thumbW * 9 / 16);
  const gap = 16;
  const cols = Math.min(opts.columns || 3, Math.max(1, samples.length));
  const rows = Math.max(1, Math.ceil(samples.length / cols));
  const width = cols * thumbW + (cols + 1) * gap;
  const height = rows * (thumbH + 36) + (rows + 1) * gap;
  const items = await Promise.all(samples.map(async (sample, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = gap + col * (thumbW + gap);
    const y = gap + row * (thumbH + 36 + gap);
    // SVGs loaded through <img> cannot fetch external subresources in Chromium.
    // Embed every captured PNG so the contact sheet is a self-contained image.
    const frameBytes = await fs.readFile(sample.path);
    const href = `data:image/png;base64,${frameBytes.toString('base64')}`;
    const label = (opts.labelOnly ? sample.label : `${sample.label} @ ${sample.time_seconds}s`)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<image href="${href}" x="${x}" y="${y}" width="${thumbW}" height="${thumbH}" preserveAspectRatio="xMidYMid meet"/><text x="${x}" y="${y + thumbH + 24}" fill="#111" font-family="system-ui, sans-serif" font-size="16">${label}</text>`;
  }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>\n${items.join('\n')}\n</svg>\n`;
  const svgPath = path.join(evidenceDirAbs, 'contact-sheet.svg');
  const pngPath = path.join(evidenceDirAbs, 'contact-sheet.png');
  await fs.writeFile(svgPath, svg, 'utf8');

  // Keep the self-contained SVG as inspectable evidence, but publish a raster
  // contact sheet as the primary preview. Conversation attachments render PNG
  // consistently, whereas an SVG attachment may be shown as a file chip and
  // leave the separately published first frame looking like the whole preview.
  const { data } = await encodeImage(Buffer.from(svg), {
    format: 'png',
    density: 96,
    failOn: 'error',
    // librsvg reports density-adjusted pixels (96/72 on some builds), so keep
    // a bounded margin above the declared sheet geometry.
    limitInputPixels: Math.max(1, Math.min(100_000_000, width * height * 4)),
  });
  await fs.writeFile(pngPath, data);
  return pngPath;
}
