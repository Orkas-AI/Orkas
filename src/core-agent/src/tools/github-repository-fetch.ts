/** GitHub repository source adapter for web_fetch. */

import type { ToolResult } from "./base.js";
import {
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  readWebFetchResponse,
  WEB_FETCH_USER_AGENT,
  webFetchAcceptLanguage,
} from "./web-fetch-http.js";

/** README characters in the first snapshot view when the caller sets no maxChars. */
const README_SNAPSHOT_DEFAULT_CHARS = 4_500;
/** Line that separates repository metadata from the README in a snapshot. */
const GITHUB_README_MARKER = "Official repository README:";
const README_OPENING_MAX_CHARS = 1_800;
const README_SECTION_EXCERPT_MAX_CHARS = 1_200;
const README_PRIORITY_EXCERPT_MAX_CHARS = 900;
/** Share of the README budget available to license/requirement/setup sections. */
const README_PRIORITY_SHARE = 0.4;
const README_RECEIPT_RESERVE_CHARS = 800;
const README_MAX_OMITTED_HEADINGS = 12;
const README_OMITTED_NAMES_MAX_CHARS = 450;
/** Smallest README budget worth compacting; below it the plain prefix limit applies. */
const README_MIN_VIEW_CHARS = 1_000;

export type GitHubRepositoryResource = {
  key: string;
  kind: "repository" | "metadata" | "readme";
  owner: string;
  repo: string;
  canonicalUrl: string;
  /** Only the exact default API endpoints are represented by a root snapshot. */
  snapshotComponent?: "metadata" | "readme";
};

type GitHubSnapshotComponent = { ok: true } | { ok: false; error: string };

/** Component facts stay in the run cache, outside the model-visible result. */
export type GitHubRepositorySnapshot = {
  result: ToolResult;
  components: Record<"metadata" | "readme", GitHubSnapshotComponent>;
};

function safePathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9_.-]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Recognize only repository roots and their first-party metadata/README aliases. */
export function identifyGitHubRepositoryResource(rawUrl: string): GitHubRepositoryResource | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let kind: GitHubRepositoryResource["kind"] | null = null;
  let ownerPart: string | undefined;
  let repoPart: string | undefined;

  if ((host === "github.com" || host === "www.github.com") && parts.length === 2) {
    kind = "repository";
    [ownerPart, repoPart] = parts;
    repoPart = repoPart?.replace(/\.git$/i, "");
  } else if (
    host === "api.github.com"
    && parts[0] === "repos"
    && (parts.length === 3 || (parts.length === 4 && parts[3].toLowerCase() === "readme"))
  ) {
    kind = parts.length === 3 ? "metadata" : "readme";
    [, ownerPart, repoPart] = parts;
  } else if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const fileName = parts.at(-1)?.toLowerCase();
    if (fileName && /^readme(?:\.[a-z0-9_-]+)?$/.test(fileName)) {
      kind = "readme";
      [ownerPart, repoPart] = parts;
    }
  }

  if (!kind || !ownerPart || !repoPart) return null;
  const owner = safePathPart(ownerPart);
  const repo = safePathPart(repoPart);
  if (!owner || !repo) return null;
  return {
    key: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
    kind,
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
    ...(parsed.origin === "https://api.github.com" && !parsed.search && !parsed.username && !parsed.password
      && kind !== "repository"
      && parsed.pathname === `/repos/${ownerPart}/${repoPart}${kind === "readme" ? "/readme" : ""}`
      ? { snapshotComponent: kind } : {}),
  };
}

type GitHubMetadata = {
  full_name?: unknown;
  description?: unknown;
  homepage?: unknown;
  default_branch?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pushed_at?: unknown;
  archived?: unknown;
  fork?: unknown;
  stargazers_count?: unknown;
  forks_count?: unknown;
  open_issues_count?: unknown;
  topics?: unknown;
  license?: {
    name?: unknown;
    spdx_id?: unknown;
    url?: unknown;
  } | null;
};

function githubHeaders(accept: string): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    "User-Agent": WEB_FETCH_USER_AGENT,
    Accept: accept,
    "Accept-Language": webFetchAcceptLanguage(),
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function metadataValue(value: unknown): string {
  if (typeof value === "string") return value.trim() || "Not provided";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "Not provided";
}

type MarkdownSection = {
  index: number;
  title: string;
  start: number;
  content: string;
  priority: number;
};

function sectionPriority(heading: string): number {
  const normalized = heading.toLowerCase();
  if (/licen[cs]e|许可|授权/.test(normalized)) return 3;
  // Hardware words need word boundaries: a bare `ram`/`memory` substring also
  // matched "program", "framework" and feature titles such as "Memory-guided
  // manipulation", which pulled an arbitrary list entry ahead of the README.
  if (
    /privacy|security|telemetry|requirement|hardware|\bgpus?\b|\bv?ram\b|memory (?:usage|footprint)|隐私|安全|遥测|配置|硬件|要求/.test(
      normalized,
    )
  ) {
    return 2;
  }
  if (
    /install|getting started|quick ?start|setup|platform|support|compatib|local|offline|self.host|model|feature|capabilit|usage|documentation|how to|安装|开始|入门|平台|系统|兼容|本地|离线|模型|功能|特性|能力|使用|文档/.test(
      normalized,
    )
  ) {
    return 1;
  }
  return 0;
}

function normalizeGitHubReadme(readme: string): string {
  return readme.replace(/\r\n?/g, "\n").trim();
}

type KeptSection = {
  content: string;
  /** README position where the shown excerpt stops, or null when complete. */
  cutAt: number | null;
};

function sectionExcerpt(section: MarkdownSection, limit: number): KeptSection {
  return section.content.length > limit
    ? { content: section.content.slice(0, limit) + "\n[Section excerpt truncated.]", cutAt: section.start + limit }
    : { content: section.content, cutAt: null };
}

/**
 * Fit a long README into `budget` characters without losing its reading order.
 *
 * The opening and the first sections are kept in document order; a bounded
 * share of the budget first pulls in license, requirement, and setup sections
 * that a comparison needs even when they sit far down the README. The closing
 * receipt states how many sections were kept and names the omitted ones, so a
 * reader can tell a curated list apart from a complete one. When `readmeOffset`
 * (the README's position in the cached web_fetch result) is known, the receipt
 * also gives the `offset` values that continue the README in order.
 */
export function compactGitHubReadme(
  readme: string,
  budget = README_SNAPSHOT_DEFAULT_CHARS,
  readmeOffset?: number,
): string {
  const normalized = normalizeGitHubReadme(readme);
  if (normalized.length <= budget) return normalized;

  const at = (position: number) => (readmeOffset === undefined ? null : readmeOffset + position);
  const headings = [...normalized.matchAll(/^#{1,4}\s+.+$/gm)];
  if (headings.length === 0) {
    const shown = Math.max(0, budget - 200);
    const resume = at(shown);
    return normalized.slice(0, shown)
      + `\n\n[README snapshot shows the first ${shown} of ${normalized.length} characters; the README has no section headings.`
      + (resume === null ? "]" : ` Continue it with "offset": ${resume}.]`);
  }

  const sections: MarkdownSection[] = headings.map((match, index) => {
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? normalized.length;
    const title = match[0].replace(/^#{1,4}\s+/, "").trim();
    return {
      index,
      title,
      start,
      content: normalized.slice(start, end).trim(),
      priority: sectionPriority(title),
    };
  });
  // The opening is the preamble plus the first heading's section, read from
  // the README itself so its positions stay exact for continuation offsets.
  const openingFull = normalized.slice(0, headings[1]?.index ?? normalized.length).trim();
  const opening = openingFull.slice(0, Math.min(README_OPENING_MAX_CHARS, Math.floor(budget / 3)));

  const retained = new Map<number, KeptSection>();
  let remaining = budget - opening.length - README_RECEIPT_RESERVE_CHARS;
  let priorityRemaining = Math.floor(remaining * README_PRIORITY_SHARE);
  const priorityCandidates = sections
    .filter((section) => section.index >= 1 && section.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  for (const section of priorityCandidates) {
    const excerpt = sectionExcerpt(section, README_PRIORITY_EXCERPT_MAX_CHARS);
    if (excerpt.content.length + 2 > priorityRemaining) continue;
    retained.set(section.index, excerpt);
    priorityRemaining -= excerpt.content.length + 2;
    remaining -= excerpt.content.length + 2;
  }

  // Fill the rest in document order and stop at the first section that no
  // longer fits, so the kept run is a prefix the reader can continue from.
  for (const section of sections) {
    if (section.index < 1 || retained.has(section.index)) continue;
    const excerpt = sectionExcerpt(section, README_SECTION_EXCERPT_MAX_CHARS);
    if (excerpt.content.length + 2 > remaining) break;
    retained.set(section.index, excerpt);
    remaining -= excerpt.content.length + 2;
  }

  // First README position whose text is not shown, walking in reading order.
  let resumeAt: number | null = opening.length < openingFull.length ? opening.length : null;
  for (const section of sections) {
    if (resumeAt !== null) break;
    if (section.index < 1) continue;
    const excerpt = retained.get(section.index);
    if (!excerpt) resumeAt = section.start;
    else if (excerpt.cutAt !== null) resumeAt = excerpt.cutAt;
  }

  const kept = [...retained.entries()].sort((a, b) => a[0] - b[0]);
  const omitted = sections.filter((section) => section.index >= 1 && !retained.has(section.index));
  const shortened = kept.filter(([, section]) => section.cutAt !== null).length
    + (opening.length < openingFull.length ? 1 : 0);
  const keptChars = opening.length + kept.reduce((sum, [, section]) => sum + section.content.length, 0);
  const receipt = [
    `[README snapshot kept ${kept.length} of ${sections.length - 1} sections after the opening`
      + (shortened ? ` (${shortened} shortened)` : "")
      + `, ${keptChars} of ${normalized.length} characters.`,
  ];
  if (omitted.length) {
    const names: string[] = [];
    let nameChars = 0;
    for (const section of omitted.slice(0, README_MAX_OMITTED_HEADINGS)) {
      const name = section.title.slice(0, 80);
      if (names.length && nameChars + name.length > README_OMITTED_NAMES_MAX_CHARS) break;
      names.push(name);
      nameChars += name.length + 3;
    }
    const more = omitted.length - names.length;
    receipt.push(`Omitted sections: ${names.join(" | ")}${more > 0 ? ` (+${more} more)` : ""}.`);
  }
  const resume = resumeAt === null ? null : at(resumeAt);
  if (resume !== null) {
    receipt.push(
      `Continue the README in order with "offset": ${resume} (first text not shown);`
        + ` the complete README starts at "offset": ${at(0)}.`,
    );
  }

  return [
    opening,
    ...kept.map(([, section]) => section.content),
    receipt.join(" ") + "]",
  ].filter(Boolean).join("\n\n");
}

/**
 * First web_fetch view of a cached repository snapshot: metadata unchanged and
 * the README fitted into the caller's character budget. Returns null when the
 * snapshot has no README section or the budget cannot hold the metadata, in
 * which case the caller applies its ordinary prefix limit.
 */
export function renderGitHubSnapshotView(
  content: string,
  maxChars: number | null,
): { content: string; servedEnd: number } | null {
  const marker = `\n${GITHUB_README_MARKER}\n`;
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return null;
  const readmeStart = markerIndex + marker.length;
  const head = content.slice(0, readmeStart);
  const readme = content.slice(readmeStart);
  if (maxChars !== null && maxChars - head.length < README_MIN_VIEW_CHARS) return null;
  const budget = maxChars === null ? README_SNAPSHOT_DEFAULT_CHARS : maxChars - head.length;
  const fitted = compactGitHubReadme(readme, budget, readmeStart);
  // A compacted README is not a reading-order prefix; only the metadata is.
  return { content: head + fitted, servedEnd: fitted === readme ? content.length : readmeStart };
}

/** Fetch one deterministic repository snapshot with two parallel HTTP requests. */
export async function fetchGitHubRepositorySnapshot(
  resource: GitHubRepositoryResource,
  signal?: AbortSignal,
): Promise<GitHubRepositorySnapshot> {
  const failed = (result: ToolResult): GitHubRepositorySnapshot => ({
    result,
    components: {
      metadata: { ok: false, error: result.content },
      readme: { ok: false, error: result.content },
    },
  });
  const cancelled = (): GitHubRepositorySnapshot => failed({
    content: `Fetch of ${resource.canonicalUrl} was cancelled`,
    isError: true,
  });
  if (signal?.aborted) return cancelled();
  const metadataUrl =
    `https://api.github.com/repos/${encodeURIComponent(resource.owner)}/${encodeURIComponent(resource.repo)}`;
  const readmeUrl = `${metadataUrl}/readme`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), DEFAULT_WEB_FETCH_TIMEOUT_MS);
  try {
    const [metadataResponse, readmeResponse] = await Promise.all([
      fetch(metadataUrl, {
        method: "GET",
        headers: githubHeaders("application/vnd.github+json"),
        signal: controller.signal,
        redirect: "follow",
      }),
      fetch(readmeUrl, {
        method: "GET",
        headers: githubHeaders("application/vnd.github.raw+json"),
        signal: controller.signal,
        redirect: "follow",
      }),
    ]);
    const [metadataBody, readmeBody] = await Promise.all([
      readWebFetchResponse(metadataResponse),
      readWebFetchResponse(readmeResponse),
    ]);
    if (signal?.aborted) return cancelled();

    if ("error" in metadataBody && "error" in readmeBody) {
      return {
        result: {
          content: [
            `Error fetching structured GitHub repository snapshot for ${resource.canonicalUrl}`,
            `Metadata: ${metadataBody.error}`,
            `README: ${readmeBody.error}`,
          ].join("\n"),
          isError: true,
        },
        components: {
          metadata: { ok: false, error: metadataBody.error },
          readme: { ok: false, error: readmeBody.error },
        },
      };
    }

    let metadata: GitHubMetadata = {};
    let metadataWarning: string | null = null;
    if ("raw" in metadataBody) {
      try {
        const decoded: unknown = JSON.parse(metadataBody.raw);
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
          metadataWarning = "GitHub metadata response was not a JSON object";
        } else {
          metadata = decoded as GitHubMetadata;
        }
      } catch {
        metadataWarning = "GitHub metadata response was not valid JSON";
      }
    } else {
      metadataWarning = metadataBody.error;
    }

    let readme = "";
    let readmeWarning: string | null = null;
    if ("raw" in readmeBody) {
      readme = readmeBody.raw;
      try {
        const decoded = JSON.parse(readme) as { content?: unknown; encoding?: unknown };
        if (decoded.encoding === "base64" && typeof decoded.content === "string") {
          readme = Buffer.from(decoded.content.replace(/\s+/g, ""), "base64").toString("utf8");
        }
      } catch {
        // The expected response is raw README text.
      }
      // Keep the complete README in the run-cached result. web_fetch fits it
      // into each call's maxChars and serves later windows by offset.
      readme = normalizeGitHubReadme(readme);
      if (!readme) readmeWarning = "GitHub README response was empty";
    } else {
      readmeWarning = readmeBody.error;
    }

    const license = metadata.license;
    const topics = Array.isArray(metadata.topics)
      ? metadata.topics.filter((item): item is string => typeof item === "string").slice(0, 20).join(", ")
      : "";
    const warnings = [
      ...(metadataWarning ? [`- Metadata unavailable: ${metadataWarning}`] : []),
      ...(readmeWarning ? [`- README unavailable: ${readmeWarning}`] : []),
    ];
    return {
      components: {
        metadata: metadataWarning ? { ok: false, error: metadataWarning } : { ok: true },
        readme: readmeWarning ? { ok: false, error: readmeWarning } : { ok: true },
      },
      result: {
        ...(metadataWarning && readmeWarning ? { isError: true } : {}),
        content: [
          `Title: ${metadataValue(metadata.full_name)}`,
          `URL: ${resource.canonicalUrl}`,
          `Accessed at: ${new Date().toISOString()}`,
          "Source type: structured GitHub repository snapshot",
          `GitHub metadata API: ${metadataUrl}`,
          `GitHub README API: ${readmeUrl}`,
          "",
          "Repository metadata (authoritative GitHub API values at access time):",
          `- Full name: ${metadataValue(metadata.full_name)}`,
          `- Description: ${metadataValue(metadata.description)}`,
          `- License name: ${metadataValue(license?.name)}`,
          `- License SPDX ID: ${metadataValue(license?.spdx_id)}`,
          `- License API URL: ${metadataValue(license?.url)}`,
          `- Created at: ${metadataValue(metadata.created_at)}`,
          `- Updated at: ${metadataValue(metadata.updated_at)}`,
          `- Pushed at: ${metadataValue(metadata.pushed_at)}`,
          `- Archived: ${metadataValue(metadata.archived)}`,
          `- Fork: ${metadataValue(metadata.fork)}`,
          `- Default branch: ${metadataValue(metadata.default_branch)}`,
          `- Stars: ${metadataValue(metadata.stargazers_count)}`,
          `- Forks: ${metadataValue(metadata.forks_count)}`,
          `- Open issues: ${metadataValue(metadata.open_issues_count)}`,
          `- Homepage: ${metadataValue(metadata.homepage)}`,
          `- Topics: ${topics || "Not provided"}`,
          ...(warnings.length ? ["", "Snapshot warnings:", ...warnings] : []),
          "",
          GITHUB_README_MARKER,
          readme || "README unavailable; do not infer README-backed claims.",
        ].join("\n"),
      },
    };
  } catch (error) {
    if (signal?.aborted) return cancelled();
    const message = error instanceof Error ? error.message : String(error);
    return failed({
      content: message.includes("abort")
        ? `Timeout fetching structured GitHub repository snapshot (${DEFAULT_WEB_FETCH_TIMEOUT_MS}ms)`
        : `Error fetching structured GitHub repository snapshot: ${message}`,
      isError: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // A failed parallel request must not leave its sibling running after return.
    controller.abort();
  }
}

export function compactGitHubSnapshotReplay(resource: GitHubRepositoryResource): ToolResult {
  const component = resource.snapshotComponent === "metadata" ? "metadata" : "README";
  return {
    content: [
      `GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT: this repository's requested ${component} was already fetched in this run; no network request was made.`,
      `URL: ${resource.canonicalUrl}`,
      "Use the earlier structured repository snapshot and durable evidence ledger. To read more of the snapshot, call web_fetch on the repository URL with the offset it reported.",
    ].join("\n"),
  };
}
