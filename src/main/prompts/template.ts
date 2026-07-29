const TEMPLATE_RE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export type TemplateArgs = Record<string, string | number | boolean>;

/** Python string.Template-compatible safe substitution used by prompt files. */
export function safeSubstitute(body: string, args: TemplateArgs): string {
  return body.replace(TEMPLATE_RE, (match, _g1, braced: string | undefined, named: string | undefined) => {
    if (match === '$$') return '$';
    const key = braced || named;
    if (key && Object.prototype.hasOwnProperty.call(args, key)) {
      return String(args[key]);
    }
    return match;
  });
}
