import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const owners = { pc: ['src/renderer/modules/utils.js', 'formatTime'] } as const;

// Execute actual owning functions with the runtime's real default timezone.
// A fresh process avoids cached Intl defaults and host-dependent test order.
function declaration(file: string, name: string): string {
  const source = readFileSync(resolve(root, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!found) throw new Error(`Missing time display owner: ${file}::${name}`);
  return found;
}

const functions = Object.fromEntries(Object.entries(owners).map(([key, [file, name]]) =>
  [key, `(${declaration(file, name)})`],
));

function probe(zone: string, instant = '2026-11-07T00:30:00Z') {
  const script = `
    const f = Object.fromEntries(Object.entries(${JSON.stringify(functions)})
      .map(([key, source]) => [key, eval(source)]));
    const iso = ${JSON.stringify(instant)};
    process.stdout.write(JSON.stringify({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pc: f.pc(iso), offset: f.pc(iso.replace('Z','+00:00')),
      naive: f.pc('2026-11-07T10:22:00'),
      empty: f.pc(''), invalid: f.pc('invalid-time-value'),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: zone, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 15_000,
  }));
}

describe('device-local time display', () => {
  // Literal wall-clock oracles come from civil timezone offsets, not owners.
  it.each([
    ['Asia/Shanghai', '2026-11-07 08:30'],
    ['Europe/London', '2026-11-07 00:30'],
    ['America/New_York', '2026-11-06 19:30'],
    ['Asia/Kathmandu', '2026-11-07 06:15'],
    ['UTC', '2026-11-07 00:30'],
  ])('uses %s for message timestamps', (zone, wall) => {
    const result = probe(zone);
    expect.soft(result.pc).toBe(wall);
    expect.soft(result.offset).toBe(wall);
    expect.soft(result.naive).toBe('2026-11-07 10:22');
    expect(result.empty).toBe('-');
    expect(result.invalid).toBe('invalid-time-val');
  });

  it.each([
    ['America/New_York', '2026-03-08T06:59:00Z', '2026-03-08 01:59'],
    ['America/New_York', '2026-03-08T07:01:00Z', '2026-03-08 03:01'],
    ['Europe/London', '2026-03-29T00:59:00Z', '2026-03-29 00:59'],
    ['Europe/London', '2026-03-29T01:01:00Z', '2026-03-29 02:01'],
  ])('tracks daylight saving in %s at %s', (zone, iso, wall) => {
    const result = probe(zone, iso);
    expect(result.pc).toBe(wall);
  });
});
