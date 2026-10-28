import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';


test('shows compact remaining allowance for both CLIs without starting a task', async ({ cliOrkas }, testInfo) => {
  const app = cliOrkas; const page = app.page!;
  const requests = path.join(app.root, 'quota-requests');
  writeFileSync(requests, '');
  const ordinary = await app.invoke<any>('agents.create', {
    name: 'Quota_ordinary', description: 'Ordinary agent without a CLI account',
  });
  expect(ordinary.ok).toBe(true);
  const section = page.locator('#agents-detail-cli-usage-section');
  const openOrdinary = async (label: string, language: string) => {
    await page.evaluate(async ({ id, language }) => {
      await (window as any).setLang(language);
      await (window as any).openAgentDetail(id);
    }, { id: ordinary.agent.agent_id, language });
    await page.screenshot({ path: testInfo.outputPath(`quota-ordinary-${label}.png`) });
    await expect(section).toBeHidden();
  };
  await openOrdinary('initial', 'zh');
  for (const cli of ['codex', 'claude'] as const) {
    const script = path.join(app.root, `quota-${cli}.cjs`);
    const source = `const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('${cli === 'codex' ? '0.160.0' : '2.1.296'}');
else if (process.argv.includes('--help')) console.log('Usage: ${cli} --model --effort --safe-mode --bare');
else require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(m) + '\\n');
  let result = {};
  if (m.method === 'model/list') result = { data: [{ id: 'model-example', isDefault: true }] };
  if (m.method === 'account/rateLimits/read') result = { rateLimits: {
    primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1900000000 },
    secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1900100000 } } };
  if (m.id !== undefined) console.log(JSON.stringify({ id: m.id, result }));
  if (m.type === 'control_request') console.log(JSON.stringify({ type: 'control_response', response: {
    request_id: m.request_id, subtype: 'success', response: m.request.subtype === 'get_usage' ? {
      rate_limits_available: true, rate_limits: { five_hour: { utilization: 25, resets_at: '2030-03-17T00:00:00Z' },
      seven_day: { utilization: 0, resets_at: null } } } : {} } }));
});`;
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    const bin = path.join(app.root, `quota-${cli}${process.platform === 'win32' ? '.cmd' : ''}`);
    writeFileSync(script, source);
    writeFileSync(bin, process.platform === 'win32' ? `@echo off\r\n"${node}" "${script}" %*\r\n` : `#!${node}\n${source}`);
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    await app.electronApp!.evaluate((_electron, args) => { process.env[args.key] = args.bin; }, {
      key: cli === 'codex' ? 'ORKAS_CODEX_PATH' : 'ORKAS_CLAUDE_PATH', bin,
    });
    await app.invoke('localAgents.detect', { type: cli });
    const created = await app.invoke<any>('agents.create', {
      name: `Quota_${cli}`, description: 'Account allowance fixture', runtime: { kind: 'cli', cli },
    });
    expect(created.ok).toBe(true);
    await page.evaluate(async id => {
      await (window as any).setLang('zh'); await (window as any).openAgentDetail(id);
    }, created.agent.agent_id);
    await expect(section).toBeVisible();
    await expect(section).toContainText(cli === 'codex' ? '83%' : '75%');
    await expect(section).toContainText('重置时间');
    await expect(section.locator('.agents-detail-label')).toHaveText('剩余额度');
    await expect(section.getByRole('button')).toHaveCount(0);
    await expect(section).not.toContainText('同一 CLI');
    await expect(section).not.toContainText('更新于');
    await page.screenshot({ path: testInfo.outputPath(`quota-${cli}.png`) });
    await openOrdinary(`after-${cli}`, cli === 'codex' ? 'en' : 'zh');
  }
  await page.setViewportSize({ width: 900, height: 650 });
  for (const cli of ['opencode', 'hermes'] as const) {
    const created = await app.invoke<any>('agents.create', {
      name: `Quota_${cli}`, description: 'CLI without account allowance support', runtime: { kind: 'cli', cli },
    });
    expect(created.ok).toBe(true);
    await page.evaluate(async id => { await (window as any).openAgentDetail(id); }, created.agent.agent_id);
    await expect(section).toBeHidden();
  }
  await openOrdinary('narrow', 'en');
  const observed = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(observed.some(r => r.method === 'account/rateLimits/read')).toBe(true);
  expect(observed.some(r => r.request?.subtype === 'get_usage')).toBe(true);
  expect(observed.filter(r => r.method === 'turn/start' || r.method === 'thread/start' || r.type === 'user')).toEqual([]);
});
