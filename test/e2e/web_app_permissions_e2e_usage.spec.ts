import { readFileSync } from 'node:fs';
import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('app approval uses Orkas UI, lasts for this use, isolates windows and honors Trusted', async ({ modelOrkas: orkas }, info) => {
  const state = orkas.createFixtureFile('app-action-effects.json', '[]');
  const server = orkas.createFixtureFile('app-action-server.cjs', String.raw`
    const fs = require('node:fs');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:request.id, result })+'\n');
      if (request.method === 'initialize') reply({ protocolVersion:request.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'app-approval-fixture',version:'1'} });
      else if (request.method === 'tools/list') reply({tools:[{name:'record', description:'Record a controlled effect.', inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]});
      else if (request.method === 'tools/call') {
        const effects = JSON.parse(fs.readFileSync(process.env.APP_EFFECTS,'utf8'));
        effects.push(request.params.arguments.value); fs.writeFileSync(process.env.APP_EFFECTS,JSON.stringify(effects));
        reply({content:[{type:'text',text:'Recorded '+request.params.arguments.value}]});
      } else if (request.method === 'ping') reply({});
    });
  `);
  const connector: any = await orkas.invoke('connectors.add_custom', { display_name: 'App approval fixture',
    transport: { kind: 'stdio', command: process.execPath, args: [server], env: { APP_EFFECTS: state } } });
  expect(connector.ok).toBe(true);
  expect(connector.instance.status.kind).toBe('connected');
  const connectorId = connector.instance.id;
  const effects = () => JSON.parse(readFileSync(state, 'utf8'));
  await orkas.invoke('permissions.setLocalExecMode', { mode: 'all_files_approval' });
  // Native confirmation would reproduce the original regression. File pickers
  // retain their independent behavior; this journey records no remote effects.
  await orkas.electronApp!.evaluate(({ dialog }) => {
    (globalThis as any).__nativeAppConfirmations = 0;
    (dialog as any).showMessageBox = async () => {
      (globalThis as any).__nativeAppConfirmations++;
      return { response: 0, checkboxChecked: false };
    };
  });
  const entry = orkas.createWorkspaceFile('usage-app/index.html', `<!doctype html><html><head><script src="/__orkas/sdk.js"></script></head><body>
    <h1>Approval notebook</h1><input aria-label="Value" value="first"><button id="run">Record</button><p role="status">Ready</p>
    <script>document.querySelector('#run').onclick = async () => {
      const status = document.querySelector('[role=status]'); status.textContent='Waiting';
      try { const result = await orkasApp.tools.call({name:'call_connector_tool',arguments:{connector_id:${JSON.stringify(connectorId)},tool_name:'record',args:{value:document.querySelector('input').value}}});
        status.textContent = result.isError ? 'Denied' : 'Recorded';
      } catch (error) { status.textContent=error.code; }
    };</script></body></html>`);
  orkas.createWorkspaceFile('usage-app/orkas-app.json', JSON.stringify({sdkVersion:1,capabilities:['connectors']}));
  const first: any = await orkas.invoke('savedApps.saveFromPath', {path:entry,title:'Usage one'});
  const second: any = await orkas.invoke('savedApps.saveFromPath', {path:entry,title:'Usage two',mode:'new'});
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(second.id).not.toBe(first.id);
  await openSidebarEntry(orkas.page, '#apps-btn');
  const open = (id: string) => orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${id}"]`).click());
  let preview = await open(first.id);
  let frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  const run = async (value: string) => { await frame.getByRole('textbox').fill(value); await frame.getByRole('button', { name:'Record', exact:true }).click(); };
  await run('denied');
  const approval = preview.locator('.bash-permission-dialog');
  await expect(approval).toBeVisible();
  await expect(approval.locator('.ui-dialog-context')).toHaveText('Application request');
  await expect(approval.getByRole('button', { name:'Allow for this use', exact:true })).toBeVisible();
  await expect(approval.getByRole('button', { name:'Allow for this task', exact:true })).toHaveCount(0);
  await expect(orkas.page.locator('.bash-permission-dialog')).toHaveCount(0);
  expect(effects()).toEqual([]);
  await preview.screenshot({path:info.outputPath('app-sensitive-approval.png')});
  await approval.locator('[data-act="cancel"]').click();
  await expect(frame.getByRole('status')).toHaveText('Denied');
  expect(effects()).toEqual([]);
  await run('first');
  await approval.getByRole('button', { name:'Allow for this use', exact:true }).click();
  await expect(frame.getByRole('status')).toHaveText('Recorded');
  await run('repeat'); await expect(frame.getByRole('status')).toHaveText('Recorded');
  expect(effects()).toEqual(['first','repeat']);
  await expect(approval).toHaveCount(0);

  const other = await open(second.id);
  const otherFrame = other.locator('.saved-app-viewer-frame').contentFrame();
  await otherFrame.getByRole('button', {name:'Record',exact:true}).click();
  await expect(other.locator('.bash-permission-dialog')).toBeVisible();
  await expect(preview.locator('.bash-permission-dialog')).toHaveCount(0);
  await orkas.closePreview(other);
  expect(effects()).toEqual(['first','repeat']);
  await orkas.closePreview(preview);
  preview = await open(first.id); frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await run('reopened');
  await expect(preview.locator('.bash-permission-dialog')).toBeVisible();
  expect(effects()).toEqual(['first','repeat']);
  await preview.locator('.bash-permission-dialog [data-id="allow_once"]').click();
  await expect(frame.getByRole('status')).toHaveText('Recorded');
  await run('must-ask-again');
  await expect(preview.locator('.bash-permission-dialog')).toBeVisible();
  await preview.locator('.bash-permission-dialog [data-act="cancel"]').click();
  await expect(frame.getByRole('status')).toHaveText('Denied');
  await orkas.invoke('permissions.setLocalExecMode', {mode:'all_files_auto'});
  await run('trusted'); await expect(frame.getByRole('status')).toHaveText('Recorded');
  await expect(preview.locator('.bash-permission-dialog')).toHaveCount(0);
  expect(effects()).toEqual(['first','repeat','reopened','trusted']);
  expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__nativeAppConfirmations)).toBe(0);
  expect(orkas.modelRequests).toHaveLength(0);
  expect(await frame.locator('body').evaluate(async () => {
    try { await (window as any).orkasApp.appFiles.writeText({path:'escape.txt',text:'No'}); return 'unexpected'; }
    catch (error) { return (error as any).code; }
  })).toBe('E_NOT_DECLARED');
  await orkas.closePreview(preview);
  await orkas.invoke('connectors.remove', {id:connectorId});
});
