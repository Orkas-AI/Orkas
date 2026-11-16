export type ImageStudioTraceRoute = 'COMPOSE' | 'HYBRID' | 'GENERATE' | 'EDIT';

export type ImageStudioSkillTraceEvent =
  | { kind: 'skill-read'; skillId: string; batch: number }
  | { kind: 'route-locked'; route: ImageStudioTraceRoute }
  | { kind: 'evidence-ready'; evidencePath: string };

export interface ImageStudioSkillTraceExpectation {
  route: ImageStudioTraceRoute;
  needsCraft: boolean;
  needsCanvas: boolean;
  needsCompose?: boolean;
}

export interface ImageStudioSkillTraceCheck {
  id: string;
  pass: boolean;
  detail: string;
}

const IMAGE_STUDIO_SKILLS = new Set([
  'image-router',
  'image-craft',
  'image-canvas',
  'image-compose',
  'image-generate',
  'image-design-review',
]);

/**
 * Validate the observable read_file trace emitted by the core-agent tool
 * boundary. This intentionally consumes runtime events instead of inspecting
 * prompt text, so eager/preloaded skill reads fail even when the workflow copy
 * says that loading should be progressive.
 */
export function validateImageStudioSkillTrace(
  events: readonly ImageStudioSkillTraceEvent[],
  expectation: ImageStudioSkillTraceExpectation,
): ImageStudioSkillTraceCheck[] {
  const reads = events
    .map((event, index) => ({ event, index }))
    .filter((item): item is { event: Extract<ImageStudioSkillTraceEvent, { kind: 'skill-read' }>; index: number } => item.event.kind === 'skill-read')
    .filter((item) => IMAGE_STUDIO_SKILLS.has(item.event.skillId));
  const routeIndex = events.findIndex((event) => event.kind === 'route-locked');
  const routeEvent = routeIndex >= 0 ? events[routeIndex] as Extract<ImageStudioSkillTraceEvent, { kind: 'route-locked' }> : null;
  const evidenceIndex = events.findIndex((event) => event.kind === 'evidence-ready');
  const firstRead = reads[0];
  const firstBatchReads = firstRead ? reads.filter((item) => item.event.batch === firstRead.event.batch) : [];
  const readIndex = (skillId: string) => reads.find((item) => item.event.skillId === skillId)?.index ?? -1;
  const readCount = (skillId: string) => reads.filter((item) => item.event.skillId === skillId).length;
  const beforeRoute = reads.filter((item) => routeIndex < 0 || item.index < routeIndex).map((item) => item.event.skillId);
  const craftIndex = readIndex('image-craft');
  const canvasIndex = readIndex('image-canvas');
  const composeIndex = readIndex('image-compose');
  const generateIndex = readIndex('image-generate');
  const reviewIndex = readIndex('image-design-review');
  const needsGenerate = expectation.route !== 'COMPOSE';
  const needsCompose = expectation.needsCompose ?? expectation.route === 'COMPOSE';

  return [
    {
      id: 'router-first-alone',
      pass: firstRead?.event.skillId === 'image-router' && firstBatchReads.length === 1,
      detail: `first=${firstRead?.event.skillId ?? 'none'} batch=${firstBatchReads.map((item) => item.event.skillId).join(',') || 'none'}`,
    },
    {
      id: 'single-router-read',
      pass: readCount('image-router') === 1,
      detail: `router_reads=${readCount('image-router')}`,
    },
    {
      id: 'route-locked-before-dependent-skills',
      pass: routeEvent?.route === expectation.route && beforeRoute.length === 1 && beforeRoute[0] === 'image-router',
      detail: `route=${routeEvent?.route ?? 'none'} pre_route=${beforeRoute.join(',') || 'none'}`,
    },
    {
      id: 'conditional-craft',
      pass: expectation.needsCraft ? craftIndex > routeIndex : craftIndex < 0,
      detail: `expected=${expectation.needsCraft} index=${craftIndex}`,
    },
    {
      id: 'conditional-canvas',
      pass: expectation.needsCanvas ? canvasIndex > routeIndex : canvasIndex < 0,
      detail: `expected=${expectation.needsCanvas} index=${canvasIndex}`,
    },
    {
      id: 'planning-order',
      pass: !(expectation.needsCraft && expectation.needsCanvas) || (craftIndex >= 0 && canvasIndex > craftIndex),
      detail: `craft=${craftIndex} canvas=${canvasIndex}`,
    },
    {
      id: 'route-production-skill',
      pass: (needsGenerate ? generateIndex > routeIndex : generateIndex < 0)
        && (needsCompose ? composeIndex > routeIndex : true),
      detail: `generate=${generateIndex} compose=${composeIndex}`,
    },
    {
      id: 'review-after-evidence',
      pass: evidenceIndex >= 0 && reviewIndex > evidenceIndex,
      detail: `evidence=${evidenceIndex} review=${reviewIndex}`,
    },
    {
      id: 'no-duplicate-skill-reads',
      pass: reads.every((item) => readCount(item.event.skillId) === 1),
      detail: reads.map((item) => `${item.event.skillId}:${readCount(item.event.skillId)}`).join(','),
    },
  ];
}

export function imageStudioSkillTracePassed(checks: readonly ImageStudioSkillTraceCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.pass);
}
