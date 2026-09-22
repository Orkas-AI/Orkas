import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './fixtures/web-app-eval';
import { expect } from './fixtures/orkas';

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
