'use strict';

// Presentation only: executors still own compatibility, validation and effects.
const PARAMETER_CODES = new Set([
  'E_BAD_INPUT', 'E_PROGRAM_BAD_INPUT', 'E_PROGRAM_BAD_TOOL_INPUT',
  'PLAN_INPUT_UNSUPPORTED_FIELDS', 'PLAN_REQUIRED', 'PLAN_STATUS_INVALID', 'E_VIDEO_PARAMETERS_INVALID',
  'E_REFERENCE_INPUT', 'E_PRODUCT_CAPTURE_INPUT',
]);
const MAX_ISSUES = 16;
const bounded = (value, max) => String(value).slice(0, max);

function parameterErrorContent(message, issues, code = 'E_BAD_INPUT', details = {}) {
  const source = Array.isArray(issues) && issues.length ? issues : [
    { field: '$', reason: 'invalid_arguments', expected: message },
  ];
  return JSON.stringify({ ...details, code, message,
    issues: source.slice(0, MAX_ISSUES).map(issue => ({
      field: bounded(issue.field || '$', 160),
      reason: bounded(issue.reason || 'invalid_arguments', 80),
      expected: bounded(issue.expected || message, 512),
    })),
    ...(source.length > MAX_ISSUES ? { issues_truncated: true, issue_count: source.length } : {}),
  });
}

/** Only complete, explicit error protocols; never classify by prose or inputs. */
function formatParameterError(content, isError) {
  if (!isError || typeof content !== 'string' || content.length > 65536) return content;
  let value;
  try { value = JSON.parse(content); } catch { /* Legacy explicit error protocols below. */ }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const code = value.code || value.errorCode || value.error_code || value.error?.code || value.reason;
    if (!PARAMETER_CODES.has(code)) return content;
    if (Array.isArray(value.issues) && value.issues.length) return content;
    const message = value.message || value.error?.message || (typeof value.error === 'string' ? value.error : content);
    return parameterErrorContent(message, undefined, code, value);
  }
  const match = /^(E_BAD_INPUT|E_PROGRAM_BAD_INPUT|E_PROGRAM_BAD_TOOL_INPUT|PLAN_INPUT_UNSUPPORTED_FIELDS): ([\s\S]+)$/.exec(content)
    || /^<tool-error code="(E_BAD_INPUT|E_PROGRAM_BAD_INPUT|E_PROGRAM_BAD_TOOL_INPUT|PLAN_INPUT_UNSUPPORTED_FIELDS)">([\s\S]*)<\/tool-error>$/.exec(content);
  return match ? parameterErrorContent(match[2], undefined, match[1]) : content;
}

/** Called only with the owning Zod validator's structured issues. No values. */
function zodParameterError(issues) {
  return parameterErrorContent('Invalid tool arguments.', issues.flatMap(issue => {
    const parts = (issue.path || []).map(part => typeof part === 'object' ? part.key : part);
    const field = parts.length ? parts.map(String).join('.') : '$';
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map(key => ({ field: field === '$' ? key : `${field}.${key}`, reason: 'unsupported_field', expected: 'Only declared fields are accepted here.' }));
    }
    // Zod messages describe constraints; do not echo received argument values.
    let expected = issue.message || (issue.expected ? `Expected ${issue.expected === 'int' ? 'integer' : issue.expected}.` : 'Use the declared parameter schema.');
    if (!issue.message) {
      if (issue.code === 'invalid_value') expected = `Allowed values: ${JSON.stringify(issue.values)}.`;
      if (issue.code === 'too_small') expected = `Minimum: ${issue.minimum}; inclusive: ${issue.inclusive}.`;
      if (issue.code === 'too_big') expected = `Maximum: ${issue.maximum}; inclusive: ${issue.inclusive}.`;
    }
    return [{ field, reason: issue.code, expected }];
  }));
}

exports.parameterErrorContent = parameterErrorContent;
exports.parameterError = (message, fields = [], reason = 'invalid_arguments', details = {}, code = 'E_BAD_INPUT') => ({
  content: parameterErrorContent(message, fields.map(field => ({ field, reason, expected: message })), code, details),
  isError: true,
});
exports.formatParameterError = formatParameterError;
exports.zodParameterError = zodParameterError;
