import { createLogger } from '../../logger';

const log = createLogger('terminal-checks');

/**
 * Host-owned terminal delivery checks, selected per agent by the spec field
 * `agent.delivery_checks` (an array of registry names). Each check inspects
 * the model's terminal text and returns a one-shot correction string, or null
 * to accept. The core-agent runner applies whatever single function the host
 * supplies: at most one repair attempt, fail-open on throw, ship-anyway on a
 * second rejection — see `AgentRunParams.terminalTextGuard`.
 *
 * Checks live here as code, not in agent.json, on purpose: they are tuned
 * narrow matchers with accepted/rejected fixtures (`terminal-checks.test.ts`),
 * and regexes shipped as spec data could not keep those fixtures. The spec
 * declares WHICH checks an agent's deliveries must pass; the host owns WHAT
 * each check means. No check may key on an agent identity.
 */

const STARTS_WITH_COMPLETION_NOTICE = /^(?:(?:任务|卡片|正文|文章|文案|草稿|成稿|内容)(?:现已|已经|已)(?:全部)?(?:完成|交付)|(?:the\s+)?(?:task|cards?|copy|draft|article|post|content)\s+(?:is|are|has been|have been)\s+(?:complete|completed|delivered|done))/iu;
const REFERS_TO_MISSING_ARTIFACT = /(?:(?:以上|上面)(?:是|为).{0,100}(?:文章|文案|内容|草稿|成稿|帖子)|(?:按|依据).{0,40}(?:SKILL|规范).{0,50}(?:包含|完成)|(?:包含了?|包括).{0,50}(?:标题|CTA|话题标签|hashtags?)|(?:the\s+)?(?:above|preceding)\s+(?:article|copy|draft|post)|(?:it|the\s+(?:draft|article|post))\s+includes?.{0,50}(?:headline|CTA|hashtags?))/isu;

/**
 * `content-delivery`: the terminal reply announces completion and describes an
 * editorial artifact that is not actually present. Written from a real
 * ContentWriter failure (2026-08-08; fired and repaired in production on
 * 2026-08-05 logs). Deliberately has no minimum-length or paragraph-count
 * rule: short valid copy must pass, and plans/audits/questions are exempt via
 * the correction's own escape hatch.
 */
export function contentDeliveryCheck(text: string): string | null {
  const normalized = String(text || '').trim();
  if (!STARTS_WITH_COMPLETION_NOTICE.test(normalized) ||
      !REFERS_TO_MISSING_ARTIFACT.test(normalized)) {
    return null;
  }

  return [
    '你刚才的最终回复只是在宣告内容已完成，并没有实际交付成稿。',
    '这是一次性的软修复提示，不是长度门槛。请现在直接返回用户要求的完整成稿；',
    '不要返回计划/状态更新、内容清单或“见上文”式总结。',
    '如果用户实际要求的是计划、审核、提问或其他非成稿交付，则直接返回该交付物。',
  ].join('');
}

/** Registry of every terminal check an agent spec may name. */
export const TERMINAL_CHECKS: Readonly<Record<string, (text: string) => string | null>> = {
  'content-delivery': contentDeliveryCheck,
};

/**
 * Compose an agent's declared `delivery_checks` into the single guard function
 * the runner accepts, in declared order; the first correction wins. Unknown
 * names are skipped LOUDLY — a declared check that cannot run is a spec defect
 * the author needs to see, not silent degradation — and a builtin-content gate
 * additionally fails closed on them (`content-writer-builtin.test.ts`).
 * Returns undefined when nothing resolves so the runner path stays untouched
 * for the common no-checks case.
 */
export function resolveDeliveryChecks(
  names: readonly string[] | undefined,
): ((text: string) => string | null) | undefined {
  if (!names || names.length === 0) return undefined;
  const resolved: Array<(text: string) => string | null> = [];
  for (const name of names) {
    const check = TERMINAL_CHECKS[name];
    if (check) {
      resolved.push(check);
    } else {
      log.warn(
        `unknown delivery check "${name}" declared by agent spec; known: ${Object.keys(TERMINAL_CHECKS).join(', ')}`,
      );
    }
  }
  if (resolved.length === 0) return undefined;
  if (resolved.length === 1) return resolved[0];
  return (text: string) => {
    for (const check of resolved) {
      const correction = check(text);
      if (correction) return correction;
    }
    return null;
  };
}
