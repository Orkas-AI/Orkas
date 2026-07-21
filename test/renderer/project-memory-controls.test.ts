import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererRoot, 'style.css'), 'utf8');
const locales = Object.fromEntries(['en', 'zh', 'ja', 'pt'].map((locale) => [
  locale,
  JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales', `${locale}.json`), 'utf8')),
]));

describe('project memory controls', () => {
  it('exposes add/edit/delete controls through project-scoped memory IPC', () => {
    expect(html).toContain('id="project-memory-add-btn"');
    expect(html).toContain('id="project-memory-editor-input"');
    expect(source).toContain("isEdit ? 'memory.replace' : 'memory.add'");
    expect(source).toContain("_mutateProjectMemory('memory.remove', { oldText: text })");
    expect(source).toContain("target: 'project'");
    expect(source).toContain('projectId: pid');
  });

  it('uses a dedicated editor state with concise context guidance', () => {
    expect(html).toContain('data-i18n="project.instructions.subtitle"');
    expect(html).toContain('data-i18n="project.memory.subtitle"');
    expect(html).toContain('class="project-detail-tab-group" role="tablist"');
    expect(html).toMatch(/project-side-card-head project-side-card-head-tabs[\s\S]*?data-project-side-tabs="context"/);
    expect(html).toMatch(/project-side-card-head project-side-card-head-tabs[\s\S]*?data-project-side-tabs="resources"/);
    expect(styles).toContain('.project-memory-editor:not([hidden]) ~ .project-memory-list');
    expect(styles).toContain('.project-memory-editor:not([hidden]) ~ .empty');
    expect(source).toContain('input.setSelectionRange(end, end)');
    expect(source).not.toContain('input.select()');
  });

  it('keeps live progress out of project-memory guidance in every locale', () => {
    const forbidden: Record<string, RegExp> = {
      en: /\b(progress|update)\b/i,
      zh: /进展|进度/,
      ja: /進捗/,
      pt: /avanços|atualizaç/i,
    };
    for (const [locale, table] of Object.entries(locales)) {
      const guidance = `${table['project.memory.subtitle']} ${table['project.memory.placeholder']}`;
      expect(guidance, locale).not.toMatch(forbidden[locale]);
    }
  });

  it('guards project-instruction saves with dirty, limit, and error states', () => {
    expect(source).toContain("window.orkas.invoke('projects.instructions.set'");
    expect(source).toContain("input.value !== (input.dataset.savedValue || '')");
    expect(source).toContain('saveBtn.disabled = !dirty || over');
    expect(source).toContain("uiAlert(t('project.instructions.save_failed'))");
    expect(source).toContain("_projectTrackEvent('project_instructions_update_result'");
    expect(source).toContain("result: 'success'");
    expect(source).toContain("result: 'failure'");
    expect(source).toContain('duration_ms: Math.max(0, Math.round(performance.now() - startedAt))');
  });
});
