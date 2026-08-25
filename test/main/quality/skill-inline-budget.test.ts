import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INLINE_RESULT_TOKENS,
  estimateToolResultTokens,
} from '../../../src/main/util/tool-result-cap';
import { SKILL_DESCRIPTION_AUTHORING_MAX_CHARS } from '../../../src/main/util/skill-description-policy';
import {
  compactPromptDescription,
  resolveSkillAllowlistRefs,
} from '../../../src/main/model/core-agent/skill-registry';
import { SkillLoader } from '../../../src/core-agent/src/skills/loader';
import { pickDescription, type SkillSpec } from '../../../src/core-agent/src/skills/types';
import { validateSkillDir } from '../../../src/main/quality';

/**
 * A skill body the model cannot read in one tool result is not a skill.
 *
 * 2026-08-07, watching a live COMPOSE run: the model read `stage-compose`
 * (62,685 chars = 16,226 estimated tokens against a 12,500-token inline cap),
 * got a `<persisted-output>` stub back, and then keyword-searched its own
 * skill looking for the manifest schema. Any rule whose wording did not match
 * whatever it happened to search for was, in practice, invisible — and the
 * skill had been over the cap since the day it was written. Nothing failed.
 * The same thing had happened before to `skill-creator` and `agent-creator`,
 * and was fixed then by raising the cap rather than by noticing at authoring
 * time.
 *
 * Silent degradation is the whole problem: a spilled skill still "works",
 * just worse, in a way no test and no log line reports. This test converts it
 * into a build failure. Conditional depth belongs in `references/`, which is
 * read only when it applies.
 */

const BUILTIN_ROOT = path.join(__dirname, '..', '..', '..', 'resources', 'builtin');
const VIDEO_STUDIO_RESIDENT_SKILL_HEADROOM = 500;
const CREATOR_ROOT_MAX_CHARS = 7_500;
// These are ceilings for documented, actually loaded paths. Never add every
// optional reference in a Skill directory together and treat that sum as one
// prompt: references exist specifically so unrelated branches stay unloaded.
const CREATOR_ROUTE_MAX_CHARS = 20_000;
const SHARED_ROOT_MAX_CHARS = 20_000;
const SHARED_ROUTE_MAX_CHARS = 40_000;
const AGENT_PRIVATE_ROUTE_MAX_CHARS = 60_000;
const VIDEO_MULTI_STAGE_ROUTE_MAX_CHARS = 80_000;
const SHIPPED_ROSTER_BUDGET = { zh: 3_000, en: 5_000 } as const;

interface BuiltinSkillGroup {
  label: string;
  kind: 'system' | 'shared' | 'agent';
  root: string;
  agentId?: string;
  specs: SkillSpec[];
}

/** What `read_file` actually hands the model: numbered lines inside a `<file>`
 *  envelope. Measuring the raw body would under-count by ~3% and let a skill
 *  sit just under the line while the real result is over it. */
function asReadFileResult(body: string, label: string): string {
  const lines = body.split('\n');
  return `<file path="${label}" kind="text" total_chars="${body.length}" `
    + `covered="0-${body.length}" lines="1-${lines.length}" `
    + `file_hash="sha256:${'0'.repeat(64)}">\n`
    + lines.map((line, index) => `${index + 1}\t${line}`).join('\n')
    + '\n</file>';
}

function collectSkillDocs(): Array<{ label: string; body: string }> {
  const docs: Array<{ label: string; body: string }> = [];
  const walk = (dir: string, insideSkillReferences = false): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A references/ tree belongs to a skill only when its parent owns a
        // SKILL.md. Carry the state recursively so nested reference documents
        // cannot silently escape this corpus scan.
        const entersSkillReferences = insideSkillReferences
          || (entry.name === 'references' && fs.existsSync(path.join(dir, 'SKILL.md')));
        walk(abs, entersSkillReferences);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      // SKILL.md is read on every use; a `references/` file is read only when
      // its condition applies, but it is still one read_file result and still
      // spills the same way, so both are held to the budget.
      const isSkillBody = entry.name === 'SKILL.md';
      const isReference = insideSkillReferences;
      if (!isSkillBody && !isReference) continue;
      docs.push({
        label: path.relative(BUILTIN_ROOT, abs),
        body: fs.readFileSync(abs, 'utf8'),
      });
    }
  };
  walk(BUILTIN_ROOT);
  return docs;
}

function collectBuiltinSkillGroups(): BuiltinSkillGroup[] {
  const groups: BuiltinSkillGroup[] = [
    {
      label: 'system',
      kind: 'system',
      root: path.join(BUILTIN_ROOT, 'system', 'skills'),
      specs: [],
    },
    {
      label: 'commander-shared',
      kind: 'shared',
      root: path.join(BUILTIN_ROOT, 'marketplace', 'skills'),
      specs: [],
    },
  ];
  const agentsRoot = path.join(BUILTIN_ROOT, 'marketplace', 'agents');
  for (const agent of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const agentFile = path.join(agentsRoot, agent.name, 'agent.json');
    if (!fs.existsSync(agentFile)) continue;
    const agentJson = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    groups.push({
      label: `agent:${String(agentJson.name || agent.name)}`,
      kind: 'agent',
      root: path.join(agentsRoot, agent.name, 'skills'),
      agentId: agent.name,
      specs: [],
    });
  }
  // Load each root independently so same-id private Skills owned by different
  // Agents cannot hide one another through loader de-duplication.
  return groups.map((group) => ({
    ...group,
    specs: new SkillLoader({ dirs: [group.root] }).list(),
  }));
}

function immediateSkillCount(root: string): number {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .length;
}

function platformDescriptionShapeFindings(content: string): string[] {
  const end = content.startsWith('---') ? content.indexOf('---', 3) : -1;
  const frontmatter = end >= 0 ? content.slice(3, end) : '';
  const has = (field: string): boolean => new RegExp(`^${field}:\\s*\\S`, 'm').test(frontmatter);
  const findings: string[] = [];
  if (has('description')) findings.push('generic_description_present');
  if (!has('description_zh')) findings.push('description_zh_missing');
  if (!has('description_en')) findings.push('description_en_missing');
  return findings;
}

function frontmatterKeys(content: string): string[] {
  const end = content.startsWith('---') ? content.indexOf('---', 3) : -1;
  if (end < 0) return [];
  return content.slice(3, end).split('\n').flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/);
    return match ? [match[1]] : [];
  }).sort();
}

function topLevelReferenceNavigationFindings(skillDir: string): string[] {
  const referencesDir = path.join(skillDir, 'references');
  if (!fs.existsSync(referencesDir)) return [];
  const root = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  return fs.readdirSync(referencesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .filter((entry) => !root.includes(`](references/${entry.name})`))
    .map((entry) => entry.name);
}

function renderRoutingRoster(specs: SkillSpec[], lang: 'zh' | 'en'): string {
  return specs.map((spec) => {
    const description = compactPromptDescription(pickDescription(spec, lang));
    return `- **${spec.name}** (Source: builtin; read ref: @skill/${spec.name}) — ${description}`;
  }).join('\n');
}

function progressiveDisclosureFindings(skillDir: string, rootMaxChars: number): string[] {
  const rootFile = path.join(skillDir, 'SKILL.md');
  const body = fs.readFileSync(rootFile, 'utf8');
  const findings: string[] = [];
  if (body.length > rootMaxChars) findings.push(`root:${body.length}>${rootMaxChars}`);
  const linked = Array.from(body.matchAll(/\]\(references\/([^)]+\.md)\)/g), (match) => match[1]);
  if (!linked.length) findings.push('no_linked_references');
  for (const relative of linked) {
    if (!fs.existsSync(path.join(skillDir, 'references', relative))) {
      findings.push(`missing_reference:${relative}`);
    }
  }
  return findings;
}

function creatorRouteChars(skillDir: string, references: readonly string[]): number {
  return ['SKILL.md', ...references.map((name) => path.join('references', name))]
    .reduce((sum, relative) => (
      sum + fs.readFileSync(path.join(skillDir, relative), 'utf8').length
    ), 0);
}

function fileSetChars(files: readonly string[]): number {
  return files.reduce((sum, file) => sum + fs.readFileSync(file, 'utf8').length, 0);
}

function effectiveAgentRoster(
  group: BuiltinSkillGroup,
  sharedSpecs: SkillSpec[],
): { specs: SkillSpec[]; unknown: string[] } {
  const agentFile = path.join(
    BUILTIN_ROOT,
    'marketplace',
    'agents',
    group.agentId || '',
    'agent.json',
  );
  const agentJson = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
  const refs = Array.isArray(agentJson.skill_list) ? agentJson.skill_list : [];
  const available = [...sharedSpecs, ...group.specs];
  const resolved = resolveSkillAllowlistRefs(available, refs);
  const byId = new Map(available.map((spec) => [spec.id, spec]));
  const roster = resolved.ids.map((id) => byId.get(id)).filter((spec): spec is SkillSpec => !!spec);
  const seen = new Set(roster.map((spec) => spec.id));
  // Runtime appends every author-owned private Skill even if an older agent.json
  // forgot to list one. Model that fail-safe so the budget covers what is
  // actually injected, not only the metadata happy path.
  for (const spec of group.specs) {
    if (seen.has(spec.id)) continue;
    seen.add(spec.id);
    roster.push(spec);
  }
  return { specs: roster, unknown: resolved.unknown };
}

describe('builtin skill inline budget', () => {
  const docs = collectSkillDocs();
  const groups = collectBuiltinSkillGroups();
  const specs = groups.flatMap((group) => group.specs);

  it('finds the builtin skill corpus', () => {
    // A silent zero here would make every assertion below vacuously true.
    expect(docs.length).toBeGreaterThan(40);
    expect(docs.some((doc) => doc.label.endsWith('SKILL.md'))).toBe(true);
    expect(docs.some((doc) => /[\\/]references[\\/].+[\\/].+\.md$/.test(doc.label))).toBe(true);
    expect(specs.length).toBeGreaterThan(40);
    for (const group of groups) {
      expect(
        group.specs.length,
        `${group.label} loader inventory must match immediate SKILL.md directories`,
      ).toBe(immediateSkillCount(group.root));
    }
  });

  it('keeps every shipped platform Skill on one bilingual description source', () => {
    const findings = specs.flatMap((spec) => {
      const content = fs.readFileSync(spec.skillFile, 'utf8');
      const shape = platformDescriptionShapeFindings(content)
        .map((finding) => `${path.relative(BUILTIN_ROOT, spec.skillFile)}:${finding}`);
      const sidecarFile = path.join(spec.dir, '_meta.json');
      if (!fs.existsSync(sidecarFile)) return shape;
      const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
      const duplicated = sidecar.descriptions || sidecar.description_zh || sidecar.description_en
        ? [`${path.relative(BUILTIN_ROOT, sidecarFile)}:duplicate_description_source`]
        : [];
      return [...shape, ...duplicated];
    });

    expect(findings).toEqual([]);
    expect(platformDescriptionShapeFindings([
      '---',
      'name: broken',
      'description: duplicate',
      'description_zh: 中文',
      'description_en: English',
      '---',
    ].join('\n'))).toContain('generic_description_present');
  });

  it('keeps official metadata with its lifecycle owner', () => {
    const findings = groups.flatMap((group) => group.specs.flatMap((spec) => {
      const content = fs.readFileSync(spec.skillFile, 'utf8');
      const requiredKeys = group.kind === 'agent'
        ? ['description_en', 'description_zh', 'name', 'ownerAgent']
        : ['description_en', 'description_zh', 'name'];
      const allowedKeys = group.kind === 'system'
        ? [...requiredKeys, 'category']
        : requiredKeys;
      const source = group.kind === 'system'
        ? 'system' as const
        : group.kind === 'agent'
          ? 'agent-private' as const
          : 'marketplace' as const;
      const report = validateSkillDir(spec.dir, { source });
      const localFindings: string[] = [];
      const actualKeys = frontmatterKeys(content);
      const missingKeys = requiredKeys.filter((key) => !actualKeys.includes(key));
      const unexpectedKeys = actualKeys.filter((key) => !allowedKeys.includes(key));
      if (missingKeys.length || unexpectedKeys.length) {
        localFindings.push(
          `frontmatter:missing=${missingKeys.join(',')};unexpected=${unexpectedKeys.join(',')}`,
        );
      }
      if (group.kind === 'shared') {
        const sidecarFile = path.join(spec.dir, '_meta.json');
        if (!fs.existsSync(sidecarFile)) {
          localFindings.push('standalone_meta_missing');
        } else {
          const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
          for (const field of ['version', 'updated_at', 'category']) {
            if (typeof sidecar[field] !== 'string' || !sidecar[field].trim()) {
              localFindings.push(`standalone_meta_${field}_missing`);
            }
          }
        }
      }
      localFindings.push(...report.violations.map((violation) => (
        `validator:${violation.level}:${violation.rule}:${violation.field}`
      )));
      return localFindings.map((finding) => (
        `${path.relative(BUILTIN_ROOT, spec.skillFile)}:${finding}`
      ));
    }));

    expect(
      findings,
      'standalone Skills own sidecar metadata; system and private Skills inherit lifecycle metadata',
    ).toEqual([]);
  });

  it('links every top-level conditional reference from its Skill root', () => {
    const findings = specs.flatMap((spec) => (
      topLevelReferenceNavigationFindings(spec.dir).map((reference) => (
        `${path.relative(BUILTIN_ROOT, spec.skillFile)}:${reference}`
      ))
    ));
    expect(
      findings,
      'a bare path is not a reliable read route; link each optional top-level reference at its condition',
    ).toEqual([]);

    expect('Read `references/example.md` when needed.')
      .not.toContain('](references/example.md)');
  });

  it('keeps every independently read skill document within one tool result', () => {
    const oversized = docs
      .map((doc) => ({
        label: doc.label,
        tokens: estimateToolResultTokens(asReadFileResult(doc.body, doc.label)),
      }))
      .filter((doc) => doc.tokens > DEFAULT_INLINE_RESULT_TOKENS)
      .map((doc) => `${doc.label}: ~${doc.tokens} tokens (budget ${DEFAULT_INLINE_RESULT_TOKENS})`);

    expect(
      oversized,
      'these skills spill to disk instead of being read; move conditional depth into references/',
    ).toEqual([]);
  });

  it('keeps always-read creator roots small and routes conditional depth explicitly', () => {
    const creatorDirs = ['agent-creator', 'skill-creator'].map((id) => (
      path.join(BUILTIN_ROOT, 'system', 'skills', id)
    ));
    const findings = creatorDirs.flatMap((dir) => (
      progressiveDisclosureFindings(dir, CREATOR_ROOT_MAX_CHARS)
        .map((finding) => `${path.basename(dir)}:${finding}`)
    ));

    expect(findings, 'editor turns should pay only for a concise root plus the matching reference')
      .toEqual([]);

    const agentRoot = fs.readFileSync(path.join(creatorDirs[0], 'SKILL.md'), 'utf8');
    const skillRoot = fs.readFileSync(path.join(creatorDirs[1], 'SKILL.md'), 'utf8');
    expect(agentRoot).toContain('A simple bound edit normally needs only `llm-agent-fields.md`');
    expect(skillRoot).toContain('A category-only edit needs only `metadata.md`');
    expect(skillRoot).toContain('an import needs `importing.md` plus `metadata.md`');

    const negativeDir = path.join(BUILTIN_ROOT, 'system', 'skills', 'agent-creator');
    const negativeRoot = path.join(negativeDir, 'SKILL.md');
    const original = fs.readFileSync(negativeRoot, 'utf8');
    const broken = original.replace(
      'references/llm-agent-fields.md',
      'references/missing-contract.md',
    );
    const linked = Array.from(broken.matchAll(/\]\(references\/([^)]+\.md)\)/g), (match) => match[1]);
    expect(linked.some((relative) => !fs.existsSync(path.join(negativeDir, 'references', relative))))
      .toBe(true);
  });

  it('keeps each creator journey within one bounded progressive-disclosure load set', () => {
    const agentDir = path.join(BUILTIN_ROOT, 'system', 'skills', 'agent-creator');
    const skillDir = path.join(BUILTIN_ROOT, 'system', 'skills', 'skill-creator');
    const routes = [
      { label: 'agent:bound-llm-edit', dir: agentDir, refs: ['llm-agent-fields.md'] },
      {
        label: 'agent:conversation-crystallization',
        dir: agentDir,
        refs: ['llm-agent-fields.md', 'source-and-editing.md'],
      },
      { label: 'agent:cli-backed-edit', dir: agentDir, refs: ['cli-and-prose.md'] },
      { label: 'skill:category-edit', dir: skillDir, refs: ['metadata.md'] },
      { label: 'skill:body-edit', dir: skillDir, refs: ['authoring.md'] },
      {
        label: 'skill:scratch-create',
        dir: skillDir,
        refs: ['authoring.md', 'metadata.md'],
      },
      {
        label: 'skill:source-import',
        dir: skillDir,
        refs: ['importing.md', 'metadata.md'],
      },
      { label: 'skill:file-delete', dir: skillDir, refs: ['file-deletion.md'] },
    ] as const;
    const overBudget = routes.flatMap((route) => {
      const chars = creatorRouteChars(route.dir, route.refs);
      return chars <= CREATOR_ROUTE_MAX_CHARS
        ? []
        : [`${route.label}:${chars}>${CREATOR_ROUTE_MAX_CHARS}`];
    });

    expect(
      overBudget,
      'a normal creator turn must fit without eagerly loading unrelated references',
    ).toEqual([]);
  });

  it('keeps official shared Skill roots concise and representative journeys bounded', () => {
    const shared = groups.find((group) => group.kind === 'shared');
    expect(shared, 'shared marketplace Skill root must be scanned').toBeDefined();
    const oversizedRoots = shared!.specs
      .filter((spec) => fs.readFileSync(spec.skillFile, 'utf8').length > SHARED_ROOT_MAX_CHARS)
      .map((spec) => `${spec.id}:${fs.readFileSync(spec.skillFile, 'utf8').length}`);
    expect(
      oversizedRoots,
      'shared roots are routing/execution spines; conditional paths belong in direct references',
    ).toEqual([]);

    const deepDir = path.join(BUILTIN_ROOT, 'marketplace', 'skills', 'ee99fbb42964');
    const deepRoutes = [
      { label: 'normal-research', refs: ['operations-and-report.md', 'research-workflow.md'] },
      { label: 'compact-landscape', refs: ['compact-landscape.md', 'operations-and-report.md'] },
      { label: 'durable-resume', refs: ['resume-and-ledgers.md', 'operations-and-report.md'] },
      { label: 'academic-evidence', refs: ['operations-and-report.md', 'scholarly-evidence.md'] },
    ];
    const overBudget = deepRoutes.flatMap((route) => {
      const chars = creatorRouteChars(deepDir, route.refs);
      return chars <= SHARED_ROUTE_MAX_CHARS
        ? []
        : [`deep-research:${route.label}:${chars}>${SHARED_ROUTE_MAX_CHARS}`];
    });
    expect(overBudget, 'one shared-Skill journey should not preload unrelated branches').toEqual([]);
  });

  it('keeps optional deep-research workflow guidance subordinate to the bounded root path', () => {
    const deepDir = path.join(BUILTIN_ROOT, 'marketplace', 'skills', 'ee99fbb42964');
    const root = fs.readFileSync(path.join(deepDir, 'SKILL.md'), 'utf8');
    const workflow = fs.readFileSync(
      path.join(deepDir, 'references', 'research-workflow.md'),
      'utf8',
    );

    expect(root).toMatch(/`caps` values are ceilings, not collection targets/i);
    expect(root).toMatch(/Stop early when evidence is\s+sufficient/i);
    expect(workflow).toMatch(/does not replace the path selected in\s+the root Skill/i);
    expect(workflow).toMatch(/stop when evidence is\s+sufficient/i);
    expect(workflow).toMatch(/format and depth the user\s+requested/i);
    expect(workflow).not.toMatch(/for every deep-research request/i);
    expect(workflow).not.toMatch(/at least two cycles per theme/i);
    expect(workflow).not.toMatch(/final report must include[\s\S]*APA 7 references/i);
  });

  it('keeps VideoStudio private roots routed and real journeys below explicit budgets', () => {
    const videoDir = path.join(BUILTIN_ROOT, 'marketplace', 'agents', '79df9cc89f5f', 'skills');
    const gateDir = path.join(videoDir, 'gate-control');
    const composeDir = path.join(videoDir, 'stage-compose');
    const editDir = path.join(videoDir, 'stage-edit');
    const disclosureFindings = [gateDir, composeDir, editDir].flatMap((dir) => (
      progressiveDisclosureFindings(dir, SHARED_ROOT_MAX_CHARS)
        .map((finding) => `${path.basename(dir)}:${finding}`)
    ));
    expect(disclosureFindings, 'large private roots must link their conditional references directly')
      .toEqual([]);

    const privateRoutes = [
      { label: 'gate:confirmation', dir: gateDir, refs: ['confirmation-artifacts.md'] },
      { label: 'gate:revision', dir: gateDir, refs: ['revision-and-recovery.md'] },
      {
        label: 'gate:auto-preview-revision',
        dir: gateDir,
        refs: ['confirmation-artifacts.md', 'assembled-productions.md', 'revision-and-recovery.md'],
      },
      { label: 'compose:author', dir: composeDir, refs: ['manifest-and-authoring.md'] },
      {
        label: 'compose:preview',
        dir: composeDir,
        refs: ['manifest-and-authoring.md', 'render-and-preview.md'],
      },
      { label: 'compose:failure', dir: composeDir, refs: ['qa-and-repair.md'] },
      { label: 'compose:narration', dir: composeDir, refs: ['narration.md'] },
      { label: 'compose:no-runtime', dir: composeDir, refs: ['no-runtime-package.md'] },
      {
        label: 'edit:transcript-or-screen-grounded',
        dir: editDir,
        refs: ['transcript-and-screen-grounded-editing.md'],
      },
    ];
    const overPrivateBudget = privateRoutes.flatMap((route) => {
      const chars = creatorRouteChars(route.dir, route.refs);
      return chars <= AGENT_PRIVATE_ROUTE_MAX_CHARS
        ? []
        : [`${route.label}:${chars}>${AGENT_PRIVATE_ROUTE_MAX_CHARS}`];
    });
    expect(overPrivateBudget, 'a private-Skill route must fit without unrelated references')
      .toEqual([]);

    const editRoot = fs.readFileSync(path.join(editDir, 'SKILL.md'), 'utf8');
    expect(editRoot).toContain('Ordinary known-timecode trim');
    expect(editRoot).toContain('do not load this branch');

    const journeys = [
      {
        label: 'compose:direction-to-preview',
        files: [
          path.join(gateDir, 'SKILL.md'),
          path.join(gateDir, 'references', 'confirmation-artifacts.md'),
          path.join(composeDir, 'SKILL.md'),
          path.join(composeDir, 'references', 'manifest-and-authoring.md'),
          path.join(composeDir, 'references', 'render-and-preview.md'),
        ],
      },
      {
        label: 'compose:failed-preview-recovery',
        files: [
          path.join(gateDir, 'SKILL.md'),
          path.join(gateDir, 'references', 'revision-and-recovery.md'),
          path.join(composeDir, 'SKILL.md'),
          path.join(composeDir, 'references', 'qa-and-repair.md'),
          path.join(composeDir, 'references', 'render-and-preview.md'),
        ],
      },
      {
        label: 'compose:narration-retry',
        files: [
          path.join(gateDir, 'SKILL.md'),
          path.join(gateDir, 'references', 'confirmation-artifacts.md'),
          path.join(gateDir, 'references', 'narration-recovery.md'),
          path.join(composeDir, 'SKILL.md'),
          path.join(composeDir, 'references', 'narration.md'),
        ],
      },
    ];
    const overJourneyBudget = journeys.flatMap((journey) => {
      const chars = fileSetChars(journey.files);
      return chars <= VIDEO_MULTI_STAGE_ROUTE_MAX_CHARS
        ? []
        : [`${journey.label}:${chars}>${VIDEO_MULTI_STAGE_ROUTE_MAX_CHARS}`];
    });
    expect(overJourneyBudget, 'VideoStudio may be multi-stage, but one real journey is still bounded')
      .toEqual([]);
  });

  it('keeps every shipped routing description within the authoring target', () => {
    const descriptions = groups.flatMap((group) => group.specs.flatMap((spec) => [
      [group.label, spec.id, 'zh', pickDescription(spec, 'zh')],
      [group.label, spec.id, 'en', pickDescription(spec, 'en')],
    ] as const));
    const oversized = descriptions
      .filter(([, , , description]) => description.length > SKILL_DESCRIPTION_AUTHORING_MAX_CHARS)
      .map(([group, id, lang, description]) => `${group}:${id}:${lang}:${description.length}`);
    const keywordLists = descriptions
      .filter(([, , , description]) => /(?:触发词|Triggers:)/i.test(description))
      .map(([group, id, lang]) => `${group}:${id}:${lang}`);

    expect(
      oversized,
      `shipped descriptions stay at or below ${SKILL_DESCRIPTION_AUTHORING_MAX_CHARS} characters; move execution detail into SKILL.md`,
    ).toEqual([]);
    expect(
      keywordLists,
      'write natural routing intent instead of a separate trigger-keyword list',
    ).toEqual([]);
  });

  it('ships descriptions that reach the prompt unchanged rather than silently losing routing clauses', () => {
    const changed = groups.flatMap((group) => group.specs.flatMap((spec) => (
      ['zh', 'en'] as const
    ).flatMap((lang) => {
      const authored = pickDescription(spec, lang);
      const rendered = compactPromptDescription(authored);
      return rendered === authored
        ? []
        : [`${group.label}:${spec.id}:${lang}:${authored.length}->${rendered.length}`];
    })));

    expect(
      changed,
      'shipped routing descriptions must fit without runtime truncation or semantic rewriting',
    ).toEqual([]);
  });

  it('keeps each shipped runtime roster within its context budget', () => {
    const shared = groups.find((group) => group.kind === 'shared');
    const system = groups.find((group) => group.kind === 'system');
    expect(shared, 'shared marketplace Skill root must be scanned').toBeDefined();
    expect(system, 'system Skill root must be scanned').toBeDefined();

    const rosters: Array<{ label: string; specs: SkillSpec[] }> = [
      { label: system!.label, specs: system!.specs },
      { label: shared!.label, specs: shared!.specs },
    ];
    const unresolved: string[] = [];
    for (const group of groups.filter((candidate) => candidate.kind === 'agent')) {
      const roster = effectiveAgentRoster(group, shared!.specs);
      rosters.push({ label: group.label, specs: roster.specs });
      unresolved.push(...roster.unknown.map((ref) => `${group.label}:${ref}`));
    }

    expect(unresolved, 'every official Agent skill_list entry must resolve into its real runtime roster')
      .toEqual([]);
    const overBudget = rosters.flatMap((roster) => (
      ['zh', 'en'] as const
    ).flatMap((lang) => {
      const chars = renderRoutingRoster(roster.specs, lang).length;
      return chars <= SHIPPED_ROSTER_BUDGET[lang]
        ? []
        : [`${roster.label}:${lang}:${chars}>${SHIPPED_ROSTER_BUDGET[lang]}`];
    }));

    expect(
      overBudget,
      'shipped routing indexes must leave prompt headroom for task context and user-installed Skills',
    ).toEqual([]);
  });

  it('keeps headroom in the two VideoStudio resident skills that previously touched the cap', () => {
    const targets = [
      'marketplace/agents/79df9cc89f5f/skills/stage-compose/SKILL.md',
      'marketplace/agents/79df9cc89f5f/skills/gate-control/SKILL.md',
    ];
    const measured = new Map(docs.map((doc) => [
      doc.label.split(path.sep).join('/'),
      estimateToolResultTokens(asReadFileResult(doc.body, doc.label)),
    ]));

    for (const target of targets) {
      expect(measured.has(target), `${target} must remain in the scanned corpus`).toBe(true);
      expect(
        measured.get(target),
        `${target} must retain at least ${VIDEO_STUDIO_RESIDENT_SKILL_HEADROOM} inline-result tokens of headroom`,
      ).toBeLessThanOrEqual(DEFAULT_INLINE_RESULT_TOKENS - VIDEO_STUDIO_RESIDENT_SKILL_HEADROOM);
    }
  });

  it('reports how close the largest skills sit to the budget', () => {
    // Not a failure condition — a visible ranking so the next person adding a
    // paragraph knows which files have no room left. The three names below
    // were all within ~500 tokens of the cap when this was written.
    const ranked = docs
      .map((doc) => ({
        label: doc.label,
        tokens: estimateToolResultTokens(asReadFileResult(doc.body, doc.label)),
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);

    expect(ranked[0].tokens).toBeGreaterThan(0);
    for (const doc of ranked) {
      expect(doc.tokens, `${doc.label} is over budget`).toBeLessThanOrEqual(DEFAULT_INLINE_RESULT_TOKENS);
    }
  });
});
