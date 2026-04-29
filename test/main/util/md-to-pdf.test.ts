import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── markdownToHtml (pure) ────────────────────────────────────────────────

describe('markdownToHtml › document shape', () => {
  it('wraps output in a DOCTYPE + head + style block', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('# Hello');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    expect(html).toContain('<body>');
  });

  it('uses the provided title in <title>', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('body', { title: 'My Report' });
    expect(html).toContain('<title>My Report</title>');
  });

  it('escapes the title', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('body', { title: '<script>bad</script>' });
    expect(html).toContain('<title>&lt;script&gt;bad&lt;/script&gt;</title>');
  });
});

describe('markdownToHtml › block elements', () => {
  it('renders all six heading levels', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const md = '# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6';
    const html = markdownToHtml(md);
    for (let i = 1; i <= 6; i++) {
      expect(html).toContain(`<h${i}>h${i}</h${i}>`);
    }
  });

  it('renders a paragraph', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    expect(markdownToHtml('hello world')).toContain('<p>hello world</p>');
  });

  it('renders an unordered list', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('- a\n- b\n- c');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
    expect(html).toContain('<li>c</li>');
    expect(html).toContain('</ul>');
    expect(html).not.toContain('<ol>');
  });

  it('renders an ordered list', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('1. a\n2. b\n3. c');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('</ol>');
  });

  it('renders a horizontal rule', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    expect(markdownToHtml('before\n\n---\n\nafter')).toContain('<hr>');
  });

  it('renders a fenced code block preserving literal < > characters', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('```\nif (x < 3) { y = 1; }\n```');
    expect(html).toContain('<pre><code>if (x &lt; 3) { y = 1; }</code></pre>');
  });

  it('attaches a lang class when the fence has a language hint', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('```python\nprint(1)\n```');
    expect(html).toContain('<code class="lang-python">');
  });

  it('does NOT apply inline formatting inside a code block', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('```\n**not bold** and *not italic*\n```');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
  });
});

describe('markdownToHtml › inline formatting', () => {
  it('renders bold', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    expect(markdownToHtml('a **bold** word')).toContain('<strong>bold</strong>');
  });

  it('renders italic', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    expect(markdownToHtml('a *slanted* word')).toContain('<em>slanted</em>');
  });

  it('renders inline code', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    expect(markdownToHtml('run `npm test` now')).toContain('<code>npm test</code>');
  });

  it('renders safe http/https links', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('see [docs](https://example.com/page)');
    expect(html).toContain('<a href="https://example.com/page">docs</a>');
  });

  it('renders mailto links', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('[ping](mailto:a@b.com)');
    expect(html).toContain('<a href="mailto:a@b.com">ping</a>');
  });
});

describe('markdownToHtml › XSS / safety', () => {
  it('escapes <script> tags in plain text', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('pre <script>alert(1)</script> post');
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('refuses to emit javascript: links', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toMatch(/href="javascript:/);
    // Falls back to literal-looking text (escaped).
    expect(html).toContain('[click]');
  });

  it('refuses to emit data: URLs (which can encode script)', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('[x](data:text/html,<script>bad</script>)');
    expect(html).not.toMatch(/href="data:/);
  });

  it('escapes HTML inside link text', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('[<b>yo</b>](https://example.com)');
    expect(html).toContain('&lt;b&gt;yo&lt;/b&gt;');
  });
});

describe('markdownToHtml › edge cases', () => {
  it('handles empty input', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('');
    expect(html).toContain('<body></body>');
  });

  it('closes an unfinished fenced block at EOF', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    // Missing closing fence — should still render without throwing.
    const html = markdownToHtml('```\nsome code');
    expect(html).toContain('<pre><code>some code</code></pre>');
  });

  it('CRLF line endings are handled the same as LF', async () => {
    const { markdownToHtml } = await import('../../../src/main/util/md-to-pdf');
    const html = markdownToHtml('# a\r\n\r\nhello');
    expect(html).toContain('<h1>a</h1>');
    expect(html).toContain('<p>hello</p>');
  });
});

// ── htmlToPdf (Electron-backed; mocked) ──────────────────────────────────

let tmpDir: string;
const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.4 fake', 'utf8'));
const loadURL = vi.fn(async (_url: string) => {});
const once = vi.fn((evt: string, cb: (...args: any[]) => void) => {
  if (evt === 'did-finish-load') setImmediate(cb);
});
const destroy = vi.fn();

class FakeBrowserWindow {
  webContents = { once, printToPDF, loadURL };
  constructor(public opts: any) {}
  async loadURL(url: string) { return loadURL(url); }
  destroy() { destroy(); }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pdf-'));
  printToPDF.mockClear();
  loadURL.mockClear();
  once.mockClear();
  destroy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('htmlToPdf › behaviour', () => {
  it('writes the returned PDF buffer to the output path', async () => {
    const { htmlToPdf } = await import('../../../src/main/util/md-to-pdf');
    const out = path.join(tmpDir, 'sub', 'doc.pdf');
    const abs = await htmlToPdf('<html><body>hi</body></html>', out);
    expect(abs).toBe(path.resolve(out));
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('%PDF-1.4 fake');
  });

  it('calls printToPDF with A4 + portrait by default', async () => {
    const { htmlToPdf } = await import('../../../src/main/util/md-to-pdf');
    await htmlToPdf('<html></html>', path.join(tmpDir, 'a.pdf'));
    expect(printToPDF).toHaveBeenCalledTimes(1);
    const args = printToPDF.mock.calls[0][0];
    expect(args).toMatchObject({ pageSize: 'A4', landscape: false, printBackground: true });
  });

  it('honors landscape + custom page size', async () => {
    const { htmlToPdf } = await import('../../../src/main/util/md-to-pdf');
    await htmlToPdf('<html></html>', path.join(tmpDir, 'b.pdf'), {
      pageSize: 'Letter',
      landscape: true,
    });
    const args = printToPDF.mock.calls[0][0];
    expect(args).toMatchObject({ pageSize: 'Letter', landscape: true });
  });

  it('loads the HTML as a data: URL (no file:// navigation)', async () => {
    const { htmlToPdf } = await import('../../../src/main/util/md-to-pdf');
    await htmlToPdf('<html><body>X</body></html>', path.join(tmpDir, 'c.pdf'));
    expect(loadURL).toHaveBeenCalledTimes(1);
    const url = loadURL.mock.calls[0][0];
    expect(url).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    // Body content is base64-encoded — decode and verify.
    const b64 = url.split('base64,')[1];
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toContain('<body>X</body>');
  });

  it('destroys the BrowserWindow even when printToPDF throws', async () => {
    printToPDF.mockRejectedValueOnce(new Error('boom'));
    const { htmlToPdf } = await import('../../../src/main/util/md-to-pdf');
    await expect(htmlToPdf('<html></html>', path.join(tmpDir, 'err.pdf'))).rejects.toThrow('boom');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('markdownToPdf › composition', () => {
  it('runs markdown through markdownToHtml and then printToPDF', async () => {
    const { markdownToPdf } = await import('../../../src/main/util/md-to-pdf');
    const out = path.join(tmpDir, 'composed.pdf');
    await markdownToPdf('# Title\n\ncontent', out, { title: 'X' });
    // Verify the rendered HTML carried the heading into the data URL.
    const url = loadURL.mock.calls[0][0];
    const b64 = url.split('base64,')[1];
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toContain('<h1>Title</h1>');
    expect(decoded).toContain('<title>X</title>');
  });
});
