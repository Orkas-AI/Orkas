/**
 * `_dedupeGoogleWorkspaceTools` is the gate that prevents the model from
 * seeing two routes to the same Gmail / Calendar / Docs / Sheets / Tasks
 * tool when a user has both the all-in-one `google-workspace` connector
 * AND a standalone single-service connector installed.
 *
 * Why this fixture exists: the dedup criterion was historically a
 * `description.startsWith('[Gmail]')` match — fragile because the
 * `[Gmail]` / `[Calendar]` / … prefix is added at runtime in
 * `bin/google-workspace-mcp-server.cjs` and could be dropped in a future
 * UI polish. Migrating to a tool-name-set match (the strict invariant —
 * both backends preserve the underlying adapter's `name`) requires
 * locking down BOTH directions:
 *
 *   - set A: a workspace tool whose `name` matches a visible
 *            standalone-service tool MUST be filtered out (regardless
 *            of whether the description still carries a `[Gmail]`
 *            prefix).
 *   - set B: a workspace tool whose `name` does NOT match any
 *            visible standalone tool MUST be preserved — even if its
 *            description happens to start with `[Gmail]` for cosmetic
 *            reasons (the old dedup would have eaten this; the new one
 *            must not).
 */

import { describe, it, expect } from 'vitest';

import { _dedupeGoogleWorkspaceToolsForTest as dedupe } from '../../../../src/main/features/connectors/tools-adapter';

type FakeInstance = { id: string };
type FakeTool = { name: string; description: string; inputSchema: object };

function visible(
  entries: Array<{ id: string; tools: Array<{ name: string; description?: string }> }>,
): Array<{ instance: any; tools: any[] }> {
  return entries.map((e) => ({
    instance: { id: e.id } as FakeInstance,
    tools: e.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: { type: 'object', properties: {} },
    })) as FakeTool[],
  }));
}

describe('dedupeGoogleWorkspaceTools › set A (shadowed by name — MUST be filtered)', () => {
  it('shadows workspace tools whose name matches a visible standalone gmail tool', () => {
    const input = visible([
      {
        id: 'google-workspace',
        tools: [
          { name: 'gmail_search', description: '[Gmail] Search messages' },
          { name: 'gmail_send', description: '[Gmail] Send message' },
          { name: 'gcal_list', description: '[Calendar] List events' },
        ],
      },
      {
        id: 'gmail',
        tools: [
          { name: 'gmail_search', description: 'Search messages' },
          { name: 'gmail_send', description: 'Send message' },
        ],
      },
    ]);
    const out = dedupe(input);
    const workspace = out.find((v: any) => v.instance.id === 'google-workspace');
    expect(workspace?.tools.map((t: any) => t.name)).toEqual(['gcal_list']);
    // standalone gmail untouched
    const gmail = out.find((v: any) => v.instance.id === 'gmail');
    expect(gmail?.tools.map((t: any) => t.name)).toEqual(['gmail_search', 'gmail_send']);
  });

  it('hides the workspace entry entirely when every workspace tool is shadowed', () => {
    const input = visible([
      {
        id: 'google-workspace',
        tools: [
          { name: 'gmail_search', description: '[Gmail] Search' },
          { name: 'gcal_list', description: '[Calendar] List' },
        ],
      },
      { id: 'gmail', tools: [{ name: 'gmail_search', description: 'Search' }] },
      { id: 'gcal', tools: [{ name: 'gcal_list', description: 'List events' }] },
    ]);
    const out = dedupe(input);
    expect(out.find((v: any) => v.instance.id === 'google-workspace')).toBeUndefined();
    expect(out.map((v: any) => v.instance.id).sort()).toEqual(['gcal', 'gmail']);
  });

  it('matches name regardless of description prefix presence (robust to future UI polish that drops [Gmail])', () => {
    // The workspace tool no longer carries the `[Gmail]` description prefix
    // (simulating a future UI change). With name-based dedup, the standalone
    // gmail tool still shadows it.
    const input = visible([
      {
        id: 'google-workspace',
        tools: [
          // NB: no `[Gmail]` prefix
          { name: 'gmail_search', description: 'Search messages' },
        ],
      },
      { id: 'gmail', tools: [{ name: 'gmail_search', description: 'Search' }] },
    ]);
    const out = dedupe(input);
    expect(out.find((v: any) => v.instance.id === 'google-workspace')).toBeUndefined();
  });
});

describe('dedupeGoogleWorkspaceTools › set B (NOT shadowed — MUST be preserved)', () => {
  it('preserves a workspace tool whose description starts with [Gmail] when no standalone gmail connector is visible', () => {
    // The old description-prefix dedup would have eaten this entry just
    // because of the cosmetic prefix. The name-based dedup correctly leaves
    // it alone: no standalone gmail connector → no name shadow → keep.
    const input = visible([
      {
        id: 'google-workspace',
        tools: [
          { name: 'gmail_search', description: '[Gmail] Search messages' },
          { name: 'gcal_list', description: '[Calendar] List events' },
        ],
      },
      // No standalone gmail / gcal visible — workspace is the only route.
    ]);
    const out = dedupe(input);
    const workspace = out.find((v: any) => v.instance.id === 'google-workspace');
    expect(workspace?.tools.map((t: any) => t.name)).toEqual(['gmail_search', 'gcal_list']);
  });

  it('does not shadow tools from unrelated visible connectors (e.g. Notion)', () => {
    const input = visible([
      {
        id: 'google-workspace',
        tools: [{ name: 'gmail_search', description: '[Gmail] Search' }],
      },
      // Unrelated connector with a coincidentally-named tool — must NOT
      // shadow the workspace's tool.
      { id: 'notion', tools: [{ name: 'gmail_search', description: 'Notion gmail-named tool' }] },
    ]);
    const out = dedupe(input);
    const workspace = out.find((v: any) => v.instance.id === 'google-workspace');
    expect(workspace?.tools.map((t: any) => t.name)).toEqual(['gmail_search']);
  });

  it('no-ops when google-workspace is not visible', () => {
    const input = visible([{ id: 'gmail', tools: [{ name: 'gmail_search' }] }]);
    const out = dedupe(input);
    expect(out).toEqual(input);
  });
});
