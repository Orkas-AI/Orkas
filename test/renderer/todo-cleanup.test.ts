import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const { _todoCleanupMatches: matches } = require('../../src/renderer/modules/todo-cleanup.js');
const cutoff = Date.parse('2026-10-01T00:00:00Z');
const base = { id: 't_1', content: 'Work', status: 'done', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };
const filters = { project: 'all', owner: 'all', status: 'all' };

describe('to-do cleanup selection', () => {
  it('includes global and local project scopes without widening an exact selection', () => {
    const projects = [{ project_id: '' }, { project_id: 'local' }];
    expect(projects.map(project => matches(base, project, filters, cutoff, 'me'))).toEqual([true, true]);
    expect(matches(base, projects[1], { ...filters, project: '' }, cutoff, 'me')).toBe(false);
    expect(matches(base, projects[0], { ...filters, project: '' }, cutoff, 'me')).toBe(true);
  });
  it('filters every workflow status and keeps recent, boundary and invalid dates out of cleanup', () => {
    const project = { project_id: '' };
    for (const status of ['todo', 'progress', 'review', 'done']) {
      expect(matches({ ...base, status }, project, filters, cutoff, 'me')).toBe(true);
      expect(matches({ ...base, status }, project, { ...filters, status: 'done' }, cutoff, 'me')).toBe(status === 'done');
    }
    for (const updated_at of ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00.001Z', 'invalid']) {
      expect(matches({ ...base, updated_at }, project, filters, cutoff, 'me')).toBe(false);
    }
    expect(matches({ ...base, updated_at: '2026-09-30T23:59:59.999Z' }, project, filters, cutoff, 'me')).toBe(true);
  });
  it('uses the last edit rather than creation age, with legacy creation fallback and equivalent time zones', () => {
    const project = { project_id: '' };
    expect(matches({ ...base, updated_at: undefined }, project, filters, cutoff, 'me')).toBe(true);
    expect(matches({ ...base, updated_at: '2026-10-02T00:00:00Z' }, project, filters, cutoff, 'me')).toBe(false);
    // A malformed edit date cannot turn into permission to delete old work.
    expect(matches({ ...base, updated_at: 'invalid' }, project, filters, cutoff, 'me')).toBe(false);
    expect(matches({ ...base, updated_at: '2026-10-01T08:00:00+08:00' }, project, filters, cutoff, 'me')).toBe(false);
    expect(matches({ ...base, updated_at: '2026-09-30T16:59:59.999-07:00' }, project, filters, cutoff, 'me')).toBe(true);
  });
  it('provides all cleanup copy and placeholder contracts in every registered locale', () => {
    const root = path.resolve(__dirname, '../../src/renderer');
    const registry = fs.readFileSync(path.join(root, 'modules/i18n.js'), 'utf8');
    const codes = [...registry.matchAll(/\{"code": "([^"]+)"/g)].map(match => match[1]);
    const english = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
    const keys = Object.keys(english).filter(key => key.startsWith('todo.cleanup.'));
    expect(keys).toEqual(expect.arrayContaining(['todo.cleanup.title', 'todo.cleanup.count', 'todo.cleanup.confirm_message', 'todo.cleanup.result']));
    expect(codes.length).toBeGreaterThan(1);
    for (const locale of codes) {
      const table = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
      for (const key of keys) {
        expect(table[key], `${locale}: ${key}`).toBeTruthy();
        expect((table[key].match(/\{\w+\}/g) || []).sort()).toEqual((english[key].match(/\{\w+\}/g) || []).sort());
      }
    }
  });
});
