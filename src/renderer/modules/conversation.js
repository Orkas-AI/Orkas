const _convLog = createLogger('conversation');
let _conversationInlineRenameCid = null;
let _conversationHeaderRenameCid = null;
let _conversationBucketDateKey = _conversationLocalDateKey();
let _conversationBucketDateRefreshTimer = null;
let _conversationBucketDateRefreshBound = false;

function _trackConversationManageResult(action, startedAt, result, errorCode = '', extra = {}) {
  const payload = {
    action: String(action || 'unknown'),
    result: String(result || 'failure'),
    duration_ms: Math.max(0, Date.now() - startedAt),
    ...(errorCode ? { error_code: String(errorCode) } : {}),
    ...(extra || {}),
  };
  try {
    const level = result === 'failure' ? 'warn' : 'info';
    _convLog[level]('conversation management result', payload);
  } catch (_) {}
}

function _convTrackClick(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _convTrackEvent(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _convTrackError(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _trackAgentRunResultTelemetry(cid, evData) {
  void cid;
  void evData;
}

function _trimTelemetryText(value, max) {
  const text = _normalizeFeedbackFieldText(value);
  const limit = Math.max(0, Number(max) || 0);
  if (!text || limit <= 0 || text.length <= limit) return text;
  return text.slice(0, limit) + '...';
}

function _handleModelOutputErrorForUi(cid, msgDiv, rawError, extra) {
  void cid;
  void msgDiv;
  void rawError;
  void extra;
}

function _uiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') return window.uiIconHtml(name, className || 'ui-icon');
  return '';
}

function _conversationLocalDateKey(now) {
  const d = now instanceof Date ? now : (now == null ? new Date() : new Date(now));
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _refreshConversationBucketsForDateChange(now) {
  const nextKey = _conversationLocalDateKey(now);
  if (!nextKey || nextKey === _conversationBucketDateKey) return false;
  _conversationBucketDateKey = nextKey;
  if (typeof renderConversationList === 'function') renderConversationList();
  return true;
}

function _scheduleConversationBucketDateRefresh() {
  if (_conversationBucketDateRefreshTimer) clearTimeout(_conversationBucketDateRefreshTimer);
  _conversationBucketDateRefreshTimer = setTimeout(() => {
    _conversationBucketDateRefreshTimer = null;
    _refreshConversationBucketsForDateChange();
  }, 100);
}

function _bindConversationBucketDateRefresh() {
  if (_conversationBucketDateRefreshBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  _conversationBucketDateRefreshBound = true;
  window.addEventListener('focus', _scheduleConversationBucketDateRefresh);
  window.addEventListener('pageshow', _scheduleConversationBucketDateRefresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _scheduleConversationBucketDateRefresh();
  });
}

_bindConversationBucketDateRefresh();

// ─── @-mention highlighting (post-render DOM walk) ────────────────────────
// Wrap `@<token>` matches in a `<span class="msg-mention">` so the chat
// bubbles paint mentions in accent color. Done after markdown render via a
// TreeWalker so we don't double-process inside `<code>` / `<pre>` / `<a>`
// (links and code are protected — markdown owners).
//
// Names that contain whitespace or punctuation (e.g. "Software Requirements
// Analyst") can't fit in a static char-class regex. We resolve this by
// dynamically building the regex per call, alternating known agent names
// (longest-first so "Software Requirements Analyst" wins over "Software")
// with the fallback ASCII+CJK token. The fallback handles unknown / partial
// mentions and also matches the bus router's mention parser.
const _MENTION_FALLBACK_CLASS = '[A-Za-z0-9_一-鿿-]+';
const _MENTION_SKIP = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE']);

function _escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _buildMentionRe() {
  const names = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache))
    ? _agentsCache.map((a) => a && a.name).filter((n) => typeof n === 'string' && n.length)
    : [];
  // Longest-first so multi-word names anchor before any single-word prefix
  // shared with another agent. Two agents named "Foo" and "Foo Bar" both
  // match correctly when the longer alternative is tried first.
  names.sort((a, b) => b.length - a.length);
  const namedAlt = names.length ? names.map(_escapeForRegex).join('|') + '|' : '';
  return new RegExp(`(^|[^A-Za-z0-9_一-鿿-])(@(?:${namedAlt}${_MENTION_FALLBACK_CLASS}))`, 'gu');
}

function _highlightMentionsIn(rootEl) {
  if (!rootEl) return;
  const re = _buildMentionRe();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (p.tagName && _MENTION_SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      re.lastIndex = 0;
      return re.test(node.nodeValue || '')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue || '';
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const beforeStart = last;
      const beforeEnd = m.index + m[1].length;
      if (beforeEnd > beforeStart) {
        frag.appendChild(document.createTextNode(text.slice(beforeStart, beforeEnd)));
      }
      const span = document.createElement('span');
      span.className = 'msg-mention';
      span.textContent = m[2];
      frag.appendChild(span);
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }
}

function _isFailedAssistantContent(rawContent, message = null) {
  if (message && (message.failed === true || message.error === true)) return true;
  const raw = String(rawContent || '');
  return /\bmsg-error\b/.test(raw)
    || /color\s*:\s*var\(--danger\)/i.test(raw)
    || /style=["'][^"']*var\(--danger\)/i.test(raw)
    || /(?:模型调用失败|model\s+(?:call|invocation|response)\s+failed)/i.test(raw);
}

function _isInterruptedAssistantMessage(message = null) {
  if (!message || typeof message !== 'object') return false;
  if (_groupMessageSystemKind(message) === 'reply_interrupted') return true;
  return Array.isArray(message.process) && message.process.some((item) => (
    item
    && item.type === 'event'
    && item.event?.stream === 'runtime'
    && item.event?.data?.aborted === true
  ));
}

function _normalizeFeedbackFieldText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _skillsForDisplayNameRewrite() {
  return (typeof _skillsCache !== 'undefined' && Array.isArray(_skillsCache)) ? _skillsCache : [];
}

function _skillIdFromKnownSkillMdPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  // The model-facing Skill reference resolves to SKILL.md at execution time,
  // but process presentation sees the safe logical path from the tool input.
  // Only the bare entry ref is a Skill load; nested references remain files.
  const virtual = /^@skill\/([^/]+)(?:\/SKILL\.md)?$/.exec(s);
  if (virtual) return virtual[1] || '';
  if (!s.endsWith('/SKILL.md')) return '';
  const direct = /\/(?:cloud\/skills|local\/marketplace\/skills|local\/system\/skills)\/([^/]+)\/SKILL\.md$/.exec(s);
  if (direct) return direct[1] || '';
  const agentOwned = /\/(?:cloud\/agents|local\/marketplace\/agents)\/[^/]+\/(?:skills|private_skills)\/([^/]+)\/SKILL\.md$/.exec(s);
  return agentOwned ? (agentOwned[1] || '') : '';
}

function _skillDisplayNameFromReadFilePath(p) {
  const sid = _skillIdFromKnownSkillMdPath(p);
  if (!sid) return '';
  const skills = _skillsForDisplayNameRewrite();
  const found = skills.find((s) => s && s.id === sid);
  return (found && (found.name || found.id)) || sid;
}

function _agentIdFromKnownAgentJsonPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const direct = /\/(?:cloud\/agents|local\/marketplace\/agents)\/([^/]+)\/agent\.json$/.exec(s);
  return direct ? (direct[1] || '') : '';
}

function _agentDisplayNameFromReadFilePath(p) {
  const aid = _agentIdFromKnownAgentJsonPath(p);
  if (!aid) return '';
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const found = _agentsCache.find((a) => a && a.agent_id === aid);
    return (found && (found.name || found.agent_id)) || aid;
  }
  return aid;
}

function _processFirstText(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function _processPatchPaths(value) {
  const text = String(value || '');
  if (!text) return [];
  const paths = [];
  const add = (candidate) => {
    const path = String(candidate || '').trim();
    if (path && !paths.includes(path)) paths.push(path);
  };
  for (const match of text.matchAll(/^\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/^\*\*\*\s+Move to:\s*(.+?)\s*$/gm)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+?)\s*$/gm)) {
    add(match[2] || match[1]);
  }
  return paths;
}

function _processInputPaths(input) {
  if (typeof input === 'string') {
    const patchPaths = _processPatchPaths(input);
    return patchPaths.length ? patchPaths : (input.trim() ? [input.trim()] : []);
  }
  if (!input || typeof input !== 'object') return [];

  const paths = [];
  const add = (candidate) => {
    if (typeof candidate !== 'string') return;
    const path = candidate.trim();
    if (path && !paths.includes(path)) paths.push(path);
  };
  const directKeys = [
    'path', 'file_path', 'filePath', 'filename', 'file',
    'output_path', 'outputPath', 'input_path', 'inputPath',
    'source_path', 'sourcePath', 'notebook_path', 'notebookPath',
  ];
  for (const key of directKeys) add(input[key]);
  for (const key of [
    'paths', 'file_paths', 'filePaths', 'files',
    'output_paths', 'outputPaths', 'input_paths', 'inputPaths', 'changes',
  ]) {
    const values = Array.isArray(input[key]) ? input[key] : [];
    for (const value of values) {
      if (typeof value === 'string') add(value);
      else add(_processFirstText(value, directKeys));
    }
  }
  const patch = _processFirstText(input, ['patch', 'diff', 'unified_diff', 'unifiedDiff']);
  for (const path of _processPatchPaths(patch)) add(path);
  return paths;
}

function _processDisplayPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  const absolute = withoutQuery.startsWith('/') || /^[A-Za-z]:\//.test(withoutQuery);
  const unsafeRelative = withoutQuery === '..' || withoutQuery.startsWith('../');
  if (absolute || unsafeRelative) return withoutQuery.split('/').filter(Boolean).pop() || '';
  return withoutQuery.replace(/^\.\//, '');
}

function _processResourceFromInput(data, input) {
  const inputPaths = _processInputPaths(input);
  // Event-level `outputPath` is also used for the private spilled tool-result
  // archive. It is not a business output file and must never appear in copy.
  const safeData = data && typeof data === 'object'
    ? { ...data, output_path: '', outputPath: '', output_paths: [], outputPaths: [] }
    : data;
  const pathValues = inputPaths.length ? inputPaths : _processInputPaths(safeData);
  const pathValue = pathValues[0] || '';
  const explicitSkill = data?.skill_name || data?.skillName || data?.skill_id || data?.skillId
    || (input && typeof input === 'object'
      ? input.skill_name || input.skillName || input.skill_id || input.skillId
      : '')
    || '';
  const skillName = String(explicitSkill
    || (pathValues.length === 1 ? _skillDisplayNameFromReadFilePath(pathValue) : '')
    || '').trim();
  if (skillName) return { type: 'skill', name: skillName };

  const explicitAgent = data?.agent_name || data?.agentName || data?.agent_id || data?.agentId
    || (input && typeof input === 'object'
      ? input.agent_name || input.agentName || input.agent_id || input.agentId
      : '')
    || '';
  const agentName = String(explicitAgent
    || (pathValues.length === 1 ? _agentDisplayNameFromReadFilePath(pathValue) : '')
    || '').trim();
  if (agentName) return { type: 'agent', name: agentName };

  const displayPaths = pathValues
    .map((path) => _processBoundedDetail(_processDisplayPath(path), 160))
    .filter((path, index, all) => path && all.indexOf(path) === index);
  if (!displayPaths.length) return null;
  const image = displayPaths.length === 1
    && /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|webp)$/i.test(displayPaths[0]);
  const name = displayPaths.length > 3
    ? `${displayPaths.slice(0, 3).join(', ')}…`
    : displayPaths.join(', ');
  return { type: image ? 'image' : 'file', name };
}

const _ORKAS_BRIDGE_TOOL_KEYS = new Set([
  'orkas_list_skills',
  'orkas_read_skill',
  'orkas_run_skill',
  'orkas_list_connector_tools',
  'orkas_call_connector_tool',
  'orkas_kb_list',
  'orkas_kb_search',
  'orkas_kb_read',
  'chat_search',
  'chat_read',
  'orkas_handoff_to_commander',
]);

function _normalizedProcessToolName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function _isOrkasBridgeToolName(name) {
  const key = _normalizedProcessToolName(name);
  return key.startsWith('orkas.')
    || key.startsWith('mcp__orkas__')
    || _ORKAS_BRIDGE_TOOL_KEYS.has(key);
}

function _processToolKey(name) {
  const key = _normalizedProcessToolName(name);
  // Codex reports MCP calls as `server.tool`; Claude uses
  // `mcp__server__tool`. The `orkas` server is an internal capability bridge,
  // not a business connector, so classify its underlying action instead of
  // exposing the transport namespace in the process rail.
  if (key.startsWith('orkas.')) return key.slice('orkas.'.length);
  if (key.startsWith('mcp__orkas__')) return key.slice('mcp__orkas__'.length);
  return key;
}

function _processBoundedDetail(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function _processDisplayWebTarget(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // A hostname alone makes separate pages on the same site look like the
  // agent is repeating one action. Keep the concrete URL (scheme, path,
  // query and fragment) so each web read remains identifiable, while
  // redacting the credential carriers that must not enter the transcript.
  text = text
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/i, '$1***@')
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator, rawKey) => (
      _processGenericSensitiveKey(rawKey)
        ? `${separator}${rawKey}=***`
        : match
    ));
  return _processBoundedDetail(text, 320);
}

function _processCommandInputText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length && value.every(part => typeof part === 'string')) {
      return value.join(' ');
    }
  }
  return '';
}

function _processCommandSummary(input) {
  const raw = _processCommandInputText(input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!raw.trim()) return '';

  // A concise process row must not become a second terminal. Keep only the
  // invocation line; heredoc and multiline script bodies stay in the private
  // tool event / expandable result rather than the always-visible rail.
  let text = raw.split(/\r?\n/, 1)[0].trim();
  if (!text) return '';

  // Redact common credential carriers before shortening the command. Doing
  // this before the length cap prevents a long secret from surviving in the
  // visible prefix.
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer ***')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    .replace(/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '***JWT***')
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9][A-Za-z0-9_-]{11,}\b/g, '***TOKEN***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g, '***TOKEN***')
    .replace(/([?&](?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie|code|state|signature|sign|q-ak|q-signature|x-cos-security-token|x-amz-signature|x-amz-security-token|x-amz-credential|ossaccesskeyid|security-token)=)([^&#\s"']+)/gi, '$1***')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password|passwd|pwd|credential|authorization|cookie|session_?id))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=***')
    .replace(/((?:^|\s)--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?id|client[-_]?secret|private[-_]?key|password|passwd|pwd|secret|token|authorization|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1***')
    .replace(/((?:authorization|x-api-key|api-key|x-auth-token)\s*:\s*)(?!\*{3})(?:Bearer\s+|Basic\s+)?[^\s"']+/gi, '$1***')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2');

  // Commands may legitimately name workspace-relative files. Preserve those,
  // but collapse absolute machine paths to their basename just like file-tool
  // process rows do.
  text = text
    .replace(/(["'])((?:\/(?!\/)|[A-Za-z]:[\\/])[^"'\r\n]+)\1/g, (_match, quote, absolutePath) => (
      `${quote}${_processDisplayPath(absolutePath)}${quote}`
    ))
    .replace(/(^|[\s=(:,])((?:\/(?!\/)|[A-Za-z]:[\\/])(?:\\ |[^\s;&|<>()"'])+)/g, (_match, prefix, absolutePath) => (
      `${prefix}${_processDisplayPath(absolutePath)}`
    ));

  return _processBoundedDetail(text, 160);
}

function _processActionLine(actionKey, target = '', statusKey = '') {
  const action = t(actionKey);
  const label = target
    ? t('chat.process.with_target', { action, target: String(target) })
    : action;
  return statusKey
    ? t('chat.process.with_status', { label, status: t(statusKey) })
    : label;
}

function _processResourceAction(resource, mode) {
  if (resource?.type === 'skill') return mode === 'modify'
    ? 'chat.process.action_modify_skill'
    : 'chat.process.action_view_skill';
  if (resource?.type === 'agent') return mode === 'modify'
    ? 'chat.process.action_modify_agent'
    : 'chat.process.action_view_agent';
  if (resource?.type === 'image' && mode !== 'modify') return 'chat.process.action_view_image';
  if (mode === 'read') return 'chat.process.action_read_file';
  return mode === 'modify'
    ? 'chat.process.action_modify_file'
    : 'chat.process.action_view_file';
}

function _processConnectorName(name, input) {
  const explicit = _processFirstText(input, [
    'connector_name', 'connectorName', 'display_name', 'displayName',
    'connector_id', 'connectorId',
  ]);
  if (explicit) return explicit;
  const raw = String(name || '').trim();
  if (/^mcp__/i.test(raw)) return raw.split('__')[1] || '';
  if (raw.includes('.')) return raw.split('.')[0] || '';
  return '';
}

function _processConnectorOperation(name, input) {
  const explicit = _processFirstText(input, [
    'tool_name', 'toolName', 'operation', 'action', 'method',
  ]);
  if (explicit) return _processBoundedDetail(_processCommandSummary(explicit), 96);

  const raw = String(name || '').trim();
  if (/^mcp__/i.test(raw)) {
    return _processBoundedDetail(raw.split('__').slice(2).join('__'), 96);
  }
  if (raw.includes('.')) {
    return _processBoundedDetail(raw.split('.').slice(1).join('.'), 96);
  }
  return '';
}

function _processConnectorTarget(name, input) {
  const connector = _processConnectorName(name, input);
  const operation = _processConnectorOperation(name, input);
  const sources = [input, input && typeof input === 'object' ? input.args : null];
  let businessTarget = '';
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!_processGenericTargetKey(key)) continue;
      const detail = _processGenericScalarDetail(key, value, 160);
      if (!detail || detail === connector || detail === operation) continue;
      businessTarget = detail;
      break;
    }
    if (businessTarget) break;
  }
  return [connector, operation, businessTarget].filter(Boolean).join(' · ');
}

function _processSearchTarget(input) {
  const query = _processFirstText(input, ['query', 'pattern', 'glob']);
  const path = _processFirstText(input, ['path', 'dir', 'directory']);
  const displayQuery = _processStatusDetail(query, 160);
  const displayPath = _processDisplayPath(path);
  return _processBoundedDetail(
    [displayQuery, displayPath]
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .join(' · '),
    240,
  );
}

const _PROCESS_GENERIC_OPERATION_KEYS = new Set([
  'op', 'operation', 'action', 'method', 'mode', 'task', 'kind',
]);

const _PROCESS_GENERIC_BODY_KEYS = new Set([
  'body', 'content', 'data', 'description', 'diff', 'headers', 'html',
  'input', 'instructions', 'markdown', 'messages', 'output', 'patch',
  'payload', 'prompt', 'result', 'schema', 'script', 'systemprompt', 'text',
]);

function _processGenericCompactKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function _processGenericSensitiveKey(key) {
  const compact = _processGenericCompactKey(key);
  return [
    'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'privatekey',
    'accesskey', 'secret', 'password', 'passwd', 'credential',
    'authorization', 'cookie', 'sessionid', 'signature',
  ].some(part => compact.includes(part))
    || ['code', 'state', 'token'].includes(compact);
}

function _processGenericTargetKey(key) {
  const compact = _processGenericCompactKey(key);
  return compact === 'dir'
    || compact === 'directory'
    || compact.endsWith('dir')
    || compact.endsWith('directory')
    || compact.endsWith('path')
    || compact.endsWith('file')
    || compact.endsWith('filename')
    || ['href', 'query', 'q', 'uri', 'url'].includes(compact);
}

function _processGenericScalarDetail(key, value, max = 96) {
  if (_processGenericSensitiveKey(key)) return '';
  const compact = _processGenericCompactKey(key);
  if (_PROCESS_GENERIC_BODY_KEYS.has(compact)) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || /^[{[]/.test(raw)) return '';
  const detail = compact === 'href' || compact === 'uri' || compact === 'url'
    ? _processDisplayWebTarget(raw)
    : (compact === 'query' || compact === 'q'
        ? _processCommandSummary(raw)
        : (_processGenericTargetKey(key)
            ? _processDisplayPath(raw)
            : _processCommandSummary(raw)));
  return _processBoundedDetail(detail, max);
}

function _processGenericToolPresentation(name, input, resourceTarget = '') {
  const key = _processToolKey(name);
  const toolName = ['tool', 'tool_result', 'result'].includes(key) ? '' : key;
  const parts = toolName ? [toolName] : [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (!toolName) return null;
    return {
      actionKey: 'chat.process.action_execute',
      target: _processBoundedDetail(parts.join(' · '), 240),
    };
  }

  const entries = Object.entries(input);
  const usedKeys = new Set();
  for (const [entryKey, value] of entries) {
    const compact = _processGenericCompactKey(entryKey);
    if (!_PROCESS_GENERIC_OPERATION_KEYS.has(compact)) continue;
    const detail = _processGenericScalarDetail(entryKey, value);
    usedKeys.add(entryKey);
    if (detail && !parts.includes(detail)) parts.push(detail);
    break;
  }

  let target = resourceTarget;
  if (!target) {
    for (const [entryKey, value] of entries) {
      if (!_processGenericTargetKey(entryKey)) continue;
      const detail = _processGenericScalarDetail(entryKey, value);
      usedKeys.add(entryKey);
      if (!detail) continue;
      target = detail;
      break;
    }
  }
  if (target && !parts.includes(target)) parts.push(target);

  let extraCount = 0;
  for (const [entryKey, value] of entries) {
    if (extraCount >= 2 || usedKeys.has(entryKey)) continue;
    const compact = _processGenericCompactKey(entryKey);
    if (_PROCESS_GENERIC_OPERATION_KEYS.has(compact)
        || _processGenericTargetKey(entryKey)
        || _PROCESS_GENERIC_BODY_KEYS.has(compact)
        || _processGenericSensitiveKey(entryKey)) continue;
    const detail = _processGenericScalarDetail(entryKey, value, 72);
    if (!detail) continue;
    parts.push(`${_processBoundedDetail(entryKey, 36)}=${detail}`);
    extraCount += 1;
  }

  return {
    actionKey: 'chat.process.action_execute',
    target: _processBoundedDetail(parts.join(' · '), 240),
  };
}

function _processToolPresentation(name, data, input) {
  const key = _processToolKey(name);
  const resource = _processResourceFromInput(data, input);
  const target = resource?.name || '';

  if (key === 'orkas_list_skills') {
    return { actionKey: 'chat.process.action_view_skill', target: '' };
  }
  if (key === 'orkas_read_skill') {
    const skillName = _processFirstText(input, ['id', 'skill_id', 'skillId', 'skill', 'name']);
    return { actionKey: 'chat.process.action_view_skill', target: skillName };
  }
  if (key === 'orkas_run_skill') {
    const skillName = _processFirstText(input, ['skill', 'skill_name', 'skillName', 'id', 'name']);
    const script = _processFirstText(input, ['script']);
    return {
      actionKey: 'chat.process.action_use_skill',
      target: [skillName, _processDisplayPath(script)].filter(Boolean).join(' · '),
    };
  }
  if (key === 'stat_file') {
    return { actionKey: 'chat.process.action_get_file_info', target };
  }
  if (['read', 'read_file', 'read_files', 'office_read'].includes(key)) {
    return { actionKey: _processResourceAction(resource, 'read'), target };
  }
  if (key === 'list_files') {
    const resourceScope = String(data?.resource_scope || data?.resourceScope || '').trim();
    return {
      actionKey: 'chat.process.action_view_directory',
      target: resourceScope === 'current_workspace'
        ? t('chat.process.target_current_workspace')
        : target,
    };
  }
  if ([
    'write', 'write_file', 'append_file', 'edit', 'edit_file', 'multi_edit', 'multiedit',
    'notebook_edit', 'notebookedit', 'apply_patch', 'patch_apply',
    'edit_office', 'edit_pdf',
  ].includes(key)) {
    return { actionKey: _processResourceAction(resource, 'modify'), target };
  }
  if ([
    'create_docx', 'create_xlsx', 'create_pptx', 'markdown_to_pdf', 'html_to_pdf',
    'create_artifact',
  ].includes(key)) {
    return { actionKey: 'chat.process.action_create_file', target };
  }
  if (key === 'delete_file') {
    const actionKey = resource?.type === 'skill'
      ? 'chat.process.action_delete_skill'
      : (resource?.type === 'agent'
          ? 'chat.process.action_delete_agent'
          : 'chat.process.action_delete_file');
    return { actionKey, target };
  }
  if (key === 'ocr_file') {
    return { actionKey: 'chat.process.action_recognize_text', target };
  }
  if (['view_image', 'imageview'].includes(key)) {
    return { actionKey: 'chat.process.action_view_image', target };
  }
  if (key === 'office_check') {
    return { actionKey: 'chat.process.action_check_file', target };
  }
  if (key === 'office_render') {
    return { actionKey: 'chat.process.action_render_file', target };
  }
  if (['pdf_render', 'html_preview'].includes(key)) {
    return { actionKey: _processResourceAction(resource, 'view'), target };
  }
  if (['glob', 'grep', 'grep_files', 'search_files'].includes(key)) {
    return { actionKey: 'chat.process.action_search_files', target: _processSearchTarget(input) };
  }
  if (['web_search', 'websearch'].includes(key)) {
    const query = _processFirstText(input, ['query', 'q']);
    return { actionKey: 'chat.process.action_search_web', target: _processStatusDetail(query, 240) };
  }
  if (key === 'web_fetch' || key === 'webfetch') {
    const url = typeof input === 'string' ? input : _processFirstText(input, ['url', 'href']);
    return { actionKey: 'chat.process.action_view_web', target: _processDisplayWebTarget(url) };
  }
  if (['kb_read', 'kb_list', 'orkas_kb_read', 'orkas_kb_list'].includes(key)) {
    const referenceName = _processFirstText(input, ['name', 'title', 'filename', 'path', 'dir']);
    return { actionKey: 'chat.process.action_view_reference', target: _processDisplayPath(referenceName) };
  }
  if (key === 'kb_search' || key === 'orkas_kb_search') {
    const query = _processFirstText(input, ['query', 'q']);
    return {
      actionKey: 'chat.process.action_search_reference',
      target: _processStatusDetail(query, 240),
    };
  }
  if (key === 'chat_read') {
    return { actionKey: 'chat.process.action_view_conversation', target: '' };
  }
  if (key === 'chat_search') {
    const query = _processFirstText(input, ['query', 'q']);
    return {
      actionKey: 'chat.process.action_search_conversation',
      target: _processStatusDetail(query, 240),
    };
  }
  if ([
    'bash', 'exec_command', 'commandexecution', 'command_execution',
    'shell', 'terminal', 'execute',
    'process_start', 'process_read', 'process_write', 'process_stop',
    'interactive_cli_start', 'interactive_cli_read', 'interactive_cli_send',
    'interactive_cli_close',
  ].includes(key)) {
    return {
      actionKey: 'chat.process.action_run_command',
      target: _processCommandSummary(input),
    };
  }
  if (['skill', 'use_skill'].includes(key)) {
    const skillName = _processFirstText(input, ['skill_name', 'skillName', 'skill', 'name']);
    return { actionKey: 'chat.process.action_use_skill', target: skillName };
  }
  if (['generate_image', 'image_generation'].includes(key)) {
    return { actionKey: 'chat.process.action_generate_image', target };
  }
  if (key === 'generate_speech') {
    return { actionKey: 'chat.process.action_generate_audio', target };
  }
  if (_isProcessPlanToolName(key)) {
    return { actionKey: 'chat.process.action_update_plan', target: '', isPlan: true };
  }
  if (['context_compaction'].includes(key)) {
    return { actionKey: 'chat.process.action_organize_conversation', target: '' };
  }
  if (key === 'orkas_handoff_to_commander') {
    return { actionKey: 'chat.process.action_handoff_commander', target: '' };
  }
  if (key === 'list_connector_tools' || key === 'orkas_list_connector_tools') {
    const connectorName = _processFirstText(input, [
      'connector_name', 'connectorName', 'display_name', 'displayName',
      'connector_id', 'connectorId',
    ]);
    return { actionKey: 'chat.process.action_view_connector', target: connectorName };
  }
  if (key === 'add_custom_connector') {
    const connectorName = _processConnectorName(name, input);
    return { actionKey: 'chat.process.action_add_connector', target: connectorName };
  }
  if (key === 'call_connector_tool' || key === 'orkas_call_connector_tool'
      || key.startsWith('mcp__')
      || (String(name || '').includes('.') && !_isOrkasBridgeToolName(name))) {
    return {
      actionKey: 'chat.process.action_use_connector',
      target: _processConnectorTarget(name, input),
    };
  }
  if (key.startsWith('collaboration:') || [
    'agent', 'task', 'background_agent', 'dispatch_to', 'hand_off_to', 'run_worker',
  ].includes(key)) {
    const agentName = _processFirstText(input, [
      'agent_name', 'agentName', 'recipient_name', 'recipientName',
      'subagent_type', 'subagentType', 'agent_type', 'agentType',
      'to', 'recipient', 'agent', 'name',
    ]);
    return { actionKey: 'chat.process.action_call_agent', target: agentName };
  }
  if (_isOrkasBridgeToolName(name)) {
    // Future bridge tools must remain internal actions rather than silently
    // becoming a fake connector merely because their protocol name is dotted.
    return _processGenericToolPresentation(name, input, target);
  }
  return _processGenericToolPresentation(name, input, target);
}

function _createProcessDisplayContext() {
  return { tools: new Map(), files: new Set(), planSteps: new Map(), planCreated: false };
}

function _processToolPresentationScore(presentation) {
  if (!presentation || typeof presentation !== 'object') return -1;
  let score = presentation.actionKey === 'chat.process.action_execute' ? 0 : 4;
  if (String(presentation.target || '').trim()) score += 2;
  if (Array.isArray(presentation.targets) && presentation.targets.length) score += 2;
  if (presentation.isPlan) score += 1;
  return score;
}

// A streamed tool announcement has a stable name but no complete input. At
// the execution boundary the same call carries safe, validated arguments.
// Keep whichever presentation contains more information while retaining the
// latest elapsed time. Identity matching remains exclusively call-id based.
function _processBestToolPresentation(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  const preferred = _processToolPresentationScore(incoming) >= _processToolPresentationScore(current)
    ? incoming
    : current;
  const elapsedMs = Math.max(Number(current.elapsedMs) || 0, Number(incoming.elapsedMs) || 0);
  return elapsedMs > 0 ? { ...preferred, elapsedMs } : preferred;
}

// Return the stable identity of one tool call across its start/progress/result
// protocol events. The UI uses this only for presentation: the persisted raw
// event trail remains untouched for debugging and result expansion.
function _processToolLifecycle(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
  const callId = String(data.callId || data.call_id || data.id || '').trim();
  if (!callId) return null;

  if (evt.stream === 'tool') {
    const phase = String(data.phase || data.status || '').toLowerCase();
    if (['start', 'use', 'progress', 'end', 'result'].includes(phase)) {
      return {
        key: `tool:${callId}`,
        terminal: phase === 'end' || phase === 'result',
      };
    }
    return null;
  }

  if (evt.stream !== 'cli') return null;
  const type = String(data.type || '').toLowerCase();
  const phase = String(data.phase || '').toLowerCase();
  const status = String(data.status || '').toLowerCase();
  if (type === 'tool-event' && ['start', 'use', 'end', 'result'].includes(phase)) {
    return {
      key: `cli:${callId}`,
      terminal: phase === 'end' || phase === 'result',
    };
  }
  if (type === 'status' && status === 'tool-progress') {
    return { key: `cli:${callId}`, terminal: false };
  }
  return null;
}

function _isProcessPlanToolName(name) {
  return ['manage_execution_plan', 'plan_set', 'todo_write', 'todowrite', 'update_plan']
    .includes(_processToolKey(name));
}

function _processPlanActionKey(input, hasPlan = false) {
  const action = String(input?.action || '').trim().toLowerCase();
  if (action === 'set_status') return 'chat.process.action_execute_plan';
  const hasSteps = ['plan', 'todos', 'steps']
    .some(key => Array.isArray(input?.[key]) && input[key].length > 0);
  if (!hasPlan && hasSteps && !['append_step', 'clear'].includes(action)) {
    return 'chat.process.action_create_plan';
  }
  return 'chat.process.action_update_plan';
}

function _isProcessPlanEvent(evt) {
  if (!evt || typeof evt !== 'object') return false;
  const stream = String(evt.stream || '').toLowerCase();
  const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
  if (stream === 'plan') return true;
  if (stream === 'tool') return _isProcessPlanToolName(data.name || data.toolName);
  if (stream !== 'cli') return false;
  const type = String(data.type || '').toLowerCase();
  if (type === 'status') return String(data.status || '').toLowerCase() === 'plan-updated';
  if (type !== 'tool-event') return false;
  if (_isProcessPlanToolName(data.tool)) return true;
  return data.phase === 'result'
    && _processPlanResult(data, _createProcessDisplayContext()) !== null;
}

function _processPlanActionTargets(input, displayContext) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  for (const key of ['plan', 'todos', 'steps']) {
    const items = Array.isArray(input[key]) ? input[key] : [];
    const targets = items.map((item, index) => {
      const text = typeof item === 'string'
        ? item
        : _processFirstText(item, ['step', 'title', 'description', 'content', 'text']);
      const target = _processBoundedDetail(text, 180);
      if (target && displayContext?.planSteps) {
        const rawId = item && typeof item === 'object'
          ? (item.id ?? item.step_id ?? item.stepId)
          : undefined;
        const id = Number(rawId);
        displayContext.planSteps.set(Number.isInteger(id) && id > 0 ? id : index + 1, target);
      }
      return target;
    }).filter(Boolean);
    if (targets.length) return targets;
  }
  const step = _processFirstText(input, ['step', 'title', 'description', 'content', 'text']);
  if (step) return [_processBoundedDetail(step, 180)];
  const stepId = Number(input.step_id ?? input.stepId);
  if (Number.isInteger(stepId) && stepId > 0 && displayContext?.planSteps?.has(stepId)) {
    return [displayContext.planSteps.get(stepId)];
  }
  const explanation = _processBoundedDetail(input.explanation || input.message || input.reason, 180);
  return explanation ? [explanation] : [];
}

function _processPlanResult(data, displayContext) {
  let parsed = null;
  for (const value of [data?.output, data?.result, data?.content, data?.result_preview]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value;
      break;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > 64 * 1024 || text.charAt(0) !== '{') continue;
    try {
      const candidate = JSON.parse(text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate;
        break;
      }
    } catch (_) {}
  }
  const action = String(parsed?.action || '').trim().toLowerCase();
  if (!['update', 'replace', 'append_step', 'set_status', 'clear'].includes(action)) return null;
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const targets = _processPlanActionTargets({ plan: steps }, displayContext);
  const selectedId = Number(parsed?.step_id ?? parsed?.appended_step_id);
  if (Number.isInteger(selectedId) && selectedId > 0 && displayContext?.planSteps?.has(selectedId)) {
    return { action, targets: [displayContext.planSteps.get(selectedId)] };
  }
  return { action, targets };
}

function _processPlanLinesFromSteps(steps, displayContext) {
  const targets = (Array.isArray(steps) ? steps : []).map(step => _processBoundedDetail(
    typeof step === 'string'
      ? step
      : _processFirstText(step, ['step', 'title', 'description', 'content', 'text']),
    180,
  )).filter(Boolean);
  if (!targets.length) return '';
  const actionKey = displayContext?.planCreated
    ? 'chat.process.action_update_plan'
    : 'chat.process.action_create_plan';
  if (displayContext) displayContext.planCreated = true;
  return targets.map(target => _processActionLine(actionKey, target)).join('\n');
}

function _processDisplayContextForMessage(msg) {
  if (!msg) return _createProcessDisplayContext();
  if (!msg._processDisplayContext) msg._processDisplayContext = _createProcessDisplayContext();
  return msg._processDisplayContext;
}

function _formatKnownToolProcessLine(name, data, input, phase, displayContext, scope = 'tool') {
  const callId = String(data?.callId || data?.call_id || data?.id || '').trim();
  const displayId = callId ? `${scope}:${callId}` : '';
  let presentation = _processToolPresentation(name, data, input);
  const terminal = phase === 'end' || phase === 'result';
  const hadPlan = Boolean(displayContext?.planCreated);
  const planResult = terminal ? _processPlanResult(data, displayContext) : null;
  const resultTargets = planResult?.targets || null;
  if (planResult && (!presentation || presentation.isPlan)) {
    presentation = {
      ...(presentation || {}),
      actionKey: _processPlanActionKey(
        { action: planResult.action, steps: resultTargets },
        hadPlan,
      ),
      target: '',
      isPlan: true,
    };
  }

  if (presentation?.isPlan && (phase === 'use' || phase === 'start')) {
    const targets = _processPlanActionTargets(input, displayContext);
    presentation = {
      ...presentation,
      actionKey: _processPlanActionKey(input, hadPlan),
      targets,
    };
    if (targets.length && displayContext) displayContext.planCreated = true;
  } else if (planResult && resultTargets?.length && displayContext) {
    displayContext.planCreated = true;
  }

  if ((phase === 'result' || phase === 'end') && displayId && displayContext?.tools) {
    presentation = displayContext.tools.get(displayId) || presentation;
  } else if (phase === 'progress' && displayId && displayContext?.tools) {
    presentation = _processBestToolPresentation(displayContext.tools.get(displayId), presentation);
    const elapsedSeconds = Number(data?.elapsedSeconds);
    if (presentation && Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) {
      presentation = {
        ...presentation,
        elapsedMs: Math.max(Number(presentation.elapsedMs) || 0, elapsedSeconds * 1000),
      };
      // Terminal CLI events commonly omit timing. Retain the latest progress
      // milestone so both live rows and restored history keep the duration
      // when the result replaces the in-progress presentation.
    }
    if (presentation) displayContext.tools.set(displayId, presentation);
  } else if ((phase === 'use' || phase === 'start') && displayId && presentation && displayContext?.tools) {
    displayContext.tools.set(displayId, presentation);
  }

  if (!presentation) return '';
  const pathlessCliPatch = scope === 'cli'
    && ['apply_patch', 'patch_apply'].includes(_processToolKey(name))
    && !presentation.target;
  if (pathlessCliPatch) return '';
  const statusKey = terminal
    ? (data?.isError === true || data?.is_error === true || data?.success === false
        || data?.error === true || (typeof data?.error === 'string' && !!data.error.trim())
        || ['error', 'failed'].includes(String(data?.status || '').toLowerCase())
        ? 'chat.process.status_failed'
        : 'chat.process.status_done')
    : '';
  // The visible step duration is the persisted end-to-end tool lifecycle:
  // first streamed tool-call event through execution completion. Legacy
  // events fall back to execution-only duration_ms. Never calculate this from
  // renderer arrival time: history replay and reconnect must show the same
  // value as the live run.
  const explicitDurationValue = data?.end_to_end_duration_ms
    ?? data?.endToEndDurationMs
    ?? data?.duration_ms
    ?? data?.durationMs
    ?? data?.elapsed_ms
    ?? data?.elapsedMs;
  const explicitDurationMs = Number(explicitDurationValue);
  const cachedDurationMs = Number(presentation.elapsedMs);
  const durationMs = explicitDurationValue != null && Number.isFinite(explicitDurationMs)
    ? Math.max(0, explicitDurationMs)
    : (Number.isFinite(cachedDurationMs) && cachedDurationMs >= 0 ? cachedDurationMs : null);
  const duration = terminal && durationMs != null ? _formatToolDuration(durationMs) : '';
  // Process delivery is at-least-once across the primary stream, observer,
  // reconnect, and persisted-history replay. Keep the best known presentation
  // after completion so a repeated terminal event cannot fall back to an
  // action-only row and erase its target or exact duration.
  if (terminal && displayId && presentation && displayContext?.tools) {
    displayContext.tools.set(displayId, durationMs == null
      ? presentation
      : { ...presentation, elapsedMs: durationMs });
  }
  if (presentation.isPlan && phase === 'progress') return null;
  if (presentation.isPlan && terminal && statusKey !== 'chat.process.status_failed') {
    const startTargets = Array.isArray(presentation.targets) ? presentation.targets : [];
    if (startTargets.length) return null;
    return Array.isArray(resultTargets) && resultTargets.length
      ? resultTargets.map(target => _processActionLine(presentation.actionKey, target)).join('\n')
      : _processActionLine(presentation.actionKey);
  }
  if (presentation.isPlan && !terminal) {
    const targets = Array.isArray(presentation.targets) ? presentation.targets : [];
    return targets.length
      ? targets.map(target => _processActionLine(presentation.actionKey, target)).join('\n')
      : null;
  }
  if (presentation.isPlan && statusKey === 'chat.process.status_failed') {
    const targets = Array.isArray(presentation.targets) ? presentation.targets : [];
    const target = targets[0] || '';
    const line = _processActionLine(presentation.actionKey, target, statusKey);
    const detailedLine = duration ? `${line} · ${duration}` : line;
    const failure = _processFailureSummary(data);
    return failure ? `${detailedLine} · ${failure}` : detailedLine;
  }
  const actionLine = _processActionLine(presentation.actionKey, presentation.target, statusKey);
  const line = !terminal && scope === 'tool'
    ? t('chat.process.started_action', { label: actionLine })
    : actionLine;
  const detailedLine = duration ? `${line} · ${duration}` : line;
  if (statusKey !== 'chat.process.status_failed') return detailedLine;
  const failure = _processFailureSummary(data);
  return failure ? `${detailedLine} · ${failure}` : detailedLine;
}

function _processFailureTextFromValue(value, depth = 0, seen = new Set()) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (/^[{[]/.test(text)) {
      if (text.length > 64 * 1024) return '';
      try {
        return _processFailureTextFromValue(JSON.parse(text), depth + 1, seen);
      } catch (_) {
        return '';
      }
    }
    return text;
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = _processFailureTextFromValue(item, depth + 1, seen);
      if (found) return found;
    }
    return '';
  }

  const directKeys = [
    'user_message', 'userMessage', 'error_message', 'errorMessage',
    'message', 'error', 'reason',
  ];
  const failureCode = typeof value.code === 'string'
    && /^[A-Z][A-Z0-9_.-]{2,63}$/.test(value.code.trim())
    ? value.code.trim()
    : '';
  for (const key of directKeys) {
    if (!(key in value)) continue;
    const found = _processFailureTextFromValue(value[key], depth + 1, seen);
    if (found) return failureCode && !found.includes(failureCode)
      ? `${failureCode}: ${found}`
      : found;
  }
  const branchPattern = /(?:block|error|fail|finding|inspect|validat|diagnostic|detail)/i;
  const branches = Object.entries(value).filter(([key, child]) => (
    branchPattern.test(key) && child && typeof child === 'object'
  ));
  const remaining = Object.entries(value).filter(([key, child]) => (
    !branchPattern.test(key) && child && typeof child === 'object'
  ));
  for (const [, child] of [...branches, ...remaining]) {
    const found = _processFailureTextFromValue(child, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

function _processFailureSummary(data) {
  const structured = _processStructuredFailureSummary(data);
  if (structured) return structured;
  let raw = _processFirstText(data, [
    'user_message', 'userMessage', 'error_message', 'errorMessage',
    'message', 'error',
  ]);
  if (!raw) {
    for (const value of [data?.error, data?.result_preview, data?.output, data?.result, data?.content]) {
      raw = _processFailureTextFromValue(value);
      if (raw) break;
    }
  }
  if (!raw) return '';
  const known = _formatKnownCliDiagnostic(raw);
  if (known) return known;
  const summary = _processCommandSummary(raw);
  if (!summary || summary.toLowerCase() === 'failed' || summary === t('chat.process.status_failed')) {
    return '';
  }
  return summary;
}

function _processStructuredFailureRecord(value, depth = 0, seen = new Set()) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !/^[{[]/.test(text) || text.length > 64 * 1024) return null;
    try { return _processStructuredFailureRecord(JSON.parse(text), depth + 1, seen); }
    catch (_) { return null; }
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && typeof value.errorCode === 'string') return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = _processStructuredFailureRecord(child, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function _processStructuredFailureSummary(data) {
  const record = _processStructuredFailureRecord(data);
  if (!record) return '';
  const code = String(record.errorCode || '');
  if (code === 'E_TTS_MEASURED_DURATION_MISMATCH') {
    return t('chat.process.video_narration_timing_mismatch', {
      measured: record.measured_duration_sec ?? '?',
      min: record.min_duration_sec ?? '?',
      max: record.max_duration_sec ?? '?',
    });
  }
  if (code === 'E_NARRATION_TIMING_USER_DECISION_REQUIRED') {
    return t('chat.process.video_narration_timing_decision', {
      measured: record.measured_duration_sec ?? '?',
      min: record.min_duration_sec ?? '?',
      max: record.max_duration_sec ?? '?',
    });
  }
  if (code === 'E_REPEATED_FAILURE_USER_DECISION_REQUIRED') {
    return t('chat.process.repeated_failure_decision');
  }
  return '';
}

function _processStatusDetail(value, max = 160) {
  const detail = _processCommandSummary(value);
  return _processBoundedDetail(detail, max);
}

function _processModelName(value) {
  const text = _processStatusDetail(value, 80);
  if (!text || /[\r\n{}[\]<>]/.test(text)) return '';
  return text;
}

function _processModelTransitionDetail(data) {
  const from = _processModelName(data?.fromModel || data?.from_model || data?.previousModel);
  const to = _processModelName(data?.toModel || data?.to_model || data?.model);
  if (from && to) return `${from} → ${to}`;
  return to || from;
}

function _formatProcessCompaction(data) {
  const rawBefore = Number(data?.tokensBefore ?? data?.tokens_before);
  const rawAfter = Number(data?.tokensAfter ?? data?.tokens_after);
  return Number.isFinite(rawBefore) && Number.isFinite(rawAfter)
    ? t('chat.stream.compaction_tokens', {
        before: Math.max(0, Math.round(rawBefore)),
        after: Math.max(0, Math.round(rawAfter)),
      })
    : t('chat.stream.compaction');
}

function _formatKnownCliDiagnostic(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/(?:sign[ -]?in|log[ -]?in|authentication|unauthorized|credential)/i.test(text)) {
    return t('chat.process.cli_login_required');
  }
  if (/(?:rate.?limit|too many requests|http\s*429)/i.test(text)) {
    return t('chat.stream.rate_limit');
  }
  if (/(?:connection|network).{0,24}(?:restored|recovered|reconnected)/i.test(text)) {
    return t('chat.process.connection_recovered');
  }
  return '';
}

function _formatCliFileChangeLine(data, displayContext) {
  const paths = _processInputPaths(data);
  const visiblePaths = paths.filter((path) => {
    if (!displayContext?.files) return true;
    const key = String(path || '').trim().replace(/\\/g, '/');
    if (!key || displayContext.files.has(key)) return false;
    displayContext.files.add(key);
    return true;
  });
  if (!visiblePaths.length) return null;
  const resource = _processResourceFromInput({}, { paths: visiblePaths });
  if (!resource) return null;
  return _processActionLine(
    _processResourceAction(resource, 'modify'),
    resource.name,
    'chat.process.status_done',
  );
}

function _htmlMayContainKnownSkillIdForDisplay(html, skills) {
  if (!html || !Array.isArray(skills) || !skills.length) return false;
  return skills.some((s) => {
    const id = typeof s?.id === 'string' ? s.id : '';
    const name = typeof s?.name === 'string' ? s.name : '';
    return id && name && id !== name && html.indexOf(id) >= 0;
  });
}

function _replaceKnownSkillIdsIn(rootEl, skills) {
  if (!rootEl || typeof _replaceKnownSkillIdsForDisplay !== 'function') return;
  if (!Array.isArray(skills) || !skills.length) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (p.tagName && _MENTION_SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      const text = node.nodeValue || '';
      return _replaceKnownSkillIdsForDisplay(text, skills) !== text
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    node.nodeValue = _replaceKnownSkillIdsForDisplay(node.nodeValue || '', skills);
  }
}

// Wrap `renderMarkdownFull` so every chat-bubble render passes through the
// mention highlighter. Same signature as the underlying function so call
// sites just swap.
//
// Defensive structural-block strip at the single markdown-render chokepoint:
// most callers already pre-strip via `_stripSurvivingStructuralBlocks`
// (`appendChatMessage` / `_streamingSetFinal` / mid-stream error path), but
// a stray path that feeds raw `<agent>...</agent>` directly into markdown
// would let `renderMarkdownFull`'s HTML pass-through render the container's
// inner text without its wrapping tags — the user sees a bare agent_id +
// description_zh + description_en bubble appear next to the real reply.
// Strip here so the chokepoint is the safety net regardless of caller. Pure
// no-op for already-clean text; pinned in `strip-structural-blocks.test.ts`
// fixture A6 (commander `<agent>` container with `<agent_id>` /
// `<description_*>` / `<workflow>` sub-tags).
function _renderMessageMarkdown(text) {
  const skills = _skillsForDisplayNameRewrite();
  const cleaned = (typeof _stripSurvivingStructuralBlocks === 'function')
    ? _stripSurvivingStructuralBlocks(String(text || ''))
    : String(text || '');
  const raw = cleaned;
  const displayText = (skills.length && typeof _simplifyKnownSkillFollowPhrasesForDisplay === 'function')
    ? _simplifyKnownSkillFollowPhrasesForDisplay(raw, skills)
    : raw;
  const html = renderMarkdownFull(displayText);
  const needsSkillRewrite = _htmlMayContainKnownSkillIdForDisplay(html, skills);
  // Mention highlighting requires DOM walking — do it on a detached
  // container, then return its innerHTML for the bubble to embed.
  if (!html || (html.indexOf('@') < 0 && !needsSkillRewrite)) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  if (needsSkillRewrite) _replaceKnownSkillIdsIn(tmp, skills);
  _highlightMentionsIn(tmp);
  return tmp.innerHTML;
}

// Build the mention-highlight portion of the textarea mirror. Escapes
// everything EXCEPT `@<token>` matches, which become accent-coloured spans.
function _buildMentionMirrorHtml(text) {
  if (!text) return '';
  const re = _buildMentionRe();
  let html = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const beforeStart = last;
    const beforeEnd = m.index + m[1].length;
    if (beforeEnd > beforeStart) html += escapeHtml(text.slice(beforeStart, beforeEnd));
    html += `<span class="msg-mention">${escapeHtml(m[2])}</span>`;
    last = re.lastIndex;
  }
  if (last < text.length) html += escapeHtml(text.slice(last));
  return html;
}

// Build the legacy mirror HTML for tests / fallback callers. The active
// composer now uses real DOM chips in `_initMentionMirror` below; this helper
// stays tiny because some focused renderer tests still extract it.
function _buildMirrorHtml(text) {
  if (!text) return '';
  const base = (typeof _renderChatUseMirrorHtml === 'function')
    ? _renderChatUseMirrorHtml(text, _buildMentionMirrorHtml)
    : _buildMentionMirrorHtml(text);
  return text.endsWith('\n') ? base + '​' : base;
}

const _chatRichComposers = new Map();

function _chatRichInputId(inputOrId) {
  if (!inputOrId) return '';
  if (typeof inputOrId === 'string') return inputOrId;
  return inputOrId.id || inputOrId.dataset?.richInputId || '';
}

function getChatRichComposerEditor(inputOrId) {
  const id = _chatRichInputId(inputOrId);
  return id ? (_chatRichComposers.get(id)?.editor || null) : null;
}

function getChatRichComposerSelection(inputOrId) {
  const id = _chatRichInputId(inputOrId);
  const api = id ? _chatRichComposers.get(id) : null;
  if (!api) return null;
  api.syncTextareaSelectionFromEditor();
  return {
    start: api.input.selectionStart || 0,
    end: api.input.selectionEnd || api.input.selectionStart || 0,
  };
}

function focusChatRichComposer(inputOrId) {
  const id = _chatRichInputId(inputOrId);
  const api = id ? _chatRichComposers.get(id) : null;
  if (!api) return false;
  api.focus();
  return true;
}

/** True when the composer (its textarea or the rich editor standing in for it)
 *  already holds focus. */
function _chatComposerHasFocus(inputOrId) {
  const active = document.activeElement;
  if (!active) return false;
  const id = _chatRichInputId(inputOrId);
  if (!id) return false;
  if (active.id === id) return true;
  const api = _chatRichComposers.get(id);
  return !!api && api.editor === active;
}

/**
 * Give the composer focus only when nothing else holds it.
 *
 * Entering a conversation and refreshing the send button both want the composer
 * ready for typing, but both fire on timers/re-renders that can land after the
 * user has moved focus elsewhere — global search focuses its box on its own
 * 30ms timer, so an unconditional focus here silently pulls the caret back into
 * the chat box and the user's keystrokes go to the wrong field. Convenience
 * focus must never take focus away from a control the user is already in.
 */
function focusChatComposerIfIdle(inputOrId) {
  const active = document.activeElement;
  const idle = !active
    || active === document.body
    || _chatComposerHasFocus(inputOrId);
  if (!idle) return false;
  const el = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
  if (!el) return false;
  if (focusChatRichComposer(el)) return true;
  el.focus();
  return true;
}

function syncChatRichComposerFromTextarea(inputOrId) {
  const id = _chatRichInputId(inputOrId);
  const api = id ? _chatRichComposers.get(id) : null;
  if (!api) return false;
  api.renderFromTextarea();
  return true;
}

function syncChatRichComposerHeight(inputOrId, maxPx) {
  const id = _chatRichInputId(inputOrId);
  const api = id ? _chatRichComposers.get(id) : null;
  if (!api) return false;
  api.renderFromTextarea();
  api.autoGrow(maxPx);
  return true;
}

function insertChatUseTokenIntoComposer(inputOrId, selection) {
  const id = _chatRichInputId(inputOrId);
  const api = id ? _chatRichComposers.get(id) : null;
  if (!api) return false;
  return api.insertUse(selection);
}

function _chatRichSerializeNode(node, isRoot = true) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node;
    if (el.dataset?.chatUseChip === '1') return el.dataset.token || '';
    // A "bogus" <br> is a display-only filler that renders the trailing empty
    // line contenteditable would otherwise collapse; it carries no value, so a
    // render→serialize round-trip must not turn it back into a newline.
    if (el.tagName === 'BR') return el.dataset?.chatBogus === '1' ? '' : '\n';
  }
  let out = '';
  node.childNodes.forEach((child) => { out += _chatRichSerializeNode(child, false); });
  // The DIV/P newline separates *sibling* blocks (e.g. browser line-wrapping
  // divs). It must not fire for the root editor itself, or every non-empty
  // value would gain a phantom trailing "\n" that (a) makes "abc" and "abc\n"
  // serialize identically and (b) can't be told apart from a real trailing
  // newline when we decide whether to render a filler line.
  if (!isRoot && node.nodeType === Node.ELEMENT_NODE && /^(DIV|P)$/i.test(node.tagName || '')) {
    if (out && !out.endsWith('\n')) out += '\n';
  }
  return out;
}

function _chatRichTextLength(node) {
  return _chatRichSerializeNode(node).length;
}

function _chatRichRangeLength(editor, container, offset) {
  try {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(container, offset);
    const len = _chatRichSerializeNode(range.cloneContents()).length;
    if (typeof range.detach === 'function') range.detach();
    return len;
  } catch (_) {
    return editor ? _chatRichSerializeNode(editor).length : 0;
  }
}

function _chatRichSelectionIndexes(editor) {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount < 1) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const start = _chatRichRangeLength(editor, range.startContainer, range.startOffset);
  const end = _chatRichRangeLength(editor, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function _chatRichFindPosition(root, index) {
  let left = Math.max(0, Number(index) || 0);
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue || '').length;
      if (left <= len) return { type: 'text', node, offset: left };
      left -= len;
      return null;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      if (el.dataset?.chatUseChip === '1' || el.tagName === 'BR') {
        const len = _chatRichTextLength(el);
        if (left <= len) return left <= len / 2
          ? { type: 'before', node: el }
          : { type: 'after', node: el };
        left -= len;
        return null;
      }
    }
    for (const child of Array.from(node.childNodes || [])) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root) || { type: 'end', node: root };
}

function _chatRichApplyBoundary(range, boundary, which) {
  const fn = which === 'start' ? 'setStart' : 'setEnd';
  if (!boundary || boundary.type === 'end') {
    range[fn](boundary?.node || range.commonAncestorContainer, (boundary?.node || range.commonAncestorContainer).childNodes.length);
  } else if (boundary.type === 'text') {
    range[fn](boundary.node, boundary.offset);
  } else if (boundary.type === 'before') {
    which === 'start' ? range.setStartBefore(boundary.node) : range.setEndBefore(boundary.node);
  } else if (boundary.type === 'after') {
    which === 'start' ? range.setStartAfter(boundary.node) : range.setEndAfter(boundary.node);
  }
}

function _chatRichSetSelection(editor, start, end = start) {
  if (!editor || !window.getSelection) return;
  const range = document.createRange();
  const startPos = _chatRichFindPosition(editor, start);
  const endPos = _chatRichFindPosition(editor, end);
  _chatRichApplyBoundary(range, startPos, 'start');
  _chatRichApplyBoundary(range, endPos, 'end');
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function _chatRichLabelParts(selection) {
  try {
    if (typeof _chatUseLabelParts === 'function') return _chatUseLabelParts(selection);
  } catch (_) {}
  const name = selection?.name || selection?.id || '';
  const prefix = selection?.kind === 'connector' ? 'Connector: ' : 'Skill: ';
  return { name, prefix, label: `${prefix}${name}` };
}

function _chatRichCreateUseChip(selection, rawToken) {
  const chip = document.createElement('span');
  chip.className = `chat-use-inline-chip chat-rich-use-chip ${selection?.kind === 'connector' ? 'is-connector' : 'is-skill'}`;
  chip.contentEditable = 'false';
  chip.dataset.chatUseChip = '1';
  chip.dataset.kind = selection?.kind || '';
  chip.dataset.itemId = selection?.id || selection?.name || '';
  chip.dataset.name = selection?.name || selection?.id || '';
  chip.dataset.token = rawToken || '';
  const parts = _chatRichLabelParts(selection);
  chip.title = parts.label || '';
  chip.innerHTML = '';
  const prefixEl = document.createElement('span');
  prefixEl.className = 'chat-use-inline-prefix';
  prefixEl.textContent = parts.prefix || '';
  const nameEl = document.createElement('span');
  nameEl.className = 'chat-use-inline-name';
  nameEl.textContent = parts.name || '';
  chip.append(prefixEl, nameEl);
  return chip;
}

// contenteditable + `white-space: pre-wrap` collapses a trailing newline: a
// value ending in "\n" (or a lone "\n" just typed) renders no empty last line,
// so the caret can't sit on it and the box never grows/scrolls to reveal it.
// Browsers solve this with a filler <br>; we mirror that with a marked "bogus"
// <br> that serialization drops (see _chatRichSerializeNode). Keep exactly one,
// always at the very end, and only when the content actually ends in a newline.
function _chatRichHasAuthoredContent(node) {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) return !!(node.nodeValue || '');
  if (node.nodeType === Node.ELEMENT_NODE && node.dataset?.chatUseChip === '1') return true;
  return Array.from(node.childNodes || []).some((child) => _chatRichHasAuthoredContent(child));
}

function _chatRichEnsureTrailingBreak(editor) {
  if (!editor) return;
  const stale = editor.querySelector ? editor.querySelector('br[data-chat-bogus="1"]') : null;
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  // Chromium represents an emptied contenteditable as <br> (and sometimes
  // <div><br></div>) so the caret still has a line box. That node is browser
  // chrome, not user input: serializing it as "\n" makes an emptied composer
  // one line taller and persists a phantom newline in the hidden textarea.
  // Real newlines in this editor are text nodes created by render/keydown/paste,
  // so they count as authored content and remain intact.
  if (!_chatRichHasAuthoredContent(editor)) {
    if (editor.childNodes?.length) editor.textContent = '';
    return;
  }
  if (_chatRichSerializeNode(editor).endsWith('\n')) {
    const br = document.createElement('br');
    br.dataset.chatBogus = '1';
    editor.appendChild(br);
  }
}

/** Reconcile every non-IME native edit before serializing it. The display-only trailing filler can
 * become stale when the user types after a trailing newline or deletes that newline with Backspace;
 * leaving it in the DOM creates a phantom visual line even though serialization correctly drops it. */
function _chatRichHandleEditorInput(api) {
  if (!api || api.composing) return;
  api.ensureTrailingBreak();
  api.syncFromEditor(true);
}

function _chatRichRenderValue(editor, value) {
  const src = String(value || '');
  editor.textContent = '';
  const tokens = (typeof _findChatUseTokens === 'function') ? _findChatUseTokens(src) : [];
  let last = 0;
  tokens.forEach((token) => {
    if (token.start > last) editor.appendChild(document.createTextNode(src.slice(last, token.start)));
    editor.appendChild(_chatRichCreateUseChip(token.selection, token.raw));
    last = token.end;
  });
  if (last < src.length) editor.appendChild(document.createTextNode(src.slice(last)));
  _chatRichEnsureTrailingBreak(editor);
}

function _chatRichInputTarget(inputId) {
  if (inputId === 'new-chat-input') return 'new-chat';
  if (inputId === 'project-chat-input') return 'project';
  if (inputId === 'auto-task-input') return 'auto';
  return 'conversation';
}

function _chatRichAutoGrowMax(inputId) {
  if (inputId === 'new-chat-input') return 260;
  if (inputId === 'project-chat-input') return 180;
  if (inputId === 'auto-task-input') return 220;
  return 200;
}

function _chatRichRecipientChipId(inputId) {
  if (inputId === 'new-chat-input') return 'new-chat-recipient-chip';
  if (inputId === 'project-chat-input') return 'project-chat-recipient-chip';
  if (inputId === 'auto-task-input') return 'auto-recipient-chip';
  if (inputId === 'chat-input') return 'chat-recipient-chip';
  return '';
}

function _chatRichUploadPasteFiles(inputId, files) {
  if (!files || !files.length || typeof _chatAttachUpload !== 'function') return false;
  if (inputId === 'new-chat-input') {
    _chatAttachUpload(DRAFT_CID, files, 'paste');
    return true;
  }
  if (inputId === 'project-chat-input'
      && typeof _projectDetailPid !== 'undefined' && _projectDetailPid
      && typeof _projectChatDraftCid === 'function') {
    _chatAttachUpload(_projectChatDraftCid(_projectDetailPid), files, 'paste');
    return true;
  }
  if (inputId === 'chat-input' && currentCid) {
    _chatAttachUpload(currentCid, files, 'paste');
    return true;
  }
  if (inputId === 'auto-task-input' && typeof window._autoUploadFilesFromComposer === 'function') {
    window._autoUploadFilesFromComposer(files, 'paste');
    return true;
  }
  return false;
}

function _chatRichInsertText(editor, text) {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount < 1 || !editor.contains(sel.anchorNode)) {
    editor.focus();
    _chatRichSetSelection(editor, _chatRichSerializeNode(editor).length);
  }
  const range = window.getSelection().getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(String(text || ''));
  range.insertNode(node);
  range.setStart(node, node.nodeValue.length);
  range.setEnd(node, node.nodeValue.length);
  const next = window.getSelection();
  next.removeAllRanges();
  next.addRange(range);
}

function _chatRichCreateApi(textarea, editor) {
  const nativeSetSelectionRange = typeof textarea.setSelectionRange === 'function'
    ? textarea.setSelectionRange.bind(textarea)
    : null;
  const nativeFocus = typeof textarea.focus === 'function' ? textarea.focus.bind(textarea) : null;
  const api = {
    input: textarea,
    editor,
    lastValue: null,
    pendingSelection: null,
    syncingFromEditor: false,
    // True between compositionstart/compositionend (IME). While composing we
    // must not rebuild the editor DOM or thrash its layout, or the in-flight
    // composition gets dropped and the user has to retype — hence the guards in
    // renderFromTextarea/the input listeners and a single reconcile on end.
    composing: false,
    focus() {
      editor.focus();
      const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : (textarea.value || '').length;
      const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
      _chatRichSetSelection(editor, start, end);
    },
    setTextareaSelection(start, end = start, opts = {}) {
      const next = { start, end: typeof end === 'number' ? end : start };
      if (nativeSetSelectionRange) {
        try { nativeSetSelectionRange(next.start, next.end); } catch (_) {}
      } else {
        textarea.selectionStart = next.start;
        textarea.selectionEnd = next.end;
      }
      if (!opts || opts.pending !== false) {
        this.pendingSelection = next;
      }
    },
    syncTextareaSelectionFromEditor() {
      const sel = _chatRichSelectionIndexes(editor);
      if (!sel) return;
      // This mirrors the browser-owned contenteditable caret into the hidden
      // textarea. It must not schedule a reverse editor selection update,
      // otherwise normal ArrowLeft/ArrowRight movement gets snapped back by
      // the next sync tick.
      this.setTextareaSelection(sel.start, sel.end, { pending: false });
    },
    renderFromTextarea(opts = {}) {
      // Rebuilding the contenteditable mid-composition drops the IME buffer;
      // compositionend runs one reconcile once the text has committed.
      if (this.composing) return;
      const value = String(textarea.value || '');
      const changed = value !== this.lastValue;
      let shouldAutoGrow = !!(opts && opts.forceHeight);
      if (changed) {
        shouldAutoGrow = true;
        this.lastValue = value;
        const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : value.length;
        const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
        _chatRichRenderValue(editor, value);
        if (document.activeElement === editor || this.pendingSelection) {
          const sel = this.pendingSelection || { start, end };
          _chatRichSetSelection(editor, sel.start, sel.end);
          this.pendingSelection = null;
        }
      } else if (this.pendingSelection && document.activeElement === editor) {
        _chatRichSetSelection(editor, this.pendingSelection.start, this.pendingSelection.end);
        this.pendingSelection = null;
      }
      if (shouldAutoGrow) this.autoGrow(_chatRichAutoGrowMax(textarea.id));
    },
    syncFromEditor(emit) {
      this.syncTextareaSelectionFromEditor();
      const value = _chatRichSerializeNode(editor);
      if (value === this.lastValue && !emit) return;
      this.lastValue = value;
      textarea.value = value;
      this.syncingFromEditor = true;
      if (emit) {
        try { textarea.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      this.syncingFromEditor = false;
      this.autoGrow(_chatRichAutoGrowMax(textarea.id));
    },
    autoGrow(maxPx) {
      const max = Number(maxPx) || _chatRichAutoGrowMax(textarea.id);
      editor.style.height = 'auto';
      const next = Math.min(editor.scrollHeight || 0, max);
      if (next > 0) editor.style.height = `${next}px`;
      const overflow = (editor.scrollHeight || 0) > max;
      editor.style.overflowY = overflow ? 'auto' : 'hidden';
      // Once the editor scrolls internally, growing/wrapping no longer keeps the
      // caret in view on its own (resetting height to 'auto' above also resets
      // scrollTop), so the newly typed line ends up clipped below the fold.
      if (overflow && document.activeElement === editor) this.scrollCaretIntoView();
    },
    // Keep the caret's line inside the scroll viewport. Range client rects are
    // empty exactly at a trailing <br> boundary (the just-created empty line),
    // so fall back to scrolling to the bottom when the caret is at content end.
    scrollCaretIntoView() {
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.rangeCount < 1) return;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.endContainer)) return;
      const editorRect = editor.getBoundingClientRect();
      const rects = range.getClientRects();
      let rect = rects && rects.length ? rects[rects.length - 1] : null;
      if (!rect || !rect.height) {
        const bounding = range.getBoundingClientRect();
        if (bounding && bounding.height) rect = bounding;
      }
      if (rect && rect.height) {
        if (rect.bottom > editorRect.bottom) editor.scrollTop += (rect.bottom - editorRect.bottom) + 2;
        else if (rect.top < editorRect.top) editor.scrollTop -= (editorRect.top - rect.top) + 2;
        return;
      }
      const idx = _chatRichSelectionIndexes(editor);
      if (idx && idx.end >= _chatRichSerializeNode(editor).length) editor.scrollTop = editor.scrollHeight;
    },
    ensureTrailingBreak() {
      _chatRichEnsureTrailingBreak(editor);
    },
    insertUse(selection) {
      if (typeof _chatUseTokenFor !== 'function') return false;
      const token = _chatUseTokenFor(selection);
      if (!token) return false;
      this.syncTextareaSelectionFromEditor();
      const value = String(textarea.value || '');
      const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : value.length;
      const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const leading = before && !/\s$/.test(before) ? ' ' : '';
      const trailing = after && /^\s/.test(after) ? '' : ' ';
      const replacement = `${leading}${token}${trailing}`;
      textarea.value = `${before}${replacement}${after}`;
      const caret = start + replacement.length;
      this.setTextareaSelection(caret, caret);
      this.lastValue = null;
      this.renderFromTextarea();
      try { textarea.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      return true;
    },
  };

  textarea.addEventListener('input', () => {
    if (api.syncingFromEditor || api.composing) return;
    api.renderFromTextarea();
  });
  editor.addEventListener('input', () => {
    // Native IME keeps mutating the editor while composing; stay out of its way
    // and reconcile once on compositionend.
    _chatRichHandleEditorInput(api);
  });
  editor.addEventListener('compositionstart', () => { api.composing = true; });
  editor.addEventListener('compositionend', () => {
    api.composing = false;
    // The committed text is now in the editor DOM; mirror it into the textarea
    // and recompute height/scroll exactly once.
    api.ensureTrailingBreak();
    api.syncFromEditor(true);
  });
  editor.addEventListener('focus', () => {
    api.renderFromTextarea();
    api.syncTextareaSelectionFromEditor();
  });
  editor.addEventListener('keyup', () => api.syncTextareaSelectionFromEditor());
  editor.addEventListener('mouseup', () => api.syncTextareaSelectionFromEditor());
  editor.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (cd?.files?.length && _chatRichUploadPasteFiles(textarea.id, cd.files)) {
      e.preventDefault();
      return;
    }
    const text = cd?.getData ? cd.getData('text/plain') : '';
    if (!text) return;
    e.preventDefault();
    _chatRichInsertText(editor, text);
    api.ensureTrailingBreak();
    api.syncFromEditor(true);
  });
  editor.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    api.syncTextareaSelectionFromEditor();
    if (e.key === 'Escape'
        && textarea.id === 'chat-input'
        && typeof _isQueueItemEditing === 'function'
        && _isQueueItemEditing(currentCid)) {
      e.preventDefault();
      _cancelQueueItemEdit(currentCid);
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && typeof _deleteChatUseTokenAtCaret === 'function') {
      const direction = e.key === 'Delete' ? 'forward' : 'backward';
      if (_deleteChatUseTokenAtCaret(textarea, direction)) {
        e.preventDefault();
        return;
      }
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && typeof _moveChatUseTokenCaret === 'function') {
      const direction = e.key === 'ArrowRight' ? 'forward' : 'backward';
      if (_moveChatUseTokenCaret(textarea, direction)) {
        e.preventDefault();
        api.pendingSelection = {
          start: textarea.selectionStart || 0,
          end: textarea.selectionEnd || textarea.selectionStart || 0,
        };
        api.renderFromTextarea();
        return;
      }
    }
    if (e.key !== 'Enter') return;
    if (textarea.id === 'auto-task-input') return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      _chatRichInsertText(editor, '\n');
      // A lone trailing "\n" renders no line; add the filler <br> before we
      // measure height so the new line shows and the caret scrolls into view.
      api.ensureTrailingBreak();
      api.syncFromEditor(true);
      return;
    }
    if (e.altKey) return;
    e.preventDefault();
    if (textarea.id === 'new-chat-input' && typeof handleNewChatSubmit === 'function') handleNewChatSubmit();
    else if (textarea.id === 'project-chat-input' && typeof _submitProjectChat === 'function') _submitProjectChat();
    else if (typeof handleChatSubmit === 'function') handleChatSubmit();
  });

  if (nativeFocus) {
    try {
      textarea.focus = function focus(options) {
        if (editor.isConnected) {
          api.focus();
          return;
        }
        nativeFocus(options);
      };
    } catch (_) {}
  }
  if (nativeSetSelectionRange) {
    try {
      textarea.setSelectionRange = function setSelectionRange(start, end, direction) {
        nativeSetSelectionRange(start, end, direction);
        api.pendingSelection = { start, end: typeof end === 'number' ? end : start };
        if (document.activeElement === editor) {
          _chatRichSetSelection(editor, api.pendingSelection.start, api.pendingSelection.end);
          api.pendingSelection = null;
        }
      };
    } catch (_) {}
  }
  return api;
}

// Replace the old transparent-textarea mirror with a real rich editor. The
// textarea remains the source-of-truth compatibility layer for send/draft/
// voice code; the visible caret and chip blocks now belong to contenteditable
// DOM, so browser selection can cross non-editable chips atomically.
function _initMentionMirror(textarea) {
  if (!textarea || textarea.dataset.mentionMirror === '1') return;
  if (!textarea.parentNode) return;
  textarea.dataset.mentionMirror = '1';

  const wrap = document.createElement('div');
  wrap.className = 'chat-input-rich-wrap';
  const editor = document.createElement('div');
  editor.className = 'chat-rich-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.dataset.richInputId = textarea.id || '';
  editor.dataset.placeholder = textarea.getAttribute('placeholder') || '';

  // Insert wrap in place of textarea, move textarea inside.
  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.appendChild(editor);
  wrap.appendChild(textarea);
  textarea.classList.add('chat-rich-source');

  let lastPlaceholder = '';
  const api = _chatRichCreateApi(textarea, editor);
  _chatRichComposers.set(textarea.id, api);
  const sync = () => {
    const placeholder = textarea.getAttribute('placeholder') || '';
    if (placeholder !== lastPlaceholder) {
      lastPlaceholder = placeholder;
      editor.dataset.placeholder = placeholder;
    }
    api.renderFromTextarea();
  };
  window.addEventListener('i18n-change', () => {
    api.lastValue = null;
    sync();
  });
  const chipId = _chatRichRecipientChipId(textarea.id);
  if (chipId && typeof bindRecipientAnchor === 'function') {
    try { bindRecipientAnchor(chipId, textarea.id); } catch (_) {}
  }
  // Programmatic value changes (send-clears the input, agent-picker
  // inserts `@<name>`, draft restore on conv switch) don't fire `input`
  // natively. Most call sites dispatch one explicitly, but a 100ms
  // safety poll catches any we missed without per-callsite plumbing.
  // String-compare cost is negligible; we only do real work when the
  // value actually drifted from the last paint.
  setInterval(sync, 100);
  sync();
}

// Set up rich composers for the chat panels that participate in the group-
// chat `@` semantics. Other chat panels (skill-edit, agent-edit) don't route
// via the bus's mention parser, so they keep the plain textarea.
function _initAllMentionMirrors() {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) _initMentionMirror(chatInput);
  const newChatInput = document.getElementById('new-chat-input');
  if (newChatInput) _initMentionMirror(newChatInput);
  const projectChatInput = document.getElementById('project-chat-input');
  if (projectChatInput) _initMentionMirror(projectChatInput);
  const autoTaskInput = document.getElementById('auto-task-input');
  if (autoTaskInput) _initMentionMirror(autoTaskInput);
}

const CHAT_INPUT_RESERVE_FALLBACK = 140;
let _chatInputReserveLast = 0;
let _chatInputReserveObserver = null;
function _updateChatInputReserve() {
  const pane = document.querySelector('#panel-conversation .chat-main-pane')
    || document.querySelector('#panel-conversation .chat-container');
  const wrap = document.querySelector('#panel-conversation .chat-input-wrapper');
  if (!pane || !wrap) return;
  const measured = Math.ceil(wrap.offsetHeight || 0);
  const reserve = Math.max(CHAT_INPUT_RESERVE_FALLBACK, measured);
  if (reserve === _chatInputReserveLast) return;
  _chatInputReserveLast = reserve;
  pane.style.setProperty('--chat-input-reserve', `${reserve}px`);

  const history = document.getElementById('chat-history');
  requestAnimationFrame(() => {
    if (!history || !history.isConnected) return;
    if (history._stickyEnabled === true && !history._scrollPinActive) _stickBottomIfPinned(history);
  });
}

function _initChatInputReserveObserver() {
  const wrap = document.querySelector('#panel-conversation .chat-input-wrapper');
  if (!wrap || wrap.dataset.reserveObserver === '1') return;
  wrap.dataset.reserveObserver = '1';
  _updateChatInputReserve();
  if (typeof ResizeObserver === 'function') {
    _chatInputReserveObserver = new ResizeObserver(() => _updateChatInputReserve());
    _chatInputReserveObserver.observe(wrap);
  }
  window.addEventListener('resize', _updateChatInputReserve);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      _initAllMentionMirrors();
      _initChatInputReserveObserver();
    }, { once: true });
  } else {
    _initAllMentionMirrors();
    _initChatInputReserveObserver();
  }
}

// ─── Recipient chip — per-cid for conversations, ephemeral for new-chat ──
// Each persisted conversation remembers its own last-picked recipient (so
// switching between conversations restores their distinct contexts) and
// stays sticky on view-enter — the only thing that overrides it is the
// auto-switch to a live interactive agent (see `_evaluateAutoRecipient`).
// The new-chat (commander landing) resets to commander only when its input
// box is empty; otherwise the user's in-progress draft keeps its target.
const _COMMANDER = { kind: 'commander', id: '', name: '' };
const _RECIPIENT_LS_KEY = 'chat.recipientByCid';
let _recipientByCid = {};       // { [cid]: {kind,id,name} } — agents only; commander = absence
let _newChatRecipient = { ..._COMMANDER }; // ephemeral, reset on view-enter
let _pendingNewChatRecipient = null;        // captured at send time, transferred to new cid
let _projectChatRecipient = { ..._COMMANDER }; // ephemeral recipient for project detail composer
const _autoRecipientByCid = new Map(); // cid → transient agent recipient while plan waits on user input
// Queue edits temporarily project the queued message's recipient into the
// composer without overwriting the conversation's sticky draft recipient.
const _queueEditRecipientByCid = new Map();
// The conversation "floor": server-authoritative `StateFile.active_recipient`,
// mirrored here from every `state_changed` event. The commander sets it via
// `hand_off_to` (model-decided); the agent's `<handback />`, the user's
// `@commander`, or the picker's return-to-commander reset it. This is the SINGLE
// source of truth for "who the user is talking to" — `_evaluateAutoRecipient`
// derives the composer target from it instead of guessing client-side.
const _serverFloorByCid = new Map();   // cid → agent id ('' / absent ⇒ commander)
// One-shot: the user picked "commander" in the composer while an agent held the
// floor. The next send injects `@commander` (the server parses it and resets the
// floor); the auto-target evaluation respects this until the reset is confirmed.
const _pendingFloorResetByCid = new Set();

function _loadRecipientMap() {
  try {
    const raw = localStorage.getItem(_RECIPIENT_LS_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') _recipientByCid = v;
  } catch (_) { /* corrupt entry — start fresh */ }
}
_loadRecipientMap();

function _saveRecipientMap() {
  try { localStorage.setItem(_RECIPIENT_LS_KEY, JSON.stringify(_recipientByCid)); } catch (_) {}
}

// Quote-reply state (per-cid, in-memory). Declared early so the
// DOMContentLoaded init branch below — which may invoke _renderQuotePreview
// synchronously when the document is already loaded — doesn't hit a TDZ on
// the binding. The helper functions live further down with the rest of the
// quote infrastructure (_addQuote / _getQuotes / _clearQuotes / _renderQuotePreview).
const _quotesByCid = new Map();   // cid → Array<{ fromActor, fromName, msgId, text, produced[] }>

function _normRecipient(next) {
  if (!next || (next.kind !== 'commander' && next.kind !== 'agent')) return null;
  if (next.kind === 'commander') return { ..._COMMANDER };
  return { kind: 'agent', id: String(next.id || ''), name: String(next.name || next.id || '') };
}

function _activeRecipient(target) {
  if (target === 'new-chat') return _newChatRecipient;
  if (target === 'project') return _projectChatRecipient;
  if (currentCid && _queueEditRecipientByCid.has(currentCid)) {
    return _queueEditRecipientByCid.get(currentCid);
  }
  if (currentCid && _autoRecipientByCid.has(currentCid)) return _autoRecipientByCid.get(currentCid);
  if (currentCid && _recipientByCid[currentCid]) return _recipientByCid[currentCid];
  return _COMMANDER;
}

function getChatRecipient(target) { return { ..._activeRecipient(target) }; }

function _projectIdForConversation(cid) {
  if (!cid || !Array.isArray(conversations)) return '';
  const conv = conversations.find((c) => c && c.conversation_id === cid);
  return (conv && conv.project_id) || '';
}

function _onRecipientChanged(target) {
  if (target === 'conversation'
      && currentCid
      && typeof _persistQueueComposerEditState === 'function') {
    _persistQueueComposerEditState(currentCid);
  }
}

function _setQueueEditRecipient(cid, next) {
  if (!cid) return;
  const current = currentCid === cid ? _activeRecipient('conversation') : _COMMANDER;
  const recipient = (
    typeof _normaliseRecipientSnapshot === 'function'
      ? _normaliseRecipientSnapshot(next)
      : _normRecipient(next)
  ) || (
    typeof _normaliseRecipientSnapshot === 'function'
      ? _normaliseRecipientSnapshot(current)
      : _normRecipient(current)
  ) || { ..._COMMANDER };
  _queueEditRecipientByCid.set(cid, recipient);
  if (cid === currentCid) _renderRecipientChip('conversation');
}

function _clearQueueEditRecipient(cid) {
  if (!cid) return;
  _queueEditRecipientByCid.delete(cid);
  if (cid === currentCid) _renderRecipientChip('conversation');
}

/** When the active project's bindings change (commander chip → switch
 *  project, or project rename/binding edit while a chat is open), the
 *  current recipient may no longer be a valid agent for the new scope.
 *  Reset to commander silently — the user will see the chip flip on next
 *  render. Called from `projects.js` post project-pick. No-op for `commander`
 *  recipients and for orphan contexts (pid empty). */
async function validateRecipientAgainstProject(target, pid) {
  const cur = _activeRecipient(target);
  if (!cur || cur.kind !== 'agent') return;
  if (!pid) return;
  try {
    const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
    if (!res || !res.ok) return;
    const bound = new Set((res.bindings && res.bindings.agents) || []);
    if (!bound.has(cur.id)) {
      setChatRecipient(target, { kind: 'commander' });
      _renderRecipientChip(target);
    }
  } catch (_) { /* leave as-is on failure */ }
}

function setChatRecipient(target, next, _opts = {}) {
  const r = _normRecipient(next);
  if (!r) return;
  if (target === 'new-chat') {
    _newChatRecipient = r;
  } else if (target === 'project') {
    _projectChatRecipient = r;
  } else if (currentCid) {
    if (_queueEditRecipientByCid.has(currentCid) && _opts.auto !== true) {
      _queueEditRecipientByCid.set(currentCid, {
        ...r,
        resetFloor: r.kind === 'commander' && !!_serverFloorByCid.get(currentCid),
      });
    } else if (_opts.auto === true) {
      if (r.kind === 'agent') _autoRecipientByCid.set(currentCid, r);
      else _autoRecipientByCid.delete(currentCid);
    } else {
      _autoRecipientByCid.delete(currentCid);
      if (r.kind === 'commander') {
        delete _recipientByCid[currentCid];
        // Returning to the commander while an agent holds the floor: arm a
        // one-shot `@commander` on the next send so the server resets the floor
        // (the model-owned floor can only be moved by a routed message).
        if (_serverFloorByCid.get(currentCid)) _pendingFloorResetByCid.add(currentCid);
      } else {
        _recipientByCid[currentCid] = r;
        _pendingFloorResetByCid.delete(currentCid);
      }
      _saveRecipientMap();
    }
  }
  _renderRecipientChip(target);
  _onRecipientChanged(target);
}

// Called by the new-chat send path *after* the new conv id is known so the
// freshly-created conversation inherits the recipient the user picked on
// the landing page (otherwise the chip would snap back to commander as
// soon as the conversation panel takes over).
function _transferNewChatRecipientTo(cid) {
  if (!cid || !_pendingNewChatRecipient) { _pendingNewChatRecipient = null; return; }
  const r = _pendingNewChatRecipient;
  _pendingNewChatRecipient = null;
  if (r.kind === 'agent') {
    _recipientByCid[cid] = r;
    _saveRecipientMap();
  }
}

function _renderRecipientChip(target) {
  const targets = target ? [target] : ['conversation', 'new-chat', 'project'];
  for (const tg of targets) {
    const id = tg === 'new-chat'
      ? 'new-chat-recipient-name'
      : (tg === 'project' ? 'project-chat-recipient-name' : 'chat-recipient-name');
    const nameEl = document.getElementById(id);
    if (!nameEl) continue;
    const r = _activeRecipient(tg);
    if (r.kind === 'agent' && r.id) {
      // Resolve name from the live registry first — the `r.name` field is
      // a snapshot taken at picker time and stays stale after rename. Fall
      // back to the snapshot only when the registry doesn't know the agent
      // (e.g. it was deleted), then to the id as a last resort.
      let display = '';
      if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
        const a = _agentsCache.find((x) => x && x.agent_id === r.id);
        if (a && a.name) display = a.name;
      }
      // A conversation can be created in the background (for example by an
      // automation) after the global Agent summary cache was loaded. Its live
      // member roster is then the freshest source for the selected Agent name.
      if (!display && tg === 'conversation' && currentCid) {
        display = _knownGroupActorLabel(currentCid, r.id) || '';
      }
      if (!display) display = r.name || r.id;
      nameEl.textContent = display;
      nameEl.removeAttribute('data-i18n');
    } else {
      nameEl.setAttribute('data-i18n', 'chat.recipient_commander');
      nameEl.textContent = t('chat.recipient_commander');
    }
  }
  if (typeof _syncComposerModelChipAvailability === 'function') {
    _syncComposerModelChipAvailability(target);
  }
}

// Hooks called by setView (boot.js) so the chip mirrors the active context.
function onEnterNewChatView() {
  if (typeof _exitMessageSelection === 'function') _exitMessageSelection();
  // The new-chat input is the only place the recipient is ephemeral. Reset
  // to commander only when the textarea is empty — if the user has typed
  // anything, treat that as an in-progress message whose target they
  // already chose, and leave the chip alone.
  const input = document.getElementById('new-chat-input');
  const hasDraft = !!(input && input.value);
  if (!hasDraft) _newChatRecipient = { ..._COMMANDER };
  _renderRecipientChip('new-chat');
  // Keep the empty-state heading aligned with the current locale.
  _refreshEmptyStateAll();
  _initEmptyStateScenarios();
  // The open-source marketplace entry is rendered as one Quick task card.
  if (typeof initOssQuickTask === 'function') initOssQuickTask();
}

// ── Empty-state landing helpers ──────────────────────────────────────────
// Surface B per PC/docs/design/PATTERNS.md.
const _SCENARIO_CATALOG = {
  data: {
    templateKey: 'new_chat.quick.tmpl.data',
    labelKey: 'new_chat.quick.data',
    taskKey: 'new_chat.quick.task.data',
    deliverableKey: 'new_chat.quick.deliver.data',
    subjectKey: 'new_chat.quick.subject.data',
    subjectFallback: 'AI desktop apps',
    thumb: 'research',
    icon: 'search',
    tone: 'research',
    group: 'knowledge-office',
    agentNames: ['DeepResearcher'],
  },
  video: {
    templateKey: 'new_chat.quick.tmpl.video',
    labelKey: 'new_chat.quick.video',
    taskKey: 'new_chat.quick.task.video',
    deliverableKey: 'new_chat.quick.deliver.video',
    subjectKey: 'new_chat.quick.subject.video',
    subjectFallback: 'AI trends',
    thumb: 'video',
    icon: 'film',
    tone: 'video',
    group: 'content-creation',
    agentNames: ['VideoStudio'],
  },
  image: {
    templateKey: 'new_chat.quick.tmpl.image',
    labelKey: 'new_chat.quick.image',
    taskKey: 'new_chat.quick.task.image',
    deliverableKey: 'new_chat.quick.deliver.image',
    subjectKey: 'new_chat.quick.subject.image',
    subjectFallback: 'City Summer Coffee Festival',
    thumb: 'poster',
    icon: 'image',
    tone: 'image',
    group: 'content-creation',
    agentNames: ['ImageStudio'],
  },
  ui_design: {
    templateKey: 'new_chat.quick.tmpl.ui_design',
    labelKey: 'new_chat.quick.ui_design',
    taskKey: 'new_chat.quick.task.ui_design',
    deliverableKey: 'new_chat.quick.deliver.ui_design',
    subjectKey: 'new_chat.quick.subject.ui_design',
    subjectFallback: 'a personal finance app',
    thumb: 'login',
    icon: 'palette',
    tone: 'ui',
    group: 'product-growth',
    agentNames: ['UIDesigner'],
  },
  office: {
    templateKey: 'new_chat.quick.tmpl.office',
    labelKey: 'new_chat.quick.office',
    taskKey: 'new_chat.quick.task.office',
    deliverableKey: 'new_chat.quick.deliver.office',
    subjectKey: 'new_chat.quick.subject.office',
    subjectFallback: 'an ecommerce store',
    thumb: 'chart',
    icon: 'file-text',
    tone: 'doc',
    group: 'knowledge-office',
    agentNames: ['OfficeWorker', 'OfficeWriter'],
  },
  ppt: {
    templateKey: 'new_chat.quick.tmpl.ppt',
    labelKey: 'new_chat.quick.ppt',
    taskKey: 'new_chat.quick.task.ppt',
    deliverableKey: 'new_chat.quick.deliver.ppt',
    subjectKey: 'new_chat.quick.subject.ppt',
    subjectFallback: 'an AI office assistant',
    thumb: 'presentation',
    icon: 'presentation',
    tone: 'presentation',
    group: 'knowledge-office',
    agentNames: ['PptMaker'],
  },
  creation: {
    templateKey: 'new_chat.quick.tmpl.creation',
    labelKey: 'new_chat.quick.creation',
    taskKey: 'new_chat.quick.task.creation',
    deliverableKey: 'new_chat.quick.deliver.creation',
    subjectKey: 'new_chat.quick.subject.creation',
    subjectFallback: 'an AI office assistant',
    thumb: 'article',
    icon: 'edit-pencil',
    tone: 'writing',
    group: 'content-creation',
    agentNames: ['ContentWriter'],
  },
  rnd: {
    templateKey: 'new_chat.quick.tmpl.rnd',
    labelKey: 'new_chat.quick.rnd',
    taskKey: 'new_chat.quick.task.rnd',
    deliverableKey: 'new_chat.quick.deliver.rnd',
    subjectKey: 'new_chat.quick.subject.rnd',
    subjectFallback: 'a product designer changing careers',
    thumb: 'web',
    icon: 'code',
    tone: 'code',
    group: 'product-growth',
    agentNames: ['ProductDeveloper'],
  },
  seo_geo: {
    templateKey: 'new_chat.quick.tmpl.seo_geo',
    labelKey: 'new_chat.quick.seo_geo',
    taskKey: 'new_chat.quick.task.seo_geo',
    deliverableKey: 'new_chat.quick.deliver.seo_geo',
    subjectKey: 'new_chat.quick.subject.seo_geo',
    subjectFallback: 'the orkas.ai website',
    thumb: 'seo',
    icon: 'globe',
    tone: 'search',
    group: 'product-growth',
    agentNames: ['SeoGeoAgent'],
  },
};
const _DEFAULT_QUICK_START_ITEMS = [
  { id: 'data', agent_id: '78900d8758bc' },
  { id: 'office', agent_id: 'a19101ba698a' },
  { id: 'ppt', agent_id: '7e91cb9ec9e9' },
  { id: 'creation', agent_id: '173d4235a431' },
  { id: 'image', agent_id: '814b61b027f0' },
  { id: 'video', agent_id: '79df9cc89f5f' },
  { id: 'ui_design', agent_id: 'bcfcb4921dce' },
  { id: 'rnd', agent_id: 'a316881746f9' },
  { id: 'seo_geo', agent_id: 'e064dca9e1bd' },
];
let _quickStartItems = _DEFAULT_QUICK_START_ITEMS.map((item) => ({ ...item }));
let _quickStartConfigPromise = null;
let _quickStartSource = 'pc_default';
let _quickStartLoadTelemetrySent = false;
let _SCENARIO_CONFIGS = {};
// English fallback templates — used when the i18n table doesn't yet carry
// the scenario template key. These are complete, ready-to-run tasks so a
// first-time user can click a card and send immediately.
const _SCENARIO_TEMPLATES_FALLBACK_EN = {
  data: 'Research AI desktop apps for everyday users and recommend options for different needs.',
  office: 'Create a sales report with sample data and charts for an ecommerce store.',
  ppt: 'Create an editable 8-slide product presentation for an AI office assistant.',
  creation: 'Write a social post about an AI office assistant.',
  video: 'Create an explainer video about AI trends.',
  image: 'Design an event poster for the City Summer Coffee Festival.',
  ui_design: 'Design a sign-in and sign-up UI for a personal finance app.',
  rnd: 'Build a portfolio website for a product designer changing careers.',
  seo_geo: 'Create an SEO and GEO improvement plan for the orkas.ai website.',
};

function _normalizeQuickStartItems(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > Object.keys(_SCENARIO_CATALOG).length) return null;
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    const id = String((item && item.id) || '').trim();
    const agentId = String((item && item.agent_id) || '').trim();
    if (!_SCENARIO_CATALOG[id] || seen.has(id) || !/^[A-Za-z0-9_-]{3,64}$/.test(agentId)) return null;
    seen.add(id);
    items.push({ id, agent_id: agentId });
  }
  return items;
}

function _setQuickStartItems(raw, source) {
  const normalized = _normalizeQuickStartItems(raw);
  const items = normalized || _DEFAULT_QUICK_START_ITEMS.map((item) => ({ ...item }));
  _quickStartItems = items;
  _quickStartSource = normalized && source === 'server_config' ? 'server_config' : 'pc_default';
  _SCENARIO_CONFIGS = Object.fromEntries(items.map((item) => [item.id, {
    ..._SCENARIO_CATALOG[item.id],
    agentId: item.agent_id,
  }]));
  return !!normalized;
}

function _commanderTelemetryId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(text) ? text : '';
}

function _normalizeCommanderTemplateAttribution(raw, defaultManual = false) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const entryPoint = String(src.entry_point || src.entryPoint || '').trim();
  const validEntryPoint = /^(?:manual|quick_start|oss_tool)$/.test(entryPoint)
    ? entryPoint
    : (defaultManual ? 'manual' : '');
  if (!validEntryPoint) return {};
  const out = { entry_point: validEntryPoint };
  const resourceId = _commanderTelemetryId(src.resource_id || src.resourceId);
  const agentId = _commanderTelemetryId(src.agent_id || src.agentId);
  const source = String(src.source || '').trim();
  const recipientType = String(src.recipient_type || src.recipientType).trim();
  const position = Math.round(Number(src.position) || 0);
  if (resourceId) out.resource_id = resourceId;
  if (agentId) out.agent_id = agentId;
  if (/^(?:pc_default|server_config|commander_home)$/.test(source)) out.source = source;
  if (/^(?:agent|commander)$/.test(recipientType)) out.recipient_type = recipientType;
  if (position > 0 && position <= 100) out.position = position;
  return out;
}

function _setCommanderTemplateAttribution(input, raw) {
  if (!input || !input.dataset) return {};
  const value = _normalizeCommanderTemplateAttribution(raw);
  _clearCommanderTemplateAttribution(input);
  if (!value.entry_point) return value;
  input.dataset.commanderEntryPoint = value.entry_point;
  if (value.resource_id) input.dataset.commanderResourceId = value.resource_id;
  if (value.agent_id) input.dataset.commanderAgentId = value.agent_id;
  if (value.source) input.dataset.commanderSource = value.source;
  if (value.recipient_type) input.dataset.commanderRecipientType = value.recipient_type;
  if (value.position) input.dataset.commanderPosition = String(value.position);
  return value;
}

function _clearCommanderTemplateAttribution(input) {
  if (!input || !input.dataset) return;
  delete input.dataset.commanderEntryPoint;
  delete input.dataset.commanderResourceId;
  delete input.dataset.commanderAgentId;
  delete input.dataset.commanderSource;
  delete input.dataset.commanderRecipientType;
  delete input.dataset.commanderPosition;
  delete input.dataset.commanderQuickStartPlaceholder;
}

function _readCommanderTemplateAttribution(input) {
  if (!input || !String(input.value || '').trim()) return { entry_point: 'manual' };
  const dataset = input.dataset || {};
  return _normalizeCommanderTemplateAttribution({
    entry_point: dataset.commanderEntryPoint,
    resource_id: dataset.commanderResourceId,
    agent_id: dataset.commanderAgentId,
    source: dataset.commanderSource,
    recipient_type: dataset.commanderRecipientType,
    position: dataset.commanderPosition,
  }, true);
}

function _bindCommanderTemplateAttributionReset(input) {
  if (!input || !input.dataset || input.dataset.commanderAttributionBound === '1'
      || typeof input.addEventListener !== 'function') return;
  input.dataset.commanderAttributionBound = '1';
  input.addEventListener('input', () => {
    const value = String(input.value || '');
    if (!value.trim()) {
      _clearCommanderTemplateAttribution(input);
      return;
    }
    const marker = String(input.dataset.commanderQuickStartPlaceholder || '');
    if (marker && !value.includes(marker)) {
      delete input.dataset.commanderQuickStartPlaceholder;
    }
  });
}

window.setCommanderTemplateAttribution = _setCommanderTemplateAttribution;

function _findQuickStartPlaceholder(text) {
  const match = String(text || '').match(/【[^】]+】|\[[^\]]+\]/);
  if (!match || typeof match.index !== 'number') return null;
  return { text: match[0], start: match.index, end: match.index + match[0].length };
}

function _findQuickStartSubject(text, subject) {
  const value = String(text || '');
  const marker = String(subject || '').trim();
  if (!marker) return null;
  const start = value.indexOf(marker);
  if (start < 0) return null;
  return { text: marker, start, end: start + marker.length };
}

function _unresolvedQuickStartPlaceholder(input) {
  if (!input || !input.dataset) return '';
  const marker = String(input.dataset.commanderQuickStartPlaceholder || '');
  if (!marker) return '';
  const value = String(input.value || '');
  const start = value.indexOf(marker);
  if (start < 0) {
    delete input.dataset.commanderQuickStartPlaceholder;
    return '';
  }
  input.focus();
  try { input.setSelectionRange(start, start + marker.length); } catch (_) {}
  return marker;
}

function _quickStartText(key, fallback) {
  const value = key ? t(key) : '';
  return value && value !== key ? value : fallback;
}

function _quickStartThumbHtml(thumb) {
  switch (thumb) {
    case 'web':
      return `
        <span class="quick-thumb-art quick-thumb-web">
          <span class="quick-thumb-browser-bar"><i></i><i></i><i></i></span>
          <span class="quick-thumb-web-hero">
            <i class="quick-thumb-web-title"></i>
            <i class="quick-thumb-web-copy"></i>
            <i class="quick-thumb-web-button"></i>
          </span>
          <span class="quick-thumb-web-menu"><i></i><i></i><i></i></span>
        </span>`;
    case 'research':
      return `
        <span class="quick-thumb-art quick-thumb-research">
          <span class="quick-thumb-paper">
            <i class="quick-thumb-paper-title"></i>
            <i class="quick-thumb-paper-line is-wide"></i>
            <i class="quick-thumb-paper-line is-medium"></i>
            <i class="quick-thumb-paper-line is-short"></i>
          </span>
          <i class="quick-thumb-research-lens"></i>
        </span>`;
    case 'login':
      return `
        <span class="quick-thumb-art quick-thumb-login">
          <span class="quick-thumb-window-bar"><i></i><i></i><i></i></span>
          <i class="quick-thumb-login-visual"></i>
          <span class="quick-thumb-login-form">
            <i class="quick-thumb-login-title"></i>
            <i class="quick-thumb-login-field"></i>
            <i class="quick-thumb-login-field"></i>
            <i class="quick-thumb-login-button"></i>
          </span>
        </span>`;
    case 'video':
      return `
        <span class="quick-thumb-art quick-thumb-video">
          <i class="quick-thumb-video-glow"></i>
          <i class="quick-thumb-video-subject"></i>
          <i class="quick-thumb-play">${_uiIconHtml('play-triangle', 'quick-thumb-play-icon')}</i>
          <i class="quick-thumb-video-caption"></i>
          <span class="quick-thumb-video-progress"><i></i></span>
        </span>`;
    case 'chart':
      return `
        <span class="quick-thumb-art quick-thumb-chart">
          <span class="quick-thumb-chart-head"><i></i><b></b></span>
          <span class="quick-thumb-chart-bars"><i></i><i></i><i></i><i></i><i></i></span>
          <i class="quick-thumb-chart-trend"></i>
        </span>`;
    case 'presentation':
      return `
        <span class="quick-thumb-art quick-thumb-presentation">
          <span class="quick-thumb-presentation-rail"><i></i><i></i><i></i></span>
          <span class="quick-thumb-presentation-slide">
            <i class="quick-thumb-presentation-title"></i>
            <i class="quick-thumb-presentation-copy"></i>
            <span class="quick-thumb-presentation-chart"><i></i><i></i><i></i></span>
          </span>
        </span>`;
    case 'poster':
      return `
        <span class="quick-thumb-art quick-thumb-poster">
          <i class="quick-thumb-poster-orb"></i>
          <i class="quick-thumb-poster-product"></i>
          <span class="quick-thumb-poster-copy"><i></i><i></i></span>
          <i class="quick-thumb-poster-tag"></i>
        </span>`;
    case 'article':
      return `
        <span class="quick-thumb-art quick-thumb-article">
          <i class="quick-thumb-article-cover"></i>
          <span class="quick-thumb-article-body">
            <i class="quick-thumb-article-kicker"></i>
            <i class="quick-thumb-article-title"></i>
            <i class="quick-thumb-article-line"></i>
            <i class="quick-thumb-article-line is-short"></i>
          </span>
        </span>`;
    case 'seo':
      return `
        <span class="quick-thumb-art quick-thumb-seo">
          <span class="quick-thumb-search-bar"><i></i><b></b></span>
          <span class="quick-thumb-search-result"><i></i><i></i></span>
          <span class="quick-thumb-search-result is-second"><i></i><i></i></span>
          <span class="quick-thumb-rank"><i></i><b></b><em></em></span>
        </span>`;
    default:
      return `
        <span class="quick-thumb-art quick-thumb-research">
          <span class="quick-thumb-paper">
            <i class="quick-thumb-paper-title"></i>
            <i class="quick-thumb-paper-line is-wide"></i>
            <i class="quick-thumb-paper-line is-medium"></i>
          </span>
        </span>`;
  }
}

function _renderQuickStartScenarios() {
  const grid = document.getElementById('new-chat-scenario-grid');
  if (!grid) return;
  const scenarioCards = _quickStartItems.map((item) => {
    const config = _SCENARIO_CONFIGS[item.id];
    if (!config) return '';
    const label = _quickStartText(config.labelKey, item.id);
    const task = _quickStartText(config.taskKey, label);
    const deliverable = _quickStartText(config.deliverableKey, '');
    const deliverableLabel = _quickStartText('new_chat.quick.deliver_label', 'Deliverable:');
    return `
      <button type="button" class="new-chat-scenario-chip quick-task-card" data-scenario="${escapeHtml(item.id)}" data-tone="${escapeHtml(config.tone || '')}" data-group="${escapeHtml(config.group || '')}">
        <span class="quick-thumb" data-thumb="${escapeHtml(config.thumb || 'doc')}" aria-hidden="true">${_quickStartThumbHtml(config.thumb)}</span>
        <span class="quick-copy">
          <span class="quick-cat">
            <span class="quick-icon" aria-hidden="true">${_uiIconHtml(config.icon || 'sparkles', 'new-chat-scenario-icon')}</span>
            <span class="new-chat-scenario-label quick-cat-name">${escapeHtml(label)}</span>
          </span>
          <span class="quick-task">${escapeHtml(task)}</span>
          <span class="quick-deliver">${escapeHtml(deliverableLabel)} <b>${escapeHtml(deliverable)}</b></span>
        </span>
      </button>`;
  }).join('');
  grid.innerHTML = scenarioCards;
}

function _refreshQuickStartConfig(row) {
  if (_quickStartConfigPromise || !window.orkas || typeof window.orkas.invoke !== 'function') return;
  _quickStartConfigPromise = window.orkas.invoke('clientConfig.getQuickStart')
    .then((res) => {
      const items = _normalizeQuickStartItems(res && res.items);
      if (!items) {
        _convLog.warn('Commander quick-start config rejected in renderer', {
          source: String((res && res.source) || 'unknown'),
        });
        return;
      }
      _setQuickStartItems(items, res && res.source);
      _renderQuickStartScenarios();
      _bindEmptyStateScenarioButtons(row);
      if (typeof initOssQuickTask === 'function') initOssQuickTask();
    })
    .catch((err) => {
      _convLog.warn('Commander quick-start config load failed; using open defaults', {
        error: err && err.message ? err.message : String(err || ''),
      });
    })
    .finally(() => { _quickStartConfigPromise = null; });
}

_setQuickStartItems(_quickStartItems, 'pc_default');

let _emptyStateAccountName = '';

function _emptyStateNameFromAccount(payload) {
  const userInfo = payload && payload.userInfo;
  if (!userInfo || typeof userInfo !== 'object') return '';
  return String(userInfo.nickname || userInfo.name || userInfo.display_name || '').trim();
}

function _renderEmptyStateHeading() {
  const el = document.getElementById('new-chat-greeting');
  if (!el) return;
  const fallbackName = _quickStartText('common.user_fallback', 'Friend');
  const name = _emptyStateAccountName || fallbackName;
  const heading = t('new_chat.title', { name });
  el.textContent = heading && heading !== 'new_chat.title'
    ? heading
    : `${name}, what do you want to accomplish?`;
}

function _updateEmptyStateAccount(payload) {
  _emptyStateAccountName = _emptyStateNameFromAccount(payload);
  _renderEmptyStateHeading();
}

function _refreshEmptyStateAccount() {
  // The open-source build has no Orkas account profile. Keep the localized
  // Friend fallback while preserving the shared heading renderer.
  _updateEmptyStateAccount(null);
}

function _refreshEmptyStateHeading() {
  _renderEmptyStateHeading();
  _refreshEmptyStateAccount();
}
function _refreshEmptyStateAll() {
  _refreshEmptyStateHeading();
}

// ── Conversation header (Surface C top) ─────────────────────────────────
// Title + project swatch + project name + stacked agent avatars
// + message count + 详情 toggle. Driven by the same data sources the sidebar
// already consumes (conversations[] cache, _groupMembersCache, pendingConvs)
// so the header stays consistent across refreshes without new IPC.

function _refreshChatHeader() {
  const cid = currentCid;
  const conv = Array.isArray(conversations)
    ? conversations.find((c) => c && c.conversation_id === cid)
    : null;
  const titleEl = document.getElementById('chat-header-title');
  const titleInput = document.getElementById('chat-header-title-input');
  const metaEl = document.getElementById('chat-header-meta');
  const actionsEl = document.querySelector('.chat-header-actions');
  const menuBtn = document.getElementById('chat-header-menu-btn');
  if (actionsEl) actionsEl.hidden = !cid;
  const editingTitle = !!(cid && _conversationHeaderRenameCid === cid);
  if (titleEl) {
    titleEl.textContent = (conv && conv.title) || t('chat.new_conv_title');
    titleEl.hidden = editingTitle;
  }
  if (titleInput) {
    titleInput.hidden = !editingTitle;
    if (editingTitle && document.activeElement !== titleInput) {
      titleInput.value = (conv && conv.title) || t('chat.new_conv_title');
    }
  }
  if (menuBtn) {
    const label = t('project.menu.more_actions');
    menuBtn.title = label;
    menuBtn.setAttribute('aria-label', label);
  }
  if (metaEl) {
    const parts = [];
    // Project swatch + name (when conv belongs to a project).
    const pid = (conv && conv.project_id) || '';
    if (pid && typeof getCommanderProjectIdName === 'function') {
      const pname = getCommanderProjectIdName(pid);
      if (pname) {
        parts.push('<span class="chat-header-meta-project-swatch" aria-hidden="true"></span>');
        parts.push(`<span class="chat-header-meta-text">${escapeHtml(pname)}</span>`);
      }
    }
    // Stacked actor avatars: commander only when it actually participated
    // in this conv (`conv.commander_in_chat`, backend-derived from a
    // <cid>.jsonl scan — `members.json` always carries commander via
    // `seedReservedActors` so it's not a usable signal). Dispatched
    // agents (kind==='agent') stack after it. Same `renderAvatarHtml`
    // path as the sidebar conv row + chat-msg avatar — uniform icon
    // style across surfaces. The trailing "N agents" count only counts
    // real agents.
    const members = _groupMembersCache.get(cid) || [];
    const agents = members.filter((a) => a && a.id && a.kind === 'agent');
    const slots = [];
    if (conv && conv.commander_in_chat) slots.push({ kind: 'commander', id: 'commander' });
    for (const a of agents) slots.push({ kind: 'agent', id: a.id });
    const visibleSlots = slots.slice(0, 4);
    if (visibleSlots.length) {
      if (parts.length) parts.push('<span class="chat-header-meta-sep">·</span>');
      const memberHtml = visibleSlots.map((s) => {
        if (s.kind === 'commander') {
          const av = (typeof _commanderAvatar === 'function') ? _commanderAvatar() : { icon: '', color: '' };
          return renderAvatarHtml(av.icon, av.color, {
            size: 18,
            seed: 'commander',
            extraClass: 'chat-header-meta-member',
          });
        }
        let icon, color;
        if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
          const ag = _agentsCache.find((x) => x && x.agent_id === s.id);
          if (ag) { icon = ag.icon; color = ag.color; }
        }
        return renderAvatarHtml(icon, color, {
          size: 18,
          seed: s.id || 'agent',
          extraClass: 'chat-header-meta-member',
        });
      }).join('');
      parts.push(`<span class="chat-header-meta-members">${memberHtml}</span>`);
      if (agents.length) {
        const countTxt = t('chat.header.agent_count', { n: agents.length });
        const countLabel = (countTxt && countTxt !== 'chat.header.agent_count')
          ? countTxt
          : `${agents.length} agents`;
        parts.push(`<span class="chat-header-meta-text">${escapeHtml(countLabel)}</span>`);
      }
    }
    metaEl.innerHTML = parts.join('');
  }
  // Reflect drawer-open state on the details button (existing toggle id is
  // reused; _syncChrome in conversation-info toggles is-active automatically).
}

function _scenarioFindAgent(config) {
  if (!config) return null;
  const list = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) ? _agentsCache : [];
  const byId = config.agentId
    ? list.find((a) => a && a.enabled !== false && a.agent_id === config.agentId)
    : null;
  if (byId) return byId;
  const names = Array.isArray(config.agentNames) ? config.agentNames : [];
  return list.find((a) => a && a.enabled !== false && names.includes(a.name || '')) || null;
}

async function _scenarioApplyAgent(config, scenarioId) {
  if (!config || typeof setChatRecipient !== 'function') {
    return { kind: 'unavailable', reason: 'recipient_api_missing' };
  }
  let agent = _scenarioFindAgent(config);
  let registryFailed = false;
  if (!agent && typeof loadAgents === 'function') {
    try {
      await loadAgents(false);
      agent = _scenarioFindAgent(config);
      if (!agent) {
        await loadAgents(true);
        agent = _scenarioFindAgent(config);
      }
    } catch (err) {
      registryFailed = true;
      _convLog.warn('Commander quick-start Agent registry load failed', {
        resource_id: String(scenarioId || ''),
        agent_id: String(config.agentId || ''),
        error: err && err.message ? err.message : String(err || ''),
      });
    }
  }
  if (!agent) {
    setChatRecipient('new-chat', { kind: 'commander' });
    _convLog.warn('Commander quick-start Agent unavailable; falling back to Commander', {
      resource_id: String(scenarioId || ''),
      agent_id: String(config.agentId || ''),
      reason: registryFailed ? 'agent_registry_error' : 'agent_missing',
    });
    return {
      kind: 'commander',
      reason: registryFailed ? 'agent_registry_error' : 'agent_missing',
    };
  }
  setChatRecipient('new-chat', {
    kind: 'agent',
    id: agent.agent_id,
    name: agent.name || agent.agent_id,
  });
  return { kind: 'agent', agent };
}

// Quick-start cards prefill the composer and bind its configured specialist.
// Cards are individually marked as bound because a client-config refresh or
// locale change replaces the grid without replacing the containing section.
function _bindEmptyStateScenarioButtons(row) {
  if (!row) return;
  const buttons = Array.from(row.querySelectorAll('.new-chat-scenario-chip[data-scenario]'));
  buttons.forEach((btn, index) => {
    if (btn.dataset.quickStartBound === '1') return;
    btn.dataset.quickStartBound = '1';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.scenario || '';
      const config = _SCENARIO_CONFIGS[id];
      const position = index + 1;
      const startedAt = Date.now();
      const telemetry = {
        resource_id: id,
        agent_id: String((config && config.agentId) || ''),
        position,
        source: _quickStartSource,
      };
      _convTrackClick('commander_quick_start', telemetry);
      if (!config) {
        _convLog.warn('Commander quick-start scenario config missing', { resource_id: id, position });
        _convTrackEvent('commander_quick_start_result', {
          ...telemetry,
          result: 'failure',
          reason: 'config_missing',
          duration_ms: Date.now() - startedAt,
        });
        return;
      }
      const key = config && config.templateKey;
      const raw = key ? t(key) : '';
      const tmpl = (raw && raw !== key) ? raw : (_SCENARIO_TEMPLATES_FALLBACK_EN[id] || '');
      if (!tmpl) {
        _convLog.warn('Commander quick-start template missing', { resource_id: id, position });
        _convTrackEvent('commander_quick_start_result', {
          ...telemetry,
          result: 'failure',
          reason: 'template_missing',
          duration_ms: Date.now() - startedAt,
        });
        return;
      }
      const applied = await _scenarioApplyAgent(config, id);
      if (!applied || applied.kind === 'unavailable') {
        _convLog.warn('Commander quick-start recipient API unavailable', { resource_id: id, position });
        _convTrackEvent('commander_quick_start_result', {
          ...telemetry,
          result: 'failure',
          reason: (applied && applied.reason) || 'recipient_unavailable',
          duration_ms: Date.now() - startedAt,
        });
        return;
      }
      const input = document.getElementById('new-chat-input');
      if (!input) {
        _convLog.warn('Commander quick-start composer missing', { resource_id: id, position });
        _convTrackEvent('commander_quick_start_result', {
          ...telemetry,
          result: 'failure',
          reason: 'composer_missing',
          duration_ms: Date.now() - startedAt,
        });
        return;
      }
      input.value = tmpl;
      _setCommanderTemplateAttribution(input, {
        entry_point: 'quick_start',
        ...telemetry,
        recipient_type: applied.kind === 'agent' ? 'agent' : 'commander',
      });
      input.focus();
      // Select the concrete subject (coffee machine, login page, etc.) so the
      // user's next keystroke customizes the example immediately. Server-fed
      // templates may still carry a real placeholder; retain the existing
      // blocking behavior for those templates only.
      const subject = _quickStartText(config.subjectKey, config.subjectFallback || '');
      const editableSubject = _findQuickStartSubject(tmpl, subject);
      const placeholder = _findQuickStartPlaceholder(tmpl);
      if (editableSubject) {
        delete input.dataset.commanderQuickStartPlaceholder;
        input.setSelectionRange(editableSubject.start, editableSubject.end);
      } else if (placeholder) {
        input.dataset.commanderQuickStartPlaceholder = placeholder.text;
        input.setSelectionRange(placeholder.start, placeholder.end);
      } else {
        delete input.dataset.commanderQuickStartPlaceholder;
        input.setSelectionRange(tmpl.length, tmpl.length);
      }
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      _convTrackEvent('commander_quick_start_result', {
        ...telemetry,
        result: applied.kind === 'agent' ? 'success' : 'fallback',
        reason: applied.reason || '',
        recipient_type: applied.kind === 'agent' ? 'agent' : 'commander',
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}

function _initEmptyStateScenarios() {
  const row = document.getElementById('new-chat-scenarios');
  if (!row) return;
  _bindCommanderTemplateAttributionReset(document.getElementById('new-chat-input'));
  const grid = document.getElementById('new-chat-scenario-grid');
  if (grid && !grid.children.length) _renderQuickStartScenarios();
  _bindEmptyStateScenarioButtons(row);
  if (typeof initOssQuickTask === 'function') initOssQuickTask();
  _refreshQuickStartConfig(row);
}

window.addEventListener('i18n-change', () => {
  const row = document.getElementById('new-chat-scenarios');
  if (!row) return;
  _renderEmptyStateHeading();
  _renderQuickStartScenarios();
  _bindEmptyStateScenarioButtons(row);
  if (typeof initOssQuickTask === 'function') initOssQuickTask();
});
function onEnterConversationView() {
  if (_messageSelectionState && _messageSelectionState.cid !== currentCid) _exitMessageSelection();
  _renderRecipientChip('conversation');
  _refreshChatHeader();
  // Workspace chip scope follows the active conv's project (resolved on
  // main side via cid → conv.project_id). Refresh whenever a conv mounts.
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
  // Recipient validation: bindings may have changed since this conv was
  // last open (user removed the agent from the project). If the sticky
  // recipient is no longer in the project's agents, drop back to commander
  // so the chip matches what the dispatch path will actually route to.
  if (currentCid && Array.isArray(conversations)) {
    const conv = conversations.find((c) => c && c.conversation_id === currentCid);
    const pid = (conv && conv.project_id) || '';
    if (pid && typeof validateRecipientAgainstProject === 'function') {
      validateRecipientAgainstProject('conversation', pid);
    }
  }
  // Empty-bindings banner: when this conv belongs to a project and the
  // project has zero agents bound, surface a one-line notice + "Open
  // project page" affordance. Cheap IPC; only fires for in-project
  // conversations.
  if (typeof refreshConvProjectEmptyBanner === 'function') refreshConvProjectEmptyBanner(currentCid);
  // One-shot auto-expand: if the conv we just entered belongs to a
  // project, surface the project's row in the sidebar. Skipped when the
  // project is already expanded; manual user collapse on subsequent
  // renders is preserved (the auto-expand does not run inside
  // renderProjectsSection — see comments in projects.js).
  if (typeof autoExpandActiveConvProject === 'function') autoExpandActiveConvProject();
  // Kick a one-shot evaluation so that a cid with a live interactive agent
  // picks it up as the composer target even if no state_changed event fires
  // before the user types. View-enter never reverts to commander (see
  // `_evaluateAutoRecipient`); the persisted per-cid pick stays sticky.
  if (currentCid) _evaluateAutoRecipient(currentCid);
  if (window.ConversationInfo) window.ConversationInfo.bind(currentCid || null);
  _openConversationTurnNavigation(currentCid);
  // Returning to a conversation while its original send-stream is still
  // alive can miss state/process events that fired while another view was
  // active (the cross-cid guard intentionally drops them). Ask main for the
  // current in-flight actors so the visible placeholders catch up
  // immediately, instead of waiting for the next tool event.
  if (currentCid && isConvPending(currentCid)) {
    _syncPendingActorsFromRuntime(currentCid, { allowController: true }).catch(() => {});
  }
  // Quote preview is per-cid; rerender so a quote captured in another conv
  // doesn't bleed into this one (and a quote left in this conv reappears
  // when the user navigates back).
  _renderQuotePreview();
  _updateChatInputReserve();
}

// Called by queue-draft.js::_forgetConvLocal when a conv is deleted so we
// don't accumulate dead entries in localStorage forever.
function _forgetCidRecipient(cid) {
  if (!cid) return;
  if (_recipientByCid[cid]) {
    delete _recipientByCid[cid];
    _saveRecipientMap();
  }
  _autoRecipientByCid.delete(cid);
  _serverFloorByCid.delete(cid);
  _pendingFloorResetByCid.delete(cid);
  setGroupConversationBusy(cid, false);
  _latestInFlight.delete(cid);
  _latestActiveTurns.delete(cid);
  const infoTimer = _conversationInfoFileRefreshTimers.get(cid);
  if (infoTimer) clearTimeout(infoTimer);
  _conversationInfoFileRefreshTimers.delete(cid);
  // Drop any pending quote for the deleted conv (memory only — no localStorage).
  _quotesByCid.delete(cid);
  _failedConvs.delete(cid);
  _settledConvTurns.delete(cid);
  if (typeof _forgetUnreadConversation === 'function') _forgetUnreadConversation(cid);
}

// ─── Auto-recipient: route genuine human-in-loop interactive threads ─────
// Goal: when an agent holds the conversation floor (the commander handed off to
// it via `hand_off_to`), keep the composer pointed at that agent so the user's
// next reply lands there without a manual @-mention. The floor is server state
// (`_serverFloorByCid`); `_evaluateAutoRecipient` mirrors it into the composer
// target. Transient UI state only — it does not overwrite the user's explicit
// pick, and it clears when the server resets the floor.
//
// Concurrency: re-entrancy guarded by `_autoEvalInflight` so back-to-back
// state_changed events coalesce.
const _autoEvalInflight = new Set(); // cid set
const _latestInFlight = new Map();   // cid → string[] (mirrors state_changed.state.in_flight)
const _latestActiveTurns = new Map(); // cid → authoritative active_turns with steer capability

// queue-draft.js calls this at render time and again at click time. Returning
// copies keeps queue code from mutating the runtime recovery cache.
function _queueSendNowActiveTurns(cid) {
  const turns = _latestActiveTurns.get(cid);
  return Array.isArray(turns) ? turns.map(turn => ({ ...turn })) : [];
}

function _renderMessageQueueForRuntimeState(cid) {
  if (typeof renderMessageQueue === 'function') renderMessageQueue(cid);
}
const _runtimeRecoveryTimers = new Map(); // cid → timeout id
const _lastGroupWorkEventAt = new Map(); // cid → ms timestamp of process/artifact/assistant message
const _groupObserverCtrls = new Map();   // cid → recovery observer controller
const _conversationInfoFileRefreshTimers = new Map(); // cid → timeout id
const _offViewGroupProcessEvents = new Map(); // cid → bounded non-delta process events
const _MAX_OFF_VIEW_GROUP_PROCESS_EVENTS = 300;

function _isReplayableOffViewGroupProcessEvent(ev) {
  if (!ev || ev.type !== 'event' || ev.event?.stream !== 'group') return false;
  const groupEvent = ev.event.data;
  if (!groupEvent || groupEvent.type !== 'process') return false;
  const processData = groupEvent.data;
  if (processData?.type === 'event'
      && processData.event?.stream === 'cli'
      && processData.event?.data?.heartbeat === true) {
    return false;
  }
  return processData?.type === 'event'
    || processData?.type === 'progress'
    || processData?.type === 'commentary-finalized';
}

function _bufferOffViewGroupProcessEvent(cid, ev) {
  if (!cid || !_isReplayableOffViewGroupProcessEvent(ev)) return false;
  const items = _offViewGroupProcessEvents.get(cid) || [];
  items.push(ev);
  if (items.length > _MAX_OFF_VIEW_GROUP_PROCESS_EVENTS) {
    items.splice(0, items.length - _MAX_OFF_VIEW_GROUP_PROCESS_EVENTS);
  }
  _offViewGroupProcessEvents.set(cid, items);
  return true;
}

function _takeOffViewGroupProcessEvents(cid) {
  const items = _offViewGroupProcessEvents.get(cid) || [];
  _offViewGroupProcessEvents.delete(cid);
  return items;
}

function _clearOffViewGroupProcessEvents(cid) {
  _offViewGroupProcessEvents.delete(cid);
}
// Conversations whose latest turn ended in failure THIS SESSION. The
// conversation index carries no persisted per-conversation status, so this
// in-memory overlay drives the sidebar row's "failed" label. User-visible
// turn-end replies and bus-owned task terminal events are authoritative;
// controller transport errors are only a fallback when neither terminal source
// settled the turn. This distinction matters when the task completed and its
// reply was persisted, but the lifecycle stream itself disconnected while
// winding down.
const _failedConvs = new Set(); // cid set
const _settledConvTurns = new Map(); // cid → { status, source, runId, finishedAtMs }

function _setConvTurnSettlement(cid, status, opts = {}) {
  const id = String(cid || '');
  if (!id || !['completed', 'failed', 'waiting_input', 'cancelled', 'pending'].includes(status)) return false;
  const source = String(opts.source || '');
  const runId = String(opts.runId || '');
  const rawFinishedAtMs = Number(opts.finishedAtMs);
  const finishedAtMs = Number.isFinite(rawFinishedAtMs) && rawFinishedAtMs > 0
    ? Math.round(rawFinishedAtMs)
    : 0;
  const previous = _settledConvTurns.get(id);
  const replacesTransportFallback = previous?.source === 'transport' && source !== 'transport';
  // Live replies, history hydration, and task-terminal replay are independent
  // delivery paths. Compare their canonical timestamps whenever both sides
  // have one so an older result cannot reverse a newer user-visible outcome.
  // A transport failure is only a provisional fallback, however: its callback
  // can run after the task actually finished, so its later wall-clock time must
  // never prevent a delayed canonical reply/terminal from repairing the row.
  if (
    !replacesTransportFallback
    && previous?.finishedAtMs > 0
    && finishedAtMs > 0
    && previous.finishedAtMs > finishedAtMs
  ) return false;
  // An undated compatibility/history record cannot disprove a dated canonical
  // task terminal that this renderer already observed.
  if (previous?.source === 'task_terminal' && !finishedAtMs && source !== 'task_terminal') {
    return false;
  }
  _settledConvTurns.set(id, { status, source, runId, finishedAtMs });
  if (status === 'failed') _failedConvs.add(id);
  else _failedConvs.delete(id);
  _repaintConvRowStatus(id);
  return true;
}

function _syncFailedFromTaskTerminal(payload) {
  if (!payload || payload.type !== 'terminal') return false;
  return _setConvTurnSettlement(
    payload.conversation_id,
    String(payload.status || ''),
    {
      source: 'task_terminal',
      runId: payload.run_id,
      finishedAtMs: payload.finished_at_ms,
    },
  );
}

function _hasAuthoritativeCleanSettlement(cid) {
  const settled = _settledConvTurns.get(String(cid || ''));
  return !!settled && ['completed', 'waiting_input', 'cancelled'].includes(settled.status);
}

function _scheduleConversationInfoFileRefresh(cid, delayMs = 180) {
  const target = cid || currentCid;
  if (!target) return;
  const prev = _conversationInfoFileRefreshTimers.get(target);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    _conversationInfoFileRefreshTimers.delete(target);
    try {
      const info = window.ConversationInfo;
      if (info && typeof info.refreshFiles === 'function') {
        info.refreshFiles(target, { silent: true });
      } else if (info && typeof info.refresh === 'function') {
        info.refresh(target, { silent: true });
      }
    } catch (_) {}
  }, delayMs);
  _conversationInfoFileRefreshTimers.set(target, timer);
}

// While the primary send stream is alive it owns the process rail. `process`
// events are append-semantics (delta text, progress lines, tool rows) and carry
// no stable id, so delivering them from both subscribers would double every
// chunk. Everything else the observer relays is addressed by render key and is
// therefore safe to receive twice.
function _isPrimaryOwnedLiveEvent(evData) {
  return !!evData && evData.type === 'process';
}

function _stopRuntimeActorRecovery(cid) {
  const timer = _runtimeRecoveryTimers.get(cid);
  if (timer) clearTimeout(timer);
  _runtimeRecoveryTimers.delete(cid);
}

function _stopGroupEventObserver(cid) {
  const ctrl = _groupObserverCtrls.get(cid);
  if (!ctrl) return;
  _groupObserverCtrls.delete(cid);
  try { ctrl.abort(); } catch (_) {}
}

async function _syncPendingActorsFromRuntime(cid, opts = {}) {
  if (!cid || !isConvPending(cid)) return false;
  const state = pendingConvs.get(cid);
  if (!state || state.aborted) return false;
  // Runtime polling is recovery for renderer reload / lost local controller
  // cases. A live send-stream controller is already the authoritative event
  // source; letting this path finish it can manufacture empty loading bubbles
  // or clear pending in the middle of a plan handoff.
  const allowController = !!opts.allowController;
  const hasLiveController = !!state.controller && _convChatCtrls.has(cid);
  if (hasLiveController && !allowController) return false;
  const loadingEl = state.loadingEl;
  let data = null;
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/runtime`);
    data = await res.json();
  } catch (_) {
    return false;
  }
  if (!data || data.ok === false) return false;
  if (!isConvPending(cid) || pendingConvs.get(cid)?.aborted) return false;
  const inFlight = Array.isArray(data.in_flight)
    ? data.in_flight.filter(Boolean).map(String)
    : [];
  const hasActiveTurnsField = Array.isArray(data.active_turns);
  const activeTurns = _normaliseActiveTurns(data.active_turns);
  const processing = data.processing === true || inFlight.length > 0 || activeTurns.length > 0;
  if (window.ConversationInfo) {
    try { window.ConversationInfo.refreshFiles(cid, { silent: true }); } catch (_) {}
  }
  if (!processing) {
    _stopGroupEventObserver(cid);
    if (hasLiveController) {
      _latestInFlight.set(cid, []);
      _latestActiveTurns.set(cid, []);
      setGroupConversationBusy(cid, false);
      _updateConvSidebarBadge(cid, false);
      if (cid === currentCid) {
        _renderMessageQueueForRuntimeState(cid);
        _updateConvSendUI(cid);
      }
      return true;
    }
    _latestInFlight.set(cid, []);
    _latestActiveTurns.set(cid, []);
    setGroupConversationBusy(cid, false);
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) {
      _settleDanglingActorPlaceholders(cid);
      if (loadingEl && loadingEl.parentElement) _removeEmptyStreamingPlaceholder(loadingEl);
      _renderMessageQueueForRuntimeState(cid);
      _updateConvSendUI(cid);
    }
    _finishStreamingMsg(cid);
    return true;
  }

  setGroupConversationBusy(cid, true);
  _latestInFlight.set(cid, inFlight);
  _latestActiveTurns.set(cid, hasActiveTurnsField ? activeTurns : []);
  _serverFloorByCid.set(cid, typeof data.active_recipient === 'string' ? data.active_recipient : '');
  if (cid === currentCid) _evaluateAutoRecipient(cid);
  _updateConvSidebarBadge(cid, true);
  startPolling(cid);
  if (cid === currentCid) {
    _renderMessageQueueForRuntimeState(cid);
    _updateConvSendUI(cid);
  }
  if (hasLiveController) {
    // Re-arm the bus observer if this snapshot found a live run without one.
    // The observer is the conversation's only event source (the send stream
    // carries lifecycle only) and is idempotent per cid, so re-arming is safe
    // and losing it would silently stop the live rail.
    _observeConversationRunFromPlanAction(cid, {
      attachExisting: true,
      allowWithController: true,
    });
  }
  if (!hasLiveController) {
    // Runtime polling can tell us who is working, but it does not carry
    // process/delta events. When the local send-stream was lost (refresh,
    // stale controller state, or reconnect), attach the group event stream
    // so plan-triggered agents keep streaming instead of only appearing
    // after the final history poll.
    _observeConversationRunFromPlanAction(cid, { attachExisting: true });
  }
  if (!inFlight.length && !activeTurns.length) return false;

  // Names/avatars are local data; warm members before revealing so the
  // placeholder does not flash as an unknown agent.
  try { await _refreshGroupMembers(cid); } catch (_) { /* best effort */ }
  if (!isConvPending(cid) || pendingConvs.get(cid)?.aborted) return false;
  if (cid !== currentCid) return true;
  if (hasActiveTurnsField) {
    const activeCommander = activeTurns.some((t) => t.actor === 'commander');
    if (!activeCommander) _removeEmptyActorPlaceholder(cid, 'commander');
    for (const turn of activeTurns) {
      _ensureActorPlaceholder(cid, turn.actor, loadingEl, turn.turn_id, turn.msg_id, turn.started_at_ms);
    }
  } else {
    if (!inFlight.includes('commander')) _removeEmptyActorPlaceholder(cid, 'commander');
    for (const actorId of inFlight) {
      _ensureActorPlaceholder(cid, actorId, loadingEl);
    }
  }
  return true;
}

function _startRuntimeActorRecovery(cid) {
  if (!cid) return;
  _stopRuntimeActorRecovery(cid);
  let attempts = 0;
  const tick = async () => {
    attempts += 1;
    if (!isConvPending(cid) || pendingConvs.get(cid)?.aborted) {
      _stopRuntimeActorRecovery(cid);
      return;
    }
    const recovered = await _syncPendingActorsFromRuntime(cid, { allowController: true });
    if (!isConvPending(cid) || pendingConvs.get(cid)?.aborted) {
      _stopRuntimeActorRecovery(cid);
      return;
    }
    // Keep this alive for genuinely long plan steps. The timer is tied to
    // pending state and stops as soon as the controller / runtime settles;
    // capping at two minutes stranded long agent runs with a permanent
    // loading bubble after their final message landed on disk.
    if (attempts >= 1800) {
      _stopRuntimeActorRecovery(cid);
      return;
    }
    const delay = recovered ? 1000 : (attempts < 4 ? 250 : 1000);
    _runtimeRecoveryTimers.set(cid, setTimeout(tick, delay));
  };
  _runtimeRecoveryTimers.set(cid, setTimeout(tick, 150));
}

async function _evaluateAutoRecipient(cid) {
  if (!cid || cid !== currentCid) return;
  if (_autoEvalInflight.has(cid)) return;
  _autoEvalInflight.add(cid);
  try {
    // Server-authoritative floor: the composer target is whatever the server's
    // `active_recipient` says (set by the commander's `hand_off_to`), NOT a
    // client-side guess. Empty / commander → clear the auto-target (chip falls
    // back to commander or the user's explicit pick).
    // A pending floor-reset (user chose to return to commander) suppresses the
    // floor until the next send confirms it server-side.
    const floorId = _pendingFloorResetByCid.has(cid) ? '' : (_serverFloorByCid.get(cid) || '');
    if (!floorId) {
      if (_autoRecipientByCid.has(cid)) {
        _autoRecipientByCid.delete(cid);
        _renderRecipientChip('conversation');
      }
      return;
    }
    const cur = _activeRecipient('conversation');
    if (cur.kind === 'agent' && cur.id === floorId) return;
    // Resolve a display name for the floor agent (roster label, then registry).
    let name = _knownGroupActorLabel(cid, floorId) || '';
    if (!name && typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
      const a = _agentsCache.find((x) => x && x.agent_id === floorId);
      if (a && a.name) name = a.name;
    }
    setChatRecipient('conversation',
      { kind: 'agent', id: floorId, name: name || floorId },
      { auto: true });
  } catch (err) {
    _convLog?.warn?.('auto-recipient evaluate failed', err);
  } finally {
    _autoEvalInflight.delete(cid);
  }
}

function _bindChatHeaderActions() {
  const menuBtn = document.getElementById('chat-header-menu-btn');
  const titleInput = document.getElementById('chat-header-title-input');
  if (menuBtn && menuBtn.dataset.bound !== '1') {
    menuBtn.dataset.bound = '1';
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentCid) return;
      _openConversationActionMenu(menuBtn, currentCid, { renameInHeader: true });
    });
  }
  if (titleInput && titleInput.dataset.bound !== '1') {
    titleInput.dataset.bound = '1';
    if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(titleInput);
    let committing = false;
    const commit = async (accept) => {
      if (committing) return;
      const cid = _conversationHeaderRenameCid;
      if (!cid) return;
      committing = true;
      const next = _normaliseConversationTitle(titleInput.value);
      if (!accept || !next) {
        _cancelConversationHeaderRename(cid);
        committing = false;
        return;
      }
      const ok = await _saveConversationTitle(cid, next);
      committing = false;
      if (!ok && _conversationHeaderRenameCid === cid) {
        titleInput.focus();
        titleInput.select();
      }
    };
    titleInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    titleInput.addEventListener('blur', () => commit(true));
  }
  _refreshChatHeader();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindChatHeaderActions, { once: true });
  } else {
    _bindChatHeaderActions();
  }
}

// Strip a leading `@<name>` token so the mention regex matches the bus
// router's charset. Used to detect whether the user already typed an
// @-prefix that would route somewhere.
const _LEADING_MENTION_RE = /^@([A-Za-z0-9_一-鿿-]+)\s?/u;

// `@commander` / `@指挥官` is a transport-only routing marker. The group bus
// removes it before persisting the user message, but the optimistic bubble is
// painted from the outbound payload before that echo arrives. Mirror the bus's
// reserved-recipient cleanup at the display boundary so live and historical
// bubbles agree without changing the payload used for routing or retry.
function _stripCommanderRoutingMentionsForDisplay(raw) {
  let text = String(raw || '');
  text = text.replace(
    /(^|\s|[,，:：。！？!?])@(?:commander|指挥官)(?=$|\s|[,，:：。！？!?])/giu,
    '$1',
  );
  text = text.replace(/[ \t]+([,，:：。！？!?])/g, '$1');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  return text.trim();
}

function _normaliseRecipientSnapshot(snapshot) {
  const r = _normRecipient(snapshot);
  if (!r) return null;
  return {
    ...r,
    resetFloor: snapshot && snapshot.resetFloor === true,
  };
}

function _recipientSnapshotForSend(target) {
  const tg = target || 'conversation';
  const r = _activeRecipient(tg);
  const snap = _normaliseRecipientSnapshot(r) || { ..._COMMANDER, resetFloor: false };
  snap.resetFloor = tg === 'conversation'
    && !!currentCid
    && _pendingFloorResetByCid.has(currentCid);
  return snap;
}

function _takeRecipientSnapshotForSend(target) {
  const tg = target || 'conversation';
  const snap = _recipientSnapshotForSend(tg);
  if (tg === 'conversation' && currentCid && snap.resetFloor) {
    _pendingFloorResetByCid.delete(currentCid);
  }
  return snap;
}

function _recipientPrefixName(r) {
  if (!r || r.kind !== 'agent' || !r.id) return '';
  let display = '';
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === r.id);
    if (a && a.name) display = a.name;
  }
  return display || r.name || r.id;
}

function _applyRecipientPrefixWithSnapshot(raw, snapshot) {
  const text = String(raw || '');
  const snap = _normaliseRecipientSnapshot(snapshot);
  if (!snap) return raw;
  if (snap.resetFloor) {
    if (_LEADING_MENTION_RE.exec(text)) return text;
    const sep = /^>/.test(text) ? '\n' : ' ';
    return '@commander' + sep + text;
  }
  if (snap.kind !== 'agent' || !snap.id) return raw;
  if (_LEADING_MENTION_RE.exec(text)) return text;
  const display = _recipientPrefixName(snap);
  if (!display) return raw;
  const sep = /^>/.test(text) ? '\n' : ' ';
  return '@' + String(display) + sep + text;
}

function applyRecipientPrefix(raw, target, opts = {}) {
  if (opts && opts.recipientSnapshot) {
    return _applyRecipientPrefixWithSnapshot(raw, opts.recipientSnapshot);
  }
  const tg = target || 'conversation';
  const text0 = String(raw || '');
  // One-shot floor reset: user returned to the commander while handed off.
  // Inject `@commander` so the server resets the floor, then disarm.
  if (tg === 'conversation' && currentCid && _pendingFloorResetByCid.has(currentCid)) {
    _pendingFloorResetByCid.delete(currentCid);
    if (!_LEADING_MENTION_RE.exec(text0)) {
      const sep = /^>/.test(text0) ? '\n' : ' ';
      return '@commander' + sep + text0;
    }
    return text0;
  }
  const r = _activeRecipient(tg);
  if (r.kind !== 'agent' || !r.id) return raw;
  const text = String(raw || '');
  if (_LEADING_MENTION_RE.exec(text)) return text;
  // Resolve from the live registry by id — `r.name` is a localStorage
  // snapshot taken at picker time, so a rename leaves it stale and the
  // outgoing `@<token>` would still carry the old name. Fall back to the
  // snapshot when the registry doesn't know the agent (deleted), then to
  // the id as last resort.
  const display = _recipientPrefixName(r);
  const tag = '@' + String(display);
  // When the raw body starts with a blockquote (e.g. the quote-reply prefix
  // injected by applyQuotePrefix), use a newline separator so the @-mention
  // ends up on its own line — markdown only treats `>` as a blockquote when
  // it sits at column 0, and `@AgentB > ...` on one line collapses the
  // blockquote into plain prose. Plain-text bodies keep the original space.
  const sep = /^>/.test(text) ? '\n' : ' ';
  return tag + sep + text;
}

if (typeof window !== 'undefined') {
  const initChip = () => { _renderRecipientChip(); _renderQuotePreview(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChip, { once: true });
  } else {
    initChip();
  }
  window.addEventListener('i18n-change', () => { _renderRecipientChip(); _renderQuotePreview(); });
}

// ─── Group-chat translation layer ─────────────────────────────────────────
// Backend now stores GroupMessage{ id, ts, from, to, mentions?, text, ... }.
// Renderer's existing bubble code expects MessageRecord{ role, content, time }.
// Translate at read/stream boundary so we don't have to rewrite every render
// path. `from === 'user'` → role=user; otherwise role=assistant with a
// "from-name" label rendered as a header chip on the bubble.
const GROUP_RESERVED = new Set(['user', 'commander']);

// Commander avatar preference, lazy-loaded cache. Used by the chat row
// renderer — fire one IPC before the first render, then refresh this
// cache on every subsequent update. `null` = not loaded / unavailable;
// the render layer falls back to the default itself.
let _commanderAvatarCache = null;
function _normalizeCommanderAvatar(avatar) {
  const fallback = (typeof COMMANDER_DEFAULT !== 'undefined' && COMMANDER_DEFAULT)
    ? COMMANDER_DEFAULT
    : { icon: 'crown', color: 'gold' };
  return {
    icon: fallback.icon || 'crown',
    color: avatar?.color || fallback.color || 'gold',
  };
}
function _commanderAvatar() {
  return _commanderAvatarCache || _normalizeCommanderAvatar(null);
}
async function _ensureCommanderAvatarLoaded() {
  if (_commanderAvatarCache) return _commanderAvatarCache;
  try {
    const res = await window.orkas.invoke('prefs.getCommanderAvatar');
    if (res?.ok && res.avatar) {
      _commanderAvatarCache = _normalizeCommanderAvatar(res.avatar);
    }
  } catch (_) { /* fall back to default */ }
  return _commanderAvatarCache || _normalizeCommanderAvatar(null);
}
function setCommanderAvatarCache(avatar) {
  if (avatar && avatar.color) {
    _commanderAvatarCache = _normalizeCommanderAvatar(avatar);
  }
}
function _isAgentActor(fromId) {
  return !!fromId && !GROUP_RESERVED.has(String(fromId));
}

function _isActorDetailTarget(fromId) {
  const id = String(fromId || '');
  return id === 'commander' || _isAgentActor(id);
}

function _actorLinkAttrs(fromId) {
  return _isActorDetailTarget(fromId)
    ? ` data-actor-agent-id="${escapeHtml(String(fromId))}" role="button" tabindex="0"`
    : '';
}

async function _openActorAgentDetail(actorId) {
  const aid = String(actorId || '').trim();
  if (!_isActorDetailTarget(aid)) return;
  if (window.Monitor) (() => {})('message_actor_open', { agent_id: aid });
  setView('agents');
  if (aid === 'commander') {
    if (typeof openAgentDetail === 'function') await openAgentDetail('commander', { returnTarget });
    else if (typeof selectAgent === 'function') await selectAgent('commander');
    return;
  }
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
    const data = await res.json();
    if (!data?.ok || !data?.agent) {
      // Agent was deleted / renamed / never installed under this uid — the
      // user clicked the actor header but there is no detail to open. Keep
      // them on the entry page and explain why instead of silently dropping
      // the click.
      _convLog.warn('open message actor: agent not found', { agent_id: aid });
      try { await uiAlert(t('agents.agent_not_found')); } catch (_) {}
      return;
    }
  } catch (err) {
    const msg = String(err && err.message || err);
    _convLog.warn('open message actor failed', { agent_id: aid, error: msg });
    try { await uiAlert(t('chat.unknown_error') + ': ' + msg); } catch (_) {}
    return;
  }
  if (typeof openAgentDetail === 'function') await openAgentDetail(aid, { returnTarget });
  else if (typeof selectAgent === 'function') await selectAgent(aid);
}

function _hydrateActorHeaderLinks(root) {
  if (!root) return;
  const links = root.querySelectorAll('[data-actor-agent-id]');
  for (const el of links) {
    if (el.dataset.actorLinkBound === '1') continue;
    el.dataset.actorLinkBound = '1';
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      _openActorAgentDetail(el.dataset.actorAgentId);
    });
    el.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      _openActorAgentDetail(el.dataset.actorAgentId);
    });
  }
}

function _decorateActorHeader(root, actorId) {
  if (!root) return;
  const aid = String(actorId || '');
  const linkable = _isActorDetailTarget(aid);
  const targets = [
    root.querySelector('.chat-msg-header .chat-msg-from'),
    root.querySelector('.chat-msg-header .avatar-circle'),
  ].filter(Boolean);
  for (const el of targets) {
    if (linkable) {
      el.dataset.actorAgentId = aid;
      el.classList.add('is-agent-link');
      if (el.classList.contains('avatar-circle')) el.classList.add('is-clickable');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
    } else {
      delete el.dataset.actorAgentId;
      el.classList.remove('is-agent-link');
      if (el.classList.contains('avatar-circle')) el.classList.remove('is-clickable');
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      delete el.dataset.actorLinkBound;
    }
  }
  if (linkable) _hydrateActorHeaderLinks(root);
}

/** Render the message row avatar. `fromId` is known to be non-'user'. */
function _renderActorAvatarHtml(fromId) {
  if (fromId === 'commander') {
    const a = _commanderAvatar();
    return renderAvatarHtml(a.icon, a.color, { size: 28, seed: 'commander' });
  }
  // The global agents registry takes priority — it's always the current
  // truth. The per-group member cache is just a join-time snapshot and
  // does not follow rename / avatar changes, so it serves as fallback
  // for legacy conversations whose agent has since been deleted from
  // the registry.
  let icon, color;
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === fromId);
    if (a) { icon = a.icon; color = a.color; }
  }
  if (!icon || !color) {
    const members = _groupMembersCache.get(currentCid);
    if (members) {
      const m = members.find((x) => x.id === fromId);
      if (m) { icon = icon || m.icon; color = color || m.color; }
    }
  }
  return renderAvatarHtml(icon, color, {
    size: 28,
    seed: fromId || 'agent',
    clickable: _isActorDetailTarget(fromId),
    dataAttrs: _isActorDetailTarget(fromId) ? { 'actor-agent-id': String(fromId) } : {},
  });
}
/** Resolve an actor id (commander / user / agent_id) to a human-readable
 *  display name. **Never returns the raw agent_id** — UI shouldn't expose
 *  hex strings to the user. Global registry is checked first so renames
 *  reflect immediately in old conversations; per-conv roster (a join-time
 *  snapshot) is the fallback for agents the registry no longer knows about
 *  (deleted agents whose old chats still need a label). */
function _groupActorLabel(fromId) {
  if (fromId === 'user') return null;
  if (fromId === 'commander') return t('chat.from_commander');
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === fromId);
    if (a && a.name) return a.name;
  }
  const cached = _groupMembersCache.get(currentCid);
  if (cached) {
    const a = cached.find((x) => x.id === fromId);
    if (a && a.name) return a.name;
  }
  // Last resort: never leak the id. Show a neutral placeholder; the chip
  // will repaint as soon as the cache catches up (state_changed handler
  // refreshes _groupMembersCache).
  return t('chat.from_agent_unknown');
}
const _groupMembersCache = new Map(); // cid → Actor[]
async function _refreshGroupMembers(cid) {
  if (!cid) return [];
  try {
    const res = await apiFetch(_membersRequestUrl(cid));
    const data = await res.json();
    if (data?.ok && Array.isArray(data.actors)) {
      _groupMembersCache.set(cid, data.actors);
      _refreshActorPlaceholders(cid);
      // Chat header's actor stack reads from the same cache. Without this
      // call the header's avatars don't appear on first open (the
      // `onEnterConversationView → _refreshChatHeader` call fires before
      // this async fetch lands), and stale ones don't repaint after `@`.
      if (cid === currentCid) {
        try { _renderRecipientChip('conversation'); } catch (_) { /* not yet bound */ }
        try { _refreshChatHeader(); } catch (_) { /* not yet bound */ }
      }
      // Roster change can flip the inline "create agent" button visibility:
      // a freshly @-mentioned agent joins members.json before it streams a
      // reply, and the button must hide as soon as that happens.
      if (cid === currentCid) {
        try { _ensureConvCreateAgentInline(); } catch (_) { /* non-fatal */ }
      }
      return data.actors;
    }
  } catch (_) { /* non-fatal */ }
  return _groupMembersCache.get(cid) || [];
}

function _rememberGroupActor(cid, actor) {
  if (!cid || !actor || !actor.id) return;
  const existing = _groupMembersCache.get(cid) || [];
  const idx = existing.findIndex((x) => x && x.id === actor.id);
  const next = existing.slice();
  if (idx >= 0) next[idx] = { ...next[idx], ...actor };
  else next.push(actor);
  _groupMembersCache.set(cid, next);
  _refreshActorPlaceholders(cid, actor.id);
  if (cid === currentCid) {
    try { _refreshChatHeader(); } catch (_) { /* not yet bound */ }
  }
}

// Read-side normalizer: jsonl records written before the multi-edit
// migration carry singular `created_agent`; new ones carry plural
// `created_agents`. Returns the array, or `null` when neither field is set.
function _normalizeCreatedAgents(gm) {
  if (!gm) return null;
  if (Array.isArray(gm.created_agents) && gm.created_agents.length) return gm.created_agents;
  if (gm.created_agent && gm.created_agent.agent_id) return [gm.created_agent];
  return null;
}
function _normalizeCreatedSkills(gm) {
  if (!gm) return null;
  if (Array.isArray(gm.created_skills) && gm.created_skills.length) return gm.created_skills;
  if (gm.created_skill && gm.created_skill.skill_id) return [gm.created_skill];
  return null;
}

function _groupMessageSystemKind(gm) {
  const explicit = String(gm?.system_kind || gm?._system_kind || '');
  if (explicit) return explicit;
  // Compatibility for interruption rows written by the first release that
  // persisted them without an explicit discriminator. `model_text` is a
  // stable host-authored English protocol string regardless of UI locale.
  const modelText = String(gm?.model_text || '');
  if (modelText.startsWith('The previous assistant run was interrupted by an application exit or crash')) {
    return 'reply_interrupted';
  }
  return '';
}

// An interruption status is useful while the old turn is genuinely stopped.
// Once the same actor continues without another visible user message, the
// status has been superseded and must not remain as a second assistant bubble.
// Keep this record-level pass shared by cold history, polling and reconcile so
// those paths agree about which persisted rows should have DOM nodes.
function _collapseSupersededInterruptionRecords(records) {
  if (!Array.isArray(records) || !records.length) return [];
  const out = [];
  const pendingByActor = new Map();
  for (const gm of records) {
    if (!gm) continue;
    const actor = String(gm.from || gm._from || '');
    const isUser = actor === 'user' || gm.role === 'user';
    if (isUser) {
      pendingByActor.clear();
      out.push(gm);
      continue;
    }
    if (_groupMessageSystemKind(gm) === 'reply_interrupted') {
      let previous = null;
      for (let index = out.length - 1; index >= 0; index -= 1) {
        if (out[index] != null) {
          previous = out[index];
          break;
        }
      }
      const previousActor = String(previous?.from || previous?._from || '');
      const previousCompletedTurn = previous?.turn_end === true
        || !!String(previous?.source_message_id || '').trim();
      if (previous
        && previousActor === actor
        && previousCompletedTurn
        && _groupMessageSystemKind(previous) !== 'reply_interrupted') {
        // Compatibility for older builds that recovered a lagging `running`
        // state after this actor's complete terminal reply was already durable.
        // The status row is false recovery residue, not a second reply.
        continue;
      }
      const previousIndex = pendingByActor.get(actor);
      if (previousIndex !== undefined) out[previousIndex] = null;
      pendingByActor.set(actor, out.length);
      out.push(gm);
      continue;
    }
    const supersededIndex = pendingByActor.get(actor);
    if (supersededIndex !== undefined) {
      out[supersededIndex] = null;
      pendingByActor.delete(actor);
    }
    out.push(gm);
  }
  return out.filter(Boolean);
}

// Client-side identity for an optimistic user bubble. The bus echoes it back on
// the persisted record (`GroupMessage.client_msg_id`), which is what lets the
// renderer claim the exact node it painted. Never used for assistant messages —
// those are identified by `msg.id` once persisted, and by their segment key
// while streaming.
let _clientMsgIdSeq = 0;
function _newClientMsgId() {
  _clientMsgIdSeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${Date.now().toString(36)}${_clientMsgIdSeq.toString(36)}${rand}`;
}

function _groupMsgToLegacy(gm) {
  if (!gm || typeof gm !== 'object') return gm;
  if (gm.role !== undefined) return gm; // already legacy shape
  const fromId = String(gm.from || 'user');
  const role = fromId === 'user' ? 'user' : 'assistant';
  // Prepend a "from-name" header so user can tell who sent each message.
  // Skip for `user` (their own messages) and `commander` (default reply
  // source — labeling every commander msg is noise; UI accent color tells).
  let body = String(gm.text || '');
  let label = '';
  if (fromId !== 'user' && fromId !== 'commander') {
    label = _groupActorLabel(fromId) || fromId;
  }
  const out = {
    role,
    content: body,
    time: gm.ts || new Date().toISOString(),
    _from: fromId,
    _msg_id: gm.id,
    _render_key: _messageRenderKey(gm),
    ...(gm.client_msg_id ? { _client_msg_id: gm.client_msg_id } : {}),
    ...(label ? { _from_label: label } : {}),
    ...(Array.isArray(gm.attachments) && gm.attachments.length ? { attachments: gm.attachments } : {}),
    ...(Array.isArray(gm.produced) && gm.produced.length ? { produced: gm.produced } : {}),
    ...(Array.isArray(gm.references) && gm.references.length ? { references: gm.references } : {}),
    ...(gm.form ? { form: gm.form } : {}),
    ...(_normalizeCreatedAgents(gm) ? { created_agents: _normalizeCreatedAgents(gm) } : {}),
    ...(_normalizeCreatedSkills(gm) ? { created_skills: _normalizeCreatedSkills(gm) } : {}),
    ...(Array.isArray(gm.artifacts) && gm.artifacts.length ? { artifacts: gm.artifacts } : {}),
    ...(Array.isArray(gm.marketplace_requests) && gm.marketplace_requests.length ? { marketplace_requests: gm.marketplace_requests } : {}),
    ...(gm.plan_announcement ? { _plan_announcement: true } : {}),
    ...(Array.isArray(gm.process) && gm.process.length ? { process: gm.process } : {}),
    ...(gm.turn_id ? { _turn_id: gm.turn_id } : {}),
    ...(gm.failure_kind ? { failure_kind: gm.failure_kind } : {}),
    ...(gm.failure_code ? { failure_code: gm.failure_code } : {}),
    ...(_groupMessageSystemKind(gm) ? { _system_kind: _groupMessageSystemKind(gm) } : {}),
    ...(Number.isSafeInteger(gm._history_index) ? { _history_index: gm._history_index } : {}),
  };
  return out;
}

function _syncRenderedGroupMessageIdentity(el, message) {
  if (!el || !message) return;
  const msgId = message.id || message._msg_id;
  if (msgId && !el.dataset.msgId) el.dataset.msgId = String(msgId);
  const from = message.from || message._from;
  if (from && !el.dataset.fromActor) el.dataset.fromActor = String(from);
  const turnId = message.turn_id || message.turnId || message._turn_id;
  if (turnId && !el.dataset.turnId) el.dataset.turnId = String(turnId);
  const systemKind = message.system_kind || message._system_kind;
  if (systemKind && !el.dataset.systemKind) el.dataset.systemKind = String(systemKind);
  const failureKind = message.failure_kind || message._failure_kind;
  if (failureKind) el.dataset.failureKind = String(failureKind);
  const failureCode = message.failure_code || message._failure_code;
  if (failureCode) el.dataset.failureCode = String(failureCode);
  const tsInput = message.ts || message.time;
  if (tsInput) {
    el.dataset.ts = String(_msTs(tsInput));
    const parent = el.parentElement;
    if (parent && !_isTimestampPositionCorrect(parent, el)) {
      parent.removeChild(el);
      _insertByTimestamp(parent, el);
    }
  }
  _syncBubbleReferenceActionState(el);
}

/** Locate the node a record already occupies. Identity only: the persisted id,
 * then the record's render key (which a live segment or an optimistic user
 * bubble already carries). The old fallback matched on
 * sender+second-resolution-timestamp+text hash, which two genuinely different
 * replies can share — it needed its own guard against collapsing them. */
function _findRenderedGroupMessage(container, message, exclude = null) {
  if (!container || !message) return null;
  const msgId = message.id || message._msg_id;
  if (msgId) {
    const existingById = container.querySelector(
      `.chat-message[data-msg-id="${CSS.escape(String(msgId))}"]`,
    );
    if (existingById && existingById !== exclude) return existingById;
  }
  const renderKey = message._render_key || _messageRenderKey(message);
  if (!renderKey) return null;
  for (const candidate of container.querySelectorAll(
    `.chat-message[data-render-key="${CSS.escape(String(renderKey))}"]`,
  )) {
    if (candidate === exclude) continue;
    // A key can be reused across attempts of one turn (retry resumes under the
    // same `turn_id`). Once both sides carry a persisted id, identity is
    // authoritative: a different id is a different reply, not a duplicate.
    const candidateId = candidate.dataset.msgId || '';
    if (msgId && candidateId && candidateId !== String(msgId)) continue;
    return candidate;
  }
  return null;
}

// ─── Chat attachments (pending-send pool per cid) ─────────────────────────
// User picks files via "+" → we upload them to `<cid>/` and remember them in
// this Map. On send we hand the filenames to the server; on success the list
// for that cid is cleared (per-message granularity). Each entry is
// {name, displayName?, kind, bytes, dataUrl?, sha256?, reused?}. `name` is the
// real attachment-pool filename; `displayName` is the stable composer label.

const _chatAttachments = new Map();   // cid → Array<{name, displayName?, kind, bytes, dataUrl?, sha256?, reused?}>

// Draft cid used by the commander (new-chat) tab — files land in a local-only
// draft pool until the user hits send, at which point the backend adopts that
// dir into the freshly-minted conversation cid (see `adoptDraftAttachments`).
const DRAFT_CID = 'main_chat';

const CHAT_ATTACH_ACCEPT = [
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
  '.zip',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
  '.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac',
];

const CHAT_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const CHAT_VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
const CHAT_AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac'];
const ORKAS_FILE_DRAG_MIME = 'application/x-orkas-file';

function _chatFileIconHtml(name, kind) {
  if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') return window.fileKindIconHtml(name, kind);
  return '';
}

function _chatAttachExtOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function _chatAttachKindFromExt(ext) {
  if (CHAT_IMAGE_EXTS.includes(ext)) return 'image';
  if (CHAT_VIDEO_EXTS.includes(ext)) return 'video';
  if (CHAT_AUDIO_EXTS.includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  if (ext === '.zip') return 'archive';
  return 'text';
}

function _chatAttachTargetOf(cid) {
  if (cid === DRAFT_CID) return 'new_chat';
  if (typeof cid === 'string' && cid.startsWith('projchat-')) return 'project';
  if (typeof cid === 'string' && cid.startsWith('agent-edit-')) return 'agent_edit';
  if (typeof cid === 'string' && cid.startsWith('skill-edit-')) return 'skill_edit';
  return 'conversation';
}

function _chatAttachPayload(cid, files, source) {
  const list = Array.from(files || []);
  const kinds = {};
  let totalBytes = 0;
  for (const file of list) {
    const name = file && (file.name || file.path || '');
    const kind = _chatAttachKindFromExt(_chatAttachExtOf(name));
    kinds[kind] = (kinds[kind] || 0) + 1;
    totalBytes += Number((file && (file.size || file.bytes)) || 0);
  }
  return {
    source,
    target: _chatAttachTargetOf(cid),
    file_count: list.length,
    total_bytes: totalBytes,
    image_count: kinds.image || 0,
    video_count: kinds.video || 0,
    audio_count: kinds.audio || 0,
    document_count:
      (kinds.pdf || 0) + (kinds.docx || 0) + (kinds.spreadsheet || 0)
      + (kinds.presentation || 0),
    text_count: kinds.text || 0,
  };
}

function _chatAttachBaseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function _chatAttachHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function _chatAttachSha256(buf) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return '';
  const digest = await subtle.digest('SHA-256', buf);
  return _chatAttachHex(digest);
}

async function _chatAttachPrepareUploadFiles(cid, fileList) {
  const files = Array.from(fileList || []);
  const rejected = [];
  const prepared = [];
  const seenHashes = new Set(
    _chatAttachList(cid)
      .map((item) => item && item.sha256 ? `${Number(item.bytes) || 0}:${item.sha256}` : '')
      .filter(Boolean),
  );

  for (const file of files) {
    const ext = _chatAttachExtOf(file.name);
    if (!CHAT_ATTACH_ACCEPT.includes(ext)) {
      rejected.push(t('chat.attach_unsupported', { name: file.name }));
      continue;
    }

    let buf;
    let sha256 = '';
    try {
      buf = await file.arrayBuffer();
    } catch (err) {
      rejected.push(t('chat.attach_upload_fail', { name: file.name, reason: err.message || t('chat.attach_upload_generic_fail') }));
      continue;
    }
    try { sha256 = await _chatAttachSha256(buf); }
    catch (_) { sha256 = ''; }

    const key = sha256 ? `${buf.byteLength}:${sha256}` : '';
    if (key && seenHashes.has(key)) continue;
    if (key) seenHashes.add(key);
    prepared.push({ file, ext, buf, sha256 });
  }

  return { prepared, rejected };
}

// Build the `chat-media://` URL for serving an attachment's raw bytes to an
// <img> or <video>. The main-process handler enforces uid + path safety; we
// just URL-encode both path segments here.
function _chatMediaUrl(cid, name) {
  return `chat-media://cid/${encodeURIComponent(cid)}/${encodeURIComponent(name)}`;
}

function _chatAttachList(cid) {
  return _chatAttachments.get(cid) || [];
}

function _chatAttachSet(cid, items) {
  _chatAttachments.set(cid, items);
  _chatAttachRenderChips(cid);
  if (cid && cid === currentCid && window.ConversationInfo) {
    window.ConversationInfo.refreshAttachments(cid, { items });
  }
  if (cid && typeof _persistQueueComposerEditState === 'function') {
    _persistQueueComposerEditState(cid);
  }
}

async function _chatAttachDeleteItemFile(cid, item) {
  if (!item || item.status === 'uploading' || item.reused) return;
  try {
    await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments?name=${encodeURIComponent(item.name)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    _convLog.warn('delete attachment failed', err);
  }
}

async function _chatAttachClear(cid, opts = {}) {
  const deleteFiles = !!(opts && opts.deleteFiles);
  if (deleteFiles) {
    const items = _chatAttachList(cid).slice();
    for (const item of items) {
      if (item && item.dataUrl && item.dataUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.dataUrl); } catch (_) { /* ignore */ }
      }
      await _chatAttachDeleteItemFile(cid, item);
    }
  }
  _chatAttachments.delete(cid);
  _chatAttachRenderChips(cid);
  if (cid && cid === currentCid && window.ConversationInfo) {
    window.ConversationInfo.refreshAttachments(cid, { items: [] });
  }
}

// cid → DOM host id for the chip row. Draft cid (commander tab) renders into the
// new-chat panel; any real cid renders into the active conversation panel
// only when it matches currentCid (stale states for other cids stay in the
// Map but aren't painted).
function _chatAttachHostIdFor(cid) {
  if (cid === DRAFT_CID) return 'new-chat-attachments';
  if (cid && cid === currentCid) return 'chat-attachments';
  if (typeof cid === 'string' && cid.startsWith('agent-edit-')) return 'agents-chat-attachments';
  if (typeof cid === 'string' && cid.startsWith('skill-edit-')) return 'skills-chat-attachments';
  // Per-project commander draft pool (KB "ask the commander about this file").
  if (typeof cid === 'string' && cid.startsWith('projchat-')) return 'project-chat-attachments';
  return null;
}

function _chatAttachRenderChips(cid) {
  const targetCid = cid || currentCid;
  const hostId = _chatAttachHostIdFor(targetCid);
  if (!hostId) return;
  const host = document.getElementById(hostId);
  if (!host) return;
  const items = _chatAttachList(targetCid);
  if (!items.length) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = '';
  host.innerHTML = items.map((it, i) => {
    const displayName = it.displayName || it.name;
    const icon = it.kind === 'image'
      ? (it.dataUrl ? `<img class="chat-attach-thumb" src="${it.dataUrl}" alt="">` : _chatFileIconHtml(displayName, it.kind))
      : _chatFileIconHtml(displayName, it.kind);
    const label = escapeHtml(displayName);
    const busy = it.status === 'uploading';
    const errored = it.status === 'error';
    const klass = `chat-attach-chip${busy ? ' is-uploading' : ''}${errored ? ' is-error' : ''}`;
    const overlay = busy ? `<span class="chat-attach-spinner" aria-label="${escapeHtml(t('chat.attach_uploading'))}"></span>` : '';
    const previewDisabled = it.status === 'ready' && it.name ? '' : ' disabled';
    const removable = !busy;   // × stays clickable when errored so user can clear
    const removeBtn = removable
      ? `<span class="chat-attach-remove" data-idx="${i}" title="${escapeHtml(t('chat.attach_remove_title'))}">×</span>`
      : '';
    return `
      <span class="${klass}" data-idx="${i}" title="${label}">
        <button type="button" class="chat-attach-preview" data-idx="${i}" aria-label="${label}"${previewDisabled}>
          <span class="chat-attach-icon">${icon}</span>
          <span class="chat-attach-label">${label}</span>
        </button>
        ${overlay}
        ${removeBtn}
      </span>`;
  }).join('');
  host.querySelectorAll('.chat-attach-preview:not(:disabled)').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      await _chatAttachOpenPreview(targetCid, _chatAttachList(targetCid)[idx]);
    });
  });
  host.querySelectorAll('.chat-attach-remove').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      await _chatAttachRemove(targetCid, idx);
    });
  });
}

async function _chatAttachOpenPreview(cid, item) {
  if (!cid || !item || item.status !== 'ready' || !item.name) return;
  if (typeof openChatFileViewer !== 'function') return;
  const displayName = item.displayName || item.name;
  try {
    const res = await window.orkas.invoke('attachments.absPath', { cid, name: item.name });
    if (!res || !res.ok || !res.path) {
      _convLog.warn('attachments.absPath pending preview failed', {
        cid,
        name: item.name,
        error: res && res.error,
      });
      _showFileMissingToast(displayName);
      return;
    }
    await openChatFileViewer(res.path, displayName, { cid });
  } catch (err) {
    _convLog.warn('attachments.absPath pending preview threw', {
      cid,
      name: item.name,
      error: String(err && err.message || err),
    });
    _showFileMissingToast(displayName);
  }
}

async function _chatAttachRemove(cid, idx) {
  const items = _chatAttachList(cid).slice();
  const item = items[idx];
  if (!item) return;
  // Revoke object URLs we minted locally for image previews.
  if (item.dataUrl && item.dataUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(item.dataUrl); } catch (_) { /* ignore */ }
  }
  // Only delete files this chip created. Reused files can belong to earlier
  // messages, so removing the pending chip must leave the original on disk.
  await _chatAttachDeleteItemFile(cid, item);
  items.splice(idx, 1);
  _chatAttachSet(cid, items);
}

function _chatAttachReplaceByTempId(cid, tempId, patch) {
  const items = _chatAttachList(cid).slice();
  const idx = items.findIndex((it) => it.tempId === tempId);
  if (idx < 0) return;
  if (patch === null) {
    // Drop the entry entirely (error path).
    items.splice(idx, 1);
  } else {
    const next = { ...items[idx], ...patch };
    const dupIdx = next.name
      ? items.findIndex((it, i) => i !== idx && it.name === next.name && it.status !== 'uploading')
      : -1;
    if (dupIdx >= 0) {
      if (items[idx].dataUrl && items[idx].dataUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(items[idx].dataUrl); } catch (_) { /* ignore */ }
      }
      items.splice(idx, 1);
    } else {
      items[idx] = next;
    }
  }
  _chatAttachSet(cid, items);
}

async function _chatAttachUpload(cid, fileList, source = 'drop') {
  const clickPayload = _chatAttachPayload(cid, fileList, source);
  _convTrackClick('chat_attachment_upload', clickPayload);
  const { prepared, rejected } = await _chatAttachPrepareUploadFiles(cid, fileList);
  if (!prepared.length) {
    if (rejected.length) uiAlert(t('chat.attach_rejected_prefix', { list: rejected.join('\n') }));
    _convTrackEvent('chat_attachment_upload_result', {
      ...clickPayload,
      result: rejected.length ? 'failure' : 'skipped',
      uploaded_count: 0,
      failed_count: rejected.length,
    });
    return;
  }

  // ── Step 1: show placeholders after client-side hash dedupe ───────────
  // Hashing before painting chips prevents one add/drop action with several
  // identical files from flashing duplicate thumbnails above the composer.
  const placeholders = [];
  const current = _chatAttachList(cid).slice();
  for (const item of prepared) {
    const { file, ext, buf, sha256 } = item;
    const kind = _chatAttachKindFromExt(ext);
    const tempId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let localPreview = null;
    if (kind === 'image' || kind === 'audio') {
      try { localPreview = URL.createObjectURL(file); } catch (_) { /* ignore */ }
    }
    const entry = {
      tempId, name: file.name, displayName: file.name, kind, bytes: file.size || 0,
      dataUrl: localPreview, sha256, status: 'uploading',
    };
    current.push(entry);
    placeholders.push({ tempId, file, ext, buf, sha256 });
  }
  _chatAttachSet(cid, current);

  // ── Step 2: upload all in parallel; rendering is already done ─────────
  let uploadFailed = 0;
  await Promise.all(placeholders.map(async (ph) => {
    try {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(ph.file.name),
        },
        body: ph.buf,
      });
      const data = await res.json();
      if (!data.ok) {
        _chatAttachReplaceByTempId(cid, ph.tempId, null);
        uploadFailed += 1;
        rejected.push(t('chat.attach_upload_fail', { name: ph.file.name, reason: data.error || t('chat.attach_upload_generic_fail') }));
        return;
      }
      const info = data.info;
      // Keep the local blob URL for image previews — no need for a second
      // roundtrip to fetch a dataUrl the server would just base64 back.
      _chatAttachReplaceByTempId(cid, ph.tempId, {
        name: info.name,
        displayName: ph.file.name,
        kind: info.kind,
        bytes: info.bytes,
        reused: !!data.reused,
        sha256: ph.sha256,
        status: 'ready',
      });
    } catch (err) {
      _chatAttachReplaceByTempId(cid, ph.tempId, null);
      uploadFailed += 1;
      rejected.push(t('chat.attach_upload_fail', { name: ph.file.name, reason: err.message || t('chat.attach_upload_generic_fail') }));
    }
  }));
  const uploadedCount = Math.max(0, placeholders.length - uploadFailed);
  const failedCount = rejected.length;
  _convTrackEvent('chat_attachment_upload_result', {
    ...clickPayload,
    result: failedCount ? (uploadedCount ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: uploadedCount,
    failed_count: failedCount,
  });

  if (rejected.length) {
    uiAlert(t('chat.attach_rejected_prefix', { list: rejected.join('\n') }));
  }
}

async function _chatAttachPickAndUpload(cid, source = 'picker') {
  if (!cid) return;
  const basePayload = { source, target: _chatAttachTargetOf(cid) };
  _convTrackClick('chat_attachment_upload', basePayload);
  let data;
  try {
    data = await window.orkas.invoke('conversations.attachments.pickAndUpload', { cid });
  } catch (err) {
    _convLog.warn('native attachment picker failed', err);
    _convTrackEvent('chat_attachment_upload_result', {
      ...basePayload,
      result: 'failure',
      uploaded_count: 0,
      failed_count: 1,
    });
    await uiAlert(t('chat.attach_upload_fail', { name: '', reason: err.message || t('chat.attach_upload_generic_fail') }));
    return;
  }
  if (data && data.cancelled) {
    _convTrackEvent('chat_attachment_upload_result', {
      ...basePayload,
      result: 'cancelled',
      uploaded_count: 0,
      failed_count: 0,
      file_count: 0,
    });
    return;
  }
  const picked = Array.isArray(data && data.items) ? data.items : [];
  const failed = Array.isArray(data && data.failed) ? data.failed : [];
  _convTrackEvent('chat_attachment_upload_result', {
    ...basePayload,
    result: failed.length ? (picked.length ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: picked.length,
    failed_count: failed.length,
    file_count: picked.length + failed.length,
  });
  if (picked.length) {
    const current = _chatAttachList(cid).slice();
    for (const item of picked) {
      const info = item && item.info;
      if (!info || !info.name) continue;
      if (current.some((it) => it.name === info.name && it.status !== 'uploading')) continue;
      current.push({
        tempId: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: info.name,
        displayName: item.displayName || info.name,
        kind: info.kind,
        bytes: info.bytes || 0,
        dataUrl: (info.kind === 'image' || info.kind === 'audio') ? _chatMediaUrl(cid, info.name) : '',
        reused: !!item.reused,
        status: 'ready',
      });
    }
    _chatAttachSet(cid, current);
  }
  if (failed.length) {
    const list = failed.map((x) => t('chat.attach_upload_fail', {
      name: x.name || '',
      reason: x.error || t('chat.attach_upload_generic_fail'),
    }));
    await uiAlert(t('chat.attach_rejected_prefix', { list: list.join('\n') }));
  }
}

function _chatAttachInternalDragItems(dataTransfer) {
  if (!dataTransfer || !dataTransfer.types) return [];
  let hasInternal = false;
  for (let i = 0; i < dataTransfer.types.length; i++) {
    if (dataTransfer.types[i] === ORKAS_FILE_DRAG_MIME) {
      hasInternal = true;
      break;
    }
  }
  if (!hasInternal) return [];
  let raw = '';
  try { raw = dataTransfer.getData(ORKAS_FILE_DRAG_MIME); }
  catch (_) { return []; }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((item) => ({
        path: typeof item?.path === 'string' ? item.path : '',
        name: typeof item?.name === 'string' ? item.name : '',
      }))
      .filter((item) => item.path);
  } catch (_) {
    return [];
  }
}

async function _chatAttachImportPaths(cid, entries, source = 'internal_drop') {
  const files = Array.isArray(entries) ? entries.filter((it) => it && it.path) : [];
  if (!files.length) return;
  const clickPayload = _chatAttachPayload(cid, files, source);
  _convTrackClick('chat_attachment_upload', clickPayload);

  const placeholders = [];
  const current = _chatAttachList(cid).slice();
  for (const item of files) {
    const displayName = item.name || _chatAttachBaseName(item.path);
    const ext = _chatAttachExtOf(displayName);
    const kind = _chatAttachKindFromExt(ext);
    const tempId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    current.push({
      tempId,
      name: displayName,
      displayName,
      kind,
      bytes: 0,
      dataUrl: null,
      status: 'uploading',
    });
    placeholders.push({ tempId, path: item.path, name: displayName });
  }
  _chatAttachSet(cid, current);

  const rejected = [];
  let uploadFailed = 0;
  await Promise.all(placeholders.map(async (ph) => {
    try {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ph.path, name: ph.name }),
      });
      const data = await res.json();
      if (!data.ok) {
        _chatAttachReplaceByTempId(cid, ph.tempId, null);
        uploadFailed += 1;
        rejected.push(t('chat.attach_upload_fail', { name: ph.name, reason: data.error || t('chat.attach_upload_generic_fail') }));
        return;
      }
      const info = data.info;
      _chatAttachReplaceByTempId(cid, ph.tempId, {
        name: info.name,
        displayName: ph.name,
        kind: info.kind,
        bytes: info.bytes,
        dataUrl: (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio') ? _chatMediaUrl(cid, info.name) : null,
        reused: !!data.reused,
        status: 'ready',
      });
    } catch (err) {
      _chatAttachReplaceByTempId(cid, ph.tempId, null);
      uploadFailed += 1;
      rejected.push(t('chat.attach_upload_fail', { name: ph.name, reason: err.message || t('chat.attach_upload_generic_fail') }));
    }
  }));
  const uploadedCount = Math.max(0, placeholders.length - uploadFailed);
  _convTrackEvent('chat_attachment_upload_result', {
    ...clickPayload,
    result: uploadFailed ? (uploadedCount ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: uploadedCount,
    failed_count: rejected.length,
  });

  if (rejected.length) {
    uiAlert(t('chat.attach_rejected_prefix', { list: rejected.join('\n') }));
  }
}

window.addChatAttachmentsFromPaths = async function addChatAttachmentsFromPaths(cid, entries) {
  return _chatAttachImportPaths(cid || currentCid, entries, 'external_import');
};

// Add an already-imported attachment (from a KB "ask the commander about this
// file" action) to a draft pool's chips. The file is imported server-side into
// the draft cid's pool; here we just surface it as a ready chip.
function _addReadyDraftAttachment(cid, info) {
  if (!info || !info.name) return;
  const items = _chatAttachList(cid).slice();
  items.push({
    name: info.name,
    displayName: info.displayName || info.name,
    kind: info.kind,
    bytes: info.bytes,
    dataUrl: (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio') ? _chatMediaUrl(cid, info.name) : null,
    reused: !!info.reused,
    status: 'ready',
  });
  _chatAttachSet(cid, items);
}

function _chatVideoFloatingTitle() {
  const key = 'chat.video_open_floating_title';
  try {
    if (typeof t === 'function') {
      const v = t(key);
      if (v && v !== key) return v;
    }
  } catch (_) { /* keep fallback */ }
  return 'Fullscreen';
}

// Exposed for the KB "ask the commander about this file" menu actions
// (contexts.js / project-detail.js). Imports the KB file into `draftCid`'s pool
// server-side via `channel`, runs `afterNavigate` (navigation must happen BEFORE
// the chip render so it lands in the now-visible composer), then surfaces the
// draft chip. No conversation is created — the user's first message creates it
// and adopts the draft attachments.
window.COMMANDER_DRAFT_CID = DRAFT_CID;
window.attachKbFileToDraft = async function attachKbFileToDraft(channel, payload, draftCid, afterNavigate) {
  const data = await window.orkas.invoke(channel, { ...(payload || {}), cid: draftCid });
  if (!data || !data.ok) throw new Error((data && data.error) || 'failed');
  if (typeof afterNavigate === 'function') afterNavigate();
  _addReadyDraftAttachment(draftCid, data.info);
};

async function _chatAttachRefreshFromServer(cid) {
  const startedAt = performance.now();
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments`);
    const data = await res.json();
    if (!data.ok) return;
    const items = (data.items || []).map((info) => {
      // Preview URL resolves from uid + cid + name on demand via the
      // `chat-media://` protocol — no per-item IPC fetch here.
      const dataUrl = (info.kind === 'image' || info.kind === 'video' || info.kind === 'audio')
        ? _chatMediaUrl(cid, info.name)
        : null;
      return { name: info.name, kind: info.kind, bytes: info.bytes, dataUrl, status: 'ready' };
    });
    _chatAttachSet(cid, items);
    _convLog.info('conversation detail attachments ready', {
      cid,
      ms: Math.round(performance.now() - startedAt),
      count: items.length,
    });
  } catch (err) {
    _convLog.warn('refresh attachments failed', err);
  }
}

function _renderMessageAttachmentsHtml(names, cid) {
  const items = names.map((n) => {
    const ext = _chatAttachExtOf(n);
    const kind = _chatAttachKindFromExt(ext);
    const icon = _chatFileIconHtml(n, kind);
    const label = escapeHtml(n);
    if (kind === 'image' && cid) {
      const url = _chatMediaUrl(cid, n);
      return `<span class="chat-msg-attach is-image" data-attach-name="${label}" data-attach-cid="${escapeHtml(cid)}" title="${label}">
        <span class="chat-image-shell chat-msg-attach-thumb-shell is-loading"><img class="chat-msg-attach-thumb" src="${url}" alt="${label}" data-monitor-resource="chat-attachment-image" /></span>
        <span class="chat-msg-attach-label">${label}</span>
      </span>`;
    }
    if (kind === 'video' && cid) {
      const url = _chatMediaUrl(cid, n);
      const floatingTitle = escapeHtml(_chatVideoFloatingTitle());
      return `<span class="chat-msg-attach is-video" data-attach-name="${label}" data-attach-cid="${escapeHtml(cid)}" title="${label}">
        <span class="chat-msg-attach-video-shell" data-chat-video-playback-surface="attachment_bubble">
          <video class="chat-msg-attach-video" width="320" height="180" controls controlslist="nodownload nofullscreen noremoteplayback" disablepictureinpicture disableremoteplayback playsinline preload="metadata" src="${url}" data-monitor-resource="chat-attachment-video"></video>
          <button type="button" class="chat-msg-attach-video-float" data-attach-video-open="1" aria-label="${floatingTitle}" title="${floatingTitle}">${_uiIconHtml('maximize', 'ui-icon chat-msg-attach-video-float-svg')}</button>
        </span>
        <span class="chat-msg-attach-label">${label}</span>
      </span>`;
    }
    if (kind === 'audio' && cid) {
      const url = _chatMediaUrl(cid, n);
      return `<span class="chat-msg-attach is-audio" data-attach-name="${label}" data-attach-cid="${escapeHtml(cid)}" title="${label}">
        <audio class="chat-msg-attach-audio" controls controlslist="nodownload noremoteplayback" preload="metadata" src="${url}"></audio>
        <span class="chat-msg-attach-label">${label}</span>
      </span>`;
    }
    return `<span class="chat-msg-attach" title="${label}">
      <span class="chat-msg-attach-icon">${icon}</span>
      <span class="chat-msg-attach-label">${label}</span>
    </span>`;
  });
  return `<div class="chat-msg-attachments">${items.join('')}</div>`;
}

// ── Produced files (assistant messages only) ─────────────────────────────
// Files written by the LLM via write_file / markdown_to_pdf / html_to_pdf.
// Chips use the same visual language as attachments; clicking opens an
// in-app preview overlay (chat-file-viewer.js) that renders the file's
// final form (PDF / Office / HTML / markdown / text) or falls through to a dialog
// offering "open the containing folder" for unsupported kinds.

function _iconForProduced(name) {
  return _chatFileIconHtml(name);
}

// Final-deliverable extensions float to the front of the chip row so the file
// the user actually asked for leads, even when a noisy bash run mixed in stray
// repo files. Everything else keeps its original order behind them.
const _PRODUCED_DELIVERABLE_EXTS = new Set([
  'pptx', 'ppt', 'key',
  'docx', 'doc', 'pages',
  'xlsx', 'xls', 'numbers', 'csv',
  'pdf',
  'zip',
]);

function _producedDeliverableRank(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return _PRODUCED_DELIVERABLE_EXTS.has(ext) ? 0 : 1;
}

function _producedPathSpecificity(p) {
  const raw = String(p || '');
  const segments = raw.split(/[\\/]/).filter(Boolean).length;
  const absoluteBonus = (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(raw)) ? 1000 : 0;
  return absoluteBonus + segments;
}

// Dedup by basename (the chip only shows the basename, so same-name files from
// different dirs read as confusing duplicates) and float deliverables first.
// If a turn reports both an early shallow/stale path and a later final path
// with the same basename, keep the more specific path so the chip opens the
// real deliverable instead of a root-level scratch name.
// Stable: original order is preserved within each rank.
function _orderProducedPaths(absPaths) {
  const byBase = new Map();
  for (const [i, p] of absPaths.entries()) {
    const base = (p.split(/[\\/]/).pop() || p);
    const next = { path: p, base, i };
    const prev = byBase.get(base);
    if (!prev) {
      byBase.set(base, next);
      continue;
    }
    const nextScore = _producedPathSpecificity(next.path);
    const prevScore = _producedPathSpecificity(prev.path);
    if (nextScore > prevScore || (nextScore === prevScore && next.i > prev.i)) {
      byBase.set(base, { ...next, i: prev.i });
    }
  }
  return Array.from(byBase.values())
    .sort((a, b) => _producedDeliverableRank(a.base) - _producedDeliverableRank(b.base) || a.i - b.i);
}

function _renderMessageProducedHtml(absPaths) {
  // Chip shows just the filename. The full absolute path lives only in
  // `data-produced-path` for the click handler; tooltip is a static
  // localized "preview" hint instead of the raw OS path (which exposes
  // the user's home directory and is hostile UX in mixed-locale contexts).
  const hint = t('chat.produced_preview_title');
  const moreHint = t('contexts.menu.more_actions');
  const ordered = _orderProducedPaths(absPaths);
  const items = ordered.map((e) => {
    const icon = _iconForProduced(e.base);
    return `<div class="chat-msg-produced-item" data-produced-path="${escapeHtml(e.path)}">
      <button type="button" class="chat-msg-produced-main" title="${escapeHtml(hint)}">
        <span class="chat-msg-produced-icon">${icon}</span>
        <span class="chat-msg-produced-label">${escapeHtml(e.base)}</span>
      </button>
      <button type="button" class="chat-msg-produced-menu-btn" title="${escapeHtml(moreHint)}" aria-label="${escapeHtml(moreHint)}" aria-haspopup="menu" aria-expanded="false">${_uiIconHtml('more-horizontal', 'ctx-row-menu-icon')}</button>
    </div>`;
  });
  return `<div class="chat-msg-produced">${items.join('')}</div>`;
}

function _mountMessageProducedFooter(msgDiv, absPaths) {
  if (!msgDiv || !Array.isArray(absPaths) || !absPaths.length) return;
  const bubble = msgDiv.querySelector('.chat-bubble');
  if (!bubble || bubble.querySelector('.chat-msg-produced')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = _renderMessageProducedHtml(absPaths);
  const node = wrap.firstElementChild;
  if (!node) return;
  bubble.appendChild(node);
  msgDiv.dataset.produced = JSON.stringify(absPaths);
  _hydrateMessageProducedChips(msgDiv);
}

// Render a "view details" chip on an assistant bubble when a new agent was
// quick-created from that turn. Click → jump to agents tab + select the new
// agent. Same visual slot as produced chips (inside the bubble, below
// content), but in .is-custom green to signal "new custom artifact created".
// Render one or more "view details" chips on an assistant bubble — one chip
// per agent quick-created or quick-edited in that turn. Same visual slot as
// produced chips (inside the bubble, below content), in .is-custom green.
// Label is neutral ("view details") for both `kind: 'created'` and
// `kind: 'updated'`; the commander's surrounding prose tells the user which.
function _renderMessageCreatedAgentHtml(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const chips = arr
    .filter((p) => p && p.agent_id)
    .map((p) => {
      const name = p.name || p.agent_id;
      return `<span class="chat-msg-created-agent-chip" data-agent-id="${escapeHtml(p.agent_id)}" title="${escapeHtml(name)}">
      <span class="chat-msg-created-agent-icon" aria-hidden="true">${_uiIconHtml('diamond', 'ui-icon')}</span>
      <span class="chat-msg-created-agent-label">${escapeHtml(t('chat.created_agent_chip', { name }))}</span>
    </span>`;
    })
    .join('');
  return chips ? `<div class="chat-msg-created-agent">${chips}</div>` : '';
}

function _hydrateMessageCreatedAgentChip(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-created-agent-chip[data-agent-id]');
  for (const chip of chips) {
    if (chip.dataset.bound === '1') continue;
    chip.dataset.bound = '1';
    chip.addEventListener('click', async () => {
      const aid = chip.dataset.agentId;
      if (!aid) return;
      if (window.Monitor) (() => {})('created_agent_chip_open', { agent_id: aid });
      setView('agents');
      // Pre-check the agent is still loadable; if it was deleted (or its
      // record is broken) the detail view would render an empty shell. Keep
      // the user on the entry page instead.
      try {
        const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
        const data = await res.json();
        if (!data?.ok || !data?.agent) return;
      } catch { return; }
      if (typeof openAgentDetail === 'function') openAgentDetail(aid, { returnTarget });
      else if (typeof selectAgent === 'function') selectAgent(aid);
    });
  }
}

// Skill mirror of the agent chip. Commander writes only custom skills,
// so the chip always opens the custom-source detail view.
function _renderMessageCreatedSkillHtml(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const chips = arr
    .filter((p) => p && p.skill_id)
    .map((p) => {
      const name = p.name || p.skill_id;
      return `<span class="chat-msg-created-agent-chip" data-skill-id="${escapeHtml(p.skill_id)}" title="${escapeHtml(name)}">
      <span class="chat-msg-created-agent-icon" aria-hidden="true">${_uiIconHtml('diamond', 'ui-icon')}</span>
      <span class="chat-msg-created-agent-label">${escapeHtml(t('chat.created_skill_chip', { name }))}</span>
    </span>`;
    })
    .join('');
  return chips ? `<div class="chat-msg-created-agent">${chips}</div>` : '';
}

function _hydrateMessageCreatedSkillChip(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-created-agent-chip[data-skill-id]');
  for (const chip of chips) {
    if (chip.dataset.bound === '1') continue;
    chip.dataset.bound = '1';
    chip.addEventListener('click', async () => {
      const sid = chip.dataset.skillId;
      if (!sid) return;
      if (window.Monitor) (() => {})('created_skill_chip_open', { skill_id: sid });
      setView('skills');
      const featureLoader = typeof loadRendererFeature === 'function'
        ? loadRendererFeature
        : window.loadRendererFeature;
      if (typeof featureLoader === 'function') {
        try { await featureLoader('skills'); } catch { return; }
      }
      // Pre-check SKILL.md is readable; covers both "skill was deleted" and
      // "skill row exists but its files are missing" (entering the detail
      // would render a 'file not found' shell otherwise).
      try {
        const res = await apiFetch(`/api/skills/read?source=custom&id=${encodeURIComponent(sid)}&file=SKILL.md`);
        const data = await res.json();
        if (!data?.ok) return;
      } catch { return; }
      if (typeof openSkillDetail === 'function') openSkillDetail('custom', sid);
    });
  }
}

function _hydrateMessageProducedChips(msgDiv) {
  const rows = msgDiv.querySelectorAll('.chat-msg-produced-item[data-produced-path]');
  rows.forEach((row) => {
    const main = row.querySelector('.chat-msg-produced-main');
    const menuBtn = row.querySelector('.chat-msg-produced-menu-btn');
    if (main && main.dataset.bound !== '1') {
      main.dataset.bound = '1';
      main.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = row.dataset.producedPath;
        if (!p) return;
        if (typeof openChatFileViewer === 'function') {
          const base = p.split(/[\\/]/).pop() || p;
          openChatFileViewer(p, base, currentCid ? { cid: currentCid } : undefined);
        }
      });
    }
    if (menuBtn && menuBtn.dataset.bound !== '1') {
      menuBtn.dataset.bound = '1';
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = row.dataset.producedPath;
        if (!p || !window.ConversationInfo || typeof window.ConversationInfo.openFileMenu !== 'function') return;
        const base = p.split(/[\\/]/).pop() || p;
        window.ConversationInfo.openFileMenu(menuBtn, p, base, {
          cid: currentCid || '',
          onDeleted: () => {
            row.remove();
            const footer = msgDiv.querySelector('.chat-msg-produced');
            if (footer && !footer.querySelector('.chat-msg-produced-item')) footer.remove();
            try {
              const produced = JSON.parse(msgDiv.dataset.produced || '[]');
              msgDiv.dataset.produced = JSON.stringify(
                Array.isArray(produced) ? produced.filter((item) => item !== p) : [],
              );
            } catch (_) { msgDiv.dataset.produced = '[]'; }
          },
        });
      });
    }
  });
}

function _showFileMissingToast(name) {
  const label = String(name || '').trim();
  let message = label ? `The file "${label}" no longer exists.` : 'The file no longer exists.';
  try {
    const got = t('chat.file_missing_toast', { name: label });
    if (got && got !== 'chat.file_missing_toast') message = got;
  } catch (_) { /* keep fallback */ }
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
  else if (typeof uiAlert === 'function') uiAlert(message);
}

function _hydrateMessageAttachmentThumbs(msgDiv, cid) {
  // Image chips have a thumb we want to enlarge via the lightbox; the rest
  // (pdf / office / text / video) get the same kind-aware viewer as produced
  // chips. Video chips have inline <video> controls in the bubble already;
  // their explicit floating-player button opens the same file-backed preview
  // as the conversation sidebar so the header actions stay consistent.
  // We rely on `_chatMediaUrl(cid, name)` having loaded the bytes for
  // images so the lightbox can reuse the already-cached resource.
  const allChips = msgDiv.querySelectorAll('.chat-msg-attach');
  allChips.forEach((chip) => {
    if (chip.classList.contains('is-video')) {
      const btn = chip.querySelector('[data-attach-video-open="1"]');
      if (!btn || btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof openChatFileViewer !== 'function') return;
        const name = chip.dataset.attachName || (chip.querySelector('.chat-msg-attach-label')?.textContent || '').trim();
        const chipCid = chip.dataset.attachCid || cid;
        if (!name || !chipCid) return;
        const video = chip.querySelector('video.chat-msg-attach-video');
        const startTime = video && Number.isFinite(Number(video.currentTime)) ? Math.max(0, Number(video.currentTime) || 0) : 0;
        const duration = video && Number.isFinite(Number(video.duration)) ? Math.max(0, Number(video.duration) || 0) : 0;
        const ended = !!(video && video.ended);
        const playbackOpts = { cid: chipCid, autoplay: true, startTime, duration, ended };
        try { if (video && typeof video.pause === 'function') video.pause(); } catch (_) {}
        try { if (window.Monitor) (() => {})('chat_attachment_video_floating_open'); } catch (_) {}
        try {
          const res = await window.orkas.invoke('attachments.absPath', { cid: chipCid, name });
          if (!res || !res.ok || !res.path) {
            _convLog.warn('attachments.absPath video failed', { cid: chipCid, name, error: res && res.error });
            _showFileMissingToast(name);
            return;
          }
          openChatFileViewer(res.path, name, playbackOpts);
        } catch (err) {
          _convLog.warn('attachments.absPath video threw', { cid: chipCid, name, error: String(err && err.message || err) });
          _showFileMissingToast(name);
        }
      });
      return;
    }
    if (chip.classList.contains('is-audio')) return;
    if (chip.classList.contains('is-image')) {
      const img = chip.querySelector('img.chat-msg-attach-thumb');
      if (!img) return;
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (typeof openChatImageLightbox === 'function') {
          const name = chip.dataset.attachName || '';
          const chipCid = chip.dataset.attachCid || cid;
          let opts;
          if (name && chipCid) {
            try {
              const res = await window.orkas.invoke('attachments.absPath', { cid: chipCid, name });
              if (res && res.ok && res.path) opts = { absPath: res.path, cid: chipCid };
              else {
                _convLog.warn('attachments.absPath image failed', { cid: chipCid, name, error: res && res.error });
                _showFileMissingToast(name);
                return;
              }
            } catch (err) {
              _convLog.warn('attachments.absPath image threw', { cid: chipCid, name, error: String(err && err.message || err) });
              _showFileMissingToast(name);
              return;
            }
          }
          openChatImageLightbox(img.src, name, opts);
        }
      });
      return;
    }
    // Non-image, non-video attachment chip → open the file viewer. The
    // chip carries `(cid, name)`, not an absolute path; resolve via
    // `attachments.absPath` so the viewer keeps a single "abs path in"
    // contract. cid flows through to the viewer so reveal / read scope
    // includes the per-conversation attachment dir.
    const name = chip.dataset.attachName || (chip.querySelector('.chat-msg-attach-label')?.textContent || '').trim();
    const chipCid = chip.dataset.attachCid || cid;
    if (!name || !chipCid) return;
    chip.classList.add('is-clickable');
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (typeof openChatFileViewer !== 'function') return;
      try {
        const res = await window.orkas.invoke('attachments.absPath', { cid: chipCid, name });
        if (!res || !res.ok || !res.path) {
          _convLog.warn('attachments.absPath failed', { cid: chipCid, name, error: res && res.error });
          _showFileMissingToast(name);
          return;
        }
        openChatFileViewer(res.path, name, { cid: chipCid });
      } catch (err) {
        _convLog.warn('attachments.absPath threw', { cid: chipCid, name, error: String(err && err.message || err) });
        _showFileMissingToast(name);
      }
    });
  });
}

// Wire `paste` on a textarea to the same upload pipeline as the "+" button.
// Triggers when the clipboard contains any File entries — screenshots from
// the OS clipboard (Cmd/Ctrl+Shift+screenshot) and files copied from Finder
// / Explorer both land in `clipboardData.files`. Plain-text pastes have an
// empty FileList and fall through to the textarea's native paste handler.
function _bindChatPasteAttach(inputSelector, getCid) {
  const el = document.querySelector(inputSelector);
  if (!el || el.dataset.pasteBound === '1') return;
  el.addEventListener('paste', (e) => {
    const cid = getCid();
    if (!cid) return;
    const cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    e.preventDefault();
    // Fire-and-forget — _chatAttachUpload paints placeholder chips
    // synchronously before any network IO, so the user sees the chip
    // appear at the top of the input area as soon as the paste lands.
    _chatAttachUpload(cid, cd.files, 'paste');
  });
  el.dataset.pasteBound = '1';
}

// Same upload pipeline, drop variant. Binds on the input-area wrapper so
// the user has a generous target — dropping on the textarea, the chip
// row, or the toolbar all land here. dragover/dragenter must preventDefault
// to mark the area as a drop target (otherwise the browser refuses the
// drop and falls through to the page-level navigate-to-file behaviour).
function _bindChatDropAttach(wrapSelector, getCid) {
  const el = document.querySelector(wrapSelector);
  if (!el || el.dataset.dropBound === '1') return;
  const isAttachDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files' || types[i] === ORKAS_FILE_DRAG_MIME) return true;
    }
    return false;
  };
  const allow = (e) => {
    if (!isAttachDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  el.addEventListener('dragover', allow);
  el.addEventListener('dragenter', allow);
  el.addEventListener('drop', (e) => {
    if (!isAttachDrag(e)) return;
    e.preventDefault();
    const cid = getCid();
    if (!cid) return;
    const internalFiles = _chatAttachInternalDragItems(e.dataTransfer);
    if (internalFiles.length) {
      _chatAttachImportPaths(cid, internalFiles, 'internal_drop');
      return;
    }
    _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
  });
  el.dataset.dropBound = '1';
}

function _initChatAttachInput() {
  const btn = document.getElementById('chat-attach-btn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.addEventListener('click', () => {
    if (!currentCid) return;
    _chatAttachPickAndUpload(currentCid, 'picker');
  });
  _bindChatPasteAttach('#chat-input', () => currentCid);
  _bindChatDropAttach('.chat-input-area', () => currentCid);
  btn.dataset.bound = '1';
}

// The commander (new-chat) tab's "+" button uses the same upload
// pipeline; the only difference is that it passes DRAFT_CID instead of
// a real conversation cid. After the user clicks send,
// handleNewChatSubmit calls adopt to move the whole local `main_chat/`
// draft directory to the freshly-minted cid; the pre-processing cache
// follows in place and doesn't need to be rerun.

function _initNewChatAttachInput() {
  const btn = document.getElementById('new-chat-attach-btn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.addEventListener('click', () => {
    _chatAttachPickAndUpload(DRAFT_CID, 'picker');
  });
  _bindChatPasteAttach('#new-chat-input', () => DRAFT_CID);
  _bindChatDropAttach('.new-chat-input-area', () => DRAFT_CID);
  btn.dataset.bound = '1';
}

// ─── Conversation list ───

let _loadConversationsInFlight = null;
let _loadConversationsMode = '';
const _loadedConversationProjectIds = new Set();
const _conversationProjectPages = new Map();
const _projectConversationLoads = new Map();
let _unprojectedConversationLoad = null;
const _unprojectedConversationPage = {
  initialized: false,
  total: 0,
  nextOffset: 0,
  loading: false,
};

function _startupConversationParams() {
  let activeCid = '';
  try {
    const saved = JSON.parse(localStorage.getItem('last_view') || 'null');
    if (saved && saved.view === 'conversation') activeCid = String(saved.cid || '');
  } catch (_) {}
  const expanded = (typeof _projectsExpanded === 'object' && _projectsExpanded)
    ? Object.keys(_projectsExpanded).filter((pid) => _projectsExpanded[pid])
    : [];
  const params = new URLSearchParams({ mode: 'startup' });
  if (activeCid) params.set('active_cid', activeCid);
  if (expanded.length) params.set('expanded_projects', expanded.join(','));
  return params.toString();
}

function _replaceConversationSlice(rows, shouldReplace) {
  const incoming = Array.isArray(rows) ? rows : [];
  const keep = (Array.isArray(conversations) ? conversations : []).filter((c) => !shouldReplace(c));
  conversations = keep.concat(incoming);
}

function _appendConversationSlice(rows) {
  const byCid = new Map((Array.isArray(conversations) ? conversations : [])
    .filter((c) => c && c.conversation_id)
    .map((c) => [c.conversation_id, c]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && row.conversation_id) byCid.set(row.conversation_id, row);
  }
  conversations = Array.from(byCid.values());
}

function _projectConversationPageInfo(projectId) {
  return _conversationProjectPages.get(String(projectId || '')) || null;
}

function _projectConversationHasMore(projectId) {
  const page = _projectConversationPageInfo(projectId);
  return !!page && Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0;
}

function _projectConversationTotal(projectId) {
  const page = _projectConversationPageInfo(projectId);
  return page ? Number(page.total) || 0 : 0;
}

async function loadConversations(options = {}) {
  // Routine refreshes retain the bounded startup slice. A caller must opt in
  // explicitly when its UI genuinely needs every conversation.
  const startup = !(options && options.full === true);
  if (_loadConversationsInFlight) {
    if (startup || _loadConversationsMode === 'full') return _loadConversationsInFlight;
    await _loadConversationsInFlight;
    return loadConversations(options);
  }
  _loadConversationsMode = startup ? 'startup' : 'full';
  _loadConversationsInFlight = (async () => {
    try {
      const url = startup
        ? `/api/conversations/list?${_startupConversationParams()}`
        : '/api/conversations/list';
      const res = await apiFetch(url);
      const data = await res.json();
      if (data.ok) {
        conversations = data.conversations || [];
        _loadedConversationProjectIds.clear();
        _conversationProjectPages.clear();
        if (startup) {
          const unprojectedInfo = data.unprojected_pagination || {};
          const unprojectedNext = unprojectedInfo.next_offset === null
            ? null : Number(unprojectedInfo.next_offset);
          _unprojectedConversationPage.initialized = true;
          _unprojectedConversationPage.total = Number(unprojectedInfo.total) || 0;
          _unprojectedConversationPage.nextOffset = Number.isSafeInteger(unprojectedNext)
            && unprojectedNext >= 0 ? unprojectedNext : null;
          _unprojectedConversationPage.loading = false;
          const pagination = data.project_pagination && typeof data.project_pagination === 'object'
            ? data.project_pagination : {};
          for (const pid of data.loaded_project_ids || []) {
            const key = String(pid);
            const info = pagination[key] || {};
            const next = info.next_offset === null ? null : Number(info.next_offset);
            const nextOffset = Number.isSafeInteger(next) && next >= 0 ? next : null;
            _conversationProjectPages.set(key, {
              initialized: true,
              total: Number(info.total) || 0,
              nextOffset,
            });
            if (nextOffset === null) _loadedConversationProjectIds.add(key);
          }
        } else if (Array.isArray(_projectsCache)) {
          for (const p of _projectsCache) {
            if (!p || !p.project_id) continue;
            _loadedConversationProjectIds.add(p.project_id);
            _conversationProjectPages.set(p.project_id, {
              initialized: true,
              total: (conversations || []).filter((c) => c && c.project_id === p.project_id).length,
              nextOffset: null,
            });
          }
          _unprojectedConversationPage.initialized = true;
          _unprojectedConversationPage.total = (conversations || [])
            .filter((c) => c && !c.project_id).length;
          _unprojectedConversationPage.nextOffset = null;
          _unprojectedConversationPage.loading = false;
        }
        renderConversationList();
      }
    } catch (e) {
      _convLog.error('load conversations failed', e);
      if (window.Monitor) (() => {})('load_conversations', { error_message: (e && e.message) || String(e) });
    } finally {
      _loadConversationsInFlight = null;
      _loadConversationsMode = '';
    }
  })();
  return _loadConversationsInFlight;
}

async function loadConversationProject(projectId, options = {}) {
  const pid = String(projectId || '');
  const append = options && options.append === true;
  const reset = options && options.reset === true;
  const shouldRender = !options || options.render !== false;
  const currentPage = _conversationProjectPages.get(pid);
  if (!pid || (!append && !reset && currentPage?.initialized)) return;
  if (append && !_projectConversationHasMore(pid)) return;
  const existing = _projectConversationLoads.get(pid);
  if (existing) {
    if (!reset) return existing;
    await existing;
    return loadConversationProject(pid, options);
  }
  const run = (async () => {
    const offset = append ? currentPage.nextOffset : 0;
    const res = await apiFetch(`/api/conversations/list?mode=project&project_id=${encodeURIComponent(pid)}&offset=${offset}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'project conversation list failed');
    if (append) _appendConversationSlice(data.conversations);
    else _replaceConversationSlice(data.conversations, (c) => c && c.project_id === pid);
    const next = data.next_offset === null ? null : Number(data.next_offset);
    const nextOffset = Number.isSafeInteger(next) && next >= 0 ? next : null;
    _conversationProjectPages.set(pid, {
      initialized: true,
      total: Number(data.total) || 0,
      nextOffset,
    });
    if (nextOffset === null) _loadedConversationProjectIds.add(pid);
    else _loadedConversationProjectIds.delete(pid);
    if (shouldRender) renderConversationList();
  })();
  _projectConversationLoads.set(pid, run);
  try { await run; } finally { if (_projectConversationLoads.get(pid) === run) _projectConversationLoads.delete(pid); }
}

async function loadUnprojectedConversations(options = {}) {
  const append = options && options.append === true;
  const reset = options && options.reset === true;
  const shouldRender = !options || options.render !== false;
  if (!append && !reset && _unprojectedConversationPage.initialized) return;
  if (append && _unprojectedConversationPage.nextOffset === null) return;
  if (_unprojectedConversationLoad) {
    if (!reset) return _unprojectedConversationLoad;
    await _unprojectedConversationLoad;
    return loadUnprojectedConversations(options);
  }
  _unprojectedConversationPage.loading = true;
  const offset = append ? _unprojectedConversationPage.nextOffset : 0;
  const run = (async () => {
    const res = await apiFetch(`/api/conversations/list?mode=unprojected&offset=${offset}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'unprojected conversation list failed');
    if (append) _appendConversationSlice(data.conversations);
    else _replaceConversationSlice(data.conversations, (c) => c && !c.project_id);
    const next = data.next_offset === null ? null : Number(data.next_offset);
    _unprojectedConversationPage.initialized = true;
    _unprojectedConversationPage.total = Number(data.total) || 0;
    _unprojectedConversationPage.nextOffset = Number.isSafeInteger(next) && next >= 0 ? next : null;
    if (shouldRender) renderConversationList();
  })();
  _unprojectedConversationLoad = run;
  try { await run; } finally {
    _unprojectedConversationPage.loading = false;
    if (_unprojectedConversationLoad === run) _unprojectedConversationLoad = null;
  }
}

async function _resetUnprojectedConversations() {
  return loadUnprojectedConversations({ reset: true });
}

window.addEventListener('sidebar-section-toggle', (event) => {
  if (event?.detail?.name !== 'tasks' || event.detail.collapsed !== false) return;
  _resetUnprojectedConversations().catch((err) => {
    _convLog.warn('reset unprojected conversations after section expand failed', err);
  });
});

// Keep the subscription hook stable for callers; the open-source build has no
// remote conversation activity channel to bind here.
let _relayActivityWatchStarted = false;
function startRelayActivitySubscription() {
  if (_relayActivityWatchStarted) return;
  _relayActivityWatchStarted = true;
}

// `timeBucket` + `_BUCKET_ORDER` live in modules/conv-bucket.js (loaded
// ahead of this file in index.html). Kept as a separate file so its pure
// helper can be fixture-tested via the §9 CJS bridge without dragging the
// whole renderer-side global graph (createLogger / IPC) into vitest.

// Advance a conversation's sidebar activity and re-sort the list. Message
// events carry their persisted timestamp so replaying a buffered background
// event when the user opens its conversation is idempotent. Callers without
// an authoritative event timestamp (the relay activity push) use receipt
// time.
function _bumpConvToTop(cid, activityAt) {
  if (!cid || !Array.isArray(conversations) || !conversations.length) return;
  const c = conversations.find((row) => row && row.conversation_id === cid);
  if (!c) return;
  const hasExplicitActivity = arguments.length >= 2;
  const candidateMs = hasExplicitActivity
    ? Date.parse(String(activityAt || ''))
    : Date.now();
  if (!Number.isFinite(candidateMs)) return;
  const knownActivityMs = Math.max(
    0,
    ...[c.last_active_at, c.updated_at, c.created_at]
      .map((value) => Date.parse(String(value || '')))
      .filter(Number.isFinite),
  );
  const nextActivityMs = Math.max(candidateMs, knownActivityMs);
  const currentLastActiveMs = Date.parse(String(c.last_active_at || ''));
  if (Number.isFinite(currentLastActiveMs) && currentLastActiveMs >= nextActivityMs) return;
  c.last_active_at = new Date(nextActivityMs).toISOString();
  _sortConversationCacheForSidebar();
  renderConversationList();
}

function _compareConversationsForSidebar(a, b) {
  const ap = (a && a.pinned_at) || '';
  const bp = (b && b.pinned_at) || '';
  if (ap && !bp) return -1;
  if (!ap && bp) return 1;
  if (ap && bp) {
    const pinCmp = bp.localeCompare(ap);
    if (pinCmp) return pinCmp;
  }
  return _conversationActivityIso(b).localeCompare(_conversationActivityIso(a));
}

function _sortConversationCacheForSidebar() {
  if (!Array.isArray(conversations)) return;
  conversations.sort(_compareConversationsForSidebar);
}

function _conversationActivityIso(c) {
  return (c && (c.last_active_at || c.updated_at || c.created_at)) || '';
}

function _renderConversationTimeBucketList(items, itemOpts = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean).slice();
  rows.sort(_compareConversationsForSidebar);
  const pinned = [];
  const rest = [];
  for (const c of rows) {
    if (c && c.pinned_at) pinned.push(c);
    else rest.push(c);
  }
  const now = new Date();
  const buckets = { today: [], yesterday: [], last7: [], last30: [], older: [] };
  for (const c of rest) {
    buckets[timeBucket(_conversationActivityIso(c), now)].push(c);
  }
  const parts = [];
  for (const c of pinned) parts.push(_renderConversationSidebarItem(c, itemOpts));
  for (const b of _BUCKET_ORDER) {
    const bucketItems = buckets[b];
    if (!bucketItems.length) continue;
    const headerKey = `sidebar.bucket.${b}`;
    parts.push(`<div class="conv-list-section-header" data-i18n="${headerKey}">${escapeHtml(t(headerKey))}</div>`);
    for (const c of bucketItems) parts.push(_renderConversationSidebarItem(c, itemOpts));
  }
  return parts.join('');
}

// ── Conversation-row status indicator ────────────────────────────────────
// The sidebar "对话历史" entries show a trailing text label for abnormal
// states. Resting rows intentionally have no dot; live streaming owns the
// single breathing status dot through `_updateConvSidebarBadge`.
//
// Conversations do not yet carry a persisted status in the conversation index,
// so `_convRowStatus` maps an OPTIONAL backend-provided `c.status` field
// (allowlisted to the task vocabulary) and defaults to 'idle' with no label
// for every real conversation today. It never invents a
// failure/blocked state. Extension point: once the backend surfaces a
// per-conversation status (or the linked task's status), populate `c.status`
// and the abnormal label lights up automatically. Live streaming/queued state
// stays owned by `_updateConvSidebarBadge`.
const _CONV_ROW_STATUSES = ['failed', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
// Only "attention" states get a text label; normal states stay unadorned so the
// list reads clean and troubled entries stand out (screenshot spec).
const _CONV_ROW_LABEL_STATUSES = new Set(['failed', 'blocked']);
function _convRowStatus(c) {
  const cid = c && c.conversation_id;
  // A live reply, canonical terminal, or reopened persisted history describes
  // a newer user journey than the optional index status. Keep its neutral
  // states authoritative as well as failure; otherwise deleting `_failedConvs`
  // merely reveals the stale backend `failed` value again.
  const settled = cid ? _settledConvTurns.get(cid) : null;
  if (settled) return settled.status === 'failed' ? 'failed' : 'idle';
  // In-session overlay: a conversation whose latest turn ended in failure is the
  // only reliable per-conversation failure signal today (the index carries no
  // persisted status), so it takes precedence over any backend `c.status`.
  if (cid && _failedConvs.has(cid)) return 'failed';
  const raw = c && typeof c.status === 'string' ? c.status : '';
  return _CONV_ROW_STATUSES.includes(raw) ? raw : 'idle';
}
function _convRowStatusLabel(status) {
  // `failed` is a conversation-level state with its own copy; the task-vocab
  // states reuse the To-do status strings.
  const key = status === 'failed' ? 'chat.status.failed_short' : `project.todo.status_${status}`;
  const label = t(key);
  return (label && label !== key) ? label : status;
}
function _convRowStatusHtml(c) {
  const status = _convRowStatus(c);
  const label = _CONV_ROW_LABEL_STATUSES.has(status)
    ? `<span class="conv-item-status-label is-${status}">${escapeHtml(_convRowStatusLabel(status))}</span>`
    : '';
  return { dot: '', label };
}

// Repaint the abnormal label for a cid's row(s) in place,
// without a full `renderConversationList()` (which would drop hover/focus).
// Reads the same `_convRowStatus` the static renderer uses, so the in-session
// failed overlay and any backend `c.status` both flow through here. Called by
// `_updateConvSidebarBadge` once no live run badge is showing.
function _repaintConvRowStatus(cid) {
  if (!cid || typeof document === 'undefined') return;
  const conv = (Array.isArray(conversations) ? conversations : []).find(
    (x) => x && x.conversation_id === cid,
  );
  const status = _convRowStatus(conv || { conversation_id: cid });
  const wantLabel = _CONV_ROW_LABEL_STATUSES.has(status);
  document.querySelectorAll(`.conv-item[data-cid="${CSS.escape(cid)}"]`).forEach((item) => {
    const row = item.querySelector(':scope > .conv-item-row');
    if (!row) return;
    row.querySelector(':scope > .conv-item-status-dot')?.remove();
    let label = row.querySelector(':scope > .conv-item-status-label');
    if (wantLabel) {
      if (!label) {
        label = document.createElement('span');
        // Sit at the row end, right after the title, before the hover actions.
        const title = row.querySelector(':scope > .conv-item-title')
          || row.querySelector(':scope > .conv-item-title-input');
        if (title && title.nextSibling) row.insertBefore(label, title.nextSibling);
        else row.appendChild(label);
      }
      label.className = `conv-item-status-label is-${status}`;
      label.textContent = _convRowStatusLabel(status);
    } else if (label) {
      label.remove();
    }
  });
}

// A reply counts as "failed" ONLY when the runtime tagged it with a structured
// failure (`failure_kind`, or an explicit failed/error flag). We deliberately
// do NOT sniff the rendered text or `var(--danger)` styling: a normal, healthy
// reply that merely discusses errors ("模型调用失败", danger colors — e.g. a chat
// about this very feature) would otherwise false-flag the whole conversation.
// The styling-level `_isFailedAssistantContent` still drives the per-bubble
// retry affordance; it must never drive the conversation-level failed mark.
function _isStructuredFailure(m) {
  return !!(m && (m.failure_kind || m.failed === true || m.error === true));
}
// Cold-load / reopen: re-derive the in-session "failed" mark for a cid from its
// loaded history, looking ONLY at the LAST reply (the user's rule). A failed
// latest assistant reply → failed; a clean latest reply, or a trailing
// (unanswered/pending) user message → not failed.
function _isFailedHistoryReply(m) {
  if (!m) return false;
  if (String(m.from || m.role || '') === 'user') return false;
  return _isStructuredFailure(m);
}
function _syncFailedFromHistory(cid, history) {
  if (!cid || !Array.isArray(history) || !history.length) return;
  const latest = history[history.length - 1];
  const fromUser = String(latest?.from || latest?.role || '') === 'user';
  const parsedAtMs = Date.parse(latest?.time || latest?.ts || '');
  // Persisted history is the cold-load truth. A trailing user message records
  // a neutral display state, but `pending` is deliberately NOT a clean
  // settlement for controller fallback: if its transport later dies before a
  // reply/terminal, the task must still become failed.
  _setConvTurnSettlement(
    cid,
    fromUser ? 'pending' : (_isFailedHistoryReply(latest) ? 'failed' : 'completed'),
    {
      source: 'history',
      finishedAtMs: Number.isFinite(parsedAtMs) ? parsedAtMs : 0,
    },
  );
}

function _renderConversationSidebarItem(c, opts = {}) {
  const cid = escapeHtml(c.conversation_id);
  const title = escapeHtml(c.title || t('chat.new_conv_title'));
  const editing = _conversationInlineRenameCid === c.conversation_id;
  const isPinned = !!c.pinned_at;
  const isFromAuto = !!c.origin_auto_task_id;
  const hidePin = !!opts.hidePin;
  const menuTitle = escapeHtml(t('project.menu.more_actions'));
  // Auto-fired conversations get the same clock icon as the sidebar
  // "Automation" tab, rendered to the LEFT of the title text. Visible in
  // the sidebar conv list AND the project-detail conversations list (both
  // reuse this renderer).
  const autoIconHtml = isFromAuto
    ? `<span class="conv-item-auto-icon" title="${escapeHtml(t('auto.title'))}" aria-label="${escapeHtml(t('auto.title'))}">${_uiIconHtml('clock', 'conv-item-auto-icon-svg') || ''}</span>`
    : '';
  const titleNode = editing
    ? `<input type="text" class="conv-item-title-input" data-conv-rename-cid="${cid}"
              value="${title}" autocomplete="off" spellcheck="false" />`
    : `<div class="conv-item-title" title="${title}">${title}</div>`;
  const classes = [
    'conv-item',
    opts.nested ? 'conv-item-nested' : '',
    currentCid === c.conversation_id ? 'active' : '',
    isPinned ? 'is-pinned' : '',
    isFromAuto ? 'is-from-auto' : '',
    hidePin ? 'no-pin' : '',
  ].filter(Boolean).join(' ');
  const actionsHtml = `
        <span class="conv-item-actions">
          <button type="button" class="conv-item-action conv-item-menu"
                  data-conv-menu-cid="${cid}" data-hide-pin="${hidePin ? '1' : '0'}"
                  title="${menuTitle}" aria-label="${menuTitle}">⋯</button>
        </span>`;
  const { dot: statusDotHtml, label: statusLabelHtml } = _convRowStatusHtml(c);
  return `
    <div class="${classes}" data-cid="${cid}">
      <div class="conv-item-row">
        ${statusDotHtml}
        ${autoIconHtml}
        ${titleNode}
        ${statusLabelHtml}
        ${actionsHtml}
      </div>
    </div>
  `;
}

function _normaliseConversationTitle(raw) {
  let title = String(raw || '').trim();
  if (typeof window.limitNameDisplayText === 'function') title = window.limitNameDisplayText(title);
  return title;
}

async function _toggleConversationPinned(cid, pinned) {
  if (!cid || !Array.isArray(conversations)) return;
  const startedAt = Date.now();
  const snapshot = conversations.map((c) => (c ? { ...c } : c));
  const local = conversations.find((c) => c && c.conversation_id === cid);
  if (!local) return;
  if (pinned) local.pinned_at = new Date().toISOString();
  else delete local.pinned_at;
  _sortConversationCacheForSidebar();
  renderConversationList();
  _refreshChatHeader();

  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned, project_id: _projectIdForConversation(cid) }),
    });
    const data = await res.json();
    if (!data || data.ok === false || !data.conversation) {
      throw new Error((data && data.error) || 'pin failed');
    }
    const idx = conversations.findIndex((c) => c && c.conversation_id === cid);
    if (idx >= 0) {
      conversations[idx] = { ...conversations[idx], ...data.conversation };
      _sortConversationCacheForSidebar();
      renderConversationList();
      _refreshChatHeader();
    }
    _trackConversationManageResult('pin', startedAt, 'success', '', { target_state: pinned });
  } catch (err) {
    conversations = snapshot;
    renderConversationList();
    _refreshChatHeader();
    _trackConversationManageResult('pin', startedAt, 'failure', 'pin_failed', { target_state: pinned });
    _convLog.warn('toggle conversation pin failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
    // Surface failure to the user — silent rollback leaves a chip-flicker
    // with no explanation (typical race: another tab/device deleted the
    // conv while this pin was in flight, or the server transient-errored).
    try { await uiAlert(t('chat.pin_failed')); } catch (_) {}
  }
}

async function _renameConversation(cid) {
  _startConversationInlineRename(cid);
}

async function _saveConversationTitle(cid, raw, opts = {}) {
  if (!cid || !Array.isArray(conversations)) return;
  const startedAt = Date.now();
  const conv = conversations.find((c) => c && c.conversation_id === cid);
  const current = (conv && conv.title) || t('chat.new_conv_title');
  const title = _normaliseConversationTitle(raw);
  if (!title) {
    _trackConversationManageResult('rename', startedAt, 'blocked', 'empty_title');
    try { await uiAlert(t('chat.conv_rename_empty')); } catch (_) {}
    return false;
  }
  if (title === current) {
    if (_conversationInlineRenameCid === cid) _conversationInlineRenameCid = null;
    if (_conversationHeaderRenameCid === cid) _conversationHeaderRenameCid = null;
    renderConversationList();
    _refreshChatHeader();
    return true;
  }
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title, project_id: _projectIdForConversation(cid) }),
    });
    const data = await res.json();
    if (!data || data.ok === false || !data.conversation) {
      throw new Error((data && data.error) || 'rename failed');
    }
    const idx = conversations.findIndex((c) => c && c.conversation_id === cid);
    if (idx >= 0) conversations[idx] = { ...conversations[idx], ...data.conversation };
    if (_conversationInlineRenameCid === cid) _conversationInlineRenameCid = null;
    if (_conversationHeaderRenameCid === cid) _conversationHeaderRenameCid = null;
    renderConversationList();
    _refreshChatHeader();
    if (typeof renderProjectsSection === 'function') renderProjectsSection();
    if (typeof _renderProjectAllTasks === 'function') _renderProjectAllTasks();
    if (window.ConversationInfo && typeof window.ConversationInfo.refresh === 'function') {
      window.ConversationInfo.refresh(cid, { silent: true });
    }
    _trackConversationManageResult('rename', startedAt, 'success');
    if (typeof opts.afterSave === 'function') {
      try { await opts.afterSave(data.conversation); } catch (err) {
        _convLog.warn('conversation rename follow-up failed', {
          error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
        });
      }
    }
    return true;
  } catch (err) {
    _trackConversationManageResult('rename', startedAt, 'failure', 'rename_failed');
    _convLog.warn('rename conversation failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
    try { await uiAlert(t('chat.conv_rename_failed')); } catch (_) {}
    return false;
  }
}

function _startConversationInlineRename(cid) {
  if (!cid || !Array.isArray(conversations)) return;
  _conversationHeaderRenameCid = null;
  _conversationInlineRenameCid = cid;
  renderConversationList();
  setTimeout(() => {
    const input = document.querySelector(`input.conv-item-title-input[data-conv-rename-cid="${CSS.escape(cid)}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }, 0);
}

function _cancelConversationInlineRename(cid) {
  if (_conversationInlineRenameCid !== cid) return;
  _conversationInlineRenameCid = null;
  renderConversationList();
  _refreshChatHeader();
}

function _startConversationHeaderRename(cid) {
  if (!cid || !Array.isArray(conversations)) return;
  _conversationInlineRenameCid = null;
  _conversationHeaderRenameCid = cid;
  _refreshChatHeader();
  setTimeout(() => {
    const input = document.getElementById('chat-header-title-input');
    if (input && _conversationHeaderRenameCid === cid) {
      if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(input);
      input.focus();
      input.select();
    }
  }, 0);
}

function _cancelConversationHeaderRename(cid) {
  if (_conversationHeaderRenameCid !== cid) return;
  _conversationHeaderRenameCid = null;
  _refreshChatHeader();
}

async function _deleteConversationWithConfirm(cid, opts = {}) {
  if (!cid) return;
  if (!(await uiConfirm(t('chat.conv_del_confirm')))) return;
  const startedAt = Date.now();
  const conversation = Array.isArray(conversations)
    ? conversations.find((item) => item && item.conversation_id === cid)
    : null;
  abortConvStream(cid);
  const projectId = _projectIdForConversation(cid);
  try {
    const response = await apiFetch(
      `/api/conversations/${encodeURIComponent(cid)}?project_id=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    );
    let result = null;
    try { result = await response.json(); } catch (_) { /* status remains authoritative */ }
    if (!response.ok || result?.ok === false) {
      throw new Error(result?.error || `delete failed (${response.status || 'unknown'})`);
    }
  } catch (err) {
    _trackConversationManageResult('delete', startedAt, 'failure', 'delete_failed');
    _convLog.warn('delete conversation failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
    await uiAlert(t('chat.message_delete_failed', { reason: t('chat.unknown_error') }));
    return false;
  }
  _forgetConvLocal(cid);
  if (currentCid === cid) setView('new-chat');
  conversations = (Array.isArray(conversations) ? conversations : [])
    .filter((item) => item && item.conversation_id !== cid);
  if (conversation?.project_id) {
    const page = _conversationProjectPages.get(conversation.project_id);
    if (page) {
      page.total = Math.max(0, (Number(page.total) || 0) - 1);
      if (page.nextOffset !== null) page.nextOffset = Math.max(0, page.nextOffset - 1);
    }
  } else if (conversation) {
    _unprojectedConversationPage.total = Math.max(
      0,
      (Number(_unprojectedConversationPage.total) || 0) - 1,
    );
    if (_unprojectedConversationPage.nextOffset !== null) {
      _unprojectedConversationPage.nextOffset = Math.max(0, _unprojectedConversationPage.nextOffset - 1);
    }
  }
  renderConversationList();
  _trackConversationManageResult('delete', startedAt, 'success');
  if (typeof opts.afterDelete === 'function') {
    try { await opts.afterDelete(cid); } catch (err) {
      _convLog.warn('conversation delete follow-up failed', {
        error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
      });
    }
  }
  return true;
}

function _conversationActionItems(cid, opts = {}) {
  const conv = Array.isArray(conversations)
    ? conversations.find((c) => c && c.conversation_id === cid)
    : null;
  const items = [];
  if (!opts.hidePin) {
    const pinned = !!(conv && conv.pinned_at);
    items.push({
      action: 'pin',
      label: t(pinned ? 'chat.conv_unpin_title' : 'chat.conv_pin_title'),
      onClick: () => _toggleConversationPinned(cid, !pinned),
    });
  }
  items.push({
    action: 'rename',
    label: t('chat.conv_rename_title'),
    onClick: () => opts.renameInHeader ? _startConversationHeaderRename(cid) : _renameConversation(cid),
  });
  items.push({
    action: 'delete',
    label: t('chat.conv_del_title'),
    danger: true,
    onClick: () => _deleteConversationWithConfirm(cid, opts),
  });
  return items;
}

function _openConversationActionMenu(anchorBtn, cid, opts = {}) {
  if (!anchorBtn || !cid) return;
  let menu = document.getElementById('conversation-action-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'conversation-action-menu';
    menu.className = 'ctx-row-menu conversation-action-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.cid === cid && menu.style.display !== 'none';
  if (sameAnchor) { _closeConversationActionMenu(); return; }
  _closeConversationActionMenu();

  const items = _conversationActionItems(cid, opts);
  menu.innerHTML = items.map((it, idx) =>
    `<div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}" data-action-idx="${idx}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.dataset.cid = cid;

  const row = anchorBtn.closest('.conv-item');
  for (const r of document.querySelectorAll('.conv-item.is-menu-open')) r.classList.remove('is-menu-open');
  if (row) row.classList.add('is-menu-open');

  menu.style.display = 'block';
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  const rect = anchorBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) left = window.innerWidth - menuRect.width - margin;
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll('.ctx-row-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(item.dataset.actionIdx);
      const action = items[idx];
      _closeConversationActionMenu();
      if (action && typeof action.onClick === 'function') action.onClick();
    });
  });
}

function _closeConversationActionMenu() {
  const menu = document.getElementById('conversation-action-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.cid;
  }
  for (const r of document.querySelectorAll('.conv-item.is-menu-open')) r.classList.remove('is-menu-open');
}

document.addEventListener('mousedown', (e) => {
  const menu = document.getElementById('conversation-action-menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.conv-item-menu')) return;
  if (e.target.closest && e.target.closest('.chat-header-menu-btn')) return;
  _closeConversationActionMenu();
}, true);
window.addEventListener('resize', _closeConversationActionMenu);
window.addEventListener('i18n-change', _closeConversationActionMenu);
window.openConversationActionMenu = _openConversationActionMenu;
window.closeConversationActionMenu = _closeConversationActionMenu;

function _bindConversationSidebarItems(container, opts = {}) {
  if (!container) return;
  const selector = opts.selector || '.conv-item';
  container.querySelectorAll('input.conv-item-title-input').forEach((input) => {
    if (input.dataset.renameBound === '1') return;
    input.dataset.renameBound = '1';
    if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(input);
    const cid = input.dataset.convRenameCid;
    const original = input.value;
    let committing = false;
    const commit = async (accept) => {
      if (committing) return;
      committing = true;
      const next = _normaliseConversationTitle(input.value);
      if (!accept || !next || next === original) {
        _cancelConversationInlineRename(cid);
        committing = false;
        return;
      }
      const ok = await _saveConversationTitle(cid, next, opts);
      committing = false;
      if (!ok && _conversationInlineRenameCid === cid) {
        input.focus();
        input.select();
      }
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  });
  container.querySelectorAll(selector).forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.conv-item-title-input')) return;
      if (e.target.closest('.conv-item-action')) return;
      _convTrackClick('sidebar_conversation_open', {
        scope: selector.includes('nested') ? 'project' : 'unprojected',
      });
      setView('conversation', el.dataset.cid);
    });
  });
  container.querySelectorAll('.conv-item-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openConversationActionMenu(btn, btn.dataset.convMenuCid, {
        ...opts,
        hidePin: btn.dataset.hidePin === '1' || !!opts.hidePin,
      });
    });
  });
}

function renderConversationList() {
  _conversationBucketDateKey = _conversationLocalDateKey();
  const container = document.getElementById('conversation-list');
  _sortConversationCacheForSidebar();
  // Conversations with a project_id are rendered nested under their project
  // by `projects.js::renderProjectsSection`. The "Conversations" section
  // here only shows the unprojected ones — same data model as the user's
  // mental picture (projected convs live "inside" their project, the rest
  // sit in the catch-all section).
  const unprojected = (conversations || []).filter((c) => !c || !c.project_id);
  if (!unprojected.length) {
    container.innerHTML = `<div class="conv-empty" data-i18n="sidebar.conv_empty">${escapeHtml(t('sidebar.conv_empty'))}</div>`;
    // Still re-render the projects section so its badges refresh (the call
    // is cheap when the cache is already loaded).
    if (typeof renderProjectsSection === 'function') renderProjectsSection();
    if (typeof _renderProjectAllTasks === 'function') _renderProjectAllTasks();
    if (typeof _refreshAutoExpandedTaskConvs === 'function') _refreshAutoExpandedTaskConvs();
    if (typeof _refreshUnreadTaskIndicators === 'function') _refreshUnreadTaskIndicators();
    return;
  }
  container.innerHTML = _renderConversationTimeBucketList(unprojected);
  if (_unprojectedConversationPage.nextOffset !== null) {
    container.insertAdjacentHTML('beforeend', `<button type="button" class="conversation-list-load-more" data-unprojected-conv-more="1">
      ${escapeHtml(t('sidebar.load_more_conversations'))}</button>`);
  }

  _bindConversationSidebarItems(container);
  container.querySelector('[data-unprojected-conv-more]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await loadUnprojectedConversations({ append: true });
    } catch (err) {
      _convLog.warn('load more unprojected conversations failed', err);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  });

  // Re-render the projects section (it consumes the same `conversations`
  // global to group projected items by project).
  if (typeof renderProjectsSection === 'function') renderProjectsSection();

  // Re-render mirror surfaces that consume the same `conversations` cache:
  // project-detail tasks and expanded automation run lists.
  if (typeof _renderProjectAllTasks === 'function') _renderProjectAllTasks();
  if (typeof _refreshAutoExpandedTaskConvs === 'function') _refreshAutoExpandedTaskConvs();

  // Reapply pending / queued status badges after the DOM was re-rendered
  // (covers both the unprojected list and the projects section's nested
  // conv items, since the helper queries by cid only).
  _refreshAllConvBadges();
}

// ─── Conversation history render ───

// Inline "create agent" entry that lives at the very end of the conversation
// history — visually a divider with a small button in the middle, anchored
// to the last message. Hidden while a stream is in flight (the scroll-pin
// spacer is present then) so it doesn't tempt the user to sediment a
// half-finished reply.
function _ensureConvCreateAgentInline() {
  const container = document.getElementById('chat-history');
  if (!container) return;
  let el = document.getElementById('conv-create-agent-inline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conv-create-agent-inline';
    el.className = 'conv-create-agent-inline';
    el.style.display = 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-i18n', 'chat.create_agent_inline');
    btn.textContent = t('chat.create_agent_inline');
    btn.addEventListener('click', () => {
      if (!currentCid) return;
      if (window.Monitor) (() => {})('create_agent_from_chat', { cid: currentCid });
      const input = document.getElementById('chat-input');
      if (!input) return;
      input.value = t('chat.create_agent_message');
      autoGrow(input, 200);
      handleChatSubmit();
    });
    el.appendChild(btn);
  }
  // Position: last child of chat-history, but BEFORE the scroll-pin spacer
  // when one exists (spacer's job is to be the literal final element).
  const spacer = container.querySelector('.chat-scroll-spacer');
  if (spacer) {
    if (el.nextSibling !== spacer) container.insertBefore(el, spacer);
  } else if (container.lastChild !== el) {
    container.appendChild(el);
  }
  const hasUserMsg = !!container.querySelector('.chat-message.user');
  const runtimeBusy = _isConvCreateAgentInlineRuntimeBusy(currentCid);
  const isStreaming = !!spacer || runtimeBusy;
  // Once any agent (other than commander / user) joins the conversation,
  // hide the entry — in a multi-agent flow the "promote a single agent"
  // semantic no longer holds. Either signal counts:
  //   1) The roster contains a member with kind === 'agent' (most
  //      authoritative — includes agents that were @-mentioned but
  //      haven't spoken yet).
  //   2) The DOM contains an utterance whose _from / fromActor is
  //      non-empty and not commander/user (fallback that fires before
  //      the member cache loads).
  const members = _groupMembersCache.get(currentCid) || [];
  const hasAgentMember = members.some((a) => a && a.kind === 'agent');
  const hasAgentMsg = hasAgentMember || Array.from(
    container.querySelectorAll('.chat-message.assistant'),
  ).some((m) => {
    const f = m.dataset.from || m.dataset.fromActor;
    return f && f !== 'commander' && f !== 'user';
  });
  el.style.display = _shouldShowConvCreateAgentInline(hasUserMsg, isStreaming, hasAgentMsg) ? '' : 'none';
}

function _isConvCreateAgentInlineRuntimeBusy(cid) {
  return !!cid && isConvPending(cid);
}

function _shouldShowConvCreateAgentInline(hasUserMsg, isStreaming, hasAgentMsg) {
  return !!hasUserMsg && !isStreaming && !hasAgentMsg;
}

// Single observer wired once — any childList change on chat-history
// (history load, send, stream final, spacer add/remove) re-runs ensure.
let _createAgentInlineObserver = null;
// Conversation detail history is deliberately page-sized. Each "older"
// request carries the previous page's opaque byte cursor, so both disk reads
// and first paint stay bounded even for very long JSONL transcripts.
const HISTORY_PAGE_SIZE = 10;
const HISTORY_AUTO_LOAD_THRESHOLD = 48;

function _isConversationMissingResponse(data) {
  if (!data || data.ok !== false) return false;
  const code = String(data.code || '').toUpperCase();
  const message = String(data.error || '').trim().toLowerCase();
  return code === 'E_CONVERSATION_NOT_FOUND'
    || code === 'E_NOT_FOUND'
    || message === 'conversation not found';
}

async function _recoverMissingConversation(cid, source = 'history') {
  if (!cid) return;
  try { abortConvStream(cid); } catch (_) {}
  try { _forgetConvLocal(cid); } catch (_) {}
  conversations = (Array.isArray(conversations) ? conversations : [])
    .filter((item) => item && item.conversation_id !== cid);
  try { renderConversationList(); } catch (_) {}
  if (currentCid === cid) {
    try { setView('new-chat'); } catch (_) {}
  }
  try { await loadConversations(); } catch (_) {}
  void source;
}

function _historyRequestUrl(
  cid,
  before = null,
  limit = HISTORY_PAGE_SIZE,
  aroundIndex = null,
  aroundMessageId = '',
) {
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || HISTORY_PAGE_SIZE)));
  let url = `/api/conversations/${encodeURIComponent(cid)}/history?limit=${pageSize}`;
  if (Number.isSafeInteger(before) && before >= 0) url += `&before=${before}`;
  if (Number.isSafeInteger(aroundIndex) && aroundIndex >= 0) url += `&around_index=${aroundIndex}`;
  if (aroundMessageId) url += `&around_message_id=${encodeURIComponent(aroundMessageId)}`;
  // The sidebar already knows the physical owner. Main treats this only as a
  // validated lookup hint and falls back safely if sync moved the conversation.
  url += `&project_id=${encodeURIComponent(_projectIdForConversation(cid))}`;
  return url;
}

function _turnNavigationRequestUrl(cid, before = null) {
  let url = `/api/conversations/${encodeURIComponent(cid)}/turns?limit=15`;
  if (Number.isSafeInteger(before) && before >= 0) url += `&before=${before}`;
  url += `&project_id=${encodeURIComponent(_projectIdForConversation(cid))}`;
  return url;
}

async function _loadConversationTurnNavigationPage(cid, before = null) {
  if (!cid || cid !== currentCid) return { turns: [], total: 0, next_cursor: null };
  const response = await apiFetch(_turnNavigationRequestUrl(cid, before));
  const data = await response.json();
  if (_isConversationMissingResponse(data)) {
    await _recoverMissingConversation(cid, 'turn_navigation');
    return { turns: [], total: 0, next_cursor: null };
  }
  if (!data?.ok) throw new Error(data?.error || 'turn navigation load failed');
  if (cid !== currentCid) return { turns: [], total: 0, next_cursor: null };
  return data;
}

async function _activateConversationTurnNavigationEntry(cid, turn) {
  if (!cid || cid !== currentCid || !turn) return false;
  const messageIndex = Number(turn.messageIndex);
  await loadConversationHistory(cid, {
    searchTarget: {
      msgId: String(turn.messageId || ''),
      ...(Number.isSafeInteger(messageIndex) && messageIndex >= 0 ? { msgIndex: messageIndex } : {}),
      role: 'user',
    },
  });
  return cid === currentCid;
}

function _openConversationTurnNavigation(cid) {
  if (!cid || !window.ConversationTurnNav?.open) return;
  window.ConversationTurnNav.open({
    cid,
    loadPage: (before) => _loadConversationTurnNavigationPage(cid, before),
    onActivate: (turn) => _activateConversationTurnNavigationEntry(cid, turn),
  });
}

function _membersRequestUrl(cid) {
  return `/api/conversations/${encodeURIComponent(cid)}/members?project_id=${encodeURIComponent(_projectIdForConversation(cid))}`;
}

function _historyNextCursor(value) {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
}

function _setEarlierHistoryLoaderState(row, state, error = '') {
  if (!row) return;
  row.classList.toggle('is-loading', state === 'loading');
  row.classList.toggle('is-error', state === 'error');
  row.dataset.state = state;
  if (state === 'loading') {
    row.removeAttribute('aria-hidden');
    row.innerHTML = `<span class="chat-history-inline-spinner" aria-hidden="true"></span><span>${escapeHtml(t('chat.loading'))}</span>`;
    return;
  }
  if (state === 'error') {
    row.removeAttribute('aria-hidden');
    row.textContent = t('chat.load_failed', { msg: error });
    return;
  }
  row.setAttribute('aria-hidden', 'true');
  row.textContent = '';
}

function _maybeAutoLoadEarlierHistory(container) {
  if (!container || Number(container.scrollTop || 0) > HISTORY_AUTO_LOAD_THRESHOLD) {
    const row = container?.querySelector?.('.chat-history-load-earlier');
    if (row?.dataset.state === 'error') _setEarlierHistoryLoaderState(row, 'idle');
    return;
  }
  if (_isProgrammaticStickyScroll(container)) return;
  const row = container.querySelector('.chat-history-load-earlier');
  if (!row || row.dataset.state === 'loading' || row.dataset.state === 'error') return;
  const cursor = _historyNextCursor(row.dataset.cursor);
  const cid = String(row.dataset.cid || '');
  if (cursor === null || !cid || cid !== currentCid) return;
  void _loadOlderConversationHistory(cid, cursor);
}

function _bindAutoLoadEarlierHistory(container) {
  if (!container || container._historyAutoLoadBound) return;
  container._historyAutoLoadBound = true;
  container.addEventListener('scroll', () => _maybeAutoLoadEarlierHistory(container), { passive: true });
  // A wheel/touch gesture at scrollTop=0 does not always emit another scroll
  // event. Listen for the user's continued upward intent so short pages can
  // still advance without a button.
  container.addEventListener('wheel', (event) => {
    if (Number(event?.deltaY || 0) < 0) _maybeAutoLoadEarlierHistory(container);
  }, { passive: true });
  container.addEventListener('touchmove', () => _maybeAutoLoadEarlierHistory(container), { passive: true });
}

function _setLoadEarlierHistory(container, cid, nextCursor) {
  if (!container) return;
  const existing = container.querySelector('.chat-history-load-earlier');
  const cursor = _historyNextCursor(nextCursor);
  if (cursor === null) {
    if (existing) existing.remove();
    return;
  }
  const row = existing || document.createElement('div');
  row.className = 'chat-history-load-earlier';
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');
  row.dataset.cid = String(cid || '');
  row.dataset.cursor = String(cursor);
  _setEarlierHistoryLoaderState(row, 'idle');
  if (!existing) container.insertBefore(row, container.firstChild);
  _bindAutoLoadEarlierHistory(container);
}

async function _loadOlderConversationHistory(cid, before) {
  if (!cid || cid !== currentCid) return;
  const container = document.getElementById('chat-history');
  if (!container) return;
  if (container._historyOlderLoading) return container._historyOlderLoading;
  const row = container.querySelector('.chat-history-load-earlier');
  const initialCursor = _historyNextCursor(before);
  if (!row || initialCursor === null) return;

  const run = (async () => {
    _setEarlierHistoryLoaderState(row, 'loading');
    const previousScrollHeight = Number(container.scrollHeight || 0);
    const previousScrollTop = Number(container.scrollTop || 0);
    try {
      const knownIds = new Set(Array.from(container.querySelectorAll('.chat-message[data-msg-id]'))
        .map((el) => el.dataset.msgId)
        .filter(Boolean));
      const visitedCursors = new Set();
      let cursor = initialCursor;
      let nextCursor = initialCursor;
      let page = [];
      let rawRows = 0;

      // Task transcripts can contain full raw pages made only of internal
      // dispatch/routing records. Advance across those pages in the same load
      // so reaching the top never appears to do nothing.
      while (cursor !== null && page.length === 0) {
        if (visitedCursors.has(cursor)) throw new Error('history cursor did not advance');
        visitedCursors.add(cursor);
        const res = await apiFetch(_historyRequestUrl(cid, cursor));
        const data = await res.json();
        if (_isConversationMissingResponse(data)) {
          await _recoverMissingConversation(cid, 'older_history');
          return;
        }
        if (!data?.ok) throw new Error(data?.error || 'load failed');
        if (cid !== currentCid || row.parentElement !== container) return;

        const rawHistory = Array.isArray(data.history) ? data.history : [];
        rawRows += rawHistory.length;
        page = _collapseSupersededInterruptionRecords(
          rawHistory.filter((gm) => (
            _isVisibleGroupHistoryRecord(gm)
            && (!gm.id || !knownIds.has(String(gm.id)))
          )),
        );
        nextCursor = _historyNextCursor(data.next_cursor);
        if (nextCursor !== null && nextCursor === cursor) {
          throw new Error('history cursor did not advance');
        }
        cursor = nextCursor;
      }

      const messages = page
        .map(_groupMsgToLegacy)
        .sort((a, b) => _msTs(a && a.time) - _msTs(b && b.time));
      const fragment = document.createDocumentFragment();
      messages.forEach((msg) => appendChatMessage(msg, false, {
        cid,
        container: fragment,
        historyHydration: true,
      }));
      // Keep the auto-load sentinel as the first child. Every successively
      // older page lands immediately after it and before the already-mounted
      // transcript, preserving chronological order across repeated loads.
      container.insertBefore(fragment, row.nextSibling);
      _removeSupersededInterruptionBubbles(container);
      _setLoadEarlierHistory(container, cid, nextCursor);
      _restoreOlderHistoryPrependScroll(container, previousScrollHeight, previousScrollTop);
      _convLog.info('older conversation history loaded', {
        cid,
        before: initialCursor,
        next_cursor: nextCursor,
        raw_rows: rawRows,
        visible_rows: messages.length,
      });
    } catch (err) {
      _convLog.warn('load older conversation history failed', err);
      if (row.parentElement === container) {
        _setEarlierHistoryLoaderState(row, 'error', err?.message || String(err));
      }
    }
  })();
  container._historyOlderLoading = run;
  try {
    await run;
  } finally {
    if (container._historyOlderLoading === run) container._historyOlderLoading = null;
  }
}

function _findConversationHistorySearchTarget(container, target = {}) {
  if (!container) return null;
  const messages = Array.from(container.querySelectorAll('.chat-message'));
  const msgId = String(target.msgId || '').trim();
  if (msgId) {
    const byId = messages.find((message) => String(message.dataset?.msgId || '') === msgId);
    if (byId) return byId;
  }
  const msgIndex = Number(target.msgIndex);
  if (Number.isSafeInteger(msgIndex) && msgIndex >= 0) {
    const byIndex = messages.find((message) => Number(message.dataset?.msgIndex) === msgIndex);
    if (byIndex) return byIndex;
  }
  const targetTs = _msTs(target.time);
  if (!targetTs) return null;
  const role = target.role === 'user' || target.role === 'assistant' ? target.role : '';
  return messages.find((message) => (
    Number(message.dataset?.ts || 0) === targetTs
    && (!role || message.classList?.contains(role))
  )) || null;
}

function _flashConversationHistorySearchTarget(target) {
  if (!target) return;
  const container = target.closest?.('.chat-history') || target.parentElement;
  if (container) {
    // `.chat-history` has CSS smooth scrolling for ordinary navigation. A
    // search hit is an exact address, so assign scrollTop directly and mark
    // the resulting event as programmatic. Besides making the jump instant,
    // this prevents the top-of-page auto-loader from interpreting the jump as
    // user intent and walking through earlier pages one by one.
    const previousBehavior = container.style?.scrollBehavior || '';
    if (container.style) container.style.scrollBehavior = 'auto';
    _markProgrammaticStickyScroll(container);
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centeredTop = Number(container.scrollTop || 0)
      + targetRect.top - containerRect.top
      - (Number(container.clientHeight || 0) - targetRect.height) / 2;
    container.scrollTop = Math.max(0, centeredTop);
    container._stickyEnabled = false;
    container._stickyUserPaused = true;
    requestAnimationFrame(() => {
      if (container.style) container.style.scrollBehavior = previousBehavior;
    });
  }
  target.classList.add('search-flash');
  setTimeout(() => target.classList.remove('search-flash'), 1600);
}

function _revealConversationHistorySearchTarget(cid, target = {}) {
  if (!cid || cid !== currentCid) return false;
  const container = document.getElementById('chat-history');
  if (!container) return false;
  const message = _findConversationHistorySearchTarget(container, target);
  if (!message) return false;
  _flashConversationHistorySearchTarget(message);
  return true;
}

function _ensureCreateAgentInlineObserver() {
  if (_createAgentInlineObserver) return;
  const target = document.getElementById('chat-history');
  if (!target) return;
  _createAgentInlineObserver = new MutationObserver(_ensureConvCreateAgentInline);
  _createAgentInlineObserver.observe(target, { childList: true });
  _ensureConvCreateAgentInline();
}

async function loadConversationHistory(cid, opts = {}) {
  const perfStartedAt = performance.now();
  const container = document.getElementById('chat-history');
  const preserveScroll = opts && opts.preserveScroll === true;
  let scrollSnapshot = preserveScroll ? _captureHistoryReloadScroll(container) : null;
  // A task switch rebuilds this container. Cancel any delayed send-time pin
  // before replacing its children; otherwise a queued double-rAF callback can
  // re-append the old turn's spacer after the new task has rendered. A
  // preserve-scroll reconcile may run mid-stream, so keep the active turn's
  // pin in that one case.
  if (!preserveScroll || !isConvPending(cid)) {
    _setChatScrollOffset(false, container);
  }
  container.classList.remove('has-scroll-offset');
  if (!preserveScroll) {
    container.innerHTML = `<div class="empty">${escapeHtml(t('chat.loading'))}</div>`;
  }
  _ensureCreateAgentInlineObserver();
  try {
    // Start the independent IPC requests first. Agent names are still ready
    // before transcript rendering, but a cold summary-cache fill no longer
    // serializes ahead of the history round trip.
    const historyStartedAt = performance.now();
    const historyPromise = apiFetch(_historyRequestUrl(
      cid,
      null,
      HISTORY_PAGE_SIZE,
      Number(opts.searchTarget?.msgIndex),
      String(opts.searchTarget?.msgId || ''),
    ));
    const membersStartedAt = performance.now();
    const membersPromise = _refreshGroupMembers(cid).then((actors) => {
      _convLog.info('conversation detail members ready', {
        cid,
        ms: Math.round(performance.now() - membersStartedAt),
        count: Array.isArray(actors) ? actors.length : 0,
      });
      return actors;
    }).catch((err) => {
      _convLog.warn('conversation detail members refresh failed', err);
      return [];
    });
    // Warm `_agentsCache` if a chat-first session never visited the agents
    // tab — `_buildMentionRe` / `_groupActorLabel` both read it for current
    // names. Without this, a user who lands straight in a conversation gets
    // multi-word `@<name>` highlighting truncated to the first whitespace.
    const agentsStartedAt = performance.now();
    if (typeof loadAgents === 'function'
        && typeof _agentsCache !== 'undefined' && !_agentsCache) {
      try { await loadAgents(false, { summary: true }); } catch (_) { /* non-fatal */ }
    }
    const agentsReadyMs = Math.round(performance.now() - agentsStartedAt);
    // Member avatars and deleted-Agent fallback names are secondary detail.
    // Start their refresh with history, but do not make the 10-row transcript
    // wait for member-file reads and per-Agent enrichment. The startup Agent
    // summary covers normal labels; completion repaints header/placeholders.
    const res = await historyPromise;
    const historyResponseMs = Math.round(performance.now() - historyStartedAt);
    const parseStartedAt = performance.now();
    const data = await res.json();
    const jsonParseMs = Math.round(performance.now() - parseStartedAt);
    if (_isConversationMissingResponse(data)) {
      await _recoverMissingConversation(cid, 'history');
      return;
    }
    if (!data.ok) throw new Error(data.error || 'load failed');
    if (cid !== currentCid) return;
    // The history request is asynchronous. The user may scroll upward after
    // this background reconcile starts but before its response arrives, so
    // the start-of-request snapshot can already be stale. Re-capture at the
    // last safe point before replacing the transcript DOM.
    if (preserveScroll) scrollSnapshot = _captureHistoryReloadScroll(container);
    const convMeta = data.conversation || {};
    _serverFloorByCid.set(cid, typeof convMeta.active_recipient === 'string' ? convMeta.active_recipient : '');
    // History reload: drop ALL per-actor placeholder map entries — the
    // `container.innerHTML=''` below detaches every placeholder DOM node,
    // including the ones for this cid. Keeping `${cid}:*` entries leaves
    // the map pointing at orphan nodes; the next `_consumeActorPlaceholder`
    // would find an entry whose `parentElement` is null, fall through to
    // the `appendChatMessage` fallback, and any deltas accumulated on
    // that orphan during the in-flight stream are lost (the symptom users
    // see as "the in-flight reply bubble disappears + a duplicate final
    // appears below"). After clearing, the next `_ensureActorPlaceholder`
    // re-adopts `state.loadingEl` (re-attached below via the
    // `isConvPending` branch) for the first actor and mints fresh
    // placeholders for any additional actors — no orphan window.
    _groupPlaceholders.clear();
    // Drop internal plan-step dispatch messages (commander → agent
    // hand-off) AND redundant routing-only commander tails (the "second
    // commander bubble" — read agent.json + hand_off_to, no prose). The user
    // already saw the narration seg bubble; surfacing these adds noise. The
    // agent's visibility slice still carries dispatches so the agent has the
    // dispatch text in its own context.
    const renderStartedAt = performance.now();
    const rawHistory = Array.isArray(data.history) ? data.history : [];
    const responseIndexes = Array.isArray(data.history_indexes) ? data.history_indexes : [];
    const responsePageStart = Number(data.page_start);
    const indexedHistory = rawHistory.map((gm, offset) => {
      if (!gm || typeof gm !== 'object') return gm;
      const explicitIndex = Number(responseIndexes[offset]);
      const fallbackIndex = Number.isSafeInteger(responsePageStart) && responsePageStart >= 0
        ? responsePageStart + offset
        : Number.NaN;
      const sourceIndex = Number.isSafeInteger(explicitIndex) && explicitIndex >= 0
        ? explicitIndex
        : fallbackIndex;
      return Number.isSafeInteger(sourceIndex) && sourceIndex >= 0
        ? { ...gm, _history_index: sourceIndex }
        : gm;
    });
    const visibleGroupHistory = _collapseSupersededInterruptionRecords(
      indexedHistory.filter(_isVisibleGroupHistoryRecord),
    );
    const history = visibleGroupHistory
      .map(_groupMsgToLegacy)
      // Defensive sort by ts: jsonl is append-ordered (already chronological),
      // but stable-sort guards against any future writer that lands a message
      // out of order so loadConversationHistory matches `_insertByTimestamp`.
      .sort((a, b) => _msTs(a && a.time) - _msTs(b && b.time));
    if (!history.length) {
      container.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
    } else {
      container.innerHTML = '';
      // The history array is already time-sorted above. Stage it off-DOM and
      // bypass the live-event dedupe/sorted-insertion work: doing either for
      // every persisted row turns even a small paged cold open into repeated DOM
      // tree scans. Live messages and recovery paths still use the guarded
      // incremental insertion path below.
      const historyFragment = document.createDocumentFragment();
      history.forEach((msg) => appendChatMessage(msg, false, {
        cid,
        // Only stamp authoritative source indexes returned by an anchored
        // history read. A normal latest-page row has no global index; using
        // its local 0..9 offset would let a later search falsely match it.
        msgIndex: Number.isSafeInteger(msg?._history_index) ? msg._history_index : undefined,
        container: historyFragment,
        historyHydration: true,
      }));
      container.appendChild(historyFragment);
    }
    // Reflect a persisted latest-reply failure on the sidebar row when a
    // conversation is (re)opened — the failure lives in the history message,
    // not the conversation index. See `_syncFailedFromHistory`.
    _syncFailedFromHistory(cid, history);
    _setLoadEarlierHistory(container, cid, data.next_cursor);
    const searchTargetRevealed = opts.searchTarget
      ? _revealConversationHistorySearchTarget(cid, opts.searchTarget)
      : false;
    const renderMs = Math.round(performance.now() - renderStartedAt);
    _convLog.info('conversation detail first paint', {
      cid,
      total_ms: Math.round(performance.now() - perfStartedAt),
      agents_ms: agentsReadyMs,
      history_response_ms: historyResponseMs,
      json_ms: jsonParseMs,
      render_ms: renderMs,
      rows: history.length,
    });
    await _evaluateAutoRecipient(cid);
    // The video review drawer binds on the conversation view switch (boot.js),
    // which covers the branches that never load history. Probing again here
    // would only repeat that IPC round trip.

    // Detect unanswered user message (e.g. after page refresh while server was processing).
    // Only show the "thinking…" bubble if the server *really* still has this
    // conversation in processing state AND the work started recently — a stale
    // `processing: true` from a crashed prior run is swept on boot, but we
    // also belt-and-braces check the flag here so no flash occurs.
    const lastMsg = history[history.length - 1];
    // Cache the conv-bound agent's enabled state so _updateConvSendUI can
    // grey out the input without a second IPC round trip. Backend stamps
    // `agent_enabled` on the conversation payload (true when no agent_id).
    convAgentEnabledByCid.set(cid, convMeta.agent_enabled !== false);
    _renderConvDisabledBanner(cid);
    const processingFresh = convMeta.processing === true
      && convMeta.processing_since
      && (Date.now() - new Date(convMeta.processing_since).getTime()) < 15 * 60 * 1000;
    const inFlightActors = Array.isArray(convMeta.in_flight)
      ? convMeta.in_flight.filter(Boolean).map(String)
      : [];
    const hasActiveTurnsField = Array.isArray(convMeta.active_turns);
    const activeTurns = _normaliseActiveTurns(convMeta.active_turns);
    _latestActiveTurns.set(cid, hasActiveTurnsField ? activeTurns : []);
    const wasPendingBeforeHistoryRecovery = isConvPending(cid);
    if (processingFresh && !wasPendingBeforeHistoryRecovery) {
      setGroupConversationBusy(cid, true);
      _latestInFlight.set(cid, inFlightActors);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
      if (cid === currentCid) _updateConvSendUI(cid);
    }
    const shouldRecoverRunningUi = !wasPendingBeforeHistoryRecovery
      && processingFresh
      && (lastMsg?.role === 'user' || inFlightActors.length > 0);
    if (shouldRecoverRunningUi) {
      pollMsgCounts.set(cid, String(lastMsg?._msg_id || ''));
      const loadingEl = _createStreamingAssistantMessage(container, { hiddenUntilActor: true });
      pendingConvs.set(cid, {
        loadingEl,
        needsIndicator: false,
        startedAtMs: Math.max(0, new Date(convMeta.processing_since).getTime() || 0),
      });
      if (hasActiveTurnsField) {
        for (const turn of activeTurns) {
          _ensureActorPlaceholder(cid, turn.actor, loadingEl, turn.turn_id, turn.msg_id, turn.started_at_ms);
        }
      } else {
        for (const actorId of inFlightActors) {
          _ensureActorPlaceholder(cid, actorId, loadingEl);
        }
      }
      // Opening/reloading into an already-running plan still needs the
      // group event stream; runtime polling can recover placeholders, but
      // it cannot replay live text deltas.
      _observeConversationRunFromPlanAction(cid, { attachExisting: true });
      _startRuntimeActorRecovery(cid);
      _updateConvSendUI(cid);
    } else if (isConvPending(cid)) {
      // User navigated away and back during an in-flight request. The stream
      // reader loop in createChatController.send() holds the original msgEl
      // in closure and keeps dispatching deltas/final to that *specific* node
      // — so we must re-attach the original node, not mint a fresh bubble.
      // Minting a new one here (as before) stranded the stream: events kept
      // landing on the orphaned node and the new bubble stayed at "thinking…"
      // until stream end / polling rescue.
      let state = pendingConvs.get(cid);
      if (!state) {
        state = { loadingEl: null, needsIndicator: false, controller: null, aborted: false };
        pendingConvs.set(cid, state);
      }
      pollMsgCounts.set(cid, String(lastMsg?._msg_id || ''));
      if (state.loadingEl) {
        const emptyEl = container.querySelector('.empty');
        if (emptyEl) emptyEl.remove();
        _appendBeforeSpacer(container, state.loadingEl);
      } else {
        const loadingEl = _createStreamingAssistantMessage(container, { hiddenUntilActor: true });
        state.loadingEl = loadingEl;
      }
      if (hasActiveTurnsField) {
        for (const turn of activeTurns) {
          _ensureActorPlaceholder(cid, turn.actor, state.loadingEl, turn.turn_id, turn.msg_id, turn.started_at_ms);
        }
      } else {
        for (const actorId of inFlightActors) {
          _ensureActorPlaceholder(cid, actorId, state.loadingEl);
        }
      }
      if (!state.controller) {
        // Same recovery path for a detached pending state: reconnect to the
        // live group event stream so the bubble streams instead of waiting
        // for the final history reconcile.
        _observeConversationRunFromPlanAction(cid, { attachExisting: true });
        _startRuntimeActorRecovery(cid);
      }
      state.needsIndicator = false;
      startPolling(cid); // ensure polling is running as backup
    }


    // Re-add the inline "create agent" entry BEFORE scrolling so it's part of
    // scrollHeight when we jump to the bottom — otherwise the MutationObserver
    // adds it post-scroll and it ends up below the visible area.
    _ensureConvCreateAgentInline();
    if (cid !== currentCid) return;
    if (preserveScroll) _restoreHistoryReloadScroll(container, scrollSnapshot);
    else if (!searchTargetRevealed) _scrollToBottomNoAnim(container);
    if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid);
    if (cid === currentCid && !isConvPending(cid) && (messageQueues.get(cid) || []).length) {
      _dispatchNextQueued(cid);
    }
    void membersPromise;
  } catch (e) {
    if (!preserveScroll) {
      container.innerHTML = `<div class="empty">${escapeHtml(t('chat.load_failed', { msg: e.message || '' }))}</div>`;
    }
    if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid);
  }
}

function _claimPersistedUserMessage(cid, gm) {
  if (!cid || cid !== currentCid || !gm || gm.from !== 'user' || !gm.id) return false;
  const container = document.getElementById('chat-history');
  if (!container) return false;
  const existing = container.querySelector(`.chat-message[data-msg-id="${CSS.escape(String(gm.id))}"]`);
  if (existing) {
    _moveUserBeforeOrphanLivePlaceholder(container, existing);
    _markEarlierLiveMessagesForUser(container, existing);
    return true;
  }

  // Exact identity: the bubble this send painted, echoed back by the bus. The
  // positional fallbacks below cannot tell two concurrent sends apart (queue
  // drain, retry), so they claim whichever bubble happens to be last.
  const clientMsgId = String(gm.client_msg_id || '');
  const claimed = clientMsgId
    ? container.querySelector(
      `.chat-message.user[data-client-msg-id="${CSS.escape(clientMsgId)}"]:not([data-msg-id])`,
    )
    : null;
  if (claimed) {
    _syncRenderedGroupMessageIdentity(claimed, gm);
    _moveUserBeforeOrphanLivePlaceholder(container, claimed);
    _markEarlierLiveMessagesForUser(container, claimed);
    return true;
  }
  // Records written before this field existed, and sends that did not originate
  // in this renderer (relay commands), still need the positional guess.
  const pairCandidates = Array.from(
    container.querySelectorAll('.chat-message.user[data-conv-pair]:not([data-msg-id]):not([data-client-msg-id])'),
  );
  const fallbackCandidates = Array.from(
    container.querySelectorAll('.chat-message.user:not([data-msg-id]):not([data-client-msg-id])'),
  );
  // Fast queued turns can append the next optimistic user bubble before the
  // bus echoes the previous persisted user record. Claiming the newest
  // unclaimed bubble would then swap the two messages in the live transcript.
  // Prefer the earliest exact-content match; persisted user events are ordered,
  // so identical messages also bind FIFO.
  const persistedText = String(gm.text || '').trim();
  const contentMatch = pairCandidates.find(candidate => (
    String(candidate.dataset.retryContent || '').trim() === persistedText
  )) || fallbackCandidates.find(candidate => (
    String(candidate.dataset.retryContent || '').trim() === persistedText
  ));
  const target = contentMatch
    || pairCandidates[pairCandidates.length - 1]
    || fallbackCandidates[fallbackCandidates.length - 1];
  if (!target) return false;

  _syncRenderedGroupMessageIdentity(target, gm);
  _moveUserBeforeOrphanLivePlaceholder(container, target);
  _markEarlierLiveMessagesForUser(container, target);
  return true;
}

function _renderOrClaimPersistedUserMessage(cid, gm, opts = {}) {
  if (!cid || cid !== currentCid || !gm || gm.from !== 'user') return false;
  if (_claimPersistedUserMessage(cid, gm)) return true;
  const bubble = appendChatMessage(_groupMsgToLegacy(gm), opts.autoScroll !== false, { cid, archive: true });
  if (!bubble) return false;
  bubble.dataset.fromActor = 'user';
  if (gm.id) bubble.dataset.msgId = String(gm.id);
  _syncRenderedGroupMessageIdentity(bubble, gm);
  const container = document.getElementById('chat-history');
  if (container) {
    _moveUserBeforeOrphanLivePlaceholder(container, bubble);
    _markEarlierLiveMessagesForUser(container, bubble);
  }
  return true;
}

// Render missing persisted user messages for the open conversation.
async function _renderRelayUserMessagesIfMissing(cid) {
  if (!cid || cid !== currentCid) return;
  const container = document.getElementById('chat-history');
  if (!container) return;
  let data;
  try {
    const res = await apiFetch(_historyRequestUrl(cid));
    data = await res.json();
  } catch (_) { return; }
  if (!data || !data.ok || !Array.isArray(data.history)) return;
  if (cid !== currentCid) return; // user navigated away mid-fetch
  for (const gm of data.history) {
    if (!gm || gm.dispatch || gm.from !== 'user' || !gm.id) continue;
    if (container.querySelector(`.chat-message[data-msg-id="${CSS.escape(String(gm.id))}"]`)) continue;
    _renderOrClaimPersistedUserMessage(cid, gm);
  }
}

// Jump to bottom without smooth animation. Use when opening a conversation —
// the last message should appear immediately, no scrolling effect.
function _scrollToBottomNoAnim(container) {
  if (!container) return;
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(container);
  container.scrollTop = container.scrollHeight;
  // Explicit jump-to-bottom = the user is now pinned to the bottom; arm
  // the sticky-follow flag so subsequent stream content keeps tracking.
  container._stickyUserPaused = false;
  container._stickyEnabled = true;
  _bindStickToBottom(container);
  requestAnimationFrame(() => {
    container.style.scrollBehavior = prev || '';
  });
}

function _olderHistoryPrependTop(previousScrollTop, previousScrollHeight, nextScrollHeight) {
  const addedHeight = Math.max(0, Number(nextScrollHeight || 0) - Number(previousScrollHeight || 0));
  return Math.max(0, Number(previousScrollTop || 0) + addedHeight);
}

function _restoreOlderHistoryPrependScroll(container, previousScrollHeight, previousScrollTop) {
  if (!container) return;
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(container);
  container.scrollTop = _olderHistoryPrependTop(
    previousScrollTop,
    previousScrollHeight,
    container.scrollHeight,
  );
  // Loading older history is explicit upward-reading intent. Do not let the
  // sticky-bottom stream path pull the viewport back to the newest message.
  container._stickyEnabled = false;
  container._stickyUserPaused = true;
  requestAnimationFrame(() => {
    container.style.scrollBehavior = prev || '';
  });
}

function _captureHistoryReloadScroll(container) {
  if (!container) return null;
  const top = Number(container.scrollTop || 0);
  const scrollHeight = Number(container.scrollHeight || 0);
  const clientHeight = Number(container.clientHeight || 0);
  const maxTop = Math.max(0, scrollHeight - clientHeight);
  return {
    top,
    bottom: Math.max(0, maxTop - top),
    // Geometry alone is not enough: a small upward wheel gesture can remain
    // within the near-bottom threshold while still expressing clear reading
    // intent. Carry that explicit pause through the history rebuild.
    nearBottom: !container._stickyUserPaused && _isNearFollowTarget(container),
  };
}

function _historyReloadTopForSnapshot(container, snapshot) {
  if (!container || !snapshot) return 0;
  const maxTop = Math.max(0, Number(container.scrollHeight || 0) - Number(container.clientHeight || 0));
  if (snapshot.nearBottom) {
    return Math.min(maxTop, Math.max(0, maxTop - Number(snapshot.bottom || 0)));
  }
  return Math.min(Math.max(0, Number(snapshot.top || 0)), maxTop);
}

function _restoreHistoryReloadScroll(container, snapshot) {
  if (!container || !snapshot) return;
  const syncStickyState = () => {
    container._stickyEnabled = snapshot.nearBottom === true && _isNearFollowTarget(container);
    container._stickyUserPaused = !container._stickyEnabled;
  };
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(container);
  container.scrollTop = _historyReloadTopForSnapshot(container, snapshot);
  syncStickyState();
  _bindStickToBottom(container);
  requestAnimationFrame(() => {
    _markProgrammaticStickyScroll(container);
    container.scrollTop = _historyReloadTopForSnapshot(container, snapshot);
    syncStickyState();
    container.style.scrollBehavior = prev || '';
  });
}

// ─── Sticky-bottom auto-scroll ─────────────────────────────────────────────
// Track per-container "is the user pinned to the bottom?" so streaming
// content (process info / token deltas / new bubbles) auto-scrolls down
// only while the user wants to follow. Any mid-stream scroll gesture
// suspends auto-stick; scrolling back to (near) bottom resumes it. Tab-switch
// back re-applies the stick if it was on at the moment of going hidden.
//
// Why a threshold (32 px) instead of strict equality: programmatic scrolls
// (`scrollTop = scrollHeight`) and Chromium's sub-pixel rounding leave a
// 1–2 px gap that would otherwise toggle the flag off on the first scroll
// event. 32 px is comfortable for the user too — being "almost at bottom"
// counts as following.
const STICKY_BOTTOM_THRESHOLD = 32;
const STICKY_PROGRAMMATIC_SCROLL_GRACE_MS = 160;
function _isNearBottom(el, threshold = STICKY_BOTTOM_THRESHOLD) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}
function _isNearFollowTarget(el, threshold = STICKY_BOTTOM_THRESHOLD) {
  return _isNearBottom(el, threshold);
}
function _markProgrammaticStickyScroll(el, graceMs = STICKY_PROGRAMMATIC_SCROLL_GRACE_MS) {
  if (!el) return;
  el._stickyProgrammaticUntil = Date.now() + graceMs;
}
function _isProgrammaticStickyScroll(el) {
  return !!el && Number(el._stickyProgrammaticUntil || 0) >= Date.now();
}
function _markStickyPausedByUser(el) {
  if (!el) return;
  el._stickyUserPaused = true;
  el._stickyEnabled = false;
}
// The send-time spacer is only a positioning aid: it lets a short outgoing
// message sit near the top before the reply has enough height of its own.
// Keeping that artificial scroll range for the whole run makes a downward
// wheel / trackpad gesture at the pinned edge appear to do nothing. As soon
// as the user expresses any scroll intent, remove the spacer and let the
// browser's real transcript height own scrolling for the rest of the turn.
function _releaseChatScrollPinForUser(el) {
  if (!el || !el._scrollPinActive) return false;
  _setChatScrollOffset(false, el);
  _markStickyPausedByUser(el);
  return true;
}
function _hasMovedAwayFromChatScrollPin(el, threshold = 2) {
  if (!el || !el._scrollPinActive) return false;
  const target = Number(el._scrollPinTargetTop);
  if (!Number.isFinite(target)) return false;
  return Math.abs(Number(el.scrollTop || 0) - target) > threshold;
}
function _isStickyPausedByUser(el) {
  if (!el || !el._stickyUserPaused) return false;
  if (_isNearFollowTarget(el)) {
    el._stickyUserPaused = false;
    el._stickyEnabled = true;
    return false;
  }
  return true;
}
function _bindStickToBottom(el) {
  if (!el || el._stickyBound) return;
  el._stickyBound = true;
  if (el._stickyEnabled === undefined) el._stickyEnabled = true;
  el.addEventListener('wheel', (ev) => {
    const dy = Number(ev?.deltaY || 0);
    const releasedPin = dy !== 0 && _releaseChatScrollPinForUser(el);
    if (releasedPin || dy < 0 || (dy !== 0 && !_isNearFollowTarget(el))) {
      _markStickyPausedByUser(el);
    }
  }, { passive: true });
  el.addEventListener('touchmove', () => {
    const releasedPin = _releaseChatScrollPinForUser(el);
    if (releasedPin || !_isNearFollowTarget(el)) _markStickyPausedByUser(el);
  }, { passive: true });
  el.addEventListener('scroll', () => {
    // Wheel/touch listeners cover direct gestures, but scrollbar dragging,
    // keyboard scrolling, accessibility controls, and momentum scrolling can
    // reach us as a bare `scroll` event. Track the send-time pin's exact
    // target so those paths release the artificial spacer as soon as the
    // viewport actually moves. A scroll event that lands on the target is
    // the delayed result of our own pin assignment and must remain inert.
    if (el._scrollPinActive) {
      if (!_hasMovedAwayFromChatScrollPin(el)) return;
      _releaseChatScrollPinForUser(el);
    }
    const nearBottom = _isNearFollowTarget(el);
    if (nearBottom) {
      el._stickyUserPaused = false;
      el._stickyEnabled = true;
      return;
    }
    if (!_isProgrammaticStickyScroll(el)) el._stickyUserPaused = true;
    el._stickyEnabled = nearBottom;
  }, { passive: true });
}

// Scroll the container to the bottom, but only if the user hasn't scrolled
// up. Safe to call after every DOM mutation that adds height — the no-op
// branch (sticky off) lets the user keep reading process info undisturbed.
//
// `scroll-behavior: smooth` is set on every chat history surface so the
// scrollbar drag / search-jump feels animated. Honouring that on a stream
// hot path queues overlapping ~300 ms animated scrolls per delta and the
// view visibly shakes; force `auto` for this programmatic stick so each
// call lands instantly without fighting the previous animation.
function _stickBottomIfPinned(el) {
  if (!el) return;
  if (el._scrollPinActive) {
    return;
  }
  if (el._stickyEnabled === false) return;
  if (_isStickyPausedByUser(el)) return;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(el);
  el.scrollTop = el.scrollHeight;
  if (prev) el.style.scrollBehavior = prev;
  else el.style.removeProperty('scroll-behavior');
}
// Convenience for stream handlers that hold a `msg` element. The container
// is whatever element the bubble lives in (chat-history for the main conv,
// or a skill/agent edit chat's messages box) — same generic stickiness
// applies to all of them.
function _stickBottomFromMsg(msg) {
  if (!msg) return;
  _stickBottomIfPinned(msg.parentElement);
}

// The process rail is its own 300px scroll surface, independent from the
// outer message list. Keep an explicit follow/pause state here instead of
// inferring user intent from geometry before every append. Geometry can move
// for non-user reasons (wrapping, icon hydration, an expanded tool result),
// and the old 10px snapshot treated those layout shifts as a manual scroll-up
// and permanently stopped following new process rows.
const PROCESS_STICKY_BOTTOM_THRESHOLD = 10;
function _markProcessStickyPausedByUser(el) {
  if (!el) return;
  el._processStickyUserPaused = true;
  el._processStickyEnabled = false;
}
function _resumeProcessStickyIfAtBottom(el) {
  if (!el || !_isNearBottom(el, PROCESS_STICKY_BOTTOM_THRESHOLD)) return false;
  el._processStickyUserPaused = false;
  el._processStickyEnabled = true;
  return true;
}
function _bindProcessStickToBottom(el) {
  if (!el || el._processStickyBound) return;
  el._processStickyBound = true;
  if (el._processStickyEnabled === undefined) {
    el._processStickyEnabled = _isNearBottom(el, PROCESS_STICKY_BOTTOM_THRESHOLD);
  }
  el.addEventListener('wheel', (ev) => {
    const dy = Number(ev?.deltaY || 0);
    if (dy < 0) {
      _markProcessStickyPausedByUser(el);
      return;
    }
    if (dy > 0) {
      // A downward gesture expresses follow intent, but only re-arm once it
      // has actually reached the bottom. The subsequent scroll event handles
      // the usual case; this also covers a wheel tick at an already-clamped
      // bottom edge where Chromium emits no scroll event.
      if (!_resumeProcessStickyIfAtBottom(el)) _markProcessStickyPausedByUser(el);
    }
  }, { passive: true });
  el.addEventListener('touchmove', () => {
    if (!_resumeProcessStickyIfAtBottom(el)) _markProcessStickyPausedByUser(el);
  }, { passive: true });
  el.addEventListener('scroll', () => {
    if (_resumeProcessStickyIfAtBottom(el)) return;
    // Bare scroll events cover scrollbar dragging, keyboard navigation and
    // accessibility controls. Ignore the event generated by our own jump.
    if (!_isProgrammaticStickyScroll(el)) _markProcessStickyPausedByUser(el);
  }, { passive: true });
}
function _stickProcessBottomIfPinned(el) {
  if (!el) return;
  _bindProcessStickToBottom(el);
  // A user gesture owns this state. Do not clear it merely because geometry
  // still says "bottom" before the browser applies the wheel/touch movement.
  // Only a later user scroll/touch/downward-wheel at the bottom may re-arm.
  if (el._processStickyUserPaused || el._processStickyEnabled === false) return;
  _markProgrammaticStickyScroll(el);
  el.scrollTop = el.scrollHeight;
}

if (typeof document !== 'undefined') {
  document.addEventListener('chat-image-settled', (event) => {
    const msg = event.target?.closest?.('.chat-message');
    if (msg) _stickBottomFromMsg(msg);
  });
}

function _streamMathSignatureForText(text) {
  const src = String(text || '');
  if (!src || (src.indexOf('$') < 0 && src.indexOf('\\') < 0)) return '';
  const scrubbed = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const formulas = [];
  const collect = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scrubbed)) !== null) formulas.push(m[0]);
  };
  collect(/\$\$[\s\S]+?\$\$/g);
  collect(/\\\[[\s\S]+?\\\]/g);
  collect(/\\\([\s\S]+?\\\)/g);
  collect(/(^|[^\\$])\$(?!\s|\d)[^\$\n]+?\$(?!\d)/g);
  return formulas.join('\n\x1e\n');
}

const STREAMING_MATH_RENDER_DEFER_MS = 40;

function _streamingMarkdownBodyHtml(display) {
  return `<div class="markdown-body">${_renderMessageMarkdown(display)}</div>`;
}

function _streamingStableMediaKey(kind, src) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedSrc = String(src || '').trim();
  if (!normalizedKind || !normalizedSrc) return '';
  return `${normalizedKind}\x1f${normalizedSrc}`;
}

const _STREAMING_MANAGED_MEDIA_SELECTOR = '.chat-md-img-shell, .chat-md-video-shell, .chat-md-audio-card, .chat-md-html-embed';

function _streamingStandaloneMediaKind(node) {
  const tag = String(node?.tagName || '').toLowerCase();
  if (tag === 'img') return 'image-node';
  if (tag === 'video') return 'video-node';
  if (tag === 'audio') return 'audio-node';
  return '';
}

function _streamingIsManagedMediaChild(node) {
  return !!(node && typeof node.closest === 'function' && node.closest(_STREAMING_MANAGED_MEDIA_SELECTOR));
}

function _streamingCollectStableMedia(root) {
  const stable = new Map();
  if (!root || typeof root.querySelectorAll !== 'function') return stable;
  const add = (kind, src, node) => {
    const key = _streamingStableMediaKey(kind, src);
    if (!key || !node) return;
    const list = stable.get(key) || [];
    list.push(node);
    stable.set(key, list);
  };
  root.querySelectorAll('.chat-md-img-shell').forEach((shell) => {
    const image = shell && shell.querySelector ? shell.querySelector('img.chat-md-img[src]') : null;
    add('image', image && image.getAttribute ? image.getAttribute('src') : '', shell);
  });
  root.querySelectorAll('.chat-md-video-shell').forEach((shell) => {
    const video = shell && shell.querySelector ? shell.querySelector('video.chat-md-video[src]') : null;
    add('video', video && video.getAttribute ? video.getAttribute('src') : '', shell);
  });
  root.querySelectorAll('.chat-md-audio-card').forEach((card) => {
    const audio = card && card.querySelector ? card.querySelector('audio.chat-md-audio[src]') : null;
    add('audio', audio && audio.getAttribute ? audio.getAttribute('src') : '', card);
  });
  root.querySelectorAll('.chat-md-html-embed').forEach((host) => {
    add('html', host && host.getAttribute ? host.getAttribute('data-html-src') : '', host);
  });
  // Dashboard Image nodes and sanitized raw HTML media do not use the
  // markdown media shells above. Preserve them directly so a stream repaint
  // cannot restart image decoding or reset native audio/video playback.
  root.querySelectorAll('img[src], video[src], audio[src]').forEach((media) => {
    if (_streamingIsManagedMediaChild(media)) return;
    const kind = _streamingStandaloneMediaKind(media);
    add(kind, media && media.getAttribute ? media.getAttribute('src') : '', media);
  });
  return stable;
}

function _streamingCopyElementAttributes(target, source) {
  if (!target || !source || !target.attributes || !source.attributes) return;
  const keep = new Set();
  Array.from(source.attributes).forEach((attr) => {
    keep.add(attr.name);
    if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
  });
  Array.from(target.attributes).forEach((attr) => {
    if (!keep.has(attr.name)) target.removeAttribute(attr.name);
  });
}

function _streamingSyncStableMediaNode(existing, fresh) {
  if (!existing || !fresh) return existing;
  _streamingCopyElementAttributes(existing, fresh);
  const existingMedia = existing.querySelector
    ? existing.querySelector('video.chat-md-video[src], audio.chat-md-audio[src]')
    : null;
  const freshMedia = fresh.querySelector
    ? fresh.querySelector('video.chat-md-video[src], audio.chat-md-audio[src]')
    : null;
  if (existingMedia && freshMedia) _streamingCopyElementAttributes(existingMedia, freshMedia);

  const existingOpen = existing.querySelector
    ? existing.querySelector('[data-chat-md-video-open="1"]')
    : null;
  const freshOpen = fresh.querySelector
    ? fresh.querySelector('[data-chat-md-video-open="1"]')
    : null;
  if (existingOpen && freshOpen) _streamingCopyElementAttributes(existingOpen, freshOpen);
  else if (!existingOpen && freshOpen && existing.appendChild) existing.appendChild(freshOpen);
  else if (existingOpen && !freshOpen && existingOpen.remove) existingOpen.remove();
  return existing;
}

function _streamingSyncStableImageNode(existing, fresh) {
  if (!existing || !fresh) return existing;
  const existingImage = existing.querySelector
    ? existing.querySelector('img.chat-md-img[src]')
    : null;
  const freshImage = fresh.querySelector
    ? fresh.querySelector('img.chat-md-img[src]')
    : null;
  if (existingImage && freshImage) _streamingCopyElementAttributes(existingImage, freshImage);
  // The existing shell owns the real image request and its settled state.
  // Copying the fresh shell would reset a decoded image back to `is-loading`;
  // because the reused <img> does not load twice, it would then stay hidden.
  return existing;
}

function _streamingRestoreStableMedia(nextRoot, stable) {
  if (!nextRoot || !stable || !stable.size || typeof nextRoot.querySelectorAll !== 'function') return;
  nextRoot.querySelectorAll('.chat-md-img-shell').forEach((freshShell) => {
    const image = freshShell && freshShell.querySelector ? freshShell.querySelector('img.chat-md-img[src]') : null;
    const key = _streamingStableMediaKey('image', image && image.getAttribute ? image.getAttribute('src') : '');
    const reusable = key ? stable.get(key) : null;
    const existing = reusable && reusable.shift ? reusable.shift() : null;
    if (existing && freshShell.replaceWith) freshShell.replaceWith(_streamingSyncStableImageNode(existing, freshShell));
  });
  nextRoot.querySelectorAll('.chat-md-video-shell').forEach((freshShell) => {
    const video = freshShell && freshShell.querySelector ? freshShell.querySelector('video.chat-md-video[src]') : null;
    const key = _streamingStableMediaKey('video', video && video.getAttribute ? video.getAttribute('src') : '');
    const reusable = key ? stable.get(key) : null;
    const existing = reusable && reusable.shift ? reusable.shift() : null;
    if (existing && freshShell.replaceWith) freshShell.replaceWith(_streamingSyncStableMediaNode(existing, freshShell));
  });
  nextRoot.querySelectorAll('.chat-md-audio-card').forEach((freshCard) => {
    const audio = freshCard && freshCard.querySelector ? freshCard.querySelector('audio.chat-md-audio[src]') : null;
    const key = _streamingStableMediaKey('audio', audio && audio.getAttribute ? audio.getAttribute('src') : '');
    const reusable = key ? stable.get(key) : null;
    const existing = reusable && reusable.shift ? reusable.shift() : null;
    if (existing && freshCard.replaceWith) freshCard.replaceWith(_streamingSyncStableMediaNode(existing, freshCard));
  });
  nextRoot.querySelectorAll('.chat-md-html-embed').forEach((freshHost) => {
    const src = freshHost && freshHost.getAttribute ? freshHost.getAttribute('data-html-src') : '';
    const key = _streamingStableMediaKey('html', src);
    const reusable = key ? stable.get(key) : null;
    const existing = reusable && reusable.shift ? reusable.shift() : null;
    // Preserve the live iframe and its scroll/state. A fresh mount point has
    // no user-visible state worth copying over the hydrated host.
    if (existing && freshHost.replaceWith) freshHost.replaceWith(existing);
  });
  nextRoot.querySelectorAll('img[src], video[src], audio[src]').forEach((freshMedia) => {
    if (_streamingIsManagedMediaChild(freshMedia)) return;
    const kind = _streamingStandaloneMediaKind(freshMedia);
    const src = freshMedia && freshMedia.getAttribute ? freshMedia.getAttribute('src') : '';
    const key = _streamingStableMediaKey(kind, src);
    const reusable = key ? stable.get(key) : null;
    const existing = reusable && reusable.shift ? reusable.shift() : null;
    if (!existing || !freshMedia.replaceWith) return;
    _streamingCopyElementAttributes(existing, freshMedia);
    freshMedia.replaceWith(existing);
  });
}

function _setStreamingFinalHtml(finalEl, html) {
  if (!finalEl) return;
  if (
    typeof document === 'undefined'
    || !document.createElement
    || typeof finalEl.querySelectorAll !== 'function'
    || typeof finalEl.replaceChildren !== 'function'
  ) {
    finalEl.innerHTML = html;
    if (typeof _hydrateMarkdownHtmlEmbeds === 'function') _hydrateMarkdownHtmlEmbeds(finalEl);
    return;
  }
  const stable = _streamingCollectStableMedia(finalEl);
  if (!stable.size) {
    finalEl.innerHTML = html;
    if (typeof _hydrateMarkdownHtmlEmbeds === 'function') _hydrateMarkdownHtmlEmbeds(finalEl);
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  _streamingRestoreStableMedia(tmp, stable);
  finalEl.replaceChildren(...Array.from(tmp.childNodes));
  if (typeof _hydrateMarkdownHtmlEmbeds === 'function') _hydrateMarkdownHtmlEmbeds(finalEl);
}

function _invalidateStreamingMathPaint(msg) {
  if (!msg) return;
  if (msg._streamMathTimer) {
    clearTimeout(msg._streamMathTimer);
    msg._streamMathTimer = null;
  }
  msg._streamMathLatestPaint = null;
  msg._streamMathPaintToken = (msg._streamMathPaintToken || 0) + 1;
}

function _scheduleStreamingMathPaint(msg) {
  if (!msg || msg._streamMathTimer || msg._streamMathPaintBusy) return;
  msg._streamMathTimer = setTimeout(() => {
    msg._streamMathTimer = null;
    _flushStreamingMathPaint(msg);
  }, STREAMING_MATH_RENDER_DEFER_MS);
}

async function _flushStreamingMathPaint(msg) {
  const job = msg?._streamMathLatestPaint;
  if (!msg || !job || !job.finalEl) return;
  msg._streamMathPaintBusy = true;
  let rendered = job.html;
  try {
    rendered = await typesetMathHtml(job.html);
  } catch (_) {
    rendered = job.html;
  } finally {
    msg._streamMathPaintBusy = false;
  }

  const latest = msg._streamMathLatestPaint;
  if (
    latest
    && latest.token === job.token
    && latest.finalEl === job.finalEl
    && job.finalEl.isConnected !== false
  ) {
    _setStreamingFinalHtml(job.finalEl, rendered);
    msg.dataset.streamPaintedDisplay = job.display;
    msg._streamMathLatestPaint = null;
    if (job.stickBottom) _stickBottomFromMsg(msg);
    return;
  }

  if (msg._streamMathLatestPaint) _scheduleStreamingMathPaint(msg);
}

function _paintStreamingFinalMarkdown(msg, finalEl, display, { stickBottom = false } = {}) {
  if (!msg || !finalEl) return;
  const html = _streamingMarkdownBodyHtml(display);
  const sig = _streamMathSignatureForText(display);
  if (!sig || typeof typesetMathHtml !== 'function') {
    _invalidateStreamingMathPaint(msg);
    _setStreamingFinalHtml(finalEl, html);
    msg.dataset.streamPaintedDisplay = display;
    if (sig && typeof typesetMath === 'function') typesetMath(finalEl);
    if (stickBottom) _stickBottomFromMsg(msg);
    return;
  }

  const token = (msg._streamMathPaintToken || 0) + 1;
  msg._streamMathPaintToken = token;
  msg._streamMathLatestPaint = { token, finalEl, display, html, stickBottom };
  _scheduleStreamingMathPaint(msg);
}

// Tab visibility: while the renderer is hidden, scroll events don't fire
// and stream content piles up below the fold. On return, if the user was
// pinned to the bottom before going hidden, jump to the latest content so
// the conversation tracks live again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Cover every chat history surface (main conv + skill/agent edit chats).
    const ids = ['chat-history', 'skills-chat-messages', 'agents-chat-messages'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el._stickyEnabled !== false) _stickBottomIfPinned(el);
    }
  });
}

function appendChatMessage(message, autoScroll = true, opts = {}) {
  const container = opts.container
    ? (typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container)
    : document.getElementById('chat-history');
  if (!container) return null;
  const archive = opts.archive !== false;   // default on for backwards compat
  const historyHydration = opts.historyHydration === true;

  // Dedupe by `_msg_id`: when the user switches conv tabs during a
  // streaming turn, the same persisted message can reach the renderer
  // twice — once via `loadConversationHistory` reading jsonl on
  // switch-back, once via the trailing group-bus `message` event whose
  // cid-mismatch guard had dropped its DOM update on the way out and
  // now arrives after `currentCid` has flipped back. Without this
  // guard, the second arrival's fallback `appendChatMessage` (used
  // when the stale per-actor placeholder no longer has a
  // `parentElement`) prints a duplicate bubble below the history-painted
  // one. Idempotent re-render is the right contract — return the
  // existing node so callers that want to mutate it (chip mounting /
  // dataset writes) still find the right target.
  if (!historyHydration && message && message._msg_id) {
    const existing = container.querySelector(
      `.chat-message[data-msg-id="${CSS.escape(String(message._msg_id))}"]`,
    );
    if (existing) {
      _syncRenderedGroupMessageIdentity(existing, message);
      return existing;
    }
  }
  if (!historyHydration) {
    const existingByKey = _findRenderedGroupMessage(container, message);
    if (existingByKey) {
      _syncRenderedGroupMessageIdentity(existingByKey, message);
      return existingByKey;
    }
  }

  const emptyEl = container.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}`;
  // Sender id stamp — used by `_ensureConvCreateAgentInline` to detect
  // whether any agent (≠ user / commander) has spoken in this conversation.
  // Empty when unknown (e.g. stale records lacking _from); the inline button
  // treats unknown as "not an agent" to avoid hiding by mistake.
  if (message._from) msgDiv.dataset.from = String(message._from);

  const rawContent = message.content || '';
  const isHtmlSnippet = typeof rawContent === 'string' && rawContent.startsWith('<');
  // User messages strip structural tags and transport-only commander routing
  // mentions for display. Keep `rawContent` untouched for retry and delivery.
  // Assistant messages get a defensive structural-block strip covering
  // `<agent>` / `<agent-input-form>` / `<agent-input-submission>` in case the
  // backend's extractor missed a format variant (see
  // `_stripSurvivingStructuralBlocks` in strip-structural-blocks.js).
  let displayContent = rawContent;
  if (!isHtmlSnippet) {
    if (role === 'user') {
      displayContent = _stripCommanderRoutingMentionsForDisplay(
        _stripUserStructuralBlocksForDisplay(rawContent),
      );
    }
    else if (role === 'assistant') displayContent = _stripSurvivingStructuralBlocks(rawContent);
  }
  const contentHtml = isHtmlSnippet
    ? sanitizeHtml(rawContent)
    : `<div class="markdown-body">${_renderMessageMarkdown(displayContent)}</div>`;

  const messageCid = opts.cid || currentCid;
  const attachmentCid = message.attachment_cid || message.attachments_cid || messageCid;
  const attachmentsHtml = (role === 'user' && Array.isArray(message.attachments) && message.attachments.length)
    ? _renderMessageAttachmentsHtml(message.attachments, attachmentCid)
    : '';
  const producedPaths = (role === 'assistant' && Array.isArray(message.produced) && message.produced.length)
    ? message.produced
    : null;
  const referencesHtml = (role === 'user' && Array.isArray(message.references) && message.references.length)
    ? _renderMessageReferencesHtml(message.references, messageCid)
    : '';
  const failedAssistant = role === 'assistant' && _isFailedAssistantContent(rawContent, message);
  const interruptedAssistant = role === 'assistant' && _isInterruptedAssistantMessage(message);
  const createdAgentsList = role === 'assistant' ? _normalizeCreatedAgents(message) : null;
  const createdAgentHtml = createdAgentsList
    ? _renderMessageCreatedAgentHtml(createdAgentsList)
    : '';
  const createdSkillsList = role === 'assistant' ? _normalizeCreatedSkills(message) : null;
  const createdSkillHtml = createdSkillsList
    ? _renderMessageCreatedSkillHtml(createdSkillsList)
    : '';
  // Group-chat header sits **above** the bubble, outside it: sender name +
  // timestamp on one row. Same DOM strip for historical (loaded via
  // getMessages) and live-streamed messages so users always see "who said
  // what when" at the same place. User messages drop the sender chip
  // (it's their own bubble) and right-align the time to match the
  // right-aligned bubble below.
  // Always go through _groupActorLabel for non-user messages so we never
  // accidentally render the raw agent_id. _from_label was eagerly computed
  // at translate time but the cache may have been empty then; recompute.
  const headerName = role === 'user'
    ? ''
    : _groupActorLabel(message._from || (message._from_label ? '' : ''))
      || message._from_label
      || (t('chat.from_agent_unknown'));
  const headerActorId = role === 'user' ? '' : String(message._from || '');
  const avatarHtml = role === 'user' ? '' : _renderActorAvatarHtml(headerActorId);
  const headerHtml = role === 'user'
    ? `<div class="chat-msg-header chat-msg-header-user"><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`
    : `<div class="chat-msg-header">${avatarHtml}<span class="chat-msg-from${_isActorDetailTarget(headerActorId) ? ' is-agent-link' : ''}"${_actorLinkAttrs(headerActorId)}>${escapeHtml(headerName)}</span><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`;
  const planAnnHtml = message._plan_announcement
    ? `<div class="chat-plan-announce">${_uiIconHtml('clipboard-list', 'ui-icon chat-plan-announce-icon')}<span>${escapeHtml(t('chat.plan_announce'))}</span></div>` : '';
  // Deliverables mount last inside the bubble as a footer strip. The separate
  // action row remains for created-agent/skill links and message actions.
  msgDiv.innerHTML = `
    ${headerHtml}
    <div class="chat-bubble">${planAnnHtml}${referencesHtml}${contentHtml}${attachmentsHtml}</div>
    <div class="chat-msg-actions" data-role="msg-actions">${createdAgentHtml}${createdSkillHtml}</div>
  `;
  if (typeof opts.msgIndex === 'number') msgDiv.dataset.msgIndex = String(opts.msgIndex);
  if (message._msg_id) msgDiv.dataset.msgId = String(message._msg_id);
  if (message._render_key) msgDiv.dataset.renderKey = String(message._render_key);
  if (message._client_msg_id) msgDiv.dataset.clientMsgId = String(message._client_msg_id);
  if (message._from) msgDiv.dataset.fromActor = String(message._from);
  if (message._turn_id) msgDiv.dataset.turnId = String(message._turn_id);
  if (message._system_kind) msgDiv.dataset.systemKind = String(message._system_kind);
  if (message.failure_kind) msgDiv.dataset.failureKind = String(message.failure_kind);
  if (message.failure_code) msgDiv.dataset.failureCode = String(message.failure_code);
  msgDiv.dataset.ts = String(_msTs(message.time));
  if (role === 'user') {
    msgDiv.dataset.retryContent = String(rawContent || '');
    if (Array.isArray(message.attachments) && message.attachments.length) {
      msgDiv.dataset.retryAttachments = JSON.stringify(message.attachments);
    }
    if (typeof message.attachment_cid === 'string' && message.attachment_cid) {
      msgDiv.dataset.retryAttachmentCid = message.attachment_cid;
    }
    if (typeof message.model_text === 'string' && message.model_text) {
      msgDiv.dataset.retryModelText = message.model_text;
    }
  }
  if (opts.messageActions === 'errors-only') msgDiv.dataset.messageActions = 'errors-only';
  if (typeof opts.failedRetryHandler === 'function') msgDiv._failedRetryHandler = opts.failedRetryHandler;
  if (Object.prototype.hasOwnProperty.call(opts, 'feedbackConversationId')) {
    msgDiv.dataset.feedbackConversationId = String(opts.feedbackConversationId || '');
  }
  if (failedAssistant) msgDiv.dataset.failed = '1';
  if (interruptedAssistant) msgDiv.dataset.interrupted = '1';
  // Stash chip-tracked produced paths on the DOM so the 引用 handler can
  // attach them to the quote payload without plumbing message into every
  // _attachBubbleArchiveBtn call site. Only chip-tracked files belong here
  // (write_file / edit_file / markdown_to_pdf / html_to_pdf / generate_image);
  // bash scratch is intentionally outside this set.
  if (Array.isArray(message.produced) && message.produced.length) {
    msgDiv.dataset.produced = JSON.stringify(message.produced);
  }
  if (Array.isArray(message.attachments) && message.attachments.length) {
    msgDiv.dataset.attachments = JSON.stringify(message.attachments);
  }
  if (Array.isArray(message.references) && message.references.length) {
    msgDiv.dataset.referenceCount = String(message.references.length);
    msgDiv.dataset.references = JSON.stringify(message.references.slice(0, 20));
  }
  if (historyHydration) container.appendChild(msgDiv);
  else _insertByTimestamp(container, msgDiv);
  if (role === 'user') _moveUserBeforeOrphanLivePlaceholder(container, msgDiv);
  if (!isHtmlSnippet && typeof _hydrateMarkdownHtmlEmbeds === 'function') {
    _hydrateMarkdownHtmlEmbeds(msgDiv);
  }
  if (!isHtmlSnippet && typeof typesetMath === 'function') {
    const md = msgDiv.querySelector('.markdown-body');
    if (md) typesetMath(md);
  }
  if (attachmentsHtml) _hydrateMessageAttachmentThumbs(msgDiv, attachmentCid);
  if (referencesHtml) _hydrateMessageReferenceFiles(msgDiv);
  _hydrateActorHeaderLinks(msgDiv);
  if (createdAgentHtml) _hydrateMessageCreatedAgentChip(msgDiv);
  if (createdSkillHtml) _hydrateMessageCreatedSkillChip(msgDiv);
  // Interactive input-form widget (assistant messages only). Appended inside
  // the bubble after markdown + chips so it reads as "reply text → confirm
  // this form". See chat-input-form.js for the widget implementation.
  if (role === 'assistant' && message.form && typeof window.renderChatInputForm === 'function') {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) {
      const formHost = document.createElement('div');
      bubble.appendChild(formHost);
      _mountChatInputForm(formHost, msgDiv, message, opts);
    }
  }
  // Commander → user marketplace install confirmation cards. The model can
  // request approval, but only this human click path performs the install.
  if (role === 'assistant' && Array.isArray(message.marketplace_requests) && message.marketplace_requests.length) {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) _mountMarketplaceInstallRequests(bubble, msgDiv, message, opts);
  }
  // Interactive web-app artifacts (assistant messages only) — sandboxed
  // `<iframe>` over the `chat-app://` protocol, appended after the form so it
  // reads as "reply text → embedded app". See chat-artifact.js.
  if (role === 'assistant' && Array.isArray(message.artifacts) && message.artifacts.length
      && typeof window.mountMessageArtifacts === 'function') {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) window.mountMessageArtifacts(bubble, message.artifacts, opts.cid || currentCid);
  }
  if (producedPaths) _mountMessageProducedFooter(msgDiv, producedPaths);
  // Every assistant reply gets actions. Archive remains limited to final
  // raw-markdown replies; sanitized HTML status stubs are not archivable.
  if (role === 'assistant' && failedAssistant) {
    _attachFailedAssistantActions(msgDiv, () => _messageTextForActions(msgDiv, rawContent));
    // Live group-bus messages can arrive without a matching streaming
    // placeholder (fast preflight failures and reconnect races). History
    // hydration must stay silent, but a newly appended live failure still
    // needs the same billing guidance as the placeholder-finalization path.
  } else if (role === 'assistant' && interruptedAssistant) {
    _attachInterruptedAssistantActions(msgDiv, () => _messageTextForActions(msgDiv, rawContent), {
      archive: !isHtmlSnippet && archive,
    });
  } else if (role === 'assistant' && opts.messageActions !== 'errors-only') {
    _attachAssistantActions(msgDiv, () => _messageTextForActions(msgDiv, rawContent), {
      archive: !isHtmlSnippet && archive,
    });
  } else if (role === 'user' && opts.messageActions !== 'errors-only') {
    _attachBubbleActions(msgDiv, () => (
      _textFromBubbleWithout(
        msgDiv,
        '.chat-reference-bundle, .chat-msg-attachments, .chat-input-form, .chat-artifacts, iframe',
      ) || String(displayContent || '')
    ), { archive: false });
  }
  // Persisted-process trail is independent of body type — it must render
  // for HTML-stub bodies too (e.g. CLI warning spans),
  // otherwise after a refresh the only visible signal of a failed run is
  // the red error line and "what happened" is gone. Auto-expand for any
  // empty / abort-stub / HTML-stub body so the rail IS the content.
  if (role === 'assistant' && Array.isArray(message.process) && message.process.length) {
    const bodyText = String(displayContent || '').trim();
    // Match both possible forms — jsonl history can carry either depending
    // on the UI language at the time of write (i18n key `model.aborted` →
    // '(stopped)' in en, '（已中断）' in zh).
    const isAbortStub = bodyText === '（已中断）' || bodyText === '(stopped)' || bodyText === '';
    const expanded = isAbortStub || isHtmlSnippet;
    _renderPersistedProcess(msgDiv, message.process, { expanded });
  }

  if (autoScroll) {
    // Respect the user's scroll position: only follow if they were already
    // pinned to the bottom (sticky on). This preserves the legacy "new
    // message arrives → snap to bottom" behaviour for users who were
    // following, without yanking users who scrolled up to read older
    // process info. _bindStickToBottom is a no-op after first bind.
    _bindStickToBottom(container);
    _stickBottomIfPinned(container);
  }
  if (role === 'assistant' && autoScroll !== false) {
    _scheduleConversationInfoFileRefresh(opts.cid || currentCid);
  }
  if (!historyHydration && _messageSelectionState?.cid === currentCid) _syncMessageSelectionUi();
  return msgDiv;
}

// Newest-form-wins registry: `${cid}::${agent_id}` → the currently
// interactive form mount. An agent's review protocol keeps at most one live
// decision open, so when it emits a newer form, every older unsubmitted form
// from that agent is a dead affordance — the backend rejects its values
// against the current artifact — and must render stale instead of clickable.
// Computed at mount time, so a full render, a live append, and pagination of
// older history all converge on the same rule without any persisted flag.
const _agentFormMounts = new Map();

// Pure decision for one form mount against the agent's current registry
// entry. `next`: { formId, ts, submitted }. Returns how this mount renders
// and whether the previously registered mount must flip to stale.
function _resolveAgentFormMount(existing, next) {
  if (next.submitted) return { stale: false, becomesActive: false, flipPrevious: false };
  if (existing && existing.formId !== next.formId && existing.ts > next.ts) {
    // An older unsubmitted form arriving after a newer one (history
    // pagination) mounts already-stale and never steals the live slot.
    return { stale: true, becomesActive: false, flipPrevious: false };
  }
  return {
    stale: false,
    becomesActive: true,
    flipPrevious: !!(existing && existing.formId !== next.formId),
  };
}

// Mount the input-form widget into a bubble. Wires the widget's submit
// callback to (a) flag the assistant form as submitted server-side and
// (b) fire the composed user message through the normal send-stream pipeline.
// That IPC handler subscribes to the group bus before enqueuing the user
// message, so form-driven plan handoffs use the same event path as normal
// sends instead of a second observer stream.
function _mountChatInputForm(host, msgDiv, message, opts) {
  const cid = opts.cid || currentCid;
  if (!cid) return;
  const form = message.form || {};
  const agentKey = form.agent_id ? `${cid}::${form.agent_id}` : '';
  const mountTs = Date.parse(message.ts || '') || Date.now();
  const existingMount = agentKey ? _agentFormMounts.get(agentKey) : null;
  const decision = _resolveAgentFormMount(existingMount, {
    formId: form.form_id || '',
    ts: mountTs,
    submitted: !!form.submitted,
  });
  if (decision.flipPrevious && existingMount && existingMount.el && existingMount.el.isConnected) {
    existingMount.el.innerHTML = '';
    window.renderChatInputForm(existingMount.el, existingMount.message, {
      stale: true,
      cid,
    });
  }
  if (agentKey) {
    if (decision.becomesActive) {
      _agentFormMounts.set(agentKey, {
        el: host, message, formId: form.form_id || '', ts: mountTs,
      });
    } else if (form.submitted && existingMount && existingMount.formId === form.form_id) {
      // The live form just re-rendered as submitted — nothing is pending.
      _agentFormMounts.delete(agentKey);
    }
  }
  window.renderChatInputForm(host, message, {
    readonly: !!(message.form && message.form.submitted),
    stale: decision.stale,
    cid,
    onSubmit: async (_encodedText, values, attachments) => {
      // Group chat form submit is a TWO-STEP operation:
      //   1. POST `form-submitted` → backend marks the form submitted on
      //      both the main jsonl and the agent's visibility slice. Returns
      //      the encoded submission text + recipient agent_id so the
      //      renderer doesn't have to re-encode (XML format must match
      //      bus's submission decoder exactly).
      //   2. Send the returned text through `/send/stream`. The main-process
      //      stream handler subscribes before calling send(), and send()
      //      includes the user-step plan reconcile, so the downstream agent
      //      dispatch cannot race past the UI listener.
      const msgId = msgDiv.dataset.msgId || (message._msg_id || '');
      if (!msgId) {
        _convLog.warn('form submit missing msgId');
        return;
      }
      let submissionText = null;
      try {
        const res = await apiFetch(`/api/conversations/${cid}/form-submitted`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgId, formId: message.form.form_id, values }),
        });
        const data = await res.json();
        if (!data || data.ok === false) {
          _convLog.warn('markFormSubmitted failed', data && data.error);
          return;
        }
        submissionText = data.submission && data.submission.text;
      } catch (err) {
        _convLog.warn('markFormSubmitted threw', err && err.message ? err.message : err);
        return;
      }
      // The record is now `form.submitted` on disk. Reflect that on the mounted
      // widget directly: the transcript is no longer rebuilt after every stream
      // to discover such changes, and re-reading the whole history to flip one
      // class is the reconcile pass this pipeline deliberately removed.
      const formHost = msgDiv.querySelector('.chat-input-form');
      if (formHost) formHost.classList.add('is-submitted');
      if (!submissionText) return;
      const extra = (Array.isArray(attachments) && attachments.length)
        ? { attachments }
        : undefined;
      try { await sendInConversation(cid, submissionText, extra); }
      catch (err) { _convLog.error('form replay send failed', err); }
    },
  });
}

function _marketplaceRequestKindLabel(kind) {
  return kind === 'skill' ? t('marketplace_request.kind_skill') : t('marketplace_request.kind_agent');
}

function _marketplaceInstallFailedText(kind, name, reason) {
  const kindLabel = _marketplaceRequestKindLabel(kind);
  const displayName = name || '';
  const text = String(reason || '');
  if (displayName && text.includes(displayName) && text.includes(kindLabel)) {
    return t('marketplace.install_failed').replace('{reason}', text);
  }
  const tmpl = t('marketplace.install_failed_resource');
  if (tmpl && tmpl !== 'marketplace.install_failed_resource') {
    return tmpl
      .replace('{kind}', kindLabel)
      .replace('{name}', displayName)
      .replace('{reason}', text);
  }
  return t('marketplace.install_failed').replace('{reason}', `${kindLabel}: ${displayName}: ${text}`);
}

function _marketplaceInstallRequestErrorCode(installError, fallback = 'install_request_failed') {
  const reason = String(installError?.reason || '').trim().toLowerCase();
  if (reason === 'account_changed') return 'account_changed';
  if (reason.includes('not_found')) return 'not_found';
  if (reason.startsWith('status_not_approved')) return 'status_not_approved';
  if (reason.includes('requires orkas')) return 'app_update_required';
  if (reason.includes('quality')) return 'quality_rejected';
  if (/timeout|timed out/.test(reason)) return 'timeout';
  if (/network|fetch|econn|enet|eai_again|socket/.test(reason)) return 'network_failed';
  return fallback;
}

function _marketplaceInstallRequestErrorType(errorCode) {
  const code = String(errorCode || '');
  if (code === 'timeout') return 'timeout';
  if (code === 'network_failed') return 'network';
  if (code === 'account_changed') return 'auth';
  if (/^(?:status_not_approved|app_update_required|quality_rejected|user_skipped)$/.test(code)) {
    return 'validation';
  }
  return 'runtime';
}

function _marketplaceTrackInstallRequestResult(startedAt, req, result, errorCode = '') {
  const safeResult = /^(?:success|failure|cancelled)$/.test(result) ? result : 'failure';
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(String(errorCode || ''))
    ? String(errorCode)
    : 'install_request_failed';
  const payload = {
    result: safeResult,
    action: 'install',
    resource_kind: req?.kind === 'skill' ? 'skill' : 'agent',
    surface: 'conversation',
    duration_ms: Math.max(0, Date.now() - startedAt),
  };
  if (safeResult !== 'success') {
    payload.error_type = _marketplaceInstallRequestErrorType(safeCode);
    payload.error_code = safeCode;
  }
  _convTrackEvent('marketplace_action_result', payload);
}

function _marketplaceRequestStatusLabel(status) {
  if (status === 'installed') return t('marketplace_request.status_installed');
  if (status === 'skipped') return t('marketplace_request.status_skipped');
  if (status === 'failed') return t('marketplace_request.status_failed');
  return t('marketplace_request.status_pending');
}

function _marketplaceRequestAgentAvatarHtml(req) {
  return renderAvatarHtml(req.icon || '', req.color || '', {
    size: 32,
    seed: req.id || req.name || 'marketplace-agent',
    extraClass: 'marketplace-card-avatar chat-marketplace-request-avatar',
    dataAttrs: { 'mp-avatar-slot': '1' },
  });
}

const _MARKETPLACE_REQUEST_CATEGORY_LABELS = {
  education: { zh: '教育', en: 'Education', ja: '教育' },
  ecommerce: { zh: '电商', en: 'E-commerce', ja: 'EC' },
  rnd: { zh: '产研', en: 'R&D', ja: '研究開発' },
  creation: { zh: '创作', en: 'Creation', ja: '創作' },
  writing: { zh: '创作', en: 'Creation', ja: '創作' },
  data: { zh: '数据', en: 'Data', ja: 'データ' },
  general: { zh: '通用', en: 'General', ja: '汎用' },
};

function _marketplaceRequestCategoryLabel(code, lang) {
  if (!code) return '';
  const row = _MARKETPLACE_REQUEST_CATEGORY_LABELS[String(code)] || null;
  if (!row) return String(code);
  const base = _baseLang(lang);
  return row[base] || row.en;
}

async function _hydrateMarketplaceRequestMeta(card, req, cid, msgId) {
  if (!card || !req) return;
  const hasAvatar = req.kind !== 'agent' || req.icon || req.color;
  const hasCardMeta = req.description_zh || req.description_en || req.category;
  if (hasAvatar && hasCardMeta) return;
  try {
    const q = req.name || req.id || '';
    const channel = req.kind === 'skill' ? 'marketplace.listSkills' : 'marketplace.listAgents';
    const res = await window.orkas.invoke(channel, { q, size: 20 });
    const row = (res?.list || []).find((x) => x && x.id === req.id);
    if (!row) return;
    req.icon = row.icon || '';
    req.color = row.color || '';
    req.description_zh = row.description_zh || '';
    req.description_en = row.description_en || '';
    req.category = row.category || '';
    _renderMarketplaceInstallCard(card, req, cid, msgId);
  } catch (_) { /* fallback content is already rendered */ }
}

function _setMarketplaceCardBusy(card, busy) {
  if (!card) return;
  card.dataset.busy = busy ? '1' : '0';
  card.classList.toggle('is-busy', !!busy);
  card.querySelectorAll('button').forEach((btn) => { btn.disabled = !!busy; });
}

function _renderMarketplaceInstallCard(card, req, cid, msgId) {
  if (!card || !req) return;
  const status = req.status || 'pending';
  const kind = req.kind === 'skill' ? 'skill' : 'agent';
  card.className = `marketplace-card chat-marketplace-request is-${status}`;
  card.dataset.marketplaceRequestId = String(req.request_id || '');
  card.dataset.marketplaceKind = kind;
  const name = req.name || req.id || '';
  const kindLabel = _marketplaceRequestKindLabel(kind);
  const statusLabel = _marketplaceRequestStatusLabel(status);
  const version = req.version ? t('marketplace.version').replace('{version}', String(req.version)) : '';
  const lang = getLang();
  const descText = pickDesc(req, lang) || req.reason || '';
  const desc = descText ? `<div class="marketplace-card-desc">${escapeHtml(descText)}</div>` : '';
  const catLabel = _marketplaceRequestCategoryLabel(req.category, lang);
  const meta = [
    version ? `<span class="marketplace-card-chip is-version">${escapeHtml(version)}</span>` : '',
    catLabel ? `<span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>` : '',
  ].filter(Boolean).join('');
  const error = req.error ? `<div class="chat-marketplace-request-error">${escapeHtml(req.error)}</div>` : '';
  const iconHtml = kind === 'agent'
    ? _marketplaceRequestAgentAvatarHtml(req)
    : '';
  const actions = status === 'pending'
    ? `<div class="marketplace-card-actions chat-marketplace-request-actions">
        <button type="button" class="btn btn-primary btn-sm" data-mp-decision="install">${escapeHtml(t('marketplace_request.install'))}</button>
        <button type="button" class="btn btn-sm" data-mp-decision="skip">${escapeHtml(t('marketplace_request.skip'))}</button>
      </div>`
    : `<div class="marketplace-card-actions chat-marketplace-request-actions">
        <span class="chat-marketplace-request-status">${escapeHtml(statusLabel)}</span>
      </div>`;
  card.innerHTML = `
    <div class="marketplace-card-header chat-marketplace-request-head">
      ${iconHtml}
      <div class="chat-marketplace-request-main">
        <div class="chat-marketplace-request-title-row">
          <span class="marketplace-card-name chat-marketplace-request-title">${escapeHtml(name)}</span>
          <span class="marketplace-card-chip chat-marketplace-request-kind">${escapeHtml(kindLabel)}</span>
        </div>
      </div>
    </div>
    ${desc}
    ${error}
    <div class="marketplace-card-footer chat-marketplace-request-footer">
      <div class="marketplace-card-meta">${meta}</div>
      ${actions}
    </div>
  `;

  const installBtn = card.querySelector('[data-mp-decision="install"]');
  const skipBtn = card.querySelector('[data-mp-decision="skip"]');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      _resolveMarketplaceInstallRequest(card, { ...req, kind }, cid, msgId, 'install');
    });
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      _resolveMarketplaceInstallRequest(card, { ...req, kind }, cid, msgId, 'skip');
    });
  }
  _hydrateMarketplaceRequestMeta(card, { ...req, kind }, cid, msgId);
}

function _mountMarketplaceInstallRequests(host, msgDiv, message, opts) {
  const cid = opts.cid || currentCid;
  if (!cid || !host || !message) return;
  const msgId = msgDiv.dataset.msgId || message._msg_id || '';
  if (!msgId) return;
  const requests = Array.isArray(message.marketplace_requests) ? message.marketplace_requests : [];
  for (const req of requests) {
    if (!req || !req.request_id) continue;
    const selector = `.chat-marketplace-request[data-marketplace-request-id="${CSS.escape(String(req.request_id))}"]`;
    if (host.querySelector(selector)) continue;
    const card = document.createElement('div');
    host.appendChild(card);
    _renderMarketplaceInstallCard(card, req, cid, msgId);
  }
}

async function _resolveMarketplaceInstallRequest(card, req, cid, msgId, decision) {
  if (!card || card.dataset.busy === '1') return;
  const startedAt = Date.now();
  let resultTracked = false;
  const trackResult = (result, errorCode = '') => {
    if (resultTracked) return;
    resultTracked = true;
    _marketplaceTrackInstallRequestResult(startedAt, req, result, errorCode);
  };
  _setMarketplaceCardBusy(card, true);
  const installBtn = card.querySelector('[data-mp-decision="install"]');
  if (decision === 'install' && installBtn) installBtn.textContent = t('marketplace.installing');
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/marketplace-install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgId, requestId: req.request_id, decision }),
    });
    const data = await res.json();
    if (!data || data.ok === false) {
      throw new Error((data && data.error) || 'marketplace install request failed');
    }
    const updated = data.request || { ...req, status: decision === 'install' ? 'installed' : 'skipped' };
    if (updated.status === 'installed') trackResult('success');
    else if (updated.status === 'skipped') trackResult('cancelled', 'user_skipped');
    else if (updated.status === 'failed') {
      trackResult('failure', _marketplaceInstallRequestErrorCode(data.install_error));
    } else {
      trackResult('failure', 'unknown_status');
    }
    _renderMarketplaceInstallCard(card, updated, cid, msgId);
    if (updated.status === 'installed') {
      if (updated.kind === 'agent') { try { loadAgents?.(true); } catch (_) {} }
      else if (typeof loadSkills === 'function') { try { loadSkills(true); } catch (_) {} }
    }
    const submissionText = data.submission && data.submission.text;
    if (submissionText) await sendInCurrentConversation(submissionText);
  } catch (err) {
    trackResult('failure', 'request_failed');
    _setMarketplaceCardBusy(card, false);
    const reason = (err && err.message) || String(err);
    _convLog.warn('marketplace install request failed', reason);
    try { await uiAlert(_marketplaceInstallFailedText(req.kind, req.name || req.id, reason)); } catch (_) {}
  } finally {
    if (!resultTracked) trackResult('failure', 'install_request_failed');
  }
}

// Insert a "process info" block above the assistant bubble content
// using the items we stored at stream time. Collapsed by default so
// old threads stay tidy; the user can click ▶ to expand. Exception:
// when the bubble's text body has no real reply (only the "(stopped)"
// abort placeholder or empty content for a turn that never produced
// final text), the process trail IS the content — auto-open it so
// refreshing doesn't appear to erase what the user already watched
// stream in (tool calls / progress lines).
function _renderPersistedProcess(msgDiv, items, { expanded = false } = {}) {
  const bubble = msgDiv.querySelector('.chat-bubble');
  if (!bubble) return;
  const runtimeText = _processSummaryRuntimeFromItems(items);
  const displayItems = _processItemsForDisplay(items);
  const details = document.createElement('details');
  details.className = 'stream-process';
  if (expanded) details.open = true;
  details.innerHTML = `
    <summary class="stream-process-summary">
      <span class="stream-process-caret" aria-hidden="true">${_uiIconHtml('chevron-right', 'ui-icon stream-process-caret-icon')}</span>
      <span class="stream-process-label">${escapeHtml(t('chat.process_info'))}</span>
      <span class="stream-process-runtime" hidden></span>
    </summary>
    <div class="stream-process-body"></div>
  `;
  const body = details.querySelector('.stream-process-body');
  const displayContext = _createProcessDisplayContext();
  _setProcessSummaryRuntime(details, runtimeText);
  for (const item of displayItems) {
    const itemEvent = item && item.type === 'event'
      ? item.event
      : (item && item.type === 'progress' ? item.event : null);
    const projection = _projectProcessRow(
      itemEvent,
      displayContext,
      item && item.type === 'progress' ? item.text : '',
    );
    if (!projection) continue;
    _appendProcessTextLines(
      body,
      projection.text,
      projection.kind,
      projection.eventName,
      projection.lifecycleKey,
      projection.lifecycleTerminal,
    );
  }
  if (body.childElementCount === 0 && !runtimeText) return;
  if (body.childElementCount === 0) details.classList.add('runtime-only');
  bubble.insertBefore(details, bubble.firstChild);
}

// ─── Quote-reply (per-cid) ───────────────────────────────────────────────
// Clicking quote on assistant bubbles appends their text + chip-tracked
// produced files to a per-cid collection. The collection renders above the
// textarea, supports per-item removal, and is persisted with the destination
// task's draft. On send it travels as structured `references`; the legacy
// markdown serializer remains below only for old queued/tested draft shapes.
// Routing reuses the existing recipient picker — quote does NOT change the
// recipient.
//
// Why dataset-driven: produced[] sits on the message object during render but
// the bubble action row only sees `msgDiv` + a getContent closure. Putting
// produced on `msgDiv.dataset.produced` (set in appendChatMessage and the
// stream-finalize path) lets the quote handler stay zero-arg without
// plumbing message into every _attachBubbleArchiveBtn call site.
//
// `_quotesByCid` itself is declared early (above `_recipientByCid`'s neighbour
// block) so the DOMContentLoaded init can call _renderQuotePreview before
// this section evaluates without hitting a TDZ.

function _quoteIdentity(payload) {
  if (!payload) return '';
  const msgId = String(payload.msgId || '');
  const sourceCid = String(payload.sourceCid || '');
  if (msgId) return `id:${sourceCid}:${msgId}`;
  return `content:${String(payload.fromActor || '')}\n${String(payload.text || '')}\n${JSON.stringify(payload.produced || [])}`;
}

function _conversationTitleForCid(cid) {
  const conv = Array.isArray(conversations)
    ? conversations.find((item) => item && item.conversation_id === cid)
    : null;
  return (conv && conv.title) || t('chat.reference_unknown_task');
}

function _referenceDisplayName(ref) {
  if (!ref) return t('chat.from_agent_unknown');
  const actor = ref.from_actor || ref.fromActor || '';
  if (actor === 'user') return t('chat.from_user');
  if (actor === 'commander') return t('chat.from_commander');
  return ref.from_name || ref.fromName || _groupActorLabel(actor) || t('chat.from_agent_unknown');
}

function _quotePreviewAttribution(quote, targetCid) {
  const fromName = _referenceDisplayName(quote);
  const sourceCid = String(quote?.source_cid || quote?.sourceCid || '');
  if (!sourceCid || sourceCid === String(targetCid || '')) {
    return t('chat.quote_from', { name: fromName });
  }
  const sourceTitle = quote.source_title || quote.sourceTitle || _conversationTitleForCid(sourceCid);
  return t('chat.reference_from_task', { title: sourceTitle, name: fromName });
}

function _renderMessageReferencesHtml(references, targetCid) {
  const refs = Array.isArray(references) ? references.slice(0, 20) : [];
  if (!refs.length) return '';
  const rows = refs.map((ref) => {
    const attribution = _quotePreviewAttribution(ref, targetCid);
    const text = String(ref.text || '').replace(/\s+/g, ' ').trim();
    return `<div class="chat-reference-message">
      <span class="chat-reference-author">${escapeHtml(attribution)}</span>
      <span class="chat-reference-text">${escapeHtml(text)}</span>
    </div>`;
  }).join('');
  const attachmentFiles = refs.flatMap((ref) => (Array.isArray(ref.attachments) ? ref.attachments : [])
    .map((attachment) => ({
      name: typeof attachment === 'string' ? attachment : attachment?.name,
      sourceCid: ref.source_cid || '',
    })))
    .filter((item) => item.name && item.sourceCid)
    .slice(0, 20)
    .map((item) => `<button type="button" class="chat-reference-file is-attachment" data-attach-name="${escapeHtml(item.name)}" data-attach-cid="${escapeHtml(item.sourceCid)}" title="${escapeHtml(item.name)}">${_chatFileIconHtml(item.name)}<span>${escapeHtml(item.name)}</span></button>`)
    .join('');
  const producedFiles = refs.flatMap((ref) => Array.isArray(ref.produced) ? ref.produced : [])
    .slice(0, Math.max(0, 20 - refs.reduce((count, ref) => count + (ref.attachments?.length || 0), 0)))
    .map((file) => {
      const base = String(file || '').split(/[\\/]/).pop() || file;
      return `<span class="chat-reference-file">${_chatFileIconHtml(base)}<span>${escapeHtml(base)}</span></span>`;
  }).join('');
  const files = `${attachmentFiles}${producedFiles}`;
  return `<div class="chat-reference-bundle">
    <div class="chat-reference-list">${rows}</div>
    ${files ? `<div class="chat-reference-files">${files}</div>` : ''}
  </div>`;
}

function _hydrateMessageReferenceFiles(msgDiv) {
  msgDiv.querySelectorAll('.chat-reference-file.is-attachment[data-attach-name][data-attach-cid]').forEach((chip) => {
    if (chip.dataset.bound === '1') return;
    chip.dataset.bound = '1';
    chip.addEventListener('click', async (event) => {
      event.stopPropagation();
      const name = chip.dataset.attachName || '';
      const cid = chip.dataset.attachCid || '';
      if (!name || !cid || typeof openChatFileViewer !== 'function') return;
      try {
        const result = await window.orkas.invoke('attachments.absPath', { cid, name });
        if (!result?.ok || !result.path) {
          _showFileMissingToast(name);
          return;
        }
        openChatFileViewer(result.path, name, { cid });
      } catch (_) { _showFileMissingToast(name); }
    });
  });
}

function _addQuote(cid, payload) {
  if (!cid || !payload) return false;
  const quotes = _quotesByCid.get(cid) || [];
  const sourceCid = payload.sourceCid || currentCid || '';
  const identity = _quoteIdentity({ ...payload, sourceCid });
  if (quotes.some((quote) => _quoteIdentity(quote) === identity)) return false;
  _quotesByCid.set(cid, quotes.concat({
    ...payload,
    sourceCid,
    sourceTitle: payload.sourceTitle || (
      typeof _conversationTitleForCid === 'function'
        ? _conversationTitleForCid(payload.sourceCid || currentCid || '')
        : ''
    ),
    attachments: Array.isArray(payload.attachments) ? payload.attachments.slice() : [],
    references: Array.isArray(payload.references) ? payload.references.slice(0, 20) : [],
    referenceCount: Math.max(0, Number(payload.referenceCount) || payload.references?.length || 0),
    produced: Array.isArray(payload.produced) ? payload.produced.slice() : [],
  }));
  if (typeof _persistQuoteDraft === 'function') _persistQuoteDraft(cid);
  _renderQuotePreview(cid);
  return true;
}

function _removeQuoteAt(cid, index) {
  if (!cid) return;
  const quotes = _quotesByCid.get(cid) || [];
  if (!Number.isInteger(index) || index < 0 || index >= quotes.length) return;
  const next = quotes.filter((_, quoteIndex) => quoteIndex !== index);
  if (next.length) _quotesByCid.set(cid, next);
  else _quotesByCid.delete(cid);
  if (typeof _persistQuoteDraft === 'function') _persistQuoteDraft(cid);
  _renderQuotePreview(cid);
}
function _getQuotes(cid) { return cid ? _quotesByCid.get(cid) || [] : []; }
function _clearQuotes(cid) {
  if (!cid) return;
  _quotesByCid.delete(cid);
  if (typeof _persistQuoteDraft === 'function') _persistQuoteDraft(cid);
  _renderQuotePreview(cid);
}

function _quotePreviewTarget(cid = currentCid) {
  if (cid === DRAFT_CID) return { cid, id: 'new-chat-quote-preview' };
  if (String(cid || '').startsWith('projchat-')) return { cid, id: 'project-chat-quote-preview' };
  if (!cid || cid !== currentCid) return null;
  return { cid, id: 'chat-quote-preview' };
}

// Render (or hide) the matching conversation, commander-draft, or project-
// draft preview. Idempotent — safe on view changes and quote mutations.
function _renderQuotePreview(cid = currentCid) {
  const target = _quotePreviewTarget(cid);
  if (!target) return;
  const wrap = document.getElementById(target.id);
  if (!wrap) return;
  const quotes = _getQuotes(target.cid);
  if (!quotes.length) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    if (target.id === 'chat-quote-preview') _updateChatInputReserve();
    return;
  }
  wrap.innerHTML = quotes.map((q, index) => {
    // Resolve attribution at render time so agent renames flow through;
    // retain the click-time snapshot if the actor was deleted after capture.
    const attribution = _quotePreviewAttribution(q, target.cid);
    const fileChips = (q.produced || []).map((p) => {
      const base = String(p || '').split(/[\\/]/).pop() || p;
      return `<span class="chat-quote-file" title="${escapeHtml(p)}">${_chatFileIconHtml(base)}<span class="chat-quote-file-label">${escapeHtml(base)}</span></span>`;
    }).concat((q.attachments || []).map((attachment) => {
      const name = typeof attachment === 'string' ? attachment : attachment?.name;
      return name ? `<span class="chat-quote-file" title="${escapeHtml(name)}">${_chatFileIconHtml(name)}<span class="chat-quote-file-label">${escapeHtml(name)}</span></span>` : '';
    })).join('');
    return `<div class="chat-quote-item">
      <div class="chat-quote-header">
        <span class="chat-quote-from">${escapeHtml(attribution)}</span>
        <button type="button" class="chat-quote-close" data-quote-index="${index}" title="${escapeHtml(t('chat.quote_remove_title'))}">×</button>
      </div>
      <div class="chat-quote-body">${escapeHtml(String(q.text || ''))}</div>
      ${q.referenceCount ? `<div class="chat-quote-nested">${escapeHtml(t('chat.quote_includes_references', { count: q.referenceCount }))}</div>` : ''}
      ${fileChips ? `<div class="chat-quote-files">${fileChips}</div>` : ''}
    </div>`;
  }).join('');
  wrap.style.display = '';
  if (target.id === 'chat-quote-preview') _updateChatInputReserve();
  wrap.querySelectorAll('.chat-quote-close').forEach((closeBtn) => {
    closeBtn.addEventListener('click', () => {
      _removeQuoteAt(target.cid, Number(closeBtn.dataset.quoteIndex));
    });
  });
}

// Prepend active quotes as markdown blockquotes so the receiving agent sees
// them in the inbound message body (no special parsing needed). File paths
// land as absolute paths — same shape `produced[]` already stores; the agent
// can `read_file('<abs>')` directly without any cwd assumptions.
//
// **No `Quoted from @<sender>` attribution line in the persisted text.**
// Earlier versions prefixed the block with `> **Quoted from @<name>:**` for
// context, but `bus.ts::resolveRecipients` scans the message body for
// `@<token>` mentions (including aliases `@指挥官` / `@user`) and
// union-routes to every match — so the attribution `@<sender>` was being
// parsed as a second recipient, re-triggering the original agent / commander
// on every quote-forward. The sender's name is still shown in the input-area
// preview (renderer-only, never serialised), which is enough context for the
// user pressing send.
function applyQuotePrefix(raw, target) {
  if (target !== 'conversation') return raw;
  const quotes = _getQuotes(currentCid);
  if (!quotes.length) return raw;
  const blocks = quotes.map((q) => {
    const bodyLines = String(q.text || '').split('\n').map((l) => `> ${l}`).join('\n');
    if (!Array.isArray(q.produced) || !q.produced.length) return bodyLines;
    const filesHead = t('chat.quote_files_label');
    const fileLines = q.produced.map((p) => `> - \`${p}\``).join('\n');
    return `${bodyLines}\n>\n> ${filesHead}\n${fileLines}`;
  });
  const block = blocks.join('\n\n');
  return raw ? `${block}\n\n${raw}` : block;
}

function _referenceSnapshotsForQuotes(quotes) {
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    if (!ref?.source_cid || !ref?.source_msg_id || out.length >= 20) return;
    const identity = `${ref.source_cid}:${ref.source_msg_id}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    out.push(ref);
  };
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    push({
      source_cid: quote.sourceCid || '',
      source_title: quote.sourceTitle || _conversationTitleForCid(quote.sourceCid || ''),
      source_msg_id: quote.msgId || '',
      from_actor: quote.fromActor || '',
      ...(quote.fromName ? { from_name: quote.fromName } : {}),
      source_ts: quote.ts || '',
      text: quote.text || '',
      ...(quote.attachments?.length ? { attachments: quote.attachments.slice() } : {}),
      ...(quote.produced?.length ? { produced: quote.produced.slice() } : {}),
    });
    for (const nested of quote.references || []) push(nested);
  }
  return out;
}

function _messageTextForActions(msgDiv, fallback = '') {
  const text = String(fallback || '');
  if (text && !text.startsWith('<')) return text;
  const bubble = msgDiv && msgDiv.querySelector ? msgDiv.querySelector('.chat-bubble') : null;
  return (bubble && bubble.textContent ? bubble.textContent : text).trim();
}

function _textFromBubbleWithout(msgDiv, selectors) {
  const bubble = msgDiv && msgDiv.querySelector ? msgDiv.querySelector('.chat-bubble') : null;
  if (!bubble) return '';
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll(selectors).forEach((el) => el.remove());
  return _normalizeFeedbackFieldText(clone.textContent || '');
}

function _failedAssistantErrorText(msgDiv) {
  const bubble = msgDiv && msgDiv.querySelector ? msgDiv.querySelector('.chat-bubble') : null;
  if (!bubble) return '';
  const errorLines = Array.from(bubble.querySelectorAll('.msg-error'))
    .map((el) => _normalizeFeedbackFieldText(el.textContent || ''))
    .filter(Boolean);
  if (errorLines.length) return errorLines.join('\n');

  const explicitFailureLines = Array.from(bubble.querySelectorAll('[style*="var(--danger)"]'))
    .map((el) => _normalizeFeedbackFieldText(el.textContent || ''))
    .filter(Boolean);
  if (explicitFailureLines.length) return explicitFailureLines.join('\n');

  const bubbleText = _normalizeFeedbackFieldText(bubble.textContent || '');
  const modelMatch = bubbleText.match(/(?:模型调用失败|model\s+(?:call|invocation|response)\s+failed)[:：]?\s*[^\n]*/i);
  if (modelMatch) return modelMatch[0].trim();
  const sendMatch = bubbleText.match(/(?:发送失败|send failed)[:：]?\s*[^\n]*/i);
  if (sendMatch) return sendMatch[0].trim();
  // Do not fall back to the entire bubble: it can include tool process output,
  // local paths, and the otherwise successful reply. Keep a stable failure
  // class when no explicit error node is available.
  return bubbleText ? 'Assistant response failed' : '';
}

let _bubbleActionMenuListenersBound = false;
let _openBubbleActionMenu = null;

function _closeBubbleActionMenus() {
  const menu = _openBubbleActionMenu;
  if (!menu) return;
  menu.hidden = true;
  const owner = menu.closest('.chat-bubble-actions');
  const trigger = owner?.querySelector('.bubble-more-btn');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  _openBubbleActionMenu = null;
}

function _bindBubbleActionMenuDismiss() {
  if (_bubbleActionMenuListenersBound) return;
  _bubbleActionMenuListenersBound = true;
  document.addEventListener('mousedown', (event) => {
    if (event.target?.closest?.('.chat-bubble-actions')) return;
    _closeBubbleActionMenus();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') _closeBubbleActionMenus();
  });
  window.addEventListener('resize', () => _closeBubbleActionMenus());
  window.addEventListener('scroll', () => _closeBubbleActionMenus(), true);
}

function _wireBubbleActionMenu(actions) {
  const trigger = actions?.querySelector('.bubble-more-btn');
  const menu = actions?.querySelector('.chat-bubble-more-menu');
  if (!trigger || !menu) return;
  _bindBubbleActionMenuDismiss();
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (_openBubbleActionMenu === menu) {
      _closeBubbleActionMenus();
      return;
    }
    _closeBubbleActionMenus();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    _openBubbleActionMenu = menu;
  });
  menu.addEventListener('click', () => _closeBubbleActionMenus());
}

function _attachBubbleRetryBtn(actions, msgDiv) {
  if (!actions || actions.querySelector('.bubble-retry-btn')) return;
  const retryBtn = document.createElement('button');
  retryBtn.className = 'bubble-action-btn bubble-retry-btn';
  retryBtn.title = t('chat.retry_btn_title');
  retryBtn.textContent = t('chat.retry_btn');
  retryBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const retryHandler = typeof msgDiv?._failedRetryHandler === 'function'
      ? msgDiv._failedRetryHandler
      : _retryFailedAssistantMessage;
    await retryHandler(msgDiv, retryBtn);
  });
  actions.appendChild(retryBtn);
}

function _attachFailedAssistantActions(msgDiv, getContent) {
  if (!msgDiv) return;
  msgDiv.dataset.failed = '1';
  _attachBubbleActions(msgDiv, getContent, {
    archive: false,
    retry: true,
  });
}

function _attachInterruptedAssistantActions(msgDiv, getContent, opts) {
  if (!msgDiv) return;
  msgDiv.dataset.interrupted = '1';
  _attachBubbleActions(msgDiv, getContent, {
    archive: !opts || opts.archive !== false,
    retry: true,
    report: true,
    compact: msgDiv.dataset.messageActions === 'errors-only',
  });
}

function _attachAssistantActions(msgDiv, getContent, opts = {}) {
  if (msgDiv?.dataset?.messageActions === 'errors-only') return;
  _attachBubbleActions(msgDiv, getContent, {
    archive: opts.archive !== false,
  });
}

let _messageSelectionState = null; // { cid, selected:Set<string> }

function _selectedMessageElements() {
  if (!_messageSelectionState || _messageSelectionState.cid !== currentCid) return [];
  return Array.from(document.querySelectorAll('#chat-history .chat-message[data-msg-id]'))
    .filter((msg) => _messageSelectionState.selected.has(msg.dataset.msgId || ''));
}

function _messageReferencePayload(msgDiv) {
  if (!msgDiv) return null;
  const msgId = msgDiv.dataset.msgId || '';
  const text = _textFromBubbleWithout(
    msgDiv,
    '.chat-reference-bundle, .chat-msg-produced, .chat-msg-attachments, .stream-process, .chat-input-form, .chat-artifacts, iframe',
  );
  if (!msgId || !text) return null;
  const fromActor = msgDiv.dataset.fromActor || msgDiv.dataset.from || (msgDiv.classList.contains('user') ? 'user' : '');
  let produced = [];
  let attachments = [];
  let references = [];
  try {
    const parsed = JSON.parse(msgDiv.dataset.produced || '[]');
    if (Array.isArray(parsed)) produced = parsed;
  } catch (_) {}
  try {
    const parsed = JSON.parse(msgDiv.dataset.attachments || '[]');
    if (Array.isArray(parsed)) attachments = parsed.map((item) => (
      typeof item === 'string' ? { name: item } : item
    )).filter((item) => item?.name);
  } catch (_) {}
  try {
    const parsed = JSON.parse(msgDiv.dataset.references || '[]');
    if (Array.isArray(parsed)) references = parsed.slice(0, 20);
  } catch (_) {}
  return {
    sourceCid: currentCid,
    sourceTitle: _conversationTitleForCid(currentCid),
    msgId,
    fromActor,
    fromName: _referenceDisplayName({ fromActor }),
    ts: msgDiv.dataset.ts || '',
    text,
    attachments,
    references,
    referenceCount: references.length,
    produced,
  };
}

function _closeReferenceTargetPicker() {
  document.getElementById('chat-reference-target-overlay')?.remove();
}

async function _transferSelectedReferences(targetCid, payloads, opts = {}) {
  if (!targetCid || !payloads.length) return;
  for (const payload of payloads) _addQuote(targetCid, payload);
  _closeReferenceTargetPicker();
  _exitMessageSelection();
  if (opts.conversation) {
    conversations = (Array.isArray(conversations) ? conversations : []).filter((c) => c.conversation_id !== targetCid);
    conversations.unshift(opts.conversation);
    renderConversationList();
  }
  setView('conversation', targetCid, opts.fresh ? { skipLoad: true } : undefined);
  _renderQuotePreview();
  document.getElementById('chat-input')?.focus();
}

function _referenceTargetProject(projectId) {
  if (!projectId || !Array.isArray(_projectsCache)) return null;
  return _projectsCache.find((project) => project && project.project_id === projectId) || null;
}

function _referenceTargetAreaLabel(conversation) {
  const projectId = conversation?.project_id || '';
  if (!projectId) return t('chat.reference_area_commander');
  return _referenceTargetProject(projectId)?.name || t('chat.reference_area_project');
}

function _referenceTargetActivity(conversation) {
  return String(conversation?.last_active_at || conversation?.updated_at || conversation?.created_at || '');
}

function _referenceNewTaskDraftCid(projectId = '') {
  return projectId ? `projchat-${projectId}` : DRAFT_CID;
}

function _stageReferencesForNewTask(payloads, projectId = '') {
  if (!Array.isArray(payloads) || !payloads.length) return;
  const draftCid = _referenceNewTaskDraftCid(projectId);
  for (const payload of payloads) _addQuote(draftCid, payload);
  _closeReferenceTargetPicker();
  _exitMessageSelection();
  if (projectId) {
    setView('project', projectId);
    _renderQuotePreview(draftCid);
    document.getElementById('project-chat-input')?.focus();
    return;
  }
  setView('new-chat');
  _renderQuotePreview(DRAFT_CID);
  document.getElementById('new-chat-input')?.focus();
}

async function _loadReferenceTargetConversations() {
  try {
    const res = await apiFetch('/api/conversations/list');
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.conversations)) {
      throw new Error(data?.error || t('chat.load_failed', { msg: t('chat.unknown_error') }));
    }
    return data.conversations;
  } catch (err) {
    _convLog.warn('reference target full list failed', { error: err?.message || String(err) });
    return Array.isArray(conversations) ? conversations.slice() : [];
  }
}

async function _openReferenceTargetPicker(payloads) {
  if (!Array.isArray(payloads) || !payloads.length) return;
  const loads = [_loadReferenceTargetConversations()];
  if (typeof loadProjects === 'function') loads.push(loadProjects());
  const [targetConversations] = await Promise.all(loads);
  _closeReferenceTargetPicker();
  const sourceProjectId = _projectIdForConversation(currentCid);
  const overlay = document.createElement('div');
  overlay.id = 'chat-reference-target-overlay';
  overlay.className = 'modal-overlay open chat-reference-target-overlay';
  overlay.innerHTML = `<div class="modal-standard chat-reference-target-modal" role="dialog" aria-modal="true" aria-labelledby="chat-reference-target-title">
    <div class="modal-header chat-reference-target-header">
      <h2 class="modal-title" id="chat-reference-target-title">${escapeHtml(t('chat.reference_target_title', { count: payloads.length }))}</h2>
      <button type="button" class="modal-close-btn chat-reference-target-close" title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}">${_uiIconHtml('x', 'modal-close-icon') || '×'}</button>
    </div>
    <div class="modal-body chat-reference-target-body">
      <button type="button" class="chat-reference-new-task" data-new-task="1">
        <span class="chat-reference-leading-plus" aria-hidden="true">+</span>
        <span class="chat-reference-new-task-label">${escapeHtml(t('chat.reference_new_task'))}</span>
        <span class="chat-reference-row-arrow" aria-hidden="true">›</span>
      </button>
      <section class="chat-reference-existing" aria-labelledby="chat-reference-existing-title">
        <div class="chat-reference-existing-head">
          <h3 id="chat-reference-existing-title">${escapeHtml(t('chat.reference_existing_tasks'))}</h3>
          <span data-reference-list-hint>${escapeHtml(t('chat.reference_recent_tasks_hint'))}</span>
        </div>
        <label class="chat-reference-target-search-wrap">
          <input type="search" class="chat-reference-target-search" placeholder="${escapeHtml(t('chat.reference_target_search'))}" />
        </label>
        <div class="chat-reference-target-list"></div>
      </section>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const list = overlay.querySelector('.chat-reference-target-list');
  const search = overlay.querySelector('.chat-reference-target-search');
  const hint = overlay.querySelector('[data-reference-list-hint]');
  const render = () => {
    const needle = String(search.value || '').trim().toLowerCase();
    const matches = (Array.isArray(targetConversations) ? targetConversations : [])
      .filter((conv) => conv && conv.conversation_id !== currentCid)
      .filter((conv) => {
        if (!needle) return true;
        return String(conv.title || '').toLowerCase().includes(needle);
      })
      .sort((a, b) => _referenceTargetActivity(b).localeCompare(_referenceTargetActivity(a)));
    const tasks = needle ? matches.slice(0, 80) : matches.slice(0, 5);
    if (hint) hint.textContent = needle
      ? t('chat.reference_search_results_count', { count: matches.length })
      : t('chat.reference_recent_tasks_hint');
    list.innerHTML = `${tasks.map((conv) => `<button type="button" class="chat-reference-target-item" data-target-cid="${escapeHtml(conv.conversation_id)}">
        <span class="chat-reference-target-main">
          <strong>${escapeHtml(conv.title || t('chat.untitled'))}</strong>
          <small>${escapeHtml(_referenceTargetAreaLabel(conv))}</small>
        </span>
        <span class="chat-reference-row-arrow" aria-hidden="true">›</span>
      </button>`).join('')}
      ${tasks.length ? '' : `<div class="chat-reference-target-empty">${escapeHtml(t('chat.reference_no_tasks'))}</div>`}`;
    list.querySelectorAll('[data-target-cid]').forEach((item) => {
      item.addEventListener('click', () => _transferSelectedReferences(item.dataset.targetCid, payloads));
    });
  };
  overlay.querySelector('[data-new-task]')?.addEventListener('click', () => {
    _stageReferencesForNewTask(payloads, sourceProjectId);
  });
  overlay.querySelector('.chat-reference-target-close')?.addEventListener('click', _closeReferenceTargetPicker);
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') _closeReferenceTargetPicker(); });
  search.addEventListener('input', render);
  render();
}

function _updateMessageSelectionToolbar() {
  const bar = document.getElementById('chat-message-selection-bar');
  if (!bar || !_messageSelectionState) return;
  const count = _messageSelectionState.selected.size;
  const countEl = bar.querySelector('[data-selection-count]');
  if (countEl) countEl.textContent = t('chat.message_selected_count', { count });
  bar.querySelectorAll('[data-requires-selection]').forEach((btn) => { btn.disabled = count === 0; });
}

function _toggleMessageSelection(msg) {
  const id = msg?.dataset?.msgId || '';
  if (!id || !_messageSelectionState || _messageSelectionState.cid !== currentCid) return;
  if (_messageSelectionState.selected.has(id)) _messageSelectionState.selected.delete(id);
  else _messageSelectionState.selected.add(id);
  _syncMessageSelectionUi();
}

function _messageBubbleSelectionClick(event, msg) {
  if (!_messageSelectionState || !msg?.classList?.contains('is-message-selectable')) return;
  if (event.target?.closest?.('a, button, input, textarea, select, label, summary, iframe, video, audio, [role="button"], [contenteditable="true"]')) return;
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (selection && !selection.isCollapsed) return;
  _toggleMessageSelection(msg);
}

function _syncMessageSelectionUi() {
  const active = !!_messageSelectionState && _messageSelectionState.cid === currentCid;
  const pane = document.querySelector('#panel-conversation .chat-main-pane');
  pane?.classList.toggle('is-message-selecting', active);
  const messages = document.querySelectorAll('#chat-history .chat-message[data-msg-id]');
  messages.forEach((msg) => {
    msg.classList.toggle('is-message-selectable', active);
    const bubble = msg.querySelector(':scope > .chat-bubble');
    if (bubble && bubble.dataset.selectionClickBound !== '1') {
      bubble.dataset.selectionClickBound = '1';
      bubble.addEventListener('click', (event) => _messageBubbleSelectionClick(event, msg));
    }
    let check = msg.querySelector(':scope > .chat-message-select-check');
    if (active && !check) {
      check = document.createElement('button');
      check.type = 'button';
      check.className = 'chat-message-select-check';
      check.innerHTML = '<span>✓</span>';
      check.addEventListener('click', (event) => {
        event.stopPropagation();
        _toggleMessageSelection(msg);
      });
      msg.prepend(check);
    }
    if (!active && check) check.remove();
    const selected = active && _messageSelectionState.selected.has(msg.dataset.msgId || '');
    msg.classList.toggle('is-message-selected', selected);
    if (check) check.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });

  let bar = document.getElementById('chat-message-selection-bar');
  if (!active) {
    bar?.remove();
    return;
  }
  if (!bar && pane) {
    bar = document.createElement('div');
    bar.id = 'chat-message-selection-bar';
    bar.className = 'chat-message-selection-bar';
    bar.innerHTML = `<button type="button" class="btn btn-sm" data-selection-cancel>${escapeHtml(t('common.cancel'))}</button>
      <span class="chat-message-selection-count" data-selection-count></span>
      <span class="chat-message-selection-spacer"></span>
      <button type="button" class="btn btn-sm" data-selection-reference data-requires-selection>${escapeHtml(t('chat.reference_to'))}</button>`;
    pane.insertBefore(bar, pane.querySelector('.chat-input-wrapper'));
    bar.querySelector('[data-selection-cancel]').addEventListener('click', _exitMessageSelection);
    bar.querySelector('[data-selection-reference]').addEventListener('click', () => {
      const payloads = _selectedMessageElements().map(_messageReferencePayload).filter(Boolean);
      _openReferenceTargetPicker(payloads);
    });
  }
  _updateMessageSelectionToolbar();
}

function _enterMessageSelection(msgDiv) {
  const msgId = msgDiv?.dataset?.msgId || '';
  if (!currentCid || !msgId) return;
  _messageSelectionState = { cid: currentCid, selected: new Set([msgId]) };
  _syncMessageSelectionUi();
}

function _exitMessageSelection() {
  _messageSelectionState = null;
  _syncMessageSelectionUi();
}

// Copy works immediately for optimistic user bubbles. Quote/select require a
// persisted message id because cross-task references and deletion are
// resolved server-side from that stable locator. The bus echo stamps the id
// moments later and `_syncRenderedGroupMessageIdentity` enables both buttons.
function _syncBubbleReferenceActionState(msgDiv) {
  if (!msgDiv?.querySelector) return;
  const hasPersistedId = !!msgDiv.dataset.msgId;
  msgDiv.querySelectorAll('.bubble-quote-btn, .bubble-select-btn').forEach((button) => {
    button.disabled = !hasPersistedId;
  });
}

// Attach small action buttons below the bubble. Kept outside the bubble so
// they never overlap content. `getContent` is a callback so it can return the
// latest text after streaming completes.
function _attachBubbleActions(msgDiv, getContent, opts = {}) {
  const includeArchive = opts.archive !== false;
  const includeRetry = opts.retry === true;
  const includeReport = opts.report === true;
  const compact = opts.compact === true;
  const mode = compact
    ? 'failure-only'
    : includeRetry
    ? (includeArchive ? 'assistant-retry' : 'failed')
    : (includeReport ? (includeArchive ? 'assistant' : 'assistant-feedback') : (includeArchive ? 'assistant' : 'user'));
  // Archive button lives in the `.chat-msg-actions` row below the bubble
  // (alongside produced-file chips). Lazily create the row if a caller
  // (e.g. streaming placeholders that didn't allocate one) needs it.
  let actionsRow = msgDiv.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msgDiv.appendChild(actionsRow);
  }
  const existingActions = actionsRow.querySelector('.chat-bubble-actions');
  if (existingActions) {
    if (existingActions.dataset.mode === mode) {
      _syncBubbleReferenceActionState(msgDiv);
      return;
    }
    existingActions.remove();
  }
  const actions = document.createElement('span');
  actions.className = 'chat-bubble-actions';
  actions.dataset.mode = mode;
  if (compact) {
    actions.innerHTML = '<span class="chat-bubble-direct-actions"></span>';
    const directActions = actions.querySelector('.chat-bubble-direct-actions');
    if (includeRetry) _attachBubbleRetryBtn(directActions, msgDiv);
    if (includeReport) _attachBubbleReportBtn(directActions, msgDiv, getContent);
    actionsRow.appendChild(actions);
    return;
  }
  const quoteButton = `<button type="button" class="bubble-action-btn bubble-quote-btn" title="${escapeHtml(t('chat.quote_btn_title'))}">${escapeHtml(t('chat.quote_btn'))}</button>`;
  const overflowItems = `<button type="button" role="menuitem" class="chat-bubble-menu-item bubble-copy-btn" title="${escapeHtml(t('chat.copy_btn_title'))}">${escapeHtml(t('chat.copy_btn'))}</button>
    <button type="button" role="menuitem" class="chat-bubble-menu-item bubble-select-btn" title="${escapeHtml(t('chat.message_select_title'))}">${escapeHtml(t('chat.message_select'))}</button>
    ${includeArchive ? `<button type="button" role="menuitem" class="chat-bubble-menu-item bubble-archive-btn" title="${escapeHtml(t('chat.archive_btn_title'))}">${escapeHtml(t('chat.archive_btn'))}</button>` : ''}`;
  actions.innerHTML = `
    <span class="chat-bubble-direct-actions">${quoteButton}</span>
    <span class="chat-bubble-more-wrap">
      <button type="button" class="bubble-more-btn" title="${escapeHtml(t('chat.more_actions'))}" aria-label="${escapeHtml(t('chat.more_actions'))}" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">···</span></button>
      <span class="chat-bubble-more-menu" role="menu" hidden>${overflowItems}</span>
    </span>
  `;
  const directActions = actions.querySelector('.chat-bubble-direct-actions');
  const btn = actions.querySelector('.bubble-archive-btn');
  const copyBtn = actions.querySelector('.bubble-copy-btn');
  const quoteBtn = actions.querySelector('.bubble-quote-btn');
  const selectBtn = actions.querySelector('.bubble-select-btn');
  if (includeRetry) _attachBubbleRetryBtn(directActions, msgDiv);
  _wireBubbleActionMenu(actions);
  quoteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (quoteBtn.disabled) return;
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim()) return;
    const fromActor = msgDiv.dataset.fromActor || (msgDiv.classList.contains('user') ? 'user' : '');
    const msgId = msgDiv.dataset.msgId || '';
    let produced = [];
    let attachments = [];
    let references = [];
    try {
      const raw = msgDiv.dataset.produced || '';
      if (raw) produced = JSON.parse(raw);
      if (!Array.isArray(produced)) produced = [];
    } catch (_) { produced = []; }
    try {
      const parsed = JSON.parse(msgDiv.dataset.attachments || '[]');
      if (Array.isArray(parsed)) attachments = parsed.map((item) => (
        typeof item === 'string' ? { name: item } : item
      )).filter((item) => item?.name);
    } catch (_) { attachments = []; }
    try {
      const parsed = JSON.parse(msgDiv.dataset.references || '[]');
      if (Array.isArray(parsed)) references = parsed.slice(0, 20);
    } catch (_) { references = []; }
    const fromName = _referenceDisplayName({ fromActor });
    const added = _addQuote(currentCid, {
      sourceCid: currentCid,
      sourceTitle: _conversationTitleForCid(currentCid),
      fromActor,
      fromName,
      msgId,
      ts: msgDiv.dataset.ts || '',
      text,
      attachments,
      references,
      referenceCount: references.length,
      produced,
    });
    const input = document.getElementById('chat-input');
    if (input) { input.focus(); }
    void added;
  });
  selectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectBtn.disabled) return;
    _enterMessageSelection(msgDiv);
  });
  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim() || copyBtn.disabled) return;
    copyBtn.disabled = true;
    const orig = copyBtn.innerHTML;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = t('chat.copy_done');
    } catch (err) {
      copyBtn.textContent = t('chat.copy_failed');
    }
    setTimeout(() => { copyBtn.innerHTML = orig; copyBtn.disabled = false; }, 1500);
  });
  if (!btn) {
    actionsRow.appendChild(actions);
    _syncBubbleReferenceActionState(msgDiv);
    return;
  }
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim() || btn.disabled) return;
    // Open the KB picker with a default filename derived from the first
    // ~20 visible chars; user confirms directory + filename before any
    // network call happens.
    if (typeof pickKbLocation !== 'function' || typeof deriveKbArchiveName !== 'function') {
      const loader = typeof loadRendererFeature === 'function'
        ? loadRendererFeature
        : window.loadRendererFeature;
      if (typeof loader !== 'function') return;
      try {
        await loader('kb-picker');
      } catch (err) {
        _convLog.warn('KB picker load failed', { error: err?.message || String(err) });
        return;
      }
    }
    const projectId = _projectIdForConversation(currentCid);
    const targetScope = projectId ? { type: 'project', projectId } : { type: 'global' };
    const pick = await pickKbLocation({
      defaultName: deriveKbArchiveName(text),
      title: t('chat.archive_picker_title'),
      scope: targetScope,
    });
    if (!pick) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    try {
      const data = await window.orkas.invoke('library.writeText', {
        cid: currentCid,
        targetScope,
        targetPath: pick.path,
        content: text,
      });
      if (data.ok) {
        btn.textContent = t('chat.archive_done');
        if (typeof uiToast === 'function') uiToast(t('chat.archive_done'), { variant: 'success' });
        if (data.scope === 'global' && currentView === 'contexts' && typeof loadContexts === 'function') {
          loadContexts();
        }
        if (data.scope === 'project' && data.projectId && currentView === 'project' && typeof loadProjectDetail === 'function') {
          loadProjectDetail(data.projectId).catch(() => {});
        }
      } else {
        btn.textContent = t('chat.archive_failed');
        const message = t('chat.archive_failed_with_reason', { reason: data.error || t('chat.unknown_error') });
        if (typeof uiToast === 'function') uiToast(message, { variant: 'error' });
        else await uiAlert(message);
      }
    } catch (err) {
      btn.textContent = t('chat.archive_failed');
      const message = t('chat.archive_failed_with_reason', { reason: err.message || err });
      if (typeof uiToast === 'function') uiToast(message, { variant: 'error' });
      else await uiAlert(message);
    }
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  });
  actionsRow.appendChild(actions);
  _syncBubbleReferenceActionState(msgDiv);
}

function _attachBubbleArchiveBtn(msgDiv, getContent) {
  _attachAssistantActions(msgDiv, getContent, { archive: true });
}

function _findUserMessageForRetry(msgDiv) {
  let cur = msgDiv ? msgDiv.previousElementSibling : null;
  while (cur) {
    if (cur.classList && cur.classList.contains('chat-message') && cur.classList.contains('user')) {
      return cur;
    }
    cur = cur.previousElementSibling;
  }
  return null;
}

function _retryPayloadFromUserMessage(userMsgEl) {
  if (!userMsgEl) return null;
  const content = String(userMsgEl.dataset.retryContent || '').trim()
    || String(userMsgEl.querySelector('.markdown-body')?.textContent || '').trim();
  if (!content) return null;
  let attachments = [];
  try {
    const raw = userMsgEl.dataset.retryAttachments || '';
    if (raw) attachments = JSON.parse(raw);
    if (!Array.isArray(attachments)) attachments = [];
  } catch (_) { attachments = []; }
  const attachmentCid = String(userMsgEl.dataset.retryAttachmentCid || '').trim();
  const modelText = String(userMsgEl.dataset.retryModelText || '').trim();
  const extra = {
    ...(attachments.length ? { attachments } : {}),
    ...(attachmentCid ? { attachment_cid: attachmentCid } : {}),
    ...(modelText ? { model_text: modelText } : {}),
  };
  return { content, extra: Object.keys(extra).length ? extra : undefined };
}

async function _retryFailedAssistantMessage(msgDiv, btn) {
  if (!msgDiv || !currentCid) return;
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  const orig = btn ? btn.innerHTML : '';
  try {
    const failedMessageId = String(msgDiv.dataset.msgId || '').trim();
    let payload;
    if (failedMessageId) {
      payload = {
        content: t('chat.retry_user_message'),
        extra: { retry_message_id: failedMessageId },
      };
    } else {
      // Compatibility for an unpersisted/legacy live failure with no stable
      // message id. There is no authoritative recovery target, so retain the
      // old restart behavior using the preceding rendered user message.
      const userMsgEl = _findUserMessageForRetry(msgDiv);
      payload = _retryPayloadFromUserMessage(userMsgEl);
      if (!payload) {
        await uiAlert(t('chat.retry_no_source'));
        return;
      }
    }
    if (btn) btn.innerHTML = `<span class="bubble-action-spinner" aria-hidden="true"></span><span>${escapeHtml(t('chat.retry_running'))}</span>`;
    await sendInConversation(currentCid, payload.content, payload.extra);
  } finally {
    if (btn) {
      btn.innerHTML = orig || escapeHtml(t('chat.retry_btn'));
      btn.disabled = false;
    }
  }
}

// ─── Send flows ───

function _chatModelTelemetryContext(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  const provider = String(source.provider || '').trim().slice(0, 80);
  const model = String(source.model || '').trim().slice(0, 160);
  if (provider || model) {
    try {
      if (typeof _composerModelTelemetryContext === 'function') {
        return _composerModelTelemetryContext({ provider, model }, model);
      }
    } catch (_) {}
    const legacyDynamicProvider = /^cp:/i.test(provider) || provider === 'custom-openai';
    const userEnteredModel = legacyDynamicProvider || provider === 'custom' || provider === 'openrouter';
    const normalizedProvider = legacyDynamicProvider ? 'custom' : provider;
    return {
      provider: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(normalizedProvider)
        ? normalizedProvider
        : 'unknown',
      model: userEnteredModel
        ? 'custom'
        : (/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/.test(model) ? model : 'unknown'),
    };
  }
  try {
    return typeof _currentComposerModelTelemetryContext === 'function'
      ? _currentComposerModelTelemetryContext()
      : {};
  } catch (_) {
    return {};
  }
}

function _trackChatSendResult(result, data = {}) {
  void result;
  void data;
}

async function handleNewChatSubmit() {
  const input = document.getElementById('new-chat-input');
  const raw = (input.value || '').trim();
  const quotes = _getQuotes(DRAFT_CID).slice();
  if (!raw && !quotes.length) return;
  const requestText = raw || t('chat.reference_default_prompt');
  const draftItems = _chatAttachList(DRAFT_CID);
  const pendingUseSelections = (typeof getChatUseSelections === 'function')
    ? getChatUseSelections('new-chat')
    : [];
  const entryAttribution = _readCommanderTemplateAttribution(input);
  const modelTelemetry = _chatModelTelemetryContext();
  const sendAttemptStartedAt = performance.now();
  const sendAttempt = {
    conversation_id: '',
    source_view: 'new_chat',
    content_length: requestText.length,
    attachment_count: draftItems.filter((a) => a.status !== 'error').length,
    ...modelTelemetry,
    ...entryAttribution,
  };
  const unresolvedQuickStart = _unresolvedQuickStartPlaceholder(input);
  const unresolvedOss = typeof unresolvedOssTemplatePlaceholder === 'function'
    ? unresolvedOssTemplatePlaceholder(input)
    : '';
  if (unresolvedQuickStart || unresolvedOss) {
    _trackChatSendResult('failure', {
      ...sendAttempt,
      duration_ms: performance.now() - sendAttemptStartedAt,
      failure_stage: 'preflight',
      failure_reason: 'template_incomplete',
    });
    await uiAlert(t(unresolvedQuickStart ? 'new_chat.quick.task_required' : 'oss.task_required'));
    return;
  }
  if (!ensureModelConfigured()) {
    _trackChatSendResult('failure', {
      ...sendAttempt,
      duration_ms: performance.now() - sendAttemptStartedAt,
      failure_stage: 'preflight',
      failure_reason: 'model_not_configured',
    });
    return;
  }
  if (draftItems.some((a) => a.status === 'uploading')) {
    _trackChatSendResult('failure', {
      ...sendAttempt,
      duration_ms: performance.now() - sendAttemptStartedAt,
      failure_stage: 'preflight',
      failure_reason: 'attachment_uploading',
    });
    await uiAlert(t('chat.attach_still_uploading'));
    return;
  }
  const references = _referenceSnapshotsForQuotes(quotes);
  // Keep resource selections in the composer until attachment adoption has
  // completed. A failed preflight must leave the whole request retryable.
  const useSelections = pendingUseSelections;
  // Snapshot the new-chat recipient *now* so a stray view-change between
  // here and conv-create doesn't reset it before we can transfer.
  const recipientSnapshot = _recipientSnapshotForSend('new-chat');
  _pendingNewChatRecipient = _normaliseRecipientSnapshot(recipientSnapshot) || { ..._COMMANDER };
  // Keep the title seed separate from transport content. `content` may gain
  // an injected leading `@Agent` for routing, while task titles describe only
  // the user's request.
  const titleText = (typeof transformChatUseTokens === 'function')
    ? transformChatUseTokens(raw)
    : raw;
  const content = applyRecipientPrefix(transformWithChatUse(requestText), 'new-chat', {
    recipientSnapshot,
  });
  const draftNames = draftItems.filter((a) => a.status !== 'error').map((a) => a.name);
  _convLog.info('new chat submit', {
    content_length: content.length,
    use: useSelections.map((sel) => sel.kind),
    attachments: draftNames.length,
    entry_point: entryAttribution.entry_point,
    resource_id: entryAttribution.resource_id || '',
  });
  const newBtn = document.getElementById('new-chat-send-btn');
  if (newBtn) newBtn.disabled = true;
  let convId;
  let createdConversation = null;
  try {
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('chat.create_conv_failed'));
    const conv = data.conversation;
    convId = conv.conversation_id;
    // Optimistic title from the user-visible text (without recipient routing).
    // Use the shared `_autoTitle` so this matches backend `autoTitle` —
    // otherwise the optimistic + backend-refreshed titles disagree and
    // the sidebar entry flips on the next loadConversations.
    if (titleText) conv.title = _autoTitle(titleText);
    // Backend `createConversation` returns `created_at`/`updated_at` but
    // NOT the derived `last_active_at` (that lives only in `listConversations`'
    // output). Set it explicitly so `timeBucket` puts the brand-new row in
    // the 'today' bucket instead of falling through to 'older'.
    conv.last_active_at = new Date().toISOString();
    createdConversation = conv;
  } catch (e) {
    _convLog.warn('new chat conversation creation failed', {
      entry_point: entryAttribution.entry_point,
      resource_id: entryAttribution.resource_id || '',
      error: e && e.message ? e.message : String(e || ''),
    });
    _trackChatSendResult('failure', {
      ...sendAttempt,
      duration_ms: performance.now() - sendAttemptStartedAt,
      failure_stage: 'conversation_create',
      failure_reason: 'conversation_create_failed',
    });
    await uiAlert(t('chat.create_conv_failed_with_reason', { reason: e.message || e }));
    if (newBtn) newBtn.disabled = false;
    return;
  }

  // Adopt local `main_chat/` draft files into `<convId>/` on disk.
  // Preprocessing caches (`.<name>.extracted.NNN.md`) move with their source
  // when present — nothing to re-run.
  let attachments = [];
  if (draftNames.length) {
    let adoptionError = '';
    try {
      const res = await apiFetch('/api/conversations/attachments/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_cid: DRAFT_CID, to_cid: convId }),
      });
      const data = await res.json();
      if (!data.ok) {
        adoptionError = String(data.error || 'attachment_adopt_failed');
      } else {
        const adoptedNameBySource = new Map(
          (Array.isArray(data.items) ? data.items : [])
            .filter((item) => item && item.sourceName && item.targetName)
            .map((item) => [String(item.sourceName), String(item.targetName)]),
        );
        attachments = draftNames
          .map((name) => adoptedNameBySource.get(name) || '')
          .filter(Boolean);
        if (attachments.length !== draftNames.length) {
          adoptionError = 'attachment_adopt_incomplete';
          attachments = [];
        }
      }
    } catch (err) {
      adoptionError = String(err && err.message ? err.message : err || 'attachment_adopt_failed');
    }
    if (adoptionError) {
      try {
        const cleanup = await window.orkas.invoke('conversations.discardEmpty', { cid: convId });
        if (!cleanup || !cleanup.discarded) {
          _convLog.warn('discard empty conversation rejected', {
            error_code: 'discard_empty_rejected',
          });
        }
      } catch (_) {
        _convLog.warn('discard empty conversation failed', {
          error_code: 'discard_empty_failed',
        });
      }
      _trackChatSendResult('failure', {
        ...sendAttempt,
        duration_ms: performance.now() - sendAttemptStartedAt,
        failure_stage: 'preflight',
        failure_reason: 'attachment_adopt_failed',
      });
      await uiAlert(t('chat.attach_adopt_failed', { reason: adoptionError }));
      if (newBtn) newBtn.disabled = false;
      return;
    }
  }
  if (createdConversation) {
    conversations.unshift(createdConversation);
    renderConversationList();
  }
  if (typeof consumeChatUseSelections === 'function') consumeChatUseSelections('new-chat');
  // Adoption succeeded, so the draft chip pool can now be consumed.
  _chatAttachClear(DRAFT_CID);
  _chatAttachClear(convId);
  _clearQuotes(DRAFT_CID);

  _clearCommanderTemplateAttribution(input);
  input.value = '';
  autoGrow(input, 260);
  // Also clear the conversation-view input. setView with skipLoad:true
  // bypasses _restoreDraft, so without this the new conv would inherit
  // whatever draft text the previously-active conversation left behind in
  // #chat-input — and the next keystroke would save that stale text under
  // the new cid's draft key.
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = '';
    autoGrow(chatInput, 200);
  }
  setView('conversation', convId, { skipLoad: true });
  // Carry the new-chat recipient pick into the new conv's per-cid state so
  // the chip keeps the chosen agent instead of snapping back to commander.
  _transferNewChatRecipientTo(convId);
  _renderRecipientChip('conversation');
  if (newBtn) newBtn.disabled = false;
  const extra = {
    title_text: titleText,
    ...(attachments.length ? { attachments } : {}),
    ...(useSelections.length ? { use_selections: useSelections } : {}),
    ...(references.length ? { references } : {}),
  };
  // The initial turn uses the same abort-recovery contract as a follow-up:
  // stopping must restore the user's authored text and adopted attachments.
  if (typeof _rememberSentComposerSnapshot === 'function') {
    _rememberSentComposerSnapshot(convId, {
      text: requestText,
      recipient: recipientSnapshot,
      references: quotes,
      attachments: attachments.map((name) => ({ name })),
    });
  }
  await sendInCurrentConversation(content, Object.keys(extra).length ? extra : undefined);
}

async function handleChatSubmit() {
  const input = document.getElementById('chat-input');
  const raw = (input.value || '').trim();
  if (!currentCid) return;
  // A queued message being edited owns the composer. Submitting commits the
  // text back to its durable queue slot; it must not create a new send or run
  // normal preflight/attachment consumption.
  if (typeof _isQueueItemEditing === 'function' && _isQueueItemEditing(currentCid)) {
    if (!raw) return;
    const editAttachments = _chatAttachList(currentCid);
    if (editAttachments.some((attachment) => attachment.status === 'uploading')) {
      await uiAlert(t('chat.attach_still_uploading'));
      return;
    }
    _commitQueueItemEdit(currentCid, raw);
    return;
  }
  // A bare quote with no extra text is a legitimate "look at this" forward;
  // only reject when both the textarea AND the quote are empty.
  if (!raw && !_getQuotes(currentCid).length) return;
  const cid = currentCid;
  const quotes = _getQuotes(cid).slice();
  const requestText = raw || t('chat.reference_default_prompt');
  const useSelections = (typeof getChatUseSelections === 'function')
    ? getChatUseSelections('conversation')
    : [];
  const attachList = _chatAttachList(cid);
  const attachments = attachList.filter((a) => a.status !== 'error').map((a) => a.name);
  _convLog.info('chat submit', { cid, length: raw.length, use: useSelections.map((sel) => sel.kind), attachments: attachments.length });
  if (!ensureModelConfigured()) {
    return;
  }
  if (attachList.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return;
  }
  const references = _referenceSnapshotsForQuotes(quotes);
  _convLog.info('chat submit', { cid, length: raw.length, use: useSelections.map((sel) => sel.kind), attachments: attachments.length });

  // If this conversation is already streaming OR has queued items waiting,
  // enqueue the new message instead of sending it now. Keep the raw text so
  // inline skill / connector tokens are expanded fresh when it is sent.
  // References are captured into the queue sidecar at enqueue time. This
  // keeps each queued message tied to the selection visible when Send was
  // pressed, even if the composer draft is changed before queue drain.
  const recipientSnapshot = _takeRecipientSnapshotForSend('conversation');
  if (isConvPending(cid) || (messageQueues.get(cid) || []).length) {
    enqueueMessage(cid, requestText, null, {
      recipient: recipientSnapshot,
      attachmentItems: attachList.filter((attachment) => attachment.status !== 'error'),
      extra: {
        ...(attachments.length ? { attachments } : {}),
        ...(useSelections.length ? { use_selections: useSelections } : {}),
        ...(references.length ? { references } : {}),
      },
    });
    _clearQuotes(cid);
    if (attachments.length) _chatAttachClear(cid);
    input.value = '';
    autoGrow(input, 200);
    _clearDraft(cid);
    return;
  }

  const content = applyRecipientPrefix(
    transformWithChatUse(requestText),
    'conversation',
    { recipientSnapshot },
  );
  // Keep the authored composer state (raw text with inline use tokens, chips)
  // so stopping this turn can hand the message back for a quick edit.
  if (typeof _rememberSentComposerSnapshot === 'function') {
    _rememberSentComposerSnapshot(cid, {
      text: requestText,
      recipient: recipientSnapshot,
      references: quotes,
      attachments: attachList.filter((attachment) => attachment.status !== 'error'),
    });
  }
  _clearQuotes(cid);
  input.value = '';
  autoGrow(input, 200);
  _clearDraft(cid);
  // Clear chip area immediately — the server will return with the final
  // attachment state tied to the user message record. If the send fails or
  // is aborted, the files remain on disk but the user can re-attach via the
  // "+" button (listAttachments shows what's still there).
  if (attachments.length) _chatAttachClear(cid);
  const extra = {
    ...(attachments.length ? { attachments } : {}),
    ...(useSelections.length ? { use_selections: useSelections } : {}),
    ...(references.length ? { references } : {}),
  };
  await sendInCurrentConversation(content, Object.keys(extra).length ? extra : undefined);
}

// One transient controller per conversation send. Multi-cid support comes
// from keying this map on cid — user can send in A, navigate to B, and
// trigger a second send in B; each send owns its own controller with its
// own AbortController. Entries are dropped on done via the hooks below.
const _convChatCtrls = new Map();  // cid → controller

function _observerShouldDeferCleanup(cid, allowWithController) {
  return !!allowWithController && _convChatCtrls.has(cid);
}

const _taskTurnRuns = new Map();
const _TASK_TURN_PROCESS_MAX_ITEMS = 120;
const _TASK_TURN_PROCESS_MAX_CHARS = 500;

function _taskTurnRunId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) { /* ignore */ }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function _taskTurnStart(cid, content, extra, startedAt, context = {}) {
  if (!cid) return;
  const attachments = Array.isArray(extra && extra.attachments) ? extra.attachments.map(String) : [];
  const ts = Math.round(startedAt || Date.now());
  _taskTurnRuns.set(cid, {
    cid,
    runId: _taskTurnRunId(),
    userText: String(content || ''),
    startedAtMs: ts,
    messages: [{
      role: 'user',
      actor: 'user',
      text: String(content || ''),
      created_at_ms: ts,
      attachment_count: attachments.length,
      attachment_names: attachments,
      initial: true,
    }],
    messageKeys: new Set(['initial_user']),
    initialUserEventMatched: false,
    assistantMessages: [],
    agentIds: [],
    agentNameById: {},
    skillIds: [],
    skillNameById: {},
    toolNames: [],
    toolCallCount: 0,
    processEvents: [],
    processKeys: new Set(),
    attachmentNames: attachments,
    attachmentCount: attachments.length,
    errorMessage: '',
    errorType: '',
    errorStage: '',
    partial: false,
  });
}

function _taskTurnRun(cid) {
  return _taskTurnRuns.get(cid) || null;
}

function _taskTurnAgentName(actorId, cid) {
  const id = String(actorId || '').trim();
  if (!id || id === 'user') return '';
  if (id === 'commander') {
    return (typeof t === 'function') ? t('chat.from_commander') : 'Commander';
  }
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const found = _agentsCache.find((a) => a && a.agent_id === id);
    if (found && found.name) return String(found.name);
  }
  const cached = _groupMembersCache.get(cid || currentCid);
  if (cached) {
    const found = cached.find((a) => a && a.id === id);
    if (found && found.name) return String(found.name);
  }
  return '';
}

function _taskTurnSkillName(skillId) {
  const id = String(skillId || '').trim();
  if (!id) return '';
  const skills = _skillsForDisplayNameRewrite();
  const found = skills.find((s) => s && s.id === id);
  return found && found.name ? String(found.name) : '';
}

function _taskTurnAddAgent(run, actorId) {
  const id = String(actorId || '').trim();
  if (!id || id === 'user') return;
  if (!run.agentIds.includes(id)) run.agentIds.push(id);
  const name = _taskTurnAgentName(id, run.cid);
  if (name) run.agentNameById[id] = name;
}

function _taskTurnAddSkill(run, skillId, skillName) {
  const id = String(skillId || '').trim();
  if (!id) return;
  if (!run.skillIds.includes(id)) run.skillIds.push(id);
  const name = String(skillName || _taskTurnSkillName(id) || '').trim();
  if (name) run.skillNameById[id] = name;
}

function _taskTurnAddTool(run, name) {
  const n = String(name || '').trim().slice(0, 128);
  if (!n) return;
  if (!run.toolNames.includes(n)) run.toolNames.push(n);
}

function _taskTurnAddProcessLine(run, evData, lineText, evt) {
  if (!run || !lineText || run.processEvents.length >= _TASK_TURN_PROCESS_MAX_ITEMS) return;
  const text = _processLineText(lineText).replace(/\s+/g, ' ').trim();
  if (!text) return;
  const key = _groupEventDedupeKey(evData) || [
    evData && evData.actor || '',
    evt && evt.stream || '',
    text.slice(0, 180),
  ].join(':');
  if (key && run.processKeys.has(key)) return;
  if (key) run.processKeys.add(key);
  const actor = String(evData && evData.actor || '').slice(0, 128);
  run.processEvents.push({
    index: run.processEvents.length,
    actor: actor,
    actor_name: _taskTurnAgentName(actor, run.cid),
    kind: _eventProcessKind(evt, lineText) || _processKindOf(lineText) || '',
    text: text.length > _TASK_TURN_PROCESS_MAX_CHARS ? text.slice(0, _TASK_TURN_PROCESS_MAX_CHARS - 1) + '…' : text,
    created_at_ms: Date.now(),
  });
}

function _taskTurnMessageKey(role, gm, fallbackText) {
  if (gm && gm.id) return `${role}:id:${gm.id}`;
  return `${role}:${gm && gm.from ? gm.from : ''}:${gm && gm.ts ? gm.ts : ''}:${String(fallbackText || '').slice(0, 120)}`;
}

function _taskTurnAddMessage(run, msg) {
  if (!run || !msg) return;
  const role = msg.role === 'user' ? 'user' : 'assistant';
  const text = String(msg.text || '');
  if (!text.trim()) return;
  const key = msg.key || `${role}:${msg.actor || ''}:${msg.created_at_ms || ''}:${text.slice(0, 120)}`;
  if (run.messageKeys.has(key)) return;
  run.messageKeys.add(key);
  const actor = String(msg.actor || (role === 'user' ? 'user' : ''));
  const actorName = role === 'assistant'
    ? String(msg.actor_name || _taskTurnAgentName(actor, run.cid) || '').trim()
    : '';
  run.messages.push({
    role,
    actor,
    ...(actorName ? { actor_name: actorName } : {}),
    text,
    created_at_ms: Math.max(0, Math.round(Number(msg.created_at_ms) || Date.now())),
    ...(msg.message_id ? { message_id: String(msg.message_id).slice(0, 64) } : {}),
    ...(msg.partial ? { partial: true } : {}),
    ...(msg.attachment_count ? { attachment_count: msg.attachment_count } : {}),
    ...(Array.isArray(msg.attachment_names) && msg.attachment_names.length ? { attachment_names: msg.attachment_names.map(String) } : {}),
  });
}

function _taskTurnSampleMessage(msg) {
  const role = msg && msg.role === 'user' ? 'user' : 'assistant';
  const rawText = String(msg && msg.text || '');
  let text = rawText;
  if (role === 'user') {
    try {
      text = _stripUserStructuralBlocksForDisplay(rawText);
    } catch (_) {
      text = rawText;
    }
  }
  const actorName = role === 'assistant'
    ? String(msg && msg.actor_name || '').trim().slice(0, 128)
    : '';
  return {
    role,
    actor: String(msg && msg.actor || (role === 'user' ? 'user' : '')).slice(0, 128),
    ...(actorName ? { actor_name: actorName } : {}),
    text,
    created_at_ms: Math.max(0, Math.round(Number(msg && msg.created_at_ms) || 0)),
    ...(msg && msg.message_id ? { message_id: String(msg.message_id).slice(0, 64) } : {}),
    ...(msg && msg.partial ? { partial: true } : {}),
    ...(msg && msg.attachment_count ? { attachment_count: msg.attachment_count } : {}),
    ...(msg && Array.isArray(msg.attachment_names) && msg.attachment_names.length
      ? { attachment_names: msg.attachment_names.map(String) }
      : {}),
  };
}

function _taskTurnRecordProcess(run, evData) {
  const processData = evData && evData.data ? evData.data : {};
  let processLine = '';
  let processEvt = null;
  try {
    if (processData.type === 'progress' && processData.text) {
      processLine = String(processData.text || '');
    } else if (processData.type === 'event' && processData.event) {
      processEvt = processData.event;
      processLine = processEvt.stream === 'command_output' ? '' : (_formatEventLine(processEvt) || '');
    }
  } catch (_) {
    processLine = '';
  }
  if (processLine) _taskTurnAddProcessLine(run, evData, processLine, processEvt);
  const payload = processData && processData.event && typeof processData.event === 'object'
    ? processData.event
    : processData;
  const stream = String(payload.stream || '');
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const cliType = stream === 'cli' ? String(data.type || '').toLowerCase() : '';
  const phase = String(data.phase || data.status || '').toLowerCase();
  const isTool = stream === 'tool' || cliType === 'tool-event';
  if (!isTool) return;
  _taskTurnAddSkill(run, data.skill_id || data.skillId, data.skill_name || data.skillName);
  if (phase && !/^(start|running|request|call|begin)$/.test(phase)) return;
  run.toolCallCount += 1;
  _taskTurnAddTool(run, data.name || data.tool || data.tool_name || data.command || payload.name);
}

function _taskTurnRecordStreamEvent(cid, ev) {
  const run = _taskTurnRun(cid);
  if (!run || !ev) return;
  if (ev.type === 'final' && ev.text) {
    const text = String(ev.text || '');
    run.assistantMessages.push({ actor: '', text });
    _taskTurnAddMessage(run, {
      role: 'assistant',
      actor: '',
      text,
      created_at_ms: Date.now(),
      key: `assistant:final:${text.slice(0, 120)}`,
    });
    return;
  }
  if (ev.type === 'error') {
    run.errorMessage = String(ev.text || '');
    run.errorType = ev.aborted ? 'abort' : 'model_output';
    run.errorStage = 'stream_event';
    return;
  }
  const inner = ev.event || {};
  const evData = inner.stream === 'group' ? inner.data : null;
  if (!evData || typeof evData !== 'object') return;
  if (evData.type === 'message' && evData.msg && !evData.msg.dispatch) {
    const gm = evData.msg;
    const text = String(gm.text || '');
    const role = gm.from === 'user' ? 'user' : 'assistant';
    const actor = String(gm.from || evData.actor || (role === 'user' ? 'user' : ''));
    if (role === 'user') {
      if (!run.initialUserEventMatched && text === run.userText) {
        run.initialUserEventMatched = true;
        const first = run.messages.find((m) => m.initial);
        if (first) {
          first.created_at_ms = Math.max(0, Math.round(Number(gm.ts ? Date.parse(gm.ts) : 0) || first.created_at_ms || run.startedAtMs));
          if (gm.id) first.message_id = String(gm.id).slice(0, 64);
        }
        return;
      }
      _taskTurnAddMessage(run, {
        role: 'user',
        actor: 'user',
        text,
        created_at_ms: gm.ts ? Date.parse(gm.ts) : Date.now(),
        message_id: gm.id || '',
        key: _taskTurnMessageKey('user', gm, text),
        attachment_count: Array.isArray(gm.attachments) ? gm.attachments.length : 0,
        attachment_names: Array.isArray(gm.attachments) ? gm.attachments : [],
      });
    } else if (text.trim()) {
      _taskTurnAddAgent(run, actor);
      run.assistantMessages.push({ actor, text });
      _taskTurnAddMessage(run, {
        role: 'assistant',
        actor,
        text,
        created_at_ms: gm.ts ? Date.parse(gm.ts) : Date.now(),
        message_id: gm.id || '',
        key: _taskTurnMessageKey('assistant', gm, text),
        partial: !!evData.partial,
      });
    }
    return;
  }
  if (evData.type === 'process') {
    const processData = evData.data && typeof evData.data === 'object' ? evData.data : {};
    const processEvent = processData.event && typeof processData.event === 'object'
      ? processData.event
      : null;
    _taskTurnAddAgent(run, evData.actor);
    _taskTurnRecordProcess(run, evData);
    return;
  }
  if (evData.type === 'artifact_created') {
    _taskTurnAddAgent(run, evData.actor);
  }
}

function _taskTurnVisibleModelFailure(text) {
  const s = String(text || '');
  if (!s) return false;
  return /模型调用失败|Model (?:exceeded|failed|errored)|GenerateContentRequest|INVALID_ARGUMENT|Bad Request|ProviderError/i.test(s);
}

function _taskTurnFinish(cid, opts = {}) {
  const run = _taskTurnRun(cid);
  if (!run) return;
  _taskTurnRuns.delete(cid);
  void opts;
}

function _notifyAgentRunFinished(agentId, payload = {}) {
  const id = String(agentId || '');
  if (!id || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('orkas-agent-run-finished', {
      detail: { agent_id: id, ...payload },
    }));
  } catch (_) {}
}

function _makeConvChatController(cid, options = {}) {
  // Captured into the hooks below so we can compare identity before deleting
  // — see onDone for why.
  let self = null;
  let activePairId = '';
  // A queued turn can start after its owner tab has been left. Keep the
  // controller and stream lifecycle fully alive, but render its optimistic
  // nodes off-screen. If the user opens the conversation while it is running,
  // loadConversationHistory re-attaches pendingConvs.loadingEl and hydrates the
  // persisted user message into the real history container.
  const backgroundHistory = options.background === true
    ? document.createElement('div')
    : null;
  const ctrl = createChatController({
    historyEl: backgroundHistory || 'chat-history',
    inputEl: backgroundHistory ? null : 'chat-input',
    sendBtnEl: backgroundHistory ? null : 'chat-send-btn',
    getCurrentId: () => cid,
    historyEndpoint: (id) => _historyRequestUrl(id),
    streamEndpoint: (id) => `/api/conversations/${id}/send/stream`,
    features: {
      archive: true,
      scrollPin: true,
      bindInput: false,   // main chat owns its input wiring (queue-aware)
      actorIdentity: true,
    },
    hooks: {
      onUserAppended(userMsgEl, content, id) {
        // Remember the pair so server timestamp reconciliation can keep the
        // user bubble above its own live placeholder even if the persisted
        // user timestamp lands a few milliseconds later than the placeholder.
        activePairId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        userMsgEl.dataset.convPair = activePairId;
        try { window.ConversationTurnNav?.appendLiveTurn?.(id, userMsgEl, content); } catch (_) {}
      },
      onAssistantStart(msgEl, id) {
        // A new turn is starting for this conversation — clear any in-session
        // "failed" mark (also covers Retry, which routes back through here) so
        // the sidebar row drops its failure dot/label as it starts streaming.
        _failedConvs.delete(id);
        _settledConvTurns.delete(id);
        // New send → drop any stale per-actor placeholders left over from a
        // previous turn in this same conv. Their DOM is finalized (or
        // detached on conv switch); leaving them in `_groupPlaceholders`
        // would cause `_ensureActorPlaceholder` to return a finalized
        // bubble and write fresh deltas into the wrong row.
        for (const k of Array.from(_groupPlaceholders.keys())) {
          if (k.startsWith(`${id}|`)) _groupPlaceholders.delete(k);
        }
        // Bridge the controller's abort into the existing pendingConvs
        // state shape so legacy code (abortConvStream, sidebar badge,
        // polling recovery) keeps working untouched.
        pendingConvs.set(id, {
          loadingEl: msgEl,
          needsIndicator: false,
          startedAtMs: Date.now(),
          // Keep the controller that owns this exact send. Looking it up by
          // cid at abort time can target a newer queued send after the map is
          // replaced by its controller.
          controller: self,
          aborted: false,
        });
        if (typeof options.onStarted === 'function') {
          try { options.onStarted(); } catch (_) {}
        }
        if (activePairId) msgEl.dataset.convPair = activePairId;
        _lastGroupWorkEventAt.set(id, Date.now());
        _updateConvSendUI(id);
        _updateConvSidebarBadge(id, true);
        // The send stream carries lifecycle only (see ipc `conversations.sendStream`),
        // so the bus observer must be attached here — it is the only source of
        // process/delta/message events for this turn. Attaching at send time
        // rather than waiting for a `state_changed` also removes the old
        // bootstrap dependency: that event used to arrive over the send stream,
        // which no longer relays anything.
        _observeConversationRunFromPlanAction(id, {
          attachExisting: true,
          allowWithController: true,
        });
        startPolling(id);
        _startRuntimeActorRecovery(id);
      },
      onAbort(msgEl, id) {
        const state = pendingConvs.get(id);
        if (state) state.aborted = true;
        // `onDone` is the single owner of task settlement and queue drain.
        // Finishing here used to start the next queued send before the old
        // controller's finally/onDone ran, allowing that stale callback to
        // clear and settle the new send.
      },
      onStreamEvent() {},
      onError(text, _msgEl, id) {
        const run = _taskTurnRun(id);
        if (run) {
          run.errorMessage = String(text || '');
          run.errorType = 'model_output';
          run.errorStage = 'stream';
        }
      },
      onDone(msgEl, id, result = {}) {
        // Final cleanup is owned by the controller that still represents this
        // conversation's active send.
        // `_finishStreamingMsg` releases the OLD pin before it synchronously
        // drains the next queued message (`_dispatchNextQueued` → new
        // `ctrl.send`). We must NOT release again after it returns: the new
        // turn may already have appended its user bubble and scheduled its
        // own scroll pin.
        // A stale controller must never settle or clear a newer send for the
        // same conversation. Reuse the existing controller identity instead
        // of introducing another run token.
        if (_convChatCtrls.get(id) === self) {
          if (
            result
            && result.errored
            && !result.aborted
            && !_hasAuthoritativeCleanSettlement(id)
          ) {
            _setConvTurnSettlement(id, 'failed', {
              source: 'transport',
              finishedAtMs: 0,
            });
          }
          _finishStreamingMsg(id);
          // `_finishStreamingMsg` can synchronously start the next queued
          // controller. Delete only if the map still belongs to this send.
          if (_convChatCtrls.get(id) === self) _convChatCtrls.delete(id);
        }
        if (typeof options.onDone === 'function') {
          try { options.onDone(result); } catch (_) {}
        }
      },
    },
  });
  self = ctrl;
  return ctrl;
}

async function sendInConversation(cid, content, extra, options = {}) {
  if (!cid) return { started: false, aborted: false, errored: false, result: 'failure' };
  const startedAt = performance.now();
  const sendOptions = options && typeof options === 'object' ? options : {};
  const modelTelemetry = _chatModelTelemetryContext(sendOptions);
  const entryAttribution = _normalizeCommanderTemplateAttribution(sendOptions);
  const statAgentId = String(sendOptions.agent_id || '');
  let doneResult = null;
  let taskStarted = false;
  const attachmentCount = Array.isArray(extra && extra.attachments) ? extra.attachments.length : 0;
  const measuredContentLength = Number.isFinite(Number(sendOptions.content_length))
    ? Math.max(0, Math.round(Number(sendOptions.content_length)))
    : String(content || '').length;
  if (isConvPending(cid)) {
    // Queued input starts a new execution stream after the current one ends,
    // so it must not be merged into the active task-turn sample.
    enqueueMessage(cid, content, '', { direct: true, extra });
    return { started: false, queued: true, aborted: false, errored: false };
  }

  // Scroll-pin spacer is owned by the controller (features.scrollPin) —
  // appending it here would land *before* userMsg/asstMsg in DOM order,
  // padding the top instead of the bottom and defeating the pin.

  const ctrl = _makeConvChatController(cid, {
    background: sendOptions.background === true,
    onStarted() {
      taskStarted = true;
      if (typeof sendOptions.onStarted === 'function') {
        try { sendOptions.onStarted(); } catch (_) {}
      }
    },
    onDone(result = {}) {
      doneResult = result || {};
      if (typeof sendOptions.onDone === 'function') {
        try { sendOptions.onDone(doneResult); } catch (_) {}
      }
    },
  });
  _convChatCtrls.set(cid, ctrl);
  try {
    const controllerResult = await ctrl.send(content, extra);
    const terminal = doneResult || controllerResult || {
      started: false,
      aborted: false,
      errored: true,
      reason: 'unknown',
    };
    const durationMs = Math.round(performance.now() - startedAt);
    const started = terminal.started !== false && taskStarted;
    const aborted = !!terminal.aborted;
    const errored = !!terminal.errored || !started;
    const result = aborted ? 'cancelled' : (errored ? 'failure' : 'success');
    const terminalReason = String(terminal.reason || '');
    const failureReason = started
      ? 'stream_error'
      : terminalReason === 'model_not_configured'
        ? 'model_not_configured'
        : 'stream_not_started';
    if (statAgentId) {
      _notifyAgentRunFinished(statAgentId, {
        duration_ms: durationMs,
        aborted,
        errored,
        success: !aborted && !errored,
      });
    }
    if (!started && _convChatCtrls.get(cid) === ctrl) _convChatCtrls.delete(cid);
    return { ...terminal, started, aborted, errored, result };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    if (statAgentId) {
      _notifyAgentRunFinished(statAgentId, {
        duration_ms: durationMs,
        errored: true,
        success: false,
      });
    }
    if (window.Monitor) {
      (() => {})('chat_send_result', {
        result: 'failure',
        conversation_id: cid,
        source_view: sendOptions.source_view || 'conversation',
        content_length: measuredContentLength,
        attachment_count: attachmentCount,
        duration_ms: durationMs,
        failure_stage: taskStarted ? 'stream' : 'preflight',
        failure_reason: taskStarted ? 'stream_error' : 'stream_not_started',
        ...modelTelemetry,
        ...entryAttribution,
      });
      (() => {})('chat_send', {
        conversation_id: cid,
        error_type: 'stream',
        error_message: err && err.message ? err.message : String(err),
        ...entryAttribution,
      });
    }
    if (taskStarted && _convChatCtrls.get(cid) === ctrl) {
      _finishStreamingMsg(cid);
    }
    if (_convChatCtrls.get(cid) === ctrl) _convChatCtrls.delete(cid);
    throw err;
  }
}

async function sendInCurrentConversation(content, extra, options = {}) {
  const sendOptions = options && typeof options === 'object' ? { ...options } : {};
  if (!sendOptions.agent_id) {
    try {
      const recipient = getChatRecipient('conversation');
      if (recipient && recipient.kind === 'agent' && recipient.id) sendOptions.agent_id = recipient.id;
    } catch (_) {}
  }
  return sendInConversation(currentCid, content, extra, sendOptions);
}

function _removeEmptyStreamingPlaceholder(ph) {
  if (!ph || !ph.parentElement || ph.dataset.finalized === '1') return;
  const processBody = ph.querySelector('[data-role="process"]');
  const hasProcess = !!processBody && processBody.children.length > 0;
  const finalBody = ph.querySelector('[data-role="final"]');
  const hasFinal = !!finalBody && (finalBody.textContent || '').trim().length > 0;
  const hasAbortNote = !!ph.querySelector('.stream-aborted-note');
  if (hasProcess || hasFinal || hasAbortNote) return;
  for (const [key, val] of Array.from(_groupPlaceholders.entries())) {
    if (val === ph) _groupPlaceholders.delete(key);
  }
  ph.remove();
}

/** Drop this actor's live rows that carry nothing to read. Used when a runtime
 * snapshot says the actor is no longer working, so a "thinking" row it never
 * filled does not linger. Rows with content, persisted rows and intentionally
 * frozen silent trails are left alone. */
function _removeEmptyActorPlaceholder(cid, actorId) {
  if (!cid || !actorId) return;
  const container = document.getElementById('chat-history');
  if (!container) return;
  const nodes = container.querySelectorAll(
    `.chat-message[data-render-key][data-from-actor="${CSS.escape(String(actorId))}"]:not([data-msg-id])`,
  );
  for (const ph of Array.from(nodes)) {
    const key = ph.dataset.renderKey || '';
    _removeEmptyStreamingPlaceholder(ph);
    if (!ph.parentElement) _groupPlaceholders.delete(_phKey(cid, key));
  }
}

function _settleDanglingActorPlaceholders(cid, opts = {}) {
  if (!cid) return;
  const preserveProcess = opts.preserveProcess === true;
  // Stream-termination sweep. Normal turn ends are handled by identity: a
  // persisted record claims its own row, and `turn_silent` disposes of the rows
  // a silent turn left behind. What is left for this pass is the abnormal exit
  // — the stream died without a terminal event — where a live row would
  // otherwise stay "thinking" forever. Persisted rows (`data-msg-id`) and
  // intentionally frozen silent trails (`data-frozen-silent`) are never swept.
  //
  // The sweep removes rather than re-renders. Renderer and bus strip structural
  // blocks differently (the renderer respects markdown fences so protocol
  // examples survive; the bus strips unconditionally because the file was
  // actually written), so re-rendering a live buffer could surface block bodies
  // the persisted record does not contain. The persisted row carries the
  // canonical text either way.
  const container = document.getElementById('chat-history');
  if (!container) return;
  const orphans = container.querySelectorAll(
    '.chat-message[data-from-actor]:not([data-msg-id]):not([data-frozen-silent="1"])',
  );
  const preserved = new Set();
  for (const el of Array.from(orphans)) {
    const processBody = el.querySelector('[data-role="process"]');
    const hasProcess = !!processBody && processBody.children.length > 0;
    const finalBody = el.querySelector('[data-role="final"]');
    const hasFinalText = !!finalBody && (finalBody.textContent || '').trim().length > 0;
    // User abort closes the renderer stream before the main process has
    // finished unwinding and persisting the terminal message. Keep the live
    // bubble (and its map entry) during that gap so the later `message` event
    // can consume/finalize it in place. Empty queued-worker placeholders are
    // still removed immediately.
    if (preserveProcess && (hasProcess || hasFinalText)) {
      preserved.add(el);
      continue;
    }
    el.remove();
  }
  // Map cleanup (state hygiene). Retain only connected process-bearing
  // placeholders explicitly preserved above; everything else is stale after
  // stream termination.
  for (const [key, ph] of Array.from(_groupPlaceholders.entries())) {
    if (!key.startsWith(`${cid}|`)) continue;
    if (preserved.has(ph) && ph?.parentElement) continue;
    _groupPlaceholders.delete(key);
  }
  const purgedCount = orphans.length - preserved.size;
  if (purgedCount > 0) {
    _convLog.info('orphan placeholders purged', { cid, count: purgedCount, preserved: preserved.size });
  }
}

function _nowForStreamYield() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function _makeStreamPaintYield() {
  let eventsSinceYield = 0;
  let lastYieldAt = _nowForStreamYield();
  return function maybeYieldToPaint() {
    eventsSinceYield += 1;
    const now = _nowForStreamYield();
    if (eventsSinceYield < 32 && now - lastYieldAt < 24) return null;
    eventsSinceYield = 0;
    lastYieldAt = now;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
      setTimeout(finish, 16);
    });
  };
}

function _observeConversationRunFromPlanAction(cid, opts = {}) {
  if (!cid) return null;
  const attachExisting = !!opts.attachExisting;
  const allowWithController = !!opts.allowWithController;
  if (_convChatCtrls.has(cid) && !allowWithController) return null;
  if (allowWithController && _groupObserverCtrls.has(cid)) return null;
  if (!attachExisting && (pendingConvs.has(cid) || isGroupConversationBusy(cid))) return null;

  const controller = new AbortController();
  let msgEl = null;
  let sawActivity = attachExisting;
  let settled = false;
  let activated = false;

  const ctrl = {
    abort: () => {
      try { controller.abort(); } catch (_) {}
    },
  };
  if (allowWithController) _groupObserverCtrls.set(cid, ctrl);

  const activate = () => {
    if (activated || controller.signal.aborted) return;
    const existing = pendingConvs.get(cid) || {};
    if (existing.aborted) return;
    activated = true;
    const container = document.getElementById('chat-history');
    msgEl = existing.loadingEl || (cid === currentCid
      ? _createStreamingAssistantMessage(container, { hiddenUntilActor: true })
      : null);
    if (!allowWithController) {
      _convChatCtrls.set(cid, ctrl);
    }
    pendingConvs.set(cid, {
      ...existing,
      loadingEl: msgEl,
      needsIndicator: false,
      startedAtMs: Number(existing.startedAtMs || Date.now()),
      controller: allowWithController ? (existing.controller || ctrl) : ctrl,
      aborted: false,
    });
    setGroupConversationBusy(cid, true);
    _updateConvSidebarBadge(cid, true);
    startPolling(cid);
    if (cid === currentCid) _updateConvSendUI(cid);
  };

  const noActivityTimer = setTimeout(() => {
    if (!sawActivity && !settled) ctrl.abort();
  }, 30000);

  if (attachExisting) activate();

  (async () => {
    try {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/events/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ untilIdle: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      const maybeYieldToPaint = _makeStreamPaintYield();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent.split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          let evData;
          try { evData = JSON.parse(dataLines.join('\n')); }
          catch (_) { continue; }
          if (!evData || evData.type === 'done') continue;
          if (controller.signal.aborted || pendingConvs.get(cid)?.aborted) continue;
          if (evData.type === 'process') {
            sawActivity = true;
          }
          if (evData.type === 'artifact_created') sawActivity = true;
          if (evData.type === 'message' && evData.msg && evData.msg.from !== 'user') sawActivity = true;
          if (evData.type === 'state_changed') {
            const st = evData.state || {};
            const inFlight = Array.isArray(st.in_flight) ? st.in_flight : [];
            const activeTurns = _normaliseActiveTurns(evData.active_turns);
            if (st.status === 'running' || inFlight.length > 0 || activeTurns.length > 0) sawActivity = true;
          }
          if (sawActivity) activate();
          // The primary send stream owns the process rail while it is alive.
          if (allowWithController && _convChatCtrls.has(cid) && _isPrimaryOwnedLiveEvent(evData)) {
            continue;
          }
          _handleGroupBusEvent(cid, msgEl, evData, { archive: true });
          const paintWait = maybeYieldToPaint();
          if (paintWait) await paintWait;
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && !controller.signal.aborted) {
        _convLog.warn(`plan recovery event stream failed cid=${cid}: ${err && err.message}`);
        if (msgEl && msgEl.parentElement && msgEl.dataset.finalized !== '1') {
          _streamingSetError(msgEl, err?.message || String(err));
        }
      }
    } finally {
      settled = true;
      clearTimeout(noActivityTimer);
      // Whether this observer is still the conversation's current one. A newer
      // send registers its own observer, and once that happens every global
      // teardown below belongs to that newer run, not to this finishing one.
      const supersededByNewerRun = allowWithController && _groupObserverCtrls.get(cid) !== ctrl;
      if (allowWithController) {
        if (_groupObserverCtrls.get(cid) === ctrl) _groupObserverCtrls.delete(cid);
      } else if (_convChatCtrls.get(cid) === ctrl) {
        _convChatCtrls.delete(cid);
      }
      if (activated) {
        // Tearing down here would abort the NEWER observer (`_finishStreamingMsg`
        // stops by cid, not by identity). Since that observer is now the only
        // source of process/message events for the live turn, its reply would
        // never reach the transcript even though the bus persisted it.
        if (supersededByNewerRun) {
          if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid, { silent: true });
          return;
        }
        if (_observerShouldDeferCleanup(cid, allowWithController)) {
          if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid, { silent: true });
          return;
        }
        setGroupConversationBusy(cid, false);
        _removeEmptyStreamingPlaceholder(msgEl);
        _finishStreamingMsg(cid);
        if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid, { silent: true });
      }
    }
  })();

  return { cancel: ctrl.abort };
}

window.ConversationRuntime = {
  ...(window.ConversationRuntime || {}),
  abortConversation: abortConvStream,
  observePlanRecoveryRun: _observeConversationRunFromPlanAction,
};

const _chatScrollOffsetObservers = new WeakMap();

function _cancelScheduledChatScrollPin(container) {
  if (!container) return 0;
  container._scrollPinScheduleEpoch = Number(container._scrollPinScheduleEpoch || 0) + 1;
  if (container._scrollPinOuterRaf != null && typeof cancelAnimationFrame === 'function') {
    try { cancelAnimationFrame(container._scrollPinOuterRaf); } catch (_) {}
  }
  if (container._scrollPinInnerRaf != null && typeof cancelAnimationFrame === 'function') {
    try { cancelAnimationFrame(container._scrollPinInnerRaf); } catch (_) {}
  }
  container._scrollPinOuterRaf = null;
  container._scrollPinInnerRaf = null;
  return container._scrollPinScheduleEpoch;
}

function _stopChatScrollOffsetObserver(container) {
  const state = _chatScrollOffsetObservers.get(container);
  if (!state) return;
  if (state.raf != null && state.rafKind === 'frame' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(state.raf);
  } else if (state.raf != null && state.rafKind === 'timeout') {
    clearTimeout(state.raf);
  }
  try { state.mutation?.disconnect?.(); } catch (_) {}
  try { state.resize?.disconnect?.(); } catch (_) {}
  _chatScrollOffsetObservers.delete(container);
}

function _scheduleChatScrollOffsetRefresh(container) {
  const state = _chatScrollOffsetObservers.get(container);
  if (!state || state.raf != null) return;
  const run = () => {
    state.raf = null;
    state.rafKind = null;
    if (!container.isConnected || !container.querySelector(':scope > .chat-scroll-spacer')) {
      _stopChatScrollOffsetObserver(container);
      return;
    }
    _setChatScrollOffset(true, container);
  };
  if (typeof requestAnimationFrame === 'function') {
    state.rafKind = 'frame';
    state.raf = requestAnimationFrame(run);
  } else {
    state.rafKind = 'timeout';
    state.raf = setTimeout(run, 0);
  }
}

function _watchChatScrollOffset(container, lastUser, spacer) {
  if (!container || !lastUser || !spacer) return;
  let state = _chatScrollOffsetObservers.get(container);
  if (!state) {
    state = { mutation: null, resize: null, raf: null, rafKind: null, observed: new Set() };
    if (typeof MutationObserver === 'function') {
      state.mutation = new MutationObserver(() => _scheduleChatScrollOffsetRefresh(container));
      state.mutation.observe(container, { childList: true, characterData: true, subtree: true });
    }
    if (typeof ResizeObserver === 'function') {
      state.resize = new ResizeObserver(() => _scheduleChatScrollOffsetRefresh(container));
    }
    _chatScrollOffsetObservers.set(container, state);
  }
  if (!state.resize) return;
  const nextObserved = new Set();
  let n = lastUser;
  while (n && n !== spacer) {
    nextObserved.add(n);
    n = n.nextElementSibling;
  }
  for (const el of state.observed) {
    if (!nextObserved.has(el)) {
      try { state.resize.unobserve(el); } catch (_) {}
    }
  }
  for (const el of nextObserved) {
    if (!state.observed.has(el)) {
      try { state.resize.observe(el); } catch (_) {}
    }
  }
  state.observed = nextObserved;
}

// Append/remove a sized spacer as the last child of the messages container
// so a short user message can still scroll to the very top. This is a
// one-shot positioning helper for send time; streaming output must not keep
// refreshing the spacer or auto-follow to the bottom.
function _setChatScrollOffset(on, containerOrId = 'chat-history') {
  const container = typeof containerOrId === 'string'
    ? document.getElementById(containerOrId)
    : containerOrId;
  if (!container) return;
  const existing = container.querySelector(':scope > .chat-scroll-spacer');
  if (!on) {
    _cancelScheduledChatScrollPin(container);
    container._scrollPinActive = false;
    delete container._scrollPinTargetTop;
    _stopChatScrollOffsetObserver(container);
    if (existing) existing.remove();
    return;
  }
  container._scrollPinActive = true;
  const spacer = existing || document.createElement('div');
  if (!existing) {
    spacer.className = 'chat-scroll-spacer';
    container.appendChild(spacer);
  }
  const userMsgs = container.querySelectorAll(':scope > .chat-message.user');
  const lastUser = userMsgs[userMsgs.length - 1];
  if (!lastUser) return;

  // Top up the exact missing scroll range. Subtracting the current spacer
  // height gives the natural scroll range without temporarily zeroing the
  // spacer (which would clamp scrollTop and cause a jump mid-stream).
  const oldHeight = Number.parseFloat(spacer.style.height || '0') || 0;
  const containerRect = container.getBoundingClientRect();
  const msgRect = lastUser.getBoundingClientRect();
  const targetScrollTop = msgRect.top - containerRect.top + container.scrollTop - 24;
  const naturalScrollHeight = Math.max(0, container.scrollHeight - oldHeight);
  const naturalMaxScrollTop = Math.max(0, naturalScrollHeight - container.clientHeight);
  const needed = Math.max(0, targetScrollTop - naturalMaxScrollTop);
  spacer.style.height = `${needed}px`;
  container._scrollPinTargetTop = targetScrollTop;
  // Place the sent user message near the top once. Later stream mutations
  // leave the outer chat scroll alone.
  const isStillFollowingPin = Math.abs(container.scrollTop - targetScrollTop) <= 48
    || _isNearBottom(container);
  if (_isStickyPausedByUser(container)) return;
  if (!isStillFollowingPin) return;
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(container);
  container.scrollTop = targetScrollTop;
  if (prev) container.style.scrollBehavior = prev;
  else container.style.removeProperty('scroll-behavior');
}

// Append `msg` into `container` BEFORE the scroll-pin spacer (if present).
// `_setChatScrollOffset(true)` parks a `.chat-scroll-spacer` at the end of
// chat-history to give short user messages enough room to pin to the top
// during streaming. Naive `container.appendChild(msg)` would put new bubbles
// AFTER that spacer — visually a large blank gap appears between the
// previous bubble and the new one until streaming ends and the spacer is
// removed. Inserting before the spacer keeps the bubble flow contiguous.
function _appendBeforeSpacer(container, msg) {
  const spacer = container.querySelector(':scope > .chat-scroll-spacer');
  if (spacer) container.insertBefore(msg, spacer);
  else container.appendChild(msg);
}

/** Insert a bubble into chat-history at its correct chronological position
 *  based on `data-ts` (ms since epoch). Replaces the older "finalized goes
 *  before live placeholders" heuristic, which had two mutually exclusive
 *  cases:
 *    - Multi-agent burst (commander dispatches A/B/C in quick succession,
 *      each followed by that agent's state_changed): we wanted dispatches
 *      grouped above placeholders.
 *    - Single commander turn: placeholder created at turn-start (~early
 *      ts), plan announcement emitted later (~mid-turn ts) → we want
 *      placeholder ABOVE the announcement.
 *  Time-stamp sort handles BOTH naturally — earlier ts comes first. The
 *  bubble carries `data-ts` set by its creator (state_changed → Date.now()
 *  for placeholders, or `gm.ts` for finalized messages).
 *
 *  Insertion: scan top-down for the first existing bubble whose ts is
 *  STRICTLY LATER than the new one; insert before that. Equal-ts bubbles
 *  preserve insertion order (renderer-arrival sequence as tiebreak). If
 *  no later bubble exists, append at end (before the scroll-pin spacer).
 *
 *  Bubbles without `data-ts` (legacy / history-load) are treated as
 *  earlier-than-anything new — new bubbles always append after them. */
function _insertByTimestamp(container, msg) {
  const newTs = Number(msg.dataset.ts || 0);
  const children = container.querySelectorAll(':scope > .chat-message[data-ts]');
  for (const existing of children) {
    const existingTs = Number(existing.dataset.ts || 0);
    if (existingTs > newTs) {
      container.insertBefore(msg, existing);
      return;
    }
  }
  _appendBeforeSpacer(container, msg);
}

function _isTimestampPositionCorrect(container, msg) {
  if (!container || !msg || msg.parentElement !== container) return false;
  const msgTs = Number(msg.dataset.ts || 0);
  let prev = msg.previousElementSibling;
  while (prev && !prev.matches?.('.chat-message[data-ts]')) prev = prev.previousElementSibling;
  let next = msg.nextElementSibling;
  while (next && !next.matches?.('.chat-message[data-ts]')) next = next.nextElementSibling;
  const prevOk = !prev || Number(prev.dataset.ts || 0) <= msgTs;
  const nextOk = !next || Number(next.dataset.ts || 0) >= msgTs;
  return prevOk && nextOk;
}

// A send-now user message can land after an already-mounted assistant
// placeholder. Mark only the live rows in that active-turn block; their next
// visible update will cross this user-message floor and move below it. Keeping
// the trigger on the user boundary avoids touching `data-ts` or reordering DOM
// on every token once the row is already current.
function _markEarlierLiveMessagesForUser(container, userEl) {
  if (!container || !userEl || userEl.parentElement !== container) return 0;
  const userTs = Number(userEl.dataset.ts || 0);
  if (!Number.isFinite(userTs) || userTs <= 0) return 0;
  let marked = 0;
  let crossedLiveRow = false;
  for (let prev = _previousChatMessage(userEl); prev; prev = _previousChatMessage(prev)) {
    // Multiple send-now messages may arrive before the actor emits again.
    // Cross those newer user rows until the active placeholder is found, then
    // stop at the user message that originally started this live block.
    if (_hasChatMessageClass(prev, 'user')) {
      if (crossedLiveRow) break;
      continue;
    }
    if (!_isLivePlaceholderMessage(prev)) continue;
    crossedLiveRow = true;
    const prevTs = Number(prev.dataset.ts || 0);
    if (Number.isFinite(prevTs) && prevTs > userTs) continue;
    const oldFloor = Number(prev.dataset.activitySortFloor || 0);
    prev.dataset.activitySortFloor = String(Math.max(userTs, oldFloor || 0));
    marked += 1;
  }
  return marked;
}

// Promote a marked live row at most once for each newer user message. The hot
// stream path is O(1): absent a floor this returns immediately; after a floor
// is consumed it checks only adjacent message nodes. A full timestamp scan and
// DOM move happen only when the row actually crosses that user boundary.
function _advanceStreamingMessageActivityPosition(msg, activityAt = Date.now()) {
  if (!_isLivePlaceholderMessage(msg) || !msg.parentElement) return false;
  const floorTs = Number(msg.dataset.activitySortFloor || 0);
  if (!Number.isFinite(floorTs) || floorTs <= 0) return false;
  const currentTs = Number(msg.dataset.ts || 0);
  const activityTs = _msTs(activityAt);
  msg.dataset.ts = String(Math.max(
    activityTs,
    floorTs + 1,
    Number.isFinite(currentTs) ? currentTs + 1 : 0,
  ));
  delete msg.dataset.activitySortFloor;
  const container = msg.parentElement;
  if (_isTimestampPositionCorrect(container, msg)) return false;
  _insertByTimestamp(container, msg);
  return true;
}

function _isChatMessageEl(el) {
  return !!(el && el.classList && el.classList.contains('chat-message'));
}

function _hasChatMessageClass(el, cls) {
  return !!(_isChatMessageEl(el) && el.classList.contains(cls));
}

function _previousChatMessage(el) {
  let prev = el ? el.previousElementSibling : null;
  while (prev && !_isChatMessageEl(prev)) prev = prev.previousElementSibling;
  return prev || null;
}

function _removeSupersededInterruptionBubbles(container) {
  if (!container?.querySelectorAll) return 0;
  const pendingByActor = new Map();
  const liveByActor = new Set();
  let removed = 0;
  const messages = Array.from(container.querySelectorAll(':scope > .chat-message'));
  for (const el of messages) {
    if (_hasChatMessageClass(el, 'user')) {
      pendingByActor.clear();
      liveByActor.clear();
      continue;
    }
    if (!_hasChatMessageClass(el, 'assistant')) continue;
    const actor = String(el.dataset.fromActor || el.dataset.from || '');
    if (el.dataset.systemKind === 'reply_interrupted') {
      // A boot-maintenance race used to append a false interruption below a
      // still-running placeholder. Never show that as a second bubble. The
      // polling path defers the record too; this DOM guard repairs an already
      // mounted row from an earlier poll without discarding the process rail.
      if (liveByActor.has(actor)) {
        el.remove();
        removed += 1;
        continue;
      }
      const previous = pendingByActor.get(actor);
      if (previous?.parentElement === container) {
        previous.remove();
        removed += 1;
      }
      pendingByActor.set(actor, el);
      continue;
    }
    const superseded = pendingByActor.get(actor);
    if (superseded?.parentElement === container) {
      superseded.remove();
      removed += 1;
    }
    pendingByActor.delete(actor);
    if (el.dataset.placeholder === '1' && el.dataset.finalized !== '1') {
      liveByActor.add(actor);
    } else {
      liveByActor.delete(actor);
    }
  }
  return removed;
}

function _isLivePlaceholderMessage(el) {
  return _hasChatMessageClass(el, 'assistant')
    && el?.dataset?.placeholder === '1'
    && el.dataset.finalized !== '1';
}

function _placeholderBlockHasTriggerUser(firstPlaceholder) {
  for (let prev = _previousChatMessage(firstPlaceholder); prev; prev = _previousChatMessage(prev)) {
    if (_hasChatMessageClass(prev, 'user')) return true;
    if (_hasChatMessageClass(prev, 'assistant') && !_isLivePlaceholderMessage(prev)) return false;
  }
  return false;
}

// A relay/recovery path can learn "someone is thinking" before the matching
// user message is rendered. If that placeholder has no user trigger between
// it and the previous finalized assistant reply, put the late user bubble
// back where the transcript naturally reads.
function _moveUserBeforeOrphanLivePlaceholder(container, userEl) {
  if (!container || !userEl || userEl.parentElement !== container || !_hasChatMessageClass(userEl, 'user')) {
    return false;
  }
  const prev = _previousChatMessage(userEl);
  if (!_isLivePlaceholderMessage(prev)) return false;
  let firstPlaceholder = prev;
  for (let p = _previousChatMessage(firstPlaceholder); _isLivePlaceholderMessage(p); p = _previousChatMessage(firstPlaceholder)) {
    firstPlaceholder = p;
  }
  const userPair = String(userEl.dataset.convPair || '');
  const userMsgId = String(userEl.dataset.msgId || '');
  const placeholderBlock = [];
  for (let p = prev; _isLivePlaceholderMessage(p); p = _previousChatMessage(p)) {
    placeholderBlock.unshift(p);
  }
  const sameOptimisticPair = !!userPair && placeholderBlock.some((ph) => userPair === String(ph.dataset.convPair || ''));
  if (sameOptimisticPair) {
    container.insertBefore(userEl, firstPlaceholder);
    return true;
  }
  const sameTriggerMsg = !!userMsgId && placeholderBlock.some((ph) => userMsgId === String(ph.dataset.triggerMsgId || ''));
  if (sameTriggerMsg) {
    container.insertBefore(userEl, firstPlaceholder);
    return true;
  }
  if (_placeholderBlockHasTriggerUser(firstPlaceholder)) return false;
  const userTs = Number(userEl.dataset.ts || 0);
  const placeholderTs = Number(firstPlaceholder.dataset.ts || 0);
  if (Number.isFinite(userTs) && Number.isFinite(placeholderTs) && userTs > placeholderTs) return false;
  container.insertBefore(userEl, firstPlaceholder);
  return true;
}

/** Convert various ts representations (ISO string, numeric ms, undefined)
 *  to ms-since-epoch for sortable comparison. Falls back to `Date.now()`
 *  so a missing ts pins the bubble at the moment of creation rather than
 *  at the dawn of time. */
function _msTs(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const ms = Date.parse(input);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function _createStreamingAssistantMessage(container, opts = {}) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) container = document.getElementById('chat-history');
  const emptyEl = container.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const msg = document.createElement('div');
  msg.className = 'chat-message assistant';
  // The streaming placeholder mirrors the bubble layout from
  // appendChatMessage: header strip (sender chip + time) inside the
  // bubble, then process / thinking / final body. The from chip stays
  // empty until we know which actor (commander vs an agent) produced the
  // first reply — _handleGroupBusEvent.message replaces this whole bubble
  // with a freshly-rendered one carrying the right name.
  // Header is intentionally empty until we know who's actually working.
  // The bus may route the user's `@<name>` message to commander OR an
  // agent depending on resolution; hard-coding "commander" misled the user
  // when @-routing succeeded. Once the first state_changed event
  // identifies the in-flight actor we'll fill the chip in (see
  // _handleGroupBusEvent's state_changed branch).
  msg.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-avatar-slot" data-role="from-avatar"></span>
      <span class="chat-msg-from" data-role="from-chip"></span>
      <span class="chat-msg-time">${formatTime(new Date().toISOString())}</span>
    </div>
    <div class="chat-bubble">
      <details class="stream-process" data-role="process-container" open style="display:none">
        <summary class="stream-process-summary">
          <span class="stream-process-caret" aria-hidden="true">${_uiIconHtml('chevron-right', 'ui-icon stream-process-caret-icon')}</span>
          <span class="stream-process-label">${escapeHtml(t('chat.process_info'))}</span>
          <span class="stream-process-runtime" hidden></span>
        </summary>
        <div class="stream-process-body" data-role="process"></div>
      </details>
      <div class="stream-activity" data-role="activity" style="display:none">
        <span class="stream-activity-pulse" aria-hidden="true"></span>
        <span class="stream-activity-text" data-role="activity-text"></span>
      </div>
      <div class="stream-final" data-role="final" style="display:none"></div>
      <div class="stream-thinking" data-role="thinking" aria-label="${escapeHtml(t('chat.thinking_short'))}">
        <span class="stream-thinking-dot"></span>
        <span class="stream-thinking-dot"></span>
        <span class="stream-thinking-dot"></span>
      </div>
    </div>
  `;
  msg.dataset.placeholder = '1';
  if (opts.messageActions === 'errors-only') msg.dataset.messageActions = 'errors-only';
  if (typeof opts.failedRetryHandler === 'function') msg._failedRetryHandler = opts.failedRetryHandler;
  if (Object.prototype.hasOwnProperty.call(opts, 'feedbackConversationId')) {
    msg.dataset.feedbackConversationId = String(opts.feedbackConversationId || '');
  }
  _stampPlaceholderTriggerMsg(msg, opts.triggerMsgId);
  if (opts.hiddenUntilActor) {
    msg.dataset.identityPending = '1';
    msg.style.display = 'none';
  }
  // Pin placeholder by creation time so `_insertByTimestamp` keeps it in
  // chronological order with surrounding messages. Updated to the actual
  // gm.ts when the placeholder finalizes (so the bubble's position settles
  // to where it belongs once we know the message's true timestamp).
  msg.dataset.ts = String(Date.now());
  _appendBeforeSpacer(container, msg);
  return msg;
}

function _hideThinking(msg) {
  const thinking = msg.querySelector('[data-role="thinking"]');
  if (thinking) thinking.style.display = 'none';
}

const _PROCESS_GLYPH_KIND = {
  '\u25EF': 'err',
  '\u2717': 'err',
  '\u25CB': 'warn',
  '\u25C9': 'patch',
  '\u25A0': 'tool',
  '\u25B7': 'out',
  '\u25C6': 'think',
  '\u25C7': 'info',
  '\u25B6': 'bound',
  '\u25CF': 'bound',
  '\u25A3': 'plan',
  '\u25D0': 'live',
  '\u25AA': 'meta',
};
const _PROCESS_KIND_ICON = {
  bound: 'play',
  tool: 'squareFilled',
  plan: 'clipboard-list',
  patch: 'document-pencil',
  think: 'diamond',
  live: 'live',
  out: 'output',
  context: 'info',
  meta: 'dot',
  warn: 'warning',
  err: 'x-circle',
  info: 'info',
};

function _processKindOf(text) {
  const g = (text || '').trimStart().charAt(0);
  return _PROCESS_GLYPH_KIND[g] || '';
}

function _processLineText(text) {
  return String(text || '').replace(/^\s*[\u25EF\u2717\u25CB\u25C9\u25A0\u25B7\u25C6\u25C7\u25B6\u25CF\u25A3\u25D0\u25AA]\uFE0F?\s*/u, '');
}

function _setProcessLineContent(line, text, kind, stripKindGlyph = true) {
  if (!line) return;
  const body = stripKindGlyph ? _processLineText(text) : String(text || '');
  line.dataset.processText = body;
  const icon = kind ? _uiIconHtml(_PROCESS_KIND_ICON[kind] || 'info', 'ui-icon stream-process-icon') : '';
  line.innerHTML = `${icon}<span class="stream-process-text">${escapeHtml(body)}</span>`;
}

function _processTextLines(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  if (!source) return [];
  return source.split('\n').filter((line) => line.trim().length > 0);
}

function _processLifecycleRow(body, lifecycleKey) {
  if (!body || !lifecycleKey) return null;
  return Array.from(body.children || []).find((line) => (
    line?.dataset?.processCallId === lifecycleKey
  )) || null;
}

function _setProcessRowPresentation(
  line,
  text,
  kind,
  eventName,
  lifecycleKey,
  expandable = false,
  lifecycleTerminal = false,
) {
  if (!line) return;
  line.className = 'stream-process-line'
    + (expandable ? ' is-expandable' : '')
    + (kind ? ' kind-' + kind : '');
  _setProcessLineContent(line, text, kind);
  // Result events from Claude-compatible CLIs often use the generic
  // `tool_result` name. Retain the concrete start-event name so routing and
  // diagnostics still know which business action this row represents.
  const genericResultName = ['result', 'tool_result'].includes(_processToolKey(eventName));
  if (eventName && (!line.dataset.eventName || !genericResultName)) {
    line.dataset.eventName = eventName;
  }
  if (lifecycleKey) line.dataset.processCallId = lifecycleKey;
  if (lifecycleTerminal) line.dataset.processTerminal = '1';
}

function _appendProcessTextLines(
  body,
  text,
  kind,
  eventName,
  lifecycleKey = '',
  lifecycleTerminal = false,
) {
  if (!body) return 0;
  const lines = _processTextLines(text);
  // Tool lifecycle rows are single-line business milestones. Update the row
  // created by start/progress when the result arrives instead of painting the
  // same action two or three times. Multiline plan rows deliberately keep
  // their existing one-step-per-line behaviour.
  if (lifecycleKey && lines.length === 1) {
    const existing = _processLifecycleRow(body, lifecycleKey);
    if (existing) {
      // Reconnect/replay can deliver a late progress pulse after the result.
      // Never regress a completed row back to an in-progress label.
      if (existing.dataset.processTerminal === '1' && !lifecycleTerminal) return 1;
      _setProcessRowPresentation(
        existing,
        lines[0],
        kind,
        eventName,
        lifecycleKey,
        false,
        lifecycleTerminal,
      );
      return 1;
    }
  }
  const splitPlanRows = kind === 'plan' && lines.length > 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = document.createElement('div');
    line.className = 'stream-process-line'
      + (kind ? ' kind-' + kind : '')
      + (index > 0 && !splitPlanRows ? ' is-continuation' : '');
    _setProcessLineContent(
      line,
      lines[index],
      index === 0 || splitPlanRows ? kind : '',
      index === 0 || splitPlanRows,
    );
    if (eventName) line.dataset.eventName = eventName;
    if (lifecycleKey && index === 0) line.dataset.processCallId = lifecycleKey;
    if (lifecycleTerminal && index === 0) line.dataset.processTerminal = '1';
    body.appendChild(line);
  }
  return lines.length;
}

function _formatProcessDuration(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return t('chat.stream.duration_hms', { h: hours, m: minutes, s: seconds });
  if (minutes > 0) return t('chat.stream.duration_ms', { m: minutes, s: seconds });
  return t('chat.stream.duration_s', { s: seconds });
}

function _formatToolDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  return _formatProcessDuration(value);
}

function _runtimeDurationMsFromEvent(evt) {
  if (!evt || typeof evt !== 'object' || evt.stream !== 'runtime') return null;
  const data = evt.data && typeof evt.data === 'object' ? evt.data : {};
  const duration = data.bubble_duration_ms ?? data.duration_ms ?? data.durationMs ?? data.elapsedMs;
  const n = Number(duration);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function _runtimeDurationFromEvent(evt) {
  const durationMs = _runtimeDurationMsFromEvent(evt);
  return durationMs == null ? '' : _formatProcessDuration(durationMs);
}

function _runtimeDurationFromProcessItem(item) {
  const evt = item && item.type === 'event'
    ? item.event
    : (item && item.type === 'progress' ? item.event : null);
  return _runtimeDurationFromEvent(evt);
}

function _runtimeEventFromProcessItem(item) {
  const evt = item && item.type === 'event'
    ? item.event
    : (item && item.type === 'progress' ? item.event : null);
  return _runtimeDurationMsFromEvent(evt) == null ? null : evt;
}

// Duration-bearing runtime items feed the process-summary clock and are not
// process milestones. Hiding every one here keeps elapsed time in exactly one
// place. Runtime retry/progress records carry no duration and remain visible.
function _processItemsForDisplay(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => !_runtimeEventFromProcessItem(item));
}

function _processSummaryRuntimeFromItems(items) {
  if (!Array.isArray(items)) return '';
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const duration = _runtimeDurationFromProcessItem(items[i]);
    if (duration) return duration;
  }
  return '';
}

function _setProcessSummaryRuntime(root, durationText) {
  const details = root && root.matches && root.matches('.stream-process')
    ? root
    : root?.querySelector?.('.stream-process');
  const el = details?.querySelector?.('.stream-process-runtime');
  if (!el) return;
  const text = String(durationText || '').trim();
  if (!text) {
    el.textContent = '';
    el.hidden = true;
    if (details.dataset) delete details.dataset.runtimeDuration;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  if (details.dataset) details.dataset.runtimeDuration = text;
}

// The process summary is the single visible elapsed-time surface. `elapsedMs`
// drives it from turn start; a duration-bearing runtime event replaces it with
// the backend's authoritative terminal value.
function _updateStreamingRuntimeSummary(msg, evt, elapsedMs) {
  if (!msg) return null;
  const eventDurationMs = _runtimeDurationMsFromEvent(evt);
  const hasRuntimeEvent = eventDurationMs != null;
  const fallbackDurationMs = Number(elapsedMs);
  if (!hasRuntimeEvent && !Number.isFinite(fallbackDurationMs)) return null;

  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  if (!container) return null;

  // A real end event freezes the clock. A segment_end value may be followed
  // by more work in the same adopted placeholder, so the live clock remains
  // allowed to advance until the final `phase:end` event arrives.
  if (!hasRuntimeEvent && container.dataset.runtimeTerminal === '1') return container;
  const phase = hasRuntimeEvent ? String(evt?.data?.phase || '') : '';
  const durationMs = hasRuntimeEvent ? eventDurationMs : Math.max(0, fallbackDurationMs);
  container.dataset.runtimeDurationMs = String(Math.max(0, Math.round(durationMs)));
  if (hasRuntimeEvent && phase !== 'segment_end' && phase !== 'retrying') {
    container.dataset.runtimeTerminal = '1';
  } else {
    delete container.dataset.runtimeTerminal;
  }
  _setProcessSummaryRuntime(msg, _formatProcessDuration(durationMs));
  return container;
}

function _eventProcessKind(evt, text) {
  if (!evt || typeof evt !== 'object') return _processKindOf(text);
  const stream = evt.stream;
  const data = evt.data || {};
  const recoverableToolGuard = stream === 'tool'
    && data.errorCode === 'E_COMPACTED_HISTORY_PLACEHOLDER'
    && data.errorSeverity === 'recoverable';
  if (stream === 'lifecycle') {
    const p = data.phase;
    if (p === 'error') return 'err';
    if (p === 'start' || p === 'end') return 'bound';
    return 'meta';
  }
  if (stream === 'item') return 'think';
  if (_isProcessPlanEvent(evt)) return 'plan';
  if (stream === 'context' || stream === 'compaction') return 'context';
  if (stream === 'runtime') {
    return String(data.phase || '').toLowerCase() === 'retrying' ? 'warn' : 'bound';
  }
  if (stream === 'provider') {
    return String(data.phase || '').toLowerCase() === 'fallback' ? 'warn' : 'meta';
  }
  if (stream === 'tool') {
    if (data.isError && !recoverableToolGuard) return 'err';
    return 'tool';
  }
  if (stream === 'command_output') return (!data.stdout && data.stderr) ? 'warn' : 'out';
  if (stream === 'patch') return 'patch';
  if (stream === 'approval') return 'warn';
  if (stream === 'error') return 'err';
  if (stream === 'attachment') {
    return String(data.phase || '').toLowerCase() === 'skipped' ? 'err' : 'meta';
  }
  if (stream === 'cli') {
    const type = String(data.type || '').toLowerCase();
    if (type === 'thinking') return 'think';
    if (type === 'file-change') return 'patch';
    if (type === 'tool-event') return 'tool';
    if (type === 'process-info') return 'bound';
    if (type === 'stderr-line' || type === 'idle') return 'warn';
    if (type === 'permission-request') return 'info';
    if (type === 'raw-line') return 'meta';
    if (type === 'log') {
      const level = String(data.level || 'info').toLowerCase();
      return level === 'error' ? 'err' : level === 'warn' ? 'warn' : 'meta';
    }
    if (type === 'status') {
      const st = String(data.status || '').toLowerCase();
      if (st === 'error' || st === 'failed' || st === 'timeout' || st === 'background-failed') return 'err';
      if (st === 'cancelled' || st === 'aborted' || st === 'background-stopped'
          || st === 'retrying' || st === 'waiting-approval' || st === 'waiting-input'
          || st === 'rate-limit') return 'warn';
      if (st === 'tool-progress') return 'tool';
      if (st === 'session_ready' || st === 'running' || st === 'result' || st === 'completed'
          || st === 'usage' || st === 'background-started' || st === 'background-running'
          || st === 'background-completed' || st === 'compacting' || st === 'compacted'
          || st === 'model-rerouted' || st === 'authenticating') return 'bound';
      return 'meta';
    }
  }
  return _processKindOf(text) || 'meta';
}

// Tool name behind a process event, for both in-process (`stream:'tool'`) and
// CLI-backed (`stream:'cli'` tool-event) shapes. '' for non-tool events. Used
// to tag process lines so the `turn_silent` handler can tell a routing-only
// trail (e.g. a lone `hand_off_to`) from real work worth keeping.
function _processEventName(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const data = evt.data || {};
  if (evt.stream === 'tool') return String(data.name || data.toolName || '');
  if (evt.stream === 'cli' && String(data.type || '').toLowerCase() === 'tool-event') {
    return String(data.tool || '');
  }
  return '';
}

// Delegation tools. A commander turn whose end-of-turn trail carries one of
// these (plus the reads it used to decide the routing) "only routed" — its
// narration already landed as a seg bubble, so the trail is redundant. Kept in
// sync with the OrchestrationLedger source_tool set (group_chat/state.ts) and
// bus.ts's `processItemsAreRoutingOnly` guard.
const _ROUTING_TOOL_NAMES = new Set(['hand_off_to', 'dispatch_to', 'run_worker']);
// Read-only file tools the commander uses to inform routing (e.g. reading the
// target agent's agent.json before hand_off_to). Routing support, not
// user-visible "real work", so they don't by themselves keep the freeze path.
const _ROUTING_SUPPORT_TOOL_NAMES = new Set(['read_file', 'search_files', 'grep_files', 'stat_file']);

// True when a silent turn's process trail (one `dataset.eventName` per line, ''
// for non-tool lines) is nothing but routing: at least one delegation tool, and
// every other line is that delegation, a routing-support read, or a non-tool
// line (progress / thinking / context / runtime). Such a trail is dropped like
// an empty turn instead of frozen into a redundant process-only bubble. Any real
// work (plan_set, write_file, bash, generate_image, …) makes it NOT routing-only,
// so the freeze path still preserves it. Mirror of bus.ts's ProcessItem version.
function _isRoutingOnlyEventNames(eventNames) {
  if (!Array.isArray(eventNames)) return false;
  let sawRoutingTool = false;
  for (const raw of eventNames) {
    const name = String(raw || '');
    if (_ROUTING_TOOL_NAMES.has(name)) { sawRoutingTool = true; continue; }
    if (!name) continue; // non-tool line (progress / context / runtime / thinking)
    if (_ROUTING_SUPPORT_TOOL_NAMES.has(name)) continue; // routing-support read
    return false; // a real-work tool → keep (freeze)
  }
  return sawRoutingTool;
}

function _shouldDiscardSilentPlaceholder(reason, eventNames) {
  // Explicit source semantics win over process-trail inference. A terminal
  // hand-off has already delivered the answer in the target agent's bubble,
  // regardless of which planning/prep tools ran before it.
  return reason === 'terminal_handoff' || _isRoutingOnlyEventNames(eventNames);
}

// Persisted-record variant of `_isRoutingOnlyEventNames`: reads each stored
// ProcessItem's tool name (`{type:'event', event}` / `{type:'progress'}`).
function _isRoutingOnlyProcessItems(processItems) {
  if (!Array.isArray(processItems) || !processItems.length) return false;
  return _isRoutingOnlyEventNames(processItems.map((item) => {
    if (!item || typeof item !== 'object') return '';
    return item.event ? _processEventName(item.event) : '';
  }));
}

// A successful hand_off_to is stronger than the routing-only heuristic: by
// contract the target agent's bubble is the final delivery, so an empty
// commander tail is redundant even when its process trail also contains prep,
// planning attempts, or other control-plane tools. This full-event predicate is
// used for legacy jsonl records written before the bus started carrying the
// explicit `turn_silent.reason='terminal_handoff'` signal.
function _processItemsContainSuccessfulTerminalHandoff(processItems) {
  if (!Array.isArray(processItems) || !processItems.length) return false;
  return processItems.some((item) => {
    const evt = item && typeof item === 'object' ? item.event : null;
    if (_processEventName(evt) !== 'hand_off_to') return false;
    const data = evt && typeof evt.data === 'object' ? evt.data : {};
    const phase = String(data.phase || data.status || '').toLowerCase();
    // In-process tool results use phase=end + isError. CLI-backed tools use
    // phase=result. A nameless legacy event has no completion proof and stays
    // on the conservative path.
    return (phase === 'end' || phase === 'result') && data.isError !== true;
  });
}

// A persisted commander record that ONLY routed: a routing-only process trail
// (a delegation call + the reads used to decide it) and no user-facing side
// effect. Its narration and pre-dispatch process are owned by the preceding seg
// bubble, so this tail record — empty text, or just an abort marker — is the same
// redundant "second commander bubble" the live turn_silent handler drops.
// History reload / session switch-back render straight from jsonl, so filter it
// here too — jsonl written before the bus-side guard (or by an un-upgraded main
// process) may still carry these whole-turn process arrays.
function _isRedundantRoutingOnlyCommanderRecord(gm) {
  if (!gm || gm.from !== 'commander') return false;
  const routingOnly = _isRoutingOnlyProcessItems(gm.process);
  const terminalHandoff = _processItemsContainSuccessfulTerminalHandoff(gm.process);
  if (!routingOnly && !terminalHandoff) return false;
  // Never drop a record that carries a user-facing side effect.
  if (gm.form
      || (Array.isArray(gm.produced) && gm.produced.length)
      || _normalizeCreatedAgents(gm) || _normalizeCreatedSkills(gm)
      || (Array.isArray(gm.artifacts) && gm.artifacts.length)
      || (Array.isArray(gm.marketplace_requests) && gm.marketplace_requests.length)) {
    return false;
  }
  // Tool shape alone cannot prove the body is redundant. In particular, a
  // dispatch_to fan-out legitimately ends with non-empty Commander synthesis
  // while its process trail remains "routing only". Preserve all real prose;
  // the cleanup target is an empty tail (or the abort-only compatibility stub)
  // whose narration, if any, already lives in a preceding segment.
  const text = String(gm.text || '').trim();
  const abortOnly = text === '(stopped)' || text === '（已中断）';
  if (text && !abortOnly) return false;
  return true;
}

// Single visibility predicate for persisted group-history records: drops
// internal commander→agent `dispatch` records AND redundant routing-only
// commander tails. Used by every history-render / reconcile / poll site so
// their record counts stay in agreement (a mismatch triggers reload loops).
function _isVisibleGroupHistoryRecord(gm) {
  return !!gm && !gm.dispatch && !_isRedundantRoutingOnlyCommanderRecord(gm);
}

function _streamingAppendProgress(
  msg,
  text,
  kindHint,
  eventName,
  lifecycleKey = '',
  lifecycleTerminal = false,
) {
  // Keep the "thinking…" row visible alongside the process trace — hiding it
  // while only process info shows makes long tool runs look stuck. The row
  // is cleared when the final reply (or an error) arrives.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  _bindProcessStickToBottom(body);
  const kind = kindHint || _processKindOf(text);
  _appendProcessTextLines(body, text, kind, eventName, lifecycleKey, lifecycleTerminal);
  _stickProcessBottomIfPinned(body);
  // Outer chat-history follows independently — its own sticky-bottom
  // logic respects user scroll on the conversation level.
  _stickBottomFromMsg(msg);
}

// ── Always-visible liveness strip ──────────────────────────────────────
// Long turns emit most detail into the collapsible process rail, so the
// bubble keeps one concise always-visible status. The same timer drives the
// process-summary clock above; it is intentionally not painted again here.
// Specific tool names/counts, inferred steps and ETA stay out of this strip
// because reconnects and suppressed worker events can make those incomplete.
function _streamingUpdateActivity(msg, text) {
  if (!msg || msg.dataset.activityDone === '1') return;
  const row = msg.querySelector('[data-role="activity"]');
  if (!row) return;
  if (!msg.dataset.activityStart) msg.dataset.activityStart = String(Date.now());
  const textEl = row.querySelector('[data-role="activity-text"]');
  const label = String(text || '').replace(/\s+/g, ' ').trim();
  if (textEl) {
    if (label) {
      textEl.textContent = label.length > 88 ? label.slice(0, 88) + '…' : label;
    } else if (!textEl.textContent) {
      // First event carried nothing displayable (e.g. a usage pulse) —
      // still show the strip with a generic label so the user sees life.
      textEl.textContent = t('chat.activity_working');
    }
  }
  row.style.display = '';
  _streamingPaintActivityMeta(msg);
  if (!msg._activityTimer) {
    msg._activityTimer = setInterval(() => {
      // Self-clean on detach / finalize so a missed stop call can't leak
      // the interval past the bubble's lifetime.
      if (!msg.isConnected || msg.dataset.activityDone === '1') {
        clearInterval(msg._activityTimer);
        msg._activityTimer = null;
        return;
      }
      _streamingPaintActivityMeta(msg);
    }, 1000);
  }
}

function _activityMonotonicNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function _streamingPaintActivityMeta(msg) {
  const wallNow = Date.now();
  const rawT0 = Number(msg.dataset.activityStart);
  const t0 = Number.isFinite(rawT0) && rawT0 > 0 ? rawT0 : wallNow;
  const wallElapsedMs = Math.max(0, wallNow - t0);
  const monotonicNow = _activityMonotonicNow();
  let clock = msg._activityClock;
  if (!clock || !Number.isFinite(clock.elapsedMs) || !Number.isFinite(clock.monotonicAt)) {
    clock = { elapsedMs: wallElapsedMs, monotonicAt: monotonicNow };
    msg._activityClock = clock;
  } else {
    const monotonicDelta = Math.max(0, monotonicNow - clock.monotonicAt);
    clock.elapsedMs = Math.max(wallElapsedMs, clock.elapsedMs + monotonicDelta);
    clock.monotonicAt = monotonicNow;
  }
  _updateStreamingRuntimeSummary(msg, null, clock.elapsedMs);
}

function _streamingStopActivity(msg) {
  if (!msg) return;
  if (msg.dataset.activityDone !== '1') _streamingPaintActivityMeta(msg);
  msg.dataset.activityDone = '1';
  if (msg._activityTimer) {
    clearInterval(msg._activityTimer);
    msg._activityTimer = null;
  }
  const row = msg.querySelector('[data-role="activity"]');
  if (row) row.style.display = 'none';
}

// Map one structured live event onto the concise activity strip. Protocol
// status events are authoritative enough to show directly; everything else
// stays at generic working so incomplete streams cannot overstate the action.
function _streamingUpdateActivityFromEvent(msg, evt) {
  const data = (evt && evt.data) || {};
  const stream = (evt && evt.stream) || '';
  const cliType = stream === 'cli' ? String(data.type || '').toLowerCase() : '';
  const phase = String(data.phase || data.status || '').toLowerCase();
  if (stream === 'runtime' && phase === 'retrying') {
    const attempt = Math.max(1, Math.round(Number(data.attempt) || 1));
    _streamingUpdateActivity(msg, attempt > 1
      ? t('model.retrying_n', { attempt })
      : t('model.retrying'));
    return;
  }
  if (cliType === 'status' && phase === 'retrying') {
    const attempt = Math.max(1, Math.round(Number(data.attempt) || 1));
    _streamingUpdateActivity(msg, attempt > 1
      ? t('model.retrying_n', { attempt })
      : t('model.retrying'));
    return;
  }
  if (cliType === 'thinking') {
    _streamingUpdateActivity(
      msg,
      _formatEventLine(evt, _processDisplayContextForMessage(msg)) || t('chat.stream.thinking'),
    );
    return;
  }
  if (cliType === 'status' && [
    'background-started', 'background-running', 'background-completed',
    'background-failed', 'background-stopped', 'compacting', 'compacted',
    'waiting-approval', 'waiting-input', 'tool-progress', 'model-rerouted',
    'authenticating', 'rate-limit',
  ].includes(phase)) {
    _streamingUpdateActivity(
      msg,
      _formatEventLine(evt, _processDisplayContextForMessage(msg)) || t('chat.activity_working'),
    );
    return;
  }
  if (cliType === 'status' && phase === 'usage') {
    _streamingUpdateActivity(msg, t('chat.activity_working'));
    return;
  }
  _streamingUpdateActivity(msg, t('chat.activity_working'));
}

// Cancel any rAF queued by `_streamingAppendFinalDelta`. Callers that are
// about to overwrite `[data-role="final"]` with canonical content (final
// text / error span) must call this first — otherwise the queued flush
// fires after the overwrite and either (a) wipes finalEl with empty
// markdown when streamBuf was deleted (`_streamingSetFinal` path) or
// (b) paints the half-streamed assistant text over the error span
// (`_streamingSetError` path). Skip for `_streamingMarkAborted` — that
// only adds a sibling note and *wants* the partial content to remain.
function _cancelPendingStreamRaf(msg) {
  if (!msg) return;
  if (msg._streamRafHandle != null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(msg._streamRafHandle);
  }
  msg._streamRafHandle = null;
  msg._streamRafScheduled = false;
  _invalidateStreamingMathPaint(msg);
}

// Paint the final reply into a streaming bubble. Caller controls whether
// to attach the archive button afterwards (not all scenes want it — skill and
// agent edit chats skip it by design).
function _streamingSetFinal(msg, text, { archive = false } = {}) {
  _hideThinking(msg);
  _streamingStopActivity(msg);
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  _cancelPendingStreamRaf(msg);
  // Finalization is a completion-state repaint (collapse process, replace
  // preview with canonical markdown). Do not auto-scroll here; streaming
  // deltas/progress already followed while content was growing.
  const display = _stripSurvivingStructuralBlocks(text);
  const alreadyPainted = finalEl.style.display !== 'none'
    && msg.dataset.streamPaintedDisplay === display
    && !!finalEl.querySelector('.markdown-body');
  if (!alreadyPainted) {
    _paintStreamingFinalMarkdown(msg, finalEl, display);
  }
  finalEl.style.display = '';
  msg.dataset.finalText = display || '';
  delete msg.dataset.streamBuf;
  delete msg.dataset.streamDisplay;
  delete msg._processDisplayContext;
  _attachAssistantActions(msg, () => msg.dataset.finalText || '', { archive });

  // Preserve the live preview line (keeps the full trace) — just freeze it.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = t('chat.stream_done');
  }

  // Auto-collapse the process section so the finalised reply reads
  // cleanly. But if the entire streaming turn never produced a progress
  // line (e.g. the model answered in one shot with no reasoning / tool
  // calls), keep the initial display:none so we don't render an empty
  // "process info" bubble.
  // **Exception**: when the final body is just an empty/abort stub
  // (i.e. the "(stopped)" placeholder for a turn that never produced
  // real text), the process trail IS the user-visible output — keep
  // it expanded; otherwise the user perceives it as "the process I
  // just watched stream is gone after finalize", which gets worse on
  // refresh.
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    const bodyText = String(display || '').trim();
    // Match both possible forms — jsonl history can carry either depending
    // on the UI language at the time of write (i18n key `model.aborted` →
    // '(stopped)' in en, '（已中断）' in zh).
    const isAbortStub = bodyText === '（已中断）' || bodyText === '(stopped)' || bodyText === '';
    if (hasProcess && isAbortStub) {
      details.open = true;
      details.style.display = '';
    } else if (hasProcess) {
      details.removeAttribute('open');
      details.style.display = '';
    } else {
      details.removeAttribute('open');
      // else: keep display:none (the initial value set by _createStreamingAssistantMessage).
    }
  }
}

// Freeze the body the user has been watching into the process rail and clear
// the streaming buffer before canonical text replaces it. Codex triggers this
// at its commentary → final_answer phase boundary; Claude Code triggers it
// when its successful terminal result arrives. The bus persists the same text
// as a process item. Idempotence protects reconnect/replay duplicates.
function _isRepeatedPriorTurnCommentary(msg, commentary) {
  const text = String(commentary || '').trim();
  const turnId = String(msg?.dataset?.turnId || '');
  const actorId = String(msg?.dataset?.fromActor || '');
  if (!text || !turnId || !actorId) return false;

  for (let prev = _previousChatMessage(msg); prev; prev = _previousChatMessage(prev)) {
    if (!_hasChatMessageClass(prev, 'assistant')) continue;
    if (String(prev.dataset?.turnId || '') !== turnId) break;
    if (String(prev.dataset?.fromActor || '') !== actorId) continue;
    if (prev.dataset?.finalized !== '1') continue;
    return String(prev.dataset?.finalText || '').trim() === text;
  }
  return false;
}

function _streamingFinalizeCommentary(msg, text) {
  if (!msg || msg.dataset.commentaryFinalized === '1') return;
  msg.dataset.commentaryFinalized = '1';

  const commentary = typeof text === 'string' && text.length
    ? text
    : (msg.dataset.streamBuf || '');
  // A commander hand-off can split one backend turn into multiple visible
  // segments. On recovery, the commentary-finalized event for the first
  // segment may be replayed after the next placeholder has already opened.
  // Do not paint that same commentary into a second bubble; the canonical
  // final answer for the resumed segment still renders normally.
  if (commentary && !_isRepeatedPriorTurnCommentary(msg, commentary)) {
    _streamingAppendProgress(msg, commentary, 'think');
  }

  _cancelPendingStreamRaf(msg);
  msg.dataset.streamBuf = '';
  msg.dataset.finalText = '';
  delete msg.dataset.streamDisplay;
  delete msg.dataset.streamPaintedDisplay;
  delete msg.dataset.streamPhase;
  const finalEl = msg.querySelector('[data-role="final"]');
  if (finalEl) {
    finalEl.innerHTML = '';
    finalEl.style.display = 'none';
  }
}

function _streamingSetError(msg, text) {
  _hideThinking(msg);
  _streamingStopActivity(msg);
  _cancelPendingStreamRaf(msg);
  msg.dataset.failed = '1';
  // Freeze the live preview line so it stops looking like it's still streaming.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = (live.textContent || '').replace(/^◐ /, '◯ ') || t('chat.stream_done');
  }
  // On error we also preserve the accumulated process info: if the
  // body is non-empty we display it (matching _streamingSetFinal /
  // _streamingMarkAborted), so the user no longer has to reopen the
  // conversation to see it backfilled from the persisted
  // message.process.
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    if (hasProcess) details.style.display = '';
  }
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  // Preserve any partial reply that streamed in before the error so the
  // user keeps the assistant's in-flight prose / process info, then append
  // the error pill underneath. Without this, mid-stream errors wipe the
  // visible turn entirely and the user only sees the error pill.
  const partial = String(msg.dataset.streamBuf || '');
  let bodyHtml = '';
  if (partial) {
    const display = _stripSurvivingStructuralBlocks(partial);
    if (display) {
      bodyHtml = _streamingMarkdownBodyHtml(display);
      msg.dataset.finalText = display;
    }
  }
  const errPill = `<div class="msg-error" style="color:var(--danger);margin-top:6px">${escapeHtml(t('chat.send_failed', { msg: text }))}</div>`;
  finalEl.innerHTML = bodyHtml + errPill;
  finalEl.style.display = '';
  delete msg.dataset.streamBuf;
  delete msg._processDisplayContext;
  if (bodyHtml && typeof typesetMath === 'function') typesetMath(finalEl);
  _attachFailedAssistantActions(msg, () => _messageTextForActions(msg, msg.dataset.finalText || ''));
}

// Mark the assistant bubble as user-interrupted. Preserves whatever partial
// content streamed into the process pane; just stamps a "stopped" note.
function _streamingMarkAborted(msg) {
  _hideThinking(msg);
  _streamingStopActivity(msg);
  msg.dataset.interrupted = '1';
  delete msg._processDisplayContext;
  // Freeze any live preview line so it's not misread as still generating.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = (live.textContent || '').replace(/^◐ /, '◯ ') || t('chat.stream_interrupted_line');
  }
  const bubble = msg.querySelector('.chat-bubble');
  if (bubble && !bubble.querySelector('.stream-aborted-note')) {
    const note = document.createElement('div');
    note.className = 'stream-aborted-note';
    note.textContent = t('chat.interrupted');
    bubble.appendChild(note);
  }
  const details = msg.querySelector('.stream-process');
  if (details) details.style.display = '';
  _attachInterruptedAssistantActions(
    msg,
    () => _messageTextForActions(msg, msg.dataset.finalText || msg.dataset.streamBuf || ''),
    { archive: false },
  );
}

function _finishStreamingMsg(cid) {
  const wasAborted = pendingConvs.get(cid)?.aborted === true;
  // The turn is over: a user-initiated stop already consumed its snapshot, and
  // any other ending means the message was answered. Keeping it would let a
  // later stop hand back a message that belongs to a finished turn.
  if (typeof _clearSentComposerSnapshot === 'function') _clearSentComposerSnapshot(cid);
  _stopRuntimeActorRecovery(cid);
  _stopGroupEventObserver(cid);
  _lastGroupWorkEventAt.delete(cid);
  pendingConvs.delete(cid);
  if (isGroupConversationBusy(cid)) startPolling(cid);
  else stopPolling(cid);
  _updateConvSidebarBadge(cid, false);
  // Settle any actor placeholder that streaming created but `message`
  // event never consumed (cid race / actor not yet identified when the
  // controller minted its bubble / streaming buf accumulated before
  // _ensureActorPlaceholder registered it). Without this, a placeholder
  // with raw streamBuf survives turn-end and renders as a stray "extra
  // commander bubble" filled with un-stripped `<<<skill-file>>>` /
  // `<skill>` body content next to the real reply. The `_streamingSetFinal`
  // path inside `_settleDanglingActorPlaceholders` runs the chokepoint
  // strip so the residue is filtered, then the bubble either inherits
  // the cleaned content or is removed entirely if both process + final
  // were empty.
  if (cid === currentCid) {
    // UI finalization and the primary send stream are independent terminal
    // paths in group chat. Release the pin again at the shared run-settlement
    // boundary so observer/recovery completion cannot leave the artificial
    // spacer behind. This runs before `_dispatchNextQueued`, so it cannot
    // remove the next queued turn's newly-created spacer.
    _setChatScrollOffset(false, document.getElementById('chat-history'));
    _settleDanglingActorPlaceholders(cid, { preserveProcess: wasAborted });
    _updateConvSendUI(cid);
  }
  // Drain the next queued message for this conversation, if any.
  _dispatchNextQueued(cid);
}

// Scroll the given message to the top of the visible chat area.
function _scrollToMessageTop(msgEl, containerId = 'chat-history') {
  if (!msgEl) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  // Pin-to-top intentionally moves the user away from the bottom; if
  // sticky-bottom were left armed, the first stream delta would race the
  // pin and yank the view back down. Disarm synchronously here — the
  // user has to scroll back to bottom themselves to re-arm following.
  container._stickyEnabled = false;
  // Instant scroll to avoid the animation getting clobbered by streaming DOM
  // mutations that land during the send. Use rAF twice to make sure layout
  // has settled (style recalc after appendChild, then paint).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _scrollToMessageTopNow(msgEl, container);
  }));
}

function _scrollToMessageTopNow(msgEl, container) {
  if (!msgEl || !container) return;
  const containerRect = container.getBoundingClientRect();
  const msgRect = msgEl.getBoundingClientRect();
  // Reserve only enough margin so the floating delete button
  // (top:20px + ~33px tall) doesn't sit flush against the message;
  // a larger blank exposes the previous message and feels noisy.
  // 24px lines up with the bottom of the delete button.
  const offset = msgRect.top - containerRect.top + container.scrollTop - 24;
  // Force auto behavior so the jump is immediate — the CSS default of
  // scroll-behavior:smooth would otherwise animate and get interrupted by
  // streaming DOM mutations that land during the scroll.
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  _markProgrammaticStickyScroll(container);
  container.scrollTop = offset;
  requestAnimationFrame(() => {
    container.style.scrollBehavior = prev || '';
  });
}

function _pinMessageToTopWithDynamicSpacer(msgEl, container) {
  if (!msgEl || !container) return;
  // Fresh tasks enter the conversation with skipLoad=true, so they do not
  // pass through history hydration (which normally binds message-list wheel,
  // touch, and scroll gestures). Bind the surface before activating the
  // send-time spacer; otherwise its artificial pin cannot be released until
  // the stream terminates.
  _bindStickToBottom(container);
  // Start from a clean generation. The pin is intentionally delayed for two
  // frames so layout can settle, but the stream can also finish or the user
  // can switch tasks during that delay. `_setChatScrollOffset(false)` bumps
  // the epoch, making both callbacks harmless even when a test/runtime cannot
  // cancel an already-queued animation frame.
  _setChatScrollOffset(false, container);
  const epoch = Number(container._scrollPinScheduleEpoch || 0);
  container._stickyEnabled = false;
  container._scrollPinOuterRaf = requestAnimationFrame(() => {
    container._scrollPinOuterRaf = null;
    if (Number(container._scrollPinScheduleEpoch || 0) !== epoch) return;
    container._scrollPinInnerRaf = requestAnimationFrame(() => {
      container._scrollPinInnerRaf = null;
      if (Number(container._scrollPinScheduleEpoch || 0) !== epoch) return;
      if (!msgEl.isConnected || !container.isConnected) return;
      _setChatScrollOffset(true, container);
      _scrollToMessageTopNow(msgEl, container);
      // Store Chromium's resolved position after the spacer and explicit
      // pin have both landed. A queued `scroll` event compares against this
      // value, so layout clamping/rounding cannot mistake our own pin for a
      // user gesture and immediately tear the spacer back down.
      container._scrollPinTargetTop = Number(container.scrollTop || 0);
    });
  });
}

// ─── Generic chat controller ─────────────────────────────────────────────
// Encapsulates the shared send/stream/abort/scroll pipeline so different
// scenes (main conversation, skill-edit inline chat, agent-edit inline chat)
// can share one implementation. Per-scene differences are expressed via the
// `config` arg, not by forking the code.
//
// config shape:
//   historyEl:       HTMLElement   — where messages render
//   inputEl:         HTMLTextArea  — the send textarea
//   sendBtnEl:       HTMLElement   — send/stop button
//   getCurrentId():  returns the target id (cid / skill id / agent id)
//   streamEndpoint(id): returns the URL string for the streaming POST
//   historyEndpoint(id): returns the URL for GET history
//   clearEndpoint(id):   (optional) URL for DELETE history
//   features: {
//     archive:    bool  // attach archive button on final
//     scrollPin:  bool  // pin newly-sent user message to top of viewport
//     actorIdentity: bool // group-chat only: wait for actor before showing placeholder
//     messageActions: 'all' | 'errors-only' // edit chats keep only retry + feedback on failures
//   }
//   hooks: {
//     beforeSend(content, id)     → transformedContent | null   // cancel by returning null
//     buildExtraBody(content, id, { pending, hasQueue }) → object | null
//       Optional field: model_text. UI renders content, while the backend can
//       send model_text to the model.
//     onUserAppended(userMsgEl, content, id)
//     onAssistantStart(msgEl, id)
//     onStreamEvent(ev, msgEl, id)   // extra side-effects per event
//     onFinal(ev, msgEl, id)         // e.g. refresh skill view, update agent fields
//     onError(text, msgEl, id)
//     onAbort(msgEl, id)
//     onDone(msgEl, id, { aborted, errored })
//     onHistoryLoaded(history, conversationMeta, id)
//     appendHistoryMessage(message, autoScroll, id)  // default uses global appendChatMessage
//   }
//
// Returns { loadHistory, send, abort, clear, isBusy }
function createChatController(config) {
  const features = {
    archive: false,
    scrollPin: true,
    bindInput: true,
    queue: false,
    actorIdentity: false,
    messageActions: 'all',
    ...(config.features || {}),
  };
  const hooks = config.hooks || {};
  let pending = null;   // { controller, msgEl, userMsgEl, aborted, errored }

  const historyEl = typeof config.historyEl === 'string'
    ? document.getElementById(config.historyEl)
    : config.historyEl;
  const inputEl = typeof config.inputEl === 'string'
    ? document.getElementById(config.inputEl)
    : config.inputEl;
  const sendBtnEl = typeof config.sendBtnEl === 'string'
    ? document.getElementById(config.sendBtnEl)
    : config.sendBtnEl;
  let idlePlaceholder = inputEl ? (inputEl.placeholder || '') : '';

  // ── Optional queue module (features.queue enabled) ──────────────────
  // Mirrors the main-chat queue (stacked while a reply is streaming,
  // drained on done, drag-reorderable, edit-in-place). Storage is per
  // (keyPrefix, currentId) in localStorage so navigating between
  // skills/agents keeps each queue isolated.
  const qCfg = config.queue || null;
  const qEls = features.queue && qCfg ? {
    panel: typeof qCfg.panelId === 'string' ? document.getElementById(qCfg.panelId) : null,
    list:  typeof qCfg.listId  === 'string' ? document.getElementById(qCfg.listId)  : null,
    count: typeof qCfg.countId === 'string' ? document.getElementById(qCfg.countId) : null,
  } : null;
  const qKeyPrefix = qCfg?.keyPrefix || 'ctrl';
  const _qStorageKey = (id) => `queue_${qKeyPrefix}:${id}`;
  const _qCache = new Map();   // id → array

  function _qLoad(id) {
    if (!id) return [];
    try {
      const raw = localStorage.getItem(_qStorageKey(id));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function _qSave(id, arr) {
    if (!id) return;
    try {
      if (arr.length) localStorage.setItem(_qStorageKey(id), JSON.stringify(arr));
      else localStorage.removeItem(_qStorageKey(id));
    } catch {}
  }
  function _qGet(id) {
    if (!id) return [];
    if (!_qCache.has(id)) _qCache.set(id, _qLoad(id));
    return _qCache.get(id);
  }
  function _qEditingItem(id) {
    return _qGet(id).find(item => (
      item
      && item.composer_edit
      && typeof item.composer_edit === 'object'
    )) || null;
  }
  function _extraBodyWithoutModelText(extraBody) {
    if (!extraBody || typeof extraBody !== 'object') return undefined;
    const body = { ...extraBody };
    delete body.model_text;
    return Object.keys(body).length ? body : undefined;
  }
  function enqueue(content, meta = {}) {
    if (!features.queue) return false;
    const id = config.getCurrentId();
    if (!id) return false;
    const q = _qGet(id);
    q.push({
      id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      content, meta,
    });
    _qSave(id, q);
    renderQueue();
    return true;
  }
  function _qRemove(qid) {
    const id = config.getCurrentId(); if (!id) return;
    const q = _qGet(id);
    const idx = q.findIndex(m => m.id === qid);
    if (idx < 0) return;
    q.splice(idx, 1);
    _qSave(id, q);
    renderQueue();
  }
  function _qReorder(fromIdx, toIdx) {
    const id = config.getCurrentId(); if (!id) return;
    const q = _qGet(id);
    if (fromIdx < 0 || fromIdx >= q.length) return;
    toIdx = Math.max(0, Math.min(q.length, toIdx));
    const [item] = q.splice(fromIdx, 1);
    q.splice(fromIdx < toIdx ? toIdx - 1 : toIdx, 0, item);
    _qSave(id, q);
    renderQueue();
  }
  function _qDispatchNext() {
    if (!features.queue) return;
    const id = config.getCurrentId(); if (!id) return;
    if (pending) return;
    const q = _qGet(id);
    if (!q.length) return;
    // The composer owns this queue until the edit is committed or cancelled.
    // Blocking the entire queue preserves FIFO ordering even when the edited
    // item is not currently at the head.
    if (_qEditingItem(id)) return;
    // Preserve edit-chat queue entries when credentials/configuration become
    // unavailable while another response is running.
    if (!ensureModelConfigured()) return;
    const next = q.shift();
    _qSave(id, q);
    renderQueue();
    send(next.content, next.meta && next.meta.extraBody ? next.meta.extraBody : undefined);
  }
  function renderQueue() {
    if (!features.queue || !qEls || !qEls.panel || !qEls.list) return;
    const id = config.getCurrentId();
    const q = id ? _qGet(id) : [];
    const editing = id ? !!_qEditingItem(id) : false;
    const visible = q
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !(item && item.composer_edit));
    if (qEls.count) qEls.count.textContent = String(visible.length);
    if (!visible.length) {
      qEls.panel.style.display = 'none';
      qEls.list.innerHTML = '';
      return;
    }
    qEls.panel.style.display = '';
    qEls.list.innerHTML = visible.map(({ item, index }) => {
      const preview = escapeHtml((item.content || '').replace(/\s+/g, ' ')).slice(0, 200);
      return `
        <div class="chat-queue-item" draggable="${editing ? 'false' : 'true'}" data-qid="${item.id}" data-idx="${index}">
          <div class="chat-queue-drag" title="${escapeHtml(t('chat.queue_drag_title'))}">⋮⋮</div>
          <div class="chat-queue-text">${preview}</div>
          <div class="chat-queue-actions">
            <button class="chat-queue-btn" data-act="edit"${editing ? ' disabled' : ''}>${escapeHtml(t('chat.queue_edit'))}</button>
            <button class="chat-queue-btn danger" data-act="del">×</button>
          </div>
        </div>`;
    }).join('');
    _wireQueueItemEvents();
  }
  function _wireQueueItemEvents() {
    if (!qEls?.list) return;
    qEls.list.querySelectorAll('.chat-queue-btn[data-act="del"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qid = btn.closest('.chat-queue-item')?.dataset.qid;
        if (qid) _qRemove(qid);
      });
    });
    qEls.list.querySelectorAll('.chat-queue-btn[data-act="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.chat-queue-item');
        if (row) _qStartEdit(row);
      });
    });
    let dragEl = null;
    qEls.list.querySelectorAll('.chat-queue-item').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragEl = row; row.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.dataset.qid || '');
        } catch {}
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        qEls.list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        dragEl = null;
      });
      row.addEventListener('dragover', (e) => {
        if (!dragEl || dragEl === row) return;
        e.preventDefault();
        qEls.list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        row.classList.add('drop-target');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === row) return;
        const fromIdx = parseInt(dragEl.dataset.idx, 10);
        let toIdx = parseInt(row.dataset.idx, 10);
        const rect = row.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) toIdx += 1;
        row.classList.remove('drop-target');
        if (Number.isInteger(fromIdx) && Number.isInteger(toIdx)) _qReorder(fromIdx, toIdx);
      });
    });
  }
  function _qStartEdit(row) {
    const id = config.getCurrentId(); if (!id) return;
    const qid = row.dataset.qid;
    const item = _qGet(id).find(m => m.id === qid);
    if (!item || !inputEl || _qEditingItem(id)) return;
    item.composer_edit = {
      previous_input: inputEl.value || '',
      draft_content: item.content || '',
    };
    _qSave(id, _qGet(id));
    inputEl.value = item.content || '';
    autoGrow(inputEl, 160);
    renderQueue();
    _updateSendUI();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }
  function _qRestoreEditingInput(id) {
    const item = id ? _qEditingItem(id) : null;
    if (!item || !inputEl) return;
    const draftContent = typeof item.composer_edit.draft_content === 'string'
      ? item.composer_edit.draft_content
      : (item.content || '');
    inputEl.value = draftContent;
    autoGrow(inputEl, 160);
  }
  function _qFinishEdit(content) {
    const id = config.getCurrentId(); if (!id) return false;
    const item = _qEditingItem(id);
    if (!item) return false;
    const shouldCommit = typeof content === 'string';
    const nextContent = shouldCommit ? content.trim() : '';
    if (shouldCommit && !nextContent) return false;

    const previousInput = typeof item.composer_edit.previous_input === 'string'
      ? item.composer_edit.previous_input
      : '';
    if (shouldCommit) {
      item.content = nextContent;
      if (item.meta?.extraBody && Object.prototype.hasOwnProperty.call(item.meta.extraBody, 'model_text')) {
        item.meta = {
          ...item.meta,
          extraBody: _extraBodyWithoutModelText(item.meta.extraBody) || {},
        };
      }
    }
    delete item.composer_edit;
    _qSave(id, _qGet(id));
    if (inputEl) {
      inputEl.value = previousInput;
      autoGrow(inputEl, 160);
    }
    renderQueue();
    _updateSendUI();
    _qDispatchNext();
    return true;
  }

  function isBusy() { return !!pending; }

  async function _retryFailedEditMessage(msgDiv, btn) {
    if (!msgDiv || (btn && btn.disabled)) return;
    const userMsgEl = _findUserMessageForRetry(msgDiv);
    const payload = _retryPayloadFromUserMessage(userMsgEl);
    if (!payload) {
      await uiAlert(t('chat.retry_no_source'));
      return;
    }
    if (btn) btn.disabled = true;
    const orig = btn ? btn.innerHTML : '';
    try {
      if (btn) {
        btn.innerHTML = `<span class="bubble-action-spinner" aria-hidden="true"></span><span>${escapeHtml(t('chat.retry_running'))}</span>`;
      }
      const hasQueue = features.queue && _qGet(config.getCurrentId()).length > 0;
      if ((pending || hasQueue) && features.queue) {
        enqueue(payload.content, payload.extra ? { extraBody: payload.extra } : {});
      } else {
        await send(payload.content, payload.extra);
      }
    } finally {
      if (btn) {
        btn.innerHTML = orig || escapeHtml(t('chat.retry_btn'));
        btn.disabled = false;
      }
    }
  }

  function _updateSendUI() {
    // When the scene owns its input wiring (features.bindInput=false), leave
    // send-button state to the caller — their own _updateXxx logic is
    // authoritative (queue-aware, multi-cid etc.).
    if (!features.bindInput) return;
    if (!sendBtnEl) return;
    const editing = !!_qEditingItem(config.getCurrentId());
    const busy = !!pending && !editing;
    // `.aborting` is the "stop clicked, stream not yet unwound" lock. While
    // set, keep the send-style + disabled appearance so the click feels
    // immediate; it self-clears once the stream truly ends (busy === false).
    if (sendBtnEl.classList.contains('aborting')) {
      if (pending && !editing) return;
      sendBtnEl.classList.remove('aborting');
    }
    sendBtnEl.classList.toggle('streaming', busy);
    sendBtnEl.disabled = false;
    sendBtnEl.title = editing
      ? t('chat.queue_save')
      : (busy ? t('chat.stop_reply') : t('chat.send_title'));
    if (inputEl) {
      const replyingText = t('chat.replying');
      if (editing) {
        inputEl.placeholder = t('chat.queue_editing_placeholder');
      } else if (busy) {
        if (inputEl.placeholder && inputEl.placeholder !== replyingText) {
          idlePlaceholder = inputEl.placeholder;
        }
        inputEl.placeholder = replyingText;
      } else {
        inputEl.placeholder = idlePlaceholder || inputEl.placeholder;
      }
    }
  }

  function _appendHistoryMessage(message, autoScroll, cid, msgIndex) {
    if (typeof hooks.appendHistoryMessage === 'function') {
      return hooks.appendHistoryMessage(message, autoScroll, config.getCurrentId());
    }
    // Default renderer — reuses the main-chat bubble so skills/agents look
    // identical out of the box. Archive defaults to scene's features flag.
    return appendChatMessage(message, autoScroll, {
      container: historyEl,
      archive: features.archive,
      cid: cid || config.getCurrentId(),
      messageActions: features.messageActions,
      ...(features.messageActions === 'errors-only'
        ? { failedRetryHandler: _retryFailedEditMessage, feedbackConversationId: '' }
        : {}),
      ...(typeof msgIndex === 'number' ? { msgIndex } : {}),
    });
  }

  async function loadHistory() {
    const id = config.getCurrentId();
    if (!id) return;
    historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.loading'))}</div>`;
    try {
      const res = await apiFetch(config.historyEndpoint(id));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'load failed');
      const history = data.history || data.messages || [];
      if (!history.length) {
        historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
      } else {
        historyEl.innerHTML = '';
        history.forEach((msg, idx) => _appendHistoryMessage(msg, false, id, idx));
      }
      _scrollToBottomNoAnim(historyEl);
      if (features.queue) {
        _qRestoreEditingInput(id);
        renderQueue();
        _updateSendUI();
      }
      if (hooks.onHistoryLoaded) hooks.onHistoryLoaded(history, data.conversation || null, id);
    } catch (e) {
      historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.load_failed', { msg: e.message || '' }))}</div>`;
    }
  }

  async function send(rawContent, extraBody) {
    if (pending) return { started: false, aborted: false, errored: false, reason: 'busy' };
    const id = config.getCurrentId();
    if (!id) return { started: false, aborted: false, errored: false, reason: 'missing_id' };
    let content = (rawContent || '').trim();
    if (!content) return { started: false, aborted: false, errored: false, reason: 'empty' };
    // Gate every chat-controller send on model config — covers the normal
    // conversation flow plus skill/agent edit chats, and also catches queue
    // drains and auto-seed sends (e.g. skills.js 'autoSeed').
    if (!ensureModelConfigured()) {
      return { started: false, aborted: false, errored: false, reason: 'model_not_configured' };
    }
    if (hooks.beforeSend) {
      const transformed = await hooks.beforeSend(content, id);
      if (transformed === null || transformed === undefined) {
        return { started: false, aborted: false, errored: false, reason: 'cancelled_by_hook' };
      }
      content = transformed;
    }

    const attachmentsForBubble = Array.isArray(extraBody && extraBody.attachments)
      ? extraBody.attachments
      : undefined;
    const attachmentCidForBubble = typeof extraBody?.attachment_cid === 'string'
      ? extraBody.attachment_cid
      : undefined;
    const referencesForBubble = Array.isArray(extraBody?.references)
      ? extraBody.references
      : undefined;
    const modelTextForBubble = typeof extraBody?.model_text === 'string' && extraBody.model_text
      ? extraBody.model_text
      : undefined;
    // Identity for the optimistic bubble, echoed back on the persisted record
    // so `_claimPersistedUserMessage` can claim this exact node. The old
    // "last user bubble without an id" guess mis-claimed whenever two sends
    // raced (queue drain, retry) — see _newClientMsgId.
    const clientMsgId = _newClientMsgId();
    const userMsgEl = _appendHistoryMessage(
      {
        role: 'user',
        content,
        // Match server's `nowIso()` format (local-time, second-precision).
        // Using `new Date().toISOString()` here would ms-bump the user
        // bubble past the server-stamped agent reply within the same
        // second and `_insertByTimestamp` would render the agent's
        // reply before the user message.
        time: nowIsoLocal(),
        _client_msg_id: clientMsgId,
        ...(attachmentsForBubble ? { attachments: attachmentsForBubble } : {}),
        ...(attachmentCidForBubble ? { attachment_cid: attachmentCidForBubble } : {}),
        ...(referencesForBubble ? { references: referencesForBubble } : {}),
        ...(modelTextForBubble ? { model_text: modelTextForBubble } : {}),
      },
      false,
      id,
    );
    if (userMsgEl) userMsgEl.dataset.clientMsgId = clientMsgId;
    if (hooks.onUserAppended) hooks.onUserAppended(userMsgEl, content, id);

    const msgEl = _createStreamingAssistantMessage(historyEl, {
      hiddenUntilActor: !!features.actorIdentity,
      messageActions: features.messageActions,
      ...(features.messageActions === 'errors-only'
        ? { failedRetryHandler: _retryFailedEditMessage, feedbackConversationId: '' }
        : {}),
    });
    if (hooks.onAssistantStart) hooks.onAssistantStart(msgEl, id);

    // On send, pin the user's message to the top while the dynamic spacer
    // can absorb reply growth. Once the spacer is consumed, live output
    // follows downward again unless the user has manually scrolled away.
    // Paired with a dynamic tail spacer so even short messages can be
    // scrolled to the top; the controller is responsible for toggling it
    // so each scene doesn't copy-paste the same logic.
    // Programmatic sends (e.g. delete-file-confirm auto-trigger) can set
    // `data-suppress-scroll-pin="1"` on the history container to skip the
    // pin once; without this the historic bubbles get pushed out of view
    // by the spacer and the user sees a "messages disappeared" flash.
    const suppressPin = historyEl.dataset.suppressScrollPin === '1';
    if (suppressPin) delete historyEl.dataset.suppressScrollPin;
    if (features.scrollPin && !suppressPin) {
      _pinMessageToTopWithDynamicSpacer(userMsgEl, historyEl);
    }

    const controller = new AbortController();
    pending = {
      controller,
      msgEl,
      userMsgEl,
      aborted: false,
      errored: false,
    };
    // Edit chats do not have the group bus's actor-start event. Start their
    // liveness/runtime clock at send time so the live bubble uses the same
    // elapsed-time surface as the main conversation, including abort/error
    // paths that may finish before a terminal backend receipt arrives.
    if (!features.actorIdentity && typeof msgEl?.querySelector === 'function') {
      _streamingUpdateActivity(msgEl, t('chat.activity_working'));
    }
    _updateSendUI();

    let terminalResult = { started: true, aborted: false, errored: false };
    try {
      const res = await apiFetch(config.streamEndpoint(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, client_msg_id: clientMsgId, ...(extraBody || {}) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      const maybeYieldToPaint = _makeStreamPaintYield();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          try {
            const ev = JSON.parse(dataLines.join('\n'));
            // Post-abort events can still arrive while main's for-await drains
            // its buffer — drop them so the bubble stays frozen at the "stopped" state
            // instead of accumulating more deltas / a final reply behind it.
            if (pending?.aborted) continue;
            // Switched away mid-stream: the placeholder bubble was detached by
            // the new view's history reset, so rendering body deltas into it is
            // wasted work. Keep a bounded set of non-delta process milestones
            // for switch-back; never abort, because the turn continues server-side.
            // Scene hooks still run so edit-scene state is intact.
            if (id === config.getCurrentId()) {
              for (const bufferedEvent of _takeOffViewGroupProcessEvents(id)) {
                _handleStreamEvent(id, msgEl, bufferedEvent, { archive: features.archive });
              }
              _handleStreamEvent(id, msgEl, ev, { archive: features.archive });
            } else {
              _bufferOffViewGroupProcessEvent(id, ev);
            }
            if (ev.type === 'final' || ev.type === 'error') {
              _clearOffViewGroupProcessEvents(id);
            }
            if (hooks.onStreamEvent) hooks.onStreamEvent(ev, msgEl, id);
            if (ev.type === 'final' && hooks.onFinal) hooks.onFinal(ev, msgEl, id);
            if (ev.type === 'error') {
              if (ev.aborted) {
                pending.aborted = true;
                pending.errored = false;
                if (hooks.onAbort) hooks.onAbort(msgEl, id);
              } else {
                pending.errored = true;
                if (hooks.onError) hooks.onError(ev.text, msgEl, id);
              }
            }
            const paintWait = maybeYieldToPaint();
            if (paintWait) await paintWait;
          } catch (err) {
            _convLog.warn('stream event handler failed', {
              cid: id,
              error: String(err && err.message || err),
            });
          }
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || pending?.aborted) {
        _streamingMarkAborted(msgEl);
        if (hooks.onAbort) hooks.onAbort(msgEl, id);
      } else {
        _streamingSetError(msgEl, err.message || String(err));
        pending.errored = true;
        _handleModelOutputErrorForUi(id, msgEl, err.message || String(err), {
          stage: 'stream_request',
          error_type: 'stream',
          failure_kind: 'runtime',
          failure_code: 'stream_request_failed',
        });
        if (hooks.onError) hooks.onError(err.message || String(err), msgEl, id);
      }
    } finally {
      const wasAborted = pending?.aborted;
      const wasErrored = pending?.errored;
      terminalResult = { started: true, aborted: !!wasAborted, errored: !!wasErrored };
      _clearOffViewGroupProcessEvents(id);
      pending = null;
      _updateSendUI();
      if (features.scrollPin) _setChatScrollOffset(false, historyEl);
      if (hooks.onDone) hooks.onDone(msgEl, id, terminalResult);
      // No re-pin at stream end — respect the user's scroll position
      // if they scrolled up mid-stream.
      // Drain one queued message if any, matching main-chat behaviour.
      if (features.queue) _qDispatchNext();
    }
    return terminalResult;
  }

  function abort() {
    if (!pending) return;
    pending.aborted = true;
    try { pending.controller.abort(); } catch (_) {}
    // Main's for-await loop only checks `cancelled` between yields, so it
    // can take a while to emit `done` — that means _streamingMarkAborted
    // (called from the catch block) runs late and the "thinking…" row stays
    // visible. Mark the bubble now so the UI terminates on click, and rely
    // on reader-loop gating (pending.aborted) to drop any stragglers.
    if (pending.msgEl) {
      try { _streamingMarkAborted(pending.msgEl); } catch (_) {}
    }
    // Immediate button feedback — fetch abort only unwinds the reader when
    // the current chunk settles, so without this the .streaming class would
    // linger and the click looks dead. See _updateSendUI's .aborting guard.
    if (features.bindInput && sendBtnEl) {
      sendBtnEl.classList.remove('streaming');
      sendBtnEl.classList.add('aborting');
      sendBtnEl.disabled = true;
    }
  }

  async function clear() {
    if (!config.clearEndpoint) return;
    const id = config.getCurrentId();
    if (!id) return;
    try {
      await apiFetch(config.clearEndpoint(id), { method: 'DELETE' });
    } catch (_) { /* ignore */ }
    historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
  }

  // Queue-aware submit: mirrors main-chat semantics.
  //   - pending stream + submit → enqueue the new message
  //   - idle + queue non-empty + submit → enqueue, so the user's stacked
  //     items keep their FIFO order (next item drains on done)
  //   - idle + empty queue → send directly
  async function _submitFromInput() {
    if (!inputEl) return;
    const content = inputEl.value;
    if (!content.trim()) return;
    const id = config.getCurrentId();
    if (features.queue && id && _qEditingItem(id)) {
      _qFinishEdit(content);
      return;
    }
    const hasQueue = features.queue && id && _qGet(id).length > 0;
    const extraBody = typeof hooks.buildExtraBody === 'function'
      ? await hooks.buildExtraBody(content, id, { pending: !!pending, hasQueue: !!hasQueue })
      : undefined;
    if (extraBody === null) return;
    inputEl.value = '';
    autoGrow(inputEl, 160);
    if (pending || hasQueue) {
      if (features.queue) enqueue(content, extraBody ? { extraBody } : {});
    } else {
      send(content, extraBody);
    }
  }

  // Wire send button + plain Enter to the controller. Scenes that have
  // their own binding (e.g. the main conversation's queue-aware logic) can
  // opt out via features.bindInput=false and just call ctrl.send() directly.
  if (features.bindInput) {
    if (sendBtnEl && !sendBtnEl.dataset.ctrlBound) {
      sendBtnEl.dataset.ctrlBound = '1';
      sendBtnEl.addEventListener('click', () => {
        if (_qEditingItem(config.getCurrentId())) _submitFromInput();
        else if (pending) abort({ userInitiated: true });
        else _submitFromInput();
      });
    }
    if (inputEl && !inputEl.dataset.ctrlBound) {
      inputEl.dataset.ctrlBound = '1';
      inputEl.addEventListener('input', () => {
        const id = config.getCurrentId();
        const item = id ? _qEditingItem(id) : null;
        if (!item) return;
        item.composer_edit.draft_content = inputEl.value || '';
        _qSave(id, _qGet(id));
      });
      inputEl.addEventListener('keydown', (e) => {
        // Plain Enter sends; Shift/Cmd/Ctrl+Enter inserts a newline. Skip IME
        // (CLAUDE.md §8 — keyCode 229 catches older Electron / Safari builds
        // where `isComposing` is occasionally inaccurate).
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape' && _qEditingItem(config.getCurrentId())) {
          e.preventDefault();
          _qFinishEdit();
          return;
        }
        if (_handleModifiedComposerEnter(e)) return;
        if (_isPlainComposerEnter(e)) {
          e.preventDefault();
          _submitFromInput();
        }
      });
    }
  }

  _qRestoreEditingInput(config.getCurrentId());
  _updateSendUI();
  return { loadHistory, send, abort, clear, isBusy, enqueue, renderQueue };
}

function _handleStreamEvent(cid, msg, ev, { archive = false } = {}) {
  if (ev.type === 'progress') {
    const evt = ev.event && ev.event.stream ? ev.event : null;
    if (_runtimeDurationMsFromEvent(evt) != null) {
      _updateStreamingRuntimeSummary(msg, evt);
    } else {
      _appendProjectedProcessRow(msg, _projectProcessRow(
        evt,
        _processDisplayContextForMessage(msg),
        ev.text,
      ));
    }
  } else if (ev.type === 'event') {
    const inner = ev.event || {};
    // Group-chat bus events arrive as `{stream:'group', data:GroupEvent}`. This
    // is the primary source (see ipc `conversations.sendStream`); the
    // `groupChat.events` observer feeds the same handler as a redundant one.
    if (inner.stream === 'group' && inner.data) {
      _handleGroupBusEvent(cid, msg, inner.data, { archive });
      return;
    }
    if (inner.stream === 'agent_created' && inner.data && inner.data.agent_id) {
      _mountCreatedAgentChip(msg, inner.data);
      return;
    }
    _renderAgentEvent(msg, ev.event);
  } else if (ev.type === 'delta') {
    _streamingAppendFinalDelta(msg, ev.text || '');
  } else if (ev.type === 'final') {
    _streamingSetFinal(msg, ev.text, { archive });
    // Attach input-form widget if the final event carries one. Main
    // already stripped the fenced block from `ev.text`, so the bubble
    // shows clean markdown + the widget below it.
    if (ev.form && typeof window.renderChatInputForm === 'function') {
      const bubble = msg.querySelector('.chat-bubble');
      if (bubble && !bubble.querySelector('.chat-input-form')) {
        if (typeof ev.msgIndex === 'number') msg.dataset.msgIndex = String(ev.msgIndex);
        const host = document.createElement('div');
        bubble.appendChild(host);
        _mountChatInputForm(host, msg, { role: 'assistant', form: ev.form }, { cid });
      }
    }
    // Created-agent chips also arrive on the final event payload — attach
    // here in case the relay event was missed (e.g. on reconnect / replay).
    const finalCreated = _normalizeCreatedAgents(ev);
    if (finalCreated) {
      for (const payload of finalCreated) _mountCreatedAgentChip(msg, payload);
    }
  } else if (ev.type === 'error') {
    if (ev.aborted) _streamingMarkAborted(msg);
    else _streamingSetError(msg, ev.text);
  }
}

// Live rows are addressed by the SAME render key the view model assigns
// (`conversation-view-model.js`), so a streaming segment and the record that
// later persists it resolve to one DOM node:
//
//   `s:<turn_id>:<seg>`  streaming actor segment
//   `m:<msg.id>`         persisted message with no segment identity
//   `u:<client_msg_id>`  optimistic user send
//   `p:<actor>`          actor known to be working before its turn id is known
//
// This replaces the old scheme, where live text was keyed to a placeholder
// bubble and the persisted record to a message id, and the two had to be
// reconciled by guessing. A failed guess printed the same reply twice.
const _groupPlaceholders = new Map(); // `${cid}|${renderKey}` → element

function _normaliseTurnId(turnId) { return turnId == null ? '' : String(turnId); }

function _conversationViewModel() {
  return (typeof window !== 'undefined' && window.ConversationViewModel) || null;
}

function _segmentRenderKey(turnId, seg) {
  const tid = _normaliseTurnId(turnId);
  if (!tid) return '';
  const index = Number.isInteger(Number(seg)) && Number(seg) >= 0 ? Number(seg) : 0;
  return `s:${tid}:${index}`;
}

/** Streaming events (`process`, `artifact_created`) address the segment they
 * belong to. Events that predate the `seg` field fall back to segment 0, which
 * is where a turn starts. */
function _eventRenderKey(evData) {
  return _segmentRenderKey(_eventTurnId(evData), evData && evData.seg);
}

/** Actor is working but its turn id is not known yet (legacy `in_flight`
 * snapshots without `active_turns`). Upgraded to a segment key as soon as a
 * real turn event arrives. */
function _pendingRenderKey(actorId) {
  return actorId ? `p:${actorId}` : '';
}

function _messageRenderKey(gm) {
  const model = _conversationViewModel();
  if (model) return model.keyForMessage(gm) || '';
  if (!gm) return '';
  if (gm.from === 'user' && gm.client_msg_id) return `u:${gm.client_msg_id}`;
  if (gm.from !== 'user' && gm.turn_id && gm.seg !== undefined && gm.seg !== null) {
    return _segmentRenderKey(gm.turn_id, gm.seg);
  }
  return gm.id ? `m:${gm.id}` : '';
}

function _phKey(cid, renderKey) { return `${cid}|${renderKey}`; }

function _stampRenderKey(el, cid, renderKey) {
  if (!el || !renderKey) return;
  el.dataset.renderKey = renderKey;
  _groupPlaceholders.set(_phKey(cid, renderKey), el);
}

/** Resolve a render key to its node. The map is the fast path; the DOM is the
 * authority, because a history rebuild replaces every node while the map still
 * holds detached ones. */
function _findRenderNode(cid, renderKey) {
  if (!renderKey) return null;
  const mapKey = _phKey(cid, renderKey);
  const cached = _groupPlaceholders.get(mapKey);
  if (cached && cached.parentElement) return cached;
  if (cached) _groupPlaceholders.delete(mapKey);
  const container = document.getElementById('chat-history');
  if (!container) return null;
  const node = container.querySelector(
    `.chat-message[data-render-key="${CSS.escape(renderKey)}"]`,
  );
  if (node) _groupPlaceholders.set(mapKey, node);
  return node || null;
}

/** Drop every live row of a turn that produced no persisted record. A silent
 * turn (terminal hand-off, aborted routing-only turn) leaves nothing the user
 * should keep reading. Persisted rows carry `data-msg-id` and are never swept. */
/** Retire live rows of this turn that an earlier segment left behind. A
 * dispatch boundary with no narration to persist ends its segment without
 * writing a record, so the row that segment opened has no message of its own —
 * its process trail is carried by the reply that closes the turn. Without this
 * the empty row would linger above the dispatched agent replies. */
function _dropSupersededTurnRows(cid, actorId, turnId, currentSeg) {
  const seg = Number(currentSeg);
  if (!Number.isInteger(seg)) return;
  for (const row of _unpersistedTurnRows(cid, actorId, turnId)) {
    const key = row.dataset.renderKey || '';
    const rowSeg = Number(key.slice(key.lastIndexOf(':') + 1));
    if (!Number.isInteger(rowSeg) || rowSeg >= seg) continue;
    _groupPlaceholders.delete(_phKey(cid, key));
    row.remove();
  }
}

function _unpersistedTurnRows(cid, actorId, turnId) {
  const tid = _normaliseTurnId(turnId);
  const container = document.getElementById('chat-history');
  if (!container) return [];
  const selectors = [`.chat-message[data-render-key^="s:${CSS.escape(tid)}:"]:not([data-msg-id])`];
  // A turn that never got far enough to stream still owns its actor-level
  // pending row.
  if (actorId) selectors.push(`.chat-message[data-render-key="p:${CSS.escape(actorId)}"]:not([data-msg-id])`);
  const out = [];
  for (const selector of tid ? selectors : selectors.slice(1)) {
    for (const node of Array.from(container.querySelectorAll(selector))) {
      if (actorId && node.dataset.fromActor && node.dataset.fromActor !== actorId) continue;
      if (node.dataset.frozenSilent === '1') continue;
      if (!out.includes(node)) out.push(node);
    }
  }
  return out;
}

function _eventTurnId(evData) {
  return _normaliseTurnId(evData && (evData.turn_id || evData.turnId));
}

function _normaliseActiveTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const startedAtMs = Number(t?.started_at_ms ?? t?.startedAtMs);
      return {
        actor: String(t?.actor || t?.actor_id || ''),
        turn_id: _normaliseTurnId(t?.turn_id || t?.turnId),
        msg_id: _normaliseTurnId(t?.msg_id || t?.msgId || t?.source_msg_id || t?.sourceMsgId),
        steerable: t?.steerable === true,
        started_at_ms: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : 0,
      };
    })
    .filter((t) => t.actor && t.turn_id);
}

// A live placeholder is disposable DOM: history reconciliation, task switches,
// and reconnect recovery may replace it while the same backend turn continues.
// Seed each replacement from the bus-owned turn start, and only ever move an
// existing start earlier, so a late recovery snapshot cannot reset the clock.
function _seedPlaceholderActivityStart(ph, startedAtMs) {
  if (!ph) return;
  const next = Number(startedAtMs);
  if (!Number.isFinite(next) || next <= 0) return;
  const current = Number(ph.dataset.activityStart);
  if (!Number.isFinite(current) || current <= 0 || next < current) {
    ph.dataset.activityStart = String(next);
  }
}

function _startPlaceholderActivity(ph, startedAtMs) {
  if (!ph) return;
  _seedPlaceholderActivityStart(ph, startedAtMs);
  // Empty label preserves a more specific existing state ("writing", retry)
  // while still starting the generic liveness strip and total-time clock for
  // a newly claimed turn.
  _streamingUpdateActivity(ph, '');
}

function _stampPlaceholderTriggerMsg(ph, msgId) {
  const id = _normaliseTurnId(msgId);
  if (ph && id) ph.dataset.triggerMsgId = id;
}

function _knownGroupActorLabel(cid, actorId) {
  if (!actorId) return '';
  if (actorId === 'commander') return t('chat.from_commander');
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === actorId);
    if (a && a.name) return a.name;
  }
  const cached = _groupMembersCache.get(cid) || [];
  const a = cached.find((x) => x && x.id === actorId);
  return a && a.name ? a.name : '';
}

function _setPlaceholderActor(ph, actorId, opts = {}) {
  if (!ph) return;
  const cid = opts.cid || currentCid;
  const force = !!opts.force;
  ph.dataset.fromActor = actorId || '';
  const label = _knownGroupActorLabel(cid, actorId);
  const ready = !!actorId && (actorId === 'commander' || !!label || !!opts.allowFallback);
  const chip = ph.querySelector('[data-role="from-chip"]');
  if (chip && (force || !chip.textContent)) {
    chip.textContent = label || (opts.allowFallback ? t('chat.from_agent_unknown') : '');
  }
  const avatarSlot = ph.querySelector('[data-role="from-avatar"]');
  if (avatarSlot && actorId && (force || !avatarSlot.firstChild)) {
    avatarSlot.innerHTML = label
      ? _renderActorAvatarHtml(actorId)
      : '';
  }
  _decorateActorHeader(ph, actorId);
  if (ph.dataset.identityPending === '1') {
    if (ready) {
      ph.style.display = '';
      delete ph.dataset.identityPending;
    } else {
      ph.style.display = 'none';
    }
  }
  if (actorId && ph.parentElement) {
    _removeSupersededInterruptionBubbles(ph.parentElement);
  }
}

function _refreshActorPlaceholders(cid, actorId) {
  if (!cid) return;
  for (const [key, ph] of _groupPlaceholders.entries()) {
    if (!key.startsWith(`${cid}|`)) continue;
    const id = ph?.dataset?.fromActor || key.slice(`${cid}|`.length);
    if (actorId && id !== actorId) continue;
    _setPlaceholderActor(ph, id, { cid, force: true, allowFallback: !!id && id !== 'commander' });
  }
}

function _ensureActorPlaceholder(cid, actorId, fallbackPh, turnId, triggerMsgId, startedAtMs, seg) {
  const tid = _normaliseTurnId(turnId);
  const sourceMsgId = _normaliseTurnId(triggerMsgId);
  const allowFallback = !!actorId && actorId !== 'commander';
  const renderKey = tid ? _segmentRenderKey(tid, seg) : _pendingRenderKey(actorId);
  if (!renderKey) return null;

  let ph = _findRenderNode(cid, renderKey);
  if (ph) {
    // A finalized row is a history record, never a streaming target again:
    // reusing it would overwrite persisted content with the next turn's text.
    if (ph.dataset.finalized === '1') return null;
    _stampPlaceholderTriggerMsg(ph, sourceMsgId);
    _startPlaceholderActivity(ph, startedAtMs);
    return ph;
  }

  // A turn's first real event upgrades the actor-level pending row it created
  // before its turn id was known, so the "thinking" bubble keeps its position
  // instead of being replaced by a second one below it.
  if (tid) {
    const pendingKey = _pendingRenderKey(actorId);
    const pendingPh = pendingKey ? _findRenderNode(cid, pendingKey) : null;
    if (pendingPh && pendingPh.dataset.finalized !== '1') {
      _groupPlaceholders.delete(_phKey(cid, pendingKey));
      pendingPh.dataset.turnId = tid;
      _stampRenderKey(pendingPh, cid, renderKey);
      _stampPlaceholderTriggerMsg(pendingPh, sourceMsgId);
      _startPlaceholderActivity(pendingPh, startedAtMs);
      _setPlaceholderActor(pendingPh, actorId, { cid, allowFallback });
      return pendingPh;
    }
  }

  // Hand-off floor guard: once the commander has handed the floor to an agent,
  // it produces no further output, so it must neither mint a fresh placeholder
  // NOR adopt the turn's initial one — either would leave an empty "thinking"
  // Commander bubble beside the agent's reply for the whole hand-off. This sits
  // ahead of adoption for that reason. `dispatch_to` does not set the floor, so
  // its post-dispatch synthesis still opens a row when its delta arrives, and a
  // pre-hand-off narration segment was already claimed above.
  if (actorId === 'commander') {
    const floor = _serverFloorByCid.get(cid) || '';
    if (floor && floor !== 'commander' && floor !== 'user') return null;
  }

  // Adopt the controller's initial placeholder for the first actor seen, so we
  // don't waste it on an empty bubble when only one actor runs. Skip adoption
  // once it has been claimed by another row or finalized in a prior turn.
  if (fallbackPh && fallbackPh.parentElement
      && fallbackPh.dataset.finalized !== '1'
      && !fallbackPh.dataset.renderKey
      && (!fallbackPh.dataset.fromActor || fallbackPh.dataset.fromActor === actorId)) {
    if (tid) fallbackPh.dataset.turnId = tid;
    _stampRenderKey(fallbackPh, cid, renderKey);
    _stampPlaceholderTriggerMsg(fallbackPh, sourceMsgId);
    _startPlaceholderActivity(fallbackPh, startedAtMs);
    _setPlaceholderActor(fallbackPh, actorId, { cid, allowFallback });
    return fallbackPh;
  }
  const container = document.getElementById('chat-history');
  if (!container) return null;
  ph = _createStreamingAssistantMessage(container, { hiddenUntilActor: true, triggerMsgId: sourceMsgId });
  if (tid) ph.dataset.turnId = tid;
  _stampRenderKey(ph, cid, renderKey);
  _startPlaceholderActivity(ph, startedAtMs);
  _setPlaceholderActor(ph, actorId, { cid, allowFallback });
  if (actorId && actorId !== 'commander' && !_knownGroupActorLabel(cid, actorId)) {
    _refreshGroupMembers(cid).then(() => _refreshActorPlaceholders(cid, actorId)).catch(() => {});
  }
  return ph;
}

/** Resolve the live row a persisted record belongs to. Identity is the record's
 * own render key — the same key its stream already wrote to — so there is no
 * fallback chain to mis-resolve. Returns null when the record has no live row
 * (a turn that never streamed), and the caller renders it fresh. */
function _claimRenderNodeForMessage(cid, gm) {
  const renderKey = _messageRenderKey(gm);
  if (!renderKey) return null;
  const ph = _findRenderNode(cid, renderKey);
  if (!ph || !ph.parentElement) return null;
  // An actor-level pending row belongs to whichever turn is streaming; only a
  // segment row can be claimed by a persisted record.
  if (ph.dataset.finalized === '1') return null;
  ph.dataset.finalized = '1';
  return ph;
}

// Transform a streaming placeholder bubble into its finalized form:
// freeze the process rail (keep visible + collapsed by default),
// render markdown into [data-role="final"], append produced-files chip /
// form widget / created-agent chip / submission-tag stripping for user
// messages — everything appendChatMessage would have done. Pre-existing
// stream content (live deltas) is replaced with the canonical text from
// the GroupMessage so the bubble matches the persisted record.
function _finalizeActorPlaceholder(ph, gm, cid, archive) {
  if (!ph || !gm) return;
  if (gm.id) {
    const container = document.getElementById('chat-history');
    const existing = container?.querySelector(`.chat-message[data-msg-id="${CSS.escape(String(gm.id))}"]`);
    if (existing && existing !== ph) {
      _syncRenderedGroupMessageIdentity(existing, gm);
      ph.remove();
      return;
    }
  }
  const container = document.getElementById('chat-history');
  const existingByKey = _findRenderedGroupMessage(container, gm, ph);
  if (existingByKey) {
    if (gm.id && !existingByKey.dataset.msgId) {
      existingByKey.remove();
    } else {
      _syncRenderedGroupMessageIdentity(existingByKey, gm);
      ph.remove();
      return;
    }
  }
  ph.dataset.fromActor = String(gm.from || '');
  ph.dataset.msgId = String(gm.id || '');
  if (gm.failure_kind) ph.dataset.failureKind = String(gm.failure_kind);
  if (gm.failure_code) ph.dataset.failureCode = String(gm.failure_code);

  // The placeholder was positioned at execution start. Once the canonical
  // reply arrives, adopt its persisted timestamp and move the row to the same
  // chronological position a history reload would use. This is especially
  // important when the user sends a queued message into the active run: the
  // final AI reply must settle after that newer user message instead of
  // remaining visually pinned above it.
  _syncRenderedGroupMessageIdentity(ph, gm);
  const timeEl = ph.querySelector('.chat-msg-time');
  if (timeEl && gm.ts) timeEl.textContent = formatTime(gm.ts);
  // Also fill the from chip in case state_changed never set it.
  _setPlaceholderActor(ph, gm.from, { cid, force: true, allowFallback: true });

  // Plan-announcement label (commander first plan_set).
  if (gm.plan_announcement) {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble && !bubble.querySelector('.chat-plan-announce')) {
      const lbl = document.createElement('div');
      lbl.className = 'chat-plan-announce';
      lbl.innerHTML = `${_uiIconHtml('clipboard-list', 'ui-icon chat-plan-announce-icon')}<span>${escapeHtml(t('chat.plan_announce'))}</span>`;
      bubble.insertBefore(lbl, bubble.firstChild);
    }
  }

  // Final markdown body: reuses the legacy helper which preserves the
  // .stream-process rail (collapsed if non-empty, hidden if empty) so
  // tool calls stay scannable after the reply lands.
  const text = String(gm.text || '');
  const failedAssistant = _isFailedAssistantContent(text, gm);
  const interruptedAssistant = _isInterruptedAssistantMessage(gm);
  _streamingSetFinal(ph, text, { archive: archive && !failedAssistant && !interruptedAssistant });
  if (failedAssistant) {
    _attachFailedAssistantActions(ph, () => _messageTextForActions(ph, text));
    _handleModelOutputErrorForUi(cid, ph, _failedAssistantErrorText(ph) || text, {
      stage: 'actor_final',
      error_type: 'model_output',
      failure_kind: String(gm.failure_kind || ''),
      failure_code: String(gm.failure_code || ''),
    });
  } else if (interruptedAssistant) {
    _attachInterruptedAssistantActions(ph, () => _messageTextForActions(ph, text), { archive });
  }
  // NB: the conversation-level failed mark is NOT set here. It is owned by the
  // cross-cid message hook in `_handleGroupBusEvent` (fires for foreground AND
  // background convs, before finalize) and by `_syncFailedFromHistory` (cold
  // load / polled recovery). Keeping it out of this DOM-finalize path avoids
  // missing background convs and no-placeholder appends.

  // Lazily allocate the below-bubble actions row (post-stream placeholders
  // didn't get one at creation time; appendChatMessage history bubbles do).
  let actionsRow = ph.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    ph.appendChild(actionsRow);
  }

  // Created-agent chips (commander quick-create / quick-edit) — same actions row.
  const gmCreated = _normalizeCreatedAgents(gm);
  if (gmCreated) {
    for (const payload of gmCreated) _mountCreatedAgentChip(ph, payload);
  }
  // Created-skill chip (commander skill create / edit).
  const gmSkills = _normalizeCreatedSkills(gm);
  if (gmSkills) {
    for (const payload of gmSkills) _mountCreatedSkillChip(ph, payload);
  }

  // Form widget (agent → user input form).
  if (gm.form && typeof window.renderChatInputForm === 'function') {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble && !bubble.querySelector('.chat-input-form')) {
      const host = document.createElement('div');
      bubble.appendChild(host);
      const formMessage = {
        role: 'assistant',
        form: gm.form,
        _msg_id: gm.id,
      };
      _mountChatInputForm(host, ph, formMessage, { cid });
    }
  }

  if (Array.isArray(gm.marketplace_requests) && gm.marketplace_requests.length) {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble) {
      const reqMessage = {
        role: 'assistant',
        marketplace_requests: gm.marketplace_requests,
        _msg_id: gm.id,
      };
      _mountMarketplaceInstallRequests(bubble, ph, reqMessage, { cid });
    }
  }

  // Interactive web-app artifacts (chat-app:// iframe). Idempotent — skips
  // ids already mounted in this bubble.
  if (Array.isArray(gm.artifacts) && gm.artifacts.length && typeof window.mountMessageArtifacts === 'function') {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble) window.mountMessageArtifacts(bubble, gm.artifacts, cid);
  }
  if (Array.isArray(gm.produced) && gm.produced.length) {
    _mountMessageProducedFooter(ph, gm.produced);
  }
  _scheduleConversationInfoFileRefresh(cid);
}

// Group-chat bus event router. Each event is one of:
//   { type: 'message', cid, msg: GroupMessage, turn_id? }
//   { type: 'process', cid, actor, turn_id?, data: { type, text?, event? } }
//   { type: 'agent_run_result', cid, actor, actor_type, turn_id?, data }
//   { type: 'artifact_created', cid, actor, turn_id?, artifact: { id, title, agent_id } }
//   { type: 'state_changed', cid, state: { status, in_flight }, active_turns? }
//   { type: 'member_joined', cid, actor }
//   { type: 'aborted', cid }
function _handleGroupBusEvent(cid, streamingMsg, evData, { archive = false } = {}) {
  if (!evData || typeof evData !== 'object') return;
  if (evData.type === 'agent_run_result') {
    return;
  }
  if (
    evData.type === 'process'
    || evData.type === 'artifact_created'
    || (evData.type === 'message' && evData.msg && evData.msg.from !== 'user')
  ) {
    _lastGroupWorkEventAt.set(cid, Date.now());
  }
  // Bump the conv to the top of the sidebar list whenever a user-visible
  // message lands — applies to both currently-viewed and background convs,
  // so the sidebar stays ordered by last activity in real time. Skip
  // internal commander→agent dispatch records (they're not visible in the
  // user's view; visible end-of-turn replies will bump shortly after).
  if (evData.type === 'message' && evData.msg && !evData.msg.dispatch) {
    // Conversation-level failed mark — evaluated here for BOTH the open conv and
    // BACKGROUND convs (this runs before the cross-cid buffer/return below), so a
    // task that fails while the user is looking elsewhere lights up its sidebar
    // row immediately. That's the whole point: surface which conversations
    // failed without having to open them. Keys off the actor's END-OF-TURN reply
    // and the STRUCTURED failure signal only — last reply wins, a clean reply
    // clears. `onAssistantStart` clears on the next turn (covers Retry).
    if (evData.turn_end && evData.msg.from !== 'user') {
      _setConvTurnSettlement(
        cid,
        _isStructuredFailure(evData.msg) ? 'failed' : 'completed',
        {
          source: 'turn_end_reply',
          runId: evData.turn_id,
          // Do not manufacture a canonical ordering timestamp from renderer
          // receive time when an older producer omits `msg.ts`.
          finishedAtMs: Date.parse(evData.msg.ts || ''),
        },
      );
      // Video review panel: production state only changes through agent
      // turns, so refresh (debounced, current-conversation-only) here.
      try { window.VideoReviewPanel?.notifyTurnEnd?.(cid); } catch (_) { /* optional surface */ }
    }
    _bumpConvToTop(cid, evData.msg.ts);
    if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid);
    // Mark commander as "in chat" the moment it speaks here, so the
    // chat header's actor stack adds the commander avatar without waiting
    // for the next `listConversations` to re-derive it from <cid>.jsonl.
    if (evData.msg.from === 'commander' && Array.isArray(conversations)) {
      const conv = conversations.find((x) => x && x.conversation_id === cid);
      if (conv && !conv.commander_in_chat) {
        conv.commander_in_chat = true;
        if (cid === currentCid) {
          try { _refreshChatHeader(); } catch (_) { /* not yet bound */ }
        }
      }
    }
    if (evData.msg.from !== 'user') _scheduleConversationInfoFileRefresh(cid);
    // Global cache refresh — must happen BEFORE the cross-cid early-return
    // below, since the agents/skills tabs are global UI surfaces. Without
    // this hop, creating a skill / agent from a background conv leaves
    // `_agentsCache` / `_skillsCache` stale: the tab still shows the old
    // list until manual refresh. The per-bubble chip mount path also calls
    // these (via `_mountCreatedAgentChip` / `_mountCreatedSkillChip`),
    // but only for the conv the user is currently viewing — this branch
    // is the catch-all so background-conv creates still propagate.
    if (_normalizeCreatedAgents(evData.msg)) { try { loadAgents?.(true); } catch (_) {} }
    if (_normalizeCreatedSkills(evData.msg) && typeof loadSkills === 'function') {
      try { loadSkills(true); } catch (_) {}
    }
  }
  // Cross-cid leakage guard: per-cid controllers stay alive when the user
  // navigates away mid-stream (a legit pattern — let the conv finish in
  // the background, sidebar badge tracks completion). But all cids share
  // the SAME `chat-history` DOM, and `_createStreamingAssistantMessage`
  // appends fresh placeholder bubbles to whatever element
  // `getElementById('chat-history')` returns — i.e. the currently-viewed
  // conv. Without this guard, switching from cid A (still streaming) to
  // cid B causes A's process / state_changed events to mint NEW bubbles
  // inside B's view, so users see "two streams running simultaneously".
  // Persistence isn't affected (jsonl is written by the bus regardless).
  // Observer-delivered events are dropped here to avoid a second delivery
  // path; the primary send stream separately retains a bounded set of process
  // milestones until switch-back, while body text comes from canonical history.
  if (cid !== currentCid) return;
  if (evData.type === 'message') {
    const gm = evData.msg;
    if (!gm) return;
    // The user's own send is already rendered optimistically by the input
    // handler. Still stamp it with the persisted message id once the bus echoes
    // the write, so history reconciliation can prove the DOM matches jsonl
    // instead of forcing a late reload.
    if (gm.from === 'user') {
      _renderOrClaimPersistedUserMessage(cid, gm);
      return;
    }
    // Internal plan-step dispatch (commander → agent) — agent slice gets
    // it for context, user view ignores. See loadConversationHistory's
    // matching filter for refresh consistency.
    if (gm.dispatch) return;
    // `turn_end: true` ONLY when this message is the actor's own end-of-turn
    // reply (bus marks it via runTurn). Tool-emitted side-effect messages
    // (plan_set's plan announcement, plan_executor's commander → agent
    // dispatch) come WITHOUT this flag — they're "the actor said this
    // mid-turn", not "the actor is done." Consuming the streaming
    // placeholder for mid-turn messages causes a stuck-bubble bug:
    // post-tool process events recreate a new placeholder that nothing
    // ends up consuming when the actor's actual turn finishes silent.
    const isTurnEnd = !!evData.turn_end;
    // A commander reasoning segment (a turn split at a visible-dispatch
    // boundary) carries `seg` with turn_end:false. Like a turn-end message it
    // must CONSUME + finalize the live placeholder rather than append a
    // duplicate bubble alongside it: that finalizes the pre-dispatch reasoning
    // as its own bubble, and the next commander delta opens a fresh placeholder
    // BELOW the dispatched agent, so the post-handback synthesis reads as a new
    // bubble in the loop.
    const isCommanderSegment = !isTurnEnd
      && gm.seg !== undefined && String(gm.from || '') === 'commander';
    if (isTurnEnd || isCommanderSegment) {
      // Finalize THIS actor's placeholder in place — preserves the process
      // rail (tool calls, progress lines) accumulated during the turn so
      // it stays readable after the reply settles. If we don't have a
      // placeholder (history-replay race, or message arrived before any
      // state_changed), fall back to a fresh appendChatMessage.
      // Rows opened by earlier segments of this same turn that never got a
      // record of their own are superseded by this reply.
      if (gm.turn_id && gm.seg !== undefined && gm.seg !== null) {
        _dropSupersededTurnRows(cid, String(gm.from || ''), gm.turn_id, gm.seg);
      }
      const ph = _claimRenderNodeForMessage(cid, gm);
      if (ph && ph.parentElement) {
        _finalizeActorPlaceholder(ph, gm, cid, archive);
      } else {
        const legacy = _groupMsgToLegacy(gm);
        const bubble = appendChatMessage(legacy, true, { cid, archive });
        if (bubble) bubble.dataset.fromActor = String(gm.from || '');
        // Cache-refresh parity with `_mountCreatedAgentChip`: the placeholder
        // path goes through it (which calls loadAgents/loadSkills(true)),
        // but this fallback runs appendChatMessage directly which only
        // paints the chip — without this hop, fast turns that emit zero
        // process events leave _agentsCache / _skillsCache stale, so the
        // newly-created agent is missing from the agents tab and the @
        // picker until a manual refresh.
        if (_normalizeCreatedAgents(gm)) { try { loadAgents?.(true); } catch (_) {} }
        if (_normalizeCreatedSkills(gm) && typeof loadSkills === 'function') {
          try { loadSkills(true); } catch (_) {}
        }
      }
      if (isTurnEnd) _evaluateAutoRecipient(cid);
    } else {
      // Mid-turn side-effect message (plan announcement etc., no `seg`) —
      // append a new bubble alongside, leave the streaming placeholder alive
      // for the rest of the actor's turn.
      const legacy = _groupMsgToLegacy(gm);
      const bubble = appendChatMessage(legacy, true, { cid, archive });
      if (bubble) bubble.dataset.fromActor = String(gm.from || '');
    }
    // (Removed pre-seed-recipient-placeholder logic.) Earlier I pre-created
    // placeholders for each `gm.to` agent on commander's dispatch message,
    // hoping to pin bubble order to dispatch sequence. But that interleaves
    // dispatch bubbles with placeholders in the DOM (`A_dispatch, A_ph,
    // B_dispatch, B_ph, ...`) — exactly the "messy realtime order" the user
    // complained about.
    //
    // Bus naturally serializes top-level turns (one per-conversation runtime
    // inbox; sync queue.push + wake → microtask), and `markInFlight` is
    // mutex-guarded. So
    // `state_changed` events arrive at renderer in dispatch order. The
    // `state_changed` handler creates each agent's placeholder at the end
    // of `chat-history` in turn, AFTER all dispatch bubbles. Final layout:
    // `[A_dispatch, B_dispatch, C_dispatch, A_ph, B_ph, C_ph]` — matches
    // the post-refresh / jsonl order.
  } else if (evData.type === 'process') {
    const actor = String(evData.actor || '');
    const turnId = _eventTurnId(evData);
    const data = evData.data || {};
    if (!actor) return;
    // No duplicate rejection here: the observer skips `process` events while
    // the primary stream is alive (`_isPrimaryOwnedLiveEvent`), so a stable
    // event is delivered once. A re-delivered one could no longer recreate a
    // consumed Commander bubble anyway — rows are addressed by render key, and
    // a settled row is never reopened as a streaming target.
    // A renderer can attach after the actor's initial `state_changed(running)`
    // event has already passed (refresh, tab switch, scheduled/remote run).
    // Process events are proof that work is still active, so recover the
    // composer state here instead of leaving the button in blue "send" mode
    // while a live placeholder is visibly thinking.
    if (!isGroupConversationBusy(cid)) {
      setGroupConversationBusy(cid, true);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
      if (cid === currentCid) _updateConvSendUI(cid);
    }
    // Once Commander has flushed a segment it is inside a dispatch loop, and
    // its remaining tool progress is orchestration bookkeeping while a delegated
    // agent works. Opening a row for that would put an empty "thinking"
    // Commander bubble beside the agent's reply for the whole hand-off. Wait for
    // real output: a delta (or the persisted record) opens the row instead.
    const visiblePlanEvent = data.type === 'event' && _isProcessPlanEvent(data.event);
    const orchestrationIdle = actor === 'commander'
      && Number(evData.seg) > 0
      && data.type !== 'delta'
      && !visiblePlanEvent
      && !_findRenderNode(cid, _segmentRenderKey(turnId, evData.seg));
    if (orchestrationIdle) return;
    const target = _ensureActorPlaceholder(
      cid, actor, streamingMsg, turnId, undefined, undefined, evData.seg,
    );
    if (!target) {
      _convLog.warn('group process target missing', {
        cid,
        actor,
        kind: data.type || '',
      });
      return;
    }
    // Diagnostic — count how many deltas reach the renderer per actor.
    // If this number is much smaller than the bus emit count from the
    // turn-end log, the bottleneck is upstream (IPC batching). If it's
    // similar, the bottleneck is in the rAF flush / markdown render.
    if (typeof window !== 'undefined') {
      window._convDeltaCount = window._convDeltaCount || {};
      if (data.type === 'delta') {
        window._convDeltaCount[actor] = (window._convDeltaCount[actor] || 0) + 1;
      }
    }
    try {
      if (data.type === 'commentary-finalized') {
        _advanceStreamingMessageActivityPosition(target);
        _streamingFinalizeCommentary(target, data.text);
        _streamingUpdateActivity(target, t('chat.activity_writing'));
      } else if (data.type === 'delta' && typeof data.text === 'string') {
        // Token-by-token streaming → write into the placeholder's final
        // body so the user sees the reply form character-by-character.
        if (data.text) _advanceStreamingMessageActivityPosition(target);
        _streamingAppendFinalDelta(target, data.text, data.phase);
        _streamingUpdateActivity(target, t('chat.activity_writing'));
      } else if (data.type === 'progress' && data.text) {
        _advanceStreamingMessageActivityPosition(target);
        const evt = data.event && data.event.stream ? data.event : null;
        if (_runtimeDurationMsFromEvent(evt) != null) {
          _updateStreamingRuntimeSummary(target, evt);
        } else {
          _appendProjectedProcessRow(target, _projectProcessRow(
            evt,
            _processDisplayContextForMessage(target),
            data.text,
          ));
        }
        if (evt) _streamingUpdateActivityFromEvent(target, evt);
        else _streamingUpdateActivity(target, t('chat.activity_working'));
      } else if (data.type === 'event') {
        _advanceStreamingMessageActivityPosition(target);
        const evt = data.event || {};
        // `_renderAgentEvent` owns both formatting and lifecycle-keyed row
        // upserts. A terminal event normally replaces its start row in place,
        // so an unchanged row count is success rather than a render failure.
        _renderAgentEvent(target, evt);
        _streamingUpdateActivityFromEvent(target, evt);
      }
    } catch (err) {
      const evt = data.event || {};
      // Rendering may fail after the keyed row was already appended (for
      // example while following scroll position). Retrying here without a
      // transaction boundary would turn a recoverable UI error into a visible
      // duplicate, so the single projection attempt remains authoritative.
      _convLog.warn('group process render failed', {
        cid,
        actor,
        kind: data.type || '',
        stream: evt.stream || '',
        error: String(err && err.message || err),
      });
    }
  } else if (evData.type === 'artifact_created') {
    const actor = String(evData.actor || evData.artifact?.agent_id || '');
    const turnId = _eventTurnId(evData);
    const artifact = evData.artifact || {};
    if (!actor || !artifact.id) return;
    if (!isGroupConversationBusy(cid)) {
      setGroupConversationBusy(cid, true);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
      if (cid === currentCid) _updateConvSendUI(cid);
    }
    const target = _ensureActorPlaceholder(
      cid, actor, streamingMsg, turnId, undefined, undefined, evData.seg,
    );
    const bubble = target?.querySelector?.('.chat-bubble');
    if (bubble && typeof window.mountMessageArtifacts === 'function') {
      _advanceStreamingMessageActivityPosition(target);
      window.mountMessageArtifacts(bubble, [artifact], cid);
      _stickBottomFromMsg(target);
    }
  } else if (evData.type === 'segment_boundary') {
    // A dispatch boundary. Whatever live row this actor still holds for the turn
    // is orchestration bookkeeping — the tool call that performed the dispatch —
    // and would otherwise sit as an empty bubble beside the delegated agent's
    // reply for the whole hand-off. Rows the bus already persisted carry a
    // message id and are left alone, so a narration segment survives untouched.
    const actorId = String(evData.actor || '');
    if (actorId) {
      for (const row of _unpersistedTurnRows(cid, actorId, _eventTurnId(evData))) {
        _groupPlaceholders.delete(_phKey(cid, row.dataset.renderKey || ''));
        row.remove();
      }
    }
  } else if (evData.type === 'state_changed') {
    // Each in_flight actor gets a placeholder so its delta tokens / tool
    // calls render in its own bubble even before its `message` arrives.
    // Adopt the controller's initial placeholder for the first actor.
    const st = evData.state || {};
    const inFlight = Array.isArray(st.in_flight) ? st.in_flight.slice() : [];
    const hasActiveTurnsField = Array.isArray(evData.active_turns);
    const activeTurns = _normaliseActiveTurns(evData.active_turns);
    // Mirror the server floor BEFORE seeding placeholders below: the hand-off
    // guard in `_ensureActorPlaceholder` (skip an empty commander placeholder
    // while the floor points at an agent) reads `_serverFloorByCid`, so it must
    // be current for THIS event or the commander bubble flickers during the
    // handed-off agent's reply.
    _serverFloorByCid.set(cid, typeof st.active_recipient === 'string' ? st.active_recipient : '');
    setGroupConversationBusy(cid, st.status === 'running' || inFlight.length > 0 || activeTurns.length > 0);
    if (hasActiveTurnsField) {
      for (const turn of activeTurns) {
        _ensureActorPlaceholder(cid, turn.actor, streamingMsg, turn.turn_id, turn.msg_id, turn.started_at_ms);
      }
    } else if (inFlight.length) {
      for (const actorId of inFlight) {
        if (!actorId) continue;
        _ensureActorPlaceholder(cid, actorId, streamingMsg);
      }
    }
    // Reconcile against the snapshot. `state` is level-triggered — the relay
    // Server stores it last-write-wins and replays it on every WS reconnect —
    // so an actor that has dropped out of `in_flight` is no longer running.
    // Drop its EMPTY streaming placeholder: an orphan dancing-dots bubble that
    // no `message` / `turn_silent` will ever consume (the stuck "thinking"
    // bubble seen on iOS when a stale running snapshot trails the turn-end one).
    // Same content guard as the `aborted` sweep below — a placeholder that
    // accumulated a process rail / final text is owned by a worker whose
    // turn-end event will finalize it, so leave those alone.
    const _liveKeys = new Set();
    for (const actorId of inFlight) {
      _liveKeys.add(_phKey(cid, _pendingRenderKey(actorId)));
    }
    const _liveSegmentPrefixes = [];
    for (const turn of activeTurns) {
      _liveKeys.add(_phKey(cid, _pendingRenderKey(turn.actor)));
      _liveSegmentPrefixes.push(_phKey(cid, `s:${turn.turn_id}:`));
    }
    for (const k of Array.from(_groupPlaceholders.keys())) {
      if (!k.startsWith(`${cid}|`)) continue;
      if (_liveKeys.has(k) || _liveSegmentPrefixes.some((prefix) => k.startsWith(prefix))) continue;
      const ph = _groupPlaceholders.get(k);
      // The map is only a lookup cache; duplicate delivery or history recovery
      // can cache a persisted row here too. A state snapshot may retire live
      // placeholders, but it must never remove a canonical history record.
      if (ph?.dataset?.msgId) {
        _groupPlaceholders.delete(k);
        continue;
      }
      const processBody = ph?.querySelector('[data-role="process"]');
      const hasProcess = !!processBody && processBody.children.length > 0;
      const finalBody = ph?.querySelector('[data-role="final"]');
      const hasFinalText = !!finalBody && (finalBody.textContent || '').trim().length > 0;
      if (hasProcess || hasFinalText) continue;
      _groupPlaceholders.delete(k);
      if (ph && ph.parentElement) ph.remove();
    }
    _latestInFlight.set(cid, inFlight);
    _latestActiveTurns.set(cid, hasActiveTurnsField ? activeTurns : []);
    // Floor already mirrored above (before seeding). Re-point the composer chip.
    _evaluateAutoRecipient(cid);
    if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid, { silent: true });
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) {
      _renderMessageQueueForRuntimeState(cid);
      _updateConvSendUI(cid);
    }
  } else if (evData.type === 'aborted') {
    _stopRuntimeActorRecovery(cid);
    setGroupConversationBusy(cid, false);
    _latestInFlight.set(cid, []);
    _latestActiveTurns.set(cid, []);
    _refreshTaskSurfacesAfterAbort(cid);
    // Only drop EMPTY placeholders here (queued-but-not-yet-running workers
    // whose queue got cleared by bus.abort never fire runTurn → no follow-up
    // message/turn_silent → their dancing-dot placeholder would be orphaned
    // forever without this sweep).
    //
    // Placeholders that already accumulated process content (tool calls,
    // progress lines, deltas) belong to a worker whose `runTurn` IS in
    // flight — its abort path will emit a `message` (persist with process
    // info attached) or `turn_silent` event right after this; let those
    // handlers consume the same DOM node so the user sees a single
    // continuous bubble (process rail rendered during streaming → text body
    // finalized in place) instead of the original "process info disappears,
    // then reappears in a new bubble" jump caused by aggressive removal.
    for (const k of Array.from(_groupPlaceholders.keys())) {
      if (!k.startsWith(`${cid}|`)) continue;
      const ph = _groupPlaceholders.get(k);
      const processBody = ph?.querySelector('[data-role="process"]');
      const hasProcess = !!processBody && processBody.children.length > 0;
      const finalBody = ph?.querySelector('[data-role="final"]');
      const hasFinalText = !!finalBody && (finalBody.textContent || '').trim().length > 0;
      if (hasProcess || hasFinalText) continue; // owned by a running worker — leave for message/turn_silent
      _groupPlaceholders.delete(k);
      if (ph && ph.parentElement) ph.remove();
    }
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) {
      _renderMessageQueueForRuntimeState(cid);
      _updateConvSendUI(cid);
    }
  } else if (evData.type === 'turn_silent') {
    // The actor's turn ended without producing a persisted message
    // (executor returned outcome=silent). Two sub-cases:
    //   (a) Placeholder accumulated process info (tool calls, progress
    //       lines, deltas) — FREEZE it as a finalized "thinking trail"
    //       bubble. Don't delete: user wants to see what the actor did
    //       during the silent turn (e.g. commander wrote a plan via
    //       plan_set; the process trail shows the tool call + reasoning).
    //   (b) Placeholder is empty (no process events) — DELETE it. Nothing
    //       useful to preserve; an empty zombie bubble is just noise.
    const actorId = String(evData.actor || '');
    if (actorId) {
      // The turn's live rows, oldest first. Everything before the last one is
      // superseded residue from earlier segments of the same silent turn.
      const rows = _unpersistedTurnRows(cid, actorId, _eventTurnId(evData));
      const ph = rows.pop() || null;
      for (const stale of rows) {
        _groupPlaceholders.delete(_phKey(cid, stale.dataset.renderKey || ''));
        stale.remove();
      }
      if (ph) {
        ph.dataset.finalized = '1';
        const processBody = ph.querySelector('[data-role="process"]');
        const procLines = processBody ? Array.from(processBody.children) : [];
        const hasProcess = procLines.length > 0;
        // A silent turn that ONLY routed (a delegation call, plus the reads the
        // commander did to decide the routing) carries nothing worth showing:
        // the commander already announced the delegation in its own prose
        // message (a seg bubble), and the delegate's reply follows. Freezing it
        // leaves a redundant, out-of-order process-only bubble (it settles at
        // the silent turn's end — AFTER the delegate has already rendered — so
        // it reads as the commander "speaking again" below the reply). Treat it
        // like an empty turn and drop the bubble. Any real work in the trail
        // (a plan_set, write_file, bash, a non-routing tool) keeps the freeze
        // path. A common trigger is `read_file <agent>/agent.json` before
        // `hand_off_to`, which the old "every line is hand_off_to" check missed.
        const eventNames = procLines.map((el) => (el.dataset && el.dataset.eventName) || '');
        const routingOnly = hasProcess && _isRoutingOnlyEventNames(eventNames);
        // Do not infer terminal-delivery semantics from the tool mix. The main
        // process marks a successful hand_off_to explicitly because prep tools
        // (including failed manage_execution_plan calls) may precede it. In
        // that case the target agent's bubble is already the answer, so even a
        // process-bearing commander placeholder must be removed.
        const terminalHandoff = evData.reason === 'terminal_handoff';
        const discardPlaceholder = hasProcess
          && _shouldDiscardSilentPlaceholder(evData.reason, eventNames);
        if (hasProcess && !discardPlaceholder) {
          // Freeze the bubble: hide thinking dots, leave process rail as
          // a folded "completed thinking" bubble. Empty final body = no main text.
          // `data-frozen-silent="1"` opts this bubble out of the stream-end
          // orphan purge — see `_settleDanglingActorPlaceholders`. Without
          // the opt-out the purge (which uses "no msg-id" as the orphan
          // signal) would sweep this intentional process-only trail too.
          if (typeof _streamingSetFinal === 'function') {
            _streamingSetFinal(ph, '', { archive: false });
          }
          ph.dataset.finalized = '1';
          ph.dataset.frozenSilent = '1';
          _convLog.info('turn_silent received (frozen)', { cid, actor: actorId });
        } else if (ph.parentElement) {
          ph.remove();
          _convLog.info('turn_silent received (removed)', { cid, actor: actorId, routingOnly, terminalHandoff });
        }
      }
    }
  } else if (evData.type === 'member_joined') {
    // Refresh the cache so subsequent bubbles and already-mounted
    // placeholders can render the agent's real name/avatar instead of the
    // neutral streaming shell.
    _rememberGroupActor(cid, evData.actor);
    _refreshGroupMembers(cid);
  }
}

// Append a "view details" chip into a streaming bubble. Idempotent per
// agent_id — repeat calls for the same id no-op; calls for different ids
// accumulate into the same `.chat-msg-created-agent` row.
function _mountCreatedAgentChip(msg, payload) {
  if (!msg || !payload || !payload.agent_id) return;
  let actionsRow = msg.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msg.appendChild(actionsRow);
  }
  const aid = payload.agent_id;
  if (actionsRow.querySelector(`.chat-msg-created-agent-chip[data-agent-id="${CSS.escape(aid)}"]`)) return;
  let wrap = actionsRow.querySelector('.chat-msg-created-agent');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'chat-msg-created-agent';
    actionsRow.appendChild(wrap);
  }
  // Render an array of one + extract the inner chip(s) so we append into
  // the existing wrap rather than nesting `.chat-msg-created-agent` rows.
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderMessageCreatedAgentHtml([payload]);
  const newChips = tmp.querySelectorAll('.chat-msg-created-agent-chip');
  for (const chip of newChips) wrap.appendChild(chip);
  _hydrateMessageCreatedAgentChip(msg);
  // Refresh the agents-cache lazily so the user sees the new agent in the
  // sidebar list when they jump over. Non-fatal if it fails.
  try { if (typeof loadAgents === 'function') loadAgents(true); } catch (_) {}
}

// Skill mirror of `_mountCreatedAgentChip`. Idempotent per skill_id;
// repeat calls for the same id no-op, calls for different ids accumulate
// into the same chip row. Skill chips and agent chips share CSS but are
// distinguished by `data-agent-id` vs `data-skill-id`, so they coexist in
// separate `.chat-msg-created-agent` wrappers.
function _mountCreatedSkillChip(msg, payload) {
  if (!msg || !payload || !payload.skill_id) return;
  let actionsRow = msg.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msg.appendChild(actionsRow);
  }
  const sid = payload.skill_id;
  if (actionsRow.querySelector(`.chat-msg-created-agent-chip[data-skill-id="${CSS.escape(sid)}"]`)) return;
  // Find or create a wrapper that already holds skill chips. `:has(...)`
  // keeps us from accidentally appending into the agent-chip wrapper.
  let wrap = actionsRow.querySelector('.chat-msg-created-agent:has(.chat-msg-created-agent-chip[data-skill-id])');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'chat-msg-created-agent';
    actionsRow.appendChild(wrap);
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderMessageCreatedSkillHtml([payload]);
  const newChips = tmp.querySelectorAll('.chat-msg-created-agent-chip');
  for (const chip of newChips) wrap.appendChild(chip);
  _hydrateMessageCreatedSkillChip(msg);
  try { if (typeof loadSkills === 'function') loadSkills(true); } catch (_) {}
  // Invalidate the skill-detail file-tree cache so a user currently viewing
  // this skill sees the file set the commander just wrote (e.g. new
  // `scripts/foo.py`). Without this hop the tree on the detail page keeps
  // showing the pre-edit file list until the user navigates away and back.
  try {
    if (typeof invalidateSkillTreeCacheFor === 'function') invalidateSkillTreeCacheFor(payload.skill_id);
  } catch (_) {}
}

// `_splitMarkdownProseCode`, `_findOuterAgentRanges`, `_stripSurvivingAgentBlocks`,
// `_replaceOuterAgentBlocks` are defined in `./strip-structural-blocks.js` (loaded earlier
// in `index.html`). They live in their own file so vitest can pin the set-A /
// set-B fixtures (`test/renderer/strip-structural-blocks.test.ts`) — see that file for
// the invariant matrix. Wrap the i18n-aware placeholder here and delegate.
//
// Wrap placeholder text in an HTML `<em>` instead of markdown `_text_`:
// standard markdown requires word-boundary chars on each side of `_` for
// italic emphasis, and CJK glyphs don't count as word boundaries, so
// `_<CJK placeholder>_` renders with the underscores visible. `<em>` passes through
// renderMarkdownFull as-is (HTML inline tags are preserved by the markdown
// pipeline) and actually italicises the CJK text.
function _streamPlaceholderHtml(key) {
  return `\n<em class="stream-placeholder">${escapeHtml(t(key))}</em>\n`;
}

function _stripAgentCreateBlocksForStream(buf) {
  return _replaceOuterAgentBlocks(buf, _streamPlaceholderHtml('chat.create_agent_streaming_placeholder'));
}

function _skillStreamPlaceholderHtml() {
  return _streamPlaceholderHtml('chat.create_skill_streaming_placeholder');
}

// `<<<skill-file path=X ... >>>` blocks (skill edit chat). Different fence
// shape from `<agent>` (see strip-structural-blocks.js header) but same user-facing
// contract: streaming placeholder hides raw file content while the skill is
// being assembled. Do not surface per-file paths here: one skill can emit
// several file blocks, and repeating "Writing SKILL.md" made the stream noisy.
function _stripSkillFileBlocksForStream(buf) {
  const placeholder = _skillStreamPlaceholderHtml();
  return _replaceOuterSkillFileBlocks(buf, () => placeholder);
}

// `<skill>` container (commander create / edit). Pure logic lives in
// `strip-structural-blocks.js::_stripSkillCreateContainer` — see that header for the
// closed-vs-unclosed mode rules. This wrapper only builds the i18n-aware
// fallback placeholder and delegates so DOM / i18n / escapeHtml stay out
// of the pure-function module (parallel to how `_stripAgentCreateBlocksForStream`
// composes `_replaceOuterAgentBlocks`). Set A / set B fixtures pinned in
// `test/renderer/strip-structural-blocks.test.ts`.
function _stripSkillCreateBlocksForStream(buf) {
  const placeholder = _skillStreamPlaceholderHtml();
  return _collapseRepeatedStructuralPlaceholders(_stripSkillCreateContainer(
    buf,
    placeholder,
  ), placeholder);
}

function _stripAutoTaskBlocksForStream(buf) {
  const placeholder = _streamPlaceholderHtml('chat.create_auto_task_streaming_placeholder');
  return _collapseRepeatedStructuralPlaceholders(
    _replaceOuterTagBlocks(buf, 'auto-task', placeholder),
    placeholder,
  );
}

function _stripAgentFormBlockForStream(buf) {
  // Primary: XML `<agent-input-form>...</agent-input-form>` (symmetric
  // with submission reply tag, token-stable). Legacy: fenced
  // ```agent-input-form block — tolerated with `[\s\-]*` inside the
  // header to also catch "```agent\n-input-form" token-split outputs.
  // Both stream to the same placeholder; main's final pass mounts the
  // actual form widget.
  if (!buf) return buf;
  const placeholder = _streamPlaceholderHtml('chat.form.streaming_placeholder');
  // XML branch: atomic-container handling via strip-structural-blocks.js — same
  // prose/code guard as `<agent>` so a fenced ```xml example or inline
  // backtick mention of `<agent-input-form>` survives instead of being
  // eaten as a real form.
  let out = _replaceOuterTagBlocks(buf, 'agent-input-form', placeholder);
  // Legacy fenced-block branch — kept for old-protocol compatibility.
  // No prose/code guard here: the legacy fence IS itself a code fence,
  // and outer fenced quoting of legacy form blocks is implausible.
  if (/```\s*agent[\s\-]*input[\s\-]*form/.test(out)) {
    out = out.replace(
      /(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[ \t]*\r?\n[\s\S]*?\n```(?=\n|$)/g,
      placeholder,
    );
    out = out.replace(/(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[\s\S]*$/, placeholder);
  }
  return out;
}

function _stripDashboardBlocksForStream(buf) {
  if (!buf || typeof _replaceUnclosedDashboardBlocks !== 'function') return buf;
  return _replaceUnclosedDashboardBlocks(
    buf,
    _streamPlaceholderHtml('chat.dashboard_streaming_placeholder'),
  );
}

// Progressive renderer — append an assistant text delta into the final
// bubble and re-render markdown. The first delta reveals the `[data-role=final]`
// container; the "thinking" row stays visible BELOW the body until the terminal
// `final` / error / aborted event lands (so the user sees "partial reply +
// still typing" instead of "partial reply + nothing happening"; the row is
// rendered after `.stream-final` in `_createStreamingAssistantMessage`).
// `_streamingSetFinal` is still called at the terminal `final` event to
// guarantee a clean final render.
//
// Render throttling: every delta accumulates into `dataset.streamBuf`
// synchronously, but the actual `renderMarkdownFull` + DOM swap only runs
// once per animation frame (via `requestAnimationFrame`). Each delta in
// the wild is ~2-4 chars and they can arrive ~50/sec; without throttling
// we'd run renderMarkdown × 500 in one event loop turn (each O(n) on the
// growing buffer = O(n²) total ≈ multi-second sync stall) and the user
// would see nothing until the stall ended. With rAF throttling the
// reader loop stays cheap and the browser paints between frames.
function _formatStreamingCommentary(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  // Commentary is transient progress prose, not the final answer. CLI agents
  // commonly emit several sentences as one markdown paragraph, which becomes
  // a dense wall of text in a wide bubble. Use the browser's Unicode-aware
  // sentence segmenter so this works across Chinese, English, Japanese, and
  // other languages instead of keying off one language's punctuation.
  // Existing author-supplied paragraph breaks remain untouched, and the
  // canonical final answer is rendered unchanged.
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return source
      .split(/(\n{2,})/)
      .map(part => {
        if (/^\n{2,}$/.test(part) || !part.trim()) return part;
        const sentences = Array.from(segmenter.segment(part), item => item.segment.trim())
          .filter(Boolean);
        return sentences.join('\n\n');
      })
      .join('');
  }
  return source
    .replace(/([。！？])(?=[^\n])/g, '$1\n\n')
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n\n');
}

function _streamingAppendFinalDelta(msg, piece, phase = '') {
  if (!piece) return;
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  if (phase) msg.dataset.streamPhase = String(phase);
  const prev = msg.dataset.streamBuf || '';
  const next = prev + piece;
  msg.dataset.streamBuf = next;
  msg.dataset.finalText = next;
  if (finalEl.style.display === 'none') finalEl.style.display = '';
  if (msg._streamRafScheduled) return;
  msg._streamRafScheduled = true;
  const flush = () => {
    msg._streamRafScheduled = false;
    msg._streamRafHandle = null;
    const buf = msg.dataset.streamBuf || '';
    const rawDisplay = _stripSkillCreateBlocksForStream(
      _stripAgentCreateBlocksForStream(
        _stripAutoTaskBlocksForStream(
          _stripAgentFormBlockForStream(
            _stripDashboardBlocksForStream(
              _stripSkillFileBlocksForStream(buf),
            ),
          ),
        ),
      ),
    );
    const display = msg.dataset.streamPhase === 'commentary'
      ? _formatStreamingCommentary(rawDisplay)
      : rawDisplay;
    msg.dataset.streamDisplay = display;
    _paintStreamingFinalMarkdown(msg, finalEl, display, { stickBottom: true });
  };
  if (typeof requestAnimationFrame === 'function') {
    msg._streamRafHandle = requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

// Format a raw openclaw event into one process-pane line. Returns null for
// events that shouldn't have their own line (assistant deltas — handled by
// the live-generating row; tool/function/message items — redundant with
// their dedicated streams).
//
// Icon palette (Unicode Geometric Shapes per CLAUDE.md §8). Each glyph has
// exactly one semantic role — stick to this table when adding new streams:
//
//   ▶   reasoning start      ●   reasoning done
// Process-pane text is plain content; _eventProcessKind maps events to SVG
// icons and semantic CSS classes.
function _formatEventLine(evt, displayContext) {
  if (!evt || typeof evt !== 'object') return null;
  const { stream, data } = evt;
  if (!stream || stream === 'assistant') return null;
  if (stream === 'usage') return null;

  const phaseCn = (p) => (
    p === 'start' ? t('chat.stream.phase_start')
      : p === 'end' ? t('chat.stream.phase_end')
        : p === 'progress' ? t('chat.stream.phase_progress')
        : (p || '')
  );

  if (stream === 'lifecycle') {
    const p = data?.phase;
    if (p === 'start') return t('chat.stream.reasoning_start');
    if (p === 'end') return t('chat.stream.reasoning_done');
    if (p === 'error') {
      const failure = _processFailureSummary(data);
      return failure
        ? t('chat.stream.reasoning_error_with', { msg: failure })
        : t('chat.stream.reasoning_error');
    }
    return null;
  }

  if (stream === 'item') {
    const itemType = String(data?.itemType || data?.type || '').toLowerCase();
    // Tool / function / message items duplicate what the dedicated streams
    // emit with much richer detail — skip them here to keep the log scannable.
    if (itemType.includes('tool') || itemType.includes('function') ||
        itemType.includes('message')) return null;
    return itemType.includes('reasoning') ? t('chat.stream.thinking') : null;
  }

  if (stream === 'plan') {
    const steps = data?.steps;
    return _processPlanLinesFromSteps(steps, displayContext)
      || _processActionLine('chat.process.action_update_plan');
  }

  if (stream === 'context') {
    const phase = String(data?.phase || '');
    if (phase === 'history_summary_start') return t('chat.stream.context_history_start');
    if (phase === 'history_summary_done') return t('chat.stream.context_history_done');
    if (phase === 'history_summary_failed') return t('chat.stream.context_history_failed');
    if (phase === 'active_process_compaction_start') return t('chat.stream.context_active_start');
    if (phase === 'active_process_compaction_done') return t('chat.stream.context_active_done');
    if (phase === 'active_process_compaction_failed') return t('chat.stream.context_active_failed');
    return t('chat.stream.context_update');
  }

  if (stream === 'compaction') {
    return _formatProcessCompaction(data);
  }

  if (stream === 'runtime') {
    const runtimeDurationMs = _runtimeDurationMsFromEvent(evt);
    if (runtimeDurationMs == null) return null;
    // Keep the process summary compact: expose only total wall time. Provider,
    // aggregate tool, compaction, and retry breakdowns remain internal
    // telemetry; individual completed tool rows show their persisted E2E time.
    return t('chat.stream.runtime_total', { duration: _formatProcessDuration(runtimeDurationMs) });
  }

  if (stream === 'tool') {
    const name = data?.name || data?.toolName || 'tool';
    const phase = data?.phase || data?.status;
    const args = data?.arguments || data?.args || data?.input || data?.parameters;
    const friendly = _formatKnownToolProcessLine(name, data, args, phase, displayContext, 'tool');
    if (friendly === null) return null;
    if (friendly) return friendly;

    const p = phaseCn(phase);
    const fallbackDurationValue = data?.end_to_end_duration_ms
      ?? data?.endToEndDurationMs
      ?? data?.duration_ms
      ?? data?.durationMs;
    const duration = phase === 'end' && Number.isFinite(Number(fallbackDurationValue))
      ? _formatToolDuration(fallbackDurationValue)
      : '';
    const displayName = typeof data?.display_name === 'string' && data.display_name.trim()
      ? data.display_name.trim().slice(0, 128)
      : t('chat.process.action_execute');
    return `${displayName}${p ? ' · ' + p : ''}${duration ? ' · ' + duration : ''}`;
  }

  if (stream === 'command_output') {
    // Raw command output remains in the stored event/tool-result expansion.
    // The concise process rail is reserved for the command action + outcome.
    return null;
  }

  if (stream === 'patch') {
    const p = data?.path || data?.file || '';
    const summary = data?.summary || data?.action || '';
    const target = _processDisplayPath(p) || _processBoundedDetail(summary);
    return _processActionLine('chat.process.action_modify_file', target);
  }

  if (stream === 'approval') {
    const prompt = data?.prompt || data?.message;
    const detail = _processStatusDetail(prompt);
    return detail ? t('chat.stream.approval_with', { p: detail }) : t('chat.stream.approval');
  }

  if (stream === 'error') {
    const failure = _processFailureSummary(data);
    return failure
      ? t('chat.stream.error', { msg: failure })
      : t('chat.process.status_failed');
  }

  if (stream === 'attachment') {
    if (data?.phase === 'skipped') {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) return null;
      const detail = items.map((it) => {
        const nm = it?.name || '';
        const reason = it?.reason || '';
        return reason ? `${nm} — ${reason}` : nm;
      }).filter(Boolean).join('; ');
      return detail ? t('chat.stream.attachment_skipped', { items: detail }) : null;
    }
    return null;
  }

  // CLI-backed agents (claude code / codex / openclaw / opencode / hermes)
  // emit `LocalEvent`s that bus.ts wraps verbatim as `{stream:'cli', data:e}`.
  // Without this branch the catch-all below dumped them as
  // `cli {json}` which is (a) unreadable JSON and (b) lands in
  // kind-meta — exactly the "all gray" symptom users see for CLI runs.
  // Field shapes mirror `local_agents/backends/base.ts::LocalEvent`.
  if (stream === 'cli') {
    const cliType = String(data?.type || '').toLowerCase();
    if (cliType === 'thinking') {
      const summary = _processBoundedDetail(data?.summary);
      return summary ? `${t('chat.stream.thinking')} · ${summary}` : t('chat.stream.thinking');
    }
    if (cliType === 'file-change') {
      return _formatCliFileChangeLine(data, displayContext);
    }
    if (cliType === 'tool-event') {
      const name = String(data?.tool || 'tool');
      const isResult = data?.phase === 'result';
      const input = isResult ? null : data?.input;
      const friendly = _formatKnownToolProcessLine(
        name,
        data,
        input,
        isResult ? 'result' : 'use',
        displayContext,
        'cli',
      );
      if (friendly === null) return null;
      if (friendly) return friendly;
      if (['apply_patch', 'patch_apply'].includes(_processToolKey(name))) return null;
      const phase = isResult ? 'chat.process.status_done' : '';
      return _processActionLine('chat.process.action_execute', '', phase);
    }
    if (cliType === 'process-info') {
      const command = _processBoundedDetail(_processDisplayPath(data?.cmd), 80);
      return _processActionLine('chat.process.action_start_agent', command);
    }
    if (cliType === 'status') {
      // Bucket statuses into milestone, warn and error so they pick up the
      // right kind class downstream.
      const st = String(data?.status || '').toLowerCase();
      if (!st) return null;
      if (st === 'usage') {
        // Usage events stay in persisted/debug streams, but process
        // information should not render token/cost counters inline.
        return null;
      }
      if (st === 'retrying') {
        const attempt = Math.max(1, Math.round(Number(data?.attempt) || 1));
        const maxRetries = Math.max(0, Math.round(Number(data?.maxRetries) || 0));
        const retry = attempt > 1
          ? t('model.retrying_n', { attempt })
          : t('model.retrying');
        const count = maxRetries ? `/${maxRetries}` : '';
        const delayMs = Number(data?.retryDelayMs);
        const wait = Number.isFinite(delayMs) && delayMs > 0
          ? ` · ${t('chat.stream.retry_wait', { duration: _formatProcessDuration(delayMs) })}`
          : '';
        const reason = _processFailureSummary(data);
        return `${retry}${count}${wait}${reason ? ` · ${reason}` : ''}`;
      }
      if (st === 'plan-updated') {
        const steps = Array.isArray(data?.steps) ? data.steps : [];
        return _processPlanLinesFromSteps(steps, displayContext)
          || _processActionLine('chat.process.action_update_plan');
      }
      if (st === 'compacting') return t('chat.stream.compacting');
      if (st === 'compacted') return _formatProcessCompaction(data);
      if (st === 'waiting-approval' || st === 'waiting-input') {
        const label = t(st === 'waiting-approval'
          ? 'chat.stream.approval'
          : 'chat.stream.waiting_input');
        const detail = _processStatusDetail(data?.prompt || data?.message);
        return detail ? `${label} · ${detail}` : label;
      }
      if (st.startsWith('background-')) {
        // Prefer the semantic task type, but retain a sanitized status summary
        // when it is the only concrete description. The command-style
        // sanitizer removes credentials, absolute paths and multiline bodies.
        const taskType = _processStatusDetail(data?.taskType || data?.subagent_type || '', 96);
        const statusKey = {
          'background-completed': 'chat.process.status_done',
          'background-failed': 'chat.process.status_failed',
          'background-stopped': 'chat.process.status_stopped',
        }[st] || '';
        if (st === 'background-failed') {
          const line = _processActionLine(
            'chat.process.action_background_task',
            taskType,
            statusKey,
          );
          const failure = _processFailureSummary(data);
          return failure ? `${line} · ${failure}` : line;
        }
        const detail = taskType || _processStatusDetail(data?.message, 160);
        return _processActionLine('chat.process.action_background_task', detail, statusKey);
      }
      if (st === 'tool-progress') {
        const toolName = String(data?.tool || '').trim();
        const label = _formatKnownToolProcessLine(
          toolName,
          data,
          null,
          'progress',
          displayContext,
          'cli',
        ) || t('chat.process.action_execute');
        const elapsed = Number(data?.elapsedSeconds);
        const elapsedText = Number.isFinite(elapsed) && elapsed > 0
          ? ` · ${_formatProcessDuration(elapsed * 1000)}`
          : '';
        return `${label}${elapsedText}`;
      }
      if (st === 'model-rerouted') {
        const transition = _processModelTransitionDetail(data);
        return t('chat.stream.model_rerouted', {
          detail: transition ? ` · ${transition}` : '',
        });
      }
      if (st === 'authenticating') return t('chat.stream.authenticating');
      if (st === 'rate-limit') {
        const delayMs = Number(data?.retryAfterMs ?? data?.retry_after_ms ?? data?.retryDelayMs);
        const wait = Number.isFinite(delayMs) && delayMs > 0
          ? t('chat.stream.retry_wait', { duration: _formatProcessDuration(delayMs) })
          : '';
        return `${t('chat.stream.rate_limit')}${wait ? ` · ${wait}` : ''}`;
      }
      if (st === 'session_ready') return t('chat.process.agent_ready');
      if (st === 'running') return t('chat.process.task_running');
      if (st === 'result' || st === 'completed') return t('chat.process.task_done');
      if (st === 'error' || st === 'failed') {
        const failure = _processFailureSummary(data);
        return failure
          ? _processActionLine('chat.process.status_failed', failure)
          : t('chat.process.status_failed');
      }
      if (st === 'timeout') {
        const timeoutMs = Number(data?.timeoutMs ?? data?.timeout_ms);
        const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
          ? _formatProcessDuration(timeoutMs)
          : '';
        return `${t('chat.process.response_timeout')}${duration ? ` · ${duration}` : ''}`;
      }
      if (st === 'cancelled' || st === 'aborted') return t('chat.process.status_stopped');
      return null;
    }
    if (cliType === 'stderr-line') {
      return _formatKnownCliDiagnostic(data?.line) || null;
    }
    if (cliType === 'log') {
      // Structured CLI log records. claude --verbose / codex unknown
      // notifications / opencode step_finish / acp commands_update all
      // funnel here. Level decides the kind class so warn lands amber,
      // error red, and info gray. Debug records remain available in the
      // devtools archive but do not belong in user-facing process information.
      const level = String(data?.level || 'info').toLowerCase();
      const msg = String(data?.message || '').trim();
      if (!msg) return null;
      if (level === 'debug') return null;
      // Compatibility cleanup for conversations persisted before the Codex
      // backend stopped forwarding item/* output deltas. Path redaction turns
      // names such as item/commandExecution/outputDelta into `item<path>`.
      // These rows contain only routing ids plus a tiny delta and are already
      // represented by the command's aggregated tool result.
      if (String(data?.source || '').toLowerCase() === 'codex'
          && msg.startsWith('item<path>:')
          && /"(?:delta|changes)"\s*:/.test(msg)) {
        return null;
      }
      return _formatKnownCliDiagnostic(msg) || null;
    }
    if (cliType === 'raw-line') {
      return _formatKnownCliDiagnostic(data?.line) || null;
    }
    if (cliType === 'permission-request') {
      if (data?.autoDecided !== 'deny') return null;
      const presentation = _processToolPresentation(String(data?.tool || ''), data, data?.input);
      const target = presentation
        ? _processActionLine(presentation.actionKey, presentation.target)
        : '';
      return _processActionLine('chat.process.action_not_allowed', target);
    }
    if (cliType === 'idle') {
      const ms = Number(data?.stalledMs || 0);
      return t('chat.process.wait_agent_response', {
        duration: _formatProcessDuration(Math.max(1000, ms)),
      });
    }
    // Unknown CLI event types: hide rather than dump JSON. Devtools archive
    // still records them verbatim under `<uid>/local/test/` for debugging.
    return null;
  }

  return null;
}

// One projection owns the facts that identify a visible process row. Live
// streams and restored history both consume this shape, so formatting changes
// cannot accidentally omit lifecycle identity, semantic kind, or result
// expansion metadata in only one path.
function _projectProcessRow(evt, displayContext, fallbackText = '') {
  const event = evt && typeof evt === 'object' && evt.stream ? evt : null;
  const text = (event ? _formatEventLine(event, displayContext) : '')
    || String(fallbackText || '');
  if (!text) return null;
  const kind = event ? _eventProcessKind(event, text) : _processKindOf(text);
  const lifecycle = kind === 'plan' ? null : _processToolLifecycle(event);
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const cliResult = event?.stream === 'cli'
    && String(data.type || '').toLowerCase() === 'tool-event'
    && data.phase === 'result';
  const toolResult = event?.stream === 'tool' && data.phase === 'end';
  const resultPath = cliResult
    ? (typeof data.outputPath === 'string' ? data.outputPath : '')
    : (toolResult && typeof data.result_path === 'string' ? data.result_path : '');
  const fullOutput = (cliResult || toolResult) && typeof data.output === 'string'
    ? data.output
    : '';
  return {
    text,
    kind,
    eventName: _processEventName(event),
    lifecycleKey: lifecycle?.key || '',
    lifecycleTerminal: lifecycle?.terminal === true,
    resultPath,
    fullOutput,
    expandable: kind !== 'plan' && !!(resultPath || fullOutput),
  };
}

function _appendProjectedProcessRow(msg, projection) {
  if (!projection) return;
  if (projection.expandable) {
    _streamingAppendToolResultRow(
      msg,
      projection.text,
      projection.resultPath,
      projection.fullOutput,
      projection.kind,
      projection.eventName,
      projection.lifecycleKey,
      projection.lifecycleTerminal,
    );
    return;
  }
  _streamingAppendProgress(
    msg,
    projection.text,
    projection.kind,
    projection.eventName,
    projection.lifecycleKey,
    projection.lifecycleTerminal,
  );
}

// Render a live openclaw agent event into the streaming bubble. Assistant
// text deltas update the single "live" line; everything else becomes a new
// process-pane line (via _formatEventLine).
function _renderAgentEvent(msg, evt) {
  if (!evt || typeof evt !== 'object') return;
  const { stream, data } = evt;
  if (!stream) return;
  if (stream === 'runtime' && _runtimeDurationMsFromEvent(evt) != null) {
    _updateStreamingRuntimeSummary(msg, evt);
    return;
  }

  if (stream === 'assistant') {
    const text = data?.text;
    const delta = data?.delta;
    if (typeof text === 'string' && text.length) {
      _streamingUpdateLive(msg, t('chat.stream_generating'), text);
    } else if (typeof delta === 'string' && delta.length) {
      _streamingUpdateLive(msg, t('chat.stream_generating'), (msg._liveBuf || '') + delta, true);
    }
    return;
  }

  // Activity heartbeats refresh the concise status strip and watchdog only;
  // rendering one row per pulse would drown the useful process milestones.
  if (stream === 'cli' && data?.heartbeat === true) return;

  // CLI status:'usage' pulses are intentionally hidden from process
  // information. The raw events are still persisted for devtools/debug.
  if (stream === 'cli'
      && String(data?.type || '').toLowerCase() === 'status'
      && String(data?.status || '').toLowerCase() === 'usage') {
    return;
  }

  const projection = _projectProcessRow(
    evt,
    _processDisplayContextForMessage(msg),
  );
  _appendProjectedProcessRow(msg, projection);
}

/** Append a tool-event result row that can expand its full output. Two
 *  storage paths for the full body, decided at append time:
 *    - `outputPath` (string)   → runner spilled to disk; click reads via IPC.
 *    - `fullOutput` (string)   → live event body (<50KB), stash on the
 *                                 row's JS prop; click renders directly.
 *  Exactly one of the two is required — caller (_renderAgentEvent) gates.
 *
 *  Path is stored in a data attribute; the in-memory fullOutput hangs
 *  off `row._fullOutput` (raw JS prop, not dataset — dataset stringifies
 *  and would double the memory). A delegated click handler set up once
 *  per bubble does the lookup so we don't bind a closure per row.
 */
function _streamingAppendToolResultRow(
  msg,
  previewText,
  outputPath,
  fullOutput,
  kindHint,
  eventName,
  lifecycleKey = '',
  lifecycleTerminal = false,
) {
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  _bindProcessStickToBottom(body);

  const kind = kindHint || _processKindOf(previewText);
  const existing = _processLifecycleRow(body, lifecycleKey);
  const line = existing || document.createElement('div');
  _setProcessRowPresentation(
    line,
    previewText,
    kind,
    eventName,
    lifecycleKey,
    true,
    lifecycleTerminal,
  );
  if (outputPath) line.dataset.toolResultPath = outputPath;
  if (fullOutput) line._fullOutput = fullOutput;
  line.title = t('chat.tool_result_expand_hint');
  if (!existing) body.appendChild(line);

  // One delegated handler per bubble — cheaper than binding per row.
  if (!body._toolResultClickBound) {
    body._toolResultClickBound = true;
    body.addEventListener('click', _onToolResultRowClick);
  }

  _stickProcessBottomIfPinned(body);
  _stickBottomFromMsg(msg);
}

async function _onToolResultRowClick(ev) {
  const row = ev.target.closest('.stream-process-line.is-expandable');
  if (!row) return;
  // Toggle existing expansion.
  const next = row.nextElementSibling;
  if (next && next.classList.contains('stream-process-line-full')) {
    next.remove();
    return;
  }
  const path = row.dataset.toolResultPath;
  const inline = row._fullOutput;
  const pre = document.createElement('pre');
  pre.className = 'stream-process-line-full';

  if (path) {
    // window.orkas.invoke is the canonical IPC entry (matches every
    // other feature's pattern — saved-apps / chat-artifact / workspace).
    const inv = window.orkas && window.orkas.invoke;
    if (typeof inv !== 'function') return;
    let res;
    try {
      res = await inv('localAgents.readToolResult', { path });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (res && res.ok) {
      pre.textContent = res.content + (res.truncated ? '\n\n[…truncated for display, open file for full content]' : '');
    } else {
      pre.textContent = '[failed to read: ' + (res?.error || 'unknown') + ']';
    }
  } else if (typeof inline === 'string' && inline) {
    pre.textContent = inline;
  } else {
    pre.textContent = '[no content recorded for this row]';
  }
  row.insertAdjacentElement('afterend', pre);
}

// Update or create a single "live" line in the process pane.
// Used for streaming text (assistant deltas) that grows over time.
function _streamingUpdateLive(msg, prefix, text, appendDelta) {
  // Assistant deltas are still "in progress" from the user's perspective —
  // leave the "thinking" row alone; it's cleared by _streamingSetFinal.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  _bindProcessStickToBottom(body);
  let line = body.querySelector('.stream-process-live');
  if (!line) {
    line = document.createElement('div');
    line.className = 'stream-process-line stream-process-live kind-live';
    body.appendChild(line);
    msg._liveBuf = '';
  }
  if (appendDelta) msg._liveBuf = text; // already concatenated outside
  else msg._liveBuf = text;
  // Show last ~200 chars to keep the row compact
  const preview = msg._liveBuf.length > 200 ? '…' + msg._liveBuf.slice(-200) : msg._liveBuf;
  _setProcessLineContent(line, prefix + preview, 'live');
  _stickProcessBottomIfPinned(body);
  _stickBottomFromMsg(msg);
}

// Update the loading element (wherever it currently lives in DOM) with the reply.
function _resolveConvReply(cid, text, isError) {
  const state = pendingConvs.get(cid);
  _stopRuntimeActorRecovery(cid);
  pendingConvs.delete(cid);
  setGroupConversationBusy(cid, false);
  stopPolling(cid);
  _setConvTurnSettlement(cid, isError ? 'failed' : 'completed', {
    source: 'legacy_reply',
    finishedAtMs: Date.now(),
  });
  _updateConvSidebarBadge(cid, false);

  const el = state?.loadingEl;
  if (el && el.isConnected) {
    if (isError) el.dataset.failed = '1';
    el.querySelector('.chat-bubble').innerHTML = isError
      ? `<span style="color:var(--danger)">${escapeHtml(t('chat.send_failed', { msg: text }))}</span>`
      : `<div class="markdown-body">${renderMarkdown(text)}</div>`;
    if (!isError && typeof _hydrateMarkdownHtmlEmbeds === 'function') {
      _hydrateMarkdownHtmlEmbeds(el);
    }
    const metaTime = el.querySelector('.chat-meta-time');
    if (metaTime) metaTime.textContent = formatTime(new Date().toISOString());
    if (!isError) {
      _attachBubbleArchiveBtn(el, () => text);
      if (typeof typesetMath === 'function') {
        const md = el.querySelector('.chat-bubble .markdown-body');
        if (md) typesetMath(md);
      }
    } else {
      _attachFailedAssistantActions(el, () => _messageTextForActions(el, text));
      _handleModelOutputErrorForUi(cid, el, text, {
        stage: 'pending_reply',
        error_type: 'model_output',
      });
    }
  } else if (cid === currentCid) {
    // loadingEl was replaced (user navigated away and back); reload history to show result
    loadConversationHistory(cid, { preserveScroll: true });
  }

  if (cid === currentCid) _updateConvSendUI(cid);
}

// Toggle send/stop button appearance. While a reply is streaming the button
// shows the stop icon and a click aborts — regardless of the queue. New
// messages typed in during the stream go to the queue via plain Enter.
function _updateConvSendUI(cid) {
  if (cid !== currentCid) return;
  const sendBtn = document.getElementById('chat-send-btn');
  const queueDeleteBtn = document.getElementById('chat-queue-edit-delete-btn');
  const input = document.getElementById('chat-input');
  if (!sendBtn) return;
  const pending = isConvPending(cid);
  const editingQueueItem = typeof _isQueueItemEditing === 'function'
    && _isQueueItemEditing(cid);
  sendBtn.classList.toggle('queue-editing', editingQueueItem);
  if (queueDeleteBtn) {
    queueDeleteBtn.hidden = !editingQueueItem;
    queueDeleteBtn.title = t('chat.queue_delete_editing');
    queueDeleteBtn.setAttribute?.('aria-label', t('chat.queue_delete_editing'));
  }
  _ensureConvCreateAgentInline();
  // While `.aborting` is set, pin the button as send-style + disabled. The
  // class self-clears once the stream truly terminates (pending flips false).
  if (sendBtn.classList.contains('aborting')) {
    if (pending && !editingQueueItem) return;
    sendBtn.classList.remove('aborting');
  }
  // Conv-bound agent disabled → input + send button locked. Backend also
  // refuses the send (defense-in-depth), but we lock the UI so the user
  // can't even queue a message that's guaranteed to fail.
  const agentEnabled = convAgentEnabledByCid.get(cid) !== false;
  if (!agentEnabled) {
    sendBtn.classList.remove('streaming');
    sendBtn.disabled = true;
    sendBtn.title = t('component.send_blocked_disabled');
    if (input) {
      input.disabled = true;
      input.placeholder = t('component.send_blocked_disabled');
    }
    return;
  }
  if (input) input.disabled = false;
  sendBtn.classList.toggle('streaming', pending && !editingQueueItem);
  sendBtn.disabled = false;
  sendBtn.title = editingQueueItem
    ? t('chat.queue_save')
    : (pending ? t('chat.stop_reply') : t('chat.send_title'));
  if (input) {
    input.placeholder = editingQueueItem
      ? t('chat.queue_editing_placeholder')
      : (pending ? t('chat.input_placeholder_queue') : t('chat.input_placeholder'));
  }
  if (!pending || editingQueueItem) focusChatComposerIfIdle(input);
}

/** Show / hide a banner above the chat input warning the user that the
 *  bound agent is disabled. Idempotent — can be called on every history load. */
function _renderConvDisabledBanner(cid) {
  const wrap = document.querySelector('#panel-conversation .chat-input-wrapper');
  if (!wrap) return;
  const existing = wrap.querySelector('.detail-disabled-banner');
  const enabled = convAgentEnabledByCid.get(cid) !== false;
  if (enabled) {
    if (existing) existing.remove();
    return;
  }
  if (!existing) {
    const banner = document.createElement('div');
    banner.className = 'detail-disabled-banner';
    banner.textContent = t('component.conv_agent_disabled_banner');
    wrap.insertBefore(banner, wrap.firstChild);
  }
  // Always re-call _updateConvSendUI so the input lock is in sync with the banner.
  if (cid === currentCid) _updateConvSendUI(cid);
}

function _refreshTaskSurfacesAfterAbort(cid) {
  if (!cid) return;
  try {
    if (window.ConversationInfo) window.ConversationInfo.refreshFiles(cid, { silent: true });
  } catch (_) {}
}

function abortConvStream(cid, options = {}) {
  const state = pendingConvs.get(cid);
  if (options && options.userInitiated) {
    // A user stop is normally followed by an edit and resend. Restore the
    // authored composer snapshot without affecting cleanup/recovery aborts.
    if (typeof _restoreSentComposerSnapshot === 'function') _restoreSentComposerSnapshot(cid);
  }
  _stopRuntimeActorRecovery(cid);
  _stopGroupEventObserver(cid);
  setGroupConversationBusy(cid, false);
  // Group chat: also tell the bus to abort all in-flight worker turns + clear
  // queues. Cancelling just the IPC stream would leave agents running in the
  // background. Fire-and-forget — no need to block the UI on the response.
  try {
    apiFetch(`/api/conversations/${cid}/abort`, { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        _refreshTaskSurfacesAfterAbort(cid);
        });
  } catch (_) {}
  if (!state) {
    _updateConvSidebarBadge(cid, false);
    _refreshTaskSurfacesAfterAbort(cid);
    if (cid === currentCid) _updateConvSendUI(cid);
    return;
  }
  // No-controller case: the pendingConvs entry was minted by
  // `loadConversationHistory`'s polling-rescue branch (user opened a conv
  // whose worker was started from outside this renderer — scheduled-task
  // fire, or a refresh mid-turn). There's no in-process stream to cancel;
  // the bus.abort POST above does the actual work. Clear the placeholder
  // and the pending entry so the send button flips back to "send" and the
  // sidebar badge drops. Without this, the button stayed pinned as "stop"
  // and re-clicks were no-ops.
  if (!state.controller) {
    pendingConvs.delete(cid);
    stopPolling(cid);
    if (state.loadingEl && state.loadingEl.isConnected) state.loadingEl.remove();
    _updateConvSidebarBadge(cid, false);
    _refreshTaskSurfacesAfterAbort(cid);
    if (cid === currentCid) _updateConvSendUI(cid);
    return;
  }
  state.aborted = true;
  try { state.controller.abort(); } catch (_) {}
  // Repaint the sidebar badge now — `_updateConvSidebarBadge` reads
  // `state.aborted` and drops the streaming indicator immediately, rather
  // than waiting for _finishStreamingMsg (which runs only when main emits
  // `done`, often seconds later).
  _updateConvSidebarBadge(cid, false);
  if (cid === currentCid) {
    const btn = document.getElementById('chat-send-btn');
    if (btn) {
      btn.classList.remove('streaming');
      btn.classList.add('aborting');
      btn.disabled = true;
    }
  }
}

// Paint a prominent status badge on the sidebar conversation item that
// reflects *both* streaming state and queued-but-unsent messages. The second
// arg is ignored (kept for call-site compatibility) — state is computed
// from pendingConvs / messageQueues directly so callers don't have to stay in
// sync. The internal third arg lets a bulk repaint defer the shared count pass.
function _updateConvSidebarBadge(cid, _unused, deferRunningChips) {
  if (!deferRunningChips) _refreshSidebarRunningChips();
  // Chat header's status pill follows the same per-conversation signal.
  if (cid === currentCid) {
    try { _refreshChatHeader(); } catch (_) { /* not yet bound */ }
  }
  const item = document.querySelector(`.conv-item[data-cid="${cid}"]`);
  if (!item) return;
  item.querySelector('.conv-status-badge')?.remove();
  // Treat aborted-but-still-draining as not streaming. `pendingConvs` only
  // clears when main emits `done`, which can trail the stop click; until then
  // the bubble already shows the "stopped" state so the streaming badge would lie.
  const state = pendingConvs.get(cid);
  const pending = isConvPending(cid) && !(state && state.aborted);
  // Use _getQueue so a queue persisted in localStorage is picked up even if
  // the conversation hasn't been opened in this session yet.
  const queued = _getQueue(cid).length;
  if (!pending && !queued) {
    // No live badge → reflect the resting abnormal status (failed / backend).
    // The failed mark is maintained by the structured hooks
    // (`_finalizeActorPlaceholder`, history sync, onDone) — nothing to derive here.
    _repaintConvRowStatus(cid);
    return;
  }
  const badge = document.createElement('span');
  badge.className = 'conv-status-badge';
  if (pending) badge.classList.add('is-streaming');
  else badge.classList.add('is-queued');

  let html = '';
  if (pending) {
    html += '<span class="conv-status-dot"></span>';
    if (queued > 0) html += `<span class="conv-status-count">+${queued}</span>`;
  } else {
    html += `<span class="conv-status-text">${escapeHtml(t('chat.status.pending_short'))}</span>`;
    html += `<span class="conv-status-count">${queued}</span>`;
  }
  badge.innerHTML = html;
  // Keep the live execution indicator as the first visible row icon. Auto-task
  // rows also have a clock, so anchoring only on the title would put the live
  // dot after that clock.
  const title = item.querySelector('.conv-item-title');
  const row = title ? title.parentElement : null;
  const autoIcon = item.querySelector('.conv-item-row > .conv-item-auto-icon');
  if (title && row) row.insertBefore(badge, autoIcon || title);
  else if (title) title.parentElement?.insertBefore(badge, title);
  else item.prepend(badge);
}

// Repaint badges on every visible conversation item. Called after re-render
// of the sidebar list so previously-known pending/queued state is reapplied.
function _refreshAllConvBadges() {
  document.querySelectorAll('.conv-item').forEach(el => {
    const cid = el.dataset.cid;
    if (cid) _updateConvSidebarBadge(cid, undefined, true);
  });
  _refreshSidebarRunningChips();
  if (typeof _refreshUnreadTaskIndicators === 'function') _refreshUnreadTaskIndicators();
}

function _sidebarRunningConversationIds() {
  const ids = new Set();
  pendingConvs.forEach((state, cid) => {
    if (!(state && state.aborted)) ids.add(cid);
  });
  // Group runtime activity can become visible just before a request-backed
  // pending entry is attached (for example during recovery). Include it so
  // project and Commander counts do not briefly disappear in that window.
  groupBusyConvs.forEach((_busy, cid) => {
    const state = pendingConvs.get(cid);
    if (!(state && state.aborted)) ids.add(cid);
  });
  return ids;
}

function _sidebarRunningLabel(count) {
  const label = t('sidebar.commander_running', { n: count });
  // t() returns the raw key on miss — keep a neutral fallback for partially
  // upgraded locale bundles.
  return (label && label !== 'sidebar.commander_running') ? label : `${count} running`;
}

// Right-aligned chips on Commander, catch-all Tasks, and each Project surface
// live group-chat work from the same state as the task-row streaming dot.
// Project ownership comes from the canonical conversations cache; a task
// contributes only to its owning surface while Commander retains the app-wide
// total.
function _refreshSidebarRunningChips() {
  const runningIds = _sidebarRunningConversationIds();
  const chip = document.getElementById('commander-running-chip');
  if (chip) {
    chip.hidden = runningIds.size <= 0;
    chip.textContent = runningIds.size > 0 ? _sidebarRunningLabel(runningIds.size) : '';
  }

  const projectByConversation = new Map();
  if (Array.isArray(conversations)) {
    for (const conversation of conversations) {
      const cid = conversation && conversation.conversation_id;
      const pid = conversation && conversation.project_id;
      if (!cid || !pid) continue;
      projectByConversation.set(cid, pid);
    }
  }
  const countsByProject = new Map();
  let globalTaskCount = 0;
  runningIds.forEach((cid) => {
    const pid = projectByConversation.get(cid);
    if (pid) {
      countsByProject.set(pid, (countsByProject.get(pid) || 0) + 1);
    } else {
      globalTaskCount += 1;
    }
  });
  const tasksChip = document.getElementById('tasks-running-chip');
  if (tasksChip) {
    tasksChip.hidden = globalTaskCount <= 0;
    tasksChip.textContent = globalTaskCount > 0 ? _sidebarRunningLabel(globalTaskCount) : '';
  }
  document.querySelectorAll('[data-project-running-chip]').forEach((projectChip) => {
    const count = countsByProject.get(projectChip.dataset.projectRunningChip) || 0;
    projectChip.hidden = count <= 0;
    projectChip.textContent = count > 0 ? _sidebarRunningLabel(count) : '';
  });
}

// ─── Chat-history right-click menu (selection-only) ───────────────────────
// Two items: Copy / Edit copy. Without an active selection we let the
// browser's default context menu show (which still carries the Devtools
// "Inspect" entry that we rely on in dev). Wired once via event delegation
// on the chat-history root — works for every bubble, present and future.
function _initChatSelectionMenu() {
  const container = document.getElementById('chat-history');
  if (!container) return;
  if (container.dataset.selectionMenuBound === '1') return;
  container.dataset.selectionMenuBound = '1';
  container.addEventListener('contextmenu', (e) => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    if (!text.trim()) return;
    // Only intercept when the cursor target is inside a rendered message.
    // Right-click on the empty area between bubbles falls through to the
    // browser default. Class is `.chat-message` (see appendChatMessage in
    // this file) — not `.chat-msg` (that's the attachment / produced-chip
    // namespace).
    if (!(e.target instanceof Element) || !e.target.closest('.chat-message')) return;
    if (!sel.anchorNode || !sel.focusNode
      || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    e.preventDefault();
    const snapshot = String(text);   // copy now — getSelection() can be cleared by the click
    if (typeof showContextMenu !== 'function') return;
    showContextMenu(e, [
      {
        label: t('chat.menu.copy'),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(snapshot);
          } catch (_) {
            if (typeof uiToast === 'function') uiToast(t('chat.copy_failed'), { variant: 'error' });
            else if (typeof uiAlert === 'function') await uiAlert(t('chat.copy_failed'));
          }
        },
      },
      {
        label: t('chat.menu.scratch_edit'),
        onClick: () => {
          if (typeof openChatMdDrawer !== 'function') return;
          openChatMdDrawer({
            source: { kind: 'ephemeral', initialText: snapshot },
            initialMode: 'edit',
            title: t('chat.md_drawer.scratch_title'),
          });
        },
      },
    ]);
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initChatSelectionMenu, { once: true });
  } else {
    _initChatSelectionMenu();
  }
}
