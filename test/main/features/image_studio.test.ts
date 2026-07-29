import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertImageQualityVerdict,
  compileImageQualityScorecard,
  inspectImageStudioProject,
  validateImageStudioManifest,
} from '../../../src/main/features/image_studio';

let root = '';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    route: 'compose',
    canvas: { width: 1200, height: 1200 },
    brief: {
      purpose: 'Launch poster',
      audience: 'Product teams',
      required_copy: ['Orkas Studio'],
      must_include: ['product mark'],
      must_avoid: ['generic dashboard cards'],
    },
    art_direction: {
      subject_world: 'A tactile editorial launch desk',
      one_job: 'Announce the new visual studio',
      visual_tradition: 'Swiss editorial poster with material collage',
      composition: 'Large title on the left with one asymmetric focal object',
      signature_device: 'A folded violet paper aperture',
      typography: 'Wide grotesk title and compact humanist details',
      color_light_material: 'Ink black, paper white, violet foil, hard side light',
    },
    generation_budget: { max_calls: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-studio-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ImageStudio project contract', () => {
  it('compiles an evidence scorecard and enforces reference-specific scoring', () => {
    const scorecard = compileImageQualityScorecard({
      intent_alignment: 92,
      composition: 86,
      craft: 84,
      text_legibility: 95,
      defect_freedom: 88,
      specificity: 83,
    });
    expect(scorecard).toMatchObject({ overall: 88, pass_threshold: 80, dimension_floor: 70 });
    expect(() => compileImageQualityScorecard({
      intent_alignment: 92,
      composition: 86,
      craft: 84,
      text_legibility: 95,
      defect_freedom: 88,
      specificity: 83,
    }, true)).toThrow('reference_fidelity');

    expect(() => assertImageQualityVerdict('passed', [], compileImageQualityScorecard({
      intent_alignment: 95,
      composition: 95,
      craft: 95,
      text_legibility: 95,
      defect_freedom: 95,
      specificity: 55,
    }))).toThrow('E_IMAGE_REVIEW_SCORE_BELOW_FLOOR');
    expect(() => assertImageQualityVerdict('passed', ['fix: title is too small'], scorecard)).toThrow('E_IMAGE_REVIEW_PASS_FINDINGS');
    expect(() => assertImageQualityVerdict('passed', [], scorecard)).not.toThrow();
    expect(() => assertImageQualityVerdict('passed', [], scorecard, 70, [{
      code: 'A_ENGLISH_ALL_CAPS_OVERUSE',
      message: 'Multiple English text roles use all caps.',
    }])).toThrow('E_IMAGE_REVIEW_ENGLISH_CASING_REQUIRED');
  });

  it('locks route-specific generation budgets', () => {
    expect(validateImageStudioManifest(manifest()).issues).toEqual([]);
    expect(validateImageStudioManifest(manifest({ generation_budget: { max_calls: 1 } })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_COMPOSE_GENERATION_BUDGET' })]));
    expect(validateImageStudioManifest(manifest({ route: 'hybrid', generation_budget: { max_calls: 2 } })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_HYBRID_GENERATION_BUDGET' })]));
  });

  it('defaults an unspecified reference to guide and lets explicit user intent override that default', () => {
    const editSource = {
      id: 'source',
      path: 'assets/source.png',
      role: 'edit_source',
      strength: 1,
      required: true,
      preserve: ['subject identity', 'background geometry'],
      may_change: ['headline copy'],
      region_ids: [],
    };
    const defaulted = validateImageStudioManifest(manifest({
      references: [{
        ...editSource,
        role: 'style',
        required: false,
      }],
    }));
    expect(defaulted.issues).toEqual([]);
    expect(defaulted.manifest?.reference_intent).toEqual({
      mode: 'guide',
      basis: 'inferred',
      instructions: [],
      minimum_score: 70,
    });

    const editable = validateImageStudioManifest(manifest({
      route: 'edit',
      generation_budget: { max_calls: 1 },
      references: [editSource],
      reference_intent: {
        mode: 'edit',
        basis: 'user',
        instructions: ['Replace only the headline copy.'],
        minimum_score: 88,
      },
    }));
    expect(editable.issues).toEqual([]);
    expect(editable.manifest?.reference_intent).toMatchObject({ mode: 'edit', basis: 'user' });

    const unboundedInferredEdit = validateImageStudioManifest(manifest({
      route: 'edit',
      generation_budget: { max_calls: 1 },
      references: [editSource],
    }));
    expect(unboundedInferredEdit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E_MANIFEST_EDIT_INSTRUCTIONS' }),
    ]));

    const weakReproduction = validateImageStudioManifest(manifest({
      references: [{ ...editSource, role: 'composition', may_change: [] }],
      reference_intent: { mode: 'reproduce', basis: 'user', instructions: [], minimum_score: 80 },
    }));
    expect(weakReproduction.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E_MANIFEST_REPRODUCE_SCORE_FLOOR' }),
    ]));

    const invalidBasis = validateImageStudioManifest(manifest({
      references: [{ ...editSource, role: 'style', required: false }],
      reference_intent: { mode: 'guide', basis: 'file-origin', instructions: [], minimum_score: 70 },
    }));
    expect(invalidBasis.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'E_MANIFEST_REFERENCE_INTENT_BASIS' }),
    ]));
  });

  it('enforces the reference score declared by edit or reproduction intent', () => {
    const scorecard = compileImageQualityScorecard({
      intent_alignment: 92,
      composition: 90,
      craft: 88,
      text_legibility: 94,
      defect_freedom: 91,
      specificity: 86,
      reference_fidelity: 84,
    }, true);
    expect(() => assertImageQualityVerdict('passed', [], scorecard, 85))
      .toThrow('E_IMAGE_REFERENCE_FIDELITY_BELOW_FLOOR');
    expect(() => assertImageQualityVerdict('passed', [], { ...scorecard, reference_fidelity: 90 }, 85))
      .not.toThrow();
  });

  it('inspects local HTML, exact copy, and local resources into one signature', async () => {
    fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(manifest(), null, 2));
    fs.writeFileSync(path.join(root, 'texture.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<!doctype html><html><body>',
      '<main><h1>Orkas Studio</h1><svg aria-hidden="true"></svg>',
      '<img src="texture.svg" alt="">',
      '</main></body></html>',
    ].join(''));

    const first = await inspectImageStudioProject(root);
    expect(first.ok).toBe(true);
    expect(first.resources).toEqual(['texture.svg']);
    expect(first.signature).toMatch(/^[0-9a-f]{64}$/);

    fs.appendFileSync(path.join(root, 'texture.svg'), '\n<!-- changed -->');
    const changed = await inspectImageStudioProject(root);
    expect(changed.ok).toBe(true);
    expect(changed.signature).not.toBe(first.signature);
  });

  it('flags repeated model-authored English all caps but permits exact required copy', async () => {
    fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(manifest(), null, 2));
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<!doctype html><html><body>',
      '<main><h1>Orkas Studio</h1><p>NOW AVAILABLE</p>',
      '<p>RELIABILITY</p><p>FLEXIBILITY</p><svg aria-hidden="true"></svg></main>',
      '</body></html>',
    ].join(''));

    const inspection = await inspectImageStudioProject(root);

    expect(inspection.ok).toBe(true);
    expect(inspection.advisories).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A_ENGLISH_ALL_CAPS_OVERUSE' }),
    ]));

    fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(manifest({
      brief: {
        purpose: 'Launch poster',
        audience: 'Product teams',
        required_copy: ['Orkas Studio', 'NOW AVAILABLE', 'RELIABILITY', 'FLEXIBILITY'],
        must_include: ['product mark'],
        must_avoid: ['generic dashboard cards'],
      },
    }), null, 2));
    const explicitlyRequired = await inspectImageStudioProject(root);
    expect(explicitlyRequired.advisories).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'A_ENGLISH_ALL_CAPS_OVERUSE' }),
    ]));
  });

  it('blocks missing required copy, remote resources, embedded pages, and traversal', async () => {
    fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(manifest(), null, 2));
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<!doctype html><html><body>',
      '<iframe src="https://example.com"></iframe>',
      '<script>document.body.textContent = "changed"</script>',
      '<img src="../outside.png" alt="">',
      '</body></html>',
    ].join(''));

    const inspection = await inspectImageStudioProject(root);
    expect(inspection.ok).toBe(false);
    expect(inspection.blockers.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'E_HTML_EMBED_FORBIDDEN',
      'E_REMOTE_RESOURCE_FORBIDDEN',
      'E_RESOURCE_OUTSIDE_PROJECT',
      'E_REQUIRED_COPY_MISSING',
    ]));
  });

  it('binds Omost-style visual regions and reference assets into the project signature', async () => {
    const planned = manifest({
      references: [{
        id: 'hero-source',
        path: 'assets/hero.svg',
        role: 'content',
        strength: 1,
        required: true,
        preserve: ['product silhouette'],
        may_change: ['crop'],
        region_ids: ['hero'],
      }],
      reference_intent: {
        mode: 'guide',
        instructions: ['Use the supplied product in the planned hero region.'],
        minimum_score: 75,
      },
      visual_plan: {
        global_description: 'A single product aperture balanced by an editorial title.',
        reading_order: ['hero', 'copy'],
        regions: [
          {
            id: 'hero',
            bounds: { x: 0.45, y: 0.1, width: 0.5, height: 0.8 },
            depth: 'foreground',
            role: 'hero',
            description: 'The supplied product silhouette inside a paper aperture.',
            detail_prompts: [],
            reference_ids: ['hero-source'],
          },
          {
            id: 'copy',
            bounds: { x: 0.05, y: 0.2, width: 0.35, height: 0.5 },
            depth: 'midground',
            role: 'copy',
            description: 'The exact launch title.',
            detail_prompts: [],
            reference_ids: [],
          },
        ],
      },
    });
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    fs.writeFileSync(path.join(root, 'image-manifest.json'), JSON.stringify(planned, null, 2));
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<!doctype html><html><body>',
      '<main><h1 data-image-region="copy">Orkas Studio</h1>',
      '<figure data-image-region="hero"><img src="assets/hero.svg" alt=""></figure>',
      '<svg aria-hidden="true"></svg></main>',
      '</body></html>',
    ].join(''));

    const first = await inspectImageStudioProject(root);
    expect(first.ok).toBe(true);
    expect(first.resources).toEqual(['assets/hero.svg']);

    fs.appendFileSync(path.join(root, 'assets', 'hero.svg'), '<!-- updated reference -->');
    const changed = await inspectImageStudioProject(root);
    expect(changed.signature).not.toBe(first.signature);

    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><h1 data-image-region="copy">Orkas Studio</h1><svg></svg></body></html>');
    const unmapped = await inspectImageStudioProject(root);
    expect(unmapped.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_VISUAL_REGION_UNMAPPED' })]));
  });

  it('rejects unknown reference ids and visual regions that leave the normalized canvas', () => {
    const result = validateImageStudioManifest(manifest({
      visual_plan: {
        global_description: 'Invalid plan',
        reading_order: ['hero'],
        regions: [{
          id: 'hero',
          bounds: { x: 0.8, y: 0, width: 0.4, height: 1 },
          depth: 'foreground',
          role: 'hero',
          description: 'Overflowing hero',
          detail_prompts: [],
          reference_ids: ['missing'],
        }],
      },
    }));
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'E_MANIFEST_REGION_BOUNDS',
      'E_MANIFEST_REGION_REFERENCE_UNKNOWN',
    ]));
  });
});
