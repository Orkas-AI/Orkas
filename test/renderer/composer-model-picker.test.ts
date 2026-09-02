import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.join(process.cwd(), 'src', 'renderer');

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('open-source composer model picker', () => {
  it('loads on every composer after dropdown placement support', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const placement = html.indexOf('./modules/dropdown-placement.js');
    const picker = html.indexOf('./modules/composer-model-picker.js');

    expect(placement).toBeGreaterThan(0);
    expect(picker).toBeGreaterThan(placement);
  });

  it('separates public official models from user-configured models without managed credits', () => {
    const source = fs.readFileSync(
      path.join(rendererRoot, 'modules', 'composer-model-picker.js'),
      'utf8',
    );

    expect(source).toContain("window.orkas.invoke('auth.listComposerEntries')");
    expect(source).toContain("entry.profileType !== 'managed'");
    expect(source).toContain("window.orkas.invoke('auth.selectEntry'");
    expect(source).not.toContain('getSubscription');
    expect(source).not.toContain('credits_remaining');
    expect(source).toContain('new_chat.model_picker.group_official');
    expect(source).toContain("entry.official === true && entry.provider === 'orkas-api'");
  });

  it('matches the commercial official-model grouping, recommendation, and descriptions', () => {
    const source = fs.readFileSync(
      path.join(rendererRoot, 'modules', 'composer-model-picker.js'),
      'utf8',
    );
    const zh = JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales', 'zh.json'), 'utf8'));
    const style = fs.readFileSync(path.join(rendererRoot, 'style.css'), 'utf8');

    class Element {
      type = '';
      className = '';
      textContent = '';
      innerHTML = '';
      disabled = false;
      dataset: Record<string, string> = {};
      children: Element[] = [];
      attributes = new Map<string, string>();
      listeners = new Map<string, () => unknown>();
      classList = { add: (name: string) => { this.className += ` ${name}`; } };
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      appendChild(child: Element) { this.children.push(child); return child; }
      addEventListener(name: string, handler: () => unknown) { this.listeners.set(name, handler); }
    }
    const interpolate = (key: string, values: Record<string, string> = {}) => (
      String(zh[key] || key).replace(/\{(\w+)\}/g, (_: string, name: string) => values[name] || '')
    );
    const context: any = {
      document: { createElement: () => new Element() },
      window: {},
      t: interpolate,
      _closeComposerModelMenu() {},
      _selectComposerModel() {},
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(source, '_composerModelEntryIsOfficial'),
      extractFunction(source, '_composerModelMenuGroups'),
      extractFunction(source, '_composerModelEntryLabel'),
      extractFunction(source, '_composerModelOfficialIncludedBody'),
      extractFunction(source, '_composerModelOfficialDescription'),
      extractFunction(source, '_buildComposerModelMenuItem'),
    ].join('\n'), context);

    const standard = {
      entryId: 'official-standard',
      provider: 'orkas-api',
      model: 'orkas-llm-1.5',
      modelName: 'Orkas-1.5',
      official: true,
      recommended: true,
      modelEditable: false,
      includedModels: ['DeepSeek V4', 'GPT-5.6 Luna', 'Claude-Sonnet-5', 'Gemini-3.6 Flash'],
    };
    const pro = {
      entryId: 'official-pro',
      provider: 'orkas-api',
      model: 'orkas-llm-1.5-pro',
      modelName: 'Orkas-1.5 Pro',
      official: true,
      modelEditable: false,
      includedModels: ['GPT-5.6 Sol', 'Claude Opus 5', 'Kimi K3'],
    };
    const custom = {
      entryId: 'custom-model', provider: 'anthropic', model: 'claude-opus-4-8',
    };
    const groups = context._composerModelMenuGroups([standard, custom, pro]);
    expect(groups.map((group: { key: string }) => group.key)).toEqual(['official', 'custom']);
    expect(groups[0].entries.map((entry: { entryId: string }) => entry.entryId))
      .toEqual(['official-standard', 'official-pro']);
    expect(groups[1].entries.map((entry: { entryId: string }) => entry.entryId))
      .toEqual(['custom-model']);

    const item = context._buildComposerModelMenuItem(
      standard,
      '',
      { dataset: { composerModelChip: 'conversation' }, focus() {} },
    );
    const title = item.children[0].children[0].children[0];
    expect(title.children[0].textContent).toBe('Orkas-1.5');
    expect(title.children[1].className).toBe('composer-model-menu-recommended');
    expect(title.children[1].textContent).toBe('推荐');
    expect(item.children[0].children[0].children[1].textContent).toBe(
      '适合问答、写作、办公等日常任务。包含：DeepSeek V4 · GPT-5.6 Luna · Claude-Sonnet-5 · Gemini-3.6 Flash',
    );
    expect(context._composerModelOfficialDescription(pro)).toBe(
      '适合研究、视频、研发等复杂任务。包含：GPT-5.6 Sol · Claude Opus 5 · Kimi K3',
    );
    expect(style).toMatch(/\.composer-model-menu-group \+ \.composer-model-menu-group\s*\{[^}]*border-top:\s*1px solid var\(--border\)/s);
  });
});
