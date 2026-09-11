import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

function functionSource(name: string): string {
  const start = mainSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf('\nfunction ', start + 1);
  return mainSource.slice(start, next < 0 ? mainSource.length : next);
}

describe('Main task-terminal UI delivery', () => {
  it('keeps the content-free terminal UI projection on its local user-owned channel', () => {
    const emit = functionSource('emitTaskTerminalToRenderer');
    expect(emit).toContain('const { user_id: ownerUserId, ...terminal } = event;');
    expect(emit).toContain("taskTerminalUi.emit({ type: 'terminal', ...terminal }, ownerUserId)");
    expect(mainSource).toContain(
      'const stopTaskTerminalUi = subscribeTaskTerminals(emitTaskTerminalToRenderer);',
    );
  });
});
