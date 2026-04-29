// ─── Avatar (icon + color) for AI actors ─────────────────────────────────
//
// 头像 catalog（15 图标 + 16 颜色 + 指挥官默认）的真相源在
// `src/main/data/avatars.json`，启动时一次性走 IPC 拉过来缓存。所有渲染
// helper 都从缓存读，**不再硬编码任何 SVG 或 hex**。
//
// 缺省回退：某 agent 还没存头像时按 `agent_id` 哈希出确定性组合 ——
// 跨设备同一 agent_id 派生同一组合，云同步不会因两端各自随机而冲突。
//
// 渲染统一走 renderAvatarHtml(...)，DOM / .avatar-circle 样式一份，卡片、
// 详情、聊天行、设置页都用同一 helper。

let AVATAR_ICONS = [];
let AVATAR_COLORS = [];
let COMMANDER_DEFAULT = { icon: 'crown', color: 'gold' }; // 兜底，IPC 完成后会被覆盖

let _avatarCatalogReady = false;
let _avatarCatalogPromise = null;

/** 启动期调用一次 —— 拉 catalog 缓存到本地。boot.js 在渲染任何头像之前
 *  await 它，确保 sync helper（renderAvatarHtml / randomAgentAvatar / …）
 *  调用时已就绪。重复调用安全，第二次起直接 resolve。 */
async function initAvatarCatalog() {
  if (_avatarCatalogReady) return;
  if (_avatarCatalogPromise) { await _avatarCatalogPromise; return; }
  _avatarCatalogPromise = (async () => {
    try {
      const res = await window.orkas.invoke('avatars.getCatalog');
      const cat = res?.catalog;
      if (cat && Array.isArray(cat.icons) && Array.isArray(cat.colors)) {
        AVATAR_ICONS = cat.icons;
        AVATAR_COLORS = cat.colors;
        if (cat.commander_default && cat.commander_default.icon && cat.commander_default.color) {
          COMMANDER_DEFAULT = { icon: cat.commander_default.icon, color: cat.commander_default.color };
        }
        _avatarCatalogReady = true;
      }
    } catch (_) {
      // 拉不到就继续用空数组 —— 渲染层会全部走 seed 兜底（视觉降级）。
    } finally {
      _avatarCatalogPromise = null;
    }
  })();
  await _avatarCatalogPromise;
}

function _isCommanderCombo(icon, color) {
  return icon === COMMANDER_DEFAULT.icon || color === COMMANDER_DEFAULT.color;
}

/** 智能体随机头像：从非指挥官池里挑一对 (icon, color)。 */
function randomAgentAvatar() {
  const icons = AVATAR_ICONS.filter((i) => i.id !== COMMANDER_DEFAULT.icon);
  const colors = AVATAR_COLORS.filter((c) => c.id !== COMMANDER_DEFAULT.color);
  if (!icons.length || !colors.length) return { icon: '', color: '' };
  const i = icons[Math.floor(Math.random() * icons.length)];
  const c = colors[Math.floor(Math.random() * colors.length)];
  return { icon: i.id, color: c.id };
}

// 简单 djb2，足够给 agent_id 散开到非指挥官的图标 / 颜色池上。
function _hash(str) {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return h >>> 0;
}

/** 由 seed 派生稳定的 (icon, color)。同一 seed 任何机器都得到同一组合，
 *  适合做"老 spec 缺字段时的回填"以及渲染兜底。 */
function avatarFromSeed(seed) {
  const icons = AVATAR_ICONS.filter((i) => i.id !== COMMANDER_DEFAULT.icon);
  const colors = AVATAR_COLORS.filter((c) => c.id !== COMMANDER_DEFAULT.color);
  if (!icons.length || !colors.length) return { icon: '', color: '' };
  const h = _hash(seed);
  return {
    icon: icons[h % icons.length].id,
    color: colors[Math.floor(h / icons.length) % colors.length].id,
  };
}

/** 解析任意 (iconId, colorId) 到可渲染的视觉数据。catalog 里查不到的
 *  字段（脏数据 / 未来重命名 token）按 fallbackSeed 派生；都没给就退化成
 *  指挥官默认色（极端情况，正常路径不会触发）。 */
function resolveAvatar(iconId, colorId, fallbackSeed) {
  let resolvedIcon = AVATAR_ICONS.find((i) => i.id === iconId);
  let resolvedColor = AVATAR_COLORS.find((c) => c.id === colorId);
  if (!resolvedIcon || !resolvedColor) {
    const fb = avatarFromSeed(fallbackSeed || 'default');
    if (!resolvedIcon) resolvedIcon = AVATAR_ICONS.find((i) => i.id === fb.icon);
    if (!resolvedColor) resolvedColor = AVATAR_COLORS.find((c) => c.id === fb.color);
  }
  if (!resolvedIcon || !resolvedColor) {
    // catalog 还没拉到（极端情况）——返回个空壳，渲染层至少不会崩。
    return { icon: '', color: '', iconSvg: '', bg: '#e5e7eb', fg: '#475569' };
  }
  return {
    icon: resolvedIcon.id,
    color: resolvedColor.id,
    iconSvg: resolvedIcon.svg,
    bg: resolvedColor.bg,
    fg: resolvedColor.fg,
  };
}

/** 就地把已有 .avatar-circle 元素的视觉换掉，不替换节点（保留点击监听）。 */
function applyAvatarToElement(el, iconId, colorId, seed) {
  if (!el) return;
  const a = resolveAvatar(iconId, colorId, seed || '');
  el.style.setProperty('--avatar-bg', a.bg);
  el.style.setProperty('--avatar-fg', a.fg);
  const sizeMatch = el.style.width && el.style.width.match(/(\d+)/);
  const sizePx = sizeMatch ? parseInt(sizeMatch[1], 10) : 28;
  const innerSize = Math.round(sizePx * 0.55);
  el.innerHTML = a.iconSvg
    ? a.iconSvg.replace('<svg ', `<svg width="${innerSize}" height="${innerSize}" `)
    : '';
}

/** 生成头像 HTML 片段。用于卡片 / 详情 / 聊天行 / 设置页。
 *  opts: { size=28, seed='', clickable=false, extraClass='', dataAttrs={} } */
function renderAvatarHtml(iconId, colorId, opts = {}) {
  const a = resolveAvatar(iconId, colorId, opts.seed || '');
  const size = opts.size || 28;
  const cls = ['avatar-circle'];
  if (opts.clickable) cls.push('is-clickable');
  if (opts.extraClass) cls.push(opts.extraClass);
  const data = Object.entries(opts.dataAttrs || {})
    .map(([k, v]) => `data-${k}="${String(v).replace(/"/g, '&quot;')}"`)
    .join(' ');
  const innerSize = Math.round(size * 0.55);
  const inner = a.iconSvg
    ? a.iconSvg.replace('<svg ', `<svg width="${innerSize}" height="${innerSize}" `)
    : '';
  return `<span class="${cls.join(' ')}" style="--avatar-bg:${a.bg};--avatar-fg:${a.fg};width:${size}px;height:${size}px" ${data}>${inner}</span>`;
}
