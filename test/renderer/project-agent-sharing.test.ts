import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
const start = source.indexOf('function _renderProjectAgentCards(items) {');
const end = source.indexOf('function _bindProjectAgentCards()', start);
if (start < 0 || end < 0) throw new Error('project Agent card renderer missing');
const projectMeta = { project: {} };
const renderCards = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
  _byDisplayName: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
  _projectDetailMeta: projectMeta,
  currentUserId: 'member',
  _projectDetailPid: 'project',
  escapeHtml: (value: string) => value,
  t: (key: string) => key,
  _projectUiIconHtml: (name: string) => `<svg data-icon="${name}"></svg>`,
});

describe('ordinary project Agent controls', () => {
  it('omits privacy locks for every Agent in an ordinary project', () => {
      for (const agent of [
        { source: 'custom', shared_with_members: false, runtime: { kind: 'in_process' } },
        { source: 'custom', shared_with_members: false, runtime: { kind: 'cli' } },
        { source: 'marketplace', seed_source: 'platform', shared_with_members: true },
        { source: 'builtin' },
      ]) {
        const html = renderCards([{ agent_id: 'agent', name: 'Agent', ...agent }]);
        expect(html).not.toContain('data-icon="lock"');
        expect(html).not.toContain('project-agent-row-sharing');
        expect(html).toContain('data-project-agent-run');
        expect(html).toContain('data-project-agent-remove');
      }
  });

});
