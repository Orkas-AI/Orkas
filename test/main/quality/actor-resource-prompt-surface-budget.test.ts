import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROMPTS = path.join(__dirname, '..', '..', '..', 'src', 'main', 'prompts');
const COMMANDER_RESOURCE_CEILING = 2_250;
const AGENT_CONTEXT_CEILING = 1_000;

function section(file: string, heading: string): string {
  const body = fs.readFileSync(path.join(PROMPTS, file), 'utf8');
  const start = body.indexOf(`## ${heading}`);
  expect(start, `${heading} must remain present`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf('\n---', start);
  return body.slice(start, end < 0 ? body.length : end);
}

describe('actor resource-policy prompt surfaces', () => {
  it('keeps Commander resource selection resident without tool call manuals', () => {
    const body = section('chat_commander.md', 'Resources you can use');
    expect(body.length).toBeLessThanOrEqual(COMMANDER_RESOURCE_CEILING);
  });

  it('rejects re-adding Commander file/history call mechanics', () => {
    const body = section('chat_commander.md', 'Resources you can use');
    const regrown = `${body}\nUse charStart/charEnd for ranges. On E_NEED_STAT call stat_file. Search history with a discriminative query; otherwise read page mode latest at count 10 and follow before paging.`;
    expect(regrown.length).toBeGreaterThan(COMMANDER_RESOURCE_CEILING);
  });

  it('keeps Agent context lookup policy compact', () => {
    const body = section('chat_agent_in_group.md', 'Context / isolation');
    expect(body.length).toBeLessThanOrEqual(AGENT_CONTEXT_CEILING);
  });

  it('rejects re-adding Agent history call mechanics', () => {
    const body = section('chat_agent_in_group.md', 'Context / isolation');
    const regrown = `${body}\nUse chat_history search only with a discriminative phrase; otherwise read page mode latest with count 10 and follow the returned before hint.`;
    expect(regrown.length).toBeGreaterThan(AGENT_CONTEXT_CEILING);
  });
});
