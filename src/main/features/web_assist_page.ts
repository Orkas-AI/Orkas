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
  text: string;
  elements: WebAssistRawElement[];
  element_count: number;
  elements_truncated: boolean;
  text_truncated: boolean;
}

export interface WebAssistStoredElementRef {
  path: number[];
  signature: WebAssistElementSignature;
}

export type WebAssistPageScope = 'browser' | 'connector_setup';

// The host selects the existing controller contract; page/model data cannot widen it.
export function webAssistObserveScript(scope: WebAssistPageScope = 'browser'): string {
  return String.raw`
(() => {
  const protectSubmissions = ${scope !== 'connector_setup'};
  const MAX_ELEMENTS = 80;
  const MAX_TEXT = 6000;
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
      || element.innerText
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
      'send', 'post', 'publish', 'submit', 'apply', 'authorize', 'approve',
      'grant access', 'allow access', 'confirm', 'transfer', 'trade', 'book',
      'reserve', 'subscribe', 'unsubscribe', 'cancel subscription', 'captcha',
      '删除', '移除', '购买', '支付', '下单', '结账', '发送', '发布', '提交',
      '申请', '授权', '同意', '确认', '转账', '交易', '预订', '预约', '验证码',
      '削除', '購入', '支払', '注文', '送信', '公開', '投稿', '申請', '承認',
      '確認', '振込', '予約', 'excluir', 'remover', 'comprar', 'pagar',
      'finalizar pedido', 'enviar', 'publicar', 'submeter', 'autorizar',
      'aprovar', 'confirmar', 'transferir', 'reservar',
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
    const fillable = !sensitive && !isFile && (
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
      requires_user_action: sensitive || isFile || (protectSubmissions
        ? submitControl(element) || highImpactControl(element)
        : sensitiveFormSubmission(element)),
      options,
    });
  }
  const textBlocks = [];
  for (const block of document.querySelectorAll('h1,h2,h3,h4,p,[role="heading"],[role="alert"],[role="status"]')) {
    if (!isVisible(block) || block.closest('code,pre,kbd,samp')) continue;
    const clone = block.cloneNode(true);
    for (const sensitiveChild of clone.querySelectorAll('code,pre,kbd,samp,input,textarea,select,[contenteditable="true"]')) {
      sensitiveChild.remove();
    }
    const text = normalize(clone.textContent, 1000);
    if (text) textBlocks.push(text);
  }
  const rawText = normalize(textBlocks.join(' '), 12000);
  return {
    ok: true,
    title: normalize(document.title, 240),
    text: rawText.slice(0, MAX_TEXT),
    elements: rows.slice(0, MAX_ELEMENTS),
    element_count: rows.length,
    elements_truncated: rows.length > MAX_ELEMENTS,
    text_truncated: rawText.length > MAX_TEXT,
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
}, scope: WebAssistPageScope = 'browser'): string {
  const payload = scriptJson(input);
  return String.raw`
(() => {
  const request = ${payload};
  const protectSubmissions = ${scope !== 'connector_setup'};
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
      || element.innerText
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
      'send', 'post', 'publish', 'submit', 'apply', 'authorize', 'approve',
      'grant access', 'allow access', 'confirm', 'transfer', 'trade', 'book',
      'reserve', 'subscribe', 'unsubscribe', 'cancel subscription', 'captcha',
      '删除', '移除', '购买', '支付', '下单', '结账', '发送', '发布', '提交',
      '申请', '授权', '同意', '确认', '转账', '交易', '预订', '预约', '验证码',
      '削除', '購入', '支払', '注文', '送信', '公開', '投稿', '申請', '承認',
      '確認', '振込', '予約', 'excluir', 'remover', 'comprar', 'pagar',
      'finalizar pedido', 'enviar', 'publicar', 'submeter', 'autorizar',
      'aprovar', 'confirmar', 'transferir', 'reservar',
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
    const isSubmission = protectSubmissions ? submitControl(element) : sensitiveFormSubmission(element);
    const isHighImpact = protectSubmissions && highImpactControl(element);
    if (isFile || isSubmission || isHighImpact) {
      return {
        ok: false,
        code: 'user_action_required',
        reason: isFile
          ? 'file_upload'
          : (isHighImpact ? 'high_impact_action'
            : (protectSubmissions ? 'form_submission_or_authorization' : 'sensitive_form_submission')),
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
    if (current.tag === 'textarea' || current.tag === 'input') {
      const proto = current.tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
      setter.call(element, text);
    } else if (element.isContentEditable) {
      element.textContent = text;
    } else {
      return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
    }
    element.focus();
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, outcome: 'acted', action: request.action };
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
    if (Boolean(element.checked) !== desired) element.click();
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
} | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const source = raw as Partial<WebAssistRawObservation>;
  const rows = Array.isArray(source.elements) ? source.elements.slice(0, 80) : [];
  const refs = new Map<string, WebAssistStoredElementRef>();
  const elements = rows.flatMap((row, index) => {
    if (!row || !Array.isArray(row.path) || !row.signature) return [];
    const ref = `e${index + 1}`;
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
      text: String(source.text || '').slice(0, 6000),
      text_truncated: source.text_truncated === true,
      elements,
      element_count: Math.max(elements.length, Number(source.element_count) || 0),
      elements_truncated: source.elements_truncated === true,
      untrusted_content: true,
    },
    refs,
  };
}
