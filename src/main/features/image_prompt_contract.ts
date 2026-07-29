export const IMAGE_REFERENCE_ROLES = [
  'style',
  'identity',
  'composition',
  'structure',
  'content',
  'mask',
  'edit_source',
] as const;

export type ImageReferenceRole = typeof IMAGE_REFERENCE_ROLES[number];

export interface ImageReferenceBinding {
  index: number;
  role: ImageReferenceRole;
  strength: number;
  preserve: string[];
  mayChange: string[];
  region?: string;
}

const IMAGE_REFERENCE_ROLE_SET = new Set<string>(IMAGE_REFERENCE_ROLES);

export function normalizeImageStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

/**
 * Validate the public, provider-neutral reference contract used by both the
 * ImageStudio manifest compiler and `generate_image`. Reference indices follow
 * local paths first and remote URLs second.
 */
export function normalizeImageReferenceBindings(value: unknown, referenceCount: number): ImageReferenceBinding[] {
  if (value === undefined) return [];
  if (!Number.isInteger(referenceCount) || referenceCount < 0) throw new Error('referenceCount must be a non-negative integer');
  if (!Array.isArray(value)) throw new Error('reference_bindings must be an array');
  const seen = new Set<number>();
  return value.map((raw, itemIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`reference_bindings[${itemIndex}] must be an object`);
    const binding = raw as Record<string, unknown>;
    const index = Number(binding.index);
    const role = String(binding.role || '') as ImageReferenceRole;
    const strength = binding.strength === undefined ? 1 : Number(binding.strength);
    if (!Number.isInteger(index) || index < 0 || index >= referenceCount) throw new Error(`reference_bindings[${itemIndex}].index is outside the reference list`);
    if (seen.has(index)) throw new Error(`reference_bindings repeats reference index ${index}`);
    seen.add(index);
    if (!IMAGE_REFERENCE_ROLE_SET.has(role)) throw new Error(`reference_bindings[${itemIndex}].role is invalid`);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error(`reference_bindings[${itemIndex}].strength must be from 0 to 1`);
    const preserve = normalizeImageStringList(binding.preserve, `reference_bindings[${itemIndex}].preserve`);
    const mayChange = normalizeImageStringList(binding.may_change ?? binding.mayChange, `reference_bindings[${itemIndex}].may_change`);
    const region = binding.region === undefined ? undefined : String(binding.region).trim();
    if (binding.region !== undefined && !region) throw new Error(`reference_bindings[${itemIndex}].region must be non-empty`);
    return { index, role, strength, preserve, mayChange, ...(region ? { region } : {}) };
  });
}

/** Compile the structured contract for providers that only accept text. */
export function compileImagePromptContract(
  prompt: string,
  bindings: readonly ImageReferenceBinding[],
  negativePrompt: readonly string[],
): string {
  const thesis = String(prompt || '').trim();
  if (!thesis) throw new Error('prompt is required');
  const sections = [thesis];
  if (bindings.length) {
    sections.push([
      'Reference contract (reference numbers follow local paths first, then URLs):',
      ...bindings.map((binding) => {
        const details = [
          `Reference ${binding.index + 1}: role=${binding.role}; strength=${binding.strength.toFixed(2)}`,
          ...(binding.region ? [`target region=${binding.region}`] : []),
          ...(binding.preserve.length ? [`preserve=${binding.preserve.join(', ')}`] : []),
          ...(binding.mayChange.length ? [`may change=${binding.mayChange.join(', ')}`] : []),
        ];
        return `- ${details.join('; ')}.`;
      }),
    ].join('\n'));
  }
  if (negativePrompt.length) sections.push(`Avoid: ${negativePrompt.join('; ')}.`);
  return sections.join('\n\n');
}
