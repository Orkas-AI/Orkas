const CONTENT_WRITER_AGENT_ID = '173d4235a431';

const STARTS_WITH_COMPLETION_NOTICE = /^(?:(?:任务|卡片|正文|文章|文案|草稿|成稿|内容)(?:现已|已经|已)(?:全部)?(?:完成|交付)|(?:the\s+)?(?:task|cards?|copy|draft|article|post|content)\s+(?:is|are|has been|have been)\s+(?:complete|completed|delivered|done))/iu;
const REFERS_TO_MISSING_ARTIFACT = /(?:(?:以上|上面)(?:是|为).{0,100}(?:文章|文案|内容|草稿|成稿|帖子)|(?:按|依据).{0,40}(?:SKILL|规范).{0,50}(?:包含|完成)|(?:包含了?|包括).{0,50}(?:标题|CTA|话题标签|hashtags?)|(?:the\s+)?(?:above|preceding)\s+(?:article|copy|draft|post)|(?:it|the\s+(?:draft|article|post))\s+includes?.{0,50}(?:headline|CTA|hashtags?))/isu;

/**
 * Detect the narrow failure where ContentWriter announces completion and
 * describes an artifact that is not actually present. This deliberately has
 * no minimum-length or paragraph-count rule: short valid copy must pass.
 */
export function contentWriterTerminalTextGuard(text: string): string | null {
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

export function terminalTextGuardForAgent(
  agentId: string | undefined,
): ((text: string) => string | null) | undefined {
  return agentId === CONTENT_WRITER_AGENT_ID
    ? contentWriterTerminalTextGuard
    : undefined;
}
