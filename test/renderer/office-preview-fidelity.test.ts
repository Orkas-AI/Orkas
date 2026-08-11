import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer/modules');
const mainRoot = path.resolve(__dirname, '../../src/main');
const stylePath = path.resolve(__dirname, '../../src/renderer/style.css');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Office preview fidelity contract', () => {
  it('routes Word, spreadsheet, and presentation files through the bundled layout renderer', () => {
    const preview = read(path.join(mainRoot, 'util/office-preview.ts'));
    const ipc = read(path.join(mainRoot, 'ipc/index.ts'));
    const contexts = read(path.join(mainRoot, 'features/contexts.ts'));
    const projects = read(path.join(mainRoot, 'features/project_files.ts'));

    expect(preview).toContain("runOfficeCli(['view', workFile, 'html', '-o', output]");
    expect(preview).toContain("if (kind === 'word') return '.docx'");
    expect(preview).toContain("if (kind === 'spreadsheet') return '.xlsx'");
    expect(preview).toContain('layoutRendered: true');
    expect(preview).toContain("connect-src 'none'");
    expect(preview).toContain("object-src 'none'");
    expect(ipc).toContain('officeFileToPreviewHtml(kind, path.basename(norm), norm, buf)');
    expect(contexts).toContain('officeFileToPreviewHtml(kind, path.basename(p), p, buf)');
    expect(projects).toContain('officeFileToPreviewHtml(kind, path.basename(r.absPath), r.absPath, buf)');
  });

  it('uses the shared Office viewer for project DOCX instead of the Mammoth-only viewer', () => {
    const projectDetail = read(path.join(rendererRoot, 'project-detail.js'));
    expect(projectDetail).toContain("kind === 'docx' || kind === 'spreadsheet' || kind === 'presentation'");
    expect(projectDetail).toContain('return await _showProjectOfficeViewer(name)');
  });

  it('enables only the hardened preview script and never grants same-origin access', () => {
    for (const file of ['chat-file-viewer.js', 'contexts.js', 'project-detail.js']) {
      const source = read(path.join(rendererRoot, file));
      expect(source).toContain("allowScripts === true ? 'allow-scripts' : ''");
      expect(source).toContain('sandbox="${sandbox}"');
      expect(source).not.toContain('allow-scripts allow-same-origin');
    }
  });

  it('shows an accessible loading state before every asynchronous Office preview request', () => {
    const cases = [
      ['chat-file-viewer.js', "window.orkas.invoke('produced.officePreviewHtml'"],
      ['contexts.js', 'apiFetch(`/api/contexts/office?path='],
      ['project-detail.js', "window.orkas.invoke('projects.files.officeHtml'"],
    ] as const;

    for (const [file, request] of cases) {
      const source = read(path.join(rendererRoot, file));
      const loadingIndex = source.indexOf('class="office-preview-loading"');
      const requestIndex = source.indexOf(request);
      expect(loadingIndex, `${file} loading markup`).toBeGreaterThanOrEqual(0);
      expect(requestIndex, `${file} Office request`).toBeGreaterThan(loadingIndex);
      expect(source).toContain('role="status" aria-live="polite"');
      expect(source).toContain("setAttribute('aria-busy', 'true')");
      expect(source).toContain("removeAttribute('aria-busy')");
    }

    const style = read(stylePath);
    expect(style).toContain('.office-preview-loading-spinner');
    expect(style).toContain('@keyframes office-preview-loading-spin');
  });
});
