import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SHARED_PROMPT = path.join(PROJECT_ROOT, 'src/main/prompts/chat_shared_rules.md');
const COMMANDER_PROMPT = path.join(PROJECT_ROOT, 'src/main/prompts/chat_commander.md');
const AGENT_PROMPT = path.join(PROJECT_ROOT, 'src/main/prompts/chat_agent_in_group.md');

describe('execution-plan resident request surface', () => {
  it('spends no resident prompt surface on the disabled Orkas Plan', () => {
    const surfaces = [SHARED_PROMPT, COMMANDER_PROMPT, AGENT_PROMPT]
      .map((file) => fs.readFileSync(file, 'utf8'));
    expect(surfaces[0]).not.toMatch(/execution Plan|manage_execution_plan/i);
    expect(surfaces[1]).not.toMatch(/Commander Plan|execution Plan|Use a Plan|manage_execution_plan/i);
    expect(surfaces[2]).not.toMatch(/current-task execution Plan|manage_execution_plan/i);
  });
});
