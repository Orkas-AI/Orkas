// ─── Avatar (icon + color) for AI actors ─────────────────────────────────
//
// The avatar catalog (agent icons + colors + commander default) is a
// per-platform runtime resource fetched through `avatars.getCatalog` at
// startup and cached locally. Every render helper reads the cache —
// **no SVG or hex is hardcoded in the renderer**.
//
// Default fallback: when an agent has no usable icon, use `bot`; derive only
// its color from `agent_id`. The same agent_id gets the same color everywhere.
//
// Rendering goes through renderAvatarHtml(...). The DOM and
// .avatar-circle CSS are shared, so cards, detail pages, chat rows,
// and the settings page all use the same helper.

let AVATAR_ICONS = [];
let AVATAR_COLORS = [];
let COMMANDER_DEFAULT = { icon: 'crown', color: 'gold' }; // fallback, overwritten once the IPC fetch lands
const LEGACY_AVATAR_COLOR_STRIDE = 15;

let _avatarCatalogReady = false;
let _avatarCatalogPromise = null;

/** Call once at startup — fetch the catalog and cache it locally.
 *  boot.js awaits this before rendering any avatar so the sync helpers
 *  synchronous render helpers are ready by the time
 *  they're called. Safe to call multiple times — subsequent calls
 *  resolve immediately. */
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
      // On fetch failure, leave the arrays empty — the render layer
      // will fall back to seed-based avatars (a visual degradation).
    } finally {
      _avatarCatalogPromise = null;
    }
  })();
  await _avatarCatalogPromise;
}

function _isCommanderCombo(icon, color) {
  return icon === COMMANDER_DEFAULT.icon || color === COMMANDER_DEFAULT.color;
}

// Simple djb2 hash — sufficient to spread agent_id across the
// non-commander icon / color pools.
function _hash(str) {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return h >>> 0;
}

/** Resolve the unified generic icon plus a stable color from a seed.
 *  Missing/unknown agent icons must not turn into a random role icon; `bot`
 *  is the single fallback. Keep the historical icon-count stride for colors so
 *  existing seed-derived colors do not change after catalog additions. */
function avatarFromSeed(seed) {
  const colors = AVATAR_COLORS.filter((c) => c.id !== COMMANDER_DEFAULT.color);
  const fallbackIcon = AVATAR_ICONS.find((i) => i.id === 'bot');
  if (!fallbackIcon || !colors.length) return { icon: '', color: '' };
  const h = _hash(seed);
  return {
    icon: fallbackIcon.id,
    color: colors[Math.floor(h / LEGACY_AVATAR_COLOR_STRIDE) % colors.length].id,
  };
}

/** Resolve any (iconId, colorId) to renderable visual data. Unknown or missing
 *  icons use the generic `bot`; unknown or missing colors remain stable by
 *  fallbackSeed. */
function resolveAvatar(iconId, colorId, fallbackSeed) {
  let resolvedIcon = AVATAR_ICONS.find((i) => i.id === iconId);
  let resolvedColor = AVATAR_COLORS.find((c) => c.id === colorId);
  if (!resolvedIcon || !resolvedColor) {
    const fb = avatarFromSeed(fallbackSeed || 'default');
    if (!resolvedIcon) resolvedIcon = AVATAR_ICONS.find((i) => i.id === fb.icon);
    if (!resolvedColor) resolvedColor = AVATAR_COLORS.find((c) => c.id === fb.color);
  }
  if (!resolvedIcon || !resolvedColor) {
    // catalog hasn't been fetched yet (edge case) — return an empty
    // shell so the render layer at least doesn't crash.
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

/** Swap the visual data of an existing .avatar-circle element in
 *  place, without replacing the node (keeps click listeners). */
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

/** Generate an avatar HTML fragment. Used by cards, the detail view,
 *  chat rows, and the settings page.
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
