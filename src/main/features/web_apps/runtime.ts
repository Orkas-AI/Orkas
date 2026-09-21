import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import * as path from 'node:path';
import type { AppUsageScope } from '../connectors/action_confirm';
import { Mutex } from 'async-mutex';
import { METHODS, SDK_VERSION, UNSUPPORTED, describeMethod, manifestSchema, type AppManifest, type Method, MAX_PAYLOAD_BYTES } from './catalog';
import { writeJson, writeBytesAtomic, isAtomicWriteTempPath } from '../../storage';
import { webAppDataFile, webAppSandboxRoot, userLocalRoot, userCloudRoot, userRoot, WS_ROOT } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import { MAX_TEXT_FILE_BYTES } from '../../util/file-size-limits';
import { RequestHistory } from './request-history';

export class AppError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface Bundle {
  kind?: 'saved' | 'artifact';
  key: string;
  title: string;
  entry: string;
  manifest: unknown;
  valid?(): boolean;
  resolve(rel: string): { absPath: string; mime: string } | null;
}
export interface AppTool {
  name: string;
  capability: 'library' | 'connectors';
  description: string;
  inputSchema: object;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface HostAdapters {
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
const error = (code: string): never => { throw new AppError(code); };
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
export function boundedJson(value: unknown, max = MAX_PAYLOAD_BYTES): string {
  let json: string;
  try { json = JSON.stringify(value); } catch { return error('E_INPUT'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > max) return error('E_LIMIT');
  // Bound nested JSON work before Zod or service adapters traverse it.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (++depth > 32) return error('E_LIMIT'); }
    else if (c === '}' || c === ']') depth--;
  }
  return json;
}

/** Instances and grants are memory-only and bound to the trusted host renderer. */
export class WebAppRuntime {
  private instances = new Map<string, Instance>();
  private stores = new Map<string, { mutex: Mutex; users: number }>();
  constructor(private host: HostAdapters, private preview?: { storageRoot: string }) {}

  private available(capability: string | null | undefined): boolean {
    if (this.preview && capability && capability !== 'storage' && capability !== 'appFiles') return false;
    return capability !== 'ai' || this.host.modelAvailable();
  }

  open(uid: string, owner: number, bundle: Bundle) {
    if (uid !== this.host.activeUser()) return error('E_CLOSED');
    const parsed = manifestSchema.safeParse(bundle.manifest);
    if (!parsed.success) return error('E_MANIFEST');
    const token = id();
    const instance: Instance = { token, host: `app-${id()}`, uid, owner, bundle, manifest: parsed.data,
      controller: new AbortController(), handles: new Map(), requests: new Map(),
      seen: new RequestHistory() };
    this.instances.set(token, instance);
    return { token, entry: bundle.entry, url: `chat-app://${instance.host}/${bundle.entry.split('/').map(encodeURIComponent).join('/')}`, sdkVersion: SDK_VERSION };
  }
  private current(uid: string, owner: number, token: string): Instance {
    const s = this.instances.get(token);
    if (!s || s.uid !== uid || s.owner !== owner || uid !== this.host.activeUser() || s.controller.signal.aborted) return error('E_CLOSED');
    if (s.bundle.valid?.() === false) {
      this.close(uid, owner, token); return error('E_CLOSED');
    }
    return s;
  }
  close(uid: string, owner: number, token: string): void {
    const s = this.instances.get(token);
    if (!s || s.uid !== uid || s.owner !== owner) return;
    this.instances.delete(token);
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
      return this.resource(to.host, rel, `chat-app://${from.host}`)?.resolved?.mime.startsWith('text/html') === true;
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
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return error('E_INPUT');
    // Tombstones also stop a cancellation arriving before its invoke.
    s.seen.add(requestId);
    s.requests.get(requestId)?.abort();
  }
  resource(host: string, rel: string, origin: string | null) {
    const s = [...this.instances.values()].find(item => item.host === host);
    if (!s || s.uid !== this.host.activeUser() || s.controller.signal.aborted) return null;
    try { this.current(s.uid, s.owner, s.token); } catch { return null; }
    if (origin && origin !== `chat-app://${host}`) return null;
    if (!rel || rel.includes('\\') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
    return { bundle: s.bundle, resolved: s.bundle.resolve(rel) };
  }
  private requireCapability(s: Instance, capability: string): void {
    if (!s.manifest.capabilities.includes(capability as any)) return error('E_NOT_DECLARED');
  }
  async call(uid: string, owner: number, token: string, requestId: string, method: string, raw: unknown,
    progress: (event: unknown) => void = () => {}) {
    const s = this.current(uid, owner, token);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return error('E_INPUT');
    if (s.seen.has(requestId)) return error('E_DUPLICATE');
    if (!Object.hasOwn(METHODS, method)) return error('E_METHOD');
    boundedJson(raw);
    const def = METHODS[method as Method];
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) return error('E_INPUT');
    if (!this.available(def.capability) || (this.preview && method === 'tools.call')) return error('E_UNAVAILABLE');
    s.seen.add(requestId);
    const controller = new AbortController();
    s.requests.set(requestId, controller);
    const signal = controller.signal;
    try {
      if (def.capability) this.requireCapability(s, def.capability);
      this.check(s, signal);
      const value = await this.execute(s, method as Method, parsed.data, signal, event => {
        this.check(s, signal); boundedJson(event, 64 * 1024); progress(event);
      });
      if (method !== 'permissions.revoke') this.check(s, signal);
      boundedJson(value);
      return value;
    } catch (cause) {
      // Owning services may reject with Error/AbortError rather than AppError.
      // The request signal, not provider wording, determines SDK cancellation.
      if (signal.aborted) return error('E_CANCELLED');
      throw cause;
    } finally { s.requests.delete(requestId); }
  }
  private check(s: Instance, signal: AbortSignal) {
    if (signal.aborted) return error('E_CANCELLED');
    this.current(s.uid, s.owner, s.token);
  }
  private async store(s: Instance, action: string, input: any, signal: AbortSignal) {
    const file = this.preview ? path.join(this.preview.storageRoot, input.scope === 'cloud' ? 'cloud-storage.json' : 'storage.json') : webAppDataFile(s.uid, s.bundle.key, input.scope);
    let lock = this.stores.get(file);
    if (!lock) { lock = { mutex: new Mutex(), users: 0 }; this.stores.set(file, lock); }
    lock.users++;
    try { return await lock.mutex.runExclusive(async () => {
      this.check(s, signal);
      if (!isPathAllowed(file, [this.preview?.storageRoot ?? (input.scope === 'cloud' ? userCloudRoot(s.uid) : userLocalRoot(s.uid))])) return error('E_FILE');
      // App-local paths may not alias another application's private store.
      for (const segment of [path.dirname(path.dirname(file)), path.dirname(file), file]) {
        try { if ((await fs.lstat(segment)).isSymbolicLink()) return error('E_FILE'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
      let entries: Record<string, unknown> = Object.create(null);
      try {
        if ((await fs.stat(file)).size > STORE_BYTES) return error('E_LIMIT');
        const data = await fs.readFile(file);
        if (data.length > STORE_BYTES) return error('E_LIMIT');
        const saved = JSON.parse(data.toString('utf8'));
        if (saved.version !== 1 || !saved.entries || Array.isArray(saved.entries) || typeof saved.entries !== 'object') return error('E_STORAGE');
        entries = Object.assign(Object.create(null), saved.entries);
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      this.check(s, signal);
      if (action === 'storage.get') return { value: Object.hasOwn(entries, input.key) ? entries[input.key] : null };
      if (action === 'storage.keys') return { keys: Object.keys(entries).sort() };
      if (action === 'storage.set') entries[input.key] = input.value;
      else delete entries[input.key];
      const saved = { version: 1, entries };
      boundedJson(saved, STORE_BYTES);
      if (Buffer.byteLength(JSON.stringify(saved, null, 2)) > STORE_BYTES) return error('E_LIMIT');
      await writeJson(file, saved, { shouldCommit: () => { this.check(s, signal); return true; } });
      this.check(s, signal);
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
      this.check(s, signal);
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
    if (method.startsWith('appFiles.')) return this.appFiles(s, method, a, signal);
    if (method.startsWith('storage.')) return this.store(s, method, a, signal);
    switch (method) {
      case 'host.getContext': return { language: this.host.language(), sdkVersion: SDK_VERSION, ...(this.preview ? { mode: 'preview' } : {}) };
      case 'capabilities.describe': return describeMethod(a.method) || error('E_METHOD');
      case 'capabilities.list': return { sdkVersion: SDK_VERSION, methods: Object.keys(METHODS).map(name => {
        const def = METHODS[name as Method];
        return { name, capability: def.capability, supported: true,
          available: this.available(def.capability) && !(this.preview && name === 'tools.call'),
          declared: !def.capability || s.manifest.capabilities.includes(def.capability as any),
          authorized: this.available(def.capability) && name !== 'tools.call' && def.capability !== 'files' && (!def.capability || s.manifest.capabilities.includes(def.capability as any)),
          authorization: name === 'tools.call' ? 'per_tool' : def.capability === 'files' ? 'picker' : 'none' };
      }), unsupported: UNSUPPORTED };
      case 'permissions.revoke': this.close(s.uid, s.owner, s.token); return { revoked: true };
      case 'files.pick': {
        const selected = await this.host.pick(); this.check(s, signal);
        if (!selected) return null;
        const real = await fs.realpath(selected);
        if (isPathAllowed(real, [WS_ROOT])) return error('E_FILE');
        const file = await fs.open(real, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return error('E_LIMIT');
          const bytes = await readFileBytes(file, () => this.check(s, signal));
          this.check(s, signal);
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
        const selected = await this.host.save(a.name); this.check(s, signal);
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
          this.check(s, signal);
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
        const tools = await this.host.tools(s.uid, { id: s.token, owner: s.owner }); this.check(s, signal);
        return { tools: tools.filter(tool => s.manifest.capabilities.includes(tool.capability)).map(({ execute: _execute, ...info }) => info) };
      }
      case 'tools.call': {
        const tools = await this.host.tools(s.uid, { id: s.token, owner: s.owner }); this.check(s, signal);
        const tool = tools.find(tool => tool.name === a.name);
        if (!tool) return error('E_TOOL');
        this.requireCapability(s, tool.capability); this.check(s, signal);
        const result = await tool.execute(a.arguments, signal); this.check(s, signal);
        // Never replay a tool because its result cannot fit the app boundary.
        try { boundedJson(result); } catch { return error('E_RESULT_LIMIT'); }
        return result;
      }
    }
    return error('E_METHOD');
  }
}
