import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, openSidebarEntry, test } from './fixtures/orkas';

const issuer = 'https://app.openseo.so';
const resource = `${issuer}/mcp`;
const scopes = 'mcp offline_access';
const readTool = 'get_search_console_performance';
const widgetTool = 'show_search_console_performance';
const result = { ok: true, rows: [{ keys: ['organic search'], clicks: 17, impressions: 131, position: 4 }] };

function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

test('identifies failed OpenSEO authorization globally, then reads data and recovers from expiry and revocation', async ({ connectorOrkas: desktop }, testInfo) => {
  const page = desktop.page!;
  const electron = desktop.electronApp!;
  const pcRoot = path.resolve(__dirname, '../..');
  let consent: URL | undefined;
  let accessToken = '';
  let acceptIssuer = false;
  let expired = false;
  let revoked = false;
  let exchanged = 0;
  let refreshes = 0;
  const calls: unknown[] = [];

  // Provider and HTTPS callback bridge run in the test process; desktop OAuth, IPC,
  // encrypted storage and the Streamable HTTP MCP client run in Electron.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
    if (pathname === '/.well-known/oauth-protected-resource/mcp') {
      return send(response, 200, { resource, authorization_servers: [issuer], scopes_supported: ['mcp'] });
    }
    if (pathname === '/.well-known/oauth-authorization-server') {
      return send(response, 200, {
        issuer, authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
        registration_endpoint: `${issuer}/api/auth/oauth2/register`, token_endpoint: `${issuer}/api/auth/oauth2/token`,
        token_endpoint_auth_methods_supported: ['client_secret_post'], authorization_response_iss_parameter_supported: true,
      });
    }
    if (pathname === '/api/auth/oauth2/register') {
      const registration = JSON.parse(body);
      if (request.method !== 'POST' || registration.token_endpoint_auth_method !== 'client_secret_post'
        || !registration.redirect_uris?.[0]?.endsWith('/api/connectors/oauth/dcr-callback')) return send(response, 400, {});
      return send(response, 201, { client_id: 'fixture-client', client_secret: 'fixture-client-secret' });
    }
    if (pathname === '/api/connectors/oauth/dcr-exchange' && consent) {
      if (JSON.parse(body).exchange_code !== 'fixture-exchange') return send(response, 400, {});
      return send(response, 200, { code: 0, oauth_code: 'fixture-code', oauth_state: consent.searchParams.get('state'), oauth_issuer: acceptIssuer ? issuer : 'https://unexpected-issuer.example' });
    }
    if (pathname === '/api/auth/oauth2/token' && consent) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== `fixture-refresh-${exchanged}` || form.get('resource') !== resource) return send(response, 400, {});
        refreshes++;
        if (revoked) return send(response, 401, { error: 'invalid_grant' });
        if (!expired) return send(response, 400, {});
        expired = false;
        accessToken = 'fixture-access-renewed';
        return send(response, 200, { access_token: accessToken, refresh_token: `fixture-refresh-${exchanged}`, expires_in: 3600, scope: scopes });
      }
      if (form.get('grant_type') !== 'authorization_code') return send(response, 400, {});
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (form.get('code') !== 'fixture-code' || form.get('resource') !== resource
        || form.get('redirect_uri') !== consent.searchParams.get('redirect_uri')
        || challenge !== consent.searchParams.get('code_challenge')) return send(response, 400, {});
      exchanged++;
      revoked = false;
      accessToken = `fixture-access-${exchanged}`;
      return send(response, 200, { access_token: accessToken, refresh_token: `fixture-refresh-${exchanged}`, expires_in: 3600, scope: scopes });
    }
    if (pathname !== '/mcp') return send(response, 404, {});
    if (expired || revoked || request.headers.authorization !== `Bearer ${accessToken}`) {
      response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return send(response, 401, { error: 'invalid_token' });
    }
    if (request.method !== 'POST') return send(response, 405, {});
    const rpc = JSON.parse(body);
    const reply = (data: unknown) => send(response, 200, { jsonrpc: '2.0', id: rpc.id, result: data });
    if (rpc.method === 'initialize') return reply({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-openseo', version: '1.0' } });
    if (rpc.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
    if (rpc.method === 'tools/list') return reply({ tools: [readTool, widgetTool].map(name => ({
      name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    })) });
    if (rpc.method === 'tools/call') {
      calls.push({ tool: rpc.params.name, args: rpc.params.arguments });
      if (rpc.params.name === readTool) return reply({ content: [{ type: 'text', text: 'Search performance' }], structuredContent: result });
    }
    return send(response, 400, {});
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));

  try {
    await electron.evaluate(({ shell }, { pcRoot, issuer, fixtureOrigin }) => {
      const host = process as any;
      const bridge = host.mainModule.require(`${pcRoot}/src/main/features/connectors/_server_bridge.ts`);
      const bridgeOrigin = new URL(bridge.accountApiBase()).origin;
      const originalFetch = globalThis.fetch;
      const originalOpen = shell.openExternal;
      host.__openSeoConsent = '';
      shell.openExternal = async (url, options) => {
        if (new URL(url).origin !== issuer) return originalOpen(url, options);
        host.__openSeoConsent = url;
      };
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const relay = url.origin === bridgeOrigin && url.pathname === '/api/connectors/oauth/dcr-exchange';
        if (url.origin !== issuer && !relay) return originalFetch(input, init);
        const target = new URL(url.pathname + url.search, fixtureOrigin);
        if (input instanceof Request) return originalFetch(new Request(target, input), init);
        return originalFetch(target, init);
      };
      host.__restoreOpenSeoFixture = () => { globalThis.fetch = originalFetch; shell.openExternal = originalOpen; };
    }, { pcRoot, issuer, fixtureOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });

    const card = page.locator('.connector-card[data-id="openseo"]');
    const startAuthorization = async () => {
      await card.locator('[data-act="connect"]').click();
      const consentUrl = () => electron.evaluate(() => String((process as any).__openSeoConsent));
      await expect.poll(consentUrl).toMatch(/\/api\/auth\/oauth2\/authorize\?/);
      consent = new URL(await consentUrl());
      expect(consent.origin).toBe(issuer);
      expect(consent.searchParams.get('resource')).toBe(resource);
      expect(consent.searchParams.get('scope')).toBe(scopes);
    };
    const returnFromAuthorization = async () => {
      await electron.evaluate(({ app }) => {
        (process as any).__openSeoConsent = '';
        const url = 'orkas://connectors/oauth/dcr-callback?exchange_code=fixture-exchange';
        if (process.platform === 'darwin') app.emit('open-url', { preventDefault() {} }, url);
        else app.emit('second-instance', {}, [url]);
      });
    };
    const openOpenSeo = async () => {
      await openSidebarEntry(page, '#connectors-btn');
      await page.locator('#connectors-search-input').fill('OpenSEO');
    };
    const connect = async () => {
      await openOpenSeo();
      await startAuthorization();
      await returnFromAuthorization();
      await expect(card.locator('[data-act="use-connector"]')).toBeEnabled();
    };
    const invokeConnector = (name: string) => electron.evaluate(async (_electron, { pcRoot, name, readTool }) => {
      const host = process as any;
      const load = host.mainModule.require.bind(host.mainModule);
      const { createConnectorMetaTools } = load(`${pcRoot}/src/main/model/core-agent/connector-meta-tools.ts`);
      const { getActiveUserId } = load(`${pcRoot}/src/main/features/users.ts`);
      const tools = await createConnectorMetaTools({ userId: getActiveUserId(), allowCustomConnectorInstall: false }, 'full');
      const tool = tools.find((entry: { name: string }) => entry.name === 'call_connector_tool');
      if (!tool) return null;
      return tool.execute({ connector_id: 'openseo', tool_name: name,
        args: name === readTool ? { projectId: 'fixture-project', dimensions: ['query'] } : {} }, { signal: new AbortController().signal });
    }, { pcRoot, name, readTool });

    const originalViewport = page.viewportSize()!;
    for (const [lang, heading] of [['zh', 'OpenSEO 连接器'], ['en', 'OpenSEO connector']]) {
      await page.evaluate(locale => (window as any).setLang(locale), lang);
      if (lang === 'en') await page.setViewportSize({ width: 800, height: 640 });
      await openOpenSeo();
      await startAuthorization();
      await openSidebarEntry(page, '#new-chat-btn');
      await expect(page.locator('#panel-new-chat')).toBeVisible();
      await returnFromAuthorization();
      const alert = page.getByRole('alertdialog');
      await expect(alert).toContainText(heading);
      await expect(alert).not.toContainText('unexpected-issuer.example');
      const confirm = alert.locator('[data-act="ok"]');
      await expect(confirm).toBeFocused();
      await expect(confirm).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`openseo-authorization-${lang}.png`) });
      await page.keyboard.press('Enter');
      await expect(alert).toHaveCount(0);
      await expect(page.locator('#panel-new-chat')).toBeVisible();
    }
    await page.setViewportSize(originalViewport);
    const rejected = await desktop.invoke<{ instances: Array<{ id: string }> }>('connectors.list');
    expect(rejected.instances.some(instance => instance.id === 'openseo')).toBe(false);
    expect(exchanged).toBe(0);
    expect(refreshes).toBe(0);

    acceptIssuer = true;
    await connect();
    expect(exchanged).toBe(1);
    const connected = await desktop.invoke<{ instances: unknown[] }>('connectors.list');
    expect(connected.instances).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'openseo', tools_count: 1 })]));
    expect(JSON.stringify(connected)).not.toContain('fixture-access-');
    expect(await invokeConnector(readTool)).toMatchObject({ content: expect.stringContaining(JSON.stringify({ structuredContent: result })) });
    expect(await invokeConnector(widgetTool)).toMatchObject({ isError: true });
    expect(calls).toEqual([{ tool: readTool, args: { projectId: 'fixture-project', dimensions: ['query'] } }]);

    expired = true;
    expect(await desktop.invoke('connectors.refresh', { id: 'openseo' })).toMatchObject({ instance: { status: { kind: 'connected' } } });
    expect({ exchanged, refreshes }).toEqual({ exchanged: 1, refreshes: 1 });
    expect(await invokeConnector(readTool)).toMatchObject({ content: expect.stringContaining('"clicks":17') });

    revoked = true;
    expect(await desktop.invoke('connectors.refresh', { id: 'openseo' })).toMatchObject({ instance: { status: { kind: 'error' } } });
    expect(refreshes).toBe(2);
    expect(await invokeConnector(readTool)).toBeNull();
    expect(calls).toHaveLength(2);
    await page.reload();
    await connect();
    expect({ exchanged, refreshes }).toEqual({ exchanged: 2, refreshes: 2 });
    expect(await invokeConnector(readTool)).toMatchObject({ content: expect.stringContaining('"clicks":17') });
    expect(calls).toHaveLength(3);
  } finally {
    try {
      await electron.evaluate(() => (process as any).__restoreOpenSeoFixture?.());
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
