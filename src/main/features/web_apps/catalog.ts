/** Web-only API contract. This is not a second model-visible Tool catalog. */
import { DATA_INPUTS, dataDefinitionSchema, commonMethod, type AppType } from './data-contract';
import { isAtomicWriteTempPath } from '../../storage';
import { z } from 'zod';
import { MAX_TEXT_FILE_BYTES } from '../../util/file-size-limits';
const { schemaToJson } = require('../../../../bin/schema-to-json.cjs');

export const SDK_VERSION = 1;
export const MANIFEST_FILE = 'orkas-app.json';
export const SDK_PATH = '__orkas/sdk.js';
// Leave room for base64 and JSON framing above the shared file byte ceiling.
export const MAX_PAYLOAD_BYTES = 2 * MAX_TEXT_FILE_BYTES + 1024 * 1024;
const empty = z.object({}).strict();
const key = z.string().min(1);
const scope = z.enum(['local', 'cloud']).default('local');
const fileScope = z.enum(['local', 'cloud']).default('cloud');
const appPath = z.string().min(1).describe('Relative path. No atomic temporary filenames, hidden/traversal segments, backslashes, Windows reserved names, trailing dots/spaces, visibility, Thumbs.db or desktop.ini.').refine(value => value.split('/').every(part =>
  !!part && !isAtomicWriteTempPath(part) && !['visibility', 'Thumbs.db', 'desktop.ini'].includes(part) && !part.startsWith('.') && !/[\\:\x00-\x1f<>"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part)));
const handle = z.string().regex(/^[a-f0-9]{32}$/);
const text = z.string().max(MAX_TEXT_FILE_BYTES);
const define = (capability: string | null, description: string, input: z.ZodTypeAny, result: string, example: object) =>
  ({ capability, description, input, result, example });
export const METHODS = {
  'data.query':define('data','Read declared fields under readFilters; default limit 20, maximum 100, offset maximum 100000. Ordering adds id as a stable tie-breaker; include reads at most four declared one-hop relations.',DATA_INPUTS['data.query'],'{records:object[]}; include adds relations keyed by reference field.',{table:'messages',fields:['body'],limit:20}),
  'data.count':define('data','Count records under declared readFilters and caller filters; requires count permission.',DATA_INPUTS['data.count'],'{count:number}',{table:'messages'}),
  'data.insert':define('data','Insert declared fields, apply defaults and meter canonical UTF-8 bytes atomically. requestId deduplicates the latest 2048 insert requests across reopening.',DATA_INPUTS['data.insert'],'{id:string}; generated record ID, never the private row.',{table:'messages',values:{body:'Hello'},requestId:'message-1'}),
  'data.insertIf':define('data','Atomically check whole-table count and insert. maxCount can only tighten the application declaration; full capacity returns E_CONDITION.',DATA_INPUTS['data.insertIf'],'{id:string}; no partial insertion on failure.',{table:'messages',values:{body:'Hello'},maxCount:100,requestId:'message-2'}),
  'data.aggregate':define('data','Compute a declared aggregate under readFilters and caller filters; groupBy requires read permission. Up to 100 groups; larger results fail with E_LIMIT.',DATA_INPUTS['data.aggregate'],'{value:number|string|null} or {groups:[{key,value}]} when groupBy is supplied.',{table:'messages',field:'score',op:'sum'}),
  'capabilities.list': define(null, 'Discover supported methods, current availability and authorization requirements.', empty, '{sdkVersion, methods, unsupported}', {}),
  'capabilities.describe': define(null, 'Read one method schema, result contract and example.', z.object({ method: key }).strict(), 'Method documentation.', { method: 'data.query' }),
  'host.getContext': define(null, 'Read the current application language and SDK version.', empty, '{language, sdkVersion}', {}),
  'permissions.revoke': define(null, 'Revoke this instance grants and cancel pending work. Reopening starts fresh.', empty, '{revoked:true}', {}),
  'storage.get': define('storage', 'Read app-private JSON; scope defaults to local for compatibility. cloud participates in account sync.', z.object({ key, scope }).strict(), '{value}; null when missing.', { key: 'draft' }),
  'storage.set': define('storage', 'Atomically save an app-private JSON value; total store limit 200 MiB.', z.object({ key, scope, value: z.unknown().refine(v => v !== undefined) }).strict(), '{saved:true}', { key: 'draft', value: 'Hello' }),
  'storage.remove': define('storage', 'Remove one app-private value.', z.object({ key, scope }).strict(), '{removed:true}', { key: 'draft' }),
  'storage.keys': define('storage', 'List keys in the selected app store.', z.object({ scope }).strict(), '{keys:string[]}', {}),
  'appFiles.list': define('appFiles', 'List sandbox files recursively. cloud (default) syncs with the account; local is for caches.', z.object({ scope: fileScope }).strict(), '{files:[{path,size}]}', { scope: 'cloud' }),
  'appFiles.readText': define('appFiles', 'Read a sandbox UTF-8 file up to 200 MiB; missing files return null.', z.object({ path: appPath, scope: fileScope }).strict(), '{text} or null.', { path: 'notes/today.txt' }),
  'appFiles.readBase64': define('appFiles', 'Read a sandbox binary file up to 200 MiB; missing files return null.', z.object({ path: appPath, scope: fileScope }).strict(), '{base64} or null.', { path: 'images/icon.png' }),
  'appFiles.writeText': define('appFiles', 'Atomically replace an app-owned UTF-8 file (200 MiB). Creates parent directories. Saved means local persistence, not completed upload.', z.object({ path: appPath, scope: fileScope, text }).strict(), '{saved:true}', { path: 'notes/today.txt', text: 'Hello' }),
  'appFiles.writeBase64': define('appFiles', 'Atomically replace an app-owned binary file (200 MiB). Requires canonical base64.', z.object({ path: appPath, scope: fileScope, base64: z.string().max(4 * Math.ceil(MAX_TEXT_FILE_BYTES / 3)) }).strict(), '{saved:true}', { path: 'images/icon.bin', base64: 'AAE=' }),
  'appFiles.remove': define('appFiles', 'Remove one sandbox file; missing files are a successful no-op. Directories are not recursively deleted.', z.object({ path: appPath, scope: fileScope }).strict(), '{removed:true}', { path: 'notes/today.txt' }),
  'files.pick': define('files', 'Choose a local file using the host dialog; grants read access only.', empty, '{handle,name,size} or null on cancellation.', {}),
  'files.readText': define('files', 'Read a selected UTF-8 file, at most 200 MiB.', z.object({ handle }).strict(), '{text}', { handle: '0123456789abcdef0123456789abcdef' }),
  'files.readBase64': define('files', 'Read a selected file as base64, at most 200 MiB.', z.object({ handle }).strict(), '{base64}', { handle: '0123456789abcdef0123456789abcdef' }),
  'files.saveAs': define('files', 'Export UTF-8 text using the host Save dialog. Create-only: choose a new destination; existing files are not overwritten.', z.object({ name: z.string().min(1).regex(/^[^/\\\x00-\x1f]+$/), text }).strict(), '{saved:true,name} or null on cancellation.', { name: 'summary.txt', text: 'Summary' }),
  'files.release': define('files', 'Release a file handle before closing the app.', z.object({ handle }).strict(), '{released:true}', { handle: '0123456789abcdef0123456789abcdef' }),
  'ai.generate': define('ai', 'Generate text with the configured model without tools, skills or conversation history. Optional progress receives text deltas. Uses the configured model without an extra application permission dialog.', z.object({ prompt: z.string().min(1), maxTokens: z.number().int().positive().safe().optional() }).strict(), '{text,usage,stopReason}; token-limited output has stopReason=max_tokens. Cancel with AbortSignal.', { prompt: 'Write a short greeting.', maxTokens: 128 }),
  'tools.list': define(null, 'Discover eligible existing Orkas tools and their original schemas. Connector discovery supports BM25 query, bounded pages and full schemas for small catalogs through list_connector_tools. Does not grant execution.', empty, '{tools:[{name,capability,description,inputSchema}]}', {}),
  'tools.call': define(null, 'Execute an eligible existing tool under its original operation permissions. Sensitive actions use host approval; Trusted mode skips confirmation. Unknown tools fail closed.', z.object({ name: key, arguments: z.record(z.string(), z.unknown()) }).strict(), '{content,isError?}; inspect isError. Oversized results fail without replay.', { name: 'library', arguments: { action: 'list', scope: 'global', limit: 10 } }),
} as const;
export type Method = keyof typeof METHODS;
export const CAPABILITIES = ['storage', 'appFiles', 'files', 'ai', 'library', 'connectors', 'data'] as const;
export const manifestSchema = z.object({ sdkVersion: z.literal(SDK_VERSION), minimumClient:z.literal('1.9.0').optional(), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length), data: dataDefinitionSchema.optional() }).strict();
export type AppManifest = z.infer<typeof manifestSchema>;
export const UNSUPPORTED = [
  { capability: 'account.renewalReminders', reason: 'Host-only: account-wide reminder claims and billing navigation belong to the signed-in desktop account UI, not saved applications.' },
  { capability: 'browser', reason: 'Host-only: task browser control, native file selection and site consent require a live conversation and its user-owned Chromium profile.' },
  { capability: 'files.writeInPlace', reason: 'Deferred: needs shared revision/lock/indexer integration; export through files.saveAs.' },
  { capability: 'projects', reason: 'Deferred: apps have no user-selected project binding; source conversation is not authority.' },
  { capability: 'memory', reason: 'Deferred: needs a user-selected scope; Agent-private and global memories are not app state.' },
  { capability: 'history', reason: 'Deferred: needs an explicit conversation grant and bounded history projection.' },
  { capability: 'agents.tasks', reason: 'Deferred: needs a host-owned task lifetime, permissions and billing association.' },
  { capability: 'skills', reason: 'Host-only: Skill script execution needs an explicitly scoped application sandbox and execution contract.' },
  { capability: 'shell', reason: 'Host-only: arbitrary execution would escape the application capability boundary.' },
  { capability: 'media.generate', reason: 'Deferred: owning studio plan, output and spending gates must be adapted first.' },
];
export function describeMethod(method: string) {
  if (!Object.hasOwn(METHODS, method)) return null;
  const def = METHODS[method as Method];
  return { name: method, capability: def.capability, description: def.description,
    appTypes:commonMethod(method)?['local','web']:['local'],environments:commonMethod(method)?['desktop','preview','online']:['desktop','preview'],status:'supported',
    inputSchema: schemaToJson(def.input), result: def.result, example: def.example };
}
export function catalogDocument(appType:AppType='local') {
  const starter = appType === 'web' ? 'web' : 'starter';
  // Web creators and runtimes already reject host capabilities; retain the
  // shared array bound while documenting their data-only declaration.
  const schema = appType === 'web'
    ? manifestSchema.extend({ capabilities: z.array(z.enum(['data'])).max(CAPABILITIES.length) })
    : manifestSchema;
  return { sdkVersion: SDK_VERSION,
    manifest: { file: MANIFEST_FILE, schema: {
        ...schemaToJson(schema),
        // Both creators and runtimes require a definition for declared data.
        allOf: [{ if: { properties: { capabilities: { contains: { const: 'data' } } }, required: ['capabilities'] }, then: { required: ['data'] } }],
      },
      starter: { entry: `@skill/web-app-sdk/assets/${starter}/index.html`,
        manifest: `@skill/web-app-sdk/assets/${starter}/${MANIFEST_FILE}` } },
    dataDefinition:schemaToJson(dataDefinitionSchema), methods: Object.keys(METHODS).filter(name=>appType==='local'||commonMethod(name)).map(name => describeMethod(name)), unsupported: UNSUPPORTED };
}
