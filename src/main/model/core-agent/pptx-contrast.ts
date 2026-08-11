type JsonRecord = Record<string, unknown>;

export interface PptxContrastAuditResult {
  issues: unknown;
  findingCount: number;
  scannedTextCount: number;
}

interface ContrastFinding {
  ownerPath: string;
  text: string;
  foreground: string;
  background: string;
  ratio: number;
  requiredRatio: number;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function formatOf(node: JsonRecord): JsonRecord {
  return record(node.format) ?? {};
}

function childrenOf(node: JsonRecord): JsonRecord[] {
  return Array.isArray(node.children)
    ? node.children.map(record).filter((child): child is JsonRecord => child !== null)
    : [];
}

function unwrapTree(value: unknown): JsonRecord | null {
  const root = record(value);
  if (!root) return null;
  const data = record(root.data);
  return data && (data.path !== undefined || data.children !== undefined) ? data : root;
}

function normalizeHex(value: unknown, theme: JsonRecord): string | null {
  const raw = String(value ?? '').trim();
  const hex = raw.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i)?.[1];
  if (hex) return `#${hex.toUpperCase()}`;
  const scheme = raw.toLowerCase().replace(/^theme:/, '');
  const aliases: Record<string, string> = {
    dark1: 'dk1', dark2: 'dk2', light1: 'lt1', light2: 'lt2',
  };
  const themeKey = aliases[scheme] ?? scheme;
  if (!/^(?:dk|lt|accent)[1-6]$/.test(themeKey)) return null;
  const themed = theme[`theme.color.${themeKey}`];
  const themedHex = String(themed ?? '').trim().match(/^#?([0-9a-f]{6})$/i)?.[1];
  return themedHex ? `#${themedHex.toUpperCase()}` : null;
}

function resolvedBackground(format: JsonRecord, inherited: string | null, theme: JsonRecord): string | null {
  const raw = format.fill ?? format.background;
  if (raw === undefined || raw === null || /^(?:none|clear|transparent)$/i.test(String(raw).trim())) {
    return inherited;
  }
  return normalizeHex(raw, theme);
}

function parsePoints(value: unknown): number | null {
  const match = String(value ?? '').trim().match(/^([0-9]+(?:\.[0-9]+)?)(?:pt)?$/i);
  if (!match) return null;
  const points = Number(match[1]);
  return Number.isFinite(points) && points > 0 ? points : null;
}

function isBold(value: unknown): boolean {
  return value === true || /^(?:true|1|bold)$/i.test(String(value ?? '').trim());
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function issueList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = record(value);
  if (!root) return [];
  if (Array.isArray(root.issues)) return root.issues;
  const data = record(root.data);
  return data && Array.isArray(data.issues) ? data.issues : [];
}

function withIssueList(value: unknown, issues: unknown[]): unknown {
  if (Array.isArray(value)) return issues;
  const root = record(value);
  if (!root) return { success: true, data: { count: issues.length, issues } };
  const data = record(root.data);
  if (data && Array.isArray(data.issues)) {
    return { ...root, data: { ...data, count: issues.length, issues } };
  }
  if (Array.isArray(root.issues)) return { ...root, count: issues.length, issues };
  return { ...root, data: { count: issues.length, issues } };
}

function isOfficeLowContrastIssue(value: unknown, auditedPaths: Set<string>): boolean {
  const issue = record(value);
  if (!issue) return false;
  const subtype = String(issue.subtype ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const message = String(issue.message ?? '');
  if (subtype !== 'low_contrast' && !/^low-contrast\b/i.test(message)) return false;
  const path = String(issue.path ?? '').trim();
  return !!path && auditedPaths.has(path);
}

/**
 * Supplement OfficeCLI's PPTX issue scan with deterministic text/background
 * contrast checks. The tree already resolves theme text colors; this catches
 * inherited black placeholder text on a dark slide, which the engine's
 * explicit-fill-only heuristic cannot see.
 *
 * This deliberately audits only backgrounds represented by the text node's
 * ancestors or the slide itself. Independent overlapping shapes, gradients,
 * images, and transparency remain the visual reviewer's responsibility.
 */
export function auditPptxContrast(rawIssues: unknown, rawTree: unknown): PptxContrastAuditResult {
  const root = unwrapTree(rawTree);
  if (!root) return { issues: rawIssues, findingCount: 0, scannedTextCount: 0 };

  const rootFormat = formatOf(root);
  const theme = rootFormat;
  const defaultText = normalizeHex(rootFormat['theme.color.dk1'], theme) ?? '#000000';
  const defaultBackground = normalizeHex(rootFormat['theme.color.lt1'], theme) ?? '#FFFFFF';
  const findings = new Map<string, ContrastFinding>();
  const auditedPaths = new Set<string>();
  let scannedTextCount = 0;

  const auditNode = (
    node: JsonRecord,
    inheritedBackground: string | null,
    inheritedForeground: string,
    inheritedSize: number | null,
    inheritedBold: boolean,
    ownerPath: string,
  ): void => {
    const format = formatOf(node);
    const nodePath = String(node.path ?? '').trim();
    const nodeType = String(node.type ?? '').trim().toLowerCase();
    const isOwner = ['shape', 'placeholder', 'textbox', 'table-cell', 'cell'].includes(nodeType);
    const activeOwner = isOwner && nodePath ? nodePath : ownerPath;
    const background = resolvedBackground(format, inheritedBackground, theme);
    const foreground = normalizeHex(format.color ?? format['effective.color'], theme) ?? inheritedForeground;
    const size = parsePoints(format.size ?? format['font.size'] ?? format['effective.size']) ?? inheritedSize;
    const bold = format.bold !== undefined ? isBold(format.bold) : inheritedBold;
    const children = childrenOf(node);
    const text = String(node.text ?? '').trim();
    const isTextLeaf = !!text && (nodeType === 'run' || children.length === 0);

    if (isTextLeaf && background && activeOwner) {
      scannedTextCount += 1;
      auditedPaths.add(activeOwner);
      const ratio = contrastRatio(foreground, background);
      const requiredRatio = (size !== null && (size >= 18 || (bold && size >= 14))) ? 3 : 4.5;
      if (ratio < requiredRatio) {
        const candidate: ContrastFinding = {
          ownerPath: activeOwner,
          text: text.replace(/\s+/g, ' ').slice(0, 80),
          foreground,
          background,
          ratio,
          requiredRatio,
        };
        const previous = findings.get(activeOwner);
        if (!previous || candidate.ratio < previous.ratio) findings.set(activeOwner, candidate);
      }
    }

    for (const child of children) {
      auditNode(child, background, foreground, size, bold, activeOwner);
    }
  };

  for (const slide of childrenOf(root)) {
    if (String(slide.type ?? '').toLowerCase() !== 'slide' && !/^\/slide\[\d+\]$/.test(String(slide.path ?? ''))) {
      continue;
    }
    const slideFormat = formatOf(slide);
    const slideBackground = slideFormat.background === undefined
      ? defaultBackground
      : normalizeHex(slideFormat.background, theme);
    auditNode(slide, slideBackground, defaultText, null, false, '');
  }

  const preserved = issueList(rawIssues).filter((issue) => !isOfficeLowContrastIssue(issue, auditedPaths));
  const generated = [...findings.values()].map((finding, index) => ({
    id: `ORKAS_CONTRAST_${index + 1}`,
    type: 'format',
    subtype: 'low_contrast',
    severity: finding.ratio < 2 ? 'blocker' : 'warning',
    path: finding.ownerPath,
    message:
      `Text "${finding.text}" has ${finding.ratio.toFixed(2)}:1 contrast ` +
      `(${finding.foreground} on ${finding.background}); requires ${finding.requiredRatio.toFixed(1)}:1.`,
    foreground: finding.foreground,
    background: finding.background,
    contrast_ratio: Number(finding.ratio.toFixed(2)),
    required_ratio: finding.requiredRatio,
  }));
  const issues = [...preserved, ...generated];
  return {
    issues: withIssueList(rawIssues, issues),
    findingCount: generated.length,
    scannedTextCount,
  };
}
