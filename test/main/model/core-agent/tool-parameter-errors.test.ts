import { describe, expect, it, vi } from 'vitest';
import { formatParameterError, parameterErrorContent } from '../../../../bin/tool-parameter-errors.cjs';
import { webSearchTool } from '../../../../src/core-agent/src/tools/web-search';
import { webFetchTool } from '../../../../src/core-agent/src/tools/web-fetch';
import { createSkillManageTool } from '../../../../src/core-agent/src/evolution/skill-tools';
import { parseApplyPatch } from '../../../../src/core-agent/src/tools/apply-patch';

describe('parameter rejection presentation', () => {
  it.each([[undefined, 'required'], [4, 'invalid_type']] as const)('returns a field rejection rather than throwing for web_fetch url %#', async (url, reason) => {
    const result = await webFetchTool.execute({ url }, { state: {} } as any);
    expect(JSON.parse(result.content)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
      { field: 'url', reason, expected: expect.any(String) },
    ] });
  });
  it.each([['', 'E_BAD_INPUT'], ['*** Begin Patch\n*** End Patch', 'E_PATCH_FORMAT']])('preserves patch parser code %# and reports its actual argument', (patch, code) => {
    const result = parseApplyPatch(patch);
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error('Expected rejected patch');
    expect(JSON.parse(result.content)).toMatchObject({ code, issues: [
      { field: 'patch', reason: expect.any(String), expected: expect.any(String) },
    ] });
    expect(result.observations?.fileFailure?.code).toBe(code);
  });
  it.each([webSearchTool, webFetchTool])('gives an actual field for $name final missing-input rejection', async tool => {
    const result = await tool.execute(tool.name === 'web_fetch' ? { url: '' } : {}, { state: {} } as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
      { field: tool.name === 'web_search' ? 'query' : 'url', reason: 'required', expected: expect.any(String) },
    ] });
  });

  it('keeps codes, legacy recovery facts, status and messages and is idempotent', () => {
    const content = JSON.stringify({ errorCode: 'E_BAD_INPUT', error: 'Missing input', recovery: { cursor: 0 }, ok: false });
    const formatted = formatParameterError(content, true);
    expect(JSON.parse(formatted)).toMatchObject({ code: 'E_BAD_INPUT', errorCode: 'E_BAD_INPUT', ok: false,
      recovery: { cursor: 0 }, error: 'Missing input', issues: [{ field: '$', reason: 'invalid_arguments', expected: 'Missing input' }] });
    expect(formatParameterError(formatted, true)).toBe(formatted);
  });

  it.each([
    { error_code: 'PLAN_INPUT_UNSUPPORTED_FIELDS', current_revision: 4, message: 'Use plan/explanation only.' },
    { reason: 'E_PROGRAM_BAD_INPUT', status: 'incomplete', attempted_calls: 0, message: 'Program source must be non-empty.' },
  ])('retains native owner recovery fields in protocol %#', original => {
    expect(JSON.parse(formatParameterError(JSON.stringify(original), true))).toMatchObject({ ...original,
      code: original.error_code || original.reason, issues: [{ field: '$', reason: 'invalid_arguments', expected: original.message }],
    });
  });

  it('formats skill field guards without changing accepted input or invoking rejected mutations', async () => {
    const create = vi.fn(async () => ({ id: 'fixture', path: 'fixture', frontmatter: { name: 'Fixture' } }));
    const tool = createSkillManageTool({ create } as any);
    const bad = await tool.execute({ action: 'create', id: 'fixture' }, {} as any);
    expect(JSON.parse(bad.content)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
      { field: 'name', reason: 'required', expected: expect.any(String) },
      { field: 'description', reason: 'required', expected: expect.any(String) },
      { field: 'body', reason: 'required', expected: expect.any(String) },
    ] });
    expect(create).not.toHaveBeenCalled();
    const result = await tool.execute({ action: 'create', id: 'fixture', name: 'Fixture', description: 'Details', body: 'Body' }, {} as any);
    expect(result.isError).not.toBe(true);
    expect(create).toHaveBeenCalledExactlyOnceWith({ id: 'fixture', name: 'Fixture', description: 'Details', body: 'Body', tags: undefined });
  });

  it.each([
    ['E_BAD_INPUT: quoted source', false],
    ['Quoted: E_BAD_INPUT: missing query', true],
    ['{"code":"E_PERMISSION","message":"query is required"}', true],
    ['{"error":"query is required"}', true],
    ['E_NETWORK: missing query', true],
    ['<tool-error code="E_QUOTA">no credits</tool-error>', true],
  ])('does not classify nonparameter or source text %#', (text, isError) => {
    expect(formatParameterError(text, isError)).toBe(text);
  });

  it('bounds issue details without adding submitted values', () => {
    const oversized = 'E_BAD_INPUT: ' + 'x'.repeat(70000);
    expect(formatParameterError(oversized, true)).toBe(oversized);
    const content = parameterErrorContent('Invalid input.', Array.from({ length: 40 }, () => ({
      field: 'x'.repeat(500), reason: 'unsupported_field', expected: 'y'.repeat(2000),
    })));
    const value = JSON.parse(content);
    expect(value).toMatchObject({ issue_count: 40, issues_truncated: true });
    expect(value.issues).toHaveLength(16);
    expect(content.length).toBeLessThan(12000);
  });
});
