/**
 * Stage-0 smoke test — runs paths.ts / storage.ts / prompts/loader.ts
 * in plain Node (no Electron) against an isolated temp data root, and prints
 * a compact report.
 *
 *   tsx main/smoke.ts
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function section(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

(async () => {
  const smokeRoot = process.env.ORKAS_WORKSPACE_ROOT
    ? ''
    : fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-smoke-root-'));
  if (smokeRoot) process.env.ORKAS_WORKSPACE_ROOT = smokeRoot;

  try {
    const paths = await import('./paths');
    const storage = await import('./storage');
    const { prompts, safeSubstitute } = await import('./prompts/loader');

    console.log('[smoke] paths');
    await section('PC_ROOT is the flat app root', () =>
      assert.strictEqual(paths.PC_ROOT, path.resolve(__dirname, '..', '..')));
    await section('APP_ROOT === PC_ROOT (flat layout)', () => assert.ok(paths.APP_ROOT === paths.PC_ROOT));
    await section('WS_ROOT derivable', () => assert.ok(paths.WS_ROOT.length > 0));
    await section('USERS_FILE at data root', () =>
      assert.strictEqual(paths.USERS_FILE, path.join(paths.WS_ROOT, 'users.json')));
    await section('userMarketplaceSkillsDir under local', () =>
      assert.ok(paths.userMarketplaceSkillsDir('12345678').endsWith('/12345678/local/marketplace/skills')));
    await section('userMarketplaceAgentsDir under local', () =>
      assert.ok(paths.userMarketplaceAgentsDir('12345678').endsWith('/12345678/local/marketplace/agents')));
    await section('userChatsDir in cloud', () =>
      assert.ok(paths.userChatsDir('12345678').endsWith('/12345678/cloud/chats')));
    await section('userAuthProfilesFile in local', () =>
      assert.ok(paths.userAuthProfilesFile('12345678').endsWith('/12345678/local/config/auth-profiles.json')));

    console.log('[smoke] storage');
    await section('nowIso matches YYYY-MM-DDTHH:MM:SS', () =>
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(storage.nowIso())));
    await section('genUserId is 8 digits', () => assert.ok(/^\d{8}$/.test(storage.genUserId())));
    await section('genId12 is 12 hex', () => assert.ok(/^[0-9a-f]{12}$/.test(storage.genId12())));
    await section('safeId rejects traversal', () => assert.ok(!storage.safeId('../evil')));
    await section('safeId accepts normal', () => assert.ok(storage.safeId('abc-123_XYZ')));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-smoke-'));
    try {
      await section('writeJson / readJson roundtrip', async () => {
        const p = path.join(tmpDir, 'a.json');
        await storage.writeJson(p, { x: 1, 中: '文' });
        const r = await storage.readJson(p);
        assert.deepStrictEqual(r, { x: 1, 中: '文' });
      });
      await section('appendJsonl / readJsonl tail', async () => {
        const p = path.join(tmpDir, 'b.jsonl');
        for (let i = 0; i < 5; i++) await storage.appendJsonl(p, { i });
        const last3 = await storage.readJsonl<{ i: number }>(p, 3);
        assert.deepStrictEqual(last3.map((r) => r.i), [2, 3, 4]);
      });
      await section('writeJson atomicity (no .tmp left)', async () => {
        const p = path.join(tmpDir, 'c.json');
        await storage.writeJson(p, { ok: true });
        assert.ok(!fs.existsSync(p + '.tmp'));
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('[smoke] prompts');
    await section('chat_commander template renders', () => {
      const rendered = prompts.load('chat_commander', {
        contexts_dir: '/ctx',
        builtin_agents_dir: '/b/a', custom_agents_dir: '/c/a',
        builtin_skills_dir: '/b/s', custom_skills_dir: '/c/s',
        agents_index: '- foo', plan_state: '',
        os: 'macOS', working_dir: '/tmp', shell_hint: '', local_exec_state: 'x',
        output_format_hint: 'x',
        project_files_block: '',
      });
      assert.ok(typeof rendered === 'string' && rendered.length > 0);
    });
    await section('unknown template returns empty', () => {
      assert.strictEqual(prompts.load('__does_not_exist__'), '');
    });
    await section('safeSubstitute $$ escapes', () =>
      assert.strictEqual(safeSubstitute('price=$$9', {}), 'price=$9'));
    await section('safeSubstitute ${braced}', () =>
      assert.strictEqual(safeSubstitute('hi ${name}!', { name: 'Bob' }), 'hi Bob!'));
    await section('safeSubstitute unknown keeps literal', () =>
      assert.strictEqual(safeSubstitute('x=$foo', {}), 'x=$foo'));
    await section('safeSubstitute mixed bag', () =>
      assert.strictEqual(
        safeSubstitute('${a} and $b but not $c and $$ is literal', { a: '1', b: '2' }),
        '1 and 2 but not $c and $ is literal'));
  } finally {
    if (smokeRoot) fs.rmSync(smokeRoot, { recursive: true, force: true });
  }

  console.log(process.exitCode ? '[smoke] FAILED' : '[smoke] OK');
})();
