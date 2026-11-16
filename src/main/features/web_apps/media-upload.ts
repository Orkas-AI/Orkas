/** Selected app files go straight to a Shopify-issued product-media target.
 * Staging uses the existing connector executor and never exposes account secrets. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './runtime';
import { isPathAllowed } from '../../util/path-sandbox';
import { MAX_TEXT_FILE_BYTES } from '../../util/file-size-limits';
let busy = false;
const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
function targetUrl(raw: string) {
    let u: URL;
    try {
        u = new URL(raw);
    }
    catch {
        throw new AppError('E_FILE');
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !['shopify-staged-uploads.storage.googleapis.com', 'shopify-video-production-core-originals.s3.amazonaws.com', 'shopify.s3.amazonaws.com'].includes(u.hostname))
        throw new AppError('E_FILE');
    return u.href;
}
export async function uploadProductAsset(root: string, relative: string, invoke: (args: object) => Promise<any>, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{
    sourceUrl: string;
}> {
    if (busy)
        throw new AppError('E_BUSY');
    busy = true;
    try {
        const file = path.join(root, ...relative.split('/')), ext = path.extname(file).toLowerCase(), mime = types[ext];
        if (!mime || !isPathAllowed(file, [root]))
            throw new AppError('E_FILE');
        const st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 1 || st.size > MAX_TEXT_FILE_BYTES)
            throw new AppError('E_FILE');
        if (signal.aborted)
            throw new AppError('E_CANCELLED');
        const raw = await invoke({ action: 'media.stage_product', parameters: { filename: randomUUID() + ext, mime_type: mime, resource: mime.startsWith('video/') ? 'VIDEO' : 'PRODUCT_IMAGE', file_size: String(st.size) } });
        if (raw.isError)
            throw new AppError('E_TOOL');
        const result = typeof raw.content === 'string' ? JSON.parse(raw.content) : raw;
        if (result.provider !== 'shopify')
            throw new AppError('E_TOOL');
        const target = result.result?.stagedTargets?.[0];
        if (!target)
            throw new AppError('E_TOOL');
        const url = targetUrl(target.url), sourceUrl = targetUrl(target.resourceUrl);
        if (!Array.isArray(target.parameters) || target.parameters.length > 32)
            throw new AppError('E_TOOL');
        const current = await fs.lstat(file);
        if (current.ino !== st.ino || current.size !== st.size || current.mtimeMs !== st.mtimeMs || !isPathAllowed(file, [root]))
            throw new AppError('E_CONFLICT');
        const bytes = await fs.readFile(file);
        if (bytes.length !== st.size)
            throw new AppError('E_CONFLICT');
        const body = new FormData();
        for (const parameter of target.parameters) {
            if (typeof parameter.name !== 'string' || typeof parameter.value !== 'string' || parameter.name === 'file')
                throw new AppError('E_TOOL');
            body.append(parameter.name, parameter.value);
        }
        body.append('file', new Blob([bytes]), path.basename(file));
        const response = await fetcher(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) });
        await response.body?.cancel();
        if (!response.ok)
            throw new AppError('E_TOOL');
        return { sourceUrl };
    }
    finally {
        busy = false;
    }
}
