/** Load code only. Keep the provider registry, clients and request path untouched.
 * Other SDK families retain demand loading until their idle cost is verified. */
export async function preloadModelApi(api: string, shouldContinue: () => boolean = () => true): Promise<boolean> {
  // Public SDK entry points split linking into smaller batches. Each batch
  // shares the ordinary ESM cache, and input/foreground work can stop the
  // remaining preparation at the next event-loop turn.
  const steps: Array<() => Promise<unknown>> = api === 'anthropic-messages' ? [
    () => import('@anthropic-ai/sdk/resources'),
    () => import('@anthropic-ai/sdk/client'),
  ] : ['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(api) ? [
    () => import('openai/resources'),
    () => import('openai/client'),
  ] : [];
  for (const load of steps) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!shouldContinue()) return false;
    await load();
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (!shouldContinue()) return false;
  switch (api) {
    case 'anthropic-messages': await import('@earendil-works/pi-ai/api/anthropic-messages'); break;
    case 'openai-completions': await import('@earendil-works/pi-ai/api/openai-completions'); break;
    case 'openai-responses': await import('@earendil-works/pi-ai/api/openai-responses'); break;
    case 'openai-codex-responses': await import('@earendil-works/pi-ai/api/openai-codex-responses'); break;
    case 'azure-openai-responses': await import('@earendil-works/pi-ai/api/azure-openai-responses'); break;
    default: return false;
  }
  return true;
}
