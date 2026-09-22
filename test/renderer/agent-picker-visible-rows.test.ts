import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { onlyCssDeclarations } from './helpers/css-oracle';

// Scenario: a user opens the recipient picker to hand the task to an agent.
// They need to see the roster, not two rows and a group heading. Two things
// decided how much of it was visible: the box could never use the room the
// anchor left it, and it was re-anchored from a measurement taken before the
// rows were painted, so a later repaint grew it past its own placement.

const agentsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/agents.js'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function extractFunction(name: string): string {
  const start = agentsSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = agentsSource.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return agentsSource.slice(start, end + 2);
}

describe('agent picker › re-anchors to the list it actually painted', () => {
  function harness() {
    const picker: any = { style: { display: 'flex' }, dataset: { anchorId: 'chip' } };
    const list: any = { innerHTML: '' };
    const anchor: any = { id: 'chip' };
    const seenRowsAtReposition: string[] = [];
    const context: any = {
      document: {
        getElementById: (id: string) => {
          if (id === 'agent-picker') return picker;
          if (id === 'agent-picker-list') return list;
          if (id === 'chip') return anchor;
          return null;
        },
      },
      _positionPopoverAboveOrBelow: vi.fn(() => {
        // Record what the box was measured against at placement time.
        seenRowsAtReposition.push(list.innerHTML);
      }),
      _renderAgentPickerListRows: vi.fn(() => {
        list.innerHTML = '<div class="skill-picker-item">row</div>'.repeat(12);
      }),
    };
    vm.createContext(context);
    vm.runInContext(extractFunction('_repositionAgentPicker'), context);
    vm.runInContext(extractFunction('_renderAgentPickerList'), context);
    return { context, picker, list, anchor, seenRowsAtReposition };
  }

  it('places the popover against the painted rows, not the list it replaced', () => {
    const h = harness();
    vm.runInContext('_renderAgentPickerList("")', h.context);

    expect(h.context._renderAgentPickerListRows).toHaveBeenCalledOnce();
    expect(h.context._positionPopoverAboveOrBelow)
      .toHaveBeenCalledExactlyOnceWith(h.picker, h.anchor);
    // The placement ran after the repaint: it saw 12 rows, not the empty list.
    expect(h.seenRowsAtReposition).toHaveLength(1);
    expect(h.seenRowsAtReposition[0]).toContain('skill-picker-item');
  });

  it('leaves a closed picker alone', () => {
    const h = harness();
    h.picker.style.display = 'none';
    vm.runInContext('_repositionAgentPicker()', h.context);
    expect(h.context._positionPopoverAboveOrBelow).not.toHaveBeenCalled();
  });

  it('skips placement when the anchor is gone instead of throwing', () => {
    const h = harness();
    h.picker.dataset.anchorId = 'removed-chip';
    vm.runInContext('_repositionAgentPicker()', h.context);
    expect(h.context._positionPopoverAboveOrBelow).not.toHaveBeenCalled();
  });

  it('routes the chip-header pass through the same guarded helper', () => {
    // The selected-chip header changes the box height on its own, so it also
    // re-anchors -- but it runs from _updateAgentPickerChrome, before the rows
    // are painted. Keeping both on one helper means the list wrapper always
    // gets the last word, and the open/anchor guards live in one place.
    const header = extractFunction('_renderAgentPickerSelectionHeader');
    expect(header).toContain('_repositionAgentPicker()');
    expect(header).not.toContain('_positionPopoverAboveOrBelow(');
    expect(agentsSource.indexOf('function _repositionAgentPicker('))
      .toBeLessThan(agentsSource.indexOf('function _renderAgentPickerList('));
  });
});

describe('agent picker › height cap', () => {
  it('scales with the viewport instead of freezing at four rows', () => {
    const rule = onlyCssDeclarations(styleSource, '.skill-picker');
    // A row is a name plus a two-line description (~62px), and the tabs, chip
    // row and search box take ~90px of the box, so a fixed 380px showed four.
    expect(rule['max-height']).toBe('min(560px, 70vh)');
    expect(rule['max-height']).not.toBe('380px');
    // The cap only matters because the list is the part that flexes and scrolls.
    const listRule = onlyCssDeclarations(styleSource, '.skill-picker-list');
    expect(listRule.flex).toBe('1');
    expect(listRule['overflow-y']).toBe('auto');
  });
});
