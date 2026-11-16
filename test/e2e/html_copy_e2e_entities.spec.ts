import path from 'node:path';
import { expect, test } from './fixtures/orkas';

const parserPath = path.resolve(__dirname, '../../src/main/features/video_studio_html_check.ts');
const studioPath = path.resolve(__dirname, '../../src/main/features/image_studio.ts');

test('matches Chromium text and preserves price acceptance boundaries', async ({ orkas }) => {
  const entries = [
    ['¥99', '¥99'], ['&yen;99', '¥99'], ['&#165;99', '¥99'], ['&#xA5;99', '¥99'],
    ['&euro;9 &pound;8 &copy;', '€9 £8 ©'], ['A&nbsp;B', 'A B'],
    ['&#x1F600; &#20013;', '😀 中'], ['&#128;9', '€9'],
    ['&amp;yen;99', '&yen;99'], ['&amp;#165;99', '&#165;99'],
    ['&amp;lt;b&amp;gt;', '&lt;b&gt;'], ['&lt;b&gt;', '<b>'],
    ['&AMP; &QUOT; &LT; &GT;', '& " < >'], ['&#38;yen;99', '&yen;99'],
    ['&unknown;', '&unknown;'], ['&#0; &#xD800; &#1114112;', '� � �'],
  ];
  const observed = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    const parse = (process as any).mainModule.require(args.parserPath).parseHtmlStructure;
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      const result: Array<{ extracted: string; browser: string }> = [];
      for (const [source] of args.entries) {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<div>${source}</div>`));
        result.push({ extracted: parse(`<div>${source}</div>`).textContent,
          browser: await win.webContents.executeJavaScript("document.body.textContent.replace(/\\s+/g, ' ').trim()") });
      }
      return result;
    } finally { win.destroy(); }
  }, { parserPath, entries });
  expect(observed).toEqual(entries.map(([, expected]) => ({ extracted: expected, browser: expected })));

  const entry = orkas.createWorkspaceFile('price-project/index.html', '<div>&yen;99</div>');
  const root = path.dirname(entry);
  orkas.createWorkspaceFile('price-project/image-manifest.json', JSON.stringify({
    schema_version: 1, route: 'compose', entry: 'index.html', canvas: { width: 1200, height: 1200 },
    brief: { purpose: 'Product image', audience: 'Buyers', required_copy: ['¥99'], must_include: [], must_avoid: [] },
    art_direction: { subject_world: 'Product', one_job: 'Show offer', visual_tradition: 'Editorial', composition: 'Centered',
      signature_device: 'Price label', typography: 'Sans serif', color_light_material: 'Paper' },
    generation_budget: { max_calls: 0 },
  }));
  for (const [html, accepted] of [
    ['<div>&yen;99</div>', true], ['<div>&#xA5;99</div>', true],
    ['<div>&amp;yen;99</div>', false], ['<div>¥199</div>', false],
    ['<!-- ¥99 --><script>const price="¥99";</script><div title="¥99">Offer</div>', false],
  ] as const) {
    orkas.createWorkspaceFile('price-project/index.html', html);
    const result = await orkas.electronApp!.evaluate(async (_, args) => {
      const studio = (process as any).mainModule.require(args.studioPath);
      const result = await studio.inspectImageStudioProject(args.root);
      return { ok: result.ok, codes: result.blockers.map((item: any) => item.code) };
    }, { studioPath, root });
    expect(result.ok).toBe(accepted);
    if (!accepted) expect(result.codes).toContain('E_REQUIRED_COPY_MISSING');
  }
});
