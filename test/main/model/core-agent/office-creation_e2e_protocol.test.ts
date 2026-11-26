import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { projectToolInput } from '../../../../bin/tool-input-compat.cjs';
import { toToolDefinition } from '../../../../src/core-agent/src/tools/base';
import * as engine from '../../../../src/main/features/office/office_engine';
import { createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';
import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';

type Protocol = 'chat' | 'responses';

function toolCallWire(protocol: Protocol, input: Record<string, unknown>): Response {
  const args = JSON.stringify(input);
  const item = { type: 'function_call', id: 'fc_doc', call_id: 'call_doc', name: 'create_docx', arguments: args, status: 'completed' };
  const response = { id: 'resp_fixture', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 3, output_tokens: 2 } };
  const chunks = protocol === 'responses' ? [
    { type: 'response.created', response: { ...response, output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ] : [
    { delta: { role: 'assistant', tool_calls: [{ index: 0, id: item.call_id, type: 'function',
      function: { name: item.name, arguments: args } }] }, finish_reason: null },
    { delta: {}, finish_reason: 'tool_calls' },
  ].map(choice => ({ id: 'fixture', model: 'fixture', choices: [{ index: 0, ...choice }] }));
  return new Response(chunks.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (protocol === 'chat' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

function creationReceipt(result: { content: string }) {
  const receipt = /<office-creation>(.+)<\/office-creation>/.exec(result.content)?.[1];
  expect(receipt).toBeDefined();
  return JSON.parse(receipt!);
}

afterEach(() => vi.restoreAllMocks());

// Real provider adapters and OfficeCLI, with synthetic responses at the HTTP boundary.
describe.skipIf(!['darwin', 'win32'].includes(process.platform))('Word creation over a custom model protocol', () => {
  it.each(['chat', 'responses'] as const)('%s reports malformed input and recovers a native rejection once', async protocol => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-word-protocol-'));
    const target = path.join(workspace, 'report.docx');
    const written: string[] = [];
    const native = engine.runOfficeCli;
    const commands = vi.spyOn(engine, 'runOfficeCli').mockImplementation(async (args, opts) => {
      const output = await native(args, opts);
      expect(output.stderr, `OfficeCLI ${args[0]} stderr`).toBe('');
      return output;
    });
    try {
      const provider = await createCustomOpenAICompatibleProvider({ apiKey: 'synthetic', baseUrl: 'https://office-fixture.invalid/v1',
        modelId: 'fixture', protocol: protocol === 'responses' ? 'responses' : undefined, contextWindow: 128_000, maxTokens: 2048 });
      const fetch = vi.spyOn(globalThis, 'fetch');
      const input = { path: 'report.docx', locale: 'en-US', preview: false, paragraphs: [{ text: 'Report body.' }] };
      const stateDir = path.join(workspace, 'creation-state');
      async function run(args: Record<string, unknown>) {
        const tool = createOfficeTools({ userId: 'office-protocol-fixture', extraRoots: [workspace], creationStateDir: stateDir,
          onFileWritten: file => { written.push(file); } }).find(tool => tool.name === 'create_docx');
        if (!tool) throw new Error('Word creation tool unavailable');
        fetch.mockImplementation(async (url, init) => {
          expect(new URL(String(url)).hostname).toBe('office-fixture.invalid');
          const { tools } = JSON.parse(String(init?.body));
          const definition = protocol === 'responses' ? tools[0] : tools[0].function;
          expect(definition.parameters.required).toEqual(['path']);
          return toolCallWire(protocol, args);
        });
        const response = await provider.complete({ model: 'fixture', maxTokens: 512, tools: [toToolDefinition(tool)],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Create the Word report.' }] }] });
        const call = response.content.find(block => block.type === 'tool_use');
        expect(call?.name).toBe('create_docx');
        if (!call) throw new Error('Expected a Word creation call');
        const { input: projected } = projectToolInput(call.input, Object.keys(tool.inputSchema.properties!));
        return tool.execute(projected, { workingDir: workspace, state: {} });
      }

      const invalid = await run({ ...input, paragraphs: [...input.paragraphs, { style: 'Heading2' }] });
      expect(invalid.isError).toBe(true);
      expect(JSON.parse(invalid.content)).toMatchObject({ code: 'E_BAD_INPUT', issues: [{ field: 'paragraphs[1].text' }] });
      expect(commands).not.toHaveBeenCalled();
      expect(fs.readdirSync(workspace)).toEqual([]);

      const failed = await run({ ...input, paragraphs: [{ text: 'Report body.', size: 'not-a-size' }] });
      expect(failed.isError).toBe(true);
      const failure = creationReceipt(failed);
      expect(failure).toMatchObject({ attempt: 1, publication: 'not_published', retry_available: true });
      expect(fs.existsSync(target)).toBe(false);
      const beforeRetry = commands.mock.calls.length;
      const missing = await run({ ...input, retry_of: null });
      expect(missing.isError).toBe(true);
      expect(creationReceipt(missing)).toEqual(failure);
      expect(commands).toHaveBeenCalledTimes(beforeRetry);

      const corrected = await run({ ...input, retry_of: failure.operation_id });
      const retryCode = corrected.content.match(/^E_[A-Z_]+(?=:)/)?.[0] ?? 'no error code';
      const retryCommands = commands.mock.calls.slice(beforeRetry).map(([args]) => args[0]);
      expect(corrected.isError, `Word correction: ${retryCode}; commands: ${retryCommands.join(', ')}`).toBeUndefined();
      expect(creationReceipt(corrected)).toMatchObject({ attempt: 2, publication: 'published', retry_available: false });
      const saved = fs.readFileSync(target);
      expect(new AdmZip(saved).readAsText('word/document.xml')).toMatch(/<w:t[^>]*>Report body\.<\/w:t>/);
      const afterRetry = commands.mock.calls.length;
      expect((await run({ ...input, retry_of: failure.operation_id })).isError).toBe(true);
      expect(commands).toHaveBeenCalledTimes(afterRetry);
      expect(fs.readFileSync(target)).toEqual(saved);
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(written).toEqual([target]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  });
});
