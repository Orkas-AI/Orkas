/**
 * Pure chat-prompt composition shared by production and evaluation.
 *
 * Keep this module free of user state, Electron, and feature imports so an
 * isolated benchmark can render the same stable-prefix/runtime-tail shape as
 * the product with deterministic fixture values.
 */

const RUNTIME_MARKER = '## Runtime injection';

export function insertStablePromptFragment(main: string, fragment: string): string {
  if (!fragment.trim()) return main;
  const index = main.indexOf(RUNTIME_MARKER);
  if (index < 0) return `${main}\n\n---\n\n${fragment}`;
  return `${main.slice(0, index)}---\n\n${fragment}\n\n${main.slice(index)}`;
}

export function composeChatPrompt(input: {
  main: string;
  stableFragments?: readonly string[];
  languageDirective: string;
  runtimeDatetimeBlock: string;
}): string {
  const withStableFragments = (input.stableFragments ?? [])
    .reduce((prompt, fragment) => insertStablePromptFragment(prompt, fragment), input.main);
  const index = withStableFragments.indexOf(RUNTIME_MARKER);
  const withLanguage = index < 0
    ? `${withStableFragments}\n\n---\n\n${input.languageDirective}`
    : `${withStableFragments.slice(0, index)}${input.languageDirective}\n\n---\n\n${withStableFragments.slice(index)}`;
  return `${withLanguage}\n\n---\n\n${input.runtimeDatetimeBlock}`;
}

/** Render the output-format preference shared by commander and group agents. */
export function buildOutputFormatHint(format: string | undefined): string {
  switch (format) {
    case 'text':
    case 'markdown_only':
      return '### Presentation preference\nstandard reply output: use plain text or Markdown only. Do NOT emit `:::dashboard` blocks or call `create_artifact`.';
    case 'dashboard':
      return [
        '### Presentation preference',
        'dashboard output: use a valid fenced `:::dashboard` JSON block for read-only structured snapshots.',
        'Follow the `Output formats` schema exactly. Do NOT call `create_artifact`.',
      ].join('\n');
    case 'artifact':
    case 'allow_artifacts':
      return [
        '### Presentation preference',
        'This agent is configured to allow interactive apps: use `:::dashboard` for static/read-only structured snapshots; call `create_artifact` only when the user must operate the result.',
        'Choose artifacts for click/type/filter/sort/calculate/drill-down/simulate; static results prefer `:::dashboard`.',
      ].join('\n');
    case 'auto':
    default:
      return [
        '### Presentation preference',
        'This actor is configured for automatic output layout: choose the lightest useful presentation.',
        '- Use plain text or Markdown for narrative answers, lists, code, fixed-format requests, progress, wrap-ups.',
        '- Use `:::dashboard` for static/read-only structured snapshots; emit a valid fenced `:::dashboard` JSON block per `Output formats`.',
        '- Use `create_artifact` only when the user must operate the result (click/type/filter/sort/calculate/drill-down/simulate).',
        'No decorative dashboards/artifacts. Respect explicit user constraints.',
      ].join('\n');
  }
}
