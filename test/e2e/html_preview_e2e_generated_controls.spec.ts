import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';
import type { HtmlPreviewDesignEvidence } from '../../src/main/features/html_preview';

test('exercises SVG diagram controls and downloads without losing native controls or disabled exclusions', async ({ sdkOrkas: orkas }, info) => {
  const entry = orkas.createWorkspaceFile('svg-controls/index.html', `<!doctype html>
    <style>button:focus-visible,[tabindex]:focus-visible{outline:2px solid blue}</style>
    <button onclick="document.getElementById('detail').textContent='Native selected'">Native control</button>
    <svg viewBox="0 0 420 180" width="420" style="max-width:100%;height:auto" aria-label="Architecture">
      <g role="button" tabindex="0" aria-label="Diagram detail" onclick="document.getElementById('detail').textContent='Diagram selected'">
        <rect width="120" height="40" fill="blue"/><text y="20" fill="white">Diagram</text>
      </g>
      <g role="tab" tabindex="0" aria-label="Unwired detail" transform="translate(140 0)">
        <rect width="120" height="40" fill="gray"/>
      </g>
      <g role="button" tabindex="0" aria-label="Download diagram" transform="translate(0 60)"
        onclick="const a=document.createElement('a');a.download='diagram.txt';a.href='data:text/plain,Diagram';a.click()">
        <rect width="120" height="40" fill="green"/>
      </g>
      <g role="button" aria-disabled="true" aria-label="Disabled detail" transform="translate(140 60)"
        onclick="console.error('Disabled control was activated')"><rect width="120" height="40"/></g>
      <g role="button" aria-label="Hidden detail" style="display:none"
        onclick="console.error('Hidden control was activated')"><rect width="120" height="40"/></g>
    </svg><p id="detail">Choose a component</p>`);
  for (const artifact of [false, true]) {
    const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
      const preview = (process as any).mainModule.require(args.modulePath);
      return (await (args.artifact ? preview.renderInteractiveHtmlSmoke(args.entry)
        : preview.renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 1280, height: 800 }]))).evidence;
    }, { entry, artifact, modulePath: path.resolve(__dirname, '../../src/main/features/html_preview.ts') });
    writeFileSync(info.outputPath(`svg-controls-${artifact}.json`), JSON.stringify({ ...evidence, entryPath: undefined }, null, 2));
    expect(evidence.ok).toBe(true);
    expect(evidence.blockers).toEqual([]);
    expect(evidence.viewports.every(view => view.consoleErrors.length === 0)).toBe(true);
    expect(evidence.interactions).toMatchObject({ controlsExercised: 4, stateControlsExercised: 3,
      stateTransitionsObserved: 2, failures: [], warnings: ['enabled control produced no observable outcome: Unwired detail'] });
    expect(evidence.interactions.downloads).toEqual([{
      filename: 'diagram.txt', mimeType: 'text/plain', totalBytes: 7, urlKind: 'data',
    }]);
  }
});

for (const empty of [false, true]) {
  test(`measures an inline resume download (${empty ? 'empty' : 'nonempty'})`, async ({ sdkOrkas: orkas }, info) => {
    const content = empty ? '' : '简历\nProduct designer\nExperience and contact details.';
    const entry = orkas.createWorkspaceFile('inline-resume/index.html', `<!doctype html>
      <style>a:focus-visible{outline:2px solid blue}</style>
      <a download="resume.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(content)}">Download resume</a>`);
    for (const artifact of [false, true]) {
      const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
        const preview = (process as any).mainModule.require(args.modulePath);
        return (await (args.artifact ? preview.renderInteractiveHtmlSmoke(args.entry)
          : preview.renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 1280, height: 800 }], {},
            { fileViewer: true }))).evidence;
      }, { entry, artifact, modulePath: path.resolve(__dirname, '../../src/main/features/html_preview.ts') });
      writeFileSync(info.outputPath(`inline-resume-${artifact}.json`), JSON.stringify({ ...evidence, entryPath: undefined }, null, 2));
      expect(evidence.interactions.downloads).toEqual([{
        filename: 'resume.txt', mimeType: 'text/plain', totalBytes: Buffer.byteLength(content), urlKind: 'data',
      }]);
      expect(evidence.ok).toBe(!empty);
    }
  });
}

for (const broken of [false, true]) {
  test(`fills an editor before download and retains empty-payload rejection (${broken ? 'broken' : 'working'})`, async ({ sdkOrkas: orkas }, info) => {
    const entry = orkas.createWorkspaceFile('editor/index.html', `<!doctype html>
      <style>button:focus-visible,textarea:focus-visible{outline:2px solid blue}</style>
      <label>Draft<textarea id="draft"></textarea></label><button id="download">Download</button>
      <script>
        let edits=0;
        const draft=document.getElementById('draft');
        draft.addEventListener('input',()=>edits++);
        document.getElementById('download').onclick=()=>{
          const a=document.createElement('a');
          a.download='draft-'+edits+'.txt';
          a.href=URL.createObjectURL(new Blob([${broken ? "''" : 'draft.value'}],{type:'text/plain'}));
          a.click();
        };
      </script>`);
    for (const artifact of [false, true]) {
      const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
        const preview = (process as any).mainModule.require(args.modulePath);
        return (await (args.artifact ? preview.renderInteractiveHtmlSmoke(args.entry)
          : preview.renderResponsiveHtmlPreview(args.entry, [{name:'desktop',width:1280,height:800}]))).evidence;
      }, {entry,artifact,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
      writeFileSync(info.outputPath(`editor-${artifact}.json`), JSON.stringify({...evidence,entryPath:undefined},null,2));
      expect(evidence.interactions.downloads).toHaveLength(1);
      expect(evidence.interactions.downloads[0]).toMatchObject({filename:'draft-1.txt',mimeType:'text/plain'});
      expect(evidence.interactions.downloads[0].totalBytes > 0).toBe(!broken);
      expect(evidence.ok).toBe(!broken);
      expect(evidence.blockers).toEqual(broken
        ? ['1 observed download(s) lacked a filename, MIME type, or non-empty payload'] : []);
    }
  });
}

test('fills newly revealed fields before their action without editing earlier fields twice', async ({ sdkOrkas: orkas }, info) => {
  const entry = orkas.createWorkspaceFile('revealed-editor/index.html', `<!doctype html>
    <style>button:focus-visible,input:focus-visible{outline:2px solid blue}</style>
    <input id="title" aria-label="Title"><button id="open">Open editor</button><div id="editor"></div>
    <script>
      let edits=0;
      document.getElementById('title').addEventListener('input',()=>edits++);
      document.getElementById('open').onclick=()=>{
        document.getElementById('editor').innerHTML='<input id="body" aria-label="Body"><button id="save">Save</button>';
        document.getElementById('save').onclick=()=>{
          const a=document.createElement('a');
          a.download='saved-'+edits+'.txt';
          a.href=URL.createObjectURL(new Blob([document.getElementById('body').value],{type:'text/plain'}));
          a.click();
        };
      };
    </script>`);
  const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
    const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
    return (await renderResponsiveHtmlPreview(args.entry,[{name:'desktop',width:1280,height:800}])).evidence;
  }, {entry,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
  writeFileSync(info.outputPath('revealed-editor.json'),JSON.stringify({...evidence,entryPath:undefined},null,2));
  expect(evidence.interactions.downloads).toHaveLength(1);
  expect(evidence.interactions.downloads[0]).toMatchObject({filename:'saved-1.txt',mimeType:'text/plain'});
  expect(evidence.interactions.downloads[0].totalBytes).toBeGreaterThan(0);
  expect(evidence.interactions.stateControlsExercised).toBe(2);
  expect(evidence.blockers).toEqual([]);
  expect(evidence.ok).toBe(true);
});

test('reports low contrast for equivalent legacy and CSS Color 4 paints', async ({ sdkOrkas: orkas }) => {
  const entry = orkas.createWorkspaceFile('color-audit/index.html', `<!doctype html>
    <style>body{background:white;font:16px sans-serif}button{color:black}
    #legacy{color:#ccc}#srgb{color:color(srgb 0.8 0.8 0.8)}#lch{color:oklch(0.9 0 0)}</style>
    <button>Focusable</button><p id="legacy">Light text</p><p id="srgb">Equivalent light text</p>
    <p id="lch">Light neutral text</p>`);
  const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
    const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
    return (await renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 1280, height: 800 }], {},
      { interactions: false })).evidence;
  }, { entry, modulePath: path.resolve(__dirname, '../../src/main/features/html_preview.ts') });
  const design = evidence.viewports[0].design as HtmlPreviewDesignEvidence;
  expect(design.lowContrastText.map(item => item.selector).sort()).toEqual(['#lch', '#legacy', '#srgb']);
  const legacy = design.lowContrastText.find(item => item.selector === '#legacy');
  const equivalent = design.lowContrastText.find(item => item.selector === '#srgb');
  expect(equivalent).toMatchObject({ color: legacy!.color, background: legacy!.background, ratio: legacy!.ratio });
  expect(design.lowContrastText.some(item => item.selector === 'button')).toBe(false);
  expect(evidence.ok).toBe(true);
});

test('retains measured findings and marks a large document audit as partial', async ({ sdkOrkas: orkas }) => {
  const entry = orkas.createWorkspaceFile('bounded-audit/index.html', `<!doctype html>
    <style>body{background:white;font:16px sans-serif}p{color:#ccc}</style>
    <button>Focusable</button><p id="early">Known light text</p>${'<i hidden></i>'.repeat(6000)}
    <p id="late">Light text after the scan boundary</p>`);
  const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
    const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
    return (await renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 1280, height: 800 }], {},
      { interactions: false })).evidence;
  }, { entry, modulePath: path.resolve(__dirname, '../../src/main/features/html_preview.ts') });
  const design = evidence.viewports[0].design as HtmlPreviewDesignEvidence & { incomplete?: string[] };
  expect(design.lowContrastText.map(item => item.selector)).toContain('#early');
  expect(design.incomplete).toContain('element_limit');
  expect(design.error).toBeUndefined();
  expect(evidence.ok).toBe(true);
});

test('discovers post-submit controls and identifies an ineffective generated flip', async ({ sdkOrkas: orkas }, info) => {
  const source = readFileSync(path.join(__dirname, 'fixtures/app-template-flashcards/list-inline-defect.html'), 'utf8');
  orkas.createWorkspaceFile('web-app/orkas-app.json', '{"sdkVersion":1,"capabilities":["storage"]}');
  const results=[];
  for (const repaired of [false,true]) {
    const entry = orkas.createWorkspaceFile('web-app/index.html', repaired ? source.replace('.inner { position:relative;', '.inner { display:block; position:relative;') : source);
    for (const interactions of [false,true]) {
      const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
        const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
        return (await renderResponsiveHtmlPreview(args.entry, [{name:'desktop',width:1440,height:900}], {}, {interactions:args.interactions})).evidence;
      }, {entry,interactions,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
      results.push({repaired,interactions,evidence:{...evidence,entryPath:undefined}});
      expect(evidence.ok).toBe(repaired || !interactions);
      if (interactions) {
        expect(evidence.interactions.stateControlsExercised).toBeGreaterThan(0);
        expect(evidence.interactions.failures).toEqual(repaired ? [] : [
          'CSS transform does not apply to non-replaced inline box: span.inner',
        ]);
      } else {
        expect(evidence.interactions.performed).toBe(false);
        expect(evidence.interactions.controlsExercised).toBe(0);
      }
    }
  }
  writeFileSync(info.outputPath('probe.json'),JSON.stringify(results,null,2));
});

test('audits controls enabled by a form and reports an unobserved next action as inconclusive', async ({ sdkOrkas: orkas }, info) => {
  for (const working of [false, true]) {
    const entry = orkas.createWorkspaceFile('dynamic/index.html', `<!doctype html>
      <style>button:focus-visible,input:focus-visible{outline:2px solid blue}</style>
      <form onsubmit="event.preventDefault();document.getElementById('next').disabled=false;this.hidden=true">
        <label>Name<input required></label><button>Create</button>
      </form>
      <button id="next" disabled onclick="${working ? "document.getElementById('result').textContent='Completed'" : ''}">Next</button>
      <p id="result"></p>`);
    const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
      const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
      return (await renderResponsiveHtmlPreview(args.entry, [{name:'desktop',width:1280,height:800}])).evidence;
    }, {entry,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
    writeFileSync(info.outputPath(`dynamic-${working}.json`), JSON.stringify({...evidence, entryPath:undefined},null,2));
    expect(evidence.ok).toBe(true);
    expect(evidence.interactions.formsSubmitted).toBe(1);
    expect(evidence.interactions.stateControlsExercised).toBe(1);
    expect(evidence.interactions.failures).toEqual([]);
    expect(evidence.interactions.warnings).toEqual(working ? [] : ['enabled control produced no observable outcome: Next']);
    expect(evidence.interactions.stateTransitionsObserved).toBe(working ? 1 : 0);
  }
});

test('keeps no-change observations advisory and never edits readonly fields', async ({ sdkOrkas: orkas }, info) => {
  const entry = orkas.createWorkspaceFile('inconclusive/index.html', `<!doctype html>
    <style>button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid blue}</style>
    <button aria-pressed="true">Priority review</button>
    <input aria-label="Result" readonly value="42">
    <textarea aria-label="Explanation" readonly>Fixed explanation</textarea>
    <input id="query" aria-label="Query">
    <form onsubmit="event.preventDefault()">
      <input aria-label="Record" readonly required value="existing record"><button>Save</button>
    </form>
    <script>document.querySelectorAll('[readonly]').forEach(field => {
      field.addEventListener('input', () => console.error('Readonly input was modified'));
      field.addEventListener('change', () => console.error('Readonly input was modified'));
    });</script>`);
  for (const artifact of [false, true]) {
    const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
      const preview = (process as any).mainModule.require(args.modulePath);
      return (await (args.artifact ? preview.renderInteractiveHtmlSmoke(args.entry)
        : preview.renderResponsiveHtmlPreview(args.entry, [{name:'desktop',width:1280,height:800}]))).evidence;
    }, {entry,artifact,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
    writeFileSync(info.outputPath(`inconclusive-${artifact}.json`), JSON.stringify({...evidence, entryPath:undefined},null,2));
    expect(evidence.ok).toBe(true);
    expect(evidence.blockers).toEqual([]);
    expect(evidence.viewports.every(view => view.consoleErrors.length === 0)).toBe(true);
    expect(evidence.interactions).toMatchObject({ controlsExercised:3, formsSubmitted:1,
      stateChangesObserved:0, failureCount:0, failures:[], warningCount:3 });
    expect(evidence.interactions.warnings).toEqual(expect.arrayContaining([
      'enabled control produced no observable outcome: Priority review',
      'standalone field produced no observable outcome: Query',
    ]));
    expect(evidence.warnings.join(' ')).toContain('does not establish a functional failure');
    if (artifact) expect(evidence.warnings.join(' ')).toContain('functional behavior remains unverified');
  }
});

test('distinguishes ignored inline transforms from transformable and hidden boxes', async ({ sdkOrkas: orkas }) => {
  for (const broken of [false, true]) {
    const entry = orkas.createWorkspaceFile('transforms/index.html', `<!doctype html>
      <style>button:focus-visible{outline:2px solid blue}.rotate{transform:rotate(15deg)}</style>
      <button>Focusable</button>
      <span id="target" class="rotate" style="display:${broken ? 'inline' : 'inline-block'}">Text</span>
      <span style="transform:rotate(0deg)">Identity</span>
      <span class="rotate" hidden>Hidden</span>
      <div style="display:flex"><span class="rotate">Flex child</span></div>
      <img class="rotate" alt="pixel" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3C/svg%3E">
      <svg width="40" height="40"><rect class="rotate" x="15" y="15" width="10" height="10"/></svg>`);
    const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
      const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
      return (await renderResponsiveHtmlPreview(args.entry, [{name:'desktop',width:1280,height:800}], {}, {interactions:false})).evidence;
    }, {entry,modulePath:path.resolve(__dirname,'../../src/main/features/html_preview.ts')});
    expect(evidence.ok).toBe(!broken);
    expect(evidence.viewports[0].ineffectiveTransforms).toEqual(broken ? ['#target'] : []);
  }
});
