/**
 * Fixed-script DOM adapter for the isolated Web Assist page.
 *
 * Model input is serialized as data into reviewed scripts; callers cannot
 * provide JavaScript. Element paths stay in main-process memory and the model
 * receives only short snapshot-scoped references.
 */

export type WebAssistPageAction =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'scroll';

export interface WebAssistElementSignature {
  tag: string;
  type: string;
  role: string;
  label: string;
}

export interface WebAssistRawElement {
  path: number[];
  signature: WebAssistElementSignature;
  tag: string;
  role: string;
  label: string;
  input_type: string;
  placeholder: string;
  href: string;
  disabled: boolean;
  checked: boolean | null;
  sensitive: boolean;
  fillable: boolean;
  requires_user_action: boolean;
  options: string[];
}

export interface WebAssistRawObservation {
  ok: true;
  title: string;
  document_kind?: 'non_html';
  content_type?: string;
  text: string;
  text_offset: number;
  text_total: number;
  text_next_offset: number | null;
  elements: WebAssistRawElement[];
  element_offset: number;
  element_count: number;
  element_next_offset: number | null;
  elements_truncated: boolean;
  text_truncated: boolean;
}

export interface WebAssistStoredElementRef {
  path: number[];
  signature: WebAssistElementSignature;
}

export type WebAssistPageScope = 'browser' | 'connector_setup';

/** Where in the page a caller wants to read from. Per-call size does not
 *  change; these only move the window, so the default reply is what it was. */
export interface WebAssistObserveWindow {
  textOffset?: number;
  elementOffset?: number;
}

function safeOffset(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// The host selects the existing controller contract; page/model data cannot widen it.
export function webAssistObserveScript(
  scope: WebAssistPageScope = 'browser',
  window: WebAssistObserveWindow = {},
): string {
  return String.raw`
(() => {
  const protectHighImpactActions = ${scope !== 'connector_setup'};
  const MAX_ELEMENTS = 80;
  const MAX_TEXT = 6000;
  const TEXT_FROM = ${safeOffset(window.textOffset)};
  const ELEMENT_FROM = ${safeOffset(window.elementOffset)};
  const normalize = (value, cap = 240) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelFor = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    return normalize(
      element.getAttribute('aria-label')
      || labels.join(' ')
      || (element.tagName !== 'TEXTAREA' && !element.isContentEditable ? element.innerText : '')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.getAttribute('alt')
      || element.getAttribute('name')
      || element.tagName,
    );
  };
  const structuralPath = (element) => {
    const path = [];
    let node = element;
    while (node && node !== document) {
      const parent = node.parentNode;
      if (!parent) return [];
      const children = parent.children ? Array.from(parent.children) : [];
      const index = children.indexOf(node);
      if (index < 0) return [];
      path.unshift(index);
      if (parent instanceof ShadowRoot) {
        path.unshift(-1);
        node = parent.host;
      } else {
        node = parent;
      }
    }
    return path;
  };
  const sensitiveControl = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input') return false;
    const type = String(element.type || '').toLowerCase();
    const autocomplete = String(element.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
    return type === 'password'
      || autocomplete.includes('current-password')
      || autocomplete.includes('new-password')
      || autocomplete.includes('one-time-code')
      || autocomplete.some((token) => token.startsWith('cc-'));
  };
  const submitControl = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = String(element.type || '').toLowerCase();
    return (tag === 'button' && type === 'submit')
      || (tag === 'input' && (type === 'submit' || type === 'image'));
  };
  const highImpactControl = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = String(element.getAttribute('role') || '').toLowerCase();
    if (!['a', 'button', 'input'].includes(tag) && !['button', 'link', 'menuitem'].includes(role)) return false;
    const label = labelFor(element).toLowerCase();
    const terms = [
      'delete', 'remove', 'buy', 'purchase', 'pay', 'checkout', 'place order',
      'post', 'publish', 'authorize', 'approve',
      'grant access', 'allow access', 'transfer', 'trade', 'book',
      'reserve', 'subscribe', 'unsubscribe', 'cancel subscription', 'captcha',
      '删除', '移除', '购买', '支付', '下单', '结账', '发布',
      '授权', '同意', '转账', '交易', '预订', '预约', '验证码',
      '削除', '購入', '支払', '注文', '公開', '投稿', '承認',
      '振込', '予約', 'excluir', 'remover', 'comprar', 'pagar',
      'finalizar pedido', 'publicar', 'autorizar',
      'aprovar', 'transferir', 'reservar',
    ];
    return terms.some((term) => label.includes(term));
  };
  const sensitiveFormSubmission = (element) => {
    if (!submitControl(element) || !element.form || !element.form.elements) return false;
    return Array.from(element.form.elements).some((control) => (
      control instanceof Element && sensitiveControl(control)
    ));
  };
  const selectors = [
    'a[href]', 'button', 'input', 'select', 'textarea', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
    '[role="treeitem"]', '[role="option"]', '[role="switch"]', '[role="menuitemcheckbox"]',
  ].join(',');
  const candidates = [];
  const seen = new Set();
  const collect = (root) => {
    for (const element of root.querySelectorAll(selectors)) {
      if (seen.has(element)) continue;
      seen.add(element);
      candidates.push(element);
      if (element.shadowRoot) collect(element.shadowRoot);
    }
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) collect(host.shadowRoot);
    }
  };
  collect(document);
  const rows = [];
  for (const element of candidates) {
    if (!isVisible(element)) continue;
    const path = structuralPath(element);
    if (!path.length) continue;
    const tag = element.tagName.toLowerCase();
    const role = normalize(element.getAttribute('role'), 40);
    const inputType = normalize(element.getAttribute('type') || element.type, 40).toLowerCase();
    const label = labelFor(element);
    const sensitive = sensitiveControl(element);
    const isFile = tag === 'input' && inputType === 'file';
    const fillable = !sensitive && !isFile && !element.readOnly && (
      tag === 'textarea'
      || element.isContentEditable
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(inputType))
    );
    let href = '';
    if (tag === 'a' && element.href) {
      try {
        const parsed = new URL(element.href, location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          href = normalize(parsed.origin + parsed.pathname, 320);
        }
      } catch { /* omit malformed link */ }
    }
    const options = tag === 'select'
      ? Array.from(element.options || []).slice(0, 30).map((option) => normalize(option.label || option.text, 160))
      : [];
    rows.push({
      path,
      signature: { tag, type: inputType, role, label },
      tag,
      role,
      label,
      input_type: inputType,
      placeholder: normalize(element.getAttribute('placeholder'), 160),
      href,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      checked: (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio'))
        ? Boolean(element.checked)
        : null,
      sensitive,
      fillable,
      requires_user_action: sensitive || isFile || sensitiveFormSubmission(element)
        || (protectHighImpactActions && highImpactControl(element)),
      options,
    });
  }
  // A document that is not HTML *is* its payload. The code/pre strip further
  // down is aimed at a code block someone embedded in a page; applying it to a
  // whole JSON or text document made that entire class read as a blank page,
  // which a caller could not tell from a page that genuinely had nothing.
  // Form values — the other half of that mitigation and the load-bearing half —
  // do not exist in such a document, so nothing is weakened by reading it.
  //
  // Chromium renders JSON and text/plain into a single <pre>. XML gets a tree
  // viewer with no such element, so that reports the kind and no payload rather
  // than pretending; CSV and octet-stream are downloads and never arrive here.
  const contentType = String(document.contentType || '').toLowerCase();
  if (contentType && contentType.indexOf('html') < 0) {
    const holder = document.querySelector('pre');
    // Strip control characters but keep newlines and tabs: the shape of a
    // document is part of reading it.
    const payload = holder
      ? String(holder.textContent || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      : '';
    const from = Math.min(TEXT_FROM, payload.length);
    const chunk = payload.slice(from, from + MAX_TEXT);
    const chunkEnd = from + chunk.length;
    return {
      ok: true,
      title: normalize(document.title, 240),
      document_kind: 'non_html',
      content_type: normalize(contentType, 80),
      text: chunk,
      text_offset: from,
      text_total: payload.length,
      text_next_offset: chunkEnd < payload.length ? chunkEnd : null,
      text_truncated: chunkEnd < payload.length,
      elements: [],
      element_offset: 0,
      element_count: 0,
      element_next_offset: null,
      elements_truncated: false,
    };
  }
  // Read each visible text node once, including table cells, ordinary divs and
  // open shadow roots. Ancestor textContent duplicated nested rows and included
  // hidden descendants; a tag whitelist silently dropped most console data.
  // Keep form/code subtrees excluded, and retain block/row and cell boundaries.
  const parts = [];
  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'INPUT', 'TEXTAREA', 'SELECT']);
  const stack = document.body ? [{ node: document.body, hidden: false }] : [];
  const visited = new Set();
  while (stack.length) {
    const entry = stack.pop();
    if (entry.separator) { parts.push(entry.separator); continue; }
    const node = entry.node;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.nodeType === 3) {
      if (!entry.hidden) parts.push(String(node.nodeValue || '').replace(/[\u0000-\u0020\u007f]+/g, ' '));
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (skippedTags.has(node.tagName) || node.isContentEditable) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.contentVisibility === 'hidden') continue;
    const hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
    const role = node.getAttribute('role');
    const separator = (style.display === 'table-cell' || role === 'cell' || role === 'gridcell' || role === 'columnheader') ? '\t'
      : (node.tagName === 'BR' || ['block', 'flex', 'grid', 'list-item', 'table-row'].includes(style.display) || role === 'row') ? '\n' : '';
    if (separator) parts.push(separator);
    if (separator) stack.push({ separator });
    // A shadow host's rendered children replace its light DOM. Slots expose
    // assigned nodes, with the ordinary fallback when nothing is assigned.
    let children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) children = assigned;
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], hidden });
  }
  const joined = parts.join('').replace(/ *\t */g, '\t').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const textFrom = Math.min(TEXT_FROM, joined.length);
  const text = joined.slice(textFrom, textFrom + MAX_TEXT);
  const textEnd = textFrom + text.length;
  const elementFrom = Math.min(ELEMENT_FROM, rows.length);
  const elements = rows.slice(elementFrom, elementFrom + MAX_ELEMENTS);
  const elementEnd = elementFrom + elements.length;
  return {
    ok: true,
    title: normalize(document.title, 240),
    text,
    text_offset: textFrom,
    text_total: joined.length,
    text_next_offset: textEnd < joined.length ? textEnd : null,
    elements,
    element_offset: elementFrom,
    element_count: rows.length,
    element_next_offset: elementEnd < rows.length ? elementEnd : null,
    elements_truncated: elementEnd < rows.length,
    text_truncated: textEnd < joined.length,
  };
})()
`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildWebAssistActionScript(input: {
  ref?: WebAssistStoredElementRef;
  action: WebAssistPageAction;
  text?: string;
  direction?: 'up' | 'down' | 'top' | 'bottom';
}, scope: WebAssistPageScope = 'browser', options: {
  /** The user approved this exact control for this page in a host dialog. */
  grantedProtectedAction?: boolean;
} = {}): string {
  const payload = scriptJson(input);
  return String.raw`
(() => {
  const request = ${payload};
  const protectHighImpactActions = ${scope !== 'connector_setup'};
  const grantedProtectedAction = ${options.grantedProtectedAction === true};
  const normalize = (value, cap = 240) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
  const resolvePath = (path) => {
    let node = document;
    for (const segment of path) {
      if (segment === -1) {
        if (!node || !node.shadowRoot) return null;
        node = node.shadowRoot;
        continue;
      }
      if (!node || !node.children || !node.children[segment]) return null;
      node = node.children[segment];
    }
    return node instanceof Element ? node : null;
  };
  const labelFor = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    return normalize(
      element.getAttribute('aria-label')
      || labels.join(' ')
      || (element.tagName !== 'TEXTAREA' && !element.isContentEditable ? element.innerText : '')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.getAttribute('alt')
      || element.getAttribute('name')
      || element.tagName,
    );
  };
  const sensitiveControl = (element) => {
    if (element.tagName.toLowerCase() !== 'input') return false;
    const type = String(element.type || '').toLowerCase();
    const autocomplete = String(element.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
    return type === 'password'
      || autocomplete.includes('current-password')
      || autocomplete.includes('new-password')
      || autocomplete.includes('one-time-code')
      || autocomplete.some((token) => token.startsWith('cc-'));
  };
  const submitControl = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = String(element.type || '').toLowerCase();
    return (tag === 'button' && type === 'submit')
      || (tag === 'input' && (type === 'submit' || type === 'image'));
  };
  const highImpactControl = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = String(element.getAttribute('role') || '').toLowerCase();
    if (!['a', 'button', 'input'].includes(tag) && !['button', 'link', 'menuitem'].includes(role)) return false;
    const label = labelFor(element).toLowerCase();
    const terms = [
      'delete', 'remove', 'buy', 'purchase', 'pay', 'checkout', 'place order',
      'post', 'publish', 'authorize', 'approve',
      'grant access', 'allow access', 'transfer', 'trade', 'book',
      'reserve', 'subscribe', 'unsubscribe', 'cancel subscription', 'captcha',
      '删除', '移除', '购买', '支付', '下单', '结账', '发布',
      '授权', '同意', '转账', '交易', '预订', '预约', '验证码',
      '削除', '購入', '支払', '注文', '公開', '投稿', '承認',
      '振込', '予約', 'excluir', 'remover', 'comprar', 'pagar',
      'finalizar pedido', 'publicar', 'autorizar',
      'aprovar', 'transferir', 'reservar',
    ];
    return terms.some((term) => label.includes(term));
  };
  const sensitiveFormSubmission = (element) => {
    if (!submitControl(element) || !element.form || !element.form.elements) return false;
    return Array.from(element.form.elements).some((control) => (
      control instanceof Element && sensitiveControl(control)
    ));
  };
  if (request.action === 'scroll') {
    const distance = Math.max(240, Math.floor(window.innerHeight * 0.72));
    if (request.direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (request.direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    else window.scrollBy({ top: request.direction === 'up' ? -distance : distance, behavior: 'smooth' });
    return { ok: true, outcome: 'acted', action: request.action };
  }
  const element = resolvePath(request.ref.path);
  if (!element) return { ok: false, code: 'stale_element', error: 'The page changed; observe it again.' };
  const current = {
    tag: element.tagName.toLowerCase(),
    type: normalize(element.getAttribute('type') || element.type, 40).toLowerCase(),
    role: normalize(element.getAttribute('role'), 40),
    label: labelFor(element),
  };
  const expected = request.ref.signature;
  if (current.tag !== expected.tag || current.type !== expected.type || current.role !== expected.role
      || (expected.label && current.label !== expected.label)) {
    return { ok: false, code: 'stale_element', error: 'The page changed; observe it again.' };
  }
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
    return { ok: false, code: 'element_disabled', error: 'This element is disabled.' };
  }
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (request.action === 'click') {
    const isFile = current.tag === 'input' && current.type === 'file';
    // Ordinary submissions run on their own; what is left for the user is a
    // high-impact control, and a host approval releases exactly that. It never
    // releases a submission carrying a password, OTP or card number.
    const isSubmission = sensitiveFormSubmission(element);
    const isHighImpact = protectHighImpactActions && !grantedProtectedAction && highImpactControl(element);
    if (isFile || isSubmission || isHighImpact) {
      return {
        ok: false,
        code: 'user_action_required',
        reason: isFile
          ? 'file_upload'
          : (isHighImpact ? 'high_impact_action'
            : 'sensitive_form_submission'),
        error: 'The user must complete this action directly in Web Assist.',
      };
    }
    element.focus();
    element.click();
    return { ok: true, outcome: 'acted', action: request.action };
  }
  if (request.action === 'fill') {
    if (sensitiveControl(element)) {
      return {
        ok: false,
        code: 'user_action_required',
        reason: 'sensitive_input',
        error: 'The user must enter this value directly in Web Assist.',
      };
    }
    const text = String(request.text == null ? '' : request.text);
    const inputFillable = current.tag === 'input'
      && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(current.type);
    if (!inputFillable && current.tag !== 'textarea' && !element.isContentEditable) {
      return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
    }
    if (element.readOnly) return { ok: false, code: 'element_readonly', error: 'This field is read-only.' };
    // Focus handlers can restore a controlled field from its component state.
    // Focus first, then recheck the target before changing any text.
    element.focus();
    const active = element.getRootNode().activeElement;
    if (active !== element || !element.isConnected || sensitiveControl(element)
        || element.disabled || element.readOnly || String(element.type || '').toLowerCase() !== current.type) {
      return { ok: false, code: 'stale_element', error: 'The field changed while focusing; observe it again.' };
    }
    const textEntry = current.tag === 'textarea' || element.isContentEditable
      || (current.tag === 'input' && ['text', 'search', 'tel', 'url', 'email', 'number'].includes(current.type));
    if (textEntry) {
      if (element.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else element.select();
      // Chromium's editing command emits the native InputEvent understood by
      // controlled inputs and editors. It stays in this reviewed, synchronous
      // script so a focus change cannot redirect a later host insertText call.
      const edited = document.execCommand(text ? 'insertText' : 'delete', false, text);
      if (!edited) return { ok: false, code: 'fill_rejected', error: 'The page did not accept the edit; observe it again.' };
    } else if (current.tag === 'textarea' || current.tag === 'input') {
      const proto = current.tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
      setter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
    }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return Promise.resolve().then(() => {
      const actual = element.isContentEditable ? element.innerText : element.value;
      if (!element.isConnected || actual !== text) {
        return { ok: false, code: 'fill_rejected', error: 'The page did not retain the requested text; observe it again.' };
      }
      return { ok: true, outcome: 'acted', action: request.action };
    });
  }
  if (request.action === 'select') {
    if (current.tag !== 'select') return { ok: false, code: 'unsupported_element', error: 'This is not a select field.' };
    const expectedOption = String(request.text == null ? '' : request.text);
    const options = Array.from(element.options || []);
    const matches = options.filter((option) => normalize(option.label || option.text, 160) === expectedOption || option.value === expectedOption);
    if (matches.length !== 1) return { ok: false, code: 'option_not_unique', error: 'Choose one exact option from a fresh observation.' };
    element.value = matches[0].value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, outcome: 'acted', action: request.action };
  }
  if (request.action === 'check' || request.action === 'uncheck') {
    if (current.tag !== 'input' || !['checkbox', 'radio'].includes(current.type)) {
      return { ok: false, code: 'unsupported_element', error: 'This is not a checkbox or radio control.' };
    }
    const desired = request.action === 'check';
    if (current.type === 'radio' && !desired) {
      return { ok: false, code: 'unsupported_element', error: 'A radio control cannot be unchecked directly.' };
    }
    if (Boolean(element.checked) !== desired) {
      if (protectHighImpactActions && !grantedProtectedAction && highImpactControl(element)) {
        return {
          ok: false,
          code: 'user_action_required',
          reason: 'high_impact_action',
          error: 'The user must complete this action directly in Web Assist.',
        };
      }
      element.click();
    }
    return { ok: true, outcome: 'acted', action: request.action };
  }
  return { ok: false, code: 'invalid_action', error: 'Unsupported page action.' };
})()
`;
}

export function buildWebAssistTextConditionScript(text: string): string {
  const expected = scriptJson(text);
  return String.raw`
(() => {
  const expected = String(${expected}).replace(/\s+/g, ' ').trim();
  const body = String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
  return expected.length > 0 && body.includes(expected);
})()
`;
}

export function sanitizeWebAssistObservation(
  raw: unknown,
  pageId: string,
  displayUrl: string,
): {
  publicSnapshot: Record<string, unknown>;
  refs: Map<string, WebAssistStoredElementRef>;
  /** Every link this observation actually showed. A later navigation to one of
   *  them followed the page; a destination absent from this set was composed by
   *  the caller, which is the shape an exfiltration attempt has to take. */
  hrefs: Set<string>;
} | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const source = raw as Partial<WebAssistRawObservation>;
  const rows = Array.isArray(source.elements) ? source.elements.slice(0, 80) : [];
  const elementOffset = Math.max(0, Math.floor(Number(source.element_offset)) || 0);
  const refs = new Map<string, WebAssistStoredElementRef>();
  const hrefs = new Set<string>();
  for (const row of rows) {
    const href = row && typeof row.href === 'string' ? row.href.trim() : '';
    if (href) hrefs.add(href.slice(0, 320));
  }
  const elements = rows.flatMap((row, index) => {
    if (!row || !Array.isArray(row.path) || !row.signature) return [];
    const ref = `e${elementOffset + index + 1}`;
    refs.set(ref, {
      path: row.path.filter((part) => Number.isInteger(part)).slice(0, 80),
      signature: {
        tag: String(row.signature.tag || '').slice(0, 40),
        type: String(row.signature.type || '').slice(0, 40),
        role: String(row.signature.role || '').slice(0, 40),
        label: String(row.signature.label || '').slice(0, 240),
      },
    });
    return [{
      ref,
      tag: String(row.tag || '').slice(0, 40),
      role: String(row.role || '').slice(0, 40),
      label: String(row.label || '').slice(0, 240),
      input_type: String(row.input_type || '').slice(0, 40),
      placeholder: String(row.placeholder || '').slice(0, 160),
      href: String(row.href || '').slice(0, 320),
      disabled: row.disabled === true,
      checked: typeof row.checked === 'boolean' ? row.checked : null,
      sensitive: row.sensitive === true,
      fillable: row.fillable === true,
      requires_user_action: row.requires_user_action === true,
      options: Array.isArray(row.options)
        ? row.options.slice(0, 30).map((option) => String(option).slice(0, 160))
        : [],
    }];
  });
  return {
    publicSnapshot: {
      page_id: pageId,
      title: String(source.title || '').slice(0, 240),
      display_url: displayUrl,
      ...(source.document_kind === 'non_html'
        ? {
          document_kind: 'non_html',
          content_type: String(source.content_type || '').slice(0, 80),
        }
        : {}),
      text: String(source.text || '').slice(0, 6000),
      text_offset: Math.max(0, Math.floor(Number(source.text_offset)) || 0),
      text_total: Math.max(0, Math.floor(Number(source.text_total)) || 0),
      text_truncated: source.text_truncated === true,
      ...(Number.isFinite(Number(source.text_next_offset)) && source.text_next_offset !== null
        ? { text_next_offset: Math.max(0, Math.floor(Number(source.text_next_offset))) }
        : {}),
      elements,
      element_offset: elementOffset,
      element_count: Math.max(elements.length + elementOffset, Number(source.element_count) || 0),
      elements_truncated: source.elements_truncated === true,
      ...(Number.isFinite(Number(source.element_next_offset)) && source.element_next_offset !== null
        ? { element_next_offset: Math.max(0, Math.floor(Number(source.element_next_offset))) }
        : {}),
      untrusted_content: true,
    },
    refs,
    hrefs,
  };
}
