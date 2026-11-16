/** Invocation policy owned by applications, not by an Agent's authored workflow. */
import { appConversationOwner } from '../paths';
import { prompts } from '../prompts/loader';

export function isDirectAppTask(cid: string | undefined): boolean {
  return !!cid && appConversationOwner(cid)?.keepSession === false;
}

export function appTaskExecutionGuidance(cid: string): string {
  return isDirectAppTask(cid) ? prompts.load('app_task_execution').trim() : '';
}

export function withAppTaskExecution(prompt: string, cid: string): string {
  const guidance = appTaskExecutionGuidance(cid);
  if (!guidance) return prompt;
  // Keep the original role/workflow and final language/date placement intact.
  const boundary = prompt.lastIndexOf('\n\n---\n\n## User language');
  return boundary < 0 ? `${prompt}\n\n${guidance}`
    : `${prompt.slice(0, boundary)}\n\n${guidance}${prompt.slice(boundary)}`;
}
