#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_MANIFEST_NAME = '_manifest.json';
const BUILTIN_MANIFEST_SCHEMA = 1;
const BUILTIN_EXTRA_RESOURCE_FILTERS = Object.freeze([
  '!**/.DS_Store',
  '!**/__pycache__/**',
  '!**/*.pyc',
]);
const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MARKETPLACE_ID = /^[0-9a-f]{12}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CATEGORY_CODE = /^[a-z][a-z0-9_-]{0,79}$/;
const INPUT_ID = /^[a-z_][a-z0-9_]{0,31}$/;
const INPUT_TYPES = new Set(['text', 'textarea', 'select', 'multiselect', 'number', 'boolean', 'file', 'directory']);
const OUTPUT_FORMATS = new Set(['auto', 'text', 'dashboard', 'artifact']);
const INPUT_UI_LANGUAGES = new Set(['zh', 'en', 'ja', 'pt']);
const AVATAR_CATALOG = readJson(
  'avatar catalog',
  path.resolve(__dirname, '..', 'src', 'main', 'data', 'avatars.json'),
);
const AVATAR_ICONS = new Set(
  Array.isArray(AVATAR_CATALOG.icons) ? AVATAR_CATALOG.icons.map((entry) => entry.id) : [],
);
const AVATAR_COLORS = new Set(
  Array.isArray(AVATAR_CATALOG.colors) ? AVATAR_CATALOG.colors.map((entry) => entry.id) : [],
);
const REQUIRED_BUILTIN_INVENTORY = Object.freeze({
  system_skills: Object.freeze([
    'agent-creator',
    'autotask-creator',
    'package-installer',
    'skill-creator',
  ]),
  marketplace_agents: Object.freeze([
    '173d4235a431',
    '78900d8758bc',
    '79df9cc89f5f',
    '814b61b027f0',
    'a19101ba698a',
    'a316881746f9',
    'bcfcb4921dce',
    'e064dca9e1bd',
  ]),
  marketplace_skills: Object.freeze([
    '081c15ffbab4',
    '36bd44ae956c',
    '6743aa0797a2',
    '68fb048b85cb',
    '88aca13869d9',
    '9b1241732f3a',
    '9be6fda271a5',
    '9dfbd4e00c0d',
    'b1f384166705',
    'c72c656eca12',
    'e7f5c0e6f1be',
    'ee99fbb42964',
    'f283632103ba',
    'f347f715469c',
    'fc125b9df078',
  ]),
});

function slash(value) {
  return value.split(path.sep).join('/');
}

function isIgnoredJunk(relativePath) {
  const parts = slash(relativePath).split('/');
  const name = parts.at(-1) || '';
  return name === '.DS_Store' || name.endsWith('.pyc') || parts.includes('__pycache__');
}

function requiredDirectory(label, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`[builtin-resource-gate] missing ${label}: ${dir}`);
  }
}

function requiredFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`[builtin-resource-gate] missing ${label}: ${file}`);
  }
}

function readJson(label, file) {
  requiredFile(label, file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[builtin-resource-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function collectBuiltinFiles(root, options = {}) {
  root = path.resolve(root);
  requiredDirectory('builtin root', root);
  const records = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relativePath = slash(path.relative(root, absolute));
      if (relativePath === BUILTIN_MANIFEST_NAME) continue;
      if (options.allowIgnoredJunk && isIgnoredJunk(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`[builtin-resource-gate] symbolic links are not allowed: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        records.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`[builtin-resource-gate] unsupported filesystem entry: ${absolute}`);
      }
    }
  }
  visit(root);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function contentTreeSha256(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function parseFrontmatterScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value[0] === '"') {
    try { return JSON.parse(value); } catch { return value.slice(1, value.endsWith('"') ? -1 : undefined); }
  }
  if (value[0] === "'") {
    const end = value.endsWith("'") ? -1 : undefined;
    return value.slice(1, end).replace(/''/g, "'");
  }
  return value;
}

function skillFrontmatter(label, skillDir) {
  const file = path.join(skillDir, 'SKILL.md');
  requiredFile(`${label} SKILL.md`, file);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('---')) {
    throw new Error(`[builtin-resource-gate] ${label} SKILL.md is missing frontmatter: ${file}`);
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    throw new Error(`[builtin-resource-gate] ${label} SKILL.md has unterminated frontmatter: ${file}`);
  }
  const values = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    values[line.slice(0, colon).trim()] = parseFrontmatterScalar(line.slice(colon + 1));
  }
  if (!values.name || !SAFE_SKILL_ID.test(values.name)) {
    throw new Error(`[builtin-resource-gate] ${label} has invalid frontmatter name: ${values.name || '(missing)'}`);
  }
  if (!values.description && !values.description_zh && !values.description_en) {
    throw new Error(`[builtin-resource-gate] ${label} is missing a frontmatter description`);
  }
  return { name: values.name };
}

function exactNames(label, actual, expected) {
  actual = [...actual].sort();
  expected = [...expected].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  if (missing.length || unexpected.length || actual.length !== actualSet.size) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
      actual.length !== actualSet.size ? 'duplicates present' : '',
    ].filter(Boolean).join('; ');
    throw new Error(`[builtin-resource-gate] ${label} does not match (${details})`);
  }
}

function directoryNames(label, root) {
  requiredDirectory(label, root);
  const names = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (!entry.isDirectory()) {
      throw new Error(`[builtin-resource-gate] unexpected file in ${label}: ${path.join(root, entry.name)}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

function systemSkillInventory(root) {
  const skillsRoot = path.join(root, 'system', 'skills');
  const manifest = readJson('system skill manifest', path.join(skillsRoot, '_system.json'));
  if (!Array.isArray(manifest)) {
    throw new Error('[builtin-resource-gate] system skill manifest must be an array');
  }
  const seen = new Set();
  const rows = [];
  for (const raw of manifest) {
    const id = raw && typeof raw.id === 'string' ? raw.id : '';
    const updateAt = raw && (typeof raw.update_at === 'number' || typeof raw.update_at === 'string')
      ? raw.update_at
      : null;
    if (!SAFE_SKILL_ID.test(id) || updateAt === null || seen.has(id)) {
      throw new Error(`[builtin-resource-gate] invalid or duplicate system skill manifest row: ${JSON.stringify(raw)}`);
    }
    seen.add(id);
    const frontmatter = skillFrontmatter(`system skill ${id}`, path.join(skillsRoot, id));
    if (frontmatter.name !== id) {
      throw new Error(`[builtin-resource-gate] system skill directory/name mismatch: ${id} != ${frontmatter.name}`);
    }
    rows.push({ id, update_at: updateAt });
  }
  const actualDirs = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.name === '_system.json' || entry.name === '.DS_Store') continue;
    if (!entry.isDirectory()) {
      throw new Error(`[builtin-resource-gate] unexpected file in system skills root: ${path.join(skillsRoot, entry.name)}`);
    }
    actualDirs.push(entry.name);
  }
  exactNames('system skill directories', actualDirs, [...seen]);
  exactNames('required system skill inventory', [...seen], REQUIRED_BUILTIN_INVENTORY.system_skills);
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function standaloneSkillInventory(root) {
  const skillsRoot = path.join(root, 'marketplace', 'skills');
  const rows = [];
  for (const id of directoryNames('builtin marketplace skills root', skillsRoot)) {
    if (!MARKETPLACE_ID.test(id)) {
      throw new Error(`[builtin-resource-gate] invalid builtin marketplace skill id: ${id}`);
    }
    const dir = path.join(skillsRoot, id);
    const frontmatter = skillFrontmatter(`builtin marketplace skill ${id}`, dir);
    const meta = readJson(`builtin marketplace skill ${id} metadata`, path.join(dir, '_meta.json'));
    const version = typeof meta.version === 'string' ? meta.version.trim() : '';
    const updatedAt = typeof meta.updated_at === 'string' ? meta.updated_at.trim() : '';
    if (!SEMVER.test(version) || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
      throw new Error(`[builtin-resource-gate] invalid version/update metadata for builtin marketplace skill ${id}`);
    }
    if ('min_app_version' in meta && (
      typeof meta.min_app_version !== 'string' || !SEMVER.test(meta.min_app_version.trim())
    )) {
      throw new Error(`[builtin-resource-gate] invalid min_app_version for builtin marketplace skill ${id}`);
    }
    rows.push({ id, name: frontmatter.name, version, updated_at: updatedAt });
  }
  exactNames(
    'required builtin marketplace skill inventory',
    rows.map((row) => row.id),
    REQUIRED_BUILTIN_INVENTORY.marketplace_skills,
  );
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function embeddedSkillNames(agentId, agentDir) {
  const skillsRoot = path.join(agentDir, 'skills');
  if (!fs.existsSync(skillsRoot)) return [];
  requiredDirectory(`builtin agent ${agentId} skills root`, skillsRoot);
  const names = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (!entry.isDirectory()) {
      throw new Error(`[builtin-resource-gate] unexpected file in builtin agent ${agentId} skills root: ${entry.name}`);
    }
    if (entry.name === '_shared') continue;
    const frontmatter = skillFrontmatter(
      `builtin agent ${agentId} skill ${entry.name}`,
      path.join(skillsRoot, entry.name),
    );
    if (frontmatter.name !== entry.name) {
      throw new Error(
        `[builtin-resource-gate] builtin agent ${agentId} skill directory/name mismatch: ${entry.name} != ${frontmatter.name}`,
      );
    }
    names.push(entry.name);
  }
  return names.sort();
}

function invalidAgentContract(id, detail) {
  throw new Error(`[builtin-resource-gate] builtin marketplace agent ${id} ${detail}`);
}

function validateBuiltinAgentInput(id, input, index, seen) {
  const label = `input[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidAgentContract(id, `${label} must be an object`);
  }
  const inputId = typeof input.id === 'string' ? input.id.trim() : '';
  if (!INPUT_ID.test(inputId) || seen.has(inputId)) {
    invalidAgentContract(id, `${label} has an invalid or duplicate id`);
  }
  seen.add(inputId);
  if (typeof input.label !== 'string' || !input.label.trim()) {
    invalidAgentContract(id, `input ${inputId} needs a user-facing label`);
  }
  if (!INPUT_TYPES.has(input.type)) {
    invalidAgentContract(id, `input ${inputId} has unsupported type ${JSON.stringify(input.type)}`);
  }
  if (typeof input.required !== 'boolean') {
    invalidAgentContract(id, `input ${inputId} required must be boolean`);
  }
  for (const key of ['description', 'placeholder']) {
    if (key in input && (typeof input[key] !== 'string' || !input[key].trim())) {
      invalidAgentContract(id, `input ${inputId} ${key} must be a non-empty string when present`);
    }
  }

  let optionValues = null;
  if (input.type === 'select' || input.type === 'multiselect') {
    if (!Array.isArray(input.options) || input.options.length === 0) {
      invalidAgentContract(id, `input ${inputId} needs non-empty options`);
    }
    optionValues = new Set();
    for (const [optionIndex, option] of input.options.entries()) {
      const value = option && typeof option.value === 'string' ? option.value : '';
      const optionLabel = option && typeof option.label === 'string' ? option.label.trim() : '';
      if (!value || !optionLabel || optionValues.has(value)) {
        invalidAgentContract(id, `input ${inputId} option[${optionIndex}] has an invalid value, label, or duplicate`);
      }
      optionValues.add(value);
    }
  } else if ('options' in input) {
    invalidAgentContract(id, `input ${inputId} must not declare options for type ${input.type}`);
  }

  if (input.type === 'text' || input.type === 'textarea' || input.type === 'directory') {
    if (typeof input.default !== 'string') {
      invalidAgentContract(id, `input ${inputId} default must be a string`);
    }
    if (input.type === 'directory' && input.default !== '') {
      invalidAgentContract(id, `input ${inputId} directory default must be empty`);
    }
  } else if (input.type === 'number') {
    if (typeof input.default !== 'number' || !Number.isFinite(input.default)) {
      invalidAgentContract(id, `input ${inputId} default must be a finite number`);
    }
    for (const bound of ['min', 'max']) {
      if (bound in input && (typeof input[bound] !== 'number' || !Number.isFinite(input[bound]))) {
        invalidAgentContract(id, `input ${inputId} ${bound} must be a finite number`);
      }
    }
    if (typeof input.min === 'number' && typeof input.max === 'number' && input.min > input.max) {
      invalidAgentContract(id, `input ${inputId} min must not exceed max`);
    }
    if (typeof input.min === 'number' && input.default < input.min) {
      invalidAgentContract(id, `input ${inputId} default is below min`);
    }
    if (typeof input.max === 'number' && input.default > input.max) {
      invalidAgentContract(id, `input ${inputId} default is above max`);
    }
  } else if (input.type === 'boolean') {
    if (typeof input.default !== 'boolean') {
      invalidAgentContract(id, `input ${inputId} default must be boolean`);
    }
  } else if (input.type === 'select') {
    if (typeof input.default !== 'string' || !optionValues.has(input.default)) {
      invalidAgentContract(id, `input ${inputId} default must match an option`);
    }
  } else if (input.type === 'multiselect') {
    if (!Array.isArray(input.default) || input.default.some((value) => typeof value !== 'string' || !optionValues.has(value))) {
      invalidAgentContract(id, `input ${inputId} default must contain only declared option values`);
    }
    if (new Set(input.default).size !== input.default.length) {
      invalidAgentContract(id, `input ${inputId} default must not contain duplicates`);
    }
  } else if (input.type === 'file') {
    if ('multiple' in input && typeof input.multiple !== 'boolean') {
      invalidAgentContract(id, `input ${inputId} multiple must be boolean`);
    }
    const expectedDefault = input.multiple === true ? [] : '';
    if (Array.isArray(expectedDefault)) {
      if (!Array.isArray(input.default) || input.default.length !== 0) {
        invalidAgentContract(id, `input ${inputId} multiple-file default must be an empty array`);
      }
    } else if (input.default !== expectedDefault) {
      invalidAgentContract(id, `input ${inputId} file default must be empty`);
    }
    if ('accept' in input && (typeof input.accept !== 'string' || !input.accept.trim())) {
      invalidAgentContract(id, `input ${inputId} accept must be a non-empty string when present`);
    }
  }
  if (input.type !== 'number' && ('min' in input || 'max' in input)) {
    invalidAgentContract(id, `input ${inputId} must not declare numeric bounds for type ${input.type}`);
  }
  if (input.type !== 'file' && ('multiple' in input || 'accept' in input)) {
    invalidAgentContract(id, `input ${inputId} must not declare file options for type ${input.type}`);
  }

  if ('default_by_ui_language' in input) {
    if (input.type !== 'select' || !input.default_by_ui_language
      || typeof input.default_by_ui_language !== 'object'
      || Array.isArray(input.default_by_ui_language)) {
      invalidAgentContract(id, `input ${inputId} language defaults require a select input`);
    }
    const entries = Object.entries(input.default_by_ui_language);
    if (entries.length === 0) {
      invalidAgentContract(id, `input ${inputId} language defaults must not be empty`);
    }
    for (const [language, value] of entries) {
      if (!INPUT_UI_LANGUAGES.has(language) || typeof value !== 'string' || !optionValues.has(value)) {
        invalidAgentContract(id, `input ${inputId} has an invalid ${language} language default`);
      }
    }
  }
}

function validateBuiltinAgentContract(agent, id) {
  const textFields = ['name', 'description_zh', 'description_en', 'workflow'];
  for (const field of textFields) {
    if (typeof agent[field] !== 'string' || !agent[field].trim()) {
      invalidAgentContract(id, `requires non-empty ${field}`);
    }
  }
  if (typeof agent.version !== 'string' || !SEMVER.test(agent.version.trim())) {
    invalidAgentContract(id, 'version must be semantic x.y.z');
  }
  for (const field of ['created_at', 'updated_at']) {
    if (typeof agent[field] !== 'string' || !Number.isFinite(Date.parse(agent[field]))) {
      invalidAgentContract(id, `${field} must be an ISO-compatible date`);
    }
  }
  if (typeof agent.category !== 'string' || !CATEGORY_CODE.test(agent.category.trim())) {
    invalidAgentContract(id, 'category must be a safe marketplace category code');
  }
  if (typeof agent.interactive !== 'boolean') {
    invalidAgentContract(id, 'interactive must be boolean');
  }
  if (typeof agent.icon !== 'string' || !AVATAR_ICONS.has(agent.icon)) {
    invalidAgentContract(id, `icon must be a supported avatar token`);
  }
  if (typeof agent.color !== 'string' || !AVATAR_COLORS.has(agent.color)) {
    invalidAgentContract(id, `color must be a supported avatar token`);
  }
  if ('output_format' in agent && !OUTPUT_FORMATS.has(agent.output_format)) {
    invalidAgentContract(id, 'output_format must be auto, text, dashboard, or artifact');
  }
  if ('min_app_version' in agent && (
    typeof agent.min_app_version !== 'string' || !SEMVER.test(agent.min_app_version.trim())
  )) {
    invalidAgentContract(id, 'min_app_version must be semantic x.y.z when present');
  }
  if ('runtime' in agent) {
    const runtime = agent.runtime;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
      || !['in_process', 'cli'].includes(runtime.kind)
      || (runtime.kind === 'cli' && (typeof runtime.cli !== 'string' || !runtime.cli.trim()))) {
      invalidAgentContract(id, 'runtime must be a supported in_process or cli definition');
    }
  }
  if (!Array.isArray(agent.inputs) || agent.inputs.length === 0) {
    invalidAgentContract(id, 'inputs must contain at least one user-facing field');
  }
  const seen = new Set();
  agent.inputs.forEach((input, index) => validateBuiltinAgentInput(id, input, index, seen));
  if (!agent.inputs.some((input) => input.required === true)) {
    invalidAgentContract(id, 'inputs must contain at least one required field');
  }
  return true;
}

function marketplaceAgentInventory(root, standaloneSkills) {
  const agentsRoot = path.join(root, 'marketplace', 'agents');
  const standaloneRefs = new Set();
  for (const skill of standaloneSkills) {
    standaloneRefs.add(skill.id);
    standaloneRefs.add(skill.name);
  }
  const rows = [];
  for (const id of directoryNames('builtin marketplace agents root', agentsRoot)) {
    if (!MARKETPLACE_ID.test(id)) {
      throw new Error(`[builtin-resource-gate] invalid builtin marketplace agent id: ${id}`);
    }
    const dir = path.join(agentsRoot, id);
    const agent = readJson(`builtin marketplace agent ${id}`, path.join(dir, 'agent.json'));
    validateBuiltinAgentContract(agent, id);
    const name = typeof agent.name === 'string' ? agent.name.trim() : '';
    const version = typeof agent.version === 'string' ? agent.version.trim() : '';
    const icon = typeof agent.icon === 'string' ? agent.icon.trim() : '';
    const color = typeof agent.color === 'string' ? agent.color.trim() : '';
    const updatedAt = typeof agent.updated_at === 'string' ? agent.updated_at.trim() : '';
    if (agent.agent_id !== id || !name || !version || !icon || !color || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
      throw new Error(`[builtin-resource-gate] invalid id/name/version/icon/color/update metadata for builtin marketplace agent ${id}`);
    }
    if (!Array.isArray(agent.skill_list) || agent.skill_list.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`[builtin-resource-gate] builtin marketplace agent ${id} skill_list must be a string array`);
    }
    const skillList = agent.skill_list.map((item) => item.trim());
    if (new Set(skillList).size !== skillList.length) {
      throw new Error(`[builtin-resource-gate] builtin marketplace agent ${id} has duplicate skill_list entries`);
    }
    const embeddedSkills = embeddedSkillNames(id, dir);
    const embeddedSet = new Set(embeddedSkills);
    // Agent-private skills are owner-scoped runtime content and are discovered from the
    // embedded skills directory. They do not need to be duplicated in skill_list, which is
    // still validated below when an agent explicitly declares private or public references.
    for (const skill of skillList) {
      if (!embeddedSet.has(skill) && !standaloneRefs.has(skill)) {
        throw new Error(`[builtin-resource-gate] builtin marketplace agent ${id} references missing skill ${skill}`);
      }
    }
    rows.push({
      id,
      name,
      version,
      icon,
      color,
      updated_at: updatedAt,
      skill_list: [...skillList].sort(),
      embedded_skills: embeddedSkills,
    });
  }
  exactNames(
    'required builtin marketplace agent inventory',
    rows.map((row) => row.id),
    REQUIRED_BUILTIN_INVENTORY.marketplace_agents,
  );
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function createBuiltinManifest(root, options = {}) {
  root = path.resolve(root);
  const files = collectBuiltinFiles(root, options);
  const marketplaceSkills = standaloneSkillInventory(root);
  return {
    schema: BUILTIN_MANIFEST_SCHEMA,
    content_tree_sha256: contentTreeSha256(files),
    files,
    inventory: {
      system_skills: systemSkillInventory(root),
      marketplace_agents: marketplaceAgentInventory(root, marketplaceSkills),
      marketplace_skills: marketplaceSkills,
    },
  };
}

function verifyBuiltinRoot(root, options = {}) {
  root = path.resolve(root);
  const manifestFile = path.join(root, BUILTIN_MANIFEST_NAME);
  const actual = readJson('builtin content manifest', manifestFile);
  if (actual.schema !== BUILTIN_MANIFEST_SCHEMA) {
    throw new Error(`[builtin-resource-gate] unsupported builtin manifest schema: ${actual.schema}`);
  }
  const expected = createBuiltinManifest(root, options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    if (actual.content_tree_sha256 !== expected.content_tree_sha256) {
      throw new Error(
        `[builtin-resource-gate] builtin content tree mismatch: manifest=${actual.content_tree_sha256 || '(missing)'} actual=${expected.content_tree_sha256}`,
      );
    }
    throw new Error('[builtin-resource-gate] builtin semantic inventory does not match the packaged content');
  }
  return 'resource:builtin:manifest-v1';
}

function verifyBuiltinExtraResourcesConfig(extraResources) {
  if (!Array.isArray(extraResources)) {
    throw new Error('[builtin-resource-gate] build.extraResources must be an array');
  }
  const entries = extraResources.filter((entry) => entry && entry.to === 'builtin');
  if (entries.length !== 1) {
    throw new Error(`[builtin-resource-gate] expected exactly one builtin extraResources entry, found ${entries.length}`);
  }
  const entry = entries[0];
  if (slash(String(entry.from || '')) !== 'resources/builtin') {
    throw new Error(`[builtin-resource-gate] builtin extraResources source mismatch: ${entry.from || '(missing)'}`);
  }
  const filters = Array.isArray(entry.filter) ? entry.filter.map(String) : [];
  for (const required of BUILTIN_EXTRA_RESOURCE_FILTERS) {
    if (!filters.includes(required)) {
      throw new Error(`[builtin-resource-gate] builtin extraResources is missing filter ${required}`);
    }
  }
  return true;
}

function requiredBuiltinVerificationEntries() {
  return ['resource:builtin:manifest-v1'];
}

module.exports = {
  BUILTIN_EXTRA_RESOURCE_FILTERS,
  BUILTIN_MANIFEST_NAME,
  BUILTIN_MANIFEST_SCHEMA,
  REQUIRED_BUILTIN_INVENTORY,
  collectBuiltinFiles,
  contentTreeSha256,
  createBuiltinManifest,
  requiredBuiltinVerificationEntries,
  validateBuiltinAgentContract,
  verifyBuiltinExtraResourcesConfig,
  verifyBuiltinRoot,
};
