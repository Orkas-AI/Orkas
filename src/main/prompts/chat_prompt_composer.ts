/**
 * Pure chat-prompt composition shared by production and evaluation.
 *
 * Keep this module free of user state, Electron, and feature imports so an
 * isolated benchmark can render the same stable-prefix/runtime-tail shape as
 * the product with deterministic fixture values.
 */

const RUNTIME_MARKER = '## Runtime injection';

export function splitVolatilePromptTail(prompt: string | undefined): {
  stable: string;
  volatileTail: string;
} {
  const raw = (prompt || '').trim();
  if (!raw) return { stable: '', volatileTail: '' };
  const marker = '\n\n---\n\n## Current date\n';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return { stable: raw, volatileTail: '' };
  return {
    stable: raw.slice(0, idx).trim(),
    volatileTail: raw.slice(idx + 2).trim(),
  };
}

export function splitCommanderAgentsBlock(prompt: string): {
  stable: string;
  agentsBlock: string;
} {
  const marker = '\n\n### Agents list\n\n';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, agentsBlock: '' };
  const blockStart = idx + 2;
  const nextSection = prompt.slice(blockStart + marker.trimStart().length).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : blockStart + marker.trimStart().length + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    agentsBlock: prompt.slice(blockStart, blockEnd).trim().replace(/^### Agents list/, '## Agents list'),
  };
}

export function splitRuntimeInjectionBlock(prompt: string): {
  stable: string;
  runtimeInjectionBlock: string;
} {
  const marker = '\n\n## Runtime injection';
  const idx = prompt.indexOf(marker);
  if (idx < 0) return { stable: prompt, runtimeInjectionBlock: '' };
  return {
    stable: prompt.slice(0, idx).trim(),
    runtimeInjectionBlock: prompt.slice(idx + 2).trim(),
  };
}

export function splitLanguageDirectiveBlock(prompt: string): {
  stable: string;
  languageDirectiveBlock: string;
} {
  const marker = '\n\n---\n\n## User language';
  const idx = prompt.lastIndexOf(marker);
  if (idx < 0) return { stable: prompt, languageDirectiveBlock: '' };
  const blockStart = idx + '\n\n---\n\n'.length;
  return {
    stable: prompt.slice(0, idx).trim(),
    languageDirectiveBlock: prompt.slice(blockStart).trim(),
  };
}

export function splitCommanderOrchestrationBlock(prompt: string): {
  stable: string;
  orchestrationBlock: string;
} {
  const continuityMarker = '\n\n## Orchestration continuity';
  const stateMarker = '\n\n## Orchestration state';
  const continuityIdx = prompt.indexOf(continuityMarker);
  const stateIdx = prompt.indexOf(stateMarker);
  const marker = continuityIdx >= 0 ? continuityMarker : stateMarker;
  const idx = continuityIdx >= 0 ? continuityIdx : stateIdx;
  if (idx < 0) return { stable: prompt, orchestrationBlock: '' };
  const blockStart = idx + 2;
  const sectionSearchStart = continuityIdx >= 0 && stateIdx > continuityIdx
    ? stateIdx + stateMarker.length
    : blockStart + marker.trimStart().length;
  const nextSection = prompt.slice(sectionSearchStart).search(/\n\n#{2,3} /);
  const blockEnd = nextSection < 0
    ? prompt.length
    : sectionSearchStart + nextSection;
  return {
    stable: `${prompt.slice(0, idx)}${prompt.slice(blockEnd)}`.trim(),
    orchestrationBlock: prompt.slice(blockStart, blockEnd).trim(),
  };
}

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
  // Keep the response-language contract after the English-authored role,
  // workflow, runtime, and skill context. This makes the user's selected
  // language the final stable instruction instead of letting a later agent
  // workflow accidentally establish English as the response style.
  return `${withStableFragments}\n\n---\n\n${input.languageDirective}\n\n---\n\n${input.runtimeDatetimeBlock}`;
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
        'Automatic layout: follow `Output formats`; use text/Markdown for narrative or fixed replies, `:::dashboard` for static structured snapshots, and `create_artifact` only for user-operated results. No decorative rich output; explicit user constraints win.',
      ].join('\n');
  }
}

export type AgentInputChannel = 'form' | 'prose';

/** Render only the channel-specific shape. The shared Agent prompt owns the
 * sufficiency decision, schema extraction, stop point, and retry loop once. */
export function buildInputChannelProtocol(channel: AgentInputChannel): string {
  if (channel === 'prose') {
    return [
      '### Input channel: plain prose',
      '',
      'For a missing-input request, ask directly in plain language. Name options inline only for a closed choice, and make clear that a direct reply is enough.',
      '',
      '- Never emit an `<agent-input-form>` block; forms in earlier history are a retired protocol, not an example to follow.',
      '- A legacy `<agent-input-submission>` may still arrive for an old form; read its values like ordinary user text.',
    ].join('\n');
  }
  return [
    '### Input channel: form',
    '',
    'For a missing-input request, output exactly one `<agent-input-form>` block. Do not put ordinary prose questions after it. Plain-text questions, numbered question lists, and "please confirm/tell me" prose are not input channels.',
    '',
    'The block is an XML tag wrapping valid JSON, with tags on their own lines:',
    '',
    '```',
    '<agent-input-form>',
    '{',
    '  "fields": [',
    '    {"id": "<snake_case_id>", "label": "<label in user UI language>", "type": "text", "required": true}',
    '  ]',
    '}',
    '</agent-input-form>',
    '```',
    '',
    '- `agent_id` can be omitted; the system fills it in as you. If present, it must equal you.',
    '- Field types: `text` / `textarea` / `select` / `multiselect` / `number` / `boolean` / `file` / `directory`.',
    '- `select` / `multiselect` must include `options: [{value,label}]`; `number` may include `min`/`max`; `file` may include `accept`.',
    '- Prefer one plain question in a field label, or one `textarea` for free-form context, files, or examples; use multiple fields only for distinct typed values.',
    '- Do not replace the form with a "need these details" section.',
    '',
    'A reply arrives as `<agent-input-submission>`; use its values.',
  ].join('\n');
}

/** Add only the interactive-plan delta to the canonical input flow. */
export function buildPlanInteractionHint(interactive: boolean): string {
  if (!interactive) return '';
  return [
    '### Plan interaction',
    '',
    'In an interactive plan step, an insufficient-input reply contains only a brief blocker sentence, the required internal result marker, the channel-specific input request above, then `<plan-interaction status="open" />`.',
    'Keep the marker open on follow-up turns until inputs are sufficient. When the step is complete, include `<plan-interaction status="closed" />`.',
    'Do not add a recommendation, diagnosis, plan, report, or separate "needed information" section to an open reply.',
  ].join('\n');
}

/** Build the final response-language precedence without loading user state. */
export function buildLanguageDirectiveText(languageName: string): string {
  return [
    '## User language',
    '',
    `Fallback UI language: **${languageName}**.`,
    '',
    "Choose the response language in this order: (1) a current explicit user language request; (2) otherwise, the clear language of the user's latest substantive prose; (3) otherwise, the fallback UI language above.",
    '',
    'Quoted text, code, file contents, proper nouns, and earlier assistant messages do not switch the response language.',
    '',
    'Write all human-readable prose in the chosen language, including replies, status text, form labels, plan titles/inputs, and natural-language text inside XML/JSON fields.',
    '',
    'Keep protocol tokens unchanged: XML tag names, JSON keys, tool/skill ids or names, file paths, code, and `select` / `multiselect` `value` strings.',
    '',
    '`description_zh` is always Chinese and `description_en` is always English; examples show shape only, not output language.',
  ].join('\n');
}
