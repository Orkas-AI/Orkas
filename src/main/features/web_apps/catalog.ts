/** Web-only API contract. This is not a second model-visible Tool catalog. */
import { isAtomicWriteTempPath } from '../../storage';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const SDK_VERSION = 1;
export const MANIFEST_FILE = 'orkas-app.json';
export const SDK_PATH = '__orkas/sdk.js';
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const empty = z.object({}).strict();
const key = z.string().min(1).max(128);
const scope = z.enum(['local', 'cloud']).default('local');
const fileScope = z.enum(['local', 'cloud']).default('cloud');
const appPath = z.string().min(1).max(240).describe('Relative path, at most 8 segments. No atomic temporary filenames, hidden/traversal segments, backslashes, Windows reserved names, trailing dots/spaces, visibility, Thumbs.db or desktop.ini.').refine(value => value.split('/').length <= 8 && value.split('/').every(part =>
  !!part && !isAtomicWriteTempPath(part) && !['visibility', 'Thumbs.db', 'desktop.ini'].includes(part) && !part.startsWith('.') && !/[\\:\x00-\x1f<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part)));
const handle = z.string().regex(/^[a-f0-9]{32}$/);
const text = z.string().max(512 * 1024);
const define = (capability: string | null, description: string, input: z.ZodTypeAny, result: string, example: object) =>
  ({ capability, description, input, result, example });
export const METHODS = {
  'capabilities.list': define(null, 'Discover supported methods, current availability and authorization requirements.', empty, '{sdkVersion, methods, unsupported}', {}),
  'capabilities.describe': define(null, 'Read one method schema, result contract and example.', z.object({ method: key }).strict(), 'Method documentation.', { method: 'ai.generate' }),
  'host.getContext': define(null, 'Read the current application language and SDK version.', empty, '{language, sdkVersion}', {}),
  'permissions.revoke': define(null, 'Revoke this instance grants and cancel pending work. Reopening starts fresh.', empty, '{revoked:true}', {}),
  'storage.get': define('storage', 'Read app-private JSON; scope defaults to local for compatibility. cloud participates in account sync.', z.object({ key, scope }).strict(), '{value}; null when missing.', { key: 'draft' }),
  'storage.set': define('storage', 'Atomically save an app-private JSON value; total store limit 1 MiB.', z.object({ key, scope, value: z.unknown().refine(v => v !== undefined) }).strict(), '{saved:true}', { key: 'draft', value: 'Hello' }),
  'storage.remove': define('storage', 'Remove one app-private value.', z.object({ key, scope }).strict(), '{removed:true}', { key: 'draft' }),
  'storage.keys': define('storage', 'List up to 256 keys in the selected app store.', z.object({ scope }).strict(), '{keys:string[]}', {}),
  'appFiles.list': define('appFiles', 'List sandbox files recursively. cloud (default) syncs with the account; local is for caches. At most 256 files and 16 MiB per scope.', z.object({ scope: fileScope }).strict(), '{files:[{path,size}]}', { scope: 'cloud' }),
  'appFiles.readText': define('appFiles', 'Read a sandbox UTF-8 file up to 512 KiB; missing files return null.', z.object({ path: appPath, scope: fileScope }).strict(), '{text} or null.', { path: 'notes/today.txt' }),
  'appFiles.readBase64': define('appFiles', 'Read a sandbox binary file up to 512 KiB; missing files return null.', z.object({ path: appPath, scope: fileScope }).strict(), '{base64} or null.', { path: 'images/icon.png' }),
  'appFiles.writeText': define('appFiles', 'Atomically replace an app-owned UTF-8 file (512 KiB). Creates parent directories. Saved means local persistence, not completed upload.', z.object({ path: appPath, scope: fileScope, text }).strict(), '{saved:true}', { path: 'notes/today.txt', text: 'Hello' }),
  'appFiles.writeBase64': define('appFiles', 'Atomically replace an app-owned binary file (512 KiB). Requires canonical base64.', z.object({ path: appPath, scope: fileScope, base64: z.string().max(700000) }).strict(), '{saved:true}', { path: 'images/icon.bin', base64: 'AAE=' }),
  'appFiles.remove': define('appFiles', 'Remove one sandbox file; missing files are a successful no-op. Directories are not recursively deleted.', z.object({ path: appPath, scope: fileScope }).strict(), '{removed:true}', { path: 'notes/today.txt' }),
  'files.pick': define('files', 'Choose a local file using the host dialog; grants read access only.', empty, '{handle,name,size} or null on cancellation.', {}),
  'files.readText': define('files', 'Read a selected UTF-8 file, at most 512 KiB.', z.object({ handle }).strict(), '{text}', { handle: '0123456789abcdef0123456789abcdef' }),
  'files.readBase64': define('files', 'Read a selected file as base64, at most 512 KiB.', z.object({ handle }).strict(), '{base64}', { handle: '0123456789abcdef0123456789abcdef' }),
  'files.saveAs': define('files', 'Export UTF-8 text using the host Save dialog. Create-only: choose a new destination; existing files are not overwritten.', z.object({ name: z.string().min(1).max(120).regex(/^[^/\\\x00-\x1f]+$/), text }).strict(), '{saved:true,name} or null on cancellation.', { name: 'summary.txt', text: 'Summary' }),
  'files.release': define('files', 'Release a file handle before closing the app.', z.object({ handle }).strict(), '{released:true}', { handle: '0123456789abcdef0123456789abcdef' }),
  'ai.generate': define('ai', 'Generate text with the configured model without tools, skills or conversation history. Optional progress receives text deltas. Uses the configured model without an extra application permission dialog.', z.object({ prompt: z.string().min(1).max(32000), maxTokens: z.number().int().min(1).max(4096).default(1024) }).strict(), '{text,usage,stopReason}; token-limited output has stopReason=max_tokens. Cancel with AbortSignal.', { prompt: 'Write a short greeting.', maxTokens: 128 }),
  'tools.list': define(null, 'Discover eligible existing Orkas tools and their original schemas. Does not grant execution.', empty, '{tools:[{name,capability,description,inputSchema}]}', {}),
  'tools.call': define(null, 'Execute an eligible existing tool under its original operation permissions. Sensitive actions use host approval; Trusted mode skips confirmation. Unknown tools fail closed.', z.object({ name: key, arguments: z.record(z.unknown()) }).strict(), '{content,isError?}; inspect isError. Oversized results fail without replay.', { name: 'library', arguments: { action: 'list', scope: 'global', limit: 10 } }),
} as const;
export type Method = keyof typeof METHODS;
export const CAPABILITIES = ['storage', 'appFiles', 'files', 'ai', 'library', 'connectors'] as const;
export const manifestSchema = z.object({ sdkVersion: z.literal(SDK_VERSION), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length) }).strict();
export type AppManifest = z.infer<typeof manifestSchema>;
export const UNSUPPORTED = [
  { capability: 'files.writeInPlace', reason: 'Deferred: needs shared revision/lock/indexer integration; export through files.saveAs.' },
  { capability: 'projects', reason: 'Deferred: apps have no user-selected project binding; source conversation is not authority.' },
  { capability: 'memory', reason: 'Deferred: needs a user-selected scope; Agent-private and global memories are not app state.' },
  { capability: 'history', reason: 'Deferred: needs an explicit conversation grant and bounded history projection.' },
  { capability: 'agents.tasks', reason: 'Deferred: needs a host-owned task lifetime, permissions and billing association.' },
  { capability: 'skills', reason: 'Host-only: Skill script execution needs an explicitly scoped application sandbox and execution contract.' },
  { capability: 'shell', reason: 'Host-only: arbitrary execution would escape the application capability boundary.' },
  { capability: 'media.generate', reason: 'Deferred: owning studio plan, output and spending gates must be adapted first.' },
  { capability: 'network', reason: 'Deferred: private app data must not reach arbitrary remote endpoints; bundled resources only.' },
];
export function describeMethod(method: string) {
  if (!Object.hasOwn(METHODS, method)) return null;
  const def = METHODS[method as Method];
  return { name: method, capability: def.capability, description: def.description,
    inputSchema: zodToJsonSchema(def.input, { $refStrategy: 'none' }), result: def.result, example: def.example };
}
export function catalogDocument() {
  return { sdkVersion: SDK_VERSION, methods: Object.keys(METHODS).map(name => describeMethod(name)), unsupported: UNSUPPORTED };
}
