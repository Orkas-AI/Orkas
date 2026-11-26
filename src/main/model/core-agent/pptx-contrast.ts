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
  /** The color comes from a declared fill or a proven backing panel. */
  backgroundDeclared: boolean;
}

interface Background {
  color: string | null;
  declared: boolean;
  needsVisualReview?: boolean;
}

interface LayerBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TEXT_OWNER_TYPES = new Set(['shape', 'title', 'placeholder', 'textbox', 'table-cell', 'cell']);
const GEOMETRY_UNIT_EMU: Record<string, number> = { cm: 360_000, mm: 36_000, in: 914_400, pt: 12_700, emu: 1 };
// Limit work on crowded decks just as the separate rendered collision audit
// bounds layout comparisons. Exhaustion leaves an advisory instead of a guess.
const MAX_LAYER_COMPARISONS = 100_000;

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
  // `get / --json` wraps the presentation in a query result, while older
  // callers provide the tree directly. Never audit an arbitrary match.
  if (data && Array.isArray(data.results)) {
    if (data.results.length !== 1) return null;
    const tree = record(data.results[0]);
    return tree?.path === '/' && tree.type === 'presentation' ? tree : null;
  }
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
  if (isTransparentFill(raw)) {
    return inherited;
  }
  return normalizeHex(raw, theme);
}

function isTransparentFill(value: unknown): boolean {
  return value == null || /^(?:none|clear|transparent)$/i.test(String(value).trim());
}

function geometryLength(value: unknown): number {
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(cm|mm|in|pt|emu)?$/i.exec(String(value ?? '').trim());
  if (!match) return NaN;
  const amount = Number(match[1]);
  const emu = match[2] ? Math.round(amount * GEOMETRY_UNIT_EMU[match[2].toLowerCase()]) : amount;
  return Number.isSafeInteger(emu) ? emu : NaN;
}

function boundsFor(node: JsonRecord, format: JsonRecord): LayerBounds | null {
  // Groups and transformed/effected shapes can paint outside their raw bounds.
  if (String(node.type ?? '').toLowerCase() === 'group'
    || Number(format.rotation ?? 0) !== 0
    || Boolean(format.shadow || format.glow || format.reflection || format.softEdge)) return null;
  const left = geometryLength(format.x);
  const top = geometryLength(format.y);
  const width = geometryLength(format.width);
  const height = geometryLength(format.height);
  const right = left + width;
  const bottom = top + height;
  return width > 0 && height > 0 && Number.isFinite(right) && Number.isFinite(bottom)
    ? { left, top, right, bottom } : null;
}

function hasUncertainOpacity(format: JsonRecord, fill: unknown): boolean {
  const alpha = /^#?[0-9a-f]{6}([0-9a-f]{2})$/i.exec(String(fill ?? '').trim())?.[1];
  return (format.opacity != null && !/^1(?:\.0+)?$/.test(String(format.opacity).trim()))
    || (alpha !== undefined && alpha.toLowerCase() !== 'ff');
}

function panelColor(node: JsonRecord, format: JsonRecord): string | null {
  if (String(node.type ?? '').toLowerCase() !== 'shape'
    || String(format.geometry ?? '').toLowerCase() !== 'rect'
    || String(node.text ?? '').trim()
    || format.gradient || format.pattern || hasUncertainOpacity(format, format.fill)) return null;
  const hex = /^#?([0-9a-f]{6})(?:ff)?$/i.exec(String(format.fill ?? '').trim())?.[1];
  return hex ? `#${hex.toUpperCase()}` : null;
}

// Undefined means no layer changes the ordinary background. Null means the
// tree cannot establish a single background for the text.
function slideBackdrops(children: JsonRecord[], budget: { remaining: number }) {
  const usedOrders = new Set<number>();
  const duplicateOrders = new Set<number>();
  const layers = children.map(node => {
    const format = formatOf(node);
    const orderText = String(format.zorder ?? '').trim();
    const order = /^\d+$/.test(orderText) && Number.isSafeInteger(Number(orderText)) ? Number(orderText) : null;
    if (order !== null) {
      if (usedOrders.has(order)) duplicateOrders.add(order);
      usedOrders.add(order);
    }
    return { node, order, bounds: boundsFor(node, format), color: panelColor(node, format) };
  });
  const byNode = new Map(layers.map(layer => [layer.node, layer]));
  // Unknown order may put a shape between the text and any candidate panel.
  layers.sort((a, b) => a.order === b.order ? 0 : (b.order ?? Infinity) - (a.order ?? Infinity));
  const hasLayout = layers.some(layer => layer.order !== null || layer.bounds !== null);
  return (node: JsonRecord): string | null | undefined => {
    const target = byNode.get(node);
    if (!target || !hasLayout || layers.length === 1) return undefined;
    for (const neighbor of layers) {
      if (neighbor === target) continue;
      if (budget.remaining-- <= 0) return null;
      const front = target.bounds;
      const back = neighbor.bounds;
      if (front && back && (back.right <= front.left || back.bottom <= front.top
        || back.left >= front.right || back.top >= front.bottom)) continue;
      if (!front || !back || target.order === null || neighbor.order === null || neighbor.order >= target.order
        || duplicateOrders.has(neighbor.order) || !neighbor.color
        || back.left > front.left || back.top > front.top || back.right < front.right || back.bottom < front.bottom) return null;
      // The first intersecting lower layer is opaque and covers the frame.
      return neighbor.color;
    }
    return undefined;
  };
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
 * A direct slide shape can also use a simple, proven backing panel.
 * Report ambiguous layers for visual review rather than guessing their color.
 */
export function auditPptxContrast(rawIssues: unknown, rawTree: unknown): PptxContrastAuditResult {
  const root = unwrapTree(rawTree);
  if (!root) return { issues: rawIssues, findingCount: 0, scannedTextCount: 0 };

  const rootFormat = formatOf(root);
  const theme = rootFormat;
  const defaultText = normalizeHex(rootFormat['theme.color.dk1'], theme) ?? '#000000';
  const defaultBackground = normalizeHex(rootFormat['theme.color.lt1'], theme) ?? '#FFFFFF';
  const findings = new Map<string, ContrastFinding>();
  const visualReviewPaths = new Set<string>();
  const auditedPaths = new Set<string>();
  const layerBudget = { remaining: MAX_LAYER_COMPARISONS };
  let scannedTextCount = 0;

  const auditNode = (
    node: JsonRecord,
    inheritedBackground: Background,
    inheritedForeground: string,
    inheritedSize: number | null,
    inheritedBold: boolean,
    ownerPath: string,
    backdropFor?: ReturnType<typeof slideBackdrops>,
  ): void => {
    const format = formatOf(node);
    const nodePath = String(node.path ?? '').trim();
    const nodeType = String(node.type ?? '').trim().toLowerCase();
    const isOwner = TEXT_OWNER_TYPES.has(nodeType);
    const activeOwner = isOwner && nodePath ? nodePath : ownerPath;
    const background = resolvedBackground(format, inheritedBackground.color, theme);
    const nodeBackground = background === inheritedBackground.color ? inheritedBackground
      : { ...inheritedBackground, color: background, declared: background !== null };
    const foreground = normalizeHex(format.color ?? format['effective.color'], theme) ?? inheritedForeground;
    const size = parsePoints(format.size ?? format['font.size'] ?? format['effective.size']) ?? inheritedSize;
    const bold = format.bold !== undefined ? isBold(format.bold) : inheritedBold;
    const children = childrenOf(node);
    const text = String(node.text ?? '').trim();
    const isTextLeaf = !!text && (nodeType === 'run' || children.length === 0);

    if (isTextLeaf && activeOwner && inheritedBackground.needsVisualReview) {
      visualReviewPaths.add(activeOwner);
      auditedPaths.add(activeOwner);
    } else if (isTextLeaf && background && activeOwner) {
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
          backgroundDeclared: nodeBackground.declared,
        };
        const previous = findings.get(activeOwner);
        if (!previous || candidate.ratio < previous.ratio) findings.set(activeOwner, candidate);
      }
    }

    for (const child of children) {
      let childBackground = nodeBackground;
      if (backdropFor && TEXT_OWNER_TYPES.has(String(child.type ?? '').toLowerCase())) {
        const childFormat = formatOf(child);
        const fill = childFormat.fill ?? childFormat.background;
        const backing = isTransparentFill(fill) ? backdropFor(child)
          : hasUncertainOpacity(childFormat, fill) ? null : undefined;
        if (backing === null) childBackground = { ...nodeBackground, needsVisualReview: true };
        else if (backing !== undefined) childBackground = { color: backing, declared: true };
      }
      auditNode(child, childBackground, foreground, size, bold, activeOwner);
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
    auditNode(slide, { color: slideBackground, declared: slideFormat.background !== undefined },
      defaultText, null, false, '', slideBackdrops(childrenOf(slide), layerBudget));
  }

  const preserved = issueList(rawIssues).filter((issue) => !isOfficeLowContrastIssue(issue, auditedPaths));
  const generated = [...findings.values()].map((finding, index) => ({
    id: `ORKAS_CONTRAST_${index + 1}`,
    type: 'format',
    subtype: 'low_contrast',
    // A blocker stops publication. Only a background the deck actually
    // declares can justify that; against the theme default the text may sit
    // on a picture the tree does not represent, so ppt-review gets a warning
    // to verify visually instead of a false "unpublishable".
    severity: finding.ratio < 2 && finding.backgroundDeclared ? 'blocker' : 'warning',
    path: finding.ownerPath,
    message:
      `Text "${finding.text}" has ${finding.ratio.toFixed(2)}:1 contrast ` +
      `(${finding.foreground} on ${finding.background}); requires ${finding.requiredRatio.toFixed(1)}:1.` +
      (finding.backgroundDeclared
        ? ''
        : ' The background is the theme default, not a declared fill; confirm visually whether a picture or shape sits under this text.'),
    foreground: finding.foreground,
    background: finding.background,
    contrast_ratio: Number(finding.ratio.toFixed(2)),
    required_ratio: finding.requiredRatio,
  }));
  const visualReview = [...visualReviewPaths].map((path, index) => {
    const slide = /^\/slide\[(\d+)\]/.exec(path)?.[1];
    return {
      id: `ORKAS_CONTRAST_REVIEW_${index + 1}`,
      type: 'format',
      subtype: 'contrast_needs_visual_review',
      severity: 'warning',
      path,
      message: `Render slide ${slide ?? 'containing this element'} to check the text contrast. Its background could not be determined from the slide layers.`,
    };
  });
  const issues = [...preserved, ...generated, ...visualReview];
  return {
    issues: withIssueList(rawIssues, issues),
    findingCount: generated.length + visualReview.length,
    scannedTextCount,
  };
}
