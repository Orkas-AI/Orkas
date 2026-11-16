/** Verify an explicit media delivery from saved bytes, never from reply prose. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bundledFfmpegPaths } from '../../util/bundled-runtime';
import { probeMedia } from '../video_studio';
/** Project the existing terminal message's published paths; never inspect reply prose. */
export function markPublishedOutputs<T extends { path: string }>(files: T[], published: readonly string[] | undefined): Array<T & { published?: boolean }> {
    if (published === undefined) return files;
    const paths = new Set(published.map(file => path.resolve(file)));
    return files.map(file => ({ ...file, published: paths.has(path.resolve(file.path)) }));
}
export class AppOutputUnverifiedError extends Error {}

export function isAppTextDeliverable(text: string, format?: string): boolean {
    if (!text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) return false;
    if (!format || format === 'txt') return true;
    if (format === 'json') { try { JSON.parse(text); return true; } catch { return false; } }
    if (format !== 'srt') return false;
    // Validate the explicit subtitle protocol, never infer success from reply prose.
    const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
    return blocks.length <= 10000 && blocks.every(block => {
        const lines = block.split('\n');
        if (!/^\d+$/.test(lines[0]) || lines.length < 3 || !lines.slice(2).join('').trim()) return false;
        const time = lines[1].match(/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/);
        if (!time) return false;
        const ms = (at: number) => ((Number(time[at]) * 60 + Number(time[at + 1])) * 60 + Number(time[at + 2])) * 1000 + Number(time[at + 3]);
        return ms(5) > ms(1);
    });
}

export async function isAppDeliverable(file: string, kind: 'image' | 'video' | 'audio' | 'text', signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const size = (await fs.stat(file)).size;
    if (!size) return false;
    const ext = path.extname(file).toLowerCase();
    if (kind === 'text') {
        if (!['.txt', '.srt', '.json'].includes(ext)) return false;
        if (size > 2 * 1024 * 1024) throw new AppOutputUnverifiedError();
        return isAppTextDeliverable(await fs.readFile(file, 'utf8'));
    }
    const extensions = {
        image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tiff', '.tif', '.svg', '.pdf', '.psd'],
        video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'],
        audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.aiff'],
    };
    if (!extensions[kind].includes(ext)) return false;
    // These design-source formats are not FFmpeg streams. Retain the app's
    // existing PDF/PSD support; native generation/export owns their full checks.
    if (kind === 'image' && ['.pdf', '.psd', '.svg'].includes(ext)) {
        const handle = await fs.open(file, 'r');
        try {
            const bytes = Buffer.alloc(1024), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            const head = bytes.subarray(0, bytesRead).toString('utf8').trimStart();
            if (ext === '.psd') return head.startsWith('8BPS');
            if (ext === '.svg') return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(head);
            return head.startsWith('%PDF-');
        } finally { await handle.close(); }
    }
    const { ffprobe } = bundledFfmpegPaths();
    if (!ffprobe) return false;
    const media = await probeMedia(ffprobe, file, signal);
    if (signal?.aborted || !media) return false;
    if (kind === 'image') return !!media?.video?.width && !!media.video.height;
    if (kind === 'video') return !!media?.video && (media.duration_seconds ?? 0) > 0;
    return !!media?.audio && (media.duration_seconds ?? 0) > 0;
}
