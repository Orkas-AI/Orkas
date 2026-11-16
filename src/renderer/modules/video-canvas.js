// The video canvas: a conversation's productions as cards, in a panel beside the chat.
//
// Three columns of cards, footage, shots and videos, read from the production's files each
// time (features/video_canvas.ts). The product heads the footage as a card of its own. Only
// card positions and new shots not generated yet belong to the canvas. Words, order, pictures, assets and product facts change
// here without a model or a confirmation, and each change waits until the user updates the
// videos it touched (decided 2026-11-09); a change also stops an update in progress. A shot's
// panel shows how a take was made and makes it again with other words, footage or service, and a
// line drawn from a card's "+" makes a new shot (decided 2026-11-10). Anything else prefills the
// composer, and while an Agent works the canvas only reads.
//
// Data: `window.orkas.invoke('videoCanvas.read', { cid })`, jobs on the push channel
// `conversations:video-canvas-job`. Media: `chat-media://local/<abs>`.

// ── Pure view model ────────────────────────────────────────────────────
// No DOM, i18n or IPC, so it can be tested directly (test/renderer/video-canvas.test.ts).
(function (global) {
  const CARD_WIDTH = { asset: 160, shot: 200, video: 380, product: 240, draft: 200 };
  const DEFAULT_CARD_HEIGHT = { asset: 170, shot: 220, video: 420, product: 220, draft: 200 };
  /** A production has one product, so its card has a fixed key (features/video_canvas.ts). */
  const PRODUCT_CARD_KEY = 'product';
  const COLUMN_GAP = 56;
  const CARD_GAP = 16;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 2;
  const FIT_PADDING = 32;

  /** Whether a response still belongs to the conversation that asked. Navigation can
   *  overtake IPC, and a late reply must not fill this panel with another conversation. */
  function acceptsResponse(activeCid, requestedCid) {
    return !!requestedCid && String(activeCid || '') === String(requestedCid);
  }

  /** The product gets its card once there is something on it to read. */
  function showsProduct(production) {
    return !!(production && production.product && (production.product.facts || []).length);
  }

  function productionCards(production) {
    if (!production) return [];
    return [
      ...(showsProduct(production) ? [{ key: PRODUCT_CARD_KEY, column: 'asset', kind: 'product' }] : []),
      ...(production.assets || []).map((card) => ({ key: card.key, column: 'asset', kind: 'asset' })),
      ...(production.shots || []).map((card) => ({ key: card.key, column: 'shot', kind: 'shot' })),
      // A new shot waits among the shots until it is generated (decided 2026-11-10).
      ...(production.drafts || []).map((card) => ({ key: card.key, column: 'shot', kind: 'draft' })),
      ...(production.videos || []).map((card) => ({ key: card.key, column: 'video', kind: 'video' })),
    ];
  }

  /** Where each card goes: where the user put it, or next in its column. Empty columns take
   *  no room, so a video with nothing behind it starts at the left. */
  function layoutCards(production, sizes) {
    const measured = sizes || {};
    const saved = (production && production.layout) || {};
    const positions = {};
    const columns = [];
    const cards = productionCards(production);
    let x = 0;
    for (const column of ['asset', 'shot', 'video']) {
      const inColumn = cards.filter((card) => card.column === column);
      if (!inColumn.length) continue;
      columns.push({ column, x });
      let y = 0;
      for (const { key, kind } of inColumn) {
        if (saved[key]) {
          positions[key] = { x: saved[key].x, y: saved[key].y };
          continue;
        }
        positions[key] = { x, y };
        y += ((measured[key] && measured[key].height) || DEFAULT_CARD_HEIGHT[kind]) + CARD_GAP;
      }
      // The product card is wider than footage, and the next column starts after it.
      x += Math.max(...inColumn.map((card) => CARD_WIDTH[card.kind])) + COLUMN_GAP;
    }
    return { positions, columns };
  }

  /** Who uses whom. Computed each time: a line is never stored. */
  function edgesOf(production) {
    if (!production) return [];
    const known = new Set(productionCards(production).map((card) => card.key));
    const edges = [];
    const product = showsProduct(production) ? [production.product] : [];
    for (const card of [...product, ...(production.shots || []), ...(production.drafts || []), ...(production.videos || [])]) {
      for (const from of card.uses || []) {
        if (known.has(from) && from !== card.key) edges.push({ from, to: card.key });
      }
    }
    return edges;
  }

  /** Whether a video's page places this ledger row itself, where the canvas cannot swap it. */
  function placedByPage(production, assetId) {
    return !!production && (production.videos || []).some((video) => (video.placed_by_page || []).includes(assetId));
  }

  /** What a card was made from and what was made from it, with the lines between them.
   *  A neighbor's other uses are not shown, or one shared photo would light up everything. */
  function relatedTo(key, edges) {
    const walk = (start, next) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        for (const other of next(queue.shift())) {
          if (!seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
      return seen;
    };
    const up = walk(key, (card) => edges.filter((edge) => edge.to === card).map((edge) => edge.from));
    const down = walk(key, (card) => edges.filter((edge) => edge.from === card).map((edge) => edge.to));
    return {
      cards: new Set([...up, ...down]),
      edges: edges.filter((edge) => (up.has(edge.from) && up.has(edge.to)) || (down.has(edge.from) && down.has(edge.to))),
    };
  }

  function clampZoom(zoom) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  /** The view that shows all of these rectangles, at no more than full size. */
  function fitView(rects, viewport) {
    if (!rects.length) return { x: FIT_PADDING, y: FIT_PADDING, zoom: 1 };
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const width = Math.max(...rects.map((rect) => rect.x + rect.width)) - left;
    const height = Math.max(...rects.map((rect) => rect.y + rect.height)) - top;
    const zoom = clampZoom(Math.min(
      1,
      (viewport.width - FIT_PADDING * 2) / Math.max(1, width),
      (viewport.height - FIT_PADDING * 2) / Math.max(1, height),
    ));
    // From the top, because a card grows downward when a scene opens.
    return {
      x: Math.max(FIT_PADDING, (viewport.width - width * zoom) / 2) - left * zoom,
      y: FIT_PADDING - top * zoom,
      zoom,
    };
  }

  /** Change zoom keeping the world point under this screen point where it is. */
  function zoomAround(view, zoom, pointX, pointY) {
    const next = clampZoom(zoom);
    const worldX = (pointX - view.x) / view.zoom;
    const worldY = (pointY - view.y) / view.zoom;
    return { x: pointX - worldX * next, y: pointY - worldY * next, zoom: next };
  }

  /** The order with one id moved by `delta` places, or null if it cannot move that way. */
  function moveInOrder(order, id, delta) {
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return null;
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
  }

  /** Where a dragged chip lands among the others, which can wrap onto several rows. */
  function dropIndex(rects, x, y) {
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (y < rect.top) return index;
      if (y <= rect.bottom && x < rect.left + rect.width / 2) return index;
    }
    return rects.length;
  }

  /** A pasted product link: the whole text is one web address, nothing else. */
  function pastedUrl(text) {
    const value = String(text || '').trim();
    if (!/^https?:\/\/\S+$/i.test(value)) return '';
    try {
      return new URL(value).hostname ? value : '';
    } catch (_) {
      return '';
    }
  }

  /** The version to play: the one the user picked while it exists, otherwise the newest. */
  function versionToShow(versions, pickedId) {
    const list = versions || [];
    return list.find((version) => version.id === pickedId) || list[list.length - 1] || null;
  }

  /** What a video card should say about itself. It does not say whether the video is behind its
   *  changes: Update is always there for the user to press (decided 2026-11-11). */
  function videoState(card, job) {
    if (job && job.status === 'failed') return 'failed';
    if (job && job.status === 'running') return 'updating';
    if (card.id && !(card.versions || []).length) return 'not_rendered';
    return 'ready';
  }

  function jobKey(job) {
    return [job.dir, job.video_id || '', job.kind, job.shot || ''].join('|');
  }

  /** The cards a take was made from, in the order its call named them, among those on the canvas. */
  function takeRefs(production, take) {
    const cards = [...((production && production.assets) || []), ...((production && production.shots) || [])];
    return ((take && take.refs) || []).flatMap((ref) => {
      const card = cards.find((item) => item.key === ref.card);
      return card ? [{ card, role: ref.role }] : [];
    });
  }

  /** The part an input plays by its place (decided 2026-11-10): with frames, the first opens the
   *  video and the second ends it; anything else is a reference. */
  function inputRole(method, index) {
    if (method !== 'frames') return 'reference';
    return index === 0 ? 'first_frame' : index === 1 ? 'last_frame' : 'reference';
  }

  /** How a take was made, as its panel first shows it: on frames if one opened it. */
  function takeMethod(take) {
    return ((take && take.refs) || []).some((ref) => ref.role === 'first_frame') ? 'frames' : 'references';
  }

  /** Whether a take's panel asks for something the take was not made with: other words, added
   *  footage, another way, setting or service. Generate waits for one (2026-11-12: with nothing
   *  changed it made the same request again). */
  function takeChanged(take, asked) {
    const words = (value) => String(value || '').trim();
    if (asked.prompt !== undefined && words(asked.prompt) !== words(take.prompt)) return true;
    const inputs = asked.inputs;
    if (inputs && ((inputs.added || []).length || (inputs.method && inputs.method !== takeMethod(take)))) return true;
    const params = take.params || {};
    if (Object.entries(asked.settings || {}).some(([setting, value]) => params[setting] !== value)) return true;
    return !!asked.choice && asked.current !== undefined && asked.choice !== asked.current;
  }

  /** What a shot card heads with: a still is an image and a video a shot, each counted among its
   *  own kind (2026-11-12: a character still headed "Shot 01" read as a video shot). */
  function shotHeading(production, card) {
    const kindOf = (item) => {
      const results = (item && item.results) || [];
      return results.length && results[results.length - 1].kind === 'image' ? 'image' : 'shot';
    };
    const kind = kindOf(card);
    const same = ((production && production.shots) || []).filter((item) => kindOf(item) === kind);
    return { kind, n: String(same.indexOf(card) + 1).padStart(2, '0') };
  }

  /** The card a ledger row shows on: footage on its own card, a take on its shot's. */
  function cardOfAsset(production, assetId) {
    const assets = (production && production.assets) || [];
    const shots = (production && production.shots) || [];
    return assets.find((card) => card.id === assetId)
      || shots.find((card) => (card.results || []).some((take) => take.asset_id === assetId))
      || null;
  }

  /** A take's inputs in its panel: its own footage, then what the user added, each playing the part
   *  the chosen way gives it by order. Only what the user added can be taken out again. */
  function takeInputs(production, take, method, added) {
    const own = takeRefs(production, take).map(({ card }) => ({ card, removable: false }));
    const extra = (added || []).flatMap((assetId) => {
      const card = cardOfAsset(production, assetId);
      return card ? [{ card, asset_id: assetId, removable: true }] : [];
    });
    return [...own, ...extra].map((input, index) => ({ ...input, role: inputRole(method, index) }));
  }

  /** Pictures that can join a shot's inputs: not among them yet, and images only where only
   *  images go (a still, or frames). */
  function inputCandidates(cards, options) {
    const skip = new Set((options && options.exclude) || []);
    const imagesOnly = !!(options && options.imagesOnly);
    return (cards || []).filter((card) => !skip.has(card.key) && (!imagesOnly || card.kind === 'image'));
  }

  /** Whether a picture dragged from a card's "+" can join this shot's inputs, once. */
  function acceptsInput(target, source) {
    if (!target || !source || target.key === source.key) return false;
    if (target.imagesOnly && source.kind !== 'image') return false;
    return !(target.cards || []).includes(source.key);
  }

  /** How far right of its card a new shot made from it starts. */
  const NEW_SHOT_GAP = 80;

  /** Where a new shot made from a card goes: right of it and level with it, or lower down past
   *  every card in the way, so it never hides one (decided 2026-11-10). Rectangles are in board
   *  units; the new shot is taken at its size before it is measured. */
  function newShotSpot(source, cards) {
    const width = CARD_WIDTH.draft;
    const height = DEFAULT_CARD_HEIGHT.draft;
    const x = source.x + source.width + NEW_SHOT_GAP;
    let y = source.y;
    const inTheWay = (card) => x < card.x + card.width + CARD_GAP && card.x < x + width + CARD_GAP
      && y < card.y + card.height + CARD_GAP && card.y < y + height + CARD_GAP;
    // Each step passes at least one more card, and y only grows, so this ends.
    for (let step = 0; step <= cards.length; step += 1) {
      const blocking = cards.filter(inTheWay);
      if (!blocking.length) break;
      y = Math.max(...blocking.map((card) => card.y + card.height)) + CARD_GAP;
    }
    return { x, y };
  }

  /** The curve the canvas draws between two points, left to right. */
  function linkPath(startX, startY, endX, endY) {
    const bend = Math.max(40, Math.abs(endX - startX) / 2);
    return `M${startX} ${startY} C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}`;
  }

  /** Whether a video shows this take, and whether one shows another take of the shot instead. */
  function takeUse(card, index) {
    const results = (card && card.results) || [];
    const take = results[index];
    if (!take) return { inUse: false, canUse: false };
    return {
      inUse: take.used_in > 0,
      canUse: results.some((other, at) => at !== index && other.used_in > 0),
    };
  }

  function formatSeconds(seconds) {
    const value = Math.round(Number(seconds) * 10) / 10;
    return Number.isFinite(value) ? String(value) : '0';
  }

  /** End offset of the first line already carrying `instruction`, else -1. */
  function instructionLineEnd(text, instruction) {
    if (!instruction) return -1;
    let offset = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith(instruction)) return offset + line.length;
      offset += line.length + 1;
    }
    return -1;
  }

  /** Where an instruction lands in the composer, and where the caret goes.
   *
   *  Several clicks before one send build up one message, so each adds a line rather than
   *  replacing what is there. `short` drops the video's name, for a run of lines about one
   *  video, which is safe only while no other video was named more recently. Clicking the
   *  same entry twice moves the caret to its line instead of writing it again. `lines` go
   *  under the instruction, with the caret left on the instruction for the user's words. */
  function mergeComposerInstruction(input) {
    const current = String((input && input.current) || '');
    const full = String((input && input.full) || '').trim();
    const short = String((input && input.short) || '').trim();
    const production = String((input && input.production) || '').trim();
    const others = Array.isArray(input && input.otherProductions) ? input.otherProductions : [];
    const lines = (Array.isArray(input && input.lines) ? input.lines : []).map((item) => String(item || '').trim()).filter(Boolean);
    const withLines = (line) => (lines.length ? `${line}\n${lines.join('\n')}` : line);
    if (!full) return { value: current, selectionStart: current.length };
    const base = current.replace(/\s+$/, '');
    if (!base) return { value: withLines(full), selectionStart: full.length };
    for (const existing of [full, short]) {
      const end = instructionLineEnd(base, existing);
      if (end >= 0) return { value: current, selectionStart: end };
    }
    const namedAt = production ? base.lastIndexOf(production) : -1;
    const anotherNamedLater = namedAt >= 0 && others.some((other) => {
      const name = String(other || '').trim();
      return !!name && name !== production && base.lastIndexOf(name) > namedAt;
    });
    const line = short && namedAt >= 0 && !anotherNamedLater ? short : full;
    return { value: `${base}\n${withLines(line)}`, selectionStart: base.length + 1 + line.length };
  }

  /** What the user's Update asks of VideoStudio, as the user's message, or '' when the app
   *  renders the video itself. Product facts are said in the video's own words (2026-11-09), and
   *  narration changed here, or the video's voice, is voiced again (2026-11-11); both in the words
   *  the product owner confirmed. */
  function agentUpdateMessage(card, translate) {
    const parts = [];
    const facts = (card && card.product_changes) || [];
    if (facts.length) {
      parts.push(translate('video_canvas.update_message', {
        name: card.label,
        changes: facts.map((change) => translate('video_canvas.update_message_change', { before: change.before, after: change.after })).join('\n'),
      }));
    }
    const voice = card && card.voice_wanted;
    const lines = ((card && card.narration_changes) || [])
      .map((change) => translate('video_canvas.narration_message_change', { n: change.position, id: change.scene, text: change.text }));
    if (voice) lines.push(translate('video_canvas.narration_message_voice', { voice: voice.name, route: voice.route_ref, ref: voice.voice_ref }));
    if (lines.length) {
      parts.push(translate(parts.length ? 'video_canvas.narration_message_also' : 'video_canvas.narration_message', {
        name: card.label,
        changes: lines.join('\n'),
        revoice: translate(voice ? 'video_canvas.narration_message_new_voice' : 'video_canvas.narration_message_same_voice'),
      }));
    }
    return parts.join('\n');
  }

  /** What another version can be made from, as the canvas shows it: the footage, then the
   *  shots, by the names on their cards (decided 2026-11-11). */
  function versionMaterials(production) {
    if (!production) return [];
    return [
      ...(production.assets || []).map((card) => ({ kind: 'footage', name: String(card.label || '').trim() })),
      ...(production.shots || []).map((card) => ({ kind: 'shot', name: String(card.label || '').trim() })),
    ].filter((item) => item.name);
  }

  global.VideoCanvasViewModel = {
    CARD_WIDTH,
    PRODUCT_CARD_KEY,
    acceptsResponse,
    showsProduct,
    productionCards,
    layoutCards,
    edgesOf,
    placedByPage,
    relatedTo,
    takeRefs,
    takeUse,
    inputRole,
    takeMethod,
    takeChanged,
    shotHeading,
    cardOfAsset,
    takeInputs,
    inputCandidates,
    acceptsInput,
    newShotSpot,
    linkPath,
    clampZoom,
    fitView,
    zoomAround,
    moveInOrder,
    dropIndex,
    pastedUrl,
    versionMaterials,
    agentUpdateMessage,
    versionToShow,
    videoState,
    jobKey,
    formatSeconds,
    mergeComposerInstruction,
  };

  // Test bridge: pure functions only, no DOM/i18n/IPC (see PC/CLAUDE.md).
  if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports = global.VideoCanvasViewModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));

(function (global) {
  // Outside the renderer (the view-model test bridge requires this file) there is no panel.
  if (typeof document === 'undefined') return;
  const _log = typeof createLogger === 'function'
    ? createLogger('video-canvas')
    : { debug() {}, info() {}, warn() {}, error() {} };
  const VM = global.VideoCanvasViewModel;
  const DRAG_THRESHOLD_PX = 4;
  const REFRESH_AFTER_TURN_MS = 600;
  const ZOOM_STEP = 1.2;
  const KEY_PAN_PX = 48;
  const TEMPLATES = ['unboxing', 'closeup', 'promo'];
  const NOT_A_CARD_DRAG = 'button, input, textarea, select, a, video[controls], .ai-select, .ai-select-popover';

  let _cid = '';
  let _lifetime = 0;
  const _fieldTargets = new WeakMap();
  const _target = () => ({ cid: _cid, dir: _dir, lifetime: _lifetime });
  const _acceptsTarget = (target) => !!target && target.cid === _cid && target.dir === _dir && target.lifetime === _lifetime;
  let _data = null;
  let _contentSignature = null;
  let _hasUnseenChanges = false;
  let _dir = '';
  let _readSeq = 0;
  let _openRequest = 0;
  let _resize = null;
  let _selected = '';
  let _lastBusy = false;
  let _suppressClick = false;
  let _turnEndTimer = 0;
  let _layoutFrame = 0;
  let _productionSelect = null;
  let _renderedDir = '';
  let _patching = false;
  let _importing = 0;
  // A new shot just made: its panel grows as its choices and availability arrive, and stays in view
  // until the user moves the board or picks another card (2026-11-10).
  let _revealDraft = '';
  // The generation settings open over the panel (decided 2026-11-10, plan 27.21): whose they are,
  // what that panel shows, the popover on <body>, and the tooltip explaining a setting.
  let _settingsOpen = '';
  let _settingsFor = null;
  let _settingsEl = null;
  let _settingsShown = '';
  let _hintEl = null;
  let _hintButton = null;
  let _hintPinned = false;

  // View state outlives a re-read, so a refresh never moves what the user is looking at.
  const _views = new Map();
  const _openScene = new Map();
  const _shotResult = new Map();
  const _pickedVersion = new Map();
  const _drafts = new Map();
  const _quotes = new Map();
  const _jobs = new Map();
  const _versionSelects = new Map();
  // A video's one voice: the voices its narration can take, read once per video, and its select.
  const _voiceLists = new Map();
  const _voiceSelects = new Map();
  // A shot's panel: the services each take can be made on, the one the user picked, and the
  // takes being checked or confirmed, so a second click cannot pay twice.
  const _takeOptions = new Map();
  const _takeChoice = new Map();
  const _takeLoading = new Set();
  // Services can change in Settings: what a refresh finds is asked again, behind what is shown.
  const _takeOptionsStale = new Set();
  // A take or new shot being checked, then sent: its panel says which and takes no change until
  // the job runs, so what is made is what was checked (2026-11-10).
  const _takeAsking = new Map();
  // Footage the user added to a take in its panel, and the way they picked, until it is made
  // (decided 2026-11-10). Keyed like the take.
  const _takeInputs = new Map();
  // The shape, resolution, length and sound the user picked for a take, until it is made
  // (decided 2026-11-10, plan 27.21). Keyed like the take.
  const _takeSettings = new Map();
  // A new shot's services, by what it asks, and its words waiting to be saved.
  const _draftOptions = new Map();
  const _draftOptionsStale = new Set();
  // What each take's and new shot's panel showed last, kept on screen while new inputs are asked
  // about, so its menus do not blink out.
  const _takeOptionsShown = new Map();
  const _draftOptionsShown = new Map();
  const _draftLoading = new Set();
  const _draftPromptSaves = new Map();
  // The panel's menus by name: its model, the way a shot is made, a new shot's shape and length.
  const _panelSelects = new Map();
  const DRAFT_PROMPT_SAVE_MS = 800;

  const _el = (id) => document.getElementById(id);
  const _viewport = () => _el('video-canvas-viewport');
  const _world = () => _el('video-canvas-world');
  const _panel = () => _el('video-canvas-panel');
  const _isOpen = () => { const panel = _panel(); return !!panel && !panel.hidden; };
  const _production = () => ((_data && _data.productions) || []).find((item) => item.dir === _dir) || null;
  const _readOnly = () => !!(_data && _data.busy);

  function _mediaUrl(absPath) {
    let p = String(absPath || '');
    if (!p) return '';
    if (p.includes('\\')) p = p.replace(/\\/g, '/');
    if (p.startsWith('/')) p = p.slice(1);
    return `chat-media://local/${encodeURI(p)}`;
  }

  function _icon(name, cls) {
    return uiIconHtml(name, cls || 'ui-icon');
  }

  function _viewKey() {
    return `${_cid}|${_dir}`;
  }

  function _cardOf(key) {
    const production = _production();
    if (!production) return null;
    if (key === VM.PRODUCT_CARD_KEY) return VM.showsProduct(production) ? production.product : null;
    return [...production.assets, ...production.shots, ...(production.drafts || []), ...production.videos].find((card) => card.key === key) || null;
  }

  function _shotCurrent(card) {
    const key = `${_dir}|${card.key}`;
    const index = _shotResult.has(key) ? _shotResult.get(key) : card.results.length - 1;
    return card.results[Math.max(0, Math.min(card.results.length - 1, index))];
  }

  /** The ledger row a dragged or chosen card stands for. */
  function _assetIdOfCard(card) {
    if (!card) return '';
    return card.results ? _shotCurrent(card).asset_id : card.id;
  }

  function _pictureCards() {
    const production = _production();
    return production ? [...production.shots, ...production.assets] : [];
  }

  /** A footage or shot card as an input: the take a shot card shows stands for it. */
  function _inputOfCard(card) {
    const take = card.results ? _shotCurrent(card) : null;
    return { key: card.key, asset_id: take ? take.asset_id : card.id, kind: take ? take.kind : card.kind, label: card.label };
  }

  // ── Composer ─────────────────────────────────────────────────────────

  function _videoNames() {
    const production = _production();
    return ((production && production.videos) || []).map((video) => video.label).filter(Boolean);
  }

  function _prefillComposer(spec) {
    const input = _el('chat-input');
    if (!input) return;
    const merged = VM.mergeComposerInstruction({
      current: composerText(input),
      full: spec.full,
      short: spec.short,
      production: spec.production,
      otherProductions: _videoNames().filter((name) => name !== spec.production),
      lines: spec.lines,
    });
    composerSetText(input, merged.value);
    composerNotify(input);
    input.focus();
    composerSetSelection(input, merged.selectionStart, merged.selectionStart);
  }

  /** Another version is the user's ask in the composer, with the canvas's footage and shots
   *  listed under it, one per line, to delete what should not be used (decided 2026-11-11). */
  function _askAnotherVersion(video) {
    const materials = VM.versionMaterials(_production());
    _prefillComposer({
      full: t('video_canvas.another_version_text', { name: video.label }),
      production: video.label,
      lines: materials.length
        ? [t('video_canvas.another_version_uses'), ...materials.map((item) => t(`video_canvas.another_version_${item.kind}`, { name: item.name }))]
        : [],
    });
  }

  function _sayAboutCard(card) {
    const label = card.label || '';
    const kind = card.key === VM.PRODUCT_CARD_KEY ? 'product' : card.results ? 'shot' : card.versions ? 'video' : 'asset';
    _prefillComposer({
      full: t(`video_canvas.say.${kind}`, { name: label }),
      ...(kind === 'video' ? { production: label } : {}),
    });
  }

  function _sayAboutScene(video, scene, position) {
    _prefillComposer({
      full: t('video_canvas.say.scene', { name: video.label, n: position, id: scene.id }),
      short: t('video_canvas.say.scene_short', { n: position, id: scene.id }),
      production: video.label,
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function _mediaHtml(path, kind, label) {
    if (!path) return `<div class="video-canvas-media-empty">${_icon('film')}</div>`;
    const src = escapeHtml(_mediaUrl(path));
    const name = escapeHtml(label || '');
    return kind === 'video'
      ? `<video class="video-canvas-media-el" data-lazy-src="${src}" muted playsinline preload="metadata" aria-label="${name}"></video>`
      : `<img class="video-canvas-media-el" data-lazy-src="${src}" alt="${name}" draggable="false">`;
  }

  const _lazyMedia = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        entry.target.src = entry.target.dataset.lazySrc;
      }
    }, { root: null })
    : null;

  /** Media loads when its card comes into view: a production can hold dozens of clips, and
   *  each one mounted costs a decoder. */
  function _startLazyMedia(root) {
    root.querySelectorAll('[data-lazy-src]').forEach((media) => {
      if (_lazyMedia) _lazyMedia.observe(media);
      else media.src = media.dataset.lazySrc;
    });
  }

  /** Replace a part of a card only if what it shows changed, so a refresh does not restart
   *  a playing video or take the caret out of a field. */
  function _patch(card, part, signature, html, after) {
    let node = card.querySelector(`:scope > [data-part="${part}"]`);
    const hasContent = !!html;
    if (!node && !hasContent) return;
    if (!node) {
      node = document.createElement('div');
      node.dataset.part = part;
      card.appendChild(node);
    }
    if (!hasContent) {
      node.remove();
      return;
    }
    if (node.dataset.signature === signature) return;
    const active = document.activeElement;
    const focusKey = active && node.contains(active) ? active.dataset.draftKey : '';
    const selection = focusKey && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
    node.dataset.signature = signature;
    _patching = true;
    node.innerHTML = html;
    _patching = false;
    node.querySelectorAll('[data-draft-key]').forEach((field) => {
      _fieldTargets.set(field, _target());
      const key = field.dataset.draftKey;
      if (_drafts.has(key)) field.value = _drafts.get(key);
      if (key === focusKey) {
        field.focus({ preventScroll: true });
        if (selection) field.setSelectionRange(selection[0], selection[1]);
      }
    });
    _startLazyMedia(node);
    if (after) after(node);
  }

  function _menuButtonHtml(key) {
    return `<button type="button" class="video-canvas-card-menu" data-action="card-menu" data-card="${escapeHtml(key)}"
      aria-label="${escapeHtml(t('video_canvas.card_menu'))}" title="${escapeHtml(t('video_canvas.card_menu'))}" aria-haspopup="menu">${_icon('more-horizontal')}</button>`;
  }

  /** The "+" on a selected footage or shot card (decided 2026-11-10): click it for a new shot made
   *  from the card, or drag a line from it to an empty spot or to a shot that should use it. */
  function _linkHandleHtml(key) {
    if (_readOnly()) return '';
    const label = escapeHtml(t('video_canvas.new_shot.from'));
    return `<button type="button" class="video-canvas-connector" data-action="link-new" data-card="${escapeHtml(key)}" aria-label="${label}" title="${label}" aria-haspopup="menu">${_icon('plus')}</button>`;
  }

  /** Every card heads with its kind (decided 2026-11-10), so footage and shots are told apart
   *  wherever they are moved. */
  function _cardHeadHtml(icon, kind, label, meta = '') {
    return `<div class="video-canvas-card-kind">${icon ? _icon(icon) : ''}<span>${escapeHtml(kind)}</span></div>
      <div class="video-canvas-card-title" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
      ${meta ? `<div class="video-canvas-meta">${escapeHtml(meta)}</div>` : ''}`;
  }

  function _renderAssetCard(el, card) {
    const lang = getLang();
    _patch(el, 'menu', `${card.key}|${lang}`, _menuButtonHtml(card.key));
    _patch(el, 'link', `${card.key}|${lang}|${_readOnly()}`, _linkHandleHtml(card.key));
    _patch(el, 'head', `${card.label}|${card.kind}|${lang}`, _cardHeadHtml(card.kind === 'video' ? 'film' : 'image', t('video_canvas.kind.asset'), card.label));
    _patch(el, 'media', `${card.media_path}`, `<div class="video-canvas-media" data-open-media="${escapeHtml(card.media_path)}">${_mediaHtml(card.media_path, card.kind, card.label)}</div>`);
  }

  /** A new image is not called a shot (2026-11-12). */
  function _draftTitle(draft) {
    return t(draft.kind === 'image' ? 'video_canvas.new_shot.title_image' : 'video_canvas.new_shot.title');
  }

  /** A new shot not generated yet: what it will be, and its progress once generating. */
  function _renderDraftCard(el, card) {
    const lang = getLang();
    const job = _draftJob(card.key);
    const running = !!job && job.status === 'running';
    _patch(el, 'menu', `${card.key}|${lang}`, _menuButtonHtml(card.key));
    _patch(el, 'head', `${card.kind}|${lang}`, _cardHeadHtml(card.kind === 'image' ? 'image' : 'clapperboard', t(`video_canvas.new_shot.${card.kind}`), _draftTitle(card)));
    _patch(el, 'media', card.kind, `<div class="video-canvas-media is-draft">${_icon(card.kind === 'video' ? 'film' : 'image')}</div>`);
    _patch(el, 'status', `${running}|${lang}`, running
      ? `<div class="video-canvas-status-row" role="status"><span class="video-canvas-pill is-running">${_icon('loader', 'ui-icon video-canvas-spin')}${escapeHtml(t('video_canvas.redoing'))}</span></div>`
      : '');
  }

  function _renderShotCard(el, card) {
    const current = _shotCurrent(card);
    const position = card.results.indexOf(current) + 1;
    const heading = VM.shotHeading(_production(), card);
    _patch(el, 'menu', `${card.key}|${getLang()}`, _menuButtonHtml(card.key));
    _patch(el, 'link', `${card.key}|${getLang()}|${_readOnly()}`, _linkHandleHtml(card.key));
    _patch(el, 'head', `${card.label}|${heading.kind}|${heading.n}|${getLang()}`,
      _cardHeadHtml(heading.kind === 'image' ? 'image' : 'clapperboard', t(`video_canvas.kind.${heading.kind}`, { n: heading.n }), card.label));
    _patch(el, 'media', current.media_path, `<div class="video-canvas-media" data-open-media="${escapeHtml(current.media_path)}">${_mediaHtml(current.media_path, current.kind, current.label)}</div>`);
    const pager = card.results.length > 1
      ? `<div class="video-canvas-shot-pager">
          <button type="button" class="video-canvas-icon-btn" data-action="shot-page" data-card="${escapeHtml(card.key)}" data-delta="-1" aria-label="${escapeHtml(t('video_canvas.shot_previous'))}" ${position <= 1 ? 'disabled' : ''}>${_icon('chevron-left')}</button>
          <span class="video-canvas-meta">${escapeHtml(t('video_canvas.shot_position', { n: position, total: card.results.length }))}</span>
          <button type="button" class="video-canvas-icon-btn" data-action="shot-page" data-card="${escapeHtml(card.key)}" data-delta="1" aria-label="${escapeHtml(t('video_canvas.shot_next'))}" ${position >= card.results.length ? 'disabled' : ''}>${_icon('chevron-right')}</button>
        </div>`
      : '';
    _patch(el, 'pager', `${position}/${card.results.length}/${getLang()}`, pager);
    const job = _shotJob(card.key);
    const running = !!job && job.status === 'running';
    _patch(el, 'status', `${running}|${getLang()}`, running
      ? `<div class="video-canvas-status-row" role="status"><span class="video-canvas-pill is-running">${_icon('loader', 'ui-icon video-canvas-spin')}${escapeHtml(t('video_canvas.redoing'))}</span></div>`
      : '');
  }

  function _productFactHtml(fact, readOnly) {
    const unverified = fact.source === 'unverified'
      ? `<div class="video-canvas-fact-foot"><span class="video-canvas-pill is-warn">${escapeHtml(t('video_canvas.fact_unverified'))}</span></div>`
      : '';
    return `<div class="video-canvas-fact">
      <input type="text" class="form-input video-canvas-input" value="${escapeHtml(fact.text)}" ${readOnly ? 'disabled' : ''}
        aria-label="${escapeHtml(t('video_canvas.fact_text'))}"
        data-draft-key="${escapeHtml(`fact:${_dir}|${fact.id}`)}" data-commit="fact" data-original="${escapeHtml(fact.text)}" data-fact="${escapeHtml(fact.id)}">
      ${unverified}
    </div>`;
  }

  /** The facts the Agent writes the videos from (decided 2026-11-09). Each is changed here, and the
   *  videos take a change in when the user updates them, through the Agent. */
  function _renderProductCard(el, card) {
    const lang = getLang();
    const readOnly = _readOnly();
    const production = _production();
    const facts = (production && production.product && production.product.facts) || [];
    _patch(el, 'menu', `${card.key}|${lang}`, _menuButtonHtml(card.key));
    _patch(el, 'head', `${card.label}|${lang}`, _cardHeadHtml('', t('video_canvas.product'), card.label));
    // A field saves only for the visit it was drawn on, so a card from an earlier visit is drawn
    // again rather than kept.
    const signature = JSON.stringify([facts, readOnly, lang, _dir, _lifetime]);
    _patch(el, 'facts', signature, `<div class="video-canvas-meta video-canvas-product-hint">${escapeHtml(t('video_canvas.product_hint'))}</div>
      <div class="video-canvas-fact-list">${facts.map((fact) => _productFactHtml(fact, readOnly)).join('')}</div>`);
  }

  function _videoJob(card) {
    return _jobs.get(VM.jobKey({ dir: _dir, video_id: card.id, kind: 'render' })) || null;
  }

  function _shotJob(shotKey) {
    return shotKey ? _jobs.get(VM.jobKey({ dir: _dir, kind: 'redo', shot: shotKey })) || null : null;
  }

  function _draftJob(draftKey) {
    return draftKey ? _jobs.get(VM.jobKey({ dir: _dir, kind: 'new_shot', shot: draftKey })) || null : null;
  }

  function _statusHtml(card, job) {
    const state = VM.videoState(card, job);
    if (state === 'updating') {
      const percent = job.phase === 'render' && typeof job.progress === 'number' ? Math.round(job.progress * 100) : null;
      const label = job.phase === 'deliver'
        ? t('video_canvas.status.delivering')
        : percent === null ? t('video_canvas.status.updating') : t('video_canvas.status.updating_percent', { percent });
      return `<div class="video-canvas-status-row" role="status">
        <span class="video-canvas-pill is-running">${_icon('loader', 'ui-icon video-canvas-spin')}${escapeHtml(label)}</span>
        ${percent === null ? '' : `<span class="video-canvas-progress"><i style="width:${percent}%"></i></span>`}
      </div>`;
    }
    // Update video, always beside the versions, tries again.
    if (state === 'failed') {
      return `<div class="video-canvas-status-row is-failed" role="alert">
        <span class="video-canvas-status-text">${escapeHtml(t('video_canvas.status.failed'))}</span>
        <button type="button" class="btn btn-sm" data-action="fix-with-agent" data-video="${escapeHtml(card.id)}">${escapeHtml(t('video_canvas.fix_with_agent'))}</button>
      </div>`;
    }
    if (state === 'not_rendered') {
      return `<div class="video-canvas-status-row">
        <span class="video-canvas-status-text">${escapeHtml(t('video_canvas.status.not_rendered'))}</span>
      </div>`;
    }
    return '';
  }

  function _chipsHtml(card) {
    const open = _openScene.get(`${_dir}|${card.key}`);
    const chips = card.scenes.map((scene, index) => {
      const thumb = scene.frame_path
        ? _mediaHtml(scene.frame_path, 'image', '')
        : scene.media_path ? _mediaHtml(scene.media_path, scene.media_kind, '') : '';
      const redoing = _shotJob(scene.source);
      return `<button type="button" class="video-canvas-chip${scene.id === open ? ' is-active' : ''}${redoing && redoing.status === 'running' ? ' is-busy' : ''}"
          data-action="scene-open" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}"
          aria-pressed="${scene.id === open ? 'true' : 'false'}"
          aria-label="${escapeHtml(t('video_canvas.scene_label', { n: index + 1, seconds: VM.formatSeconds(scene.duration_sec) }))}">
        <span class="video-canvas-chip-thumb">${thumb}${redoing && redoing.status === 'running' ? `<span class="video-canvas-chip-spinner">${_icon('loader', 'ui-icon video-canvas-spin')}</span>` : ''}</span>
        <span class="video-canvas-chip-label">${index + 1} · ${escapeHtml(t('video_canvas.seconds', { seconds: VM.formatSeconds(scene.duration_sec) }))}</span>
      </button>`;
    }).join('');
    const add = `<button type="button" class="video-canvas-chip is-add" data-action="scene-add" data-video="${escapeHtml(card.id)}"
      aria-label="${escapeHtml(t('video_canvas.add_scene'))}" title="${escapeHtml(t('video_canvas.add_scene'))}" ${_readOnly() ? 'disabled' : ''}>${_icon('plus')}</button>`;
    return `<div class="video-canvas-bar" role="group" aria-label="${escapeHtml(t('video_canvas.scenes'))}">${chips}${add}</div>`;
  }

  function _editorHtml(card, scene, position) {
    const readOnly = _readOnly();
    const disabled = readOnly ? 'disabled' : '';
    const index = position - 1;
    // Words that quote the product change here like any others, and become this scene's own
    // (decided 2026-11-11).
    const fields = scene.texts.map((text, slotIndex) => {
      const label = escapeHtml(t('video_canvas.words', { n: slotIndex + 1 }));
      return `<label class="video-canvas-field">
        <span class="video-canvas-field-label">${label}</span>
        <input type="text" class="form-input video-canvas-input" value="${escapeHtml(text.value)}" ${disabled}
          data-draft-key="${escapeHtml(`text:${_dir}|${card.id}|${scene.id}|${text.slot}`)}" data-commit="text" data-original="${escapeHtml(text.value)}"
          data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}" data-slot="${escapeHtml(text.slot)}">
      </label>`;
    }).join('');
    const note = !scene.texts.length
      ? `<div class="video-canvas-note">${escapeHtml(t(scene.on_page_timeline ? 'video_canvas.page_scene_note' : 'video_canvas.no_words_note'))}</div>`
      : '';
    // Narration voiced here changes like words; the Agent voices it again at the user's Update
    // (decided 2026-11-11).
    const narration = !scene.narration
      ? ''
      : scene.narration_editable
        ? `<label class="video-canvas-field">
          <span class="video-canvas-field-label">${escapeHtml(t('video_canvas.narration_label'))}</span>
          <input type="text" class="form-input video-canvas-input" value="${escapeHtml(scene.narration)}" ${disabled}
            data-draft-key="${escapeHtml(`narration:${_dir}|${card.id}|${scene.id}`)}" data-commit="narration" data-original="${escapeHtml(scene.narration)}"
            data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}">
        </label>`
        : `<div class="video-canvas-note"><b>${escapeHtml(t('video_canvas.narration'))}</b> ${escapeHtml(scene.narration)}</div>`;
    // A shot is made again from its own panel, where its words and service can change.
    const regenerate = scene.redoable && scene.source
      ? `<button type="button" class="btn btn-sm" data-action="scene-regenerate" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}">${escapeHtml(t('video_canvas.regenerate'))}</button>`
      : '';
    // An old page draws this scene itself, so it has no picture to change.
    const swap = scene.on_page_timeline && !scene.media_path
      ? ''
      : `<button type="button" class="btn btn-sm" data-action="scene-swap" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}" ${disabled}>${escapeHtml(t('video_canvas.swap_picture'))}</button>`;
    return `<div class="video-canvas-editor">
      <div class="video-canvas-editor-head">
        <span class="video-canvas-editor-title">${escapeHtml(t('video_canvas.scene_label', { n: position, seconds: VM.formatSeconds(scene.duration_sec) }))}</span>
        <button type="button" class="video-canvas-icon-btn" data-action="scene-move" data-delta="-1" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}" aria-label="${escapeHtml(t('video_canvas.move_earlier'))}" title="${escapeHtml(t('video_canvas.move_earlier'))}" ${disabled || (index === 0 ? 'disabled' : '')}>${_icon('chevron-left')}</button>
        <button type="button" class="video-canvas-icon-btn" data-action="scene-move" data-delta="1" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}" aria-label="${escapeHtml(t('video_canvas.move_later'))}" title="${escapeHtml(t('video_canvas.move_later'))}" ${disabled || (index === card.scenes.length - 1 ? 'disabled' : '')}>${_icon('chevron-right')}</button>
        <button type="button" class="video-canvas-icon-btn" data-action="scene-remove" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}" aria-label="${escapeHtml(t('video_canvas.remove_scene'))}" title="${escapeHtml(t('video_canvas.remove_scene'))}" ${disabled || (card.scenes.length === 1 ? 'disabled' : '')}>${_icon('trash')}</button>
      </div>
      ${fields}${note}${narration}
      <div class="video-canvas-editor-actions">
        ${swap}
        ${regenerate}
        <button type="button" class="btn btn-sm" data-action="scene-say" data-video="${escapeHtml(card.id)}" data-scene="${escapeHtml(scene.id)}">${escapeHtml(t('video_canvas.say_to_agent'))}</button>
      </div>
    </div>`;
  }

  function _renderVideoCard(el, card) {
    const lang = getLang();
    const version = VM.versionToShow(card.versions, _pickedVersion.get(`${_dir}|${card.key}`));
    const job = _videoJob(card);
    _patch(el, 'menu', `${card.key}|${lang}`, _menuButtonHtml(card.key));
    const meta = [
      card.duration_sec ? t('video_canvas.seconds', { seconds: VM.formatSeconds(card.duration_sec) }) : '',
      card.width ? `${card.width}×${card.height}` : '',
      card.scenes.length ? t('video_canvas.scene_count', { n: card.scenes.length }) : '',
    ].filter(Boolean).join(' · ');
    _patch(el, 'head', `${card.label}|${meta}|${lang}`, _cardHeadHtml('film', t('video_canvas.kind.video'), card.label, meta));
    const aspect = card.width && card.height ? `${card.width} / ${card.height}` : '16 / 9';
    _patch(el, 'player', `${version ? version.media_path : ''}|${aspect}|${version ? version.id : ''}|${lang}`, version
      ? `<div class="video-canvas-player-shell" style="aspect-ratio:${aspect}"><video class="chat-md-video video-canvas-player" controls controlslist="nodownload nofullscreen noremoteplayback" disablepictureinpicture disableremoteplayback playsinline preload="metadata" src="${escapeHtml(_mediaUrl(version.media_path))}" aria-label="${escapeHtml(card.label)}"></video></div>`
      : `<div class="video-canvas-player-shell is-empty" style="aspect-ratio:${aspect}">${_icon('film')}</div>`);
    const versionSignature = card.versions.map((item) => item.id).join(',');
    // Update video stays beside the versions of a video with a timeline, whether or not anything
    // changed (decided 2026-11-11).
    const update = card.id
      ? `<button type="button" class="btn btn-sm" data-action="render" data-video="${escapeHtml(card.id)}">${escapeHtml(t('video_canvas.update'))}</button>`
      : '';
    _patch(el, 'versions', `${versionSignature}|${lang}|${version ? version.id : ''}|${card.id}`, version || update
      ? `<div class="video-canvas-versions">
          ${version ? `<div class="video-canvas-version-select" data-version-select></div>
          <button type="button" class="video-canvas-icon-btn" data-action="version-save" data-video="${escapeHtml(card.key)}" aria-label="${escapeHtml(t('video_canvas.download'))}" title="${escapeHtml(t('video_canvas.download'))}">${_icon('download')}</button>` : ''}
          ${update}
        </div>`
      : '', (node) => _mountVersionSelect(node, card, version));
    if (!card.id) return;
    // Locked apart from drawing the row, so an open version menu stays open.
    const updateButton = el.querySelector(':scope > [data-part="versions"] [data-action="render"]');
    if (updateButton) updateButton.disabled = _readOnly() || VM.videoState(card, job) === 'updating';
    const statusSignature = JSON.stringify([VM.videoState(card, job), job && job.phase, job && job.progress, _readOnly(), lang]);
    _patch(el, 'status', statusSignature, _statusHtml(card, job));
    const barSignature = JSON.stringify([
      card.scenes.map((scene) => [scene.id, scene.duration_sec, scene.frame_path, scene.media_path, _shotJob(scene.source)?.status]),
      _openScene.get(`${_dir}|${card.key}`),
      _readOnly(),
      lang,
    ]);
    _patch(el, 'bar', barSignature, _chipsHtml(card));
    _renderVoice(el, card);
    const openId = _openScene.get(`${_dir}|${card.key}`);
    const position = card.scenes.findIndex((scene) => scene.id === openId) + 1;
    const scene = position ? card.scenes[position - 1] : null;
    const editorSignature = scene
      ? JSON.stringify([scene, position, card.scenes.length, _readOnly(), lang, VM.showsProduct(_production())])
      : '';
    _patch(el, 'editor', editorSignature, scene ? _editorHtml(card, scene, position) : '');
  }

  /** The video's one voice, in a field of its own under its scenes whichever is open (decided
   *  2026-11-12), when a line can change and the card names the voice. */
  function _renderVoice(el, card) {
    const key = `${_dir}|${card.key}`;
    const list = card.voice && card.scenes.some((scene) => scene.narration_editable) ? _voiceList(card) : null;
    if (!list) {
      _voiceSelects.get(key)?.close();
      _voiceSelects.delete(key);
    }
    _patch(el, 'voice', JSON.stringify([card.voice, card.voice_wanted, list && list.status, list && list.voices.length, getLang(), _dir, _lifetime]), list
      ? `<div class="video-canvas-field">
          <span class="video-canvas-field-label">${escapeHtml(t('video_canvas.voice'))}</span>
          <div class="video-canvas-voice-select" data-voice-select></div>
        </div>`
      : '', (node) => _mountVoiceSelect(node, card));
    // Locked apart from drawing the field, as the shot panel's menus are, so an open menu stays open.
    const trigger = list && el.querySelector(':scope > [data-part="voice"] .ai-select-trigger');
    if (trigger) trigger.disabled = _readOnly() || list.status !== 'ready';
  }

  /** The voices a video's narration can take, read the first time its card shows the voice and
   *  kept for the conversation from its configured speech services. */
  function _voiceList(card) {
    const key = `${_dir}|${card.id}`;
    let entry = _voiceLists.get(key);
    if (entry) return entry;
    entry = { status: 'loading', voices: [] };
    _voiceLists.set(key, entry);
    const target = _target();
    global.orkas.invoke('videoCanvas.voices', { cid: target.cid, dir: target.dir, video: card.id })
      .catch(() => null)
      .then((result) => {
        if (_voiceLists.get(key) !== entry) return;
        entry.status = result && result.ok ? 'ready' : 'failed';
        entry.voices = (result && result.ok && result.voices) || [];
        if (_acceptsTarget(target)) _render();
      });
    return entry;
  }

  function _voiceValue(voice) {
    return JSON.stringify([voice.route_ref, voice.voice_ref]);
  }

  /** The video's one voice, from what the speech services offer. The voice it has stays the
   *  choice shown even when no service lists it any more. */
  function _mountVoiceSelect(node, card) {
    const host = node.querySelector('[data-voice-select]');
    if (!host || !card.voice) return;
    const key = `${_dir}|${card.key}`;
    _voiceSelects.get(key)?.close();
    const list = _voiceList(card);
    const services = new Set(list.voices.map((voice) => voice.route_ref));
    const options = list.voices.map((voice) => ({
      value: _voiceValue(voice),
      label: voice.name,
      ...(services.size > 1 ? { hint: voice.route_name } : {}),
    }));
    const listed = (voice) => options.some((option) => option.value === _voiceValue(voice));
    if (card.voice_wanted && !listed(card.voice_wanted)) options.unshift({ value: _voiceValue(card.voice_wanted), label: card.voice_wanted.name });
    if (!listed(card.voice)) {
      const said = { loading: 'video_canvas.voice_loading', failed: 'video_canvas.voice_unavailable' }[list.status] || 'video_canvas.voice_current';
      options.unshift({ value: _voiceValue(card.voice), label: t(said) });
    }
    const target = _target();
    const api = _aiSelectMount(host, {
      options,
      value: _voiceValue(card.voice_wanted || card.voice),
      ariaLabel: t('video_canvas.voice'),
      onChange: (value) => {
        const [route, voice] = JSON.parse(value);
        _edit({ kind: 'set_voice', video: card.id, route_ref: route, voice_ref: voice }, target);
      },
    });
    _voiceSelects.set(key, api);
  }

  function _mountVersionSelect(node, card, version) {
    const host = node.querySelector('[data-version-select]');
    if (!host || !version) return;
    const selectKey = `${_dir}|${card.key}`;
    // Its menu lives on <body> while open, so replacing the select would leave it behind.
    _versionSelects.get(selectKey)?.close();
    const latest = card.versions[card.versions.length - 1];
    const api = _aiSelectMount(host, {
      options: card.versions.slice().reverse().map((item) => ({
        value: item.id,
        label: item === latest ? t('video_canvas.version_latest', { id: item.id }) : item.id,
      })),
      value: version.id,
      ariaLabel: t('video_canvas.version'),
      onChange: (value) => {
        if (value === latest.id) _pickedVersion.delete(selectKey);
        else _pickedVersion.set(selectKey, value);
        _render();
      },
    });
    _versionSelects.set(selectKey, api);
  }

  // ── A shot's panel ───────────────────────────────────────────────────
  // How the take the shot card shows was made, and making it again with other words, footage or
  // service. It floats under the selected shot card, like the bar a node canvas opens under a
  // result. A new shot's card opens the same panel to say what to make (decided 2026-11-10).

  function _selectedShot() {
    const card = _selected ? _cardOf(_selected) : null;
    return card && card.results ? card : null;
  }

  function _selectedDraft() {
    return _selected && _selected.startsWith('draft:') ? _cardOf(_selected) : null;
  }

  function _takeKey(take) {
    return `${_dir}|${take.asset_id}`;
  }

  /** What the user changed about a take's inputs, as the panel sends it, or nothing if untouched. */
  function _takeInputsOf(take, dir = _dir) {
    const pending = _takeInputs.get(`${dir}|${take.asset_id}`);
    return pending ? { ...(pending.method ? { method: pending.method } : {}), added: pending.added.slice() } : undefined;
  }

  /** A take's services and availability are asked for each set of inputs. */
  function _inputsSignature(inputs) {
    return inputs ? JSON.stringify(inputs) : '';
  }

  /** The settings the user picked for a take, as the panel sends them, or nothing if untouched. */
  function _takeSettingsOf(take, dir = _dir) {
    const picked = _takeSettings.get(`${dir}|${take.asset_id}`);
    return picked && Object.keys(picked).length ? { ...picked } : undefined;
  }

  function _takeOptionsKey(take, dir = _dir) {
    return `${dir}|${take.asset_id}|${_inputsSignature(_takeInputsOf(take, dir))}|${_inputsSignature(_takeSettingsOf(take, dir))}`;
  }

  function _quoteKey(dir, assetId, choice, inputs, settings) {
    return `${dir}|${assetId}|${choice || ''}|${_inputsSignature(inputs)}|${_inputsSignature(settings)}`;
  }

  /** The service picked for a take: the user's choice while it is offered, or where it was made. */
  function _takeChoiceOf(take) {
    const options = _takeOptions.get(_takeOptionsKey(take)) || _takeOptionsShown.get(_takeKey(take));
    const picked = _takeChoice.get(_takeKey(take));
    // Asked again for new inputs, the pick stands until the answer says otherwise.
    if (!options) return picked || '';
    if (options.ok === false || !options.choices.length) return '';
    return options.choices.some((choice) => choice.id === picked) ? picked : options.current;
  }

  /** How a take is made in its panel: as the user picked, as the services say, or as it was. */
  function _takeMethodOf(take) {
    const pending = _takeInputs.get(_takeKey(take));
    const options = _takeOptions.get(_takeOptionsKey(take)) || _takeOptionsShown.get(_takeKey(take));
    if (pending && pending.method) return pending.method;
    if (options && options.ok !== false && options.method) return options.method;
    return take.kind === 'video' ? VM.takeMethod(take) : 'references';
  }

  function _choiceLabel(choice) {
    return choice.name;
  }

  function _unavailableText(reason) {
    if (!reason) return '';
    if (reason.code === 'images' || reason.code === 'videos') {
      return reason.max > 0
        ? t(`video_canvas.take.unavailable.${reason.code}`, { max: reason.max })
        : t(`video_canvas.take.unavailable.no_${reason.code}`);
    }
    if (['frames', 'last_frame', 'frames_with_references', 'frames_inputs'].includes(reason.code)) {
      return t(`video_canvas.take.unavailable.${reason.code}`);
    }
    return t('video_canvas.take.unavailable.other');
  }

  /** A ratio as the user knows it: framed, "adaptive" is the first frame's own shape. */
  function _ratioText(ratio, framed) {
    return ratio === 'adaptive' && framed ? t('video_canvas.new_shot.ratio_adaptive') : ratio;
  }

  function _paramsText(params, framed) {
    if (!params) return '';
    return [
      params.ratio ? _ratioText(params.ratio, framed) : '',
      params.resolution || '',
      typeof params.duration === 'number' && params.duration > 0 ? t('video_canvas.seconds', { seconds: VM.formatSeconds(params.duration) }) : '',
      typeof params.audio === 'boolean' ? t(params.audio ? 'video_canvas.take.sound' : 'video_canvas.take.silent') : '',
      params.size || '',
    ].filter(Boolean).join(' · ');
  }

  /** The panel sits on the board, not in the zoomed world, so its words and fields keep their size
   *  at any zoom (decided 2026-11-10). */
  function _mountedTakePanel() {
    return _viewport()?.querySelector(':scope > .video-canvas-take-panel') || null;
  }

  function _takePanel() {
    const viewport = _viewport();
    if (!viewport || !_world()) return null;
    let panel = _mountedTakePanel();
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'video-canvas-take-panel';
      panel.hidden = true;
      // Under the zoom controls, which share its layer.
      viewport.insertBefore(panel, _el('video-canvas-zoom'));
      if (typeof ResizeObserver === 'function') {
        const shown = panel;
        new ResizeObserver(() => {
          if (!_revealDraft) return;
          if (_revealDraft !== _selected || shown.hidden) _revealDraft = '';
          else _reveal(shown);
        }).observe(shown);
      }
    }
    return panel;
  }

  /** Centred under the selected shot card, following it when it or the board moves. Wider than the
   *  card, it reaches about as far into the columns on either side. */
  function _placeTakePanel() {
    const panel = _mountedTakePanel();
    if (!panel || panel.hidden) return;
    const cardEl = _world()?.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(_selected)}"]`);
    if (!cardEl) {
      panel.hidden = true;
      return;
    }
    const view = _view();
    panel.style.left = `${Math.round(view.x + (cardEl.offsetLeft + cardEl.offsetWidth / 2) * view.zoom - panel.offsetWidth / 2)}px`;
    panel.style.top = `${Math.round(view.y + (cardEl.offsetTop + cardEl.offsetHeight) * view.zoom + 12)}px`;
  }

  function _closePanelSelect(name) {
    const api = _panelSelects.get(name);
    if (!api) return;
    _panelSelects.delete(name);
    try { api.close(); } catch (_) { /* a removed select has nothing to close */ }
  }

  function _closePanelSelects() {
    for (const name of [..._panelSelects.keys()]) _closePanelSelect(name);
  }

  /** A menu in the panel, under its name. Its list lives on <body> while open, so one being
   *  replaced is closed first. */
  function _mountPanelSelect(name, host, config, locked) {
    _closePanelSelect(name);
    if (!host) return;
    _panelSelects.set(name, _aiSelectMount(host, config));
    _lockPanelSelect(name, locked);
  }

  /** Read-only, a menu shows its value and opens nothing. Set apart from drawing it, so an Agent
   *  starting and stopping leaves an open menu open. */
  function _lockPanelSelect(name, locked) {
    const api = _panelSelects.get(name);
    const trigger = api && api.el && api.el.querySelector('.ai-select-trigger');
    if (trigger) trigger.disabled = !!locked;
  }

  /** The services to pick from. The one picked stays pickable when it cannot make the shot, so the
   *  menu still names it while the panel says why. */
  function _modelOptions(choices, choiceId) {
    return choices.map((choice) => ({
      value: choice.id,
      label: _choiceLabel(choice),
      disabled: !!choice.unavailable && choice.id !== choiceId,
      ...(choice.unavailable ? { hint: _unavailableText(choice.unavailable) } : {}),
    }));
  }

  function _mountTakeSelect(node, take, options, choiceId) {
    _mountPanelSelect('model', node.querySelector('[data-take-model]'), {
      options: _modelOptions(options.choices, choiceId),
      value: choiceId,
      ariaLabel: t('video_canvas.take.model'),
      onChange: (value) => {
        _takeChoice.set(_takeKey(take), value);
        _renderTakePanel();
      },
    });
  }

  /** What "+" adds: a reference, or the next frame. */
  function _addLabel(method, count) {
    if (method !== 'frames') return t('video_canvas.take.add_reference');
    return t(count === 0 ? 'video_canvas.take.add_first_frame' : 'video_canvas.take.add_last_frame');
  }

  function _refsLabelHtml() {
    return `<div class="video-canvas-field-label"><span>${escapeHtml(t('video_canvas.take.references'))}</span></div>`;
  }

  /** The inputs row: each picture with the part it plays, × on what can be taken out, then "+". */
  function _inputsHtml(inputs, add, locked) {
    const items = inputs.map((input) => {
      const roleText = input.role === 'reference' ? '' : t(`video_canvas.take.role.${input.role}`);
      const label = roleText ? `${input.label} · ${roleText}` : input.label;
      const removeLabel = escapeHtml(t('video_canvas.take.remove_input', { name: input.label }));
      const remove = input.removable
        ? `<button type="button" class="video-canvas-take-remove" data-action="input-remove" data-asset="${escapeHtml(input.asset_id)}" aria-label="${removeLabel}" title="${removeLabel}" ${locked ? 'disabled' : ''}>${_icon('x')}</button>`
        : '';
      return `<div class="video-canvas-take-input">
          <button type="button" class="video-canvas-take-ref" data-action="take-ref" data-card="${escapeHtml(input.card)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
            ${_mediaHtml(input.media_path, input.kind, '')}${roleText ? `<span class="video-canvas-take-ref-role">${escapeHtml(roleText)}</span>` : ''}
          </button>${remove}
        </div>`;
    }).join('');
    const plus = add
      ? `<button type="button" class="video-canvas-take-add" data-action="input-add" aria-label="${escapeHtml(add)}" title="${escapeHtml(add)}" aria-haspopup="menu" ${locked ? 'disabled' : ''}>${_icon('plus')}</button>`
      : '';
    return `<div class="video-canvas-take-refs" role="group" aria-label="${escapeHtml(t('video_canvas.take.references'))}">${items}${plus}</div>`;
  }

  /** A take's input as the row shows it. An added take of a shot shows that take, and the take's
   *  own references show their card. */
  function _shownInput(input) {
    const { card } = input;
    const media = card.results
      ? card.results.find((take) => take.asset_id === input.asset_id) || _shotCurrent(card)
      : card;
    return {
      card: card.key,
      ...(input.asset_id ? { asset_id: input.asset_id } : {}),
      label: card.label,
      media_path: media.media_path,
      kind: media.kind,
      role: input.role,
      removable: input.removable,
    };
  }

  function _renderTakePanel() {
    const panel = _takePanel();
    if (!panel) return;
    _settingsFor = null;
    const draft = _isOpen() ? _selectedDraft() : null;
    const card = _isOpen() && !draft ? _selectedShot() : null;
    if (!card && !draft) {
      _closePanelSelects();
      panel.hidden = true;
      panel.innerHTML = '';
      _renderSettings();
      return;
    }
    // A new shot's panel and a take's have parts of the same names.
    const kind = draft ? 'draft' : 'shot';
    if (panel.dataset.kind !== kind) {
      _closePanelSelects();
      panel.innerHTML = '';
      panel.dataset.kind = kind;
    }
    panel.hidden = false;
    if (draft) _renderDraftPanel(panel, draft);
    else _renderShotPanel(panel, card);
    _placeTakePanel();
    _renderSettings();
  }

  function _renderShotPanel(panel, card) {
    const take = _shotCurrent(card);
    const index = card.results.indexOf(take);
    const lang = getLang();
    const readOnly = _readOnly();
    const job = _shotJob(card.key);
    const running = !!job && job.status === 'running';
    const key = _takeKey(take);
    const asking = _takeAsking.get(`${_cid}|${key}`) || '';
    const inputsAsked = _takeInputsOf(take);
    const settingsAsked = _takeSettingsOf(take);
    const optionsKey = _takeOptionsKey(take);
    const current = take.redoable ? _takeOptions.get(optionsKey) : null;
    const options = current || (take.redoable ? _takeOptionsShown.get(key) : null);
    const loaded = options && options.ok !== false ? options : null;
    const choiceId = take.redoable ? _takeChoiceOf(take) : '';
    const choice = loaded ? loaded.choices.find((item) => item.id === choiceId) || null : null;
    const quote = take.redoable && current ? _quotes.get(_quoteKey(_dir, take.asset_id, choiceId, inputsAsked, settingsAsked)) : null;
    const use = VM.takeUse(card, index);
    const method = _takeMethodOf(take);
    panel.setAttribute('aria-label', t('video_canvas.take.panel', { name: card.label }));

    // Footage joins a take only on the way to making it again (decided 2026-11-10).
    const editable = take.redoable && !readOnly && !running && !asking && !(quote && quote.ok === false && quote.code === 'in_progress');
    const pending = _takeInputs.get(key);
    const inputs = VM.takeInputs(_production(), take, method, pending ? pending.added : []).map(_shownInput);
    const add = take.redoable && !(method === 'frames' && inputs.length >= 2) ? _addLabel(method, inputs.length) : '';
    const showRefs = !!(inputs.length || add);
    const offersMethod = take.kind === 'video' && !!(loaded && loaded.method);
    _patch(panel, 'refs-label', JSON.stringify([showRefs, lang]), showRefs ? _refsLabelHtml() : '');
    _patch(panel, 'refs', JSON.stringify([inputs, add, editable, lang]), showRefs ? _inputsHtml(inputs, add, !editable) : '');

    _patch(panel, 'use', JSON.stringify([use, take.asset_id, readOnly, running, lang]), use.inUse || use.canUse
      ? `<div class="video-canvas-take-use">
          ${use.inUse ? `<span class="video-canvas-meta">${escapeHtml(t('video_canvas.take.in_use'))}</span>` : ''}
          ${use.canUse ? `<button type="button" class="btn btn-sm" data-action="take-use" data-asset="${escapeHtml(take.asset_id)}" ${readOnly || running ? 'disabled' : ''}>${escapeHtml(t('video_canvas.take.use'))}</button>` : ''}
        </div>`
      : '');

    // A field saves its draft only for the visit it was drawn on, like the product card's.
    const promptText = take.prompt || '';
    const promptEditable = editable;
    _patch(panel, 'prompt', JSON.stringify([take.asset_id, promptText, promptEditable, lang, _dir, _lifetime]), promptText || take.redoable
      ? `<label class="video-canvas-field">
          <span class="video-canvas-field-label">${escapeHtml(t('video_canvas.take.prompt'))}</span>
          <textarea class="form-input video-canvas-input video-canvas-prompt" rows="5" ${promptEditable ? '' : 'readonly'}
            data-draft-key="${escapeHtml(`prompt:${key}`)}" data-original="${escapeHtml(promptText)}">${escapeHtml(promptText)}</textarea>
        </label>`
      : '');

    // A video made again sums up its settings on a button that opens them (decided 2026-11-10,
    // plan 27.21); a still lists what it was made at.
    const summary = take.redoable && take.kind === 'video' && choice ? _settingsSummary(choice.params, offersMethod ? method : '') : '';
    const params = summary ? '' : _paramsText(choice ? choice.params : take.params, method === 'frames');
    const choosing = take.kind === 'video' && loaded && loaded.choices.length > 0;
    const modelHtml = choosing
      ? '<div class="video-canvas-take-model" data-take-model></div>'
      : take.model ? `<span class="video-canvas-take-model-name" title="${escapeHtml(take.model)}">${escapeHtml(take.model)}</span>` : '';
    const reason = (choice && choice.unavailable) || (loaded && loaded.unavailable) || null;
    // The words Generate would send, as the field shows them.
    const promptField = panel.querySelector(':scope > [data-part="prompt"] textarea');
    const changed = VM.takeChanged(take, {
      prompt: promptField ? promptField.value : undefined,
      inputs: inputsAsked,
      settings: settingsAsked,
      choice: take.kind === 'video' ? choiceId : '',
      current: loaded ? loaded.current : undefined,
    });
    // New inputs are checked afresh: until their services are known there is nothing to confirm.
    // An unresolved request cannot be sent again, even if new inputs are supplied.
    const blocked = readOnly || running || !!asking || !!reason || (!!inputsAsked && !current) || !changed || !!(quote && quote.ok === false && quote.code === 'in_progress');
    const generate = take.redoable ? _generateHtml(`data-action="take-generate" data-asset="${escapeHtml(take.asset_id)}"`, blocked, t(_generateLabel(running, asking))) : '';
    // The model menu has a part of its own, so an availability result arriving or the panel turning read-only
    // redraws the button beside it and leaves an open menu open. So does the settings button, which
    // the settings popover hangs from.
    const shown = !!(modelHtml || params || summary || generate);
    _patch(panel, 'bar', JSON.stringify([take.asset_id, choosing && loaded.choices, choiceId, take.model, shown, lang, _dir]), shown
      ? _barHtml(modelHtml)
      : '', (node) => { if (choosing) _mountTakeSelect(node, take, loaded, choiceId); else _closePanelSelect('model'); });
    if (!shown) _closePanelSelect('model');
    else _lockPanelSelect('model', !editable);
    const bar = panel.querySelector(':scope > [data-part="bar"] > .video-canvas-take-bar');
    if (bar) {
      _patch(bar.querySelector(':scope > .video-canvas-take-summary'), 'settings', JSON.stringify([summary, !editable, lang]), summary ? _settingsButtonHtml(summary, !editable) : '');
      _patch(bar.querySelector(':scope > .video-canvas-take-row'), 'action', JSON.stringify([take.asset_id, params, quote, blocked, running, asking, lang, _dir]), params || generate
        ? `${params ? `<span class="video-canvas-meta video-canvas-take-params" title="${escapeHtml(params)}">${escapeHtml(params)}</span>` : ''}${generate}`
        : '');
    }
    _settingsFor = summary ? {
      owner: `take:${key}`,
      method,
      offersMethod,
      framesFit: !loaded || loaded.frames_fit !== false,
      choice,
      locked: !editable,
      apply: (setting, value) => (setting === 'method' ? _setTakeMethod(take, value) : _setTakeSetting(take, setting, value)),
    } : null;

    const failed = job && job.status === 'failed';
    const note = !take.redoable ? t('video_canvas.take.no_request')
      : failed ? t('video_canvas.take.failed')
      : quote && quote.ok === false && quote.code === 'in_progress' ? t('video_canvas.error.in_progress')
      : reason ? _unavailableText(reason)
      : '';
    _patch(panel, 'note', JSON.stringify([note, failed, !!reason, lang]), note
      ? `<div class="video-canvas-note${failed || reason ? ' is-failed' : ''}"${failed ? ' role="alert"' : ''}>${escapeHtml(note)}</div>`
      : '');

    if (take.redoable && (!current || _takeOptionsStale.has(optionsKey)) && !readOnly) _loadTakeOptions(take);
    else if (take.redoable && current && !quote && !readOnly && !running && !reason) _quoteFor(take.asset_id, choiceId, _target(), false, inputsAsked, settingsAsked);
  }

  /** A panel's bar: how a video will be made, on a row of its own, in full; then the model, with
   *  Generate at the row's end (decided 2026-11-10, plan 27.21). The row never wraps, so a label
   *  that changes while Generate works never moves it to another. */
  function _barHtml(modelHtml) {
    return `<div class="video-canvas-take-bar"><div class="video-canvas-take-summary"></div><div class="video-canvas-take-row">${modelHtml}</div></div>`;
  }

  /** Generate starts an explicit request using the configured service (2026-11-12). */
  function _generateHtml(attributes, blocked, label) {
    return `<button type="button" class="btn btn-sm btn-primary" ${attributes} ${blocked ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
  }

  // ── Generation settings (decided 2026-11-10, plan 27.21) ──────────────
  // A button on the panel's bar sums up how a video will be made and opens these settings, as
  // TapNow's do: the way it is made, its shape, resolution, length and sound, each a row of buttons
  // like the project page's All / Mine. A shape, resolution or length the service does not make is
  // not listed; a way or sound it cannot take is greyed out, with why beneath.

  /** How a video will be made, in a line: its way where it has a choice, then its settings. */
  function _settingsSummary(params, method) {
    return [
      method ? t(method === 'frames' ? 'video_canvas.take.method_frames' : 'video_canvas.take.method_references') : '',
      _paramsText(params, method === 'frames'),
    ].filter(Boolean).join(' · ');
  }

  function _settingsButtonHtml(summary, locked) {
    return `<button type="button" class="ai-select-trigger video-canvas-settings-button" data-action="gen-settings"
        aria-haspopup="dialog" aria-expanded="false" aria-label="${escapeHtml(t('video_canvas.take.settings'))}" title="${escapeHtml(summary)}" ${locked ? 'disabled' : ''}>
        <span class="ai-select-label">${escapeHtml(summary)}</span>${_icon('chevron-down', 'ai-select-caret')}
      </button>`;
  }

  function _settingsButton() {
    return _takePanel()?.querySelector('[data-action="gen-settings"]') || null;
  }

  function _toggleSettings() {
    if (_closeSettings()) return;
    if (!_settingsFor || _settingsFor.locked) return;
    _settingsOpen = _settingsFor.owner;
    _renderSettings();
    _settingsEl?.querySelector('button[aria-pressed="true"]:not(:disabled)')?.focus({ preventScroll: true });
  }

  function _closeSettings(restoreFocus = false) {
    if (!_settingsOpen) return false;
    _settingsOpen = '';
    _closeSettingsHint();
    if (_settingsEl) {
      _settingsEl.hidden = true;
      _settingsEl.innerHTML = '';
      _settingsShown = '';
    }
    document.removeEventListener('pointerdown', _onSettingsOutside, true);
    window.removeEventListener('resize', _placeSettings);
    const button = _settingsButton();
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) button.focus({ preventScroll: true });
    }
    return true;
  }

  /** Drawn again with the panel, so a pick shows at once; closed when the panel no longer offers
   *  them, as for another card, a read-only panel, or a take being checked. */
  function _renderSettings() {
    if (!_settingsOpen) return;
    const model = _settingsFor;
    const button = _settingsButton();
    if (!model || model.owner !== _settingsOpen || model.locked || !button) {
      _closeSettings();
      return;
    }
    if (!_settingsEl) {
      _settingsEl = document.createElement('section');
      _settingsEl.id = 'video-canvas-settings';
      _settingsEl.className = 'video-canvas-settings';
      _settingsEl.setAttribute('role', 'dialog');
      _settingsEl.hidden = true;
      _settingsEl.addEventListener('click', _onSettingsClick);
      _settingsEl.addEventListener('keydown', _onSettingsKey);
      _settingsEl.addEventListener('mouseover', _onHintOver);
      _settingsEl.addEventListener('mouseout', _onHintOut);
      _settingsEl.addEventListener('focusin', _onHintOver);
      _settingsEl.addEventListener('focusout', _onHintOut);
      document.body.appendChild(_settingsEl);
    }
    _settingsEl.setAttribute('aria-label', t('video_canvas.take.settings'));
    const html = _settingsHtml(model);
    if (_settingsShown !== html) {
      // What had the focus, or the explanation, is found again among the new buttons.
      const focused = _settingsEl.contains(document.activeElement) ? document.activeElement : null;
      const again = focused && focused.dataset.setting
        ? `[data-setting="${focused.dataset.setting}"][data-value="${CSS.escape(focused.dataset.value)}"]`
        : focused && focused.dataset.hint ? `[data-hint="${focused.dataset.hint}"]` : '';
      const hinted = _hintButton ? _hintButton.dataset.hint : '';
      _settingsEl.innerHTML = html;
      _settingsShown = html;
      if (again) _settingsEl.querySelector(again)?.focus({ preventScroll: true });
      if (hinted) {
        const hint = _settingsEl.querySelector(`[data-hint="${hinted}"]`);
        if (hint) _hintButton = hint;
        else _closeSettingsHint();
      }
    }
    _settingsEl.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', _settingsEl.id);
    _placeSettings();
    document.addEventListener('pointerdown', _onSettingsOutside, true);
    window.addEventListener('resize', _placeSettings);
  }

  function _settingsHtml(model) {
    const { choice, method, offersMethod, framesFit } = model;
    const params = choice.params || {};
    const framed = method === 'frames';
    const groups = [];
    if (offersMethod) {
      const reason = choice.frames === 'none' ? t('video_canvas.take.unavailable.frames')
        : !framesFit ? t('video_canvas.take.unavailable.frames_inputs') : '';
      // The way already picked stays pickable, and the panel says why it cannot be made.
      const blocked = !!reason && method !== 'frames';
      groups.push(_settingsGroupHtml('method', t('video_canvas.take.method'), [
        { value: 'references', label: escapeHtml(t('video_canvas.take.method_references')) },
        { value: 'frames', label: escapeHtml(t('video_canvas.take.method_frames')), disabled: blocked },
      ], method, { hint: 'method', note: blocked ? reason : '' }));
    }
    if (choice.ratios.length) {
      groups.push(_settingsGroupHtml('ratio', t('video_canvas.new_shot.ratio'), choice.ratios.map((ratio) => ({
        value: ratio,
        label: `${_ratioGlyph(ratio)}${escapeHtml(_ratioText(ratio, framed))}`,
      })), params.ratio));
    }
    if (choice.resolutions.length) {
      groups.push(_settingsGroupHtml('resolution', t('video_canvas.take.resolution'), choice.resolutions.map((value) => ({ value, label: escapeHtml(value) })), params.resolution));
    }
    if (choice.durations.length) {
      groups.push(_settingsGroupHtml('duration', t('video_canvas.new_shot.duration'), choice.durations.map((seconds) => ({
        value: seconds,
        label: escapeHtml(t('video_canvas.seconds', { seconds: VM.formatSeconds(seconds) })),
      })), params.duration));
    }
    groups.push(_settingsGroupHtml('audio', t('video_canvas.take.audio'), [
      { value: true, label: escapeHtml(t('video_canvas.take.sound')) },
      { value: false, label: escapeHtml(t('video_canvas.take.silent')), disabled: !choice.silent },
    ], params.audio !== false, { hint: 'audio', note: choice.silent ? '' : t('video_canvas.take.unavailable.silent') }));
    return groups.join('');
  }

  /** One setting: its name, with an explanation where it has one, a row of buttons, and why one
   *  of them cannot be picked. Labels arrive escaped. */
  function _settingsGroupHtml(setting, title, options, value, { hint = '', note = '' } = {}) {
    const hintHtml = hint
      ? `<button type="button" class="video-canvas-hint" data-hint="${hint}" aria-label="${escapeHtml(title)}" aria-describedby="video-canvas-hint">${_icon('info', 'video-canvas-hint-icon')}</button>`
      : '';
    const buttons = options.map((option) => `<button type="button" class="btn btn-sm" data-setting="${setting}" data-value="${escapeHtml(String(option.value))}"
        aria-pressed="${String(option.value) === String(value)}" ${option.disabled ? 'disabled' : ''}>${option.label}</button>`).join('');
    return `<div class="video-canvas-settings-group">
        <div class="video-canvas-settings-title"><span id="video-canvas-setting-${setting}">${escapeHtml(title)}</span>${hintHtml}</div>
        <div class="project-detail-tab-group video-canvas-segments" role="group" aria-labelledby="video-canvas-setting-${setting}">${buttons}</div>
        ${note ? `<div class="video-canvas-settings-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
  }

  /** A small box the shape of a ratio, fitted in 14px; the first frame's shape has a dashed one. */
  function _ratioGlyph(ratio) {
    const [width, height] = String(ratio).split(':').map(Number);
    if (!(width > 0 && height > 0)) return '<span class="video-canvas-ratio-glyph is-adaptive" aria-hidden="true"></span>';
    return `<span class="video-canvas-ratio-glyph" style="${width >= height ? 'width' : 'height'}:14px;aspect-ratio:${width} / ${height}" aria-hidden="true"></span>`;
  }

  function _onSettingsClick(event) {
    const hint = event.target.closest('[data-hint]');
    if (hint) {
      // A click pins the explanation; another click on it lets go.
      if (_hintPinned && _hintButton === hint) _closeSettingsHint();
      else {
        _showSettingsHint(hint);
        _hintPinned = true;
      }
      return;
    }
    const button = event.target.closest('[data-setting]');
    const model = _settingsFor;
    if (!button || button.disabled || button.getAttribute('aria-pressed') === 'true') return;
    if (!model || model.locked || model.owner !== _settingsOpen) return;
    const { setting, value } = button.dataset;
    Promise.resolve(model.apply(setting, setting === 'duration' ? Number(value) : setting === 'audio' ? value === 'true' : value)).catch((err) => {
      _log.warn('canvas setting not applied', { setting, error_type: err && err.name ? String(err.name) : typeof err });
    });
  }

  function _onSettingsKey(event) {
    if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    // The innermost first: the explanation, then the settings.
    if (_hintButton) _closeSettingsHint();
    else _closeSettings(true);
  }

  function _onSettingsOutside(event) {
    const { target } = event;
    if (_settingsEl?.contains(target) || _hintEl?.contains(target) || target.closest?.('[data-action="gen-settings"]')) return;
    _closeSettings();
  }

  /** Under its button, or above where it fits better (P16), on the layer above any open dialog. */
  function _placeSettings() {
    const button = _settingsButton();
    if (!_settingsEl || _settingsEl.hidden || !button) return;
    const rect = button.getBoundingClientRect();
    _settingsEl.dataset.uiOverlay = '';
    _settingsEl.style.maxHeight = '';
    const placement = _dropdownVerticalPlacement(rect, _settingsEl.offsetHeight, window.innerHeight, { edge: 8, gap: 4 });
    _settingsEl.style.top = `${placement.top}px`;
    _settingsEl.style.maxHeight = `${placement.availableHeight}px`;
    _settingsEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - _settingsEl.offsetWidth - 8))}px`;
    _settingsEl.style.zIndex = String(_aiSelectPopoverZIndexFor(button));
    _placeSettingsHint();
  }

  // An explanation of a setting (P21): shown on hover or focus, kept while the pointer is on it,
  // pinned by a click, and gone with Escape or a click elsewhere.
  function _showSettingsHint(button) {
    if (!_hintEl) {
      _hintEl = document.createElement('div');
      _hintEl.id = 'video-canvas-hint';
      _hintEl.className = 'project-driver-tooltip';
      _hintEl.setAttribute('role', 'tooltip');
      _hintEl.hidden = true;
      _hintEl.addEventListener('mouseleave', (event) => {
        if (!_hintPinned && _hintButton && document.activeElement !== _hintButton && !_hintButton.contains(event.relatedTarget)) _closeSettingsHint();
      });
      document.body.appendChild(_hintEl);
    }
    _hintPinned = false;
    _hintButton = button;
    _hintEl.textContent = t(`video_canvas.take.${button.dataset.hint}_help`);
    _hintEl.hidden = false;
    _placeSettingsHint();
  }

  function _placeSettingsHint() {
    if (!_hintEl || _hintEl.hidden || !_hintButton || !_hintButton.isConnected) return;
    const rect = _hintButton.getBoundingClientRect();
    _hintEl.dataset.uiOverlay = '';
    _hintEl.style.maxHeight = '';
    const placement = _dropdownVerticalPlacement(rect, _hintEl.offsetHeight, window.innerHeight, { gap: 4 });
    _hintEl.style.top = `${placement.top}px`;
    _hintEl.style.maxHeight = `${placement.availableHeight}px`;
    _hintEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - _hintEl.offsetWidth - 8))}px`;
    _hintEl.style.zIndex = String((Number.parseInt(_settingsEl?.style.zIndex || '', 10) || 0) + 1);
  }

  function _closeSettingsHint() {
    _hintPinned = false;
    _hintButton = null;
    if (_hintEl) _hintEl.hidden = true;
  }

  function _onHintOver(event) {
    const button = event.target.closest('[data-hint]');
    if (button && !_hintPinned) _showSettingsHint(button);
  }

  function _onHintOut(event) {
    const button = event.target.closest('[data-hint]');
    if (!button || _hintPinned || button !== _hintButton) return;
    const next = event.relatedTarget;
    if (next && (button.contains(next) || _hintEl?.contains(next))) return;
    if (event.type === 'mouseout' && document.activeElement === button) return;
    _closeSettingsHint();
  }

  /** What Generate says: what is under way, else what pressing it does. */
  function _generateLabel(running, asking) {
    if (running) return 'video_canvas.redoing';
    if (asking === 'submitting') return 'video_canvas.take.submitting';
    if (asking === 'checking') return 'common.loading';
    return 'video_canvas.take.generate';
  }

  function _setTakeMethod(take, method) {
    const key = _takeKey(take);
    const pending = _takeInputs.get(key) || { added: [] };
    _takeInputs.set(key, { ...pending, method });
    _renderTakePanel();
  }

  function _setTakeSetting(take, setting, value) {
    const key = _takeKey(take);
    _takeSettings.set(key, { ...(_takeSettings.get(key) || {}), [setting]: value });
    _renderTakePanel();
  }

  function _addTakeInput(take, assetId, target = _target()) {
    if (!_acceptsTarget(target)) return;
    const key = _takeKey(take);
    const pending = _takeInputs.get(key) || { added: [] };
    if (pending.added.includes(assetId)) return;
    _takeInputs.set(key, { ...pending, added: [...pending.added, assetId] });
    _renderTakePanel();
  }

  function _removeTakeInput(take, assetId) {
    const key = _takeKey(take);
    const pending = _takeInputs.get(key);
    if (!pending) return;
    _takeInputs.set(key, { ...pending, added: pending.added.filter((id) => id !== assetId) });
    _renderTakePanel();
  }

  async function _loadTakeOptions(take, target = _target()) {
    const inputs = _takeInputsOf(take, target.dir);
    const key = _takeOptionsKey(take, target.dir);
    if (_takeLoading.has(key)) return;
    _takeLoading.add(key);
    try {
      const settings = _takeSettingsOf(take, target.dir);
      const options = await global.orkas.invoke('videoCanvas.redoOptions', {
        cid: target.cid,
        dir: target.dir,
        asset: take.asset_id,
        ...(inputs ? { inputs } : {}),
        ...(settings ? { settings } : {}),
      }).catch(() => null);
      if (!_acceptsTarget(target)) return;
      // A failed lookup offers no choice: the take is made where it was, as from the Agent.
      if (options && options.ok) {
        _takeOptions.set(key, options);
        _takeOptionsShown.set(`${target.dir}|${take.asset_id}`, options);
      } else if (!_takeOptions.has(key)) _takeOptions.set(key, { ok: true, choices: [], current: '' });
      _takeOptionsStale.delete(key);
      _renderTakePanel();
    } finally {
      _takeLoading.delete(key);
    }
  }

  // ── A new shot's panel (decided 2026-11-10) ──────────────────────────
  // What to make it from, its words, and on which service, at what shape and length. Its choices
  // are saved as they are made, so the new shot survives closing the canvas.

  function _draftOptionsKey(draft, dir = _dir) {
    return `${dir}|${draft.id}|${JSON.stringify([draft.kind, draft.method, draft.inputs.map((input) => input.asset_id), draft.choice || '', draft.ratio || '', draft.duration || 0, draft.resolution || '', draft.audio ?? null])}`;
  }

  /** The service a new shot is made on: the user's pick while it is offered, else the default. */
  function _draftChoiceOf(draft) {
    const options = _draftOptions.get(_draftOptionsKey(draft)) || _draftOptionsShown.get(`${_dir}|${draft.id}`);
    if (!options || options.ok === false || options.kind !== 'video') return '';
    return options.choices.some((choice) => choice.id === draft.choice) ? draft.choice : options.current;
  }

  function _renderDraftPanel(panel, draft) {
    const lang = getLang();
    const readOnly = _readOnly();
    const job = _draftJob(draft.key);
    const running = !!job && job.status === 'running';
    const asking = _takeAsking.get(`${_cid}|${_dir}|${draft.key}`) || '';
    const optionsKey = _draftOptionsKey(draft);
    const current = _draftOptions.get(optionsKey);
    const options = current || _draftOptionsShown.get(`${_dir}|${draft.id}`);
    const loaded = options && options.ok !== false ? options : null;
    const video = draft.kind === 'video';
    const choices = loaded && loaded.kind === 'video' ? loaded.choices : [];
    const choiceId = _draftChoiceOf(draft);
    const choice = choices.find((item) => item.id === choiceId) || null;
    const quote = current ? _quotes.get(`${optionsKey}|${choiceId}`) : null;
    const pending = !!(quote && quote.ok === false && quote.code === 'in_progress');
    const locked = readOnly || running || pending || !!asking;
    panel.setAttribute('aria-label', t('video_canvas.take.panel', { name: _draftTitle(draft) }));

    const inputs = draft.inputs.map((input, index) => ({
      card: input.card,
      asset_id: input.asset_id,
      label: input.label,
      media_path: input.media_path,
      kind: input.kind,
      role: VM.inputRole(draft.method, index),
      removable: true,
    }));
    const framesFit = inputs.length <= 2 && inputs.every((input) => input.kind === 'image');
    const add = draft.method === 'frames' && inputs.length >= 2 ? '' : _addLabel(draft.method, inputs.length);
    _patch(panel, 'refs-label', JSON.stringify([lang]), _refsLabelHtml());
    _patch(panel, 'refs', JSON.stringify([inputs, add, locked, lang]), _inputsHtml(inputs, add, locked));

    // Drawn once for each visit and kept while typing: the words are saved as they are typed.
    _patch(panel, 'prompt', JSON.stringify([draft.id, locked, lang, _dir, _lifetime]), `<label class="video-canvas-field">
        <span class="video-canvas-field-label">${escapeHtml(t('video_canvas.take.prompt'))}</span>
        <textarea class="form-input video-canvas-input video-canvas-prompt" rows="5" ${locked ? 'readonly' : ''}
          data-draft-key="${escapeHtml(`draft-prompt:${_dir}|${draft.id}`)}" data-commit="draft" data-draft="${escapeHtml(draft.id)}"
          data-original="${escapeHtml(draft.prompt)}">${escapeHtml(draft.prompt)}</textarea>
      </label>`);

    _patch(panel, 'bar', JSON.stringify([draft.id, choices, choiceId, lang, _dir]),
      _barHtml(choices.length ? '<div class="video-canvas-take-model" data-take-model></div>' : ''), (node) => _mountDraftModel(node, draft, choices, choiceId));
    if (!choices.length) _closePanelSelect('model');
    _lockPanelSelect('model', locked);
    const bar = panel.querySelector(':scope > [data-part="bar"] > .video-canvas-take-bar');
    const reason = (choice && choice.unavailable) || (loaded && loaded.unavailable) || null;
    const blocked = readOnly || running || pending || !!asking || !!reason || (video && !current);
    // How it is made, its shape, resolution, length and sound, summed up on a button that opens
    // them (decided 2026-11-10, plan 27.21).
    const summary = video && choice ? _settingsSummary(choice.params, draft.method) : '';
    if (bar) {
      _patch(bar.querySelector(':scope > .video-canvas-take-summary'), 'settings', JSON.stringify([summary, locked, lang]), summary ? _settingsButtonHtml(summary, locked) : '');
      _patch(bar.querySelector(':scope > .video-canvas-take-row'), 'action', JSON.stringify([draft.id, quote, blocked, running, asking, lang, _dir]),
        _generateHtml(`data-action="draft-generate" data-draft="${escapeHtml(draft.id)}"`, blocked, t(_generateLabel(running, asking))));
    }
    _settingsFor = summary ? {
      owner: `draft:${draft.key}`,
      method: draft.method,
      offersMethod: true,
      framesFit,
      choice,
      locked,
      apply: (setting, value) => _saveDraft(draft, { [setting]: value }),
    } : null;

    const failed = job && job.status === 'failed';
    const note = failed ? t('video_canvas.take.failed') : pending ? t('video_canvas.error.in_progress') : reason ? _unavailableText(reason) : '';
    _patch(panel, 'note', JSON.stringify([note, failed, !!reason, lang]), note
      ? `<div class="video-canvas-note${failed || reason ? ' is-failed' : ''}"${failed ? ' role="alert"' : ''}>${escapeHtml(note)}</div>`
      : '');

    if ((!current || _draftOptionsStale.has(optionsKey)) && !readOnly) _loadDraftOptions(draft);
    else if (current && !quote && !readOnly && !running && !reason) _quoteDraftFor(draft, choiceId);
  }

  function _mountDraftModel(node, draft, choices, choiceId) {
    if (!choices.length) return;
    _mountPanelSelect('model', node.querySelector('[data-take-model]'), {
      options: _modelOptions(choices, choiceId),
      value: choiceId,
      ariaLabel: t('video_canvas.take.model'),
      onChange: (value) => _saveDraft(draft, { choice: value }),
    });
  }

  async function _loadDraftOptions(draft, target = _target()) {
    const key = _draftOptionsKey(draft, target.dir);
    if (_draftLoading.has(key)) return;
    _draftLoading.add(key);
    try {
      const options = await global.orkas.invoke('videoCanvas.draftOptions', { cid: target.cid, dir: target.dir, id: draft.id }).catch(() => null);
      if (!_acceptsTarget(target)) return;
      // Without an answer there is no choice to show; making it asks again.
      _draftOptions.set(key, options && options.ok ? options : { ok: false });
      if (options && options.ok) _draftOptionsShown.set(`${target.dir}|${draft.id}`, options);
      _draftOptionsStale.delete(key);
      _renderTakePanel();
    } finally {
      _draftLoading.delete(key);
    }
  }

  /** From a scene, a card or a ref: select a shot showing this take, with its panel in view. */
  function _showTake(cardKey, assetId) {
    const card = _cardOf(cardKey);
    if (!card || !card.results) return;
    const index = card.results.findIndex((take) => take.asset_id === assetId);
    if (index >= 0) _shotResult.set(`${_dir}|${card.key}`, index);
    _selected = card.key;
    _render();
    const cardEl = _world()?.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(card.key)}"]`);
    const panel = _mountedTakePanel();
    if (cardEl) _reveal(cardEl);
    if (panel && !panel.hidden) _reveal(panel);
    const field = panel && panel.querySelector('textarea');
    if (field && !field.readOnly) field.focus({ preventScroll: true });
  }

  function _ensureCard(key, column, kind = column) {
    const world = _world();
    let el = world.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(key)}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = `video-canvas-card is-${kind}`;
      el.dataset.card = key;
      el.dataset.column = column;
      el.tabIndex = 0;
      world.appendChild(el);
      if (_cardObserver) _cardObserver.observe(el);
    }
    return el;
  }

  const _cardObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => _scheduleLayout())
    : null;

  function _scheduleLayout() {
    if (_layoutFrame) return;
    _layoutFrame = requestAnimationFrame(() => {
      _layoutFrame = 0;
      _layout();
    });
  }

  /** Put every card where it goes, then draw what is selected. */
  function _layout() {
    const production = _production();
    const world = _world();
    if (!production || !world) return;
    const cards = [...world.querySelectorAll(':scope > .video-canvas-card')];
    const sizes = {};
    for (const card of cards) sizes[card.dataset.card] = { width: card.offsetWidth, height: card.offsetHeight };
    const { positions } = VM.layoutCards(production, sizes);
    for (const card of cards) {
      if (card.classList.contains('is-dragging')) continue;
      const position = positions[card.dataset.card];
      if (!position) continue;
      card.style.left = `${position.x}px`;
      card.style.top = `${position.y}px`;
    }
    _drawLines();
    if (!_views.has(_viewKey())) _fit();
    else _applyView();
  }

  function _drawLines() {
    const svg = _el('video-canvas-lines');
    const production = _production();
    if (!svg) return;
    const world = _world();
    world.querySelectorAll(':scope > .video-canvas-card').forEach((card) => {
      card.classList.toggle('is-selected', card.dataset.card === _selected);
      card.classList.remove('is-related');
    });
    if (!_selected || !production) {
      svg.innerHTML = '';
      _placeTakePanel();
      return;
    }
    const related = VM.relatedTo(_selected, VM.edgesOf(production));
    for (const key of related.cards) {
      if (key === _selected) continue;
      const node = world.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(key)}"]`);
      if (node) node.classList.add('is-related');
    }
    const rectOf = (key) => {
      const node = world.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(key)}"]`);
      return node ? { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight } : null;
    };
    svg.innerHTML = related.edges.map((edge) => {
      const from = rectOf(edge.from);
      const to = rectOf(edge.to);
      if (!from || !to) return '';
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const bend = Math.max(40, Math.abs(endX - startX) / 2);
      return `<path d="M${startX} ${startY} C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}"></path>`;
    }).join('');
    _placeTakePanel();
  }

  function _view() {
    return _views.get(_viewKey()) || { x: 32, y: 32, zoom: 1 };
  }

  function _applyView() {
    const world = _world();
    if (!world) return;
    const view = _view();
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const label = _el('video-canvas-zoom-label');
    if (label) label.textContent = `${Math.round(view.zoom * 100)}%`;
    _placeTakePanel();
    _placeSettings();
  }

  /** A move of the board, except one that reveals something, stops a new shot's panel following. */
  function _setView(view, revealing = false) {
    if (!revealing) _revealDraft = '';
    _views.set(_viewKey(), view);
    _applyView();
  }

  function _fit() {
    const viewport = _viewport();
    const world = _world();
    if (!viewport || !world || viewport.clientWidth <= 0) return;
    const rects = [...world.querySelectorAll(':scope > .video-canvas-card')].map((card) => ({
      x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight,
    }));
    _setView(VM.fitView(rects, { width: viewport.clientWidth, height: viewport.clientHeight }));
  }

  function _closeFloating() {
    for (const api of [..._versionSelects.values(), ..._voiceSelects.values()]) {
      try { api.close(); } catch (_) { /* a removed select has nothing to close */ }
    }
    for (const api of _panelSelects.values()) {
      try { api.close(); } catch (_) { /* a removed select has nothing to close */ }
    }
  }

  function _renderHeader() {
    const productions = (_data && _data.productions) || [];
    const host = _el('video-canvas-production');
    if (host) {
      if (productions.length > 1) {
        host.hidden = false;
        const options = productions.map((item) => ({ value: item.dir, label: item.name || item.dir }));
        if (_productionSelect) _productionSelect.setOptions(options, { value: _dir });
        else {
          _productionSelect = _aiSelectMount(host, {
            options,
            value: _dir,
            ariaLabel: t('video_canvas.production'),
            onChange: (value) => {
              _dir = value;
              _selected = '';
              _render();
            },
          });
        }
      } else {
        host.hidden = true;
      }
    }
    const status = _el('video-canvas-status');
    if (status) {
      const message = _readOnly() ? t('video_canvas.read_only') : _importing ? t('video_canvas.importing') : '';
      status.hidden = !message;
      status.innerHTML = message ? `${_icon('loader', 'ui-icon video-canvas-spin')}${escapeHtml(message)}` : '';
    }
  }

  function _renderEmpty() {
    const empty = _el('video-canvas-empty');
    if (!empty) return;
    const has = !!_production();
    empty.hidden = has;
    if (has) return;
    const signature = `${getLang()}|${_readOnly()}`;
    if (empty.dataset.signature === signature) return;
    empty.dataset.signature = signature;
    empty.innerHTML = `<div class="video-canvas-empty-title">${escapeHtml(t('video_canvas.empty_title'))}</div>
      <div class="video-canvas-note">${escapeHtml(t('video_canvas.empty_hint'))}</div>
      <div class="video-canvas-templates">${TEMPLATES.map((id) => `<button type="button" class="btn btn-sm" data-action="template" data-template="${id}">${escapeHtml(t(`video_canvas.template.${id}`))}</button>`).join('')}</div>
      <div class="video-canvas-dropzone">
        ${_icon('download')}
        <div class="video-canvas-dropzone-title">${escapeHtml(t('video_canvas.drop_title'))}</div>
        <div class="video-canvas-meta">${escapeHtml(t('video_canvas.drop_hint'))}</div>
      </div>`;
  }

  /** Bring the panel up to date without disturbing what the user is doing in it. */
  function _render() {
    const world = _world();
    if (!world) return;
    const productions = (_data && _data.productions) || [];
    if (!productions.some((item) => item.dir === _dir)) {
      _dir = productions.length ? productions[0].dir : '';
      _selected = '';
    }
    if (_renderedDir !== _dir) _lifetime += 1;
    _renderHeader();
    _renderEmpty();
    _panel().classList.toggle('is-read-only', _readOnly());
    const production = _production();
    const zoom = _el('video-canvas-zoom');
    if (zoom) zoom.hidden = !production;
    const hint = _el('video-canvas-board-hint');
    if (hint) hint.hidden = !production;
    const wanted = new Set(VM.productionCards(production).map((card) => card.key));
    const changedProduction = _renderedDir !== _dir;
    world.querySelectorAll(':scope > .video-canvas-card').forEach((card) => {
      if (changedProduction || !wanted.has(card.dataset.card)) {
        if (_cardObserver) _cardObserver.unobserve(card);
        card.remove();
      }
    });
    _renderedDir = _dir;
    if (!production) {
      _drawLines();
      _renderTakePanel();
      return;
    }
    if (_selected && !wanted.has(_selected)) _selected = '';
    const show = (card, column, render, kind = column) => {
      const el = _ensureCard(card.key, column, kind);
      el.setAttribute('aria-label', card.label);
      render(el, card);
    };
    if (VM.showsProduct(production)) show(production.product, 'asset', _renderProductCard, 'product');
    for (const card of production.assets) show(card, 'asset', _renderAssetCard);
    for (const card of production.shots) show(card, 'shot', _renderShotCard);
    for (const card of production.drafts || []) show({ ...card, label: _draftTitle(card) }, 'shot', _renderDraftCard, 'draft');
    for (const card of production.videos) show(card, 'video', _renderVideoCard);
    _layout();
    _renderTakePanel();
  }

  // ── Talking to main ──────────────────────────────────────────────────

  async function refresh() {
    const requestedCid = _cid;
    if (!requestedCid) return;
    const seq = ++_readSeq;
    let response = null;
    try {
      response = await global.orkas.invoke('videoCanvas.read', { cid: requestedCid });
    } catch (err) {
      _log.warn('canvas read failed', { error_type: err && err.name ? String(err.name) : typeof err });
    }
    if (seq !== _readSeq || !VM.acceptsResponse(_cid, requestedCid)) return;
    if (!response || response.ok === false) return;
    // Compare the cards, not job progress, file timestamps or saved positions.
    // Production order follows timestamps, so normalize it before comparing.
    const signature = JSON.stringify((response.productions || [])
      .map(({ updated_at_ms, layout, ...content }) => content)
      .sort((a, b) => a.dir.localeCompare(b.dir)));
    if (_isOpen()) _hasUnseenChanges = false;
    else if (_contentSignature !== null && signature !== _contentSignature) _hasUnseenChanges = true;
    _contentSignature = signature;
    _data = response;
    _lastBusy = !!response.busy;
    for (const key of _takeOptions.keys()) _takeOptionsStale.add(key);
    for (const key of _draftOptions.keys()) _draftOptionsStale.add(key);
    _adoptJobs(response.jobs || []);
    _updateToggle();
    if (_isOpen()) _render();
  }

  function _adoptJobs(jobs) {
    _jobs.clear();
    for (const job of jobs) _jobs.set(VM.jobKey(job), job);
  }

  function _updateToggle() {
    const toggle = _el('video-canvas-toggle');
    if (!toggle) return;
    const has = !!(_data && ((_data.productions || []).length || _data.video_studio));
    toggle.hidden = !has;
    _updateReminder();
    if (!has && _isOpen()) close();
  }

  function _updateReminder() {
    const toggle = _el('video-canvas-toggle');
    if (!toggle) return;
    const unseen = !toggle.hidden && _hasUnseenChanges && !_isOpen();
    const dot = _el('video-canvas-update-dot');
    if (dot) dot.hidden = !unseen;
    toggle.setAttribute('aria-label', `${t('video_canvas.toggle_title')}${unseen ? ` · ${t('video_canvas.updated')}` : ''}`);
  }

  function _refusalMessage(result) {
    const code = String((result && result.code) || 'failed');
    const key = `video_canvas.error.${code}`;
    const text = t(key);
    return text && text !== key ? text : t('video_canvas.error.failed');
  }

  async function _edit(edit, target = _target()) {
    if (!_acceptsTarget(target)) return false;
    const { cid, dir } = target;
    let result = null;
    try {
      result = await global.orkas.invoke('videoCanvas.edit', { cid, dir, edit });
    } catch (err) {
      _log.warn('canvas edit failed', { kind: edit.kind, error_type: err && err.name ? String(err.name) : typeof err });
    }
    const ok = !!(result && result.ok);
    if (!_acceptsTarget(target)) return ok;
    if (ok && result.trimmed_to_sec) {
      uiToast(t('video_canvas.clip_trimmed', { seconds: result.trimmed_to_sec }), { variant: 'info', timeoutMs: 6000 });
    }
    if (!ok) uiToast(_refusalMessage(result), { variant: 'warning', timeoutMs: 6000 });
    await refresh();
    return ok;
  }

  /** Who the update of a changed product goes to (main: tool-catalog VIDEO_STUDIO_AGENT_ID). */
  const VIDEO_STUDIO_RECIPIENT = { kind: 'agent', id: '79df9cc89f5f', name: 'VideoStudio' };
  const _askingAgent = new Set();

  /** Update a video as the user asked. The product's words reach it through the Agent, which says
   *  them in the video's own words and voice, and so does narration changed here, or its voice,
   *  which the Agent voices again; anything else the app renders by itself, and a video with
   *  nothing changed renders nothing. Read afresh first: nothing marks a video as behind. */
  async function _updateVideo(videoId) {
    const target = _target();
    await refresh();
    if (!_acceptsTarget(target)) return;
    const card = ((_production() && _production().videos) || []).find((item) => item.id === videoId);
    if (card && VM.agentUpdateMessage(card, t)) return _askAgentToUpdate(card);
    return _startRender(videoId);
  }

  /** Sent as the user's own message, naming what changed since the video went out. */
  async function _askAgentToUpdate(card, target = _target()) {
    if (!_acceptsTarget(target)) return;
    const key = `${target.cid}|${target.dir}|${card.id}`;
    if (_askingAgent.has(key)) return;
    _askingAgent.add(key);
    let ok = false;
    try {
      const text = VM.agentUpdateMessage(card, t);
      const content = typeof global.applyRecipientPrefix === 'function'
        ? global.applyRecipientPrefix(text, 'conversation', { recipientSnapshot: VIDEO_STUDIO_RECIPIENT })
        : `@${VIDEO_STUDIO_RECIPIENT.name} ${text}`;
      const result = typeof global.sendInConversation === 'function'
        ? await global.sendInConversation(target.cid, content, undefined, { source_view: 'video_canvas' })
        : null;
      ok = !!result && (result.started !== false || result.queued === true);
    } catch (err) {
      _log.warn('canvas update not sent', { error_type: err && err.name ? String(err.name) : typeof err });
    } finally {
      _askingAgent.delete(key);
    }
    if (!ok && _acceptsTarget(target)) uiToast(t('video_canvas.error.failed'), { variant: 'warning' });
  }

  async function _startRender(video) {
    const cid = _cid;
    const result = await global.orkas.invoke('videoCanvas.render', { cid, dir: _dir, video }).catch(() => null);
    if (!result || result.ok === false) uiToast(_refusalMessage(result), { variant: 'warning' });
    else if (result.unchanged && VM.acceptsResponse(_cid, cid)) uiToast(t('video_canvas.up_to_date'), { variant: 'info' });
    if (VM.acceptsResponse(_cid, cid)) await refresh();
  }

  async function _saveLayout() {
    const production = _production();
    if (!production) return;
    const result = await global.orkas.invoke('videoCanvas.layout', { cid: _cid, dir: _dir, cards: production.layout }).catch(() => null);
    if (!result || result.ok === false) _log.warn('canvas layout not saved');
  }

  /** Check the configured service once per input set; an explicit Generate checks afresh. */
  const _quoting = new Set();
  async function _quoteFor(assetId, choice, target = _target(), fresh = false, inputs = undefined, settings = undefined) {
    if (!_acceptsTarget(target)) return null;
    const { cid, dir } = target;
    const key = _quoteKey(dir, assetId, choice, inputs, settings);
    if (!fresh && _quoting.has(key)) return null;
    _quoting.add(key);
    try {
      const quote = await global.orkas.invoke('videoCanvas.quoteRedo', {
        cid,
        dir,
        asset: assetId,
        choice: choice || '',
        ...(inputs ? { inputs } : {}),
        ...(settings ? { settings } : {}),
      }).catch(() => null);
      if (!_acceptsTarget(target)) return null;
      _quotes.set(key, quote || { ok: false, code: 'quote_failed' });
      _renderTakePanel();
      return quote;
    } finally {
      _quoting.delete(key);
    }
  }

  function _regenerateConfirmMessage(_quote, card) {
    const where = t(card.results.some((take) => take.used_in > 0) ? 'video_canvas.take.goes_into_videos' : 'video_canvas.take.stays_on_card');
    return t('video_canvas.take.confirm_own_key', { where });
  }

  /** Once service availability is checked and nothing was started, focus goes back to Generate if it was lost:
   *  the button it was on was redrawn while the panel took no change (2026-11-10). */
  function _refocusGenerate() {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const panel = _mountedTakePanel();
    const button = panel && !panel.hidden ? panel.querySelector('[data-action="take-generate"], [data-action="draft-generate"]') : null;
    if (button && !button.disabled) button.focus({ preventScroll: true });
  }

  /** Make the take the panel shows again, with the words and service it shows now. */
  async function _regenerate(card, take) {
    const target = _target();
    // A second click while this one is being checked or confirmed would be a duplicate request.
    const key = `${target.cid}|${target.dir}|${take.asset_id}`;
    if (_takeAsking.has(key)) return;
    _takeAsking.set(key, 'checking');
    _renderTakePanel();
    try {
      const choice = take.kind === 'video' ? _takeChoiceOf(take) : '';
      const inputs = _takeInputsOf(take, target.dir);
      const settings = _takeSettingsOf(take, target.dir);
      const field = _takePanel()?.querySelector('textarea[data-draft-key]');
      const prompt = field ? field.value : take.prompt || '';
      if (!String(prompt).trim()) {
        uiToast(t('video_canvas.take.prompt_empty'), { variant: 'warning' });
        return;
      }
      const quote = await _quoteFor(take.asset_id, choice, target, true, inputs, settings);
      if (!_acceptsTarget(target)) return;
      if (!quote || quote.ok === false) {
        uiToast(_refusalMessage(quote), { variant: 'warning' });
        return;
      }
      if (!quote.sufficient) {
        uiToast(t('video_canvas.error.route_unavailable'), { variant: 'warning', timeoutMs: 8000 });
        return;
      }
      const confirmed = await uiConfirm({
        message: _regenerateConfirmMessage(quote, card),
        okLabel: t('video_canvas.take.generate'),
      });
      if (!confirmed || !_acceptsTarget(target)) return;
      _takeAsking.set(key, 'submitting');
      _renderTakePanel();
      const result = await global.orkas.invoke('videoCanvas.redo', {
        cid: target.cid,
        dir: target.dir,
        asset: take.asset_id,
        prompt,
        choice,
        ...(inputs ? { inputs } : {}),
        ...(settings ? { settings } : {}),
      }).catch(() => null);
      if (!_acceptsTarget(target)) return;
      if (!result || result.ok === false) {
        const message = _refusalMessage(result);
        uiToast(message, { variant: 'warning', timeoutMs: 8000 });
        return;
      }
      // The words, footage and settings went with the request, and the new take will carry them.
      _drafts.delete(`prompt:${target.dir}|${take.asset_id}`);
      _takeInputs.delete(`${target.dir}|${take.asset_id}`);
      _takeSettings.delete(`${target.dir}|${take.asset_id}`);
    } finally {
      _takeAsking.delete(key);
      if (_acceptsTarget(target)) {
        _renderTakePanel();
        _refocusGenerate();
      }
    }
  }

  /** Save what the user changed about a new shot, and show it as saved. */
  async function _saveDraft(draft, fields, target = _target()) {
    if (!_acceptsTarget(target)) return false;
    const result = await global.orkas.invoke('videoCanvas.draft', {
      cid: target.cid,
      dir: target.dir,
      change: { kind: 'update', id: draft.id, ...fields },
    }).catch(() => null);
    if (!_acceptsTarget(target)) return false;
    const ok = !!(result && result.ok);
    if (!ok) uiToast(_refusalMessage(result), { variant: 'warning', timeoutMs: 6000 });
    await refresh();
    return ok;
  }

  function _scheduleDraftPrompt(field) {
    const key = field.dataset.draftKey;
    clearTimeout(_draftPromptSaves.get(key)?.timer);
    _draftPromptSaves.set(key, { field, timer: setTimeout(() => { _saveDraftPrompt(field); }, DRAFT_PROMPT_SAVE_MS) });
  }

  /** A new shot's words are saved as they are typed, without redrawing the panel, so they are
   *  still there when the canvas opens again. They go where they were typed, even once the user
   *  has moved on to another conversation. */
  async function _saveDraftPrompt(field, target = _fieldTargets.get(field)) {
    const key = field.dataset.draftKey;
    clearTimeout(_draftPromptSaves.get(key)?.timer);
    _draftPromptSaves.delete(key);
    if (!target) return true;
    const id = field.dataset.draft;
    const prompt = field.value;
    const shown = _acceptsTarget(target) ? _cardOf(`draft:${id}`) : null;
    if (shown && shown.prompt === prompt) return true;
    const result = await global.orkas.invoke('videoCanvas.draft', {
      cid: target.cid,
      dir: target.dir,
      change: { kind: 'update', id, prompt },
    }).catch(() => null);
    if (!result || result.ok === false) {
      _log.warn('new shot words not saved', { code: String((result && result.code) || 'failed') });
      return false;
    }
    // What was read last catches up without reading again.
    const current = _acceptsTarget(target) ? _cardOf(`draft:${id}`) : null;
    if (current) current.prompt = prompt;
    return true;
  }

  /** A new shot made from a card, where it was asked for, selected with its words in focus. */
  async function _createDraft(type, source, at, target = _target()) {
    if (!_acceptsTarget(target) || _readOnly()) return;
    const result = await global.orkas.invoke('videoCanvas.draft', {
      cid: target.cid,
      dir: target.dir,
      change: { kind: 'create', type, inputs: source ? [source.asset_id] : [], at },
    }).catch(() => null);
    if (!_acceptsTarget(target)) return;
    if (!result || result.ok === false) {
      uiToast(_refusalMessage(result), { variant: 'warning', timeoutMs: 6000 });
      return;
    }
    _selected = `draft:${result.id}`;
    _revealDraft = _selected;
    await refresh();
    if (!_acceptsTarget(target)) return;
    const cardEl = _world()?.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(_selected)}"]`);
    const panel = _mountedTakePanel();
    if (cardEl) _reveal(cardEl);
    if (panel && !panel.hidden) _reveal(panel);
    const field = panel && panel.querySelector('textarea[data-commit="draft"]');
    if (field && !field.readOnly) field.focus({ preventScroll: true });
  }

  /** What to make from a card: a video shot, or an image from an image. */
  function _newShotMenu(event, card, at) {
    const target = _target();
    const source = _inputOfCard(card);
    showContextMenu(event, [
      { label: t('video_canvas.new_shot.video'), icon: 'film', onClick: () => (_acceptsTarget(target) ? _createDraft('video', source, at, target) : undefined) },
      {
        label: t('video_canvas.new_shot.image'),
        icon: 'image',
        disabled: source.kind !== 'image',
        onClick: () => (_acceptsTarget(target) ? _createDraft('image', source, at, target) : undefined),
      },
    ]);
  }

  /** No generation was sent for a draft yet, so it goes without asking. */
  async function _removeDraft(card, target = _target()) {
    if (!_acceptsTarget(target)) return;
    const result = await global.orkas.invoke('videoCanvas.draft', { cid: target.cid, dir: target.dir, change: { kind: 'remove', id: card.id } }).catch(() => null);
    if (!_acceptsTarget(target)) return;
    if (!result || result.ok === false) uiToast(_refusalMessage(result), { variant: 'warning', timeoutMs: 6000 });
    if (_selected === card.key) _selected = '';
    _drafts.delete(`draft-prompt:${target.dir}|${card.id}`);
    await refresh();
  }

  async function _quoteDraftFor(draft, choiceId, target = _target(), fresh = false) {
    if (!_acceptsTarget(target)) return null;
    const key = `${_draftOptionsKey(draft, target.dir)}|${choiceId || ''}`;
    if (!fresh && _quoting.has(key)) return null;
    _quoting.add(key);
    try {
      const quote = await global.orkas.invoke('videoCanvas.quoteDraft', { cid: target.cid, dir: target.dir, id: draft.id }).catch(() => null);
      if (!_acceptsTarget(target)) return null;
      _quotes.set(key, quote || { ok: false, code: 'quote_failed' });
      _renderTakePanel();
      return quote;
    } finally {
      _quoting.delete(key);
    }
  }

  function _newShotConfirmMessage() {
    return t('video_canvas.new_shot.confirm_own_key');
  }

  /** Make the new shot the panel shows, after its words are saved and the request confirmed. */
  async function _generateDraft(draft) {
    const target = _target();
    // A second click while this one is being checked or confirmed would be a duplicate request.
    const key = `${target.cid}|${target.dir}|${draft.key}`;
    if (_takeAsking.has(key)) return;
    _takeAsking.set(key, 'checking');
    _renderTakePanel();
    try {
      const field = _takePanel()?.querySelector('textarea[data-commit="draft"]');
      const prompt = field ? field.value : draft.prompt;
      if (!String(prompt).trim()) {
        uiToast(t('video_canvas.take.prompt_empty'), { variant: 'warning' });
        return;
      }
      if (field && !await _saveDraftPrompt(field, target)) {
        uiToast(t('video_canvas.error.failed'), { variant: 'warning' });
        return;
      }
      const quote = await _quoteDraftFor(draft, _draftChoiceOf(draft), target, true);
      if (!_acceptsTarget(target)) return;
      if (!quote || quote.ok === false) {
        uiToast(_refusalMessage(quote), { variant: 'warning' });
        return;
      }
      if (!quote.sufficient) {
        uiToast(t('video_canvas.error.route_unavailable'), { variant: 'warning', timeoutMs: 8000 });
        return;
      }
      const confirmed = await uiConfirm({
        message: _newShotConfirmMessage(quote),
        okLabel: t('video_canvas.take.generate'),
      });
      if (!confirmed || !_acceptsTarget(target)) return;
      _takeAsking.set(key, 'submitting');
      _renderTakePanel();
      const result = await global.orkas.invoke('videoCanvas.generateDraft', { cid: target.cid, dir: target.dir, id: draft.id }).catch(() => null);
      if (!_acceptsTarget(target)) return;
      if (!result || result.ok === false) {
        const message = _refusalMessage(result);
        uiToast(message, { variant: 'warning', timeoutMs: 8000 });
      }
    } finally {
      _takeAsking.delete(key);
      if (_acceptsTarget(target)) {
        _renderTakePanel();
        _refocusGenerate();
      }
    }
  }

  async function _useTake(assetId, target = _target()) {
    if (await _edit({ kind: 'use_result', asset: assetId }, target)) {
      uiToast(t('video_canvas.take.used'), { variant: 'info', timeoutMs: 6000 });
    }
  }

  async function _saveVersion(card) {
    const version = VM.versionToShow(card.versions, _pickedVersion.get(`${_dir}|${card.key}`));
    if (!version) return;
    const result = await global.orkas.invoke('videoCanvas.saveCopy', {
      cid: _cid,
      dir: _dir,
      file: version.media_path,
      name: card.label,
    }).catch(() => null);
    if (result && result.ok) uiToast(t('video_canvas.saved'), { variant: 'success' });
    else if (!result || !result.cancelled) uiToast(t('video_canvas.error.failed'), { variant: 'warning' });
  }

  async function _importFiles(files, target = _target()) {
    if (!_acceptsTarget(target)) return [];
    if (!files.length) return [];
    if (typeof global.orkas.importLocalFiles !== 'function') return [];
    _importing += 1;
    _renderHeader();
    const imported = await global.orkas.importLocalFiles('video_canvas', files, { cid: target.cid, targetDir: target.dir }).catch(() => null);
    _importing -= 1;
    if (!_acceptsTarget(target)) return [];
    _renderHeader();
    const results = (imported && imported.files) || [];
    const failed = results.filter((item) => !item.ok);
    if (imported && imported.ok === false) uiToast(t('video_canvas.error.failed'), { variant: 'warning' });
    else if (failed.length) {
      const busy = failed.some((item) => item.reason === 'busy');
      uiToast(busy ? t('video_canvas.error.busy') : t('video_canvas.import_skipped', { n: failed.length }), { variant: 'warning', timeoutMs: 6000 });
    }
    return results.filter((item) => item.ok).map((item) => item.asset_id);
  }

  function _pickFiles(multiple) {
    return new Promise((resolve) => {
      const input = _el('video-canvas-file');
      if (!input) { resolve([]); return; }
      input.value = '';
      input.multiple = !!multiple;
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  function _anchorEvent(button) {
    const rect = button.getBoundingClientRect();
    return { clientX: rect.left, clientY: rect.bottom + 4 };
  }

  function _sceneFromTarget(target) {
    const card = _cardOf(`video:${target.dataset.video}`);
    if (!card) return null;
    const index = card.scenes.findIndex((scene) => scene.id === target.dataset.scene);
    return index < 0 ? null : { card, scene: card.scenes[index], position: index + 1 };
  }

  function _openMedia(path) {
    if (!path || typeof openChatFileViewer !== 'function') return;
    openChatFileViewer(path, undefined, { cid: _cid, autoplay: true });
  }

  function _markMenuOpen(button) {
    const card = button.closest('.video-canvas-card');
    if (!card) return;
    card.classList.add('is-menu-open');
    const clear = () => {
      card.classList.remove('is-menu-open');
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('keydown', clear, true);
    };
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('keydown', clear, true);
  }

  function _pictureMenuItems(onPick) {
    return _pictureCards().map((card) => ({
      label: card.label,
      icon: card.results ? 'sparkles' : (card.kind === 'video' ? 'film' : 'image'),
      onClick: () => onPick(_assetIdOfCard(card)),
    }));
  }

  async function _replaceAsset(assetId, target = _target()) {
    if (!_acceptsTarget(target)) return;
    // Said before a file is picked, so nothing is imported for a swap that cannot happen.
    if (VM.placedByPage(_production(), assetId)) {
      uiToast(t('video_canvas.error.page_picture'), { variant: 'warning', timeoutMs: 6000 });
      return;
    }
    const files = await _pickFiles(false);
    const [next] = await _importFiles(files, target);
    if (next && next !== assetId) await _edit({ kind: 'replace_asset', asset: assetId, with: next }, target);
    else if (next) await refresh();
  }

  function _cardMenuItems(card, anchor) {
    const target = _target();
    const scoped = (items) => items.map(item => ({ ...item, onClick: () => _acceptsTarget(target) ? item.onClick() : undefined }));
    const readOnly = _readOnly();
    if (card.key === VM.PRODUCT_CARD_KEY) return scoped([{ label: t('video_canvas.say_to_agent'), onClick: () => _sayAboutCard(card) }]);
    if (card.key.startsWith('draft:')) {
      const job = _draftJob(card.key);
      return scoped([{
        label: t('common.delete'),
        danger: true,
        disabled: readOnly || !!(job && job.status === 'running'),
        onClick: () => _removeDraft(card, target),
      }]);
    }
    if (card.versions) {
      const items = [];
      if (card.id) {
        items.push({ label: t('video_canvas.another_version'), onClick: () => _askAnotherVersion(card) });
      }
      items.push({ label: t('video_canvas.say_to_agent'), onClick: () => _sayAboutCard(card) });
      return scoped(items);
    }
    const assetId = _assetIdOfCard(card);
    const mediaPath = card.results ? _shotCurrent(card).media_path : card.media_path;
    const cardEl = _world()?.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(card.key)}"]`);
    return scoped([
      { label: t('video_canvas.preview'), onClick: () => _openMedia(mediaPath) },
      // The keyboard's way to the "+" beside a selected card (decided 2026-11-10).
      {
        label: t('video_canvas.new_shot.from'),
        disabled: readOnly || !cardEl,
        onClick: () => _newShotMenu(anchor, card, _besideCard(cardEl)),
      },
      { label: t('video_canvas.replace'), disabled: readOnly, onClick: () => _replaceAsset(assetId, target) },
      { label: t('video_canvas.say_to_agent'), onClick: () => _sayAboutCard(card) },
      {
        label: t('common.delete'),
        danger: true,
        disabled: readOnly,
        onClick: async () => {
          // This row leads back to the generated result.
          if (card.results && !await uiConfirmDanger({
            message: t('video_canvas.delete_result_confirm'),
            dangerLabel: t('common.delete'),
            cancelLabel: t('common.cancel'),
          })) return;
          await _edit({ kind: 'remove_asset', asset: assetId }, target);
        },
      },
    ]);
  }

  /** Where a new shot made from a card goes: right of it, clear of every card on the board. */
  function _besideCard(cardEl) {
    if (!cardEl) return { x: 0, y: 0 };
    const rect = (el) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    const cards = [...(_world()?.querySelectorAll(':scope > .video-canvas-card') || [])].map(rect);
    return VM.newShotSpot(rect(cardEl), cards);
  }

  /** What the shot in the panel can still take: pictures on the canvas, images only for a still
   *  or frames. */
  function _offerInputs(button) {
    const scope = _target();
    const draft = _selectedDraft();
    const card = draft ? null : _selectedShot();
    let imagesOnly = false;
    let exclude = [];
    let pick = null;
    if (draft) {
      imagesOnly = draft.kind === 'image' || draft.method === 'frames';
      exclude = draft.inputs.map((input) => input.card);
      pick = (assetId) => _saveDraft(draft, { inputs: [...draft.inputs.map((input) => input.asset_id), assetId] }, scope);
    } else if (card) {
      const take = _shotCurrent(card);
      const method = _takeMethodOf(take);
      const pending = _takeInputs.get(_takeKey(take));
      imagesOnly = take.kind === 'image' || method === 'frames';
      exclude = [card.key, ...VM.takeInputs(_production(), take, method, pending ? pending.added : []).map((input) => input.card.key)];
      pick = (assetId) => _addTakeInput(take, assetId, scope);
    } else return;
    const items = VM.inputCandidates(_pictureCards().map(_inputOfCard), { imagesOnly, exclude }).map((input) => ({
      label: input.label,
      icon: input.key.startsWith('shot:') ? 'sparkles' : (input.kind === 'video' ? 'film' : 'image'),
      onClick: () => (_acceptsTarget(scope) ? pick(input.asset_id) : undefined),
    }));
    showContextMenu(_anchorEvent(button), items.length ? items : [{ label: t('video_canvas.take.nothing_to_add'), disabled: true, onClick: () => {} }]);
  }

  const _actions = {
    'card-menu': (target) => {
      const card = _cardOf(target.dataset.card);
      if (!card) return;
      _markMenuOpen(target);
      showContextMenu(_anchorEvent(target), _cardMenuItems(card, _anchorEvent(target)));
    },
    'link-new': (target) => {
      const card = _cardOf(target.dataset.card);
      const cardEl = target.closest('.video-canvas-card');
      if (!card || !cardEl || _readOnly()) return;
      _newShotMenu(_anchorEvent(target), card, _besideCard(cardEl));
    },
    'input-add': (target) => _offerInputs(target),
    'input-remove': (target) => {
      const assetId = target.dataset.asset;
      const draft = _selectedDraft();
      if (draft) return _saveDraft(draft, { inputs: draft.inputs.map((input) => input.asset_id).filter((id) => id !== assetId) });
      const card = _selectedShot();
      if (card) _removeTakeInput(_shotCurrent(card), assetId);
      return undefined;
    },
    'draft-generate': (target) => {
      const draft = _selectedDraft();
      return draft && draft.id === target.dataset.draft ? _generateDraft(draft) : undefined;
    },
    'shot-page': (target) => {
      const card = _cardOf(target.dataset.card);
      if (!card) return;
      const current = card.results.indexOf(_shotCurrent(card));
      _shotResult.set(`${_dir}|${card.key}`, current + Number(target.dataset.delta));
      _render();
    },
    render: (target) => _updateVideo(target.dataset.video),
    'fix-with-agent': (target) => {
      const card = _cardOf(`video:${target.dataset.video}`);
      if (!card) return;
      const job = _videoJob(card);
      _prefillComposer({ full: t('video_canvas.fix_text', { name: card.label, code: (job && job.code) || '' }), production: card.label });
    },
    'version-save': (target) => {
      const card = _cardOf(target.dataset.video);
      if (card) _saveVersion(card);
    },
    'scene-open': (target) => {
      const found = _sceneFromTarget(target);
      if (!found) return;
      const key = `${_dir}|${found.card.key}`;
      if (_openScene.get(key) === found.scene.id) _openScene.delete(key);
      else _openScene.set(key, found.scene.id);
      _render();
    },
    'scene-move': (target) => {
      const found = _sceneFromTarget(target);
      if (!found) return undefined;
      const order = VM.moveInOrder(found.card.scenes.map((scene) => scene.id), found.scene.id, Number(target.dataset.delta));
      return order ? _edit({ kind: 'reorder', video: found.card.id, order }) : undefined;
    },
    'scene-remove': (target) => {
      const found = _sceneFromTarget(target);
      return found ? _edit({ kind: 'remove_scene', video: found.card.id, scene: found.scene.id }) : undefined;
    },
    'scene-swap': (target) => {
      const scope = _target();
      const found = _sceneFromTarget(target);
      if (!found) return;
      const items = _pictureMenuItems((asset) => _edit({ kind: 'swap_clip', video: found.card.id, scene: found.scene.id, asset }, scope));
      items.push({
        label: t('video_canvas.from_file'),
        icon: 'folder-open',
        onClick: async () => {
          const [asset] = await _importFiles(await _pickFiles(false), scope);
          if (asset) await _edit({ kind: 'swap_clip', video: found.card.id, scene: found.scene.id, asset }, scope);
        },
      });
      showContextMenu(_anchorEvent(target), items);
    },
    'scene-add': (target) => {
      const scope = _target();
      const card = _cardOf(`video:${target.dataset.video}`);
      if (!card) return;
      // Scenes taken out here come first, to go back as they were (decided 2026-11-11).
      const putBack = (card.removed_scenes || []).map((removed) => ({
        label: [t('video_canvas.put_back', { n: removed.position, seconds: VM.formatSeconds(removed.duration_sec) }), removed.words].filter(Boolean).join(' · '),
        icon: 'undo',
        onClick: () => _edit({ kind: 'restore_scene', video: card.id, removed: removed.key }, scope),
      }));
      const items = [...putBack, ..._pictureMenuItems((asset) => _edit({ kind: 'add_scene', video: card.id, asset }, scope))];
      items.push({
        label: t('video_canvas.from_file'),
        icon: 'folder-open',
        onClick: async () => {
          const [asset] = await _importFiles(await _pickFiles(false), scope);
          if (asset) await _edit({ kind: 'add_scene', video: card.id, asset }, scope);
        },
      });
      showContextMenu(_anchorEvent(target), items);
    },
    'scene-regenerate': (target) => {
      const found = _sceneFromTarget(target);
      if (found) _showTake(found.scene.source, found.scene.asset_id);
    },
    'take-ref': (target) => {
      const cardEl = _world()?.querySelector(`:scope > .video-canvas-card[data-card="${CSS.escape(target.dataset.card)}"]`);
      if (!cardEl) return;
      _selected = target.dataset.card;
      _drawLines();
      _renderTakePanel();
      _reveal(cardEl);
    },
    'take-use': (target) => _useTake(target.dataset.asset),
    'gen-settings': () => _toggleSettings(),
    'take-generate': (target) => {
      const card = _selectedShot();
      const take = card ? _shotCurrent(card) : null;
      return take && take.asset_id === target.dataset.asset ? _regenerate(card, take) : undefined;
    },
    'scene-say': (target) => {
      const found = _sceneFromTarget(target);
      if (found) _sayAboutScene(found.card, found.scene, found.position);
    },
    template: (target) => _prefillComposer({ full: t(`video_canvas.template.${target.dataset.template}_text`) }),
  };

  function _onClick(event) {
    if (_suppressClick) {
      _suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (button && !button.disabled) {
      const action = _actions[button.dataset.action];
      if (action) {
        Promise.resolve(action(button)).catch((err) => {
          _log.warn('canvas action failed', { action: button.dataset.action, error_type: err && err.name ? String(err.name) : typeof err });
          uiToast(t('video_canvas.error.failed'), { variant: 'warning' });
        });
      }
      return;
    }
    const card = event.target.closest('.video-canvas-card');
    if (card) {
      if (!event.target.closest(NOT_A_CARD_DRAG)) {
        _selected = card.dataset.card;
        _drawLines();
        _renderTakePanel();
      }
      return;
    }
    if (!event.target.closest('.video-canvas-zoom, .video-canvas-empty, .video-canvas-take-panel') && _selected) {
      _selected = '';
      _drawLines();
      _renderTakePanel();
    }
  }

  /** Pan just enough that a card, or the shot panel on the board above the world, is in view. */
  function _reveal(cardEl) {
    const viewport = _viewport();
    const view = _view();
    const pad = 16;
    const inWorld = cardEl.parentElement === _world();
    const scale = inWorld ? view.zoom : 1;
    const left = (inWorld ? view.x : 0) + cardEl.offsetLeft * scale;
    const top = (inWorld ? view.y : 0) + cardEl.offsetTop * scale;
    const right = left + cardEl.offsetWidth * scale;
    const bottom = top + cardEl.offsetHeight * scale;
    // Above the zoom controls and the hint on the board's bottom edge, which would cover it.
    const floor = Math.min(viewport.clientHeight - pad, ...['video-canvas-zoom', 'video-canvas-board-hint']
      .map((id) => _el(id))
      .filter((el) => el && !el.hidden && el.parentElement === viewport)
      .map((el) => el.offsetTop - 8));
    let { x, y } = view;
    if (left < pad) x += pad - left;
    else if (right > viewport.clientWidth - pad) x -= Math.min(right - (viewport.clientWidth - pad), left - pad);
    if (top < pad) y += pad - top;
    else if (bottom > floor) y -= Math.min(bottom - floor, top - pad);
    if (x !== view.x || y !== view.y) _setView({ ...view, x, y }, true);
  }

  function _onDoubleClick(event) {
    const media = event.target.closest('[data-open-media]');
    if (media) _openMedia(media.dataset.openMedia);
  }

  /** A field's words go to the file when the user leaves it. */
  function _commit(field) {
    // A shot's words go with the request that uses them, not to a file.
    if (!field.dataset.commit) return;
    // A new shot's are its own, saved as typed.
    if (field.dataset.commit === 'draft') {
      _saveDraftPrompt(field);
      return;
    }
    const target = _fieldTargets.get(field);
    if (!_acceptsTarget(target)) return;
    const key = field.dataset.draftKey;
    const value = field.value;
    if (value === field.dataset.original) {
      _drafts.delete(key);
      return;
    }
    _drafts.delete(key);
    const edit = field.dataset.commit === 'fact'
      ? { kind: 'set_fact', fact: field.dataset.fact, text: value }
      : field.dataset.commit === 'narration'
        ? { kind: 'set_narration', video: field.dataset.video, scene: field.dataset.scene, value }
        : { kind: 'set_text', video: field.dataset.video, scene: field.dataset.scene, slot: field.dataset.slot, value };
    _edit(edit, target).then((ok) => {
      // Refused, so the field goes back to what is saved.
      if (!ok && field.isConnected) field.value = field.dataset.original;
    });
  }

  // ── Pointer: pan, zoom, move cards, reorder scenes ───────────────────

  /** Follow a press until release. Capture starts only once it is a drag, so a press that
   *  stays put is still an ordinary click on what is under it. */
  function _trackDrag(event, threshold, handlers) {
    const target = _target();
    const viewport = _viewport();
    const startX = event.clientX;
    const startY = event.clientY;
    const { pointerId } = event;
    let dragging = false;
    const onMove = (move) => {
      if (move.pointerId !== pointerId || !_acceptsTarget(target)) return;
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < threshold) return;
        dragging = true;
        try { viewport.setPointerCapture(pointerId); } catch (_) { /* the press already ended */ }
        handlers.start();
      }
      handlers.move(dx, dy, move);
    };
    const finish = (up) => {
      if (up.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (!dragging || !_acceptsTarget(target)) return;
      _suppressClick = true;
      // A drag that ends over nothing clickable fires no click to swallow.
      setTimeout(() => { _suppressClick = false; }, 0);
      handlers.end(up);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function _startPan(event) {
    const origin = _view();
    _trackDrag(event, DRAG_THRESHOLD_PX, {
      start: () => { _viewport().classList.add('is-panning'); },
      move: (dx, dy) => _setView({ ...origin, x: origin.x + dx, y: origin.y + dy }),
      end: () => { _viewport().classList.remove('is-panning'); },
    });
  }

  function _dropTargetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    return hit ? hit.closest('.video-canvas-chip') : null;
  }

  function _startCardDrag(event, cardEl) {
    const key = cardEl.dataset.card;
    const origin = { x: cardEl.offsetLeft, y: cardEl.offsetTop };
    // Only a picture can go into a scene, and a new shot has none yet.
    const droppable = cardEl.dataset.column !== 'video' && key !== VM.PRODUCT_CARD_KEY && !key.startsWith('draft:') && !_readOnly();
    let target = null;
    const setTarget = (next) => {
      if (target === next) return;
      if (target) target.classList.remove('is-drop-target');
      target = next;
      if (target) target.classList.add('is-drop-target');
    };
    _trackDrag(event, DRAG_THRESHOLD_PX, {
      start: () => { cardEl.classList.add('is-dragging'); },
      move: (dx, dy, move) => {
        const { zoom } = _view();
        cardEl.style.left = `${origin.x + dx / zoom}px`;
        cardEl.style.top = `${origin.y + dy / zoom}px`;
        _drawLines();
        if (droppable) setTarget(_dropTargetAt(move.clientX, move.clientY));
      },
      end: async (up) => {
        const { zoom } = _view();
        const dropped = droppable ? _dropTargetAt(up.clientX, up.clientY) : null;
        setTarget(null);
        cardEl.classList.remove('is-dragging');
        const production = _production();
        if (dropped && production) {
          // A drop is a change to the video. The card goes back where it was.
          cardEl.style.left = `${origin.x}px`;
          cardEl.style.top = `${origin.y}px`;
          _drawLines();
          const asset = _assetIdOfCard(_cardOf(key));
          if (dropped.dataset.scene) await _edit({ kind: 'swap_clip', video: dropped.dataset.video, scene: dropped.dataset.scene, asset });
          else if (dropped.dataset.video) await _edit({ kind: 'add_scene', video: dropped.dataset.video, asset });
          return;
        }
        if (!production) return;
        production.layout = {
          ...production.layout,
          [key]: { x: Math.round(origin.x + (up.clientX - event.clientX) / zoom), y: Math.round(origin.y + (up.clientY - event.clientY) / zoom) },
        };
        _layout();
        await _saveLayout();
      },
    });
  }

  /** A shot that can take a dragged picture as an input: a new shot, or a take that can be made again. */
  function _inputTargetOf(key) {
    const card = _cardOf(key);
    if (!card) return null;
    if (key.startsWith('draft:')) {
      if (_takeAsking.has(`${_cid}|${_dir}|${key}`)) return null;
      return { key, imagesOnly: card.kind === 'image', cards: card.inputs.map((input) => input.card) };
    }
    if (!card.results) return null;
    const take = _shotCurrent(card);
    if (!take.redoable || _takeAsking.has(`${_cid}|${_takeKey(take)}`)) return null;
    const pending = _takeInputs.get(_takeKey(take));
    const inputs = VM.takeInputs(_production(), take, _takeMethodOf(take), pending ? pending.added : []);
    return { key, imagesOnly: take.kind === 'image', cards: inputs.map((input) => input.card.key) };
  }

  function _linkTargetAt(x, y, source) {
    const hit = document.elementFromPoint(x, y);
    const cardEl = hit && hit.closest('.video-canvas-card');
    return cardEl && VM.acceptsInput(_inputTargetOf(cardEl.dataset.card), source) ? cardEl : null;
  }

  /** Open board, where a line can end in a new shot. */
  function _onOpenBoard(x, y) {
    const hit = document.elementFromPoint(x, y);
    return !!hit && _viewport().contains(hit)
      && !hit.closest('.video-canvas-card, .video-canvas-take-panel, .video-canvas-zoom, .video-canvas-empty');
  }

  function _worldPoint(clientX, clientY) {
    const rect = _viewport().getBoundingClientRect();
    const view = _view();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  }

  function _drawPendingLink(from, to) {
    const svg = _el('video-canvas-lines');
    if (!svg) return;
    let line = svg.querySelector('path.is-pending');
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('class', 'is-pending');
      svg.appendChild(line);
    }
    line.setAttribute('d', VM.linkPath(from.x, from.y, to.x, to.y));
  }

  /** A line from a card's "+" (decided 2026-11-10): released on a shot, the card's picture joins
   *  that shot's inputs; on open board, a new shot made from it goes there. */
  function _startLinkDrag(event, handle) {
    const cardEl = handle.closest('.video-canvas-card');
    const card = cardEl && _cardOf(cardEl.dataset.card);
    if (!card || _readOnly()) return;
    const source = _inputOfCard(card);
    const from = { x: cardEl.offsetLeft + cardEl.offsetWidth, y: cardEl.offsetTop + cardEl.offsetHeight / 2 };
    let target = null;
    const setTarget = (next) => {
      if (target === next) return;
      if (target) target.classList.remove('is-drop-target');
      target = next;
      if (target) target.classList.add('is-drop-target');
    };
    const finish = () => {
      setTarget(null);
      _el('video-canvas-lines')?.querySelector('path.is-pending')?.remove();
      _viewport().classList.remove('is-linking');
    };
    _trackDrag(event, DRAG_THRESHOLD_PX, {
      start: () => { _viewport().classList.add('is-linking'); },
      move: (_dx, _dy, move) => {
        _drawPendingLink(from, _worldPoint(move.clientX, move.clientY));
        setTarget(_linkTargetAt(move.clientX, move.clientY, source));
      },
      end: (up) => {
        const dropped = _linkTargetAt(up.clientX, up.clientY, source);
        const open = !dropped && _onOpenBoard(up.clientX, up.clientY);
        finish();
        if (dropped) {
          _addInputTo(dropped.dataset.card, source);
          return;
        }
        if (!open) return;
        const at = _worldPoint(up.clientX, up.clientY);
        _newShotMenu({ clientX: up.clientX, clientY: up.clientY }, card, { x: Math.round(at.x), y: Math.round(at.y - DEFAULT_DRAFT_OFFSET_Y) });
      },
    });
  }

  /** The new shot's card hangs from where the line ended, as a node does from its link. */
  const DEFAULT_DRAFT_OFFSET_Y = 40;

  /** A dropped picture joins the shot it was dropped on, and that shot opens to show it. */
  function _addInputTo(key, source) {
    const card = _cardOf(key);
    if (!card) return;
    _selected = key;
    if (key.startsWith('draft:')) {
      _drawLines();
      _saveDraft(card, { inputs: [...card.inputs.map((input) => input.asset_id), source.asset_id] });
      return;
    }
    _drawLines();
    _addTakeInput(_shotCurrent(card), source.asset_id);
  }

  function _startChipDrag(event, chip) {
    const bar = chip.closest('.video-canvas-bar');
    if (!bar || _readOnly()) return;
    const video = chip.dataset.video;
    const before = [...bar.querySelectorAll('.video-canvas-chip[data-scene]')].map((node) => node.dataset.scene);
    if (before.length < 2) return;
    _trackDrag(event, DRAG_THRESHOLD_PX + 2, {
      start: () => { chip.classList.add('is-dragging'); },
      move: (_dx, _dy, move) => {
        const others = [...bar.querySelectorAll('.video-canvas-chip[data-scene]')].filter((node) => node !== chip);
        const index = VM.dropIndex(others.map((node) => node.getBoundingClientRect()), move.clientX, move.clientY);
        bar.insertBefore(chip, others[index] || bar.querySelector('.video-canvas-chip.is-add'));
      },
      end: async () => {
        chip.classList.remove('is-dragging');
        const after = [...bar.querySelectorAll('.video-canvas-chip[data-scene]')].map((node) => node.dataset.scene);
        if (after.join('\n') !== before.join('\n')) await _edit({ kind: 'reorder', video, order: after });
      },
    });
  }

  function _onPointerDown(event) {
    if (event.button !== 0) return;
    _closeFloating();
    const { target } = event;
    if (target.closest('.video-canvas-zoom, .video-canvas-empty')) return;
    const chip = target.closest('.video-canvas-chip[data-scene]');
    if (chip) {
      _startChipDrag(event, chip);
      return;
    }
    const handle = target.closest('.video-canvas-connector');
    if (handle) {
      _startLinkDrag(event, handle);
      return;
    }
    if (target.closest(NOT_A_CARD_DRAG) || target.closest('.video-canvas-take-panel')) return;
    const card = target.closest('.video-canvas-card');
    if (card) {
      _startCardDrag(event, card);
      return;
    }
    _viewport().focus({ preventScroll: true });
    _startPan(event);
  }

  function _onWheel(event) {
    // The prompt scrolls its own words.
    if (event.target.closest('.video-canvas-empty, .video-canvas-take-panel textarea')) return;
    event.preventDefault();
    _closeFloating();
    const view = _view();
    const rect = _viewport().getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      _setView(VM.zoomAround(view, view.zoom * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top));
    } else {
      _setView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
    }
  }

  function _zoomBy(factor) {
    const viewport = _viewport();
    const view = _view();
    _setView(VM.zoomAround(view, view.zoom * factor, viewport.clientWidth / 2, viewport.clientHeight / 2));
  }

  function _onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const field = event.target.closest('[data-draft-key]');
    if (field) {
      // A prompt takes new lines; a one-line field saves on Enter.
      if (event.key === 'Enter' && field.tagName !== 'TEXTAREA') {
        event.preventDefault();
        field.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        // A new shot's words are saved as typed, so leaving keeps them.
        if (field.dataset.commit !== 'draft') {
          field.value = field.dataset.original;
          _drafts.delete(field.dataset.draftKey);
          _takePromptEdited(field);
        }
        field.blur();
      }
      return;
    }
    // Escape closes the innermost thing open: a menu in the panel or its settings take it first.
    if (event.key === 'Escape' && !event.defaultPrevented && _closeSettings(true)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && _selected && !event.defaultPrevented) {
      _selected = '';
      _drawLines();
      _renderTakePanel();
      return;
    }
    if (event.target !== _viewport()) return;
    const view = _view();
    if (event.key === 'ArrowLeft') _setView({ ...view, x: view.x + KEY_PAN_PX });
    else if (event.key === 'ArrowRight') _setView({ ...view, x: view.x - KEY_PAN_PX });
    else if (event.key === 'ArrowUp') _setView({ ...view, y: view.y + KEY_PAN_PX });
    else if (event.key === 'ArrowDown') _setView({ ...view, y: view.y - KEY_PAN_PX });
    else if (event.key === '+' || event.key === '=') _zoomBy(ZOOM_STEP);
    else if (event.key === '-') _zoomBy(1 / ZOOM_STEP);
    else if (event.key === '0') _fit();
    else return;
    event.preventDefault();
  }

  function _onInput(event) {
    const field = event.target.closest('[data-draft-key]');
    if (!field) return;
    _drafts.set(field.dataset.draftKey, field.value);
    if (field.dataset.commit === 'draft') _scheduleDraftPrompt(field);
    else _takePromptEdited(field);
  }

  /** A take's Generate waits for its words to differ from the take's, so it follows each edit. */
  function _takePromptEdited(field) {
    if (field.dataset.draftKey.startsWith('prompt:')) _renderTakePanel();
  }

  function _onFocusOut(event) {
    // Being replaced by a refresh is not the user leaving the field.
    if (_patching) return;
    const field = event.target.closest('[data-draft-key]');
    if (field && !field.disabled) _commit(field);
  }

  function _onCardKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList && event.target.classList.contains('video-canvas-card')) {
      event.preventDefault();
      _selected = event.target.dataset.card;
      _drawLines();
      _renderTakePanel();
    }
  }

  // ── Files and links ──────────────────────────────────────────────────

  const _hasFiles = (event) => !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');

  function _onDragOver(event) {
    if (!_hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    _viewport().classList.add('is-file-over');
  }

  function _onDragLeave(event) {
    if (!_viewport().contains(event.relatedTarget)) _viewport().classList.remove('is-file-over');
  }

  async function _onDrop(event) {
    if (!_hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    _viewport().classList.remove('is-file-over');
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    if (!_production()) {
      // Nothing to add them to yet: they go with the message that starts one.
      if (typeof _chatAttachUpload === 'function') await _chatAttachUpload(_cid, event.dataTransfer.files, 'drop');
      return;
    }
    await _importFiles(files);
    await refresh();
  }

  /** A right-click on open board adds footage from the computer, as a drop would, or asks for
   *  another version of a video (decided 2026-11-11). Cards and the shot panel, with their
   *  fields, keep their own right-click. */
  function _onContextMenu(event) {
    if (!_production()) return;
    if (event.target.closest('.video-canvas-card, .video-canvas-take-panel, .video-canvas-zoom, .video-canvas-empty')) return;
    event.preventDefault();
    _closeFloating();
    const target = _target();
    // Another version of each video, as its card's menu asks it (decided 2026-11-11). It only
    // fills the composer, so it stays while an Agent works.
    const videos = (_production().videos || []).filter((video) => video.id);
    showContextMenu(event, [{
      label: t('video_canvas.upload_footage'),
      icon: 'folder-open',
      disabled: _readOnly(),
      onClick: async () => {
        const files = await _pickFiles(true);
        if (!files.length || !_acceptsTarget(target)) return;
        await _importFiles(files, target);
        if (_acceptsTarget(target)) await refresh();
      },
    }, ...videos.map((video) => ({
      label: videos.length === 1 ? t('video_canvas.another_version_video') : t('video_canvas.another_version_of', { name: video.label }),
      icon: 'film',
      onClick: () => (_acceptsTarget(target) ? _askAnotherVersion(video) : undefined),
    }))]);
  }

  function _onPaste(event) {
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
    const data = event.clipboardData;
    if (!data) return;
    if (data.files && data.files.length) {
      event.preventDefault();
      if (_production()) _importFiles([...data.files]).then(refresh);
      else if (typeof _chatAttachUpload === 'function') _chatAttachUpload(_cid, data.files, 'paste');
      return;
    }
    const url = VM.pastedUrl(data.getData('text/plain'));
    if (url) {
      event.preventDefault();
      _prefillComposer({ full: t('video_canvas.paste_link_text', { url }) });
    }
  }

  // ── Jobs ─────────────────────────────────────────────────────────────

  function _onJobEvent(event) {
    if (!event || !event.kind) return;
    const key = VM.jobKey(event);
    if (event.status === 'stopped') {
      // A change made this update pointless. It has no outcome, and the next one starts afresh.
      if (event.cid !== _cid) return;
      _jobs.delete(key);
      if (_isOpen()) _render();
      return;
    }
    if ((event.kind === 'redo' || event.kind === 'new_shot') && event.status === 'done') {
      if (event.own_key) uiToast(t('video_canvas.redo_own_key_done'), { variant: 'info', timeoutMs: 8000 });
      uiToast(t(event.swapped ? 'video_canvas.take.done_swapped' : 'video_canvas.take.done_kept'), { variant: 'info', timeoutMs: 8000 });
    }
    if (event.cid !== _cid) return;
    if (event.status === 'done') {
      _jobs.delete(key);
      if (!_isOpen() && event.kind === 'render') uiToast(t('video_canvas.updated'), { variant: 'success' });
      if (event.kind === 'redo') {
        _quotes.clear();
        // The shot card turns to its newest take: the one just made.
        if (event.shot) _shotResult.delete(`${event.dir}|${event.shot}`);
      }
      if (event.kind === 'new_shot' && event.shot) {
        // The shot card takes the new shot's place, and its selection.
        const id = event.shot.slice('draft:'.length);
        if (event.dir === _dir && _selected === event.shot) _selected = `shot:${id}`;
        _drafts.delete(`draft-prompt:${event.dir}|${id}`);
        _quotes.clear();
      }
      refresh();
      return;
    }
    _jobs.set(key, { ...event });
    if (event.status === 'failed' && !_isOpen()) uiToast(t('video_canvas.status.failed'), { variant: 'warning', timeoutMs: 8000 });
    if (_isOpen()) _render();
  }

  // ── Open, close, conversation changes ────────────────────────────────

  function _setOpen(open) {
    const panel = _panel();
    const toggle = _el('video-canvas-toggle');
    if (!panel) return;
    if (open) global.ConversationInfo?.close();
    else _resize?.finish();
    panel.hidden = !open;
    if (open) {
      _hasUnseenChanges = false;
      _resize?.apply();
    }
    _updateReminder();
    if (toggle) {
      toggle.classList.toggle('is-active', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  async function open(cid) {
    const request = ++_openRequest;
    _cid = cid;
    // Read before showing: the panel still holds what was rendered last.
    await refresh();
    if (request !== _openRequest || _cid !== cid) return;
    _setOpen(true);
    _render();
  }

  function close() {
    _openRequest += 1;
    _closeSettings();
    _setOpen(false);
  }

  function _forgetConversation() {
    _lifetime += 1;
    _data = null;
    _contentSignature = null;
    _hasUnseenChanges = false;
    _updateToggle();
    _dir = '';
    _selected = '';
    _renderedDir = '';
    _jobs.clear();
    _quotes.clear();
    _takeOptions.clear();
    _takeOptionsStale.clear();
    _takeChoice.clear();
    _takeInputs.clear();
    _takeSettings.clear();
    _closeSettings();
    _draftOptions.clear();
    _draftOptionsStale.clear();
    _takeOptionsShown.clear();
    _draftOptionsShown.clear();
    // Words typed into a new shot are saved where they were typed.
    for (const { field } of [..._draftPromptSaves.values()]) _saveDraftPrompt(field);
    _openScene.clear();
    _shotResult.clear();
    _pickedVersion.clear();
    _voiceLists.clear();
    _drafts.clear();
    _productionSelect = null;
    const host = _el('video-canvas-production');
    if (host) host.innerHTML = '';
  }

  /** Called when a conversation is shown: the toolbar button appears only where there is
   *  something for it, and the panel never carries over to another conversation. */
  async function probe(cid) {
    if (_cid !== cid) {
      if (_cid) close();
      _forgetConversation();
    }
    _cid = cid;
    await refresh();
  }

  function notifyTurnEnd(cid) {
    if (!cid || cid !== _cid) return;
    clearTimeout(_turnEndTimer);
    _turnEndTimer = setTimeout(refresh, REFRESH_AFTER_TURN_MS);
  }

  /** An Agent started or stopped working here, so the canvas stops or resumes taking changes. */
  function notifyBusy(cid, busy) {
    if (!cid || cid !== _cid || !!busy === _lastBusy) return;
    _lastBusy = !!busy;
    if (_data) _data.busy = !!busy;
    if (_isOpen()) _render();
    clearTimeout(_turnEndTimer);
    _turnEndTimer = setTimeout(refresh, REFRESH_AFTER_TURN_MS);
  }

  function _bind() {
    _resize = global.TaskSidePanel?.bind('video-canvas-panel', 'video-canvas-resize', () => _scheduleLayout());
    _el('video-canvas-toggle')?.addEventListener('click', () => {
      if (_isOpen()) close();
      else open(_cid);
    });
    _el('video-canvas-close')?.addEventListener('click', close);
    _el('video-canvas-zoom-in')?.addEventListener('click', () => _zoomBy(ZOOM_STEP));
    _el('video-canvas-zoom-out')?.addEventListener('click', () => _zoomBy(1 / ZOOM_STEP));
    _el('video-canvas-zoom-fit')?.addEventListener('click', _fit);
    const viewport = _viewport();
    if (viewport) {
      viewport.addEventListener('pointerdown', _onPointerDown);
      viewport.addEventListener('click', _onClick, true);
      viewport.addEventListener('dblclick', _onDoubleClick);
      viewport.addEventListener('wheel', _onWheel, { passive: false });
      viewport.addEventListener('keydown', _onKeyDown);
      viewport.addEventListener('keydown', _onCardKeyDown);
      viewport.addEventListener('input', _onInput);
      viewport.addEventListener('focusout', _onFocusOut);
      viewport.addEventListener('dragenter', _onDragOver);
      viewport.addEventListener('dragover', _onDragOver);
      viewport.addEventListener('dragleave', _onDragLeave);
      viewport.addEventListener('drop', _onDrop);
      viewport.addEventListener('paste', _onPaste);
      viewport.addEventListener('contextmenu', _onContextMenu);
    }
    global.addEventListener('i18n-change', () => {
      _updateReminder();
      if (_isOpen()) _render();
    });
    if (global.orkas && typeof global.orkas.onPushEvent === 'function') {
      try { global.orkas.onPushEvent('conversations:video-canvas-job', _onJobEvent); }
      catch (_) { /* push channel unavailable in this build */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bind);
  else _bind();

  global.VideoCanvas = { probe, open, close, refresh, notifyTurnEnd, notifyBusy };
}(typeof window !== 'undefined' ? window : globalThis));
