#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const VALID_EXPECTATIONS = new Set(['live-ready', 'raster-handoff']);

function parseValidatorArgs(args) {
  let rootArg = '';
  const expectations = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--expect') {
      const expectation = args[index + 1];
      if (!expectation) throw new Error('--expect requires a profile name');
      expectations.push(expectation);
      index += 1;
      continue;
    }
    if (arg.startsWith('--expect=')) {
      expectations.push(arg.slice('--expect='.length));
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (rootArg) throw new Error(`Unexpected positional argument: ${arg}`);
    rootArg = arg;
  }
  for (const expectation of expectations) {
    if (!VALID_EXPECTATIONS.has(expectation)) {
      throw new Error(`Unknown expectation profile: ${expectation}`);
    }
  }
  return { rootArg, expectations: [...new Set(expectations)] };
}

export function validateHtmlArtifact(rootArg, { expectations = [] } = {}) {
if (!rootArg) {
  throw new Error('Usage: validate-html-artifact.mjs <artifact-directory> [--expect live-ready|raster-handoff]');
}
for (const expectation of expectations) {
  if (!VALID_EXPECTATIONS.has(expectation)) throw new Error(`Unknown expectation profile: ${expectation}`);
}
const activeExpectations = new Set(expectations);
const inferredExpectations = [];

const root = path.resolve(rootArg);
const errors = [];
const warnings = [];
const checks = {};
let entryHtml = '';

function fail(check, message) {
  checks[check] = false;
  errors.push(`${check}: ${message}`);
}

function pass(check) {
  if (checks[check] !== false) checks[check] = true;
}

function warn(check, message) {
  warnings.push(`${check}: ${message}`);
}

function filesBelow(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.zip')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function symlinksBelow(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.zip')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(rel);
    else if (entry.isDirectory()) out.push(...symlinksBelow(abs, rel));
  }
  return out.sort();
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return !parts.includes('..') && !parts.includes('');
}

function countTags(html, tag, closing = false) {
  const slash = closing ? '\\/' : '';
  return [...html.matchAll(new RegExp(`<${slash}${tag}\\b`, 'gi'))].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2]?.trim() ?? '';
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|=|$)`, 'i').test(attrs);
}

function formRanges(html) {
  return [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((match) => ({
    start: match.index ?? -1,
    end: (match.index ?? -1) + match[0].length,
  }));
}

function rangeIndexAt(index, ranges) {
  return ranges.findIndex((range) => index >= range.start && index < range.end);
}

function checkHtml(entryPath, html) {
  if (!/^\s*<!doctype\s+html\b/i.test(html)) fail('html-doctype', 'missing HTML doctype');
  else pass('html-doctype');

  for (const tag of ['html', 'head', 'body', 'script', 'style']) {
    const opens = countTags(html, tag);
    const closes = countTags(html, tag, true);
    if (opens !== closes) fail('html-critical-tags', `<${tag}> count ${opens} does not match closing count ${closes}`);
  }
  pass('html-critical-tags');

  const staticText = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (staticText.length < 24) fail('html-static-shell', 'less than 24 characters of meaningful static first-render text');
  else pass('html-static-shell');

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptIndex = 0;
  const inlineScripts = [];
  for (const match of html.matchAll(scriptRe)) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attrValue(attrs, 'type').toLowerCase();
    if (['application/json', 'application/ld+json', 'importmap', 'speculationrules'].includes(type)) {
      try {
        JSON.parse(match[2]);
      } catch (error) {
        fail('inline-data-syntax', error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (type && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) {
      continue;
    }
    scriptIndex += 1;
    inlineScripts.push(match[2]);
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) {
      warn('inline-script-syntax', `inline module script ${scriptIndex} needs a module-aware runtime check`);
      continue;
    }
    try {
      new vm.Script(match[2], { filename: `${entryPath}#inline-${scriptIndex}` });
    } catch (error) {
      fail('inline-script-syntax', error instanceof Error ? error.message : String(error));
    }
  }
  pass('inline-data-syntax');
  pass('inline-script-syntax');

  const generatedHandler = /(?:innerHTML|insertAdjacentHTML)\s*(?:=|\()[\s\S]{0,1200}\bon(?:click|change|input|submit)\s*=/i;
  if (generatedHandler.test(html)) fail('runtime-event-wiring', 'generated markup contains an inline event handler');
  else pass('runtime-event-wiring');

  const inlineCode = inlineScripts.join('\n');
  const controlSource = html.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
  const markupSource = controlSource
    .replace(/<script\b[\s\S]*?<\/script>/gi, (block) => ' '.repeat(block.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (block) => ' '.repeat(block.length))
    .replace(/<template\b[\s\S]*?<\/template>/gi, (block) => ' '.repeat(block.length));
  const ranges = formRanges(markupSource);
  const idCounts = new Map();
  for (const match of markupSource.matchAll(/<[a-z][^>]*>/gi)) {
    const id = attrValue(match[0], 'id');
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }

  const formControls = [...markupSource.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)]
    .filter((match) => rangeIndexAt(match.index ?? -1, ranges) >= 0)
    .map((match) => {
      const attrs = match[2] || '';
      return {
        attrs,
        formIndex: rangeIndexAt(match.index ?? -1, ranges),
        id: attrValue(attrs, 'id'),
        name: attrValue(attrs, 'name'),
        describedBy: new Set(attrValue(attrs, 'aria-describedby').split(/\s+/).filter(Boolean)),
      };
    })
    .filter((control) => control.id || control.name);
  const fieldErrors = [...markupSource.matchAll(/<(?:div|p|span|small|output)\b([^>]*)>[\s\S]*?<\/(?:div|p|span|small|output)>/gi)]
    .filter((match) => rangeIndexAt(match.index ?? -1, ranges) >= 0)
    .map((match) => {
      const attrs = match[1] || '';
      return {
        formIndex: rangeIndexAt(match.index ?? -1, ranges),
        id: attrValue(attrs, 'id'),
        semantic: `${attrValue(attrs, 'id')} ${attrValue(attrs, 'class')} ${attrValue(attrs, 'data-state')} ${attrValue(attrs, 'role')}`,
      };
    })
    .filter((error) => error.id && /(?:^|[\s_-])(?:error|invalid)(?:[\s_-]|$)|\balert\b/i.test(error.semantic));

  const inaccessibleFieldErrors = [];
  for (const control of formControls) {
    for (const targetId of control.describedBy) {
      if (!/(?:^|[-_])(?:error|invalid)(?:[-_]|$)/i.test(targetId)) continue;
      const targetCount = idCounts.get(targetId) || 0;
      if (targetCount === 0) {
        warn(
          'form-error-accessibility',
          `${control.id || control.name} -> ${targetId} has a missing aria-describedby target`,
        );
      } else if (targetCount > 1) {
        warn(
          'form-error-accessibility',
          `${control.id || control.name} -> ${targetId} has an ambiguous aria-describedby target (${targetCount} matching ids)`,
        );
      }
    }
  }
  for (const error of fieldErrors) {
    const sameFormControls = formControls.filter((control) => control.formIndex === error.formIndex);
    const directlyLinked = sameFormControls.filter((control) => control.describedBy.has(error.id));
    const conventionallyMatched = sameFormControls.filter((control) => control.id && [
      `${control.id}-error`,
      `${control.id}_error`,
      `${control.id}-invalid`,
      `${control.id}_invalid`,
    ].includes(error.id));
    if (conventionallyMatched.length > 1) {
      warn(
        'form-error-accessibility',
        `${error.id} maps ambiguously to multiple controls with the same conventional id`,
      );
    }
    const associated = [...new Set([
      ...directlyLinked,
      ...(conventionallyMatched.length === 1 ? conventionallyMatched : []),
    ])];
    if (!associated.length) {
      warn(
        'form-error-accessibility',
        `${error.id} could not be mapped deterministically; link it with aria-describedby or use an exact <control-id>-error or <control-id>-invalid id`,
      );
      continue;
    }
    for (const control of associated) {
      const missing = [];
      if (!control.describedBy.has(error.id)) missing.push(`aria-describedby="${error.id}"`);
      if (!hasAttr(control.attrs, 'aria-invalid')) missing.push('aria-invalid');
      if (missing.length) {
        inaccessibleFieldErrors.push(
          `${control.id || control.name} -> ${error.id} missing ${missing.join(' and ')}`,
        );
      }
    }
  }
  if (inaccessibleFieldErrors.length) {
    fail(
      'form-error-accessibility',
      `custom field errors must be linked to their controls: ${inaccessibleFieldErrors.join('; ')}`,
    );
  } else {
    pass('form-error-accessibility');
  }

  const hasInitializer =
    /\b(?:function\s+)?(?:init|boot|start|render)[A-Za-z0-9_$]*\s*(?:=|\()/i.test(inlineCode) ||
    /\b(?:document|window)\.addEventListener\s*\(\s*["']DOMContentLoaded["']\s*,/i.test(inlineCode) ||
    /\bdocument\.readyState\b/i.test(inlineCode);
  const hasInteractiveMarkup = /<(?:button|form|input|select|textarea)\b|role\s*=\s*["'](?:tab|dialog)["']|data-action\s*=/i.test(html);
  if (hasInitializer && hasInteractiveMarkup) {
    const unguardedNamedReadyCallback =
      /\b(?:document|window)\.addEventListener\s*\(\s*["']DOMContentLoaded["']\s*,\s*(?!(?:safeInit|guardedInit|bootSafely|startSafely)\b)[A-Za-z_$][A-Za-z0-9_$]*\s*(?=[,)])/i.test(inlineCode);
    const namedGuardedInitializer =
      /(?:function\s+(?:safeInit|guardedInit|bootSafely|startSafely)\s*\([^)]*\)|(?:const|let)\s+(?:safeInit|guardedInit|bootSafely|startSafely)\s*=\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>))\s*\{[\s\S]{0,12000}\btry\s*\{[\s\S]{0,12000}\b(?!(?:if|for|while|switch|catch|with)\b)[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)[\s\S]{0,12000}\bcatch\s*\([^)]*\)\s*\{[\s\S]{0,3000}(?:textContent|innerHTML|replaceChildren|hidden\s*=\s*false)/i.test(inlineCode) &&
      /\b(?:document|window)\.addEventListener\s*\(\s*["']DOMContentLoaded["']\s*,\s*(?:safeInit|guardedInit|bootSafely|startSafely)\b|\b(?:safeInit|guardedInit|bootSafely|startSafely)\s*\(\s*\)/i.test(inlineCode);
    const inlineGuardedReadyCallback =
      /\b(?:document|window)\.addEventListener\s*\(\s*["']DOMContentLoaded["']\s*,\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{[\s\S]{0,600}\btry\s*\{[\s\S]{0,5000}\b(?!(?:if|for|while|switch|catch|with)\b)[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)[\s\S]{0,5000}\bcatch\s*\([^)]*\)\s*\{[\s\S]{0,3000}(?:textContent|innerHTML|replaceChildren|hidden\s*=\s*false)/i.test(inlineCode);
    if (unguardedNamedReadyCallback || (!namedGuardedInitializer && !inlineGuardedReadyCallback)) {
      fail(
        'runtime-guarded-init',
        'interactive HTML with an initializer must invoke it through a guarded callback that exposes an actionable fallback',
      );
    } else {
      pass('runtime-guarded-init');
    }
  } else {
    pass('runtime-guarded-init');
  }

  const localRefs = new Set();
  for (const match of html.matchAll(/(?:^|[\s<])(?:src|href)\s*=\s*["']([^"']+)["']/gim)) {
    localRefs.add(match[1].trim());
  }
  for (const match of html.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    localRefs.add(match[1].trim());
  }
  for (const ref of localRefs) {
    if (!ref || ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('blob:')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
    const localPath = ref.split(/[?#]/, 1)[0];
    if (!isSafeRelative(localPath)) {
      fail('local-references', `unsafe or root-relative reference: ${localPath}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(entryPath), localPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail('local-references', `reference escapes artifact directory: ${localPath}`);
    } else if (!fs.existsSync(resolved)) {
      fail('local-references', `missing local reference: ${localPath}`);
    } else {
      const realRoot = fs.realpathSync(root);
      const realResolved = fs.realpathSync(resolved);
      if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) {
        fail('artifact-boundary', `reference resolves outside artifact directory: ${localPath}`);
      }
    }
  }
  pass('local-references');
}

function normalizedState(value) {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function checkLiveReadyExpectation(html) {
  const source = html.replace(/<!--([\s\S]*?)-->/g, ' ');
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join('\n');
  const exactDomStates = new Set(
    [...source.matchAll(/\bdata-(?:(?:live|ui)-)?state=["']([^"']+)["']/gi)]
      .map((match) => normalizedState(match[1]))
      .filter((value) => /^[a-z][a-z0-9-]*$/.test(value)),
  );
  const hasStateBranch = (aliases) => aliases.some((alias) => {
    const token = escapeRegExp(alias);
    return new RegExp(
      `(?:\\b(?:state|status|mode|view)\\b\\s*={2,3}\\s*["']${token}["']|["']${token}["']\\s*={2,3}\\s*\\b(?:state|status|mode|view)\\b|\\bcase\\s+["']${token}["']|\\b(?:set|apply|render|show)(?:Live)?State\\s*\\(\\s*["']${token}["'])`,
      'i',
    ).test(scripts);
  });
  const implemented = (aliases) => aliases.some((alias) => exactDomStates.has(alias)) || hasStateBranch(aliases);
  const liveChecks = [
    {
      id: 'expect-live-loading',
      pass: implemented(['loading', 'pending']) && /loading|加载中|aria-busy=["']true["']/i.test(source),
      error: 'loading must exist in DOM or rendering logic with visible loading feedback',
    },
    {
      id: 'expect-live-empty',
      pass: implemented(['empty']) && /empty|暂无|无项目|没有项目|无数据/i.test(source),
      error: 'empty must exist in DOM or rendering logic with visible empty-state feedback',
    },
    {
      id: 'expect-live-failed-refresh',
      pass: implemented(['failed-refresh', 'refresh-failed', 'refresh-failure', 'refresh-error', 'error'])
        && /failed[-_ ]?refresh|refresh.{0,24}(?:fail(?:ed|ure)?|error)|(?:fail(?:ed|ure)?|error).{0,24}refresh|刷新失败/i.test(source),
      error: 'failed-refresh must exist in DOM or rendering logic with visible refresh-failure feedback',
    },
    {
      id: 'expect-live-stale-partial',
      pass: implemented(['stale', 'partial', 'partial-stale']) && /stale|partial|过期|部分数据|数据不完整/i.test(source),
      error: 'stale or partial must exist in DOM or rendering logic with visible freshness feedback',
    },
    {
      id: 'expect-live-last-updated',
      pass: /<time\b[^>]*\bdata-field=["']lastUpdated["']/i.test(source)
        || (
          /last updated|updated.{0,20}ago|最后更新|上次更新|最近更新|最后同步|上次同步|刷新于|同步于|更新于/i.test(source)
          && /lastUpdated|updatedAt|refreshedAt|data-field=["']lastUpdated["']/i.test(source)
        ),
      error: 'last-updated must be rendered through a canonical time/data field rather than prose alone',
    },
  ];
  for (const item of liveChecks) {
    if (item.pass) pass(item.id);
    else fail(item.id, item.error);
  }

  const forbiddenJsonKeys = new Set([
    'token',
    'accesstoken',
    'refreshtoken',
    'secret',
    'credential',
    'password',
    'cookie',
    'authorization',
    'authheader',
    'headers',
    'raw',
    'rawresponse',
    'payload',
    'body',
  ]);
  const unsafeFields = [];
  const unsafeValues = [];
  const inspectJson = (value, trail = '') => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectJson(item, `${trail}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && /(?:sk|ghp|xox[baprs])-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~-]{12,}/i.test(value)) {
        unsafeValues.push(trail || '(root)');
      }
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const nextTrail = trail ? `${trail}.${key}` : key;
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
      if (forbiddenJsonKeys.has(normalizedKey)) unsafeFields.push(nextTrail);
      inspectJson(item, nextTrail);
    }
  };
  const invalidJsonFiles = [];
  for (const relativeFile of filesBelow(root).filter((file) => file.toLowerCase().endsWith('.json'))) {
    try {
      inspectJson(JSON.parse(fs.readFileSync(path.join(root, relativeFile), 'utf8')), relativeFile);
    } catch {
      invalidJsonFiles.push(relativeFile);
    }
  }
  if (invalidJsonFiles.length) {
    fail('expect-live-json-contract', `persisted JSON must parse: ${invalidJsonFiles.join(', ')}`);
  } else {
    pass('expect-live-json-contract');
  }
  if (unsafeFields.length || unsafeValues.length) {
    fail(
      'expect-live-safe-persistence',
      `persisted JSON contains sensitive keys or secret-like values: ${[...unsafeFields, ...unsafeValues].join(', ')}`,
    );
  } else {
    pass('expect-live-safe-persistence');
  }
}

function parseAspect(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const ratio = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (ratio) {
    const denominator = Number(ratio[2]);
    return denominator > 0 ? Number(ratio[1]) / denominator : null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function rasterBriefFrom(html) {
  for (const match of html.matchAll(/<template\b([^>]*)>([\s\S]*?)<\/template>/gi)) {
    const attrs = match[1] || '';
    if (!/(?:^|\s)asset-brief(?:\s|$)/i.test(attrValue(attrs, 'class'))) continue;
    if (!/application\/json/i.test(attrValue(attrs, 'type'))) {
      return { error: 'asset-brief template must use type="application/json"' };
    }
    try {
      const value = JSON.parse(match[2].trim());
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'asset-brief JSON must be an object' };
      }
      return { value };
    } catch (error) {
      return { error: `asset-brief JSON is invalid: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { error: 'missing <template class="asset-brief" type="application/json">' };
}

function rasterDimensions(brief) {
  let width = Number(brief.width);
  let height = Number(brief.height);
  if ((!Number.isFinite(width) || !Number.isFinite(height)) && typeof brief.dimensions === 'string') {
    const match = brief.dimensions.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (match) {
      width = Number(match[1]);
      height = Number(match[2]);
    }
  }
  return { width, height };
}

function paletteSize(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).length;
  if (typeof value !== 'string') return 0;
  const colors = value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  if (colors.length >= 2) return colors.length;
  return [...value.matchAll(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi)].length;
}

function checkRasterHandoffExpectation(html) {
  const parsed = rasterBriefFrom(html);
  const brief = parsed.value;
  if (!brief) {
    fail('expect-raster-brief-schema', parsed.error);
    fail('expect-raster-brief-route', 'a pending raster-generation capability route must be machine-readable');
    fail('expect-raster-brief-fields', 'composition, aspect, dimensions, palette, background, and save_path are required');
    fail('expect-raster-brief-ratio', 'a ratio-consistent raster brief is required');
    fail('expect-raster-integration', 'the future raster path must be prewired as an inert data-raster-src hook');
    fail('expect-raster-fallback', 'the pending raster hook must retain an honest visible fallback');
    return;
  }
  pass('expect-raster-brief-schema');

  const capability = String(brief.capability ?? brief.kind ?? '');
  const status = String(brief.status ?? '');
  if (/(?:raster|image)[-_ ]?(?:generation|generator)|raster[-_ ]?asset/i.test(capability)
    && /pending|planned|handoff|not[-_ ]?generated|awaiting/i.test(status)) {
    pass('expect-raster-brief-route');
  } else {
    fail(
      'expect-raster-brief-route',
      'asset-brief must name the raster/image-generation capability and a pending/handoff status',
    );
  }

  const composition = typeof brief.composition === 'string' && brief.composition.trim();
  const aspect = parseAspect(brief.aspect);
  const { width, height } = rasterDimensions(brief);
  const background = typeof brief.background === 'string' && brief.background.trim();
  const savePath = String(brief.save_path ?? brief.savePath ?? '');
  const safeSavePath = isSafeRelative(savePath)
    && /^assets\/[a-z0-9._/-]+\.(?:png|jpe?g|webp|avif)$/i.test(savePath);
  const fieldsValid = Boolean(
    composition
    && aspect
    && Number.isInteger(width) && width > 0
    && Number.isInteger(height) && height > 0
    && paletteSize(brief.palette) >= 2
    && background
    && safeSavePath,
  );
  if (fieldsValid) pass('expect-raster-brief-fields');
  else {
    fail(
      'expect-raster-brief-fields',
      'asset-brief requires composition, aspect, positive integer width/height, two palette colors, background, and a safe raster assets/... save_path',
    );
  }

  const actualRatio = width / height;
  if (aspect && Number.isFinite(actualRatio) && Math.abs(actualRatio - aspect) / aspect <= 0.01) {
    pass('expect-raster-brief-ratio');
  } else {
    fail('expect-raster-brief-ratio', 'asset-brief aspect must match width/height within one percent');
  }

  const inertPaths = [...html.matchAll(/\bdata-(?:future|raster|asset)-src=["']([^"']+)["']/gi)]
    .map((match) => match[1].replace(/^\.\//, ''));
  if (safeSavePath && inertPaths.includes(savePath.replace(/^\.\//, ''))) {
    pass('expect-raster-integration');
  } else {
    fail('expect-raster-integration', 'asset-brief save_path must match an inert data-raster-src hook in the HTML');
  }

  const hasFallback = /\b(?:class|data-role|data-fallback)=["'][^"']*(?:fallback|placeholder|pending)[^"']*["']/i.test(html)
    || /<(?:p|span|div|figcaption)\b[^>]*>[\s\S]{0,240}(?:pending|placeholder|fallback|待生成|占位|备用)[\s\S]{0,240}<\/(?:p|span|div|figcaption)>/i.test(html)
    || /<img\b[^>]*\bdata-(?:future|raster|asset)-src=["'][^"']+["'][^>]*\bsrc=["']data:image\//i.test(html);
  if (inertPaths.length && hasFallback) pass('expect-raster-fallback');
  else fail('expect-raster-fallback', 'the inert raster hook must include an honest local/data placeholder or visible pending fallback');
}

function likelyRasterHeroSubstitution(manifestValue, html) {
  if (!manifestValue || typeof manifestValue !== 'object') return false;
  const designText = JSON.stringify(manifestValue.design ?? '');
  const originalHeroIntent = /(?:original|原创).{0,60}(?:hero|illustration|插画)|(?:hero|illustration|插画).{0,60}(?:original|原创)/i.test(designText);
  const explicitVectorIntent = /(?:explicit|requested|用户明确|明确要求).{0,40}(?:svg|vector|矢量)|(?:svg|vector|矢量).{0,40}(?:explicit|requested|用户明确|明确要求)/i.test(designText);
  const heroSvg = /<svg\b[^>]*(?:(?:class|id)=["'][^"']*(?:hero|illustration)[^"']*["']|aria-label=["'][^"']*(?:hero|illustration|插画|等距城市)[^"']*["'])/i.test(html);
  return originalHeroIntent && heroSvg && !explicitVectorIntent;
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  fail('artifact-directory', `not a directory: ${root}`);
} else {
  pass('artifact-directory');
  const symlinks = symlinksBelow(root);
  if (symlinks.length) fail('artifact-boundary', `symbolic links are not allowed: ${symlinks.join(', ')}`);
  else pass('artifact-boundary');
}

let manifest = null;
const manifestPath = path.join(root, 'artifact.json');
if (!fs.existsSync(manifestPath)) {
  fail('manifest-json', 'artifact.json is missing');
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pass('manifest-json');
  } catch (error) {
    fail('manifest-json', error instanceof Error ? error.message : String(error));
  }
}

if (manifest) {
  const contractValid =
    manifest.schema_version === 1 &&
    typeof manifest.artifact_id === 'string' &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(manifest.artifact_id) &&
    typeof manifest.format === 'string' && manifest.format.length > 0 &&
    Number.isInteger(manifest.revision) && manifest.revision >= 1;
  if (!contractValid) {
    fail('manifest-contract', 'schema_version=1, a stable artifact_id, format, and positive integer revision are required');
  } else {
    pass('manifest-contract');
  }

  if (!isSafeRelative(manifest.entry)) fail('manifest-entry', 'entry must be a safe relative path');
  else if (!fs.existsSync(path.join(root, manifest.entry))) fail('manifest-entry', `entry does not exist: ${manifest.entry}`);
  else pass('manifest-entry');

  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  if (!listed.length || listed.some((item) => !isSafeRelative(item))) {
    fail('manifest-files', 'files must be a non-empty list of safe relative paths');
  } else {
    const sortedListed = [...listed].sort();
    const actual = filesBelow(root);
    if (JSON.stringify(listed) !== JSON.stringify(sortedListed)) fail('manifest-files', 'files must be sorted');
    if (!listed.includes('artifact.json')) fail('manifest-files', 'files must include artifact.json');
    if (JSON.stringify(sortedListed) !== JSON.stringify(actual)) {
      fail('manifest-files', `inventory mismatch; listed=${JSON.stringify(sortedListed)} actual=${JSON.stringify(actual)}`);
    }
    pass('manifest-files');
  }

  if (typeof manifest.entry === 'string' && manifest.entry.toLowerCase().endsWith('.html')) {
    const entryPath = path.join(root, manifest.entry);
    if (fs.existsSync(entryPath)) {
      entryHtml = fs.readFileSync(entryPath, 'utf8');
      checkHtml(entryPath, entryHtml);
    }
  }
}

if (!activeExpectations.has('raster-handoff') && likelyRasterHeroSubstitution(manifest, entryHtml)) {
  activeExpectations.add('raster-handoff');
  inferredExpectations.push('raster-handoff');
}

for (const expectation of activeExpectations) {
  if (!entryHtml) {
    fail(`expect-${expectation}`, 'the expectation profile requires an HTML entry');
  } else if (expectation === 'live-ready') {
    checkLiveReadyExpectation(entryHtml);
  } else if (expectation === 'raster-handoff') {
    checkRasterHandoffExpectation(entryHtml);
  }
}

const result = {
  ok: errors.length === 0,
  root,
  expectations: [...activeExpectations],
  inferredExpectations,
  checks,
  errors,
  warnings,
};
return result;
}

export default async function runSkill({ args = [] } = {}) {
  if (!Array.isArray(args)) throw new Error('args must be an array');
  const parsed = parseValidatorArgs(args);
  return validateHtmlArtifact(parsed.rootArg, { expectations: parsed.expectations });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseValidatorArgs(process.argv.slice(2));
    const result = validateHtmlArtifact(parsed.rootArg, { expectations: parsed.expectations });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
