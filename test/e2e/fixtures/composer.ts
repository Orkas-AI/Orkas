import { expect, type Locator } from '@playwright/test';

/** Assert the exact authored/wire text, including invisible resource metadata.
 * textContent is only presentation and cannot be the oracle for atomic chips. */
export function composerText(input: Locator): Promise<string> {
  return input.evaluate(element => (window as any).composerText(element));
}
export async function expectComposerText(input: Locator, expected: string | RegExp) {
  if (typeof expected === 'string') await expect.poll(() => composerText(input)).toBe(expected);
  else await expect.poll(() => composerText(input)).toMatch(expected);
}
