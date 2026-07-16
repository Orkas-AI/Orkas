import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const indexSource = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const lazySource = fs.readFileSync(path.join(rendererRoot, 'modules/lazy-features.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(rendererRoot, 'modules/skills.js'), 'utf8');
const chatUseSource = fs.readFileSync(path.join(rendererRoot, 'modules/chat-use.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(rendererRoot, 'modules/conversation.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(rendererRoot, 'modules/queue-draft.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8');
const agentsSource = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');

describe('chat-use core and lazy Skills page boundary', () => {
  it('loads the composer core eagerly before every send and draft consumer', () => {
    const chatUseTag = indexSource.indexOf('<script src="./modules/chat-use.js"></script>');
    const conversationTag = indexSource.indexOf('<script src="./modules/conversation.js"></script>');
    const queueTag = indexSource.indexOf('<script src="./modules/queue-draft.js"></script>');

    expect(chatUseTag).toBeGreaterThan(-1);
    expect(chatUseTag).toBeLessThan(conversationTag);
    expect(chatUseTag).toBeLessThan(queueTag);
    expect(chatUseSource).toContain('function transformWithChatUse');
    expect(chatUseSource).toContain('function setChatUseSelection');
    expect(chatUseSource).toContain('function consumeChatUseSelections');
  });

  it('keeps only Skills-page code in the lazy feature bundle', () => {
    expect(lazySource).toContain("skills: [");
    expect(lazySource).toContain("{ src: './modules/skills.js' }");
    expect(skillsSource).not.toContain('function transformWithChatUse');
    expect(skillsSource).not.toContain('function setChatUseSelection');
  });

  it('does not load the Skills page from send paths', () => {
    expect(conversationSource).toContain('transformWithChatUse(requestText)');
    expect(conversationSource).not.toContain("loadRendererFeature('skills')");
    expect(queueSource).toContain('transformWithChatUse(next.content, use)');
    expect(projectSource).toContain('transformWithChatUse(requestText)');
  });

  it('guards optional lazy Skills refreshes as undeclared globals', () => {
    expect(conversationSource).not.toMatch(/\bloadSkills\?\./);
    expect(conversationSource).toContain("typeof loadSkills === 'function'");
    expect(agentsSource).toContain("typeof _skillsCache !== 'undefined'");
  });

  it('loads the small KB picker on its explicit action without loading Contexts', () => {
    expect(lazySource).toContain("'kb-picker': [");
    expect(conversationSource).toContain("await loader('kb-picker')");
    expect(conversationSource).toContain("typeof pickKbLocation !== 'function'");
  });
});
