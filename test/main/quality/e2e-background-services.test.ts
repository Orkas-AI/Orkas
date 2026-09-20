import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackgroundServices } from '../../e2e/fixtures/background-services';

describe('E2E background service contracts', () => {
  it('freezes matching catalog versions and assets, filters lookups, and keeps undeclared routes failing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orkas-fixture-catalog-'));
    try {
      mkdirSync(path.join(root, 'account/cloud/marketplace'), { recursive: true });
      const agentDir = path.join(root, 'account/local/marketplace/agents/agent-a');
      mkdirSync(agentDir, { recursive: true });
      const file = path.join(agentDir, 'agent.json');
      const original = JSON.stringify({ agent_id: 'agent-a', name: 'Example', version: '2.0.0' });
      writeFileSync(file, original);
      writeFileSync(path.join(root, 'account/cloud/marketplace/installs.json'), JSON.stringify({
        agents: [{ id: 'agent-a', version: '2.0.0', published_at: 1 }], skills: [],
      }));
      const service = new BackgroundServices(root, 'account');
      const request = (route: string, body = {}) => service.marketplace(route, Buffer.from(JSON.stringify(body)), 'http://127.0.0.1:1234');
      expect(request('/agents/list', { ids: ['agent-a'] }).body).toMatchObject({ code: 0, total: 1, list: [{ id: 'agent-a', version: '2.0.0' }] });
      expect(request('/agents/list', { ids: ['agent-ab'] }).body).toEqual({ code: 0, total: 0, list: [] });
      const detail = request('/agents/detail', { id: 'agent-a' }).body as Record<string, any>;
      writeFileSync(file, 'local edit after catalog snapshot');
      expect(service.asset(new URL(detail.agent_json_url).pathname)?.toString()).toBe(original);
      expect(request('/defaults').body).toEqual({ code: 0, agents: [], skills: [] });
      expect(request('/agents/detail', { id: 'missing' }).status).toBe(404);
      expect(request('/undeclared').status).toBe(404);
      expect(service.marketplace('/agents/list', Buffer.from('not-json'), '').status).toBe(400);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
