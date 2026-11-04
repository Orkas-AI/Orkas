import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { vi } from 'vitest';

// Recovery cases mock the tool runtime. Media setup must use the real bundled
// executable rather than that mock or an unrelated FFmpeg on the host PATH.
const { bundledFfmpegPaths } = await vi.importActual<typeof import('../../src/main/util/bundled-runtime')>(
  '../../src/main/util/bundled-runtime',
);

// Public completed-draft recovery fixture extracted from the frozen production owner.
// Contains no evaluation harness, account, hosted provider or collection code.
function writeFixtureFile(root: string, relativePath: string, body: string): void {
  const file = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

export function seedVideoComposeRecoveryFixture(
  root: string,
  options: { userId: string; userLocalRoot: string },
): string {
  const compositionDir = path.join(root, "project", "composition");
  const now = "2026-07-29T08:00:00.000Z";
  const narrationText = "Durable recovery fixture.";
  writeFixtureFile(root, "project/script.md", "# Approved script\n\nDurable recovery fixture.\n");
  const manifest = {
    schema_version: 1,
    composition: {
      id: "main",
      width: 1920,
      height: 1080,
      duration: 5,
      fps: 30,
      language: "en",
    },
    scenes: [{
      id: "cover",
      start: 0,
      duration: 5,
      approved_copy: ["Durable recovery fixture"],
      narration_text: narrationText,
      narration_refs: [],
      source_shots: ["cover"],
      roles: ["title", "visual"],
    }],
    audio: {
      owner: "composition",
      tracks: [{
        id: "narration",
        kind: "narration",
        src: "assets/narration.mp3",
        start: 0,
        duration: 5,
        volume: 1,
      }],
    },
    // This fixture starts after completed authoring and QA. A signed plan and
    // ready draft alone do not prove that delivery preflight can succeed.
    art_direction: {
      aesthetic: {
        subject_world: "A calm editorial recovery status card",
        one_job: "Make the preserved recovery result readable",
        signature_device: "A single large white title on a deep blue field",
        aesthetic_risk: "Small default text would make the preserved result unreadable",
        anti_template_check: "Use one strong typographic focal point without decorative card grids",
      },
      visual_direction: {
        visual_tradition: "Editorial title card",
        lazy_defaults_rejected: "No miniature centered cards or decorative blobs",
        video_scale: { hero_title_min_px: 88, label_min_px: 28,
          safe_zone_px: { left: 120, right: 120, top: 90, bottom: 90 } },
        depth_layer_rule: "Blue field, dominant white title, quiet supporting line",
        motion_verb_rule: ["hold"],
        rhythm_pattern: "Hold the completed result for five seconds",
      },
      cover: {
        scene_id: "cover", headline: "Durable recovery fixture",
        content_signals: ["Durable recovery", "preserved result"],
        hero_visual: "A large preserved-result title",
        composition_strategy: "One readable title against the blue field",
        frame_time_sec: 0,
      },
      scenes: [{ id: "cover", start: 0, duration: 5,
        scene_world: "Recovery result card", hero_visual: "The preserved-result title",
        depth_layers: ["blue field", "white title", "supporting line"], motion_verbs: ["hold"] }],
      layout_boxes: { safe_margin: 120, visual_zone: "full-frame title" },
      typography_tokens: { title: "display 128px", body: "supporting 40px", label: "label 28px" },
      color_tokens: { bg: "#17365D", ink: "#ffffff", accent: "#b9d9ff" },
      motion_budget: { rule: "Static readable hold" },
      scene_variation: { rule: "One scene; no repeated layout" },
    },
  };
  writeFixtureFile(root, "project/composition/composition-manifest.json", `${JSON.stringify(
    manifest,
    null,
    2,
  )}\n`);
  const narrationPath = path.join(compositionDir, "assets", "narration.mp3");
  const draftPath = path.join(root, "project", "render", "draft.mp4");
  fs.mkdirSync(path.dirname(narrationPath), { recursive: true });
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  // One source backs both the authored page and encoded static draft. This
  // synthetic fixture tests recovery, not speech generation or native QA.
  const titleCard = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">'
    + '<rect width="1920" height="1080" fill="#17365D"/>'
    + '<text data-role="title" x="120" y="480" fill="white" font-family="sans-serif" font-size="128">Durable recovery</text>'
    + '<text data-role="title" x="120" y="640" fill="white" font-family="sans-serif" font-size="128">fixture</text>'
    + '<text data-role="body" data-cover-signal="" x="120" y="760" fill="#b9d9ff" font-family="sans-serif" font-size="40">Preserved result · Ready for review</text>'
    + '</svg>';
  writeFixtureFile(root, "project/composition/assets/title-card.svg", titleCard);
  const cardPath = path.join(compositionDir, "assets/title-card.png");
  // Seeding is synchronous for all production fixtures. Use the existing
  // Sharp dependency in a bounded child rather than changing that API.
  const raster = spawnSync(process.execPath, ["-e",
    'require(process.argv[1])(require("node:fs").readFileSync(0)).png().toFile(process.argv[2]).catch(() => process.exit(1))',
    createRequire(import.meta.url).resolve("sharp"), cardPath], {
    input: titleCard,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (raster.status !== 0 || !fs.existsSync(cardPath)) throw new Error("Video recovery title-card rasterization failed.");
  runFixtureMediaCommand([
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-codec:a", "libmp3lame", "-q:a", "5",
    narrationPath,
  ], narrationPath);
  runFixtureMediaCommand([
    "-y", "-loglevel", "error",
    "-loop", "1", "-i", cardPath,
    "-i", narrationPath, "-vf", "format=yuv420p", "-r", "30", "-c:a", "aac", "-shortest",
    "-c:v", "mpeg4", "-q:v", "5", "-movflags", "+faststart", "-t", "5",
    draftPath,
  ], draftPath);
  const narrationTextSha256 = createHash("sha256").update(narrationText).digest("hex");
  const narrationAudioSha256 = createHash("sha256")
    .update(fs.readFileSync(narrationPath))
    .digest("hex");
  writeFixtureFile(root, "project/composition/narration-map.json", `${JSON.stringify({
    schema_version: 1,
    source: "composition.materialize_narration",
    alignment_method: "scene_estimate_scaled",
    narration_text_sha256: narrationTextSha256,
    narration_audio_sha256: narrationAudioSha256,
    total_duration: 5,
    lines: [{
      id: "narration-cover",
      scene_id: "cover",
      start: 0,
      duration: 5,
      text: narrationText,
    }],
  }, null, 2)}\n`);
  writeFixtureFile(root, "project/composition/index.html", [
    "<!doctype html>",
    '<html lang="en"><head><style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden}svg{display:block}</style></head><body>',
    '<main data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="5">',
    '<section class="clip" data-scene-id="cover" data-start="0" data-duration="5">',
    `<div data-role="visual" data-cover-hero>${titleCard}</div>`,
    "</section>",
    "  ",
    '    <audio id="audio-narration" src="./assets/narration.mp3" data-start="0" data-duration="5" data-track-index="10" data-volume="1"></audio>',
    "  </main></body></html>",
    "",
  ].join("\n"));
  writeFixtureFile(root, "project/render/draft-report.json", `${JSON.stringify({
    ok: true,
    draft_ready: true,
    output_path: "project/render/draft.mp4",
    qa: { status: "ok", source: "synthetic-fixture", checks: ["shared-source-title-card", "playable-media"] },
  }, null, 2)}\n`);

  // An independently authored approved intent, including a genuine plan
  // record, is needed for this fixture's final-review recovery frontier.
  const approvedIntent = { manifest: {
    composition: { id: "main", width: 1920, height: 1080, target_duration: 5, language: "en" },
    scenes: [{ id: "cover", approved_copy: ["Durable recovery fixture"], narration_text: narrationText,
      narration_refs: [], source_shots: ["cover"], roles: ["title", "visual"] }],
    audio: { narration_intent: null },
  } };
  const sortedJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const approvedSignature = createHash("sha256").update(sortedJson(approvedIntent)).digest("hex");
  if (options.userId && options.userLocalRoot) {
    const stateKey = createHash("sha256")
      .update([options.userId, path.resolve(compositionDir)].join("\0"))
      .digest("hex")
      .slice(0, 32);
    writeFixtureFile(options.userLocalRoot, `video_studio/gates/${stateKey}.json`, `${JSON.stringify({
      schema_version: 1,
      revision: 4,
      composition_dir: compositionDir,
      stage: "draft_ready",
      artifacts: {
        manifest_sha256: createHash("sha256").update(fs.readFileSync(path.join(compositionDir, "composition-manifest.json"))).digest("hex"),
        html_sha256: createHash("sha256").update(fs.readFileSync(path.join(compositionDir, "index.html"))).digest("hex"),
      },
      plan_approval: {
        gate: "B", signature: approvedSignature, identity_kind: "approved_intent_sha256",
        intent_snapshot: approvedIntent, turn_id: "fixture-plan-approved-turn", approved_at: now,
        artifact_paths: [path.join(compositionDir, "composition-manifest.json")], validation_version: 3,
      },
      narration: {
        status: "materialized",
        text_sha256: narrationTextSha256,
        audio_sha256: narrationAudioSha256,
        path: narrationPath,
        measured_duration_sec: 5,
        backend: "fixture",
        language: "en",
        speed: 1,
        materialized_at: now,
      },
      draft: {
        signature: legacyCompositionSignature(compositionDir),
        turn_id: "fixture-draft-turn",
        created_at: now,
        status: "ready",
        path: draftPath,
        report_path: path.join(root, "project", "render", "draft-report.json"),
        validation_version: 1,
      },
      last_operation: {
        revision: 4,
        op: "composition.draft",
        status: "passed",
        stage: "draft_ready",
        output_path: draftPath,
        report_path: path.join(root, "project", "render", "draft-report.json"),
        at: now,
      },
      history: [
        {
          revision: 3,
          op: "composition.materialize_narration",
          status: "passed",
          stage: "narration_ready",
          at: now,
        },
        {
          revision: 4,
          op: "composition.draft",
          status: "passed",
          stage: "draft_ready",
          at: now,
        },
      ],
      created_at: now,
      updated_at: now,
    }, null, 2)}\n`);
  }
  return root;
}

function runFixtureMediaCommand(args: string[], outputPath: string): void {
  const ffmpeg = bundledFfmpegPaths().ffmpeg;
  if (!ffmpeg) throw new Error('Video recovery fixture requires the prepared FFmpeg runtime.');
  const result = spawnSync(ffmpeg, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1_000) {
    throw new Error(
      `real media fixture generation failed for ${path.basename(outputPath)}: ${result.error?.code || result.signal || result.stderr || result.stdout}`,
    );
  }
}

function legacyCompositionSignature(compositionDir: string): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(compositionDir, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (relative === "qa" || relative === "preview") continue;
        visit(absolute);
      } else if (entry.isFile() && !["design-contract.json", "scene-map.json"].includes(relative)) {
        files.push(absolute);
      }
    }
  };
  visit(compositionDir);
  const hash = createHash("sha256");
  for (const absolute of files) {
    hash.update(path.relative(compositionDir, absolute).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

