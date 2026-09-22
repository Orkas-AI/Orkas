import type { FileFailureDiagnostic } from '../../../core-agent/src/tools/file-diagnostics';

/** One grammar for host-created aliases and model-supplied reference names.
 * Child paths have their own scope/segment rules and must not use this check. */
export function isPortableRuntimeRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(String(value || '').trim());
}

export function lookupSkillRuntimeRef<T>(
  ref: string,
  bindings: ReadonlyMap<string, T> | undefined,
): { binding?: T; error?: string; diagnostic?: FileFailureDiagnostic } {
  if (!isPortableRuntimeRef(ref)) {
    return {
      error: 'E_SKILL_REF_INVALID: Use @skill/<read-ref> with the exact read ref advertised in Available skills.',
      diagnostic: { code: 'E_SKILL_REF_INVALID', reason: 'skill_ref_format', stage: 'input', skill_ref_valid: false },
    };
  }
  const binding = bindings?.get(ref);
  if (!binding) {
    return {
      error: `E_SKILL_NOT_AVAILABLE: @skill/${ref} is not bound for this run. Use an exact read ref from the current Available skills block.`,
      diagnostic: { code: 'E_SKILL_NOT_AVAILABLE', reason: 'skill_ref_unbound', stage: 'input', skill_ref_valid: true, skill_binding_found: false },
    };
  }
  return { binding };
}
