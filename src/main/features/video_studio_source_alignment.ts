type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter(Boolean);
}

export type ApprovedShotReferenceIndex = {
  shotIds: Set<string>;
  aliasOwners: Map<string, Set<string>>;
};

export type ApprovedShotReferenceResolution =
  | { status: 'direct'; shotId: string }
  | { status: 'alias'; shotId: string }
  | { status: 'ambiguous'; owners: string[] }
  | { status: 'unknown' };

/**
 * A shotlist may give a shot a semantic id (`hook`) and one or more source
 * aliases (`s01`). Both identify the same approved beat only when an alias has
 * exactly one owner. This index is the shared source of truth for QA and Gate B
 * content addressing.
 */
export function approvedShotReferenceIndex(shotlist: unknown): ApprovedShotReferenceIndex {
  const shots = isRecord(shotlist) && Array.isArray(shotlist.shots)
    ? shotlist.shots.filter(isRecord)
    : [];
  const shotIds = new Set<string>();
  const aliasOwners = new Map<string, Set<string>>();
  for (const shot of shots) {
    const shotId = nonEmptyString(shot.id)
      || nonEmptyString(shot.shot_id)
      || nonEmptyString(shot.scene_id);
    if (!shotId) continue;
    shotIds.add(shotId);
    for (const alias of stringList(shot.source_shots)) {
      const owners = aliasOwners.get(alias) || new Set<string>();
      owners.add(shotId);
      aliasOwners.set(alias, owners);
    }
  }
  return { shotIds, aliasOwners };
}

export function resolveApprovedShotReference(
  reference: string,
  index: ApprovedShotReferenceIndex,
): ApprovedShotReferenceResolution {
  const normalized = reference.trim();
  if (!normalized) return { status: 'unknown' };
  if (index.shotIds.has(normalized)) return { status: 'direct', shotId: normalized };
  const owners = index.aliasOwners.get(normalized);
  if (!owners?.size) return { status: 'unknown' };
  if (owners.size > 1) return { status: 'ambiguous', owners: [...owners].sort() };
  return { status: 'alias', shotId: [...owners][0] };
}

export function canonicalApprovedShotReferences(
  references: unknown,
  index: ApprovedShotReferenceIndex,
): string[] {
  const canonical: string[] = [];
  for (const reference of stringList(references)) {
    const resolution = resolveApprovedShotReference(reference, index);
    const value = resolution.status === 'direct' || resolution.status === 'alias'
      ? resolution.shotId
      : reference;
    if (!canonical.includes(value)) canonical.push(value);
  }
  return canonical;
}

/**
 * Canonicalize only representation-equivalent source aliases. Unknown or
 * ambiguous references remain unchanged so QA can reject them and a real
 * mapping change still changes the approved-intent content address.
 */
export function canonicalizeManifestSourceShotReferences(
  manifest: unknown,
  shotlist: unknown,
): unknown {
  if (!isRecord(manifest) || !Array.isArray(manifest.scenes)) return manifest;
  const index = approvedShotReferenceIndex(shotlist);
  return {
    ...manifest,
    scenes: manifest.scenes.map((scene) => {
      if (!isRecord(scene)) return scene;
      return {
        ...scene,
        source_shots: canonicalApprovedShotReferences(scene.source_shots, index),
      };
    }),
  };
}
