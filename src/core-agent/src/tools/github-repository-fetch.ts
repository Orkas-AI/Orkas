/** GitHub repository source adapter for web_fetch. */

import type { ToolResult } from "./base.js";
import {
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  readWebFetchResponse,
  WEB_FETCH_USER_AGENT,
  webFetchAcceptLanguage,
} from "./web-fetch-http.js";

const README_SNAPSHOT_MAX_CHARS = 4_500;

export type GitHubRepositoryResource = {
  key: string;
  kind: "repository" | "metadata" | "readme";
  owner: string;
  repo: string;
  canonicalUrl: string;
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
  content: string;
  priority: number;
};

function sectionPriority(heading: string): number {
  const normalized = heading.toLowerCase();
  if (/licen[cs]e|许可|授权/.test(normalized)) return 3;
  if (
    /privacy|security|telemetry|requirement|hardware|gpu|memory|ram|隐私|安全|遥测|配置|硬件|要求/.test(
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

/** Preserve the opening and bounded high-signal sections of a long README. */
export function compactGitHubReadme(readme: string): string {
  const normalized = readme.replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= README_SNAPSHOT_MAX_CHARS) return normalized;

  const headings = [...normalized.matchAll(/^#{1,4}\s+.+$/gm)];
  if (headings.length === 0) {
    return normalized.slice(0, README_SNAPSHOT_MAX_CHARS)
      + "\n\n[README snapshot truncated after the bounded source excerpt.]";
  }

  const preamble = normalized.slice(0, headings[0].index ?? 0).trim();
  const sections: MarkdownSection[] = headings.map((match, index) => {
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? normalized.length;
    return {
      index,
      content: normalized.slice(start, end).trim(),
      priority: sectionPriority(match[0].replace(/^#{1,4}\s+/, "").trim()),
    };
  });
  const opening = [preamble, sections[0]?.content]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1_800);
  const candidates = sections
    .filter((section) => section.index >= 1 && section.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const retained: MarkdownSection[] = [];
  let remaining = README_SNAPSHOT_MAX_CHARS - opening.length - 250;
  for (const section of candidates) {
    if (remaining < 250) break;
    const content = section.content.length > 900
      ? section.content.slice(0, 900) + "\n[Section excerpt truncated.]"
      : section.content;
    if (content.length > remaining) continue;
    retained.push({ ...section, content });
    remaining -= content.length + 2;
  }
  retained.sort((a, b) => a.index - b.index);

  return [
    opening,
    ...retained.map((section) => section.content),
    "[README snapshot selected high-signal source sections; other sections omitted.]",
  ].filter(Boolean).join("\n\n");
}

/** Fetch one deterministic repository snapshot with two parallel HTTP requests. */
export async function fetchGitHubRepositorySnapshot(
  resource: GitHubRepositoryResource,
): Promise<ToolResult> {
  const metadataUrl =
    `https://api.github.com/repos/${encodeURIComponent(resource.owner)}/${encodeURIComponent(resource.repo)}`;
  const readmeUrl = `${metadataUrl}/readme`;
  const controller = new AbortController();
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

    if ("error" in metadataBody && "error" in readmeBody) {
      return {
        content: [
          `Error fetching structured GitHub repository snapshot for ${resource.canonicalUrl}`,
          `Metadata: ${metadataBody.error}`,
          `README: ${readmeBody.error}`,
        ].join("\n"),
        isError: true,
      };
    }

    let metadata: GitHubMetadata = {};
    let metadataWarning: string | null = null;
    if ("raw" in metadataBody) {
      try {
        metadata = JSON.parse(metadataBody.raw) as GitHubMetadata;
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
      readme = compactGitHubReadme(readme);
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
        "Official repository README:",
        readme || "README unavailable; do not infer README-backed claims.",
      ].join("\n"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: message.includes("abort")
        ? `Timeout fetching structured GitHub repository snapshot (${DEFAULT_WEB_FETCH_TIMEOUT_MS}ms)`
        : `Error fetching structured GitHub repository snapshot: ${message}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function compactGitHubSnapshotReplay(resource: GitHubRepositoryResource): ToolResult {
  return {
    content: [
      "GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT: this repository's metadata and README were already fetched in this run; no network request was made.",
      `URL: ${resource.canonicalUrl}`,
      "Use the earlier structured repository snapshot and durable evidence ledger. Do not fetch a GitHub HTML/API/README alias again.",
    ].join("\n"),
  };
}
