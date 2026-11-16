import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { t, type Lang } from '../i18n';
import { createLogger } from '../logger';
import { isPathAllowed } from '../util/path-sandbox';

const log = createLogger('video-delivery-notice');
const MAX_OUTPUTS = 16;
const MAX_VIDEOS = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_FILE_BYTES;
const NOTICE_TIMEOUT_MS = 500;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
type Version = { id: string; video_id?: string; path: string };

/** Optional, read-only context for an interrupted reply's existing attachments.
 * Never discovers files, publishes outputs, judges completion or starts work. */
export async function interruptedVideoDeliveryNotice(input: {
  produced: readonly string[];
  allowedRoots: readonly string[];
  lang?: Lang;
}): Promise<string> {
  let stopped = false;
  let bytesLeft = MAX_TOTAL_BYTES;
  const reasons = new Set<string>();
  const notes: string[] = [];
  const check = () => { if (stopped) throw new Error('notice stopped'); };
  const read = async (file: string, production: string): Promise<string | null> => {
    check();
    if (!isPathAllowed(file, [production])) throw new Error('metadata scope');
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      // NONBLOCK also prevents a replaced metadata file from parking on a FIFO.
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      check();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > bytesLeft) throw new Error('metadata size');
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, bytesLeft) + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      check();
      bytesLeft -= result.bytesRead;
      if (result.bytesRead !== stat.size || result.bytesRead > MAX_FILE_BYTES || bytesLeft < 0) throw new Error('metadata size');
      return buffer.subarray(0, result.bytesRead).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close(); }
  };
  const collect = async () => {
    let videos = 0;
    const seen = new Set<string>();
    for (const [index, raw] of input.produced.slice(0, MAX_OUTPUTS).entries()) {
      check();
      const file = path.resolve(raw);
      if (seen.has(file) || path.basename(path.dirname(file)) !== 'versions'
          || !VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      seen.add(file);
      if (++videos > MAX_VIDEOS) { reasons.add('limit'); break; }
      const production = path.dirname(path.dirname(file));
      if (!isPathAllowed(production, input.allowedRoots) || !isPathAllowed(file, [production])) continue;
      let retained = '';
      try {
        if (!(await fs.stat(file)).isFile()) continue;
        const rawLedger = await read(path.join(production, 'versions.json'), production);
        if (!rawLedger) continue;
        const ledger = JSON.parse(rawLedger) as { versions?: unknown[] };
        if (!Array.isArray(ledger.versions)) throw new Error('invalid versions');
        const versions = ledger.versions.filter((value): value is Version => {
          if (!value || typeof value !== 'object') return false;
          const v = value as Version;
          return typeof v.id === 'string' && v.id.length <= 24 && /^v[1-9]\d*$/.test(v.id)
            && (v.video_id === undefined || typeof v.video_id === 'string' && v.video_id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.video_id))
            && typeof v.path === 'string';
        });
        const version = versions.find(v => path.resolve(production, v.path) === file);
        if (!version) continue;
        retained = t('video.delivery_retained', { index: index + 1, version: version.id }, input.lang);
        // Only the latest version's own source fingerprint can establish later edits.
        const latest = versions.filter(v => v.video_id === version.video_id).at(-1);
        const video = path.join(production, 'videos', version.video_id ?? '');
        const recordRaw = version.video_id && latest === version ? await read(path.join(video, '.last-render.json'), production) : null;
        if (recordRaw) {
          const record = JSON.parse(recordRaw) as { delivered_version_id?: string; delivered_source_sha256?: string };
          const hash = record.delivered_source_sha256;
          if (record.delivered_version_id === version.id && typeof hash === 'string' && /^(parsed:|facts:)?[a-f0-9]{64}$/.test(hash)) {
            const manifest = await read(path.join(video, 'manifest.json'), production);
            if (!manifest || JSON.parse(manifest)?.id !== version.video_id) throw new Error('invalid manifest');
            const page = await read(path.join(video, 'index.html'), production) ?? '';
            const product = await read(path.join(production, 'product.json'), production) ?? '';
            if (product) JSON.parse(product);
            const { videoTimelineSourceHash } = await import('./video_timeline_render');
            check();
            const form = hash.startsWith('parsed:') ? 'parsed' : hash.startsWith('facts:') ? 'facts' : 'whole';
            if (videoTimelineSourceHash({ manifest, page, product }, form) !== hash) {
              retained += ` ${t('video.delivery_later_edits', undefined, input.lang)}`;
            }
          }
        }
      } catch { if (!stopped) reasons.add('metadata'); }
      check();
      if (retained) notes.push(retained);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      collect().catch(() => { if (!stopped) reasons.add('metadata'); }),
      new Promise<void>(resolve => { timer = setTimeout(() => { stopped = true; reasons.add('timeout'); resolve(); }, NOTICE_TIMEOUT_MS); }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
  if (reasons.size) log.warn('delivery notice incomplete', { reasons: [...reasons] });
  return notes.join('\n\n');
}
