import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TOOL_CATALOG } from '../../../../src/main/model/core-agent/tool-catalog';

/**
 * Primary direct-behavior owner for every injected built-in tool.
 *
 * This is deliberately separate from tool-catalog.test.ts: catalog/schema
 * assertions do not count as behavior coverage. Adding a tool now requires a
 * named suite that calls its execute path (or its host adapter for native
 * runtimes) before this anti-drift test will pass.
 */
const BEHAVIOR_SUITE_BY_TOOL: Record<string, string> = {
  read_file: 'test/main/model/core-agent/file-tools.test.ts',
  read_files: 'test/main/model/core-agent/file-tools.test.ts',
  write_file: 'test/main/model/core-agent/local-tools.test.ts',
  append_file: 'test/main/model/local-tools.test.ts',
  apply_patch: 'test/main/model/core-agent/local-tools.test.ts',
  edit_file: 'test/main/model/core-agent/local-tools.test.ts',
  delete_file: 'test/main/model/core-agent/local-tools.test.ts',
  list_files: 'src/core-agent/test/tools.test.ts',
  stat_file: 'test/main/model/core-agent/file-tools.test.ts',
  ocr_file: 'test/main/model/core-agent/file-tools.test.ts',
  search_files: 'test/main/model/core-agent/file-tools.test.ts',
  grep_files: 'test/main/model/core-agent/file-tools.test.ts',
  workspace_diff: 'src/core-agent/test/workspace-state.test.ts',
  tool_result_search: 'test/main/model/core-agent/tool-result-tools.test.ts',
  tool_result_read_chunk: 'test/main/model/core-agent/tool-result-tools.test.ts',
  publish_outputs: 'test/main/model/local-tools.test.ts',
  create_artifact: 'test/main/model/core-agent/local-tools.test.ts',
  html_preview: 'test/main/model/core-agent/html-preview-tool.test.ts',
  bash: 'src/core-agent/test/tools.test.ts',
  process_start: 'src/core-agent/test/process-session.test.ts',
  process_read: 'src/core-agent/test/process-session.test.ts',
  process_write: 'src/core-agent/test/process-session.test.ts',
  process_stop: 'src/core-agent/test/process-session.test.ts',
  interactive_cli_start: 'test/main/model/local-tools.test.ts',
  interactive_cli_read: 'test/main/model/local-tools.test.ts',
  interactive_cli_send: 'test/main/model/local-tools.test.ts',
  interactive_cli_close: 'test/main/model/local-tools.test.ts',
  markdown_to_pdf: 'test/main/model/local-tools.test.ts',
  html_to_pdf: 'test/main/model/local-tools.test.ts',
  edit_pdf: 'test/main/model/core-agent/pdf-tools.test.ts',
  pdf_render: 'test/main/model/core-agent/pdf-tools.test.ts',
  create_docx: 'test/main/model/core-agent/office-tools.test.ts',
  create_xlsx: 'test/main/model/core-agent/office-tools.test.ts',
  create_pptx: 'test/main/model/core-agent/office-tools.test.ts',
  office_read: 'test/main/model/core-agent/office-tools.test.ts',
  edit_office: 'test/main/model/core-agent/office-tools.test.ts',
  office_check: 'test/main/model/core-agent/office-tools.test.ts',
  office_render: 'test/main/model/core-agent/office-tools.test.ts',
  kb_list: 'test/main/model/core-agent/kb-tools.test.ts',
  kb_search: 'test/main/model/core-agent/kb-tools.test.ts',
  kb_read: 'test/main/model/core-agent/kb-tools.test.ts',
  chat_search: 'test/main/model/core-agent/chat-history-tools.test.ts',
  chat_read: 'test/main/model/core-agent/chat-history-tools.test.ts',
  generate_image: 'test/main/model/core-agent/image-gen-tool.test.ts',
  generate_speech: 'test/main/model/core-agent/generate-speech-tool.test.ts',
  video_studio: 'test/main/model/core-agent/video-studio-state-tool.test.ts',
  image_studio: 'test/main/model/core-agent/image-studio-tool.test.ts',
  web_search: 'src/core-agent/test/web-search.test.ts',
  web_fetch: 'src/core-agent/test/tools.test.ts',
  list_connector_tools: 'test/main/model/core-agent/connector-meta-tools.test.ts',
  call_connector_tool: 'test/main/model/core-agent/connector-meta-tools.test.ts',
  add_custom_connector: 'test/main/features/connectors/install-confirm.test.ts',
  manage_execution_plan: 'src/core-agent/test/tools.test.ts',
  cross_session_memory: 'src/core-agent/test/memory-tool.test.ts',
  project_instructions: 'src/core-agent/test/project-instructions-tool.test.ts',
  project_tasks: 'src/core-agent/test/project-tasks-tool.test.ts',
  metacognition: 'src/core-agent/test/metacognition-tool.test.ts',
};

const SYSTEM_OPERATION_TOOLS = new Set([
  'read_file',
  'read_files',
  'write_file',
  'append_file',
  'apply_patch',
  'edit_file',
  'delete_file',
  'list_files',
  'stat_file',
  'ocr_file',
  'search_files',
  'grep_files',
  'workspace_diff',
  'tool_result_search',
  'tool_result_read_chunk',
  'publish_outputs',
  'create_artifact',
  'html_preview',
  'bash',
  'process_start',
  'process_read',
  'process_write',
  'process_stop',
  'interactive_cli_start',
  'interactive_cli_read',
  'interactive_cli_send',
  'interactive_cli_close',
  'markdown_to_pdf',
  'html_to_pdf',
  'edit_pdf',
  'pdf_render',
  'create_docx',
  'create_xlsx',
  'create_pptx',
  'office_read',
  'edit_office',
  'office_check',
  'office_render',
  'video_studio',
  'image_studio',
]);

describe('built-in tool behavior coverage', () => {
  it('assigns every catalog tool to a direct behavior suite', () => {
    const catalogNames = TOOL_CATALOG.map((entry) => entry.name).sort();
    const ownedNames = Object.keys(BEHAVIOR_SUITE_BY_TOOL).sort();
    expect(ownedNames).toEqual(catalogNames);
  });

  it('points to existing suites that name the tool under test', () => {
    const invalid: string[] = [];
    for (const [tool, suite] of Object.entries(BEHAVIOR_SUITE_BY_TOOL)) {
      const abs = path.resolve(process.cwd(), suite);
      if (!fs.existsSync(abs)) {
        invalid.push(`${tool}: missing ${suite}`);
        continue;
      }
      const source = fs.readFileSync(abs, 'utf8');
      if (!source.includes(tool)) invalid.push(`${tool}: ${suite} does not name the tool`);
      if (suite.endsWith('tool-catalog.test.ts')) invalid.push(`${tool}: catalog tests are not behavior tests`);
    }
    expect(invalid).toEqual([]);
  });

  it('keeps every system-operation tool in the dedicated host-native lane', () => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-platform-native-tests.mjs'), 'utf8');
    const missingOwners = [...SYSTEM_OPERATION_TOOLS]
      .filter((tool) => !BEHAVIOR_SUITE_BY_TOOL[tool]);
    expect(missingOwners).toEqual([]);
    expect(runner).toContain('process.platform');
    expect(runner).toContain('win32');
    expect(runner).toContain('darwin');
    for (const suite of new Set([...SYSTEM_OPERATION_TOOLS].map((tool) => BEHAVIOR_SUITE_BY_TOOL[tool]))) {
      expect(runner, `${suite} is not in the platform-native lane`).toContain(suite);
    }
  });
});
