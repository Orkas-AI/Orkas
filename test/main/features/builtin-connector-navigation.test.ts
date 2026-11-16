import { afterEach, expect, it, vi } from 'vitest';
import { WebAppRuntime, type Bundle } from '../../../src/main/features/web_apps/runtime';
import { catalogDocument } from '../../../src/main/features/web_apps/catalog';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { sdkScript } from '../../../src/main/features/web_apps/resources';

const navigation = vi.hoisted(() => ({ user: 'account-a', windows: [] as any[] }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => navigation.windows } }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => navigation.user }));

const host = { activeUser: () => 'account-a', language: () => 'en', modelAvailable: () => false,
  pick: async () => null, save: async () => null, generate: async () => ({}), tools: async () => [],
  openConnectors: vi.fn(async () => ({ opened: true })) };
const runtimes: WebAppRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.closeOwner(1); vi.clearAllMocks(); });
const bundle = (extra: Partial<Bundle> = {}): Bundle => ({ key: 'commerce', title: 'Commerce', entry: 'index.html',
  appType: 'local', manifest: { sdkVersion: 1, capabilities: ['connectors'] }, resolve: () => null, ...extra });

it('navigates model setup only from live media workspaces with a closed purpose and no credential authority',async()=>{
 const configureModels=vi.fn(async()=>({opened:true})),runtime=new WebAppRuntime({...host,tasks:{} as any,configureModels} as any);runtimes.push(runtime);
 for(const builtinApp of ['content_workbench','product_listing'] as const){
  const app=runtime.open('account-a',1,bundle({builtinApp,manifest:{sdkVersion:1,capabilities:['tasks']}}));
  for(const kind of ['image','video','audio'])expect(await runtime.call('account-a',1,app.token,kind,'__builtin.configureModels',{kind})).toEqual({opened:true});
  let bad=0;for(const args of [{kind:'chat'},{kind:'image',credentials:{}},{kind:'image/../settings'},{},null])await expect(runtime.call('account-a',1,app.token,'bad'+bad++,'__builtin.configureModels',args)).rejects.toMatchObject({code:'E_INPUT'});
  await expect(runtime.call('other-account',1,app.token,'foreign','__builtin.configureModels',{kind:'image'})).rejects.toMatchObject({code:'E_CLOSED'});
 }
 expect(configureModels.mock.calls.map(row=>row.slice(0,2))).toEqual([['account-a','image'],['account-a','video'],['account-a','audio'],['account-a','image'],['account-a','video'],['account-a','audio']]);
 expect(catalogDocument().methods.map(row=>row.name)).not.toContain('__builtin.configureModels');
});

it('denies model setup to custom, preview, nonlocal, undeclared and stale app instances',async()=>{
 const configureModels=vi.fn(async()=>({opened:true}));
 for(const [extra,code]of [[{},'E_METHOD'],[{builtinApp:'product_listing',appType:'web',manifest:{sdkVersion:1,capabilities:[]}},'E_UNAVAILABLE'],[{builtinApp:'product_listing'},'E_NOT_DECLARED'],[{builtinApp:'content_workbench',valid:async()=>false,manifest:{sdkVersion:1,capabilities:['tasks']}},'E_CLOSED']]as [Partial<Bundle>,string][]){
  const runtime=new WebAppRuntime({...host,tasks:{} as any,configureModels}as any);runtimes.push(runtime);const app=runtime.open('account-a',1,bundle(extra));await expect(runtime.call('account-a',1,app.token,'denied','__builtin.configureModels',{kind:'image'})).rejects.toMatchObject({code});
 }
 const preview=new WebAppRuntime({...host,tasks:{} as any,configureModels}as any,{storageRoot:'/unused-preview'});runtimes.push(preview);const app=preview.open('account-a',1,bundle({builtinApp:'content_workbench',manifest:{sdkVersion:1,capabilities:['tasks']}}));await expect(preview.call('account-a',1,app.token,'preview','__builtin.configureModels',{kind:'image'})).rejects.toMatchObject({code:'E_METHOD'});expect(configureModels).not.toHaveBeenCalled();
});

it('opens the connector catalog only for a live packaged commerce instance without authorizing a connection', async () => {
  const runtime = new WebAppRuntime(host); runtimes.push(runtime);
  const app = runtime.open('account-a', 1, bundle({ builtinApp: 'product_listing' }));
  expect(await runtime.call('account-a', 1, app.token, 'open', '__builtin.openConnectors', {})).toEqual({ opened: true });
  expect(host.openConnectors).toHaveBeenCalledWith('account-a');
  await expect(runtime.call('account-a', 1, app.token, 'extra', '__builtin.openConnectors', { connect: true })).rejects.toMatchObject({ code: 'E_INPUT' });
  await expect(runtime.call('account-b', 1, app.token, 'foreign', '__builtin.openConnectors', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
  runtime.closeOwner(1);
  await expect(runtime.call('account-a', 1, app.token, 'closed', '__builtin.openConnectors', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
  expect(host.openConnectors).toHaveBeenCalledTimes(1);
  expect(catalogDocument().methods.map(row => row.name)).not.toContain('__builtin.openConnectors');
});

it('rejects custom, other packaged, preview and stale applications before opening any host page', async () => {
  const cases: [Partial<Bundle>, string][] = [[{}, 'E_METHOD'], [{ builtinApp: 'content_workbench' }, 'E_METHOD'],
    [{ builtinApp: 'product_listing', appType: 'web', manifest: { sdkVersion: 1, capabilities: [] } }, 'E_UNAVAILABLE'],
    [{ builtinApp: 'product_listing', manifest: { sdkVersion: 1, capabilities: [] } }, 'E_NOT_DECLARED'],
    [{ builtinApp: 'product_listing', valid: async () => false }, 'E_CLOSED']];
  for (const [extra, code] of cases) {
    const runtime = new WebAppRuntime(host); runtimes.push(runtime);
    const app = runtime.open('account-a', 1, bundle(extra));
    await expect(runtime.call('account-a', 1, app.token, 'blocked', '__builtin.openConnectors', {})).rejects.toMatchObject({ code });
  }
  const preview = new WebAppRuntime(host, { storageRoot: '/unused-preview' }); runtimes.push(preview);
  const app = preview.open('account-a', 1, bundle({ builtinApp: 'product_listing' }));
  await expect(preview.call('account-a', 1, app.token, 'preview', '__builtin.openConnectors', {})).rejects.toMatchObject({ code: 'E_METHOD' });
  expect(host.openConnectors).not.toHaveBeenCalled();
});

it.each([true,false])('navigates for the active account while respecting native focusability without changing authorization: %s', async (focusable) => {
  const { openConnectors } = await import('../../../src/main/features/web_apps/connector-navigation');
  const main = { isDestroyed: () => false, isFocusable: () => focusable, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    webContents: { getURL: () => 'file:///app/index.html', send: vi.fn() } };
  navigation.windows = [{ ...main, webContents: { ...main.webContents, getURL: () => 'file:///app/preview.html' } }, main];
  expect(await openConnectors('account-a')).toEqual({ opened: true });
  expect(main.webContents.send).toHaveBeenCalledWith('connectors:open-from-app', { user_id: 'account-a' });
  expect(main.restore).toHaveBeenCalledTimes(focusable?1:0); expect(main.show).toHaveBeenCalledTimes(focusable?1:0); expect(main.focus).toHaveBeenCalledTimes(focusable?1:0);
  main.webContents.send.mockClear();
  await expect(openConnectors('other-account')).rejects.toMatchObject({ code: 'E_CLOSED' });
  navigation.windows = [];
  await expect(openConnectors('account-a')).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
  expect(main.webContents.send).not.toHaveBeenCalled();
});

it('offers the navigation helper only in the packaged SDK and sends no credentials or automatic connection request', async () => {
  const messages: any[] = [], listeners: Record<string, (event: any) => void> = {};
  const parent = { postMessage: (message: any) => { messages.push(message); listeners.message({ source: parent,
    data: { __orkasApp: 1, id: message.id, type: 'result', ok: true, value: { opened: true } } }); } };
  const window: any = { parent, addEventListener: (name: string, callback: any) => { listeners[name] = callback; } };
  runInNewContext(sdkScript('local', true), { window, parent, crypto: webcrypto, setTimeout, clearTimeout });
  expect(await window.orkasApp.openConnectors()).toEqual({ opened: true });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ method: '__builtin.openConnectors', args: {} });
  const ordinary: any = { parent, addEventListener: () => {} };
  runInNewContext(sdkScript(), { window: ordinary, parent, crypto: webcrypto, setTimeout, clearTimeout });
  expect(ordinary.orkasApp.openConnectors).toBeUndefined();
  expect(ordinary.orkasApp.configureModels).toBeUndefined();
  expect(await window.orkasApp.configureModels('audio')).toEqual({opened:true});
  expect(messages[1]).toMatchObject({method:'__builtin.configureModels',args:{kind:'audio'}});
});

it.each([true,false])('opens the matching model purpose with account checks and focusability: %s',async focusable=>{
 const {configureModels}=await import('../../../src/main/features/web_apps/model-navigation');
 navigation.user='account-a';const main={isDestroyed:()=>false,isFocusable:()=>focusable,isMinimized:()=>true,restore:vi.fn(),show:vi.fn(),focus:vi.fn(),webContents:{getURL:()=> 'file:///app/index.html',send:vi.fn()}};navigation.windows=[main];
 for(const [kind,tab]of [['image','image'],['video','video'],['audio','tts']]as const){expect(await configureModels('account-a',kind)).toEqual({opened:true});expect(main.webContents.send).toHaveBeenLastCalledWith('settings:open-models-from-app',{user_id:'account-a',kind:tab});}
 expect(main.show).toHaveBeenCalledTimes(focusable?3:0);expect(main.focus).toHaveBeenCalledTimes(focusable?3:0);
 main.webContents.send.mockClear();await expect(configureModels('other','image')).rejects.toMatchObject({code:'E_CLOSED'});await expect(configureModels('account-a','chat'as any)).rejects.toMatchObject({code:'E_INPUT'});navigation.windows=[];await expect(configureModels('account-a','image')).rejects.toMatchObject({code:'E_UNAVAILABLE'});expect(main.webContents.send).not.toHaveBeenCalled();
});
