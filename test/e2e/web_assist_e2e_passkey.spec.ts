import { createServer } from 'node:http';
import { expect, test } from './fixtures/orkas';

// This is a real Electron/Orkas bridge and lifecycle check with a controlled
// native dependency. It is not phone authentication or Google acceptance.
test('Google phone passkey returns a browser-shaped assertion and cancels cleanly on navigation', async ({ modelOrkas: orkas }) => {
  test.skip(process.platform !== 'darwin', 'Windows keeps its native WebAuthn route; hardware cases are retained separately.');
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Phone passkey fixture' })).conversation.conversation_id;
  const page = orkas.page!;
  const destination = 'https://accounts.google.com/passkey-fixture';
  await page.evaluate(async id => {
    await (window as any).loadConversations(); (window as any).setView('conversation', id);
    (window as any).ConversationInfo.openAndSetTab('browser');
  }, cid);
  await expect(page.locator('.web-assist-tab')).toHaveCount(1);
  await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
    view.webContents.session.protocol.handle('https', () => new Response('<title>Public passkey fixture</title><h1>Credential fixture</h1>', { headers: { 'Content-Type': 'text/html' } }));
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const cp = require('node:child_process'); const original = cp.spawn;
    const state = { count: 0, stopped: 0, mode: 'result' };
    (globalThis as any).__phonePasskeyFixture = { state, restore: () => { cp.spawn = original; } };
    cp.spawn = (binary: string, ...args: any[]) => {
      if (!binary.endsWith('/orkas-phone-passkey')) return original(binary, ...args);
      const { PassThrough } = require('node:stream'); const { EventEmitter } = require('node:events');
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { state.stopped++; } });
      state.count++;
      child.stdin.once('data', (bytes: Buffer) => {
        const request = JSON.parse(bytes.toString());
        setTimeout(() => {
          if (state.mode === 'hold') { child.stdout.write(JSON.stringify({ type: 'qr', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }) + '\n'); return; }
          const auth = Buffer.alloc(37); require('node:crypto').createHash('sha256').update(request.publicKey.rpId).digest().copy(auth); auth[32] = 5;
          child.stdout.write(JSON.stringify({ type: 'result', credential: { type: 'public-key', id: 'AQ', rawId: 'AQ', extensions: { appid: null }, response: {
            authenticatorData: auth.toString('base64url'), clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: request.publicKey.challenge, origin: request.origin, crossOrigin: false })).toString('base64url'), signature: 'AQ', userHandle: null,
          } } }) + '\n');
        }, 30);
      });
      return child;
    };
  });
  let nativeId: number | undefined;
  try {
    const address = page.locator('.web-assist-address-input'); await address.fill(destination); await address.press('Enter');
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state', {})).state.tabs[0]?.loading).toBe(false);
    nativeId = await orkas.electronApp!.evaluate(({ webContents }, target) => webContents.getAllWebContents().find(c => c.getURL() === target)!.id, destination);
    const assertion = await orkas.electronApp!.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(`(async () => {
      const key = await CredentialsContainer.prototype.get.call(navigator.credentials, { publicKey: { challenge: new Uint8Array(3193).fill(7), rpId: 'google.com', userVerification: 'required', allowCredentials: [] } });
      const data = JSON.parse(new TextDecoder().decode(key.response.clientDataJSON));
      return { isCredential: key instanceof PublicKeyCredential, isResponse: key.response instanceof AuthenticatorAssertionResponse,
        rawId: [...new Uint8Array(key.rawId)], origin: data.origin, challengeBytes: Uint8Array.from(atob(data.challenge), c => c.charCodeAt(0)).length,
        json: key.toJSON(), extensions: key.getClientExtensionResults() };
    })()`), nativeId);
    expect(assertion).toMatchObject({ isCredential: true, isResponse: true, rawId: [1], origin: 'https://accounts.google.com', challengeBytes: 3193,
      json: { id: 'AQ', rawId: 'AQ', type: 'public-key', authenticatorAttachment: 'cross-platform', clientExtensionResults: {}, response: { signature: 'AQ' } }, extensions: {} });
    expect(await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/browser-passkey/index.html')).length)).toBe(0);
    await orkas.electronApp!.evaluate(({ webContents }, id) => {
      (globalThis as any).__phonePasskeyFixture.state.mode = 'hold';
      void webContents.fromId(id)!.executeJavaScript(`navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),rpId:'google.com',allowCredentials:[]}}).then(()=>{window.fixtureResult='unexpected-success'},e=>{window.fixtureResult=e.name})`);
    }, nativeId);
    await expect.poll(() => orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/browser-passkey/index.html')).length)).toBe(1);
    const state = (await orkas.invoke<any>('webAssist.state', {})).state;
    expect(JSON.stringify(state)).not.toMatch(/clientDataJSON|authenticatorData|signature|qr|credential/i);
    await address.fill('https://accounts.google.com/replacement-fixture'); await address.press('Enter');
    await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__phonePasskeyFixture.state.stopped)).toBe(2);
    await expect.poll(() => orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/browser-passkey/index.html')).length)).toBe(0);
  } finally {
    await orkas.invoke('webAssist.close', {});
    await orkas.electronApp!.evaluate(() => (globalThis as any).__phonePasskeyFixture?.restore());
  }
});

test('phone tunnel obeys the owning Session proxy and fails closed without bypassing it', async ({ modelOrkas: orkas }) => {
  test.skip(process.platform !== 'darwin', 'Mac hybrid transport coverage.');
  const proxyFailureDiagnostics = orkas.rendererDiagnosticCheckpoint();
  const destinations: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => { destinations.push(request.url!); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const result = await orkas.electronApp!.evaluate(async ({ session, BrowserWindow }, port) => {
      const ses = session.fromPartition('passkey-proxy-fixture'); await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${port}` });
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const path = require('node:path');
      const module = require(path.join(process.cwd(), 'src/main/features/web_assist_passkey_transport.ts'));
      module.configurePasskeyTransportSession(ses);
      return await new Promise(resolve => {
        let transport: any;
        const timer = setTimeout(() => { transport?.destroy(); resolve('timeout'); }, 10_000);
        transport = module.createPasskeyTransport({ session: ses, attachProxy: () => {},
          url: 'wss://cable.auth.com/cable/connect/010203/00000000000000000000000000000000',
          receive: () => { clearTimeout(timer); transport.destroy(); resolve('unexpected-open'); },
          unavailable: () => { clearTimeout(timer); resolve('proxy-rejected'); },
        });
      });
    }, (proxy.address() as { port: number }).port);
    expect(result).toBe('proxy-rejected'); expect(destinations).toEqual(['cable.auth.com:443']);
    expect(await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(win => win.webContents.getURL().endsWith('/browser-passkey/transport.html')).length)).toBe(0);
    await orkas.acknowledgeRendererFailure({ after: proxyFailureDiagnostics, count: 1,
      detail: "WebSocket connection to 'wss://cable.auth.com/cable/connect/010203/00000000000000000000000000000000' failed: " });
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
