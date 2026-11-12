// ==UserScript==
// @name           Zen Page Tint
// @description    Adaptive Zen chrome color from the active page
// @version        2.1.0
// ==/UserScript==

(() => {
  'use strict';

  // Each pref is read independently: Services.prefs.get*Pref throws on a
  // wrong-TYPE pref (the default arg only covers the missing case), so sharing one
  // try block would let a single mistyped about:config entry silently revert every
  // later pref to its default.
  function prefBool(name, def) { try { return Services.prefs.getBoolPref(name, def); } catch { return def; } }
  function prefInt(name, def) { try { return Services.prefs.getIntPref(name, def); } catch { return def; } }
  function prefStr(name, def) { try { return Services.prefs.getStringPref(name, def); } catch { return def; } }

  // Diagnostic and live-mode preferences are read once per script load.
  const DEBUG = prefBool('zen.page-tint.debug', false);
  const log = DEBUG ? (...args) => console.log('[zen-page-tint]', ...args) : () => {};

  // Live mode — optional continuous polling that lets the chrome tint follow
  // video / animated content in real time. On by default (auto-detected against
  // <video>, so static pages cost zero). Tunable in about:config:
  //
  //   zen.page-tint.live-mode               (bool, default true)
  //     Master switch. When off, no polling at all (pure event-driven).
  //   zen.page-tint.live-mode-rate-ms       (int, default 2000 — 0.5 Hz)
  //     The poll interval, used verbatim (floored at 100ms as a guard against an
  //     absurd value). This is the rate at which the chrome color can change.
  //     Sampling used to adaptively run at rate/4 on changing content, which meant
  //     video pinned it there permanently and this number never actually applied —
  //     see the frame script. How MUCH change is needed to re-tint is a separate
  //     knob (live-mode-threshold); this one is purely cadence.
  //   zen.page-tint.live-mode-threshold     (int, default 8 — 0..255)
  //     Minimum per-channel color change required to actually re-tint. Below this
  //     is ignored so the chrome doesn't churn. Set 0 to re-tint on any change.
  //   zen.page-tint.live-mode-smoothing-ms  (int, default 1000)
  //     CSS transition duration applied to EVERY tint change, live or event-driven.
  //   zen.page-tint.live-mode-always-on     (bool, default false)
  //     When false, live polling only runs while a <video> is actually playing.
  //   zen.page-tint.live-mode-hosts         (string, default '')
  //     Comma-separated host allowlist treated as always-on (canvas/WebGL players,
  //     cross-origin <iframe> video embeds). Matched by hostname, port-independent.
  //       example.com, *.spotify.com, music.apple.com, localhost
  //
  // Disabling the master switch requires a Zen restart (config is pushed only at
  // frame-script load time). All polling is paused when the tab is backgrounded.
  const LIVE_MODE = prefBool('zen.page-tint.live-mode', true);
  const LIVE_RATE_MS = Math.max(100, prefInt('zen.page-tint.live-mode-rate-ms', 2000));
  const LIVE_SMOOTH_MS = Math.max(0, prefInt('zen.page-tint.live-mode-smoothing-ms', 1000));
  const LIVE_ALWAYS_ON = prefBool('zen.page-tint.live-mode-always-on', false);
  const LIVE_HOSTS_RAW = prefStr('zen.page-tint.live-mode-hosts', '');
  const LIVE_THRESHOLD = prefInt('zen.page-tint.live-mode-threshold', 8);

  // Color-source prefs. Both are pushed to the frame script with the rest of the
  // config, and both are live-applicable (the observer below clears the cache and
  // re-samples), so they can be A/B'd without a restart.
  //
  //   zen.page-tint.youtube-ambient  (bool, default true)
  //     On YouTube, sample the video's own painted picture box instead of a
  //     centered viewport grab, gated on the player's Ambient mode being on. Same
  //     frames YouTube's on-screen glow is built from, minus what a viewport grab
  //     drags in — letterbox bars on a 21:9 video, page chrome, the comments
  //     column. (It reads the compositor via drawWindow, not YouTube's own
  //     #cinematics canvas: that canvas is CORS-tainted by the cross-origin video
  //     stream and throws on read. See the frame-script comment.) With Ambient mode
  //     off we fall through to the normal sample chain.
  //   zen.page-tint.light-average    (bool, default false)
  //     Average PAGE samples as light rather than as flat color: decode sRGB to
  //     linear before averaging and weight vivid cells above gray ones. The
  //     extra chroma weight is an aesthetic choice and often brightens mixed
  //     pages — a mostly-dark page with bright content on it stops reading as
  //     dark, which is why it's off by default. The YouTube ambient path always
  //     uses this model regardless, since there it's modelling actual light.
  let YT_AMBIENT = prefBool('zen.page-tint.youtube-ambient', true);
  let LIGHT_AVERAGE = prefBool('zen.page-tint.light-average', false);

  // CSS-side appearance knobs. Unlike the live-mode prefs (read once at
  // frame-script load, so they need a restart), these only drive CSS variables,
  // so they're applied live via a pref observer below — changing them in the Sine
  // settings panel updates the chrome immediately.
  //
  //   zen.page-tint.mix-amount   (int 0..100, default 100)  → --zpt-strength
  //     Tint STRENGTH: the page color is laid as a translucent OVERLAY over Zen's
  //     own chrome (including workspace gradients) at this opacity. 100 = fully
  //     opaque page tint (the original look); 0 = no tint, your untouched Zen
  //     theme/gradient shows through; in between veils the gradient with the page
  //     color. Done as an overlay (not a solid color blend) precisely because a
  //     workspace gradient is a gradient, not a single color, so it can't be
  //     reproduced by mixing one color — see style.css's backdrop overlays.
  //   zen.page-tint.frame-gap    (int px, default 5) → --zpt-frame-gap
  //     Non-compact only: compact mode stays flush so Zen's screen-edge hover
  //     targets remain reachable.
  //   zen.page-tint.frame-radius (int px, default 14)  → --zpt-frame-radius
  //   zen.page-tint.saturation   (int 0..200, default 100)
  //     Scales the sampled color's HSL saturation before it's applied. 0 =
  //     grayscale chrome, 100 = the page's own saturation, 200 = double (more
  //     vibrant). Adjusted in JS so the readable-foreground pick uses the result.
  //   zen.page-tint.min-lightness / .max-lightness (int 0..100, default 0 / 100)
  //     Clamp the sampled color's HSL lightness into [min, max]. Keeps blinding-
  //     white pages from washing the chrome out and near-black pages from going
  //     muddy. Defaults (0 / 100) are a no-op.
  //   zen.page-tint.disable-hosts (string, default '')
  //     Comma-separated host list (same syntax as live-mode-hosts, supports
  //     *.example.com) where the tint is turned OFF entirely — the chrome keeps
  //     your Zen theme on those sites.
  //   zen.page-tint.brightness   (int 0..300, default 100)
  //     Gain on the sampled color's lightness, applied BEFORE the min/max clamp so
  //     those stay hard bounds. 100 = untouched, 200 = twice as light. Operates on
  //     HSL lightness rather than multiplying RGB channels, so it can't shift hue
  //     or clip one channel before the others.
  //   zen.page-tint.contrast     (int 0..300, default 100)
  //     Pushes lightness away from (or toward) mid-grey: 100 = untouched, 200
  //     doubles the distance from 50%, 0 flattens everything to mid-grey. Note this
  //     acts on the single already-averaged color, so it deepens darks and lifts
  //     lights — it cannot add local contrast the way a filter on an image would.
  //   zen.page-tint.ambient-spread (int 0..100, default 0)
  //     Strength of the DIRECTIONAL gradient. The sampler already reduces the
  //     viewport to a 16x16 grid; this exposes the per-edge colors that the flat
  //     average was discarding, laid over the base tint as a gradient so the left
  //     of the chrome takes its color from the left of the page and so on. 0 = off
  //     (flat tint, exactly as before, and the frame script skips the extra work);
  //     100 = strongest. This is the analogue of the userstyle's scale + blur, done
  //     as chrome geometry instead of a GPU blur pass.
  const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, n | 0));
  let MIX_AMOUNT = clampInt(prefInt('zen.page-tint.mix-amount', 100), 0, 100);
  let SATURATION = clampInt(prefInt('zen.page-tint.saturation', 100), 0, 200);
  let MIN_LIGHT = clampInt(prefInt('zen.page-tint.min-lightness', 0), 0, 100);
  let MAX_LIGHT = clampInt(prefInt('zen.page-tint.max-lightness', 100), 0, 100);
  let BRIGHTNESS = clampInt(prefInt('zen.page-tint.brightness', 100), 0, 300);
  let CONTRAST = clampInt(prefInt('zen.page-tint.contrast', 100), 0, 300);
  let AMBIENT_SPREAD = clampInt(prefInt('zen.page-tint.ambient-spread', 0), 0, 100);
  // Maximum directional overlay; edgeStop further limits it for text contrast.
  const EDGE_ALPHA_MAX = 0.7;

  // Host-pattern matching. Supports exact-host and leading-wildcard patterns
  // ('*.example.com' matches 'foo.example.com' but not 'example.com'). Matched
  // against URL.hostname, so entries are port-independent. Shared by the live-mode
  // allowlist and the per-site disable list.
  function parseHostList(raw) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  function hostMatches(url, patterns) {
    if (!patterns.length) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const pattern of patterns) {
        if (pattern.startsWith('*.')) { if (host.endsWith(pattern.slice(1))) return true; }
        else if (host === pattern) return true;
      }
    } catch {}
    return false;
  }
  const LIVE_HOSTS = parseHostList(LIVE_HOSTS_RAW);
  let DISABLE_HOSTS = parseHostList(prefStr('zen.page-tint.disable-hosts', ''));

  log('live-mode pref =', LIVE_MODE,
    '| rate =', LIVE_RATE_MS, 'ms',
    '| smoothing =', LIVE_SMOOTH_MS, 'ms',
    '| threshold =', LIVE_THRESHOLD,
    '| always-on =', LIVE_ALWAYS_ON,
    '| allowlist =', LIVE_HOSTS.length ? LIVE_HOSTS.join(', ') : '(none)');

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
  const TEARDOWN_MESSAGE_NAME = 'zen-page-tint:teardown';
  // The frame script sends this once its listeners are live; we answer with
  // config. loadFrameScript() + an immediate sendConfig() races on a process's
  // first load — the message manager drops messages aimed at listeners that
  // aren't registered yet — and the failure is silent, leaving live mode off with
  // liveRateMs stuck at 0. Keeping the eager send too means the common case
  // (process already running the script) still gets config with no extra round
  // trip; this handshake only has to cover the cold start.
  const READY_MESSAGE_NAME = 'zen-page-tint:ready';
  const GLANCE_TAB_ATTRIBUTE = 'zen-glance-tab';
  const FRAME_SCRIPT_URL = 'chrome://sine/content/zen-page-tint/frame.js';
  const root = document.documentElement;
  const controllerId = window.crypto.randomUUID();
  let disposed = false;
  const originalStyles = new Map([
    '--zen-tab-header-background', '--zen-tab-header-foreground',
    '--zpt-strength', '--zpt-color', '--zpt-live-smoothing-ms',
    '--zpt-frame-gap', '--zpt-frame-radius',
    '--zpt-edge-l', '--zpt-edge-r', '--zpt-edge-t', '--zpt-edge-b',
  ].map(name => [name, [root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]]));
  function restoreStyle(name) {
    const [value, priority] = originalStyles.get(name);
    if (value) root.style.setProperty(name, value, priority);
    else root.style.removeProperty(name);
  }
  const tintBackdrops = [];
  const backdropParents = new WeakSet();
  let windowBackdrop = null;
  let ambientClipRaf = 0;
  const backdropResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateAmbientClip) : null;

  function updateAmbientClip() {
    if (disposed || !windowBackdrop) return;
    const navbar = document.querySelector('#zen-appcontent-navbar-wrapper');
    const floating = root.getAttribute('zen-compact-mode') === 'true' && prefBool('zen.view.compact.hide-toolbar', true);
    if (!AMBIENT_SPREAD || !navbar || floating || root.getAttribute('zen-single-toolbar') === 'true') {
      windowBackdrop.style.removeProperty('--zpt-ambient-clip');
      windowBackdrop.style.removeProperty('--zpt-navbar-inset');
      windowBackdrop.style.removeProperty('--zpt-navbar-display');
      return;
    }
    // Both gradient axes live inside the window overlay so opacity applies to
    // their combined result exactly once. Give its horizontal pseudo-element the
    // navbar rectangle and cut that rectangle out of the vertical one.
    const bar = navbar.getBoundingClientRect();
    const bounds = windowBackdrop.getBoundingClientRect();
    const left = bar.left - bounds.left, top = bar.top - bounds.top;
    const right = left + bar.width, bottom = top + bar.height;
    windowBackdrop.style.setProperty('--zpt-ambient-clip',
      `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`);
    windowBackdrop.style.setProperty('--zpt-navbar-inset',
      `${top}px ${bounds.width - right}px ${bounds.height - bottom}px ${left}px`);
    windowBackdrop.style.setProperty('--zpt-navbar-display', 'block');
  }

  function installBackdrops() {
    if (disposed) return;
    // These are leaf surfaces: exactly one tint coat above each native workspace
    // or floating-panel backdrop. No ancestor-depth estimate or inherited color
    // animation is needed, and Zen continues to own panel geometry and materials.
    for (const parent of document.querySelectorAll('#zen-browser-background, .zen-toolbar-background')) {
      if (backdropParents.has(parent)) continue;
      const overlay = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      overlay.className = 'zen-page-tint-backdrop';
      overlay.setAttribute('aria-hidden', 'true');
      parent.appendChild(overlay);
      if (parent.id === 'zen-browser-background') windowBackdrop = overlay;
      tintBackdrops.push(overlay);
      backdropParents.add(parent);
      chromeThemeObserver.observe(parent, { attributes: true, attributeFilter: ['style'] });
    }
    const navbar = document.querySelector('#zen-appcontent-navbar-wrapper');
    if (navbar) backdropResizeObserver?.observe(navbar);
    if (windowBackdrop) backdropResizeObserver?.observe(windowBackdrop);
    updateAmbientClip();
    // Zen updates root layout attributes before pref-dependent CSS margins have
    // settled. Measure again on the next frame; a position-only change does not
    // notify ResizeObserver, even though it moves the ambient cutout.
    if (windowBackdrop && !ambientClipRaf) {
      ambientClipRaf = requestAnimationFrame(() => {
        ambientClipRaf = 0;
        updateAmbientClip();
      });
    }
  }

  function isInternalUrl(url) {
    return !url || url.startsWith('about:') || url.startsWith('chrome:');
  }

  // Full URL → raw color + edges. Query strings and fragments can select different
  // videos or SPA routes; they must not share a cached theme.
  const themeCache = new Map();
  // Sized above the heavy-tab working set (the project targets 1300+ tabs). A
  // smaller cap thrashes: cycling more distinct URLs than the cap forces most tab
  // switches onto the slow miss path, defeating the cache. Entries are short
  // strings (~a few hundred KB total at this size).
  const CACHE_MAX = 3000;

  function parseRgb(color) {
    if (!color) return null;
    const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  // WCAG relative luminance uses linear sRGB, not the gamma-encoded Rec 601
  // shortcut (which picks low-contrast white text on red and middle gray).
  function luminance(rgb) {
    const linear = v => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
  }

  function readableFg(bg) {
    const rgb = parseRgb(bg);
    if (!rgb) return null;
    const lum = luminance(rgb);
    return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#000' : '#fff';
  }

  // ---- HSL conversion (for the saturation / lightness-clamp adjustments) ----
  // All channels 0..1.
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }
  function hslToRgb(h, s, l) {
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue(p, q, h + 1 / 3) * 255),
      g: Math.round(hue(p, q, h) * 255),
      b: Math.round(hue(p, q, h - 1 / 3) * 255),
    };
  }

  // Apply saturation, brightness, contrast, then the lightness clamp to a sampled
  // color. Order matters: gain and contrast run first so the clamp stays a hard
  // bound on the final result rather than something a later multiply can escape.
  // Fast-paths out when nothing is configured (the common case) so default users
  // pay nothing.
  function transformColor(bg) {
    if (SATURATION === 100 && BRIGHTNESS === 100 && CONTRAST === 100
      && MIN_LIGHT === 0 && MAX_LIGHT === 100) return bg;
    const rgb = parseRgb(bg);
    if (!rgb) return bg;
    const unit = (n) => Math.max(0, Math.min(1, n));
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    hsl.s = unit(hsl.s * (SATURATION / 100));
    if (BRIGHTNESS !== 100) hsl.l = unit(hsl.l * (BRIGHTNESS / 100));
    if (CONTRAST !== 100) hsl.l = unit(0.5 + (hsl.l - 0.5) * (CONTRAST / 100));
    const lo = Math.min(MIN_LIGHT, MAX_LIGHT) / 100;
    const hi = Math.max(MIN_LIGHT, MAX_LIGHT) / 100;
    hsl.l = Math.max(lo, Math.min(hi, hsl.l));
    const out = hslToRgb(hsl.h, hsl.s, hsl.l);
    return `rgb(${out.r}, ${out.g}, ${out.b})`;
  }

  // Approximate the visible surface for foreground selection only. The painted
  // tint stays translucent, preserving workspace gradients. A gradient cannot be
  // used as a CSS color; fall back to Canvas when the background has no solid base.
  let chromeBaseCache = null;
  function chromeBaseColor() {
    if (chromeBaseCache) return chromeBaseCache;
    let probe;
    try {
      probe = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      probe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;'
        + 'color:Canvas;background:var(--zen-main-browser-background)';
      // Workspace colors are local to this backdrop in current Zen releases.
      (document.querySelector('#zen-browser-background') || root).appendChild(probe);
      const style = getComputedStyle(probe);
      const background = style.backgroundColor;
      const resolved = background?.startsWith('rgb(') ? background : style.color;
      if (parseRgb(resolved)) chromeBaseCache = resolved;
    } catch (e) { log('chrome base probe failed', e); }
    finally { probe?.remove(); }
    return chromeBaseCache;
  }

  // Blend a sampled color toward Zen's chrome base. amount 100 = pure page color,
  // 0 = pure Zen (though JS drops the tint entirely at 0 before reaching here).
  // Returns the input unchanged if the base can't be resolved, so a Zen theme that
  // defines the base in some form we can't read degrades to the old full-strength
  // look rather than to no tint at all.
  function blendToChromeBase(color, amount) {
    if (amount >= 100) return color;
    const page = parseRgb(color);
    const base = parseRgb(chromeBaseColor() || '');
    if (!page || !base) return color;
    const t = amount / 100;
    const mix = (a, b) => Math.round(b + (a - b) * t);
    return `rgb(${mix(page.r, base.r)}, ${mix(page.g, base.g)}, ${mix(page.b, base.b)})`;
  }

  // Turn a transformed edge color into the translucent overlay stop CSS consumes.
  // Alpha carries the spread strength, so the compositor does the base↔edge blend
  // and JS never has to lerp — and at spread 0 the attribute gate below removes the
  // gradient rules entirely rather than painting a no-op.
  // The whole overlay carries MIX_AMOUNT, including this gradient. Applying
  // strength independently to the base and edges would compound their opacity.
  function edgeStop(color, surface, foreground) {
    const rgb = parseRgb(color);
    if (!rgb) return null;
    let alpha = (AMBIENT_SPREAD / 100) * EDGE_ALPHA_MAX;
    const base = parseRgb(surface);
    // Contrast is evaluated after the group's opacity composites over Zen.
    const visibleEdge = parseRgb(blendToChromeBase(color, MIX_AMOUNT));
    const light = amount => luminance({
      r: base.r + (visibleEdge.r - base.r) * amount,
      g: base.g + (visibleEdge.g - base.g) * amount,
      b: base.b + (visibleEdge.b - base.b) * amount,
    });
    const readable = amount => {
      const lum = light(amount);
      return (foreground === '#000' ? (lum + 0.05) / 0.05 : 1.05 / (lum + 0.05)) >= 4.5;
    };
    // A fixed 0.7 cap alone can still put white text over an almost-white edge.
    // For black text, complementary colors can also darken the middle of the
    // gradient despite readable endpoints. Luminance along an sRGB segment is
    // convex, so find its minimum before limiting the overlay to the first safe
    // contrast crossing. For white text the worst luminance is at an endpoint.
    let limit = alpha;
    if (base && foreground === '#000') {
      let low = 0, high = alpha;
      for (let i = 0; i < 18; i++) {
        const a = low + (high - low) / 3, b = high - (high - low) / 3;
        if (light(a) < light(b)) high = b;
        else low = a;
      }
      const minimum = (low + high) / 2;
      if (!readable(minimum)) limit = minimum;
    }
    if (base && !readable(limit)) {
      let low = 0, high = limit;
      for (let i = 0; i < 12; i++) {
        const middle = (low + high) / 2;
        if (readable(middle)) low = middle;
        else high = middle;
      }
      alpha = low;
    }
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.floor(alpha * 1000) / 1000})`;
  }

  // Each native backdrop gets one coat, so strength is the actual overlay alpha.
  function applyCssVarPrefs() {
    root.style.setProperty('--zpt-strength', `${MIX_AMOUNT}%`);
    root.style.setProperty('--zpt-frame-gap', `${Math.max(0, prefInt('zen.page-tint.frame-gap', 5))}px`);
    root.style.setProperty('--zpt-frame-radius', `${Math.max(0, prefInt('zen.page-tint.frame-radius', 14))}px`);
  }

  // Write the tint variables for a raw sampled color (null, or strength 0, clears
  // the tint so Zen renders natively). Saturation / lightness adjustments are
  // applied here; the overlay OPACITY is handled in CSS by --zpt-strength; and the
  // readable foreground is picked against the ADJUSTED color so contrast stays
  // correct.
  const EDGE_VARS = { l: '--zpt-edge-l', r: '--zpt-edge-r', t: '--zpt-edge-t', b: '--zpt-edge-b' };

  function clearEdgeVars() {
    for (const name of Object.values(EDGE_VARS)) root.style.removeProperty(name);
    root.removeAttribute('zen-page-tint-ambient');
  }

  function renderTint(rawBg, rawEdges) {
    updateAmbientClip();
    if (rawBg && MIX_AMOUNT > 0) {
      // The painted value stays the full page color; CSS applies strength as alpha
      // (--zpt-strength). The FOREGROUND pick, though,
      // has to run against an approximation of what actually lands on screen —
      // below full strength that's the page color composited over Zen's base, so
      // picking contrast against the raw page color could put black text on chrome
      // that has already gone dark.
      const tint = transformColor(rawBg);
      const surface = blendToChromeBase(tint, MIX_AMOUNT);
      const fg = readableFg(surface) || 'inherit';
      root.style.setProperty('--zen-tab-header-background', tint);
      // Retain the last leaf color while fading out; restoring Zen's own header
      // variable must not change the color halfway through that fade.
      root.style.setProperty('--zpt-color', tint);
      root.style.setProperty('--zen-tab-header-foreground', fg);
      root.setAttribute('zen-page-tint', 'on');

      // Directional gradient. Edge colors go through the SAME transform as the
      // base so a saturation or brightness change moves all of them together —
      // otherwise the gradient would drift out of family with the surface it sits
      // on. The attribute gates the CSS: without it there is no gradient rule at
      // all, so spread 0 costs nothing rather than painting a transparent one.
      if (AMBIENT_SPREAD > 0 && rawEdges) {
        let ok = true;
        const stops = {};
        for (const key of Object.keys(EDGE_VARS)) {
          // Spread is internal to the tint; the leaf's opacity applies strength
          // once to the base plus gradient, preserving the native theme beneath.
          const stop = rawEdges[key] ? edgeStop(transformColor(rawEdges[key]), surface, fg) : null;
          if (!stop) { ok = false; break; }
          stops[key] = stop;
        }
        if (ok) {
          for (const [key, name] of Object.entries(EDGE_VARS)) root.style.setProperty(name, stops[key]);
          root.setAttribute('zen-page-tint-ambient', 'on');
        } else {
          clearEdgeVars();
        }
      } else {
        clearEdgeVars();
      }
    } else {
      restoreStyle('--zen-tab-header-background');
      restoreStyle('--zen-tab-header-foreground');
      root.removeAttribute('zen-page-tint');
      clearEdgeVars();
    }
  }

  // One-shot diagnostic of the native surfaces and our leaf overlays.
  let dumpedChromeLayers = false;
  function dumpChromeLayers() {
    if (!DEBUG || dumpedChromeLayers) return;
    dumpedChromeLayers = true;
    try {
      const rs = getComputedStyle(root);
      const lines = ['[zen-page-tint] chrome layer dump'];
      for (const v of ['--zpt-color', '--zpt-strength', '--zen-tab-header-background']) {
        lines.push(`  ${v} = ${rs.getPropertyValue(v).trim() || '(unset)'}`);
      }
      const trim = (s, n) => (s && s !== 'none' ? String(s).slice(0, n) : s);
      const report = (label, el, pseudo) => {
        if (!el) { lines.push(`  ${label} -> NOT FOUND`); return; }
        const s = getComputedStyle(el, pseudo || null);
        lines.push(`  ${label}`);
        lines.push(`      bg=${s.backgroundColor} | img=${trim(s.backgroundImage, 46)}`);
        lines.push(`      shadow=${trim(s.boxShadow, 80)} | appearance=${s.appearance}`);
      };
      report('#main-window', root);
      for (const sel of ['#zen-main-app-wrapper', '#browser', '#appcontent', '#zen-appcontent-wrapper',
        '#navigator-toolbox', '#zen-browser-background', '#sidebar-main',
        '.browserSidebarContainer.deck-selected']) {
        report(sel, document.querySelector(sel));
      }
      const bgEl = document.querySelector('#zen-browser-background');
      report('#zen-browser-background::before', bgEl, '::before');
      report('#zen-browser-background::after', bgEl, '::after');
      tintBackdrops.forEach((overlay, i) => report(`tint overlay ${i}`, overlay));
      console.log(lines.join('\n'));
    } catch (e) { log('chrome layer dump failed', e); }
  }

  // Track the last applied (raw) theme so switching between same-colored tabs (the
  // common case — most pages are white or one of a few grays) doesn't rewrite the
  // CSS variables and trigger a full restyle of every var() consumer (including the
  // per-tab rules × thousands of tabs) plus a re-armed 1s fade. Compared by
  // signature rather than identity because the theme is now an object rebuilt on
  // every message, so `===` would never match and the dedupe would be dead.
  let lastAppliedTheme = null;
  let lastAppliedSig = undefined;
  function themeSig(theme) {
    if (!theme || !theme.bg) return null;
    const e = theme.edges;
    return e ? `${theme.bg}|${e.l}|${e.r}|${e.t}|${e.b}` : theme.bg;
  }
  function applyTheme(theme) {
    const next = (theme && theme.bg) ? theme : null;
    const sig = themeSig(next);
    if (sig === lastAppliedSig) return;
    lastAppliedSig = sig;
    lastAppliedTheme = next;
    renderTint(next && next.bg, next && next.edges);
    if (next) dumpChromeLayers();
  }

  // Re-render from the last raw theme without the same-color dedupe. Used when an
  // appearance pref (strength / saturation / brightness / contrast / lightness /
  // spread) changes live: the raw page color is unchanged but its rendered result
  // isn't.
  function reapplyTint() {
    renderTint(lastAppliedTheme && lastAppliedTheme.bg, lastAppliedTheme && lastAppliedTheme.edges);
  }

  function cacheKey(uri) {
    try { return new URL(uri).href; }
    catch { return uri || ''; }
  }

  function cacheGet(key) {
    const value = themeCache.get(key);
    if (value !== undefined) { themeCache.delete(key); themeCache.set(key, value); }
    return value;
  }

  function cacheSet(key, value) {
    if (themeCache.has(key)) themeCache.delete(key);
    else if (themeCache.size >= CACHE_MAX) themeCache.delete(themeCache.keys().next().value);
    themeCache.set(key, value);
  }

  // Per-browser transport, request identity, and last sample. Keyed weakly by
  // browser element, but we track the messageManager identity too: a discarded/restored tab,
  // remoteness change, or tab tear-off recreates the mm, and the listener must be
  // re-attached to the live one (the old "have we attached?" boolean guard left
  // restored tabs with no listener at all).
  const browserState = new WeakMap();
  let nextRequestId = 0;
  let sourceRevision = 0;

  function documentId(browser) {
    return browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? null;
  }

  function invalidateSamples() {
    // Old background samplers must not repopulate a cleared cache with samples
    // produced under the previous color-source settings. Update them lazily on
    // selection so this never instantiates session-restore browsers.
    sourceRevision++;
    themeCache.clear();
    scheduleSample(true);
  }

  // A transient Zen Glance is selected like a normal browser, but Zen still shows
  // its parent page behind the overlay. Keep the shared chrome on the parent's
  // tint until the child is expanded into a normal tab, at which point Zen removes
  // this attribute and the observer below samples the child normally.
  function isTransientGlance(browser) {
    try { return gBrowser.getTabForBrowser(browser)?.hasAttribute(GLANCE_TAB_ATTRIBUTE) === true; }
    catch { return false; }
  }

  function makeListener(browser) {
    return (msg) => {
      if (disposed) return;
      const theme = msg.data || {};
      const rec = browserState.get(browser);
      if (!rec || rec.sourceRevision !== sourceRevision || theme.requestId !== rec.requestId
        || rec.documentId !== documentId(browser)) return;
      const current = browser.currentURI?.spec || '';
      // Key by the URL the sample was actually taken from (sent as href), not the
      // browser's current URI — an in-flight sample from the previous document can
      // arrive after navigation, and must not be cached/applied under the new URL.
      const sampled = theme.href;
      if (isInternalUrl(sampled) || hostMatches(sampled, DISABLE_HOSTS)) return;
      const key = cacheKey(sampled);
      const isCurrent = cacheKey(current) === key;
      if (!isCurrent) return;
      const canApply = isCurrent && gBrowser.selectedBrowser === browser && !isTransientGlance(browser);
      log('message received', { source: theme.source, bg: theme.bg, url: sampled });
      // Same-URL tabs can show different video frames, scroll positions, or app
      // state. Keep this document's own result, including an explicit null color,
      // so the shared URL cache cannot overwrite it on the next tab switch.
      rec.sample = { key, theme: theme.bg ? { bg: theme.bg, edges: theme.edges || null } : null };

      if (theme.bg) {
        // Cache the whole sampled theme (color + directional edges), not just the
        // color: a cache hit has to be able to restore the gradient too, or
        // revisiting a tab would silently drop to a flat tint.
        cacheSet(key, rec.sample.theme);
        if (canApply) {
          applyTheme(rec.sample.theme);
          log('applied', { bg: theme.bg, edges: !!theme.edges });
        }
      } else if (canApply) {
        // Genuine "no color found" on the page currently shown — drop the stale
        // cache entry and clear the tint (otherwise the previous page's tint
        // lingers on a colorless / transparent page). Gated on selected+current so
        // a background duplicate-URL tab's transient pre-paint null can't evict the
        // entry a foreground tab on the same URL is relying on.
        themeCache.delete(key);
        applyTheme(null);
      }
    };
  }

  // Drop both message listeners recorded for a browser. Shared so the two removal
  // sites (stale-mm re-attach, and detach on TabClose / cleanup) can't drift apart
  // and leak one listener — which is what a hand-rolled second copy invites.
  function removeListeners(rec) {
    if (!rec || !rec.mm) return;
    if (rec.listener) { try { rec.mm.removeMessageListener(MESSAGE_NAME, rec.listener); } catch {} }
    if (rec.readyListener) { try { rec.mm.removeMessageListener(READY_MESSAGE_NAME, rec.readyListener); } catch {} }
  }

  // Attach (or re-attach) the chrome-side message listener for a browser. Returns
  // the record, or null if no message manager is available.
  function ensureAttached(browser) {
    if (!browser) return null;
    const mm = browser.messageManager;
    if (!mm?.addMessageListener) return null;
    let rec = browserState.get(browser);
    if (rec && rec.mm === mm) return rec;
    // New browser, or the mm was recreated under us — drop any stale listener and
    // attach to the live mm.
    removeListeners(rec);
    const listener = makeListener(browser);
    const readyListener = () => {
      if (!disposed && browserState.get(browser)?.mm === mm) sendConfig(browser);
    };
    try {
      mm.addMessageListener(MESSAGE_NAME, listener);
      mm.addMessageListener(READY_MESSAGE_NAME, readyListener);
    }
    catch (e) {
      // Drop any stale record so the next attempt retries cleanly, rather than
      // leaving a record with loaded:true that makes the cache-hit path skip the
      // frame-script reload for this (still-unlistened) browser.
      log('listener attach failed', e);
      removeListeners({ mm, listener, readyListener });
      browserState.delete(browser);
      return null;
    }
    rec = { mm, listener, readyListener, loaded: false, requestId: null,
      sourceRevision: -1, documentId: null, urlKey: null, sample: null };
    browserState.set(browser, rec);
    log('listener attached');
    return rec;
  }

  // Config is sent unconditionally — the live-mode master switch is expressed as
  // liveRateMs: 0 (which the frame script already treats as "never poll") rather
  // than by skipping the message. Bailing early here would also starve the
  // non-live settings below it, silently pinning them to the frame script's
  // built-in defaults for anyone running with live mode off.
  function sendConfig(browser) {
    const rec = browserState.get(browser);
    const mm = rec?.mm;
    if (disposed || !mm?.sendAsyncMessage || rec.sourceRevision !== sourceRevision) return;
    try {
      const url = browser.currentURI?.spec || '';
      mm.sendAsyncMessage(CONFIG_MESSAGE_NAME, {
        requestId: rec.requestId,
        liveRateMs: LIVE_MODE ? LIVE_RATE_MS : 0,
        alwaysOn: LIVE_ALWAYS_ON || hostMatches(url, LIVE_HOSTS),
        threshold: LIVE_THRESHOLD,
        debug: DEBUG,
        ytAmbient: YT_AMBIENT,
        lightAverage: LIGHT_AVERAGE,
        // Only ask for per-edge colors when something will actually render them.
        edges: AMBIENT_SPREAD > 0,
      });
    } catch (e) { log('config message send failed', e); }
  }

  // Load the frame script into the browser's content process and push config.
  // frame.js's globalThis guard makes a repeat load cheap (it just re-samples the
  // current document). Marks the record loaded so cache hits can skip re-loading.
  function loadFrameScript(browser) {
    const rec = ensureAttached(browser);
    const mm = rec?.mm;
    if (!mm?.loadFrameScript) return;
    rec.requestId = `${controllerId}:${++nextRequestId}`;
    rec.sourceRevision = sourceRevision;
    rec.documentId = documentId(browser);
    rec.urlKey = cacheKey(browser.currentURI?.spec || '');
    rec.sample = null;
    rec.loaded = false;
    try {
      mm.loadFrameScript(FRAME_SCRIPT_URL, false);
      sendConfig(browser);
      rec.loaded = true;
      log('frame script load requested');
    } catch (e) { log('frame script load failed', e); }
  }

  function detachBrowser(browser) {
    if (!browser) return;
    const rec = browserState.get(browser);
    removeListeners(rec);
    if (rec?.loaded) {
      try { rec.mm.sendAsyncMessage(TEARDOWN_MESSAGE_NAME, {}); } catch {}
    }
    browserState.delete(browser);
    log('detached');
  }

  function sampleAndApply(browser, forceFresh = false) {
    if (!browser) return;
    if (isTransientGlance(browser)) {
      log('transient Glance selected; preserving parent tint');
      return;
    }
    const url = browser.currentURI?.spec || '';

    // Internal pages and per-site-disabled hosts keep Zen's own chrome (no tint).
    if (isInternalUrl(url) || hostMatches(url, DISABLE_HOSTS)) {
      detachBrowser(browser);
      applyTheme(null);
      return;
    }

    const key = cacheKey(url);

    if (forceFresh) {
      // Pre-delete so a fast subsequent TabSelect doesn't read the stale value.
      themeCache.delete(key);
      loadFrameScript(browser);
      return;
    }

    const rec = ensureAttached(browser);
    const currentSampler = rec?.loaded && rec.sourceRevision === sourceRevision
      && rec.documentId === documentId(browser) && rec.urlKey === key;
    if (currentSampler && rec.sample?.key === key) {
      applyTheme(rec.sample.theme);
      return;
    }

    const hit = cacheGet(key);
    if (hit !== undefined) {
      applyTheme(hit);
      // The cache is keyed by URL, not browser, so a hit can land on a tab whose
      // content process never loaded frame.js (a duplicate-URL tab, or one whose
      // mm was recreated). Ensure the listener is live, and load the frame script
      // once if it isn't already running — otherwise that tab gets the static tint
      // but no mutation/live-mode updates. Repeat visits keep the fast path.
      if (rec && !currentSampler) {
        loadFrameScript(browser);
      }
      return;
    }

    // Cache miss: need a sample.
    loadFrameScript(browser);
  }

  // Coalesce rapid back-to-back schedule calls into a single run. We race
  // requestAnimationFrame (yields to next paint) against a setTimeout safety net
  // (rAF can be throttled when the window is occluded); whichever fires first
  // wins and cancels the other.
  const SCHEDULE_SAFETY_MS = 100;
  let scheduled = false;
  let scheduledForceBrowser = null;
  let scheduleRafId = 0;
  let scheduleTimerId = 0;
  function runScheduled() {
    if (!scheduled) return; // already ran via the other path
    scheduled = false;
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduleRafId = 0;
    scheduleTimerId = 0;
    const force = scheduledForceBrowser === gBrowser.selectedBrowser;
    scheduledForceBrowser = null;
    sampleAndApply(gBrowser.selectedBrowser, force);
  }
  function scheduleSample(forceFresh = false) {
    if (disposed) return;
    if (forceFresh) scheduledForceBrowser = gBrowser.selectedBrowser;
    if (scheduled) return;
    scheduled = true;
    scheduleRafId = requestAnimationFrame(runScheduled);
    scheduleTimerId = setTimeout(runScheduled, SCHEDULE_SAFETY_MS);
  }

  // Named handlers so cleanup() can remove them.
  const onTabSelect = () => scheduleSample(false);
  const onTabClose = (evt) => { const browser = evt.target?.linkedBrowser; if (browser) detachBrowser(browser); };
  gBrowser.tabContainer.addEventListener('TabSelect', onTabSelect);
  gBrowser.tabContainer.addEventListener('TabClose', onTabClose);

  // Expanding a Glance removes zen-glance-tab without necessarily selecting a
  // different tab, so TabSelect alone cannot hand tint ownership to the child.
  // Observe only that one attribute and sample once it disappears from the
  // currently selected tab. Opening/closing Glance still uses the normal guards
  // and TabSelect path.
  const glanceObserver = new MutationObserver((records) => {
    const selectedTab = gBrowser.selectedTab;
    if (!selectedTab || selectedTab.hasAttribute(GLANCE_TAB_ATTRIBUTE)) return;
    if (records.some((record) => record.target === selectedTab)) scheduleSample(false);
  });
  glanceObserver.observe(gBrowser.tabContainer, {
    attributes: true,
    attributeFilter: [GLANCE_TAB_ATTRIBUTE],
    subtree: true,
  });

  // onLocationChange: top-level navigation/reload in active tab — bypass cache.
  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(progress, request, location, flags, isTabSwitch = false) {
      if (!progress?.isTopLevel) return;
      // tabbrowser.updateCurrentBrowser synthesizes this event with a fifth
      // argument on TabSelect. Treating it as navigation defeats every cache hit.
      if (isTabSwitch) return;
      // pushState/hash routes can change a static page without a theme mutation.
      scheduleSample(true);
    },
    onStateChange() {}, onProgressChange() {}, onStatusChange() {},
    onSecurityChange() {}, onContentBlockingEvent() {},
  };
  gBrowser.addProgressListener(progressListener);

  const onWindowLoad = () => { installBackdrops(); scheduleSample(false); };

  // Watch only native theme inputs, excluding every variable this mod writes.
  // Workspace/theme changes can alter the contrast needed for the same page.
  function nativeThemeSignature() {
    const elements = [root, ...document.querySelectorAll('#zen-browser-background, .zen-toolbar-background')];
    return elements.map(el => ['--zen-main-browser-background', '--zen-main-browser-background-toolbar',
      '--zen-primary-color', '--toolbar-color-scheme'].map(name => el.style.getPropertyValue(name)).join('|')).join(';')
      + ['class', 'theme-effective-id', 'theme-in-app', 'zen-single-toolbar', 'zen-compact-mode', 'zen-right-side']
        .map(name => root.getAttribute(name)).join('|');
  }
  let nativeThemeSig = nativeThemeSignature();
  const chromeThemeObserver = new MutationObserver(() => {
    if (disposed) return;
    const signature = nativeThemeSignature();
    if (signature === nativeThemeSig) return;
    nativeThemeSig = signature;
    installBackdrops();
    chromeBaseCache = null;
    if (MIX_AMOUNT > 0 && MIX_AMOUNT < 100) reapplyTint();
  });
  chromeThemeObserver.observe(root, { attributes: true,
    attributeFilter: ['style', 'class', 'theme-effective-id', 'theme-in-app', 'zen-single-toolbar', 'zen-compact-mode', 'zen-right-side'] });

  // OS color scheme change: every cached entry is now stale. Clear and re-sample.
  let colorSchemeQuery = null;
  let onColorSchemeChange = null;
  try {
    colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    onColorSchemeChange = () => {
      // Zen's chrome base is light-dark(), so it flips with the scheme — the cached
      // probe result is stale the moment this fires.
      chromeBaseCache = null;
      log('color-scheme changed, cache cleared');
      reapplyTint();
      invalidateSamples();
    };
    colorSchemeQuery.addEventListener('change', onColorSchemeChange);
  } catch {}

  // Live-apply the appearance prefs (mix / saturation / lightness / gap / radius /
  // disable-hosts) when they're changed from the Sine settings panel, so the
  // effect is visible without a restart. (The live-mode prefs are read once at
  // frame-script load and still need a restart — Sine shows a restart toast for
  // those.) A branch observer catches every zen.page-tint.* change; we act only on
  // the live-applicable ones.
  const prefObserver = {
    observe(_subject, topic, data) {
      if (topic !== 'nsPref:changed') return;
      switch (data) {
        case 'zen.page-tint.mix-amount':
          MIX_AMOUNT = clampInt(prefInt('zen.page-tint.mix-amount', 100), 0, 100);
          applyCssVarPrefs();   // push the new --zpt-strength
          reapplyTint();        // re-evaluate the tint (strength may have crossed 0)
          break;
        case 'zen.page-tint.saturation':
          SATURATION = clampInt(prefInt('zen.page-tint.saturation', 100), 0, 200);
          reapplyTint();
          break;
        case 'zen.page-tint.min-lightness':
        case 'zen.page-tint.max-lightness':
          MIN_LIGHT = clampInt(prefInt('zen.page-tint.min-lightness', 0), 0, 100);
          MAX_LIGHT = clampInt(prefInt('zen.page-tint.max-lightness', 100), 0, 100);
          reapplyTint();
          break;
        case 'zen.page-tint.brightness':
          BRIGHTNESS = clampInt(prefInt('zen.page-tint.brightness', 100), 0, 300);
          reapplyTint();
          break;
        case 'zen.page-tint.contrast':
          CONTRAST = clampInt(prefInt('zen.page-tint.contrast', 100), 0, 300);
          reapplyTint();
          break;
        case 'zen.page-tint.ambient-spread': {
          const wasOn = AMBIENT_SPREAD > 0;
          AMBIENT_SPREAD = clampInt(prefInt('zen.page-tint.ambient-spread', 0), 0, 100);
          // Crossing the 0 boundary flips whether the frame script computes edges at
          // all, so cached entries are now the wrong shape. Within a non-zero range
          // only the overlay alpha changes, which is a pure re-render.
          //
          // Cache invalidation and a revision change propagate settings lazily.
          // Do NOT iterate gBrowser.browsers to push config eagerly — that touches
          // .messageManager on every tab, which instantiates lazy session-restore
          // browsers and floods IPC. At this project's target tab counts it hangs the
          // window outright (observed at ~1660 tabs). scheduleSample handles the tab
          // the user is actually looking at; the rest fix themselves on select.
          if (wasOn !== (AMBIENT_SPREAD > 0)) {
            reapplyTint();
            invalidateSamples();
          } else {
            reapplyTint();
          }
          break;
        }
        case 'zen.page-tint.disable-hosts':
          DISABLE_HOSTS = parseHostList(prefStr('zen.page-tint.disable-hosts', ''));
          scheduleSample(false); // re-evaluate the active tab (clear or restore)
          break;
        case 'zen.page-tint.frame-gap':
        case 'zen.page-tint.frame-radius':
          applyCssVarPrefs();
          break;
        // Color-source changes invalidate every cached sample, since the cache
        // stores the resulting color rather than the pixels it came from. Clear
        // and force a fresh sample — same treatment as an OS color-scheme flip.
        // Other tabs re-sample on their next select, which is now a cache miss and
        // therefore reloads the frame script (re-pushing this config with it).
        case 'zen.page-tint.youtube-ambient':
        case 'zen.page-tint.light-average':
          YT_AMBIENT = prefBool('zen.page-tint.youtube-ambient', true);
          LIGHT_AVERAGE = prefBool('zen.page-tint.light-average', false);
          invalidateSamples();
          break;
      }
    },
  };
  try { Services.prefs.addObserver('zen.page-tint.', prefObserver); }
  catch (e) { log('pref observer add failed', e); }

  // Cleanup on window unload / mod hot-reload. Sine's addUnloadListener is
  // preferred (it survives hot-reload); fall back to a one-shot 'unload'.
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('load', onWindowLoad);
    try { gBrowser.removeProgressListener(progressListener); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabSelect', onTabSelect); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabClose', onTabClose); } catch {}
    try { glanceObserver.disconnect(); } catch {}
    try { chromeThemeObserver.disconnect(); } catch {}
    backdropResizeObserver?.disconnect();
    if (ambientClipRaf) cancelAnimationFrame(ambientClipRaf);
    ambientClipRaf = 0;
    try {
      if (colorSchemeQuery && onColorSchemeChange) colorSchemeQuery.removeEventListener('change', onColorSchemeChange);
    } catch {}
    try { Services.prefs.removeObserver('zen.page-tint.', prefObserver); } catch {}
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduled = false;
    // Detach each browser's listener and tell its content process to tear down
    // (stop observers / polling). Iterates live browsers because the per-browser
    // WeakMap isn't enumerable; closed tabs already detached on TabClose.
    //
    // Skips lazy (unrestored) tabs via tab.linkedPanel, which is tabbrowser.js's own
    // "browser is inserted" idiom. Reading .messageManager on a lazy browser trips
    // the property trap that calls _insertBrowser() — messageManager is not on the
    // safe-while-lazy list — so an unguarded sweep instantiates every restored-
    // session tab just to tear it down. At 1600+ tabs that's a multi-second hang on
    // window close or mod hot-reload. A lazy tab never ran the frame script and never
    // had a listener attached, so there is nothing there to clean up anyway.
    try {
      for (const tab of gBrowser.tabs) {
        if (!tab.linkedPanel) continue;
        const browser = tab.linkedBrowser;
        if (!browser) continue;
        detachBrowser(browser);
      }
    } catch {}
    applyTheme(null);
    root.removeAttribute('zen-page-tint-active');
    root.removeAttribute('zen-page-tint-live');
    for (const overlay of tintBackdrops) overlay.remove();
    tintBackdrops.length = 0;
    windowBackdrop = null;
    for (const name of originalStyles.keys()) restoreStyle(name);
  };
  if (typeof addUnloadListener === 'function') addUnloadListener(cleanup);
  else window.addEventListener('unload', cleanup, { once: true });

  // Initialize only after all state and cleanup handlers exist.
  root.style.setProperty('--zpt-live-smoothing-ms', `${LIVE_SMOOTH_MS}ms`);
  applyCssVarPrefs();
  root.setAttribute('zen-page-tint-active', 'on');
  if (LIVE_MODE) root.setAttribute('zen-page-tint-live', 'on');
  if (document.readyState === 'complete') onWindowLoad();
  else window.addEventListener('load', onWindowLoad, { once: true });

  log('initialized');
})();
