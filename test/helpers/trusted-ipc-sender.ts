import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export function trustedIpcSender<T extends Record<string, unknown>>(extra?: T): T & { getURL(): string } {
  return {
    getURL: () => pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'index.html')).toString(),
    ...(extra || {} as T),
  } as T & { getURL(): string };
}
