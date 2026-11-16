export type ParameterIssue = { field: string; reason: string; expected: string };
export function parameterErrorContent(message: string, issues?: ParameterIssue[], code?: string, details?: Record<string, unknown>): string;
export function formatParameterError(content: string, isError?: boolean): string;
export function parameterError(message: string, fields?: string[], reason?: string, details?: Record<string, unknown>, code?: string): { content: string; isError: true };
export function zodParameterError(issues: any[]): string;
