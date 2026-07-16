import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('renderer conversation-list pagination wiring', () => {
  it('uses bounded routine refreshes and explicit 10-row page controls', () => {
    const conversation = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
    const projects = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/projects.js'), 'utf8');
    const projectDetail = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');

    expect(conversation).toContain('const startup = !(options && options.full === true)');
    expect(conversation).toContain('mode=project&project_id=${encodeURIComponent(pid)}&offset=${offset}');
    expect(conversation).toContain('mode=old_unprojected&bucket=${bucket}&offset=${offset}');
    expect(conversation).toContain('data-conv-bucket-more="1"');
    expect(conversation).not.toMatch(/_deleteConversationWithConfirm[\s\S]*?await loadConversations\(\);[\s\S]*?function _conversationActionItems/);
    expect(projects).toContain('data-project-conv-more=');
    expect(projects).toContain('loadConversationProject(pid, { append: true })');
    expect(projectDetail).toContain('data-project-detail-conv-more="1"');
  });
});
