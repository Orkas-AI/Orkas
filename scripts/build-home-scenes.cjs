#!/usr/bin/env node
/* Derive the homepage use-case scenes' desktop UI layer from the renderer.
 *
 * Web/home.html renders use-case scenes with the same class names as the
 * Orkas desktop UI inside `.oks-ui` containers. This script copies the
 * renderer tokens and every style rule whose classes are all used by that
 * markup, scoped under `.oks-ui`, and copies the desktop UI labels the scenes
 * show into each homepage locale catalog as `pcui.*`. It then copies each scene
 * into its use-case landing page with a derived scene catalog. Rerun it after a
 * desktop UI or scene change; `--check` fails when committed outputs are stale.
 * Run: node PC/scripts/build-home-scenes.cjs [--check]
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const SOURCE = 'PC/src/renderer/style.css';
const MARKUP = 'Web/home.html';
const OUTPUT = 'Web/home-scene-ui.css';
const UI_LOCALES = 'PC/src/renderer/locales';
const HOME_LOCALES = 'Web/seo/locales/home';
// Desktop labels shown verbatim in the scenes.
const UI_KEYS = ['auto.title', 'auto.status_enabled', 'auto.device_current',
  'project.todo.title', 'project.todo.status_todo', 'project.todo.status_progress', 'project.todo.status_review',
  'apps.title', 'apps.publish_published', 'apps.view_details',
  'apps.publish_address', 'apps.publish_visit', 'apps.publish_published_at', 'apps.publish_updated_at', 'apps.publish_trend', 'apps.publish_update', 'apps.publish_unpublish', 'common.copy',
  'project.tab_tasks', 'project.tab_auto', 'project.resources.title', 'project.resources.agents_tab', 'project.resources.files_tab', 'sidebar.bucket.last7'];
// Example figures rendered through desktop templates that take values.
const TEMPLATES = { 'apps.publish_pv': { total: '1,286', today: '42' } };
// Example last-run times per scenario, formatted through the desktop template.
const LAST_RUNS = { marketing: '10-19 09:00', ops: '10-19 08:30', ops2: '10-19 10:00', client: '10-17 16:00', client2: '10-20 08:00', launch: '10-16 17:00' };
const SCOPE = '.oks-ui';

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Split top-level blocks: [{prelude, body}] where body is the text inside braces.
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    out.push({ prelude: prelude.replace(/^[^{}]*;/, '').trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function splitSelectors(prelude) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) { parts.push(prelude.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(prelude.slice(start).trim());
  return parts.filter(Boolean);
}

function usedClasses(html) {
  const used = new Set();
  const re = /<[^>]+class="([^"]*\boks-ui\b[^"]*)"[^>]*>/g;
  let match;
  while ((match = re.exec(html))) {
    // Collect from the opening `.oks-ui` tag to the end of its figure.
    const end = html.indexOf('</figure>', match.index);
    if (end < 0) throw Error('`.oks-ui` markup must live inside a <figure>');
    for (const attr of html.slice(match.index, end).matchAll(/class="([^"]*)"/g)) {
      for (const name of attr[1].split(/\s+/)) if (name) used.add(name);
    }
  }
  if (!used.size) throw Error('No `.oks-ui` markup found in ' + MARKUP);
  return used;
}

function scopeSelector(selector, used) {
  if (/^(html|body|:root)\b/.test(selector) || selector.includes('#')) return null;
  const classes = [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]);
  if (!classes.length || !classes.every(name => used.has(name))) return null;
  return `${SCOPE} ${selector}`;
}

function rules(css, used, keyframes) {
  const out = [];
  for (const { prelude, body } of blocks(css)) {
    if (/^@(media|supports)\b/.test(prelude)) {
      const inner = rules(body, used, keyframes);
      if (inner.length) out.push(`${prelude} {\n${inner.map(rule => '  ' + rule).join('\n')}\n}`);
      continue;
    }
    if (prelude.startsWith('@')) continue;
    const selectors = splitSelectors(prelude).map(s => scopeSelector(s, used)).filter(Boolean);
    if (!selectors.length) continue;
    const declarations = body.trim().replace(/\s+/g, ' ');
    for (const match of declarations.matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)) keyframes.add(match[1]);
    out.push(`${selectors.join(', ')} { ${declarations} }`);
  }
  return out;
}

function buildCss(source, markup) {
  const css = stripComments(source);
  const used = usedClasses(markup);
  const top = blocks(css);
  const tokens = top.filter(b => b.prelude === ':root').map(b => b.body.trim().replace(/\s+/g, ' ')).join(' ');
  const base = top.filter(b => b.prelude === 'body').map(b => b.body).join(';')
    .split(';').map(d => d.trim()).filter(d => /^(font-family|color)\s*:/.test(d)).join('; ');
  const keyframes = new Set();
  const body = rules(css, used, keyframes);
  const frames = top.filter(b => keyframes.has((b.prelude.match(/^@keyframes\s+([\w-]+)/) || [])[1]))
    .map(b => `${b.prelude} { ${b.body.trim().replace(/\s+/g, ' ')} }`);
  return [
    `/* Generated by PC/scripts/build-home-scenes.cjs from ${SOURCE}. Do not edit. */`,
    `${SCOPE} { ${tokens} ${base}; }`,
    ...body,
    ...frames,
    '',
  ].join('\n');
}

function catalogs() {
  const out = {};
  for (const file of fs.readdirSync(path.join(root, HOME_LOCALES)).filter(f => f.endsWith('.json')).sort()) {
    const homeFile = path.join(root, HOME_LOCALES, file);
    const ui = JSON.parse(fs.readFileSync(path.join(root, UI_LOCALES, file), 'utf8'));
    const home = JSON.parse(fs.readFileSync(homeFile, 'utf8'));
    for (const key of Object.keys(home)) if (key.startsWith('pcui.')) delete home[key];
    for (const key of UI_KEYS) {
      if (typeof ui[key] !== 'string') throw Error(`Missing desktop label ${key} in ${file}`);
      home['pcui.' + key] = ui[key];
    }
    for (const [key, values] of Object.entries(TEMPLATES)) {
      if (typeof ui[key] !== 'string') throw Error(`Missing desktop label ${key} in ${file}`);
      home['pcui.' + key] = ui[key].replace(/\{(\w+)\}/g, (_, name) => values[name]);
    }
    for (const [scenario, when] of Object.entries(LAST_RUNS)) {
      home[`pcui.auto.last_run.${scenario}`] = ui['auto.last_run'].replace('{when}', when);
    }
    out[homeFile] = JSON.stringify(home, null, 2) + '\n';
  }
  return out;
}

// Each homepage scene is also the example on its use-case landing page.
const LANDING_PAGES = { marketing: 'content-writing', ops: 'ecommerce', client: 'client-projects', launch: 'product-launch', apps: 'build-apps' };
const SCENE_LOCALES = 'Web/seo/locales/scenes';

function sceneFigure(html, scenario, source) {
  const pattern = new RegExp(`<figure class="business-shot[^"]*"[^>]*data-i18n-aria-label="business\\.${scenario}\\.visual"[^>]*>[\\s\\S]*?</figure>`);
  const match = html.match(pattern);
  if (!match) throw Error(`Missing ${scenario} scene in ${source}`);
  return { pattern, figure: match[0] };
}

function landingPages(markup) {
  const out = {};
  for (const [scenario, slug] of Object.entries(LANDING_PAGES)) {
    const file = path.join(root, 'Web/use', slug, 'index.html');
    const page = fs.readFileSync(file, 'utf8');
    // Landing pages live two levels below the homepage.
    const figure = sceneFigure(markup, scenario, MARKUP).figure.replace(/(src|href)="\.\/res\//g, '$1="../../res/');
    out[file] = page.replace(sceneFigure(page, scenario, file).pattern, () => figure);
  }
  return out;
}

// Landing pages keep their own catalogs; scene copy comes from a derived
// catalog so homepage-only keys never override page metadata.
function sceneCatalogs(markup, homeCatalogs) {
  const keys = new Set();
  for (const scenario of Object.keys(LANDING_PAGES)) {
    for (const match of sceneFigure(markup, scenario, MARKUP).figure.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)) keys.add(match[1]);
  }
  const out = {};
  for (const [homeFile, text] of Object.entries(homeCatalogs)) {
    const home = JSON.parse(text), scene = {};
    for (const key of [...keys].sort()) {
      if (typeof home[key] !== 'string') throw Error(`Missing scene key ${key} in ${path.basename(homeFile)}`);
      scene[key] = home[key];
    }
    out[path.join(root, SCENE_LOCALES, path.basename(homeFile))] = JSON.stringify(scene, null, 2) + '\n';
  }
  return out;
}

function outputs() {
  const markup = fs.readFileSync(path.join(root, MARKUP), 'utf8');
  const css = buildCss(fs.readFileSync(path.join(root, SOURCE), 'utf8'), markup);
  const home = catalogs();
  return { [path.join(root, OUTPUT)]: css, ...home, ...landingPages(markup), ...sceneCatalogs(markup, home) };
}

function main() {
  const files = outputs();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files)
      .filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      .map(([file]) => path.relative(root, file));
    if (stale.length) {
      console.error(`Stale homepage scene outputs: ${stale.join(', ')}. Run: node PC/scripts/build-home-scenes.cjs`);
      process.exitCode = 1;
    }
    return;
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  process.stdout.write(`Wrote ${Object.keys(files).length} homepage scene outputs\n`);
}

if (require.main === module) main();
module.exports = { buildCss, outputs, UI_KEYS, LAST_RUNS, TEMPLATES, LANDING_PAGES };
