import * as path from 'node:path';
import { chatMediaLocalUrl } from './chat-media-url';

/** The owner validates eligibility; a receipt never adds unrequested files. */
export function outputPublicationReceipt(requested: readonly string[], accepted: readonly string[]) {
  const acceptedSet = new Set(accepted.map(file => path.resolve(file)));
  const outputs = [...new Set(requested)].filter(file => acceptedSet.has(file))
    .map(file => ({ path: file, url: chatMediaLocalUrl(file) }));
  return { published: outputs.length, requested: requested.length, outputs };
}
