import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const indexHtml = read('src/renderer/index.html');
const settingsJs = read('src/renderer/modules/settings.js');
const bootJs = read('src/renderer/modules/boot.js');

function previousSettingsGroupTag(controlId: string) {
  const idMatch = new RegExp(`id=["']${controlId}["']`).exec(indexHtml);
  expect(idMatch, `${controlId} should be present or this guard needs updating`).toBeTruthy();
  const before = indexHtml.slice(0, idMatch!.index);
  const matches = Array.from(before.matchAll(/<div\b[^>]*>/g))
    .filter((match) => {
      const classAttr = /\bclass=["']([^"']*)["']/.exec(match[0]);
      const classes = classAttr ? classAttr[1].split(/\s+/).filter(Boolean) : [];
      return classes.includes('settings-group');
    });
  return matches[matches.length - 1]?.[0] || '';
}

function liveLines(raw: string) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*'));
}

function count(raw: string, needle: string) {
  return raw.split(needle).length - 1;
}

describe('OrkasOpen Settings sync guards', () => {
  it('loads the standalone settings tabs module before settings.js', () => {
    const tabsScript = '<script src="./modules/settings_tabs.js"></script>';
    const settingsScript = '<script src="./modules/settings.js"></script>';

    const tabsIndex = indexHtml.indexOf(tabsScript);
    const settingsIndex = indexHtml.indexOf(settingsScript);

    expect(tabsIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(tabsIndex).toBeLessThan(settingsIndex);
    expect(indexHtml).toMatch(/class=["'][^"']*\bsettings-tab\b[^"']*\bis-active\b[^"']*["'][^>]*data-settings-tab=["']data["']/);
  });

  it('keeps unsupported search and image provider controls hidden from OrkasOpen', () => {
    for (const controlId of ['settings-search-provider', 'settings-image-provider']) {
      const groupTag = previousSettingsGroupTag(controlId);
      expect(groupTag).toMatch(/\bhidden\b/);
      expect(groupTag).toMatch(/\bdata-open-unsupported=["']1["']/);
    }
  });

  it('isolates settings refresh/render failures and skips hidden provider sections', () => {
    expect(settingsJs).toContain('async function _settingsSafeCall');

    const loadSettingsStart = settingsJs.indexOf('async function loadSettings()');
    expect(loadSettingsStart).toBeGreaterThanOrEqual(0);
    const loadSettingsSnippet = settingsJs.slice(loadSettingsStart, loadSettingsStart + 4000);

    for (const marker of [
      "_settingsSafeCall('settings providers refresh'",
      "_settingsSafeCall('settings entries refresh'",
      "_settingsSafeCall('settings picker render'",
      "_settingsSafeCall('settings entries render'",
    ]) {
      expect(loadSettingsSnippet).toContain(marker);
    }

    expect(loadSettingsSnippet).not.toMatch(/await\s+Promise\.all\s*\(\s*\[\s*_settingsRefresh/);
    expect(count(settingsJs, "_settingsIsOpenUnsupported('settings-search-provider')")).toBeGreaterThanOrEqual(2);
    expect(count(settingsJs, "_settingsIsOpenUnsupported('settings-image-provider')")).toBeGreaterThanOrEqual(2);
  });

  it('does not leave bare PC-only settings renderer calls after stripping', () => {
    for (const line of liveLines(settingsJs)) {
      if (/_settingsRenderVideoSection\s*\(\s*\)/.test(line)) {
        expect(line).toMatch(/typeof\s+_settingsRenderVideoSection\s*===\s*['"]function['"]/);
      }
      expect(line).not.toMatch(/\brender(?:Account|Subscription)Settings\s*\(/);
    }
  });

  it('catches settings load failures at the tab-entry boundary', () => {
    expect(bootJs).not.toMatch(/\bloadSettings\(\);/);
    expect(bootJs).toMatch(/Promise\.resolve\(\s*loadSettings\(\)\s*\)[\s\S]{0,400}\.catch\s*\(/);
  });
});
