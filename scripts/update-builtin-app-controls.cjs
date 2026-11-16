#!/usr/bin/env node
'use strict';
// Opaque app frames cannot load desktop modules. Derive their offline control
// bundle from the owning renderer source instead of maintaining another widget.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<=a||b-a>100000)throw Error('Shared control source boundary missing');return source.slice(a,b);}
function rule(source,start){const a=source.indexOf('\n'+start),b=source.indexOf('}',a);if(a<0||b<=a||b-a>2000||source.slice(a,b).includes('@'))throw Error('Shared control rule missing');return source.slice(a,b+1)+'\n';}
function generatedFiles(){
 const utils=fs.readFileSync(path.join(root,'src/renderer/modules/utils.js'),'utf8');
 const placement=fs.readFileSync(path.join(root,'src/renderer/modules/dropdown-placement.js'),'utf8').split("if (typeof module !== 'undefined'")[0];
 const select=section(utils,'const AI_SELECT_BASE_POPOVER_Z_INDEX','// Test bridge');
 const escape=section(utils,'function escapeHtml(str)','// Safe resource-URI');
 const css=section(fs.readFileSync(path.join(root,'src/renderer/style.css'),'utf8'),'/* ── Custom dropdown (AiSelect)','/* Opt-in calendar multi-selection');
 const desktop=fs.readFileSync(path.join(root,'src/renderer/style.css'),'utf8');
 const radii=['sm','lg'].map(size=>{const match=desktop.match(new RegExp('--radius-'+size+':[^;]+;'));if(!match)throw Error('Shared radius token missing');return match[0];}).join('');
 const sharedCss=[['.chat-attach-btn {','\n.chat-composer-divider {'],['.modal {','\n.form-row {'],['.form-row {','.form-row input[type="text"],'],['.form-input {','.custom-max-tokens-input {'],['.modal-actions {','\n.ui-dialog-choices {'],['.btn {','.btn-sm {'],['.context-menu {','.context-menu-avatar {']].map(([start,end])=>section(desktop,'\n'+start,end)).join('\n')+rule(desktop,'.context-menu-item:hover,')+rule(desktop,'.context-menu-item:focus-visible {');
 const preface='/* Generated from desktop AiSelect; run node scripts/update-builtin-app-controls.cjs. */\n';
 const js=preface+"(function(){'use strict';\nconst t=key=>window.ContentLocales[document.documentElement.lang][{placeholder:'operation',empty:'noMatches',multiple:'selected'}[key.split('.')[1]]]||'';\n"+escape+placement+select+'\nwindow.ContentControls=Object.freeze({mount:_aiSelectMount});\n})();\n';
 const folder=path.join(root,'resources/builtin/apps/builtin-content-workbench');
 const icons='/* Generated from desktop icons; run node scripts/update-builtin-app-controls.cjs. */\n'+fs.readFileSync(path.join(root,'src/renderer/modules/icons.js'),'utf8');
 return new Map([[path.join(folder,'controls.js'),js],[path.join(folder,'controls.css'),preface+css],[path.join(folder,'icons.js'),icons],[path.join(folder,'desktop.css'),'/* Generated from desktop dialog, form, button and menu styles; run node scripts/update-builtin-app-controls.cjs. */\n:root{'+radii+'}\n'+sharedCss]]);
}
if(require.main===module){for(const[file,source]of generatedFiles()){if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==source)throw Error('Stale built-in controls');}else fs.writeFileSync(file,source);}}
module.exports={generatedFiles};
