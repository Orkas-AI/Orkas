import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import * as path from 'node:path';
import type { AppUsageScope } from '../connectors/action_confirm';
import { Mutex } from 'async-mutex';
import { METHODS, SDK_VERSION, UNSUPPORTED, describeMethod, manifestSchema, type AppManifest, type Method, MAX_PAYLOAD_BYTES } from './catalog';
import { writeBytesAtomic, isAtomicWriteTempPath } from '../../storage';
import { webAppDataFile, webAppSandboxRoot, userLocalRoot, userCloudRoot, userRoot, WS_ROOT } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import { MAX_TEXT_FILE_BYTES } from '../../util/file-size-limits';
import { LocalAppData } from './data';
import {createLogger} from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { commonMethod, type AppType, type DataDefinition } from './data-contract';
import { RequestHistory } from './request-history';

export class AppError extends Error {
  constructor(readonly code: string) { super(code); }
}
class SourceRevisionError extends AppError {
  constructor() { super('E_CLOSED'); }
}
export interface Bundle {
  browserOnly?: boolean;
  kind?: 'saved' | 'artifact';
  /** Unresolved is runtime-only; it allows rendering/common data, never host authority. */
  appType?: AppType | 'unresolved';
  key: string;
  title: string;
  entry: string;
  manifest: unknown;
  /** Cheap rejection only; content validation remains authoritative. */
  current?(): boolean;
  valid?(signal?: AbortSignal): boolean | Promise<boolean>;
  resolve(rel: string): { absPath: string; mime: string } | null;
}
export interface AppTool {
  name: string;
  capability: 'library' | 'connectors';
  description: string;
  inputSchema: object;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface AppDataOwner {
  readonly closed?:boolean;
  open():Promise<LocalAppData>;
  call(method:string,args:unknown,signal?:AbortSignal):Promise<unknown>;
  close():Promise<void>;
}
export interface HostAdapters {
  dataOwner?(uid:string,key:string,file:string,definition:DataDefinition):AppDataOwner;
  storageChanged?(uid: string, relPath: string): void;
  activeUser(): string;
  language(): string;
  modelAvailable(): boolean;
  closed?(uid: string, usage: AppUsageScope): void;
  pick(): Promise<string | null>;
  save(name: string): Promise<string | null>;
  generate(uid: string, args: { prompt: string; maxTokens?: number }, signal: AbortSignal, progress: (event: unknown) => void): Promise<unknown>;
  tools(uid: string, usage: AppUsageScope): Promise<AppTool[]>;
}
interface Instance {
  token: string;
  host: string;
  uid: string;
  owner: number;
  bundle: Bundle;
  manifest: AppManifest;
  controller: AbortController;
  handles: Map<string, { name: string; bytes: Buffer }>;
  requests: Map<string, AbortController>;
  seen: RequestHistory;
}
const id = () => crypto.randomBytes(16).toString('hex');
const MAX_FILE_BYTES = MAX_TEXT_FILE_BYTES;
const STORE_BYTES = MAX_TEXT_FILE_BYTES;
/** Serialized bytes of parsed stores kept for open apps; larger stores are
 * re-read per call. */
const STORE_CACHE_BYTES = 32 * 1024 * 1024;
interface ParsedStore { signature: string; owner: string; bytes: number; entries: Record<string, unknown> }
/** Identity plus both change times: a synced copy arrives by rename (new
 * inode) and an in-place rewrite always moves ctime, even when mtime is set. */
const storeSignature = (st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const error = (code: string): never => { throw new AppError(code); };
const callLog = createLogger('web-app-runtime');
const CALL_FAILURE_WINDOW_MS = 60_000;
const CALL_FAILURE_MAX_KEYS = 64;
const callFailures = new Map<string, { at: number; suppressed: number }>();
/** One warning per catalog method + code per minute, with the suppressed
 *  count carried forward. Unexpected non-AppError causes keep only a redacted
 *  summary; app arguments, results, paths, and identities are never logged. */
function logCallFailure(method: string, code: string, cause: unknown): void {
  try {
    const key = `${method}\0${code}`, now = Date.now();
    const seen = callFailures.get(key);
    if (seen && now - seen.at < CALL_FAILURE_WINDOW_MS) { seen.suppressed++; return; }
    if (!seen && callFailures.size >= CALL_FAILURE_MAX_KEYS) {
      for (const [old, entry] of callFailures) if (now - entry.at >= CALL_FAILURE_WINDOW_MS) callFailures.delete(old);
      if (callFailures.size >= CALL_FAILURE_MAX_KEYS) return;
    }
    callFailures.set(key, { at: now, suppressed: 0 });
    callLog.warn('web app call failed', { method, code, suppressed_count: seen?.suppressed || 0,
      ...(cause instanceof AppError ? {} : { error: logErrorSummary(cause) }) });
  } catch { /* Diagnostics are best effort. */ }
}
const liveRuntimes=new Set<WeakRef<WebAppRuntime>>();
const heldAppData=new Set<string>();
export function holdAppData(uid:string,key:string){const identity=JSON.stringify([uid,key]);if(heldAppData.has(identity))throw new AppError('E_BUSY');heldAppData.add(identity);return ()=>heldAppData.delete(identity);}
export async function closeAppData(uid:string,key:string){
  for(const ref of [...liveRuntimes]){const runtime=ref.deref();if(!runtime){liveRuntimes.delete(ref);continue;}runtime.closeSource(uid,key);await runtime.drainData();}
}
/** A formal migration must be transferable even when its page stays closed. */
export async function checkpointAppData(uid:string,key:string,file:string,definition:DataDefinition){
  for(const ref of [...liveRuntimes]){const runtime=ref.deref();if(!runtime){liveRuntimes.delete(ref);continue;}if(await runtime.checkpointData(uid,key,file,definition))return;}
}
async function readFileBytes(file: fs.FileHandle, check: () => void): Promise<Buffer> {
  // Allocate for this file, not the admission ceiling; read in chunks so
  // cancellation still interrupts large snapshots. Short reads are not EOF.
  let bytes = Buffer.allocUnsafe(Math.min((await file.stat()).size, MAX_FILE_BYTES) + 1);
  let offset = 0;
  while (true) {
    check();
    const { bytesRead } = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
    check();
    if (!bytesRead) return bytes.subarray(0, offset);
    offset += bytesRead;
    if (offset > MAX_FILE_BYTES) return error('E_LIMIT');
    if (offset === bytes.length) {
      // The source grew after stat; expand only as needed, with one sentinel
      // byte so a file crossing the shared ceiling cannot be truncated silently.
      const grown = Buffer.allocUnsafe(Math.min(MAX_FILE_BYTES + 1, Math.max(64 * 1024, bytes.length * 2)));
      bytes.copy(grown); bytes = grown;
    }
  }
}
/** Whether serialized JSON nests at most `max` objects/arrays deep. Strings
 * are skipped whole (the input is JSON.stringify output, so quotes and escapes
 * are well formed); scanning only structure keeps long text values cheap. */
function jsonDepthWithin(json: string, max: number): boolean {
  const structure = /["{}[\]]/g;
  let depth = 0;
  for (let m = structure.exec(json); m; m = structure.exec(json)) {
    const c = m[0];
    if (c === '"') {
      // The closing quote is the next one not escaped by an odd backslash run.
      let end = m.index;
      for (;;) {
        end = json.indexOf('"', end + 1);
        if (end < 0) return true;
        let slashes = 0;
        while (json.charCodeAt(end - 1 - slashes) === 92) slashes++;
        if (slashes % 2 === 0) break;
      }
      structure.lastIndex = end + 1;
    } else if (c === '{' || c === '[') { if (++depth > max) return false; }
    else depth--;
  }
  return true;
}
export function boundedJson(value: unknown, max = MAX_PAYLOAD_BYTES): string {
  let json: string;
  try { json = JSON.stringify(value); } catch { return error('E_INPUT'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > max) return error('E_LIMIT');
  // Bound nested JSON work before Zod or service adapters traverse it.
  if (!jsonDepthWithin(json, 32)) return error('E_LIMIT');
  return json;
}

/** Instances and grants are memory-only and bound to the trusted host renderer. */
export class WebAppRuntime {
  private dataConnections=new Map<string,LocalAppData>();
  private dataOwners=new Map<string,AppDataOwner>();
  private dataOpening=new Map<string,Promise<LocalAppData>>();
  private dataClosures=new Set<Promise<void>>();
  async drainData(){await Promise.allSettled([...this.dataOpening.values()]);await Promise.allSettled([...this.dataClosures]);}
  private dataFile(s:Instance){return this.preview ? path.join(this.preview.storageRoot,'data.sqlite') : path.join(webAppSandboxRoot(s.uid,s.bundle.key,'local'),'data.sqlite');}
  private async dataCall(s:Instance,method:string,args:unknown,signal:AbortSignal){
    if(heldAppData.has(JSON.stringify([s.uid,s.bundle.key])))return error('E_BUSY');
    if(!s.manifest.data)return error('E_NOT_DECLARED');
    const file=this.dataFile(s);let connection=this.dataConnections.get(file);
    if(this.dataOwners.get(file)?.closed){this.releaseData(file);connection=undefined;}
    // A worker stopped by a call timeout or crash never recovers; release it so this call reopens.
    if(connection?.dead){createLogger('web-app-data').warn('data worker stopped, reopening');this.releaseData(file);connection=undefined;}
    if(!connection){
      if(!this.dataOpening.has(file)&&this.dataConnections.size+this.dataOpening.size>=4)return error('E_BUSY');
      const boundary=this.preview?.storageRoot ?? userLocalRoot(s.uid);
      if(!isPathAllowed(file,[boundary]))return error('E_FILE');
      if(!this.dataOpening.has(file))this.dataOpening.set(file,(async()=>{
        const owner=this.preview?null:this.host.dataOwner?.(s.uid,s.bundle.key,file,s.manifest.data);
        const opened=owner?await owner.open():new LocalAppData(file,boundary,s.manifest.data);
        const inUse = [...this.instances.values()].some(other => other.manifest.data
          && this.dataFile(other) === file && !other.controller.signal.aborted
          && other.uid === this.host.activeUser());
        if(!inUse){await (owner?owner.close():opened.close());throw new AppError('E_CLOSED');}
        this.dataConnections.set(file,opened);if(owner)this.dataOwners.set(file,owner);return opened;
      })().finally(()=>this.dataOpening.delete(file)));
      connection=await this.dataOpening.get(file);
    }
    if(s.controller.signal.aborted||s.uid!==this.host.activeUser())return error('E_CLOSED');
    try{return await (this.dataOwners.get(file)?.call(method,args,signal)??connection.call(method,args));}catch(e){throw new AppError((e as any)?.code?.startsWith('E_')?(e as any).code:'E_DATA');}
  }
  /** Drop the cached connection for `file`; its close (and checkpoint) finishes in the background. */
  private releaseData(file:string){
    const connection=this.dataConnections.get(file);this.dataConnections.delete(file);
    const owner=this.dataOwners.get(file);this.dataOwners.delete(file);
    if(connection){const closing=(owner?owner.close():connection.close()).catch(e=>{createLogger('web-app-data').warn('data checkpoint unavailable',{error_code:(e as any).code||'E_DATA'});}).finally(()=>this.dataClosures.delete(closing));this.dataClosures.add(closing);}
  }

  private instances = new Map<string, Instance>();
  private stores = new Map<string, { mutex: Mutex; users: number }>();
  /** Parsed storage files of open apps, least recently used first. */
  private parsedStores = new Map<string, ParsedStore>();
  private parsedBytes = 0;
  constructor(private host: HostAdapters, private preview?: { storageRoot: string }) {liveRuntimes.add(new WeakRef(this));}
  closeSource(uid:string,key:string){for(const s of [...this.instances.values()])if(s.uid===uid&&s.bundle.key===key)this.close(uid,s.owner,s.token);}

  private static storeOwner(s: Instance): string { return `${s.uid}\0${s.bundle.key}`; }
  private ownerOpen(owner: string): boolean {
    for (const s of this.instances.values()) if (WebAppRuntime.storeOwner(s) === owner) return true;
    return false;
  }
  private dropStore(file: string): void {
    const old = this.parsedStores.get(file);
    if (!old) return;
    this.parsedStores.delete(file);
    this.parsedBytes -= old.bytes;
  }
  private keepStore(file: string, store: ParsedStore): void {
    this.dropStore(file);
    if (store.bytes > STORE_CACHE_BYTES || !this.ownerOpen(store.owner)) return;
    this.parsedStores.set(file, store);
    this.parsedBytes += store.bytes;
    for (const oldest of this.parsedStores.keys()) {
      if (this.parsedBytes <= STORE_CACHE_BYTES) break;
      this.dropStore(oldest);
    }
  }

  private available(capability: string | null | undefined): boolean {
    if (this.preview && capability && capability !== 'storage' && capability !== 'appFiles' && capability !== 'data') return false;
    return capability !== 'ai' || this.host.modelAvailable();
  }

  async checkpointData(uid:string,key:string,file:string,definition:DataDefinition){
    if(this.preview||!this.host.dataOwner)return false;
    const owner=this.host.dataOwner(uid,key,file,definition);try{await owner.open();}finally{await owner.close();}return true;
  }
  open(uid: string, owner: number, bundle: Bundle) {
    if (uid !== this.host.activeUser()) return error('E_CLOSED');
    if(heldAppData.has(JSON.stringify([uid,bundle.key])))return error('E_BUSY');
    const parsed = manifestSchema.safeParse(bundle.manifest);
    if (!parsed.success || (bundle.appType === 'web' && parsed.data.capabilities.some(c=>c!=='data'))) return error('E_MANIFEST');
    const token = id();
    const host = bundle.browserOnly
      ? 'a-' + crypto.createHash('sha256').update(JSON.stringify([uid, bundle.key])).digest('hex').slice(0, 20)
      : `app-${id()}`;
    if ([...this.instances.values()].some(s => s.host === host && (s.uid !== uid || s.bundle.key !== bundle.key))) return error('E_BUNDLE');
    const instance: Instance = { token, host, uid, owner, bundle: {...bundle,appType:bundle.appType??'local'}, manifest: structuredClone(parsed.data),
      controller: new AbortController(), handles: new Map(), requests: new Map(),
      seen: new RequestHistory() };
    this.instances.set(token, instance);
    return { token, entry: bundle.entry, url: `chat-app://${instance.host}/${bundle.entry.split('/').map(encodeURIComponent).join('/')}`, ...(bundle.browserOnly ? { browserOnly: true } : { sdkVersion: SDK_VERSION }) };
  }
  private current(uid: string, owner: number, token: string): Instance {
    const s = this.instances.get(token);
    if (!s || s.uid !== uid || s.owner !== owner || uid !== this.host.activeUser() || s.controller.signal.aborted) return error('E_CLOSED');
    if (s.bundle.current?.() === false) {
      this.close(uid, owner, token); throw new SourceRevisionError();
    }
    return s;
  }
  /** The existing artifact bridge is available only in its local task context. */
  async canSubmitArtifact(uid: string, owner: number, token: string): Promise<boolean> {
    try {
      const s = this.current(uid, owner, token);
      await this.check(s, s.controller.signal);
      return !this.preview && s.bundle.kind === 'artifact' && s.bundle.appType === 'local';
    } catch { return false; }
  }
  close(uid: string, owner: number, token: string): void {
    const s = this.instances.get(token);
    if (!s || s.uid !== uid || s.owner !== owner) return;
    this.instances.delete(token);
    const dataFile=s.manifest.data?this.dataFile(s):null;
    if(dataFile&&![...this.instances.values()].some(other=>other.manifest.data&&this.dataFile(other)===dataFile))this.releaseData(dataFile);
    const app = WebAppRuntime.storeOwner(s);
    if (!this.ownerOpen(app)) {
      for (const [file, store] of this.parsedStores) if (store.owner === app) this.dropStore(file);
    }
    s.controller.abort();
    for (const c of s.requests.values()) c.abort();
    this.host.closed?.(s.uid, { id: s.token, owner: s.owner });
    s.handles.clear(); s.seen.clear();
  }
  canNavigate(owner: number, source: string, destination: string): boolean {
    try {
      const from = new URL(source), to = new URL(destination);
      if (from.protocol !== 'chat-app:' || to.protocol !== from.protocol || to.host !== from.host
        || to.username || to.password) return false;
      const instance = [...this.instances.values()].find(s => s.owner === owner && s.host === from.host);
      if (!instance) return false;
      const rel = to.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      // This synchronous Electron navigation decision grants no resource or
      // SDK access. The protocol waits for content validation before serving.
      return this.resourceCandidate(to.host, rel, `chat-app://${from.host}`)?.resolved?.mime.startsWith('text/html') === true;
    } catch { return false; }
  }
  cancelOriginRequests(owner: number, url: string): void {
    let host: string; try { host = new URL(url).host; } catch { return; }
    for (const s of this.instances.values()) {
      if (s.owner === owner && s.host === host) for (const request of s.requests.values()) request.abort();
    }
  }
  closeOrigin(owner: number, url: string): void {
    let host: string; try { host = new URL(url).host; } catch { return; }
    for (const s of this.instances.values()) if (s.owner === owner && s.host === host) this.close(s.uid, owner, s.token);
  }
  closeOwner(owner: number): void {
    for (const s of this.instances.values()) if (s.owner === owner) this.close(s.uid, owner, s.token);
  }
  closeUser(uid: string): void {
    for (const s of this.instances.values()) if (s.uid === uid) this.close(uid, s.owner, s.token);
  }
  cancel(uid: string, owner: number, token: string, requestId: string) {
    const s = this.current(uid, owner, token);
    if (s.bundle.browserOnly) return error('E_UNAVAILABLE');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return error('E_INPUT');
    // Tombstones also stop a cancellation arriving before its invoke.
    if (!s.seen.add(requestId)) return error('E_LIMIT');
    s.requests.get(requestId)?.abort();
  }
  private resourceCandidate(host: string, rel: string, origin: string | null) {
    const s = [...this.instances.values()].find(item => item.host === host);
    if (!s || s.uid !== this.host.activeUser() || s.controller.signal.aborted) return null;
    try { this.current(s.uid, s.owner, s.token); } catch { return null; }
    if (origin && origin !== `chat-app://${host}`) return null;
    if (!rel || rel.includes('\\') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
    return { instance: s, bundle: s.bundle, resolved: s.bundle.resolve(rel) };
  }
  async resource(host: string, rel: string, origin: string | null) {
    const candidate = this.resourceCandidate(host, rel, origin);
    if (!candidate) return null;
    try { await this.check(candidate.instance, candidate.instance.controller.signal); }
    catch { return null; }
    return { bundle: candidate.bundle, resolved: candidate.resolved };
  }
  private requireCapability(s: Instance, capability: string): void {
    if (!s.manifest.capabilities.includes(capability as any)) return error('E_NOT_DECLARED');
  }
  async call(uid: string, owner: number, token: string, requestId: string, method: string, raw: unknown,
    progress: (event: unknown) => void = () => {}) {
    const s = this.current(uid, owner, token);
    try { return await this.dispatch(s, requestId, method, raw, progress); }
    catch (cause) {
      const code = cause instanceof AppError ? cause.code : 'E_FAILED';
      if (code !== 'E_CANCELLED' && code !== 'E_CLOSED') {
        logCallFailure(Object.hasOwn(METHODS, method) ? method : 'unknown', code, cause);
      }
      throw cause;
    }
  }
  private async dispatch(s: Instance, requestId: string, method: string, raw: unknown,
    progress: (event: unknown) => void) {
    if (s.bundle.browserOnly) return error('E_UNAVAILABLE');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return error('E_INPUT');
    if (s.seen.has(requestId)) return error('E_DUPLICATE');
    if (!Object.hasOwn(METHODS, method)) return error('E_METHOD');
    if(s.bundle.appType!=='local'&&!commonMethod(method))return error('E_UNAVAILABLE');
    boundedJson(raw,method.startsWith('data.')?1024*1024:MAX_PAYLOAD_BYTES);
    const def = METHODS[method as Method];
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) return error('E_INPUT');
    if (!this.available(def.capability) || (this.preview && method === 'tools.call')) return error('E_UNAVAILABLE');
    if (!s.seen.add(requestId)) return error('E_LIMIT');
    const controller = new AbortController();
    s.requests.set(requestId, controller);
    const signal = controller.signal;
    try {
      if (def.capability) this.requireCapability(s, def.capability);
      await this.check(s, signal);
      const value = await this.execute(s, method as Method, parsed.data, signal, event => {
        this.checkCurrent(s, signal); boundedJson(event, 64 * 1024); progress(event);
      });
      if (method !== 'permissions.revoke') await this.check(s, signal);
      boundedJson(value,method.startsWith('data.')?2*1024*1024:MAX_PAYLOAD_BYTES);
      return value;
    } catch (cause) {
      // Owning services may reject with Error/AbortError rather than AppError.
      // The request signal, not provider wording, determines SDK cancellation.
      if (cause instanceof SourceRevisionError) throw cause;
      if (signal.aborted) return error('E_CANCELLED');
      throw cause;
    } finally { s.requests.delete(requestId); }
  }
  private checkCurrent(s: Instance, signal: AbortSignal) {
    if (signal.aborted) return error('E_CANCELLED');
    this.current(s.uid, s.owner, s.token);
  }
  private async check(s: Instance, signal: AbortSignal) {
    this.checkCurrent(s, signal);
    const valid = await s.bundle.valid?.(signal);
    this.checkCurrent(s, signal);
    if (valid === false) { this.close(s.uid, s.owner, s.token); throw new SourceRevisionError(); }
  }
  private async store(s: Instance, action: string, input: any, signal: AbortSignal) {
    const file = this.preview ? path.join(this.preview.storageRoot, input.scope === 'cloud' ? 'cloud-storage.json' : 'storage.json') : webAppDataFile(s.uid, s.bundle.key, input.scope);
    let lock = this.stores.get(file);
    if (!lock) { lock = { mutex: new Mutex(), users: 0 }; this.stores.set(file, lock); }
    lock.users++;
    try { return await lock.mutex.runExclusive(async () => {
      await this.check(s, signal);
      if (!isPathAllowed(file, [this.preview?.storageRoot ?? (input.scope === 'cloud' ? userCloudRoot(s.uid) : userLocalRoot(s.uid))])) return error('E_FILE');
      // App-local paths may not alias another application's private store.
      for (const segment of [path.dirname(path.dirname(file)), path.dirname(file), file]) {
        try { if ((await fs.lstat(segment)).isSymbolicLink()) return error('E_FILE'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
      const owner = WebAppRuntime.storeOwner(s);
      // Cached entries are shared with later calls: read them, never mutate.
      let entries: Record<string, unknown> = Object.create(null);
      try {
        const st = await fs.stat(file);
        if (st.size > STORE_BYTES) return error('E_LIMIT');
        const signature = storeSignature(st);
        const cached = this.parsedStores.get(file);
        if (cached?.signature === signature) {
          entries = cached.entries;
          this.keepStore(file, cached);
        } else {
          const data = await fs.readFile(file);
          if (data.length > STORE_BYTES) return error('E_LIMIT');
          const saved = JSON.parse(data.toString('utf8'));
          if (saved.version !== 1 || !saved.entries || Array.isArray(saved.entries) || typeof saved.entries !== 'object') return error('E_STORAGE');
          entries = Object.assign(Object.create(null), saved.entries);
          this.keepStore(file, { signature, owner, bytes: data.length, entries });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.dropStore(file);
      }
      await this.check(s, signal);
      if (action === 'storage.get') return { value: Object.hasOwn(entries, input.key) ? entries[input.key] : null };
      if (action === 'storage.keys') return { keys: Object.keys(entries).sort() };
      const next: Record<string, unknown> = Object.assign(Object.create(null), entries);
      if (action === 'storage.set') next[input.key] = input.value;
      else delete next[input.key];
      // One serialization: the written bytes are what the size and depth
      // limits check (the indented form is never smaller than the compact one).
      let json: string;
      try { json = JSON.stringify({ version: 1, entries: next }, null, 2); } catch { return error('E_INPUT'); }
      const bytes = Buffer.from(json);
      if (bytes.length > STORE_BYTES || !jsonDepthWithin(json, 32)) return error('E_LIMIT');
      await writeBytesAtomic(file, bytes, { shouldCommit: () => { this.checkCurrent(s, signal); return true; } });
      await this.check(s, signal);
      // Only sync also writes cloud files, and it could land between this
      // write and a stat; those are re-read on their next call instead.
      const written = this.preview || input.scope !== 'cloud' ? await fs.stat(file).catch(() => null) : null;
      if (written) this.keepStore(file, { signature: storeSignature(written), owner, bytes: bytes.length, entries: next });
      else this.dropStore(file);
      this.changed(s, input.scope, file);
      return action === 'storage.set' ? { saved: true } : { removed: true };
    }); } finally { if (--lock.users === 0) this.stores.delete(file); }
  }
  private changed(s: Instance, scope: string, file: string) {
    if (!this.preview && scope === 'cloud') this.host.storageChanged?.(s.uid, path.relative(userRoot(s.uid), file).split(path.sep).join('/'));
  }
  private async appFiles(s: Instance, action: string, input: any, signal: AbortSignal) {
    const base = this.preview ? path.join(this.preview.storageRoot, input.scope) : webAppSandboxRoot(s.uid, s.bundle.key, input.scope);
    const root = path.join(base, 'files');
    const file = input.path ? path.join(root, ...input.path.split('/')) : root;
    // Serialize file operations and publication across instances of this app.
    let lock = this.stores.get(root);
    if (!lock) { lock = { mutex: new Mutex(), users: 0 }; this.stores.set(root, lock); }
    lock.users++;
    const guard = (target: string) => {
      this.checkCurrent(s, signal);
      const boundary = this.preview?.storageRoot ?? (input.scope === 'cloud' ? userCloudRoot(s.uid) : userLocalRoot(s.uid));
      if (!isPathAllowed(target, [boundary])) return error('E_FILE');
      let current = target;
      while (current !== boundary) {
        try { const st = lstatSync(current); if (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1)) return error('E_FILE'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
        const parent = path.dirname(current); if (parent === current) return error('E_FILE'); current = parent;
      }
    };
    try { return await lock.mutex.runExclusive(async () => {
      await this.check(s, signal);
      guard(file);
      if (action === 'appFiles.readText' || action === 'appFiles.readBase64') {
        let handle;
        try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
        try {
          const st = await handle.stat();
          if (!st.isFile() || st.nlink !== 1) return error('E_FILE');
          if (st.size > MAX_FILE_BYTES) return error('E_LIMIT');
          const data = await readFileBytes(handle, () => guard(file));
          guard(file);
          if (action === 'appFiles.readBase64') return { base64: data.toString('base64') };
          try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data) }; } catch { return error('E_ENCODING'); }
        } finally { await handle.close(); }
      }
      if (action === 'appFiles.remove') {
        guard(file);
        try { if (!lstatSync(file).isFile()) return error('E_FILE'); unlinkSync(file); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
        for (let dir = path.dirname(file); dir !== root; dir = path.dirname(dir)) {
          guard(dir); try { rmdirSync(dir); } catch { break; }
        }
        this.changed(s, input.scope, file);
        return { removed: true };
      }
      if (action === 'appFiles.list') {
        const files: Array<{ path: string; size: number }> = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
          guard(dir);
          let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); }
          catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
          for (const entry of entries) {
            if (isAtomicWriteTempPath(entry.name)) continue;
            const abs = path.join(dir, entry.name); guard(abs);
            if (entry.isDirectory()) await walk(abs, depth + 1);
            else if (entry.isFile()) {
              const st = await fs.lstat(abs);
              files.push({ path: path.relative(root, abs).split(path.sep).join('/'), size: st.size });
            } else return error('E_FILE');
          }
        };
        await walk(root, 0);
        return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
      }
      const bytes = action === 'appFiles.writeText' ? Buffer.from(input.text, 'utf8') : Buffer.from(input.base64, 'base64');
      if (action === 'appFiles.writeBase64' && bytes.toString('base64') !== input.base64) return error('E_INPUT');
      if (bytes.length > MAX_FILE_BYTES) return error('E_LIMIT');
      guard(file);
      await writeBytesAtomic(file, bytes, { shouldCommit: () => { guard(file); return true; } });
      guard(file); this.changed(s, input.scope, file);
      return { saved: true };
    }); } finally { if (--lock.users === 0) this.stores.delete(root); }
  }
  private async execute(s: Instance, method: Method, a: any, signal: AbortSignal, progress: (event: unknown) => void): Promise<any> {
    if (method.startsWith('data.')) return this.dataCall(s,method,a,signal);
    if (method.startsWith('appFiles.')) return this.appFiles(s, method, a, signal);
    if (method.startsWith('storage.')) return this.store(s, method, a, signal);
    switch (method) {
      case 'host.getContext': return { language: this.host.language(), sdkVersion: SDK_VERSION, ...(this.preview ? { mode: 'preview' } : {}) };
      case 'capabilities.describe': return (s.bundle.appType==='local'||commonMethod(a.method)) && describeMethod(a.method) || error('E_METHOD');
      case 'capabilities.list': return { sdkVersion: SDK_VERSION, methods: Object.keys(METHODS).filter(name=>s.bundle.appType==='local'||commonMethod(name)).map(name => {
        const def = METHODS[name as Method];
        return { name, capability: def.capability, supported: true,
          available: this.available(def.capability) && !(this.preview && name === 'tools.call'),
          declared: !def.capability || s.manifest.capabilities.includes(def.capability as any),
          authorized: this.available(def.capability) && name !== 'tools.call' && def.capability !== 'files' && (!def.capability || s.manifest.capabilities.includes(def.capability as any)),
          authorization: name === 'tools.call' ? 'per_tool' : def.capability === 'files' ? 'picker' : 'none' };
      }), unsupported: UNSUPPORTED };
      case 'permissions.revoke': this.close(s.uid, s.owner, s.token); return { revoked: true };
      case 'files.pick': {
        const selected = await this.host.pick(); await this.check(s, signal);
        if (!selected) return null;
        const real = await fs.realpath(selected);
        if (isPathAllowed(real, [WS_ROOT])) return error('E_FILE');
        const file = await fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return error('E_LIMIT');
          const bytes = await readFileBytes(file, () => this.checkCurrent(s, signal));
          await this.check(s, signal);
          const handle = id(); const name = path.basename(real);
          s.handles.set(handle, { name, bytes });
          return { handle, name, size: bytes.length };
        } finally { await file.close(); }
      }
      case 'files.readText': case 'files.readBase64': {
        const file = s.handles.get(a.handle); if (!file) return error('E_HANDLE');
        if (method === 'files.readBase64') return { base64: file.bytes.toString('base64') };
        let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { return error('E_ENCODING'); }
        return { text };
      }
      case 'files.release': s.handles.delete(a.handle); return { released: true };
      case 'files.saveAs': {
        if (Buffer.byteLength(a.text, 'utf8') > MAX_FILE_BYTES) return error('E_LIMIT');
        const selected = await this.host.save(a.name); await this.check(s, signal);
        if (!selected) return null;
        const parent = await fs.realpath(path.dirname(selected));
        const target = path.join(parent, path.basename(selected));
        if (isPathAllowed(target, [WS_ROOT])) return error('E_FILE');
        // Create-only export never overwrites a file owned by another workflow.
        const temp = path.join(parent, `.orkas-export-${id()}`);
        try {
          const file = await fs.open(temp, 'wx', 0o600);
          try { await file.writeFile(a.text, 'utf8'); await file.sync(); }
          finally { await file.close(); }
          await this.check(s, signal);
          // Atomic create-only publication, including on Windows; never replace.
          await fs.link(temp, target);
        } finally { await fs.unlink(temp).catch(() => {}); }
        return { saved: true, name: path.basename(target) };
      }
      case 'ai.generate': {
        if (!this.host.modelAvailable()) return error('E_UNAVAILABLE');
        return this.host.generate(s.uid, a, signal, progress);
      }
      case 'tools.list': {
        if (this.preview) return { tools: [] };
        const tools = await this.host.tools(s.uid, { id: s.token, owner: s.owner }); await this.check(s, signal);
        return { tools: tools.filter(tool => s.manifest.capabilities.includes(tool.capability)).map(({ execute: _execute, ...info }) => info) };
      }
      case 'tools.call': {
        const tools = await this.host.tools(s.uid, { id: s.token, owner: s.owner }); await this.check(s, signal);
        const tool = tools.find(tool => tool.name === a.name);
        if (!tool) return error('E_TOOL');
        this.requireCapability(s, tool.capability); await this.check(s, signal);
        const result = await tool.execute(a.arguments, signal); await this.check(s, signal);
        // Never replay a tool because its result cannot fit the app boundary.
        try { boundedJson(result); } catch { return error('E_RESULT_LIMIT'); }
        return result;
      }
    }
    return error('E_METHOD');
  }
}
