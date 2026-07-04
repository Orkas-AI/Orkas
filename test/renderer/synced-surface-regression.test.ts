import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function cssBlock(css: string, selector: RegExp) {
  return css.match(selector)?.[1] || '';
}

function cssBlockLast(css: string, selector: RegExp) {
  return [...css.matchAll(selector)].at(-1)?.[1] || '';
}

describe('synced PC surface regressions', () => {
  it('keeps card Use actions as text buttons and reserves icon sizing for icon buttons', () => {
    const css = read('src/renderer/style.css');
    const html = read('src/renderer/index.html');

    const useBlock = cssBlock(css, /\.agent-card-use,\s*\.skill-card-use,\s*\.agent-dialog-btn\s*{([\s\S]*?)}/);
    expect(useBlock).toContain('padding: 4px 10px;');
    expect(useBlock).toContain('border-radius: 8px;');
    expect(useBlock).toContain('background: var(--primary);');
    expect(useBlock).not.toContain('width: 26px;');
    expect(useBlock).not.toContain('border-radius: 50%;');

    const iconBlock = cssBlock(css, /\.btn-icon-use\s*{([\s\S]*?)}/);
    expect(iconBlock).toContain('width: 26px;');
    expect(iconBlock).toContain('height: 26px;');
    expect(iconBlock).toContain('border-radius: 8px;');

    expect(css).toContain('.skill-card--global-group');
    expect(css).toContain('.skill-card-disclosure');
    expect(html).toContain('class="skill-card-use skill-dialog-btn" id="skill-use-btn"');
    expect(html).toContain('class="agent-card-use agent-dialog-btn" id="agent-use-btn"');
  });

  it('keeps synced tab card layout sizing for agent and marketplace chips', () => {
    const css = read('src/renderer/style.css');

    const agentCardBlock = cssBlockLast(css, /\.agent-card\s*{([\s\S]*?)}/g);
    expect(agentCardBlock).toContain('gap: 2px;');
    expect(agentCardBlock).toContain('min-height: 132px;');

    const agentHeaderBlock = cssBlockLast(css, /\.agent-card-header\s*{([\s\S]*?)}/g);
    expect(agentHeaderBlock).toContain('padding-right: 26px;');
    expect(css).toContain('.agent-card-title');
    expect(css).toContain('.agent-card-meta');

    const agentMoreBlock = cssBlockLast(css, /(?:^|\n)\.agent-card-more\s*{([\s\S]*?)}/g);
    expect(agentMoreBlock).toContain('position: absolute;');
    expect(agentMoreBlock).toContain('right: 12px;');
    expect(agentMoreBlock).toContain('width: 22px;');

    const skillDescBlock = cssBlock(css, /\.skill-card-desc\s*{([\s\S]*?)}/);
    expect(skillDescBlock).toContain('color: var(--text-2);');

    const chipBlock = cssBlock(css, /\.marketplace-card-chip,\s*\.skill-card-chip,\s*\.agent-card-chip\s*{([\s\S]*?)}/);
    expect(chipBlock).toContain('display: inline-flex;');
    expect(chipBlock).toContain('box-sizing: border-box;');
    expect(chipBlock).toContain('min-height: 20px;');
    expect(chipBlock).toContain('line-height: 1.2;');
  });

  it('keeps the external-agent entry copy aligned with external agents, not coding tools only', () => {
    const html = read('src/renderer/index.html');
    const en = read('src/renderer/locales/en.json');
    const zh = read('src/renderer/locales/zh.json');

    expect(html).toContain('other external agents');
    expect(en).toContain('other external agents');
    expect(zh).toContain('等外部智能体');
    expect(zh).not.toContain('AI 编程工具');
  });

  it('exposes the local Commander profile to the renderer', () => {
    const ipc = read('src/main/ipc/index.ts');
    const profile = read('src/main/data/commander.json');
    const fromToken = ['fr', 'om'].join('');
    const commanderProfileImport = ['im', 'port * as commanderProfile ', fromToken, " '", '..', "/features/commander_profile'"].join('');

    expect(ipc).toContain(commanderProfileImport);
    expect(ipc).toContain("'commander.getProfile'");
    expect(ipc).toContain("'commander.runtimeStats.get'");
    expect(profile).toContain('Orkas 的总调度者');
  });

  it('restores user-owned speech key configuration without exposing managed Orkas voice', () => {
    const html = read('src/renderer/index.html');
    const settings = read('src/renderer/modules/settings.js');
    const auth = read('src/main/features/auth.ts');
    const ipc = read('src/main/ipc/index.ts');
    const ttsAuth = read('src/main/features/tts_auth.ts');
    const fromToken = ['fr', 'om'].join('');
    const ttsAuthImport = ['im', 'port * as ttsAuth ', fromToken, " '", '..', "/features/tts_auth'"].join('');

    for (const marker of [
      'id="settings-tts-provider"',
      'id="settings-tts-key-input"',
      'id="settings-tts-add-btn"',
      'id="settings-tts-entries"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(settings).toContain("_settingsSafeCall('settings tts refresh', _settingsRefreshTtsProfiles)");
    expect(settings).toContain("window.orkas.invoke('ttsAuth.list')");
    expect(settings).toContain("window.orkas.invoke('ttsAuth.add'");
    expect(settings).toContain('_settingsRenderTtsEntries');
    expect(auth).toContain('export interface TtsProfile');
    expect(auth).toContain('export function loadTtsProfiles');
    expect(ipc).toContain(ttsAuthImport);
    expect(ipc).toContain("'ttsAuth.list'");
    expect(ttsAuth).toContain("id: 'doubao'");
    expect(ttsAuth).toContain("id: 'openai'");
    expect(ttsAuth).not.toContain('ORKAS_VOICE');
    expect(ttsAuth).not.toContain('Orkas · Voice');
  });
});
