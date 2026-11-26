/*
 * ScreenDemo: show a step being done on a real screenshot.
 *
 * Load after gsap.min.js. In the page, give a box explicit geometry and put that
 * scene's screenshots in it:
 *
 *   <div class="demo"><img data-clip="search"><img data-clip="results"></div>
 *
 * Then, in the scene's timeline:
 *
 *   const tl = window.__timelines.find = gsap.timeline({ paused: true });
 *   ScreenDemo('[data-scene-id="find"] .demo', tl)
 *     .tap(0.52, 0.18, 0.8)
 *     .type([0.08, 0.14, 0.7, 0.06], 'pet clinic', 1.0)
 *     .zoom([0.05, 0.3, 0.9, 0.3], 2.6)
 *     .mark([0.06, 0.32, 0.88, 0.12], 3.0);
 *
 * Points and boxes are fractions of the screenshot (0 to 1), or its own pixels when
 * any value is above 1. Times are seconds of the scene. Every step is a tween on
 * the given paused timeline, so any frame can be rendered on its own.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.ScreenDemo) return;

  var STYLE_ID = 'orkas-screen-demo-style';
  var CSS = [
    '.sd-device{position:absolute;box-sizing:border-box;overflow:hidden}',
    '.sd-device[data-frame="browser"]{background:#fff;border-radius:14px;box-shadow:0 28px 70px rgba(15,23,42,.24),0 0 0 1px rgba(15,23,42,.10)}',
    '.sd-device[data-frame="phone"]{background:#0c0e13;box-shadow:0 28px 70px rgba(15,23,42,.30),inset 0 0 0 2px #2a2e37}',
    '.sd-bar{position:relative;display:flex;align-items:center;box-sizing:border-box;background:#eef0f4;border-bottom:1px solid #dde1e8}',
    '.sd-bar i{display:block;border-radius:50%;background:#d3d7df;flex:none}',
    '.sd-bar b{display:block;flex:1;height:56%;border-radius:999px;background:#fff;box-shadow:inset 0 0 0 1px #e3e6ec}',
    '.sd-view{position:relative;overflow:hidden;background:#fff}',
    '.sd-camera{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}',
    '.sd-camera>img{position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;object-fit:fill;display:block;margin:0}',
    '.sd-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}',
    '.sd-mark{position:absolute;box-sizing:border-box;opacity:0;border-radius:var(--sd-radius);border:var(--sd-line) solid var(--sd-accent);box-shadow:0 0 0 calc(var(--sd-line) * 2) var(--sd-glow)}',
    '.sd-mark.sd-spot{border-color:transparent;box-shadow:0 0 0 400vmax rgba(9,12,20,.52)}',
    '.sd-field{position:absolute;box-sizing:border-box;display:flex;align-items:center;overflow:hidden;white-space:pre;opacity:0;border-radius:4px}',
    '.sd-field>span{display:none}',
    '.sd-caret{display:inline-block;width:2px;height:1.15em;margin-left:2px;background:currentColor;opacity:0}',
    '.sd-ripple{position:absolute;width:0;height:0;opacity:0}',
    '.sd-ripple>i{position:absolute;display:block;border-radius:50%;box-sizing:border-box;border:var(--sd-line) solid var(--sd-accent);background:var(--sd-glow)}',
    '.sd-pointer{position:absolute;left:50%;top:60%;width:0;height:0;opacity:0;z-index:3}',
    '.sd-size,.sd-hand{position:absolute;left:0;top:0;width:0;height:0}',
    '.sd-hand svg{position:absolute;left:-1px;top:-1px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}',
    '.sd-hand>i{position:absolute;display:block;border-radius:50%;box-sizing:border-box;background:rgba(255,255,255,.62);border:3px solid rgba(20,24,32,.38);box-shadow:0 4px 12px rgba(0,0,0,.25)}',
  ].join('\n');
  var ARROW = '<svg viewBox="0 0 18 26" xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L1 21.5 L6.2 16.6 L9.8 24.6 L13.4 23 L9.9 15.2 L16.8 15.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, className, parent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function num(value, name) {
    var n = Number(value);
    if (!isFinite(n)) throw new Error('ScreenDemo: ' + name + ' must be a number');
    return n;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function Demo(target, tl, options) {
    if (!window.gsap) throw new Error('ScreenDemo: load ./assets/vendor/gsap.min.js before screen-demo.js');
    var root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root || root.nodeType !== 1) throw new Error('ScreenDemo: no element matches ' + target);
    if (!tl || typeof tl.add !== 'function') throw new Error('ScreenDemo: pass the scene\'s paused gsap timeline');
    ensureStyle();
    this.root = root;
    this.tl = tl;
    this.options = options || {};
    this.accent = this.options.color || '#2f7bff';
    this.free = 0;
    this.zoomed = function () { return { s: 1, x: 0, y: 0 }; };
    this.placements = [];
    this.at = null;
    this.size = null;
    this.build();
    var self = this;
    this.images.forEach(function (img) { img.addEventListener('load', function () { self.layout(); }); });
    this.layout();
    // The host loads the screenshots just before it renders a frame; lay out again
    // then, before any step reads a position.
    tl.set(this.device, { '--sd-ready': function () { self.layoutOnce(); return 1; }, immediateRender: false }, 0);
  }

  Demo.prototype.build = function () {
    var root = this.root;
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.setAttribute('data-orkas-screen', '');
    var images = Array.prototype.filter.call(root.querySelectorAll('img'), function (img) { return !img.closest('.sd-layer'); });
    if (!images.length) throw new Error('ScreenDemo: put the screenshot <img data-clip> elements inside the box');
    var device = root.querySelector(':scope > .sd-device') || el('div', 'sd-device', root);
    var bar = device.querySelector(':scope > .sd-bar');
    var view = device.querySelector(':scope > .sd-view') || el('div', 'sd-view', device);
    var camera = view.querySelector(':scope > .sd-camera') || el('div', 'sd-camera', view);
    images.forEach(function (img) { if (img.parentNode !== camera) camera.appendChild(img); });
    var layer = camera.querySelector(':scope > .sd-layer') || el('div', 'sd-layer', camera);
    var pointer = camera.querySelector(':scope > .sd-pointer');
    if (!pointer) {
      pointer = el('div', 'sd-pointer', camera);
      el('div', 'sd-hand', el('div', 'sd-size', pointer));
    }
    this.device = device;
    this.bar = bar;
    this.view = view;
    this.camera_ = camera;
    this.layer = layer;
    this.pointer = pointer;
    this.sizer = pointer.firstChild;
    this.hand = this.sizer.firstChild;
    this.images = images;
  };

  /** The screenshot's own size: the first one the host has loaded. */
  Demo.prototype.naturalSize = function () {
    for (var i = 0; i < this.images.length; i += 1) {
      var img = this.images[i];
      if (img.naturalWidth > 0 && img.naturalHeight > 0) return { w: img.naturalWidth, h: img.naturalHeight };
    }
    var o = this.options;
    if (o.width > 0 && o.height > 0) return { w: Number(o.width), h: Number(o.height) };
    return null;
  };

  Demo.prototype.frame = function (size) {
    var f = this.options.frame;
    if (f === 'browser' || f === 'phone' || f === 'none') return f;
    return size && size.h > size.w * 1.15 ? 'phone' : 'browser';
  };

  /** Fit the device into the box. Runs again whenever a screenshot loads, and before
   *  any step's values are first read. */
  Demo.prototype.layout = function () {
    var size = this.naturalSize();
    var known = !!size;
    size = size || { w: 1440, h: 900 };
    var frame = this.frame(known ? size : null);
    var W = this.root.clientWidth || this.root.getBoundingClientRect().width;
    var H = this.root.clientHeight || this.root.getBoundingClientRect().height;
    if (!(W > 0 && H > 0)) return;
    var device = this.device;
    device.setAttribute('data-frame', frame);
    this.frameKind = frame;
    var unit = Math.min(W, H);
    var pad = frame === 'phone' ? clamp(Math.round(unit * 0.022), 8, 22) : 0;
    var barH = 0;
    var scale = Math.min((W - pad * 2) / size.w, (H - pad * 2) / size.h);
    if (frame === 'browser') {
      for (var k = 0; k < 3; k += 1) {
        barH = clamp(Math.round(size.w * scale * 0.034), 20, 46);
        scale = Math.min(W / size.w, (H - barH) / size.h);
      }
    }
    var vw = Math.max(1, size.w * scale);
    var vh = Math.max(1, size.h * scale);
    var dw = vw + pad * 2;
    var dh = vh + pad * 2 + barH;
    var align = this.options.align || 'center';
    var left = align === 'left' ? 0 : align === 'right' ? W - dw : (W - dw) / 2;
    var top = (H - dh) / 2;
    device.style.left = left + 'px';
    device.style.top = top + 'px';
    device.style.width = dw + 'px';
    device.style.height = dh + 'px';
    device.style.padding = pad + 'px';
    device.style.borderRadius = frame === 'phone' ? Math.round(pad * 2.6) + 'px' : '';
    if (frame === 'browser') {
      if (!this.bar) {
        this.bar = el('div', 'sd-bar');
        device.insertBefore(this.bar, this.view);
        this.bar.innerHTML = '<i></i><i></i><i></i><b></b>';
      }
      var dot = Math.round(barH * 0.28);
      this.bar.style.display = 'flex';
      this.bar.style.height = barH + 'px';
      this.bar.style.gap = Math.round(dot * 0.7) + 'px';
      this.bar.style.padding = '0 ' + Math.round(barH * 0.45) + 'px';
      Array.prototype.forEach.call(this.bar.querySelectorAll('i'), function (i) { i.style.width = dot + 'px'; i.style.height = dot + 'px'; });
      this.bar.querySelector('b').style.marginLeft = Math.round(barH * 0.4) + 'px';
    } else if (this.bar) {
      this.bar.style.display = 'none';
    }
    this.view.style.width = vw + 'px';
    this.view.style.height = vh + 'px';
    this.view.style.borderRadius = frame === 'phone' ? Math.round(pad * 1.8) + 'px' : '';
    // Interaction marks are sized from the shown screen, so they read the same on a
    // phone screenshot and a desktop one.
    var mark = Math.min(vw, vh);
    this.unit = mark;
    this.root.style.setProperty('--sd-accent', this.accent);
    this.root.style.setProperty('--sd-glow', hexAlpha(this.accent, 0.22));
    this.root.style.setProperty('--sd-line', Math.max(2, Math.round(mark * 0.006)) + 'px');
    this.root.style.setProperty('--sd-radius', Math.max(6, Math.round(mark * 0.014)) + 'px');
    this.drawHand(frame, mark);
    this.size = known ? size : this.size;
    for (var p = 0; p < this.placements.length; p += 1) this.placements[p]();
  };

  Demo.prototype.drawHand = function (frame, unit) {
    var touch = frame === 'phone' || this.options.pointer === 'touch';
    if (this.options.pointer === 'arrow') touch = false;
    var key = (touch ? 't' : 'a') + Math.round(unit);
    if (this.hand.getAttribute('data-key') === key) return;
    this.hand.setAttribute('data-key', key);
    this.touch = touch;
    if (touch) {
      var d = Math.round(unit * 0.13);
      this.hand.innerHTML = '<i></i>';
      var dot = this.hand.firstChild;
      dot.style.width = d + 'px';
      dot.style.height = d + 'px';
      dot.style.left = -d / 2 + 'px';
      dot.style.top = -d / 2 + 'px';
    } else {
      var h = Math.round(clamp(unit * 0.07, 22, 64));
      this.hand.innerHTML = ARROW;
      this.hand.firstChild.setAttribute('width', String(Math.round(h * 18 / 26)));
      this.hand.firstChild.setAttribute('height', String(h));
    }
  };

  function hexAlpha(color, alpha) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!m) return 'rgba(47,123,255,' + alpha + ')';
    var hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return 'rgba(' + parseInt(hex.slice(0, 2), 16) + ',' + parseInt(hex.slice(2, 4), 16) + ',' + parseInt(hex.slice(4, 6), 16) + ',' + alpha + ')';
  }

  /** Fractions of the screenshot from what the caller gave: fractions, or the
   *  screenshot's own pixels when any value is above 1. */
  Demo.prototype.fractions = function (values) {
    var pixels = values.some(function (v) { return Math.abs(v) > 1; });
    if (!pixels) return values.slice();
    var size = this.size || this.naturalSize();
    if (!size) return values.map(function () { return 0.5; });
    return values.map(function (v, i) { return i % 2 === 0 ? v / size.w : v / size.h; });
  };

  Demo.prototype.point = function (x, y) {
    var f = this.fractions([num(x, 'x'), num(y, 'y')]);
    return { x: clamp(f[0], 0, 1), y: clamp(f[1], 0, 1) };
  };

  Demo.prototype.box = function (box) {
    if (!box || box.length !== 4) throw new Error('ScreenDemo: a box is [x, y, width, height]');
    var raw = [num(box[0], 'box x'), num(box[1], 'box y'), num(box[2], 'box width'), num(box[3], 'box height')];
    var pixels = raw.some(function (v) { return Math.abs(v) > 1; });
    var f;
    if (pixels) {
      var size = this.size || this.naturalSize() || { w: 1, h: 1 };
      f = [raw[0] / size.w, raw[1] / size.h, raw[2] / size.w, raw[3] / size.h];
    } else {
      f = raw;
    }
    var x = clamp(f[0], 0, 1);
    var y = clamp(f[1], 0, 1);
    return { x: x, y: y, w: clamp(f[2], 0.005, 1 - x), h: clamp(f[3], 0.005, 1 - y) };
  };

  /** Place an element on a box, now and again whenever the layout changes. */
  Demo.prototype.place = function (node, box, extra) {
    var self = this;
    var apply = function () {
      var b = self.box(box);
      node.style.left = b.x * 100 + '%';
      node.style.top = b.y * 100 + '%';
      node.style.width = b.w * 100 + '%';
      node.style.height = b.h * 100 + '%';
      if (extra) extra(b);
    };
    this.placements.push(apply);
    apply();
  };

  /** Move the pointer so it arrives at `at`. `to` returns the point as fractions.
   *  Moves never overlap: one starts when the step before it is done. */
  Demo.prototype.glide = function (to, at) {
    var tl = this.tl;
    var from = this.at;
    var duration = 0.6;
    var start = Math.max(this.free, at - duration);
    duration = Math.max(0.12, at - start);
    start = Math.max(0, at - duration);
    var self = this;
    var fromPoint = from || function () {
      var p = to();
      return { x: clamp(p.x + 0.12, 0, 1), y: clamp(p.y + 0.16, 0, 1) };
    };
    tl.fromTo(this.pointer,
      { left: function () { self.layoutOnce(); return fromPoint().x * 100 + '%'; }, top: function () { return fromPoint().y * 100 + '%'; } },
      { left: function () { return to().x * 100 + '%'; }, top: function () { return to().y * 100 + '%'; }, duration: duration, ease: 'power2.inOut', immediateRender: false },
      start);
    if (!from) {
      tl.fromTo(this.pointer, { opacity: 0 }, { opacity: 1, duration: Math.min(0.25, duration), ease: 'none', immediateRender: false }, start);
    }
    this.at = to;
    this.free = at;
    this.glideStart = start;
    return this;
  };

  Demo.prototype.layoutOnce = function () {
    if (!this.size) this.layout();
  };

  Demo.prototype.pointFn = function (x, y) {
    var self = this;
    num(x, 'x');
    num(y, 'y');
    return function () { return self.point(x, y); };
  };

  /** Point at a control without pressing it. */
  Demo.prototype.hover = function (x, y, at) {
    return this.glide(this.pointFn(x, y), num(at, 'at'));
  };

  /** Press a control: the pointer arrives at `at`, presses and shows where. */
  Demo.prototype.tap = function (x, y, at) {
    return this.press(this.pointFn(x, y), num(at, 'at'));
  };

  Demo.prototype.press = function (p, at) {
    this.glide(p, at);
    this.follow(p, at);
    var tl = this.tl;
    var down = this.touch ? 0.78 : 0.86;
    tl.fromTo(this.hand, { scale: 1 }, { scale: down, duration: 0.09, ease: 'power1.out', immediateRender: false }, at);
    tl.fromTo(this.hand, { scale: down }, { scale: 1, duration: 0.16, ease: 'power1.out', immediateRender: false }, at + 0.09);
    var ripple = el('div', 'sd-ripple', this.layer);
    var ring = el('i', '', ripple);
    var self = this;
    var placeRipple = function () {
      var c = p();
      var d = Math.round((self.unit || 400) * 0.12);
      ripple.style.left = c.x * 100 + '%';
      ripple.style.top = c.y * 100 + '%';
      ring.style.width = d + 'px';
      ring.style.height = d + 'px';
      ring.style.left = -d / 2 + 'px';
      ring.style.top = -d / 2 + 'px';
    };
    this.placements.push(placeRipple);
    placeRipple();
    tl.fromTo(ripple, { opacity: 0.95, scale: 0.25 }, { opacity: 0, scale: 1.25, duration: 0.55, ease: 'power2.out', immediateRender: false }, at);
    this.free = at + 0.25;
    return this;
  };

  /** Type into a field: taps it first unless the pointer is already there, then
   *  writes the text over the field, one character at a time. */
  Demo.prototype.type = function (box, text, at, opts) {
    at = num(at, 'at');
    opts = opts || {};
    var chars = Array.from(String(text == null ? '' : text));
    var self = this;
    var field = el('div', 'sd-field', this.layer);
    chars.forEach(function (ch) { el('span', '', field).textContent = ch; });
    var caret = el('i', 'sd-caret', field);
    field.style.background = opts.background || '#fff';
    field.style.color = opts.color || '#1f2329';
    field.style.fontFamily = opts.font || '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif';
    field.style.fontWeight = opts.weight || '400';
    if (opts.align === 'center') field.style.justifyContent = 'center';
    this.place(field, box, function (b) {
      var px = b.h * (self.view.clientHeight || 1);
      field.style.fontSize = Math.max(6, px * (opts.size || 0.52)) + 'px';
      field.style.paddingLeft = Math.max(4, px * 0.32) + 'px';
    });
    if (opts.tap !== false) {
      this.press(function () {
        var b = self.box(box);
        return { x: b.x + Math.min(b.w * 0.25, 0.08), y: b.y + b.h / 2 };
      }, Math.max(0, at - 0.3));
    }
    var tl = this.tl;
    var step = clamp(Number(opts.speed) > 0 ? 1 / Number(opts.speed) : 0.075, 0.02, 0.3);
    if (chars.length * step > 2.2) step = 2.2 / chars.length;
    tl.fromTo(field, { opacity: 0 }, { opacity: 1, duration: 0.05, ease: 'none', immediateRender: false }, at);
    tl.fromTo(caret, { opacity: 0 }, { opacity: 1, duration: 0.01, ease: 'none', immediateRender: false }, at);
    var spans = field.querySelectorAll('span');
    for (var i = 0; i < spans.length; i += 1) {
      tl.set(spans[i], { display: 'inline', immediateRender: false }, at + 0.08 + i * step);
    }
    var done = at + 0.08 + chars.length * step;
    tl.fromTo(caret, { opacity: 1 }, { opacity: 0, duration: 0.01, ease: 'none', immediateRender: false }, done + 0.5);
    this.free = Math.max(this.free, at);
    return this;
  };

  /** Ring a control or result from `at`. opts.until fades it out; opts.spot dims the
   *  rest of the screen instead of drawing a ring. */
  Demo.prototype.mark = function (box, at, opts) {
    at = num(at, 'at');
    opts = opts || {};
    var node = el('div', 'sd-mark' + (opts.spot ? ' sd-spot' : ''), this.layer);
    var self = this;
    this.place(node, box, function () {
      var pad = Math.round((self.unit || 400) * 0.008);
      node.style.margin = -pad + 'px';
      node.style.width = 'calc(' + node.style.width + ' + ' + pad * 2 + 'px)';
      node.style.height = 'calc(' + node.style.height + ' + ' + pad * 2 + 'px)';
    });
    var tl = this.tl;
    tl.fromTo(node, { opacity: 0, scale: opts.spot ? 1 : 1.12 }, { opacity: 1, scale: 1, duration: 0.35, ease: opts.spot ? 'power1.out' : 'back.out(2)', immediateRender: false }, at);
    if (opts.until !== undefined) {
      tl.fromTo(node, { opacity: 1 }, { opacity: 0, duration: 0.25, ease: 'power1.in', immediateRender: false }, num(opts.until, 'until'));
    }
    return this;
  };

  /** The camera state that shows a box, or a point at a given scale, kept inside the screen. */
  Demo.prototype.view_ = function (cx, cy, scale) {
    var s = Math.max(1, scale);
    return {
      s: s,
      x: clamp((0.5 - cx * s) * 100, (1 - s) * 100, 0),
      y: clamp((0.5 - cy * s) * 100, (1 - s) * 100, 0),
    };
  };

  /** Move the camera from where the steps so far leave it to `target`, as one pair of tweens
   *  that can be taken back while the timeline is still being written. */
  Demo.prototype.camera = function (target, start, duration) {
    var self = this;
    var before = this.zoomed;
    var freeBefore = this.cameraFree || 0;
    var ease = 'power2.inOut';
    var moves = [
      gsap.fromTo(this.camera_,
        { scale: function () { self.layoutOnce(); return before().s; }, xPercent: function () { return before().x; }, yPercent: function () { return before().y; } },
        { scale: function () { return target().s; }, xPercent: function () { return target().x; }, yPercent: function () { return target().y; }, duration: duration, ease: ease, immediateRender: false }),
      // The pointer keeps its size on screen while the picture grows.
      gsap.fromTo(this.sizer, { scale: function () { return 1 / before().s; } }, { scale: function () { return 1 / target().s; }, duration: duration, ease: ease, immediateRender: false }),
    ];
    moves.forEach(function (tween) { self.tl.add(tween, start); });
    this.zoomed = target;
    this.cameraFree = start + duration;
    return { moves: moves, before: before, freeBefore: freeBefore, start: start, end: start + duration };
  };

  /** Take back a camera move written earlier, when a later step changes the plan. */
  Demo.prototype.uncamera = function (move) {
    var tl = this.tl;
    move.moves.forEach(function (tween) { tl.remove(tween); });
    this.zoomed = move.before;
    this.cameraFree = move.freeBefore;
  };

  Demo.prototype.followScale = function () {
    var f = this.options.follow;
    if (f === false) return 1;
    if (Number(f) > 1) return Number(f);
    return this.frameKind === 'phone' ? 1.3 : 1.55;
  };

  /** Unless the camera was set by zoom(), move in on each step as it happens and back out
   *  when nothing happens for a while, the way a screen recording is cut. */
  Demo.prototype.follow = function (p, at) {
    if (this.options.follow === false || this.held) return;
    if (this.out && this.glideStart < this.out.end) {
      this.uncamera(this.out);
    }
    this.out = null;
    var self = this;
    var start = Math.max(this.cameraFree || 0, Math.min(this.glideStart, at - 0.45));
    var duration = Math.max(0.2, at - start);
    this.camera(function () { var c = p(); return self.view_(c.x, c.y, self.followScale()); }, start, duration);
    this.out = this.camera(function () { return { s: 1, x: 0, y: 0 }; }, at + 1.5, 0.8);
  };

  /** Move the camera in on a box from `at`, or back out with null. The camera then stays
   *  where it is put until the next zoom. */
  Demo.prototype.zoom = function (box, at, opts) {
    at = num(at, 'at');
    opts = opts || {};
    var self = this;
    var max = Number(opts.max) > 1 ? Number(opts.max) : 2.6;
    if (box) this.box(box);
    if (this.out && this.out.end > at) this.uncamera(this.out);
    this.out = null;
    this.held = !!box;
    var target = function () {
      if (!box) return { s: 1, x: 0, y: 0 };
      var b = self.box(box);
      return self.view_(b.x + b.w / 2, b.y + b.h / 2, clamp(Math.min(0.86 / b.w, 0.86 / b.h), 1, max));
    };
    var duration = Number(opts.duration) > 0 ? Number(opts.duration) : 0.8;
    this.camera(target, Math.max(at, this.cameraFree || 0), duration);
    return this;
  };

  /** Fade the pointer out at `at`. */
  Demo.prototype.hide = function (at) {
    at = num(at, 'at');
    this.tl.fromTo(this.pointer, { opacity: 1 }, { opacity: 0, duration: 0.25, ease: 'none', immediateRender: false }, at);
    return this;
  };

  window.ScreenDemo = function (target, tl, options) { return new Demo(target, tl, options); };
})();
