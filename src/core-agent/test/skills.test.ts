import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader, parseFrontmatter } from "../src/skills/index.js";

let root: string;

function tmpRoot(): string {
  return path.join(os.tmpdir(), `core-agent-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeSkill(base: string, id: string, frontmatter: Record<string, string>, body = "body text"): void {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n");
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

describe("parseFrontmatter", () => {
  it("parses a standard frontmatter block", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: foo\ndescription: a short description\n---\n\nbody here\nline 2\n",
    );
    expect(data.name).toBe("foo");
    expect(data.description).toBe("a short description");
    expect(body.trim()).toBe("body here\nline 2");
  });

  it("handles description with colons and commas", () => {
    const { data } = parseFrontmatter("---\ndescription: foo: bar, baz\n---\n");
    expect(data.description).toBe("foo: bar, baz");
  });

  it("strips matching surrounding quotes", () => {
    const { data } = parseFrontmatter('---\nname: "quoted name"\n---\n');
    expect(data.name).toBe("quoted name");
  });

  it("returns body unchanged when no frontmatter", () => {
    const { data, body } = parseFrontmatter("# heading\nhello\n");
    expect(data).toEqual({});
    expect(body).toBe("# heading\nhello\n");
  });

  it("treats unterminated frontmatter as body", () => {
    const { data, body } = parseFrontmatter("---\nname: foo\n(no closing fence)");
    expect(data).toEqual({});
    expect(body).toContain("(no closing fence)");
  });
});

describe("SkillLoader", () => {
  beforeEach(() => {
    root = tmpRoot();
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns empty list when no dirs exist", () => {
    const loader = new SkillLoader({ dirs: [path.join(root, "does-not-exist")] });
    expect(loader.list()).toEqual([]);
    expect(loader.renderSystemPromptBlock()).toBe("");
  });

  it("discovers skills with frontmatter", () => {
    const base = path.join(root, "skills");
    // Legacy `description` field migrates to `description_en` (no CJK chars).
    writeSkill(base, "alpha", { name: "alpha", description: "first skill" });
    writeSkill(base, "beta",  { name: "beta",  description: "second skill" });

    const loader = new SkillLoader({ dirs: [base] });
    const list = loader.list();
    expect(list.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(list[0].name).toBe("alpha"); // invariant: name === id
    expect(list[0].description_en).toBe("first skill");
    expect(list[0].description_zh).toBe("");
    expect(list[0].source).toBe(base);
    expect(list[0].skillFile.endsWith("SKILL.md")).toBe(true);
  });

  it("falls back to directory name when frontmatter is missing", () => {
    const base = path.join(root, "skills");
    const d = path.join(base, "no-fm");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), "# Just a heading, no frontmatter\n");

    const loader = new SkillLoader({ dirs: [base] });
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("no-fm");
    expect(list[0].name).toBe("no-fm");
    expect(list[0].description_zh).toBe("");
    expect(list[0].description_en).toBe("");
  });

  it("skips dirs without SKILL.md", () => {
    const base = path.join(root, "skills");
    writeSkill(base, "real", { name: "real" });
    fs.mkdirSync(path.join(base, "empty"), { recursive: true });

    const loader = new SkillLoader({ dirs: [base] });
    expect(loader.list().map((s) => s.id)).toEqual(["real"]);
  });

  it("first dir wins on id collision", () => {
    const customDir = path.join(root, "custom");
    const builtinDir = path.join(root, "builtin");
    // Descriptions carry the custom-vs-builtin marker since name==id now.
    writeSkill(customDir,  "shared", { name: "shared", description: "custom-wins" });
    writeSkill(builtinDir, "shared", { name: "shared", description: "builtin-loses" });
    writeSkill(builtinDir, "only-in-builtin", { name: "only-in-builtin", description: "extra" });

    const loader = new SkillLoader({ dirs: [customDir, builtinDir] });
    const list = loader.list();
    const shared = list.find((s) => s.id === "shared")!;
    // Legacy `description` migrates to `description_en` (English content).
    expect(shared.description_en).toBe("custom-wins");
    expect(shared.source).toBe(customDir);
    expect(list.find((s) => s.id === "only-in-builtin")).toBeDefined();
  });

  it("caches by mtime and invalidate() forces re-scan", () => {
    const base = path.join(root, "skills");
    writeSkill(base, "one", { name: "One" });

    const loader = new SkillLoader({ dirs: [base] });
    const first = loader.list();
    expect(first).toHaveLength(1);

    // Second call returns the same array reference (cache hit).
    const second = loader.list();
    expect(second).toBe(first);

    // Add another skill without touching mtime — cache still wins (expected).
    writeSkill(base, "two", { name: "Two" });
    // Depending on filesystem, mtime may not have changed; force invalidate.
    loader.invalidate();
    const third = loader.list();
    expect(third.map((s) => s.id).sort()).toEqual(["one", "two"]);
  });

  it("renderSystemPromptBlock lists all skills with source marker", () => {
    const customDir  = path.join(root, "custom");
    const builtinDir = path.join(root, "builtin");
    writeSkill(customDir,  "alpha", { name: "alpha", description: "alpha desc" });
    writeSkill(builtinDir, "beta",  { name: "beta",  description: "beta desc" });

    const loader = new SkillLoader({ dirs: [customDir, builtinDir] });
    const block = loader.renderSystemPromptBlock();
    expect(block).toContain("## Available skills");
    // Each entry carries a `Source` tag (dir basename) so the LLM can pick
    // the right path prefix without probing both roots. (Note: Orkas's
    // production renderer in skill-registry.ts uses richer formatting with
    // inline ROOT path headers; this default helper stays minimal and is
    // only consumed by other hosts / by these tests.)
    expect(block).toContain("**alpha** (Source: custom) — alpha desc");
    expect(block).toContain("**beta** (Source: builtin) — beta desc");
    // id must never be shown twice — the name==id invariant holds.
    expect(block).not.toMatch(/\(`/);
  });

  it("parseSpec keeps frontmatter name distinct from dir id (id≠name invariant)", () => {
    // The loader decouples id (= dir basename, used as `read_file` path
    // component) from name (= frontmatter name, the LLM-facing display
    // label). Marketplace installs deliberately let these diverge (dir is
    // the 12-hex server_id, name is the authored human label).
    const customDir = path.join(root, "custom");
    writeSkill(customDir, "web-summary", { name: "WebSummaryLegacy", description: "x" });

    const loader = new SkillLoader({ dirs: [customDir] });
    const [spec] = loader.list();
    expect(spec.id).toBe("web-summary");
    expect(spec.name).toBe("WebSummaryLegacy");  // frontmatter is preserved verbatim
  });

});
