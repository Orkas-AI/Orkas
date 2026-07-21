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
const REQUIRED_BUILTIN_INVENTORY = Object.freeze({
  system_skills: Object.freeze([
    'agent-creator',
    'autotask-creator',
    'coding',
    'package-installer',
    'skill-creator',
  ]),
  marketplace_agents: Object.freeze([
    '78900d8758bc',
    '79df9cc89f5f',
    'bcfcb4921dce',
    'e064dca9e1bd',
  ]),
  marketplace_skills: Object.freeze([
    '6743aa0797a2',
    '9be6fda271a5',
    'e7f5c0e6f1be',
    'ee99fbb42964',
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
    if (!version || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
      throw new Error(`[builtin-resource-gate] invalid version/update metadata for builtin marketplace skill ${id}`);
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
    const name = typeof agent.name === 'string' ? agent.name.trim() : '';
    const version = typeof agent.version === 'string' ? agent.version.trim() : '';
    if (agent.agent_id !== id || !name || !version) {
      throw new Error(`[builtin-resource-gate] invalid id/name/version for builtin marketplace agent ${id}`);
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
    rows.push({ id, name, version, skill_list: [...skillList].sort(), embedded_skills: embeddedSkills });
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
  verifyBuiltinExtraResourcesConfig,
  verifyBuiltinRoot,
};
