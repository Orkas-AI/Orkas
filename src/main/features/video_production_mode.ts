/** Classify the current deliverable, never the conversation or its route name.
 * Runtime annotations are advisory; only the executable plan determines QA.
 * References are inputs, whereas every EDL layer is part of the output. */
export function videoProductionIsGeneration(plan: Record<string, unknown>): boolean {
  const segments = plan.segments;
  if (!Array.isArray(segments) || segments.length !== 1) return false;
  const segment = segments[0];
  if (!isRecord(segment) || segment.source !== 'generate' || segment.layer !== 'primary'
    || !isRecord(segment.spec) || segment.spec.media_kind !== 'video'
    || (segment.spec.operation !== undefined
      && segment.spec.operation !== 'generate' && segment.spec.operation !== 'edit')) return false;
  // Null/omitted and legacy empty tracks are disabled. Even an incomplete
  // nonempty track must not accidentally exempt a planned local operation.
  if (plan.tracks === undefined) return true;
  if (!isRecord(plan.tracks)) return false;
  return Object.values(plan.tracks).every((track) => track == null
    || (isRecord(track) && Object.keys(track).length === 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
