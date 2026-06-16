import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const indexHtml = read('src/renderer/index.html');
const settingsJs = read('src/renderer/modules/settings.js');
const styleCss = read('src/renderer/style.css');
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

describe('open-source Settings sync guards', () => {
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

  it('keeps BYO search, image, and video provider controls visible and wired', () => {
    for (const controlId of ['settings-search-provider', 'settings-image-provider', 'settings-video-provider']) {
      const groupTag = previousSettingsGroupTag(controlId);
      expect(groupTag).not.toMatch(/\bhidden\b/);
      expect(groupTag).not.toMatch(/\bdata-open-unsupported=["']1["']/);
    }
    expect(settingsJs).toContain('searchAuth.list');
    expect(settingsJs).toContain('searchAuth.add');
    expect(settingsJs).toContain('imageAuth.list');
    expect(settingsJs).toContain('imageAuth.add');
    expect(settingsJs).toContain('videoAuth.list');
    expect(settingsJs).toContain('videoAuth.add');
  });

  it('keeps video key setup provider-only and hides image Seedream version details', () => {
    expect(indexHtml).toContain('id="settings-video-provider"');
    expect(indexHtml).not.toContain('id="settings-video-model"');
    expect(settingsJs).not.toContain('videoModelSel');
    expect(settingsJs).not.toContain('videoModelsByProvider');
    expect(settingsJs).not.toContain('modelsByProvider');
    expect(settingsJs).not.toContain('_videoModelLabel');
    expect(settingsJs).not.toContain('_settingsRenderVideoModelPicker');
    expect(settingsJs).not.toContain('settings.video.pick_model');
    expect(settingsJs).not.toContain('settings.video.error_model_needed');
    expect(settingsJs).not.toContain('Seedance 2.0');

    expect(settingsJs).toContain('DouBao · Seedream');
    expect(settingsJs).not.toContain('Seedream 3.0');
  });

  it('keeps model authorization add flow usable after open-source stripping', () => {
    for (const id of [
      'settings-picker-provider',
      'settings-picker-model',
      'settings-add-entry-btn',
      'settings-picker-status',
      'add-account-modal',
      'add-account-title',
      'add-account-body',
      'add-account-actions',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    expect(settingsJs).not.toContain('addBtnBound');
    expect(settingsJs).toContain('addBtnEl');
    expect(settingsJs).toContain('_settingsState.addBtnEl !== addBtn');
    expect(settingsJs).toContain('_settingsState.pickerProviderEl !== providerEl');
    expect(settingsJs).toContain('_settingsState.pickerModelEl !== modelEl');
  });

  it('keeps the local execution permission mode UI spacing fix', () => {
    expect(indexHtml).toContain('id="settings-localexec-modes"');
    expect(styleCss).toContain('.settings-row.settings-mode-list > .settings-mode-opt');
    expect(styleCss).toContain('flex: 0 0 auto;');
    expect(styleCss).toContain('.settings-mode-label { font-size: 13px; color: var(--text); }');
  });

  it('isolates settings refresh/render failures while loading BYO provider sections', () => {
    expect(settingsJs).toContain('async function _settingsSafeCall');

    const loadSettingsStart = settingsJs.indexOf('async function loadSettings()');
    expect(loadSettingsStart).toBeGreaterThanOrEqual(0);
    const loadSettingsSnippet = settingsJs.slice(loadSettingsStart, loadSettingsStart + 4000);

    for (const marker of [
      "_settingsSafeCall('settings providers refresh'",
      "_settingsSafeCall('settings entries refresh'",
      "_settingsSafeCall('settings search refresh'",
      "_settingsSafeCall('settings image refresh'",
      "_settingsSafeCall('settings video refresh'",
      "_settingsSafeCall('settings picker render'",
      "_settingsSafeCall('settings entries render'",
      "_settingsSafeCall('settings search render'",
      "_settingsSafeCall('settings image render'",
      "_settingsSafeCall('settings video render'",
    ]) {
      expect(loadSettingsSnippet).toContain(marker);
    }

    expect(loadSettingsSnippet).not.toMatch(/await\s+Promise\.all\s*\(\s*\[\s*_settingsRefresh/);
    expect(settingsJs).not.toContain('_settingsIsOpenUnsupported');
  });

  it('does not expose Orkas-managed search, image, or video providers', () => {
    for (const marker of [
      ['Orkas', 'Search'].join('-'),
      ['orkas', 'search'].join('-'),
      ['orkas', 'search'].join('_'),
      ['Orkas', 'Image'].join('-'),
      ['orkas', 'image'].join('-'),
      ['orkas', 'image'].join('_'),
      ['Orkas', 'Video'].join('-'),
      ['orkas', 'video'].join('-'),
      ['orkas', 'video'].join('_'),
    ]) {
      expect(settingsJs).not.toContain(marker);
      expect(indexHtml).not.toContain(marker);
    }
  });

  it('does not leave bare PC-only settings renderer calls after stripping', () => {
    for (const line of liveLines(settingsJs)) {
      expect(line).not.toMatch(/\brender(?:Account|Subscription)Settings\s*\(/);
    }
  });

  it('catches settings load failures at the tab-entry boundary', () => {
    expect(bootJs).not.toMatch(/\bloadSettings\(\);/);
    expect(bootJs).toMatch(/Promise\.resolve\(\s*loadSettings\(\)\s*\)[\s\S]{0,400}\.catch\s*\(/);
  });
});
