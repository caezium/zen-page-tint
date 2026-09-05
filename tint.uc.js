// ==UserScript==
// @name           Zen Page Tint
// @description    Adaptive Zen chrome color from the active page
// @version        2.0.1
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

  // DEBUG is read from a pref so it can be toggled at runtime via about:config
  // (zen.page-tint.debug = true). Defaults to false.
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
  const LIVE_RATE_MS = prefInt('zen.page-tint.live-mode-rate-ms', 2000);
  const LIVE_SMOOTH_MS = prefInt('zen.page-tint.live-mode-smoothing-ms', 1000);
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
  //     linear before averaging and weight vivid cells above gray ones. More
  //     accurate physically, and noticeably brighter/more saturated on mixed
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
  //     reproduced by mixing one color — see style.css --zpt-tint / the rim rule.
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
  // Ceiling on the gradient overlay's alpha. Full opacity would let an edge color
  // completely replace the base tint at the extremes, which breaks the readable-
  // foreground pick (that's computed against the base). Capping keeps the endpoints
  // tethered to the base so text contrast survives at any spread.
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

  // Smoothing transitions are always armed, so the smoothing variable is set
  // unconditionally.
  root.style.setProperty('--zpt-live-smoothing-ms', `${LIVE_SMOOTH_MS}ms`);

  // Tint strength / frame gap / radius are pref-driven (Sine settings panel);
  // apply at startup.
  applyCssVarPrefs();

  // Persistent "mod is active in this window" marker. Smoothing transitions are
  // armed against THIS attribute (not zen-page-tint) so they survive leaving a
  // tinted page for about:/chrome:. Removed only on cleanup.
  root.setAttribute('zen-page-tint-active', 'on');
  if (LIVE_MODE) root.setAttribute('zen-page-tint-live', 'on');

  function isInternalUrl(url) {
    return !url || url.startsWith('about:') || url.startsWith('chrome:');
  }

  // Cache: origin+path → bg string (canonical rgb()). Bounded LRU (true access-order).
  // Only `bg` is stored; `fg` is derived deterministically via readableFg(bg).
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

  // Pick black or white text for max contrast (Rec 601 luminance). The frame
  // script normalizes ALL bg values to canonical rgb() before sending.
  function readableFg(bg) {
    const rgb = parseRgb(bg);
    if (!rgb) return null;
    const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.55 ? '#000' : '#fff';
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

  // ---- Opaque pre-blend (tint strength) ----
  //
  // Strength used to be an ALPHA: --zpt-tint was the page color at that opacity,
  // laid over Zen's chrome so the workspace gradient showed through. That model is
  // depth-dependent, and Zen's chrome nests four deep, so painting the same
  // translucent color on an element and its ancestors composites to 1-(1-s)^depth
  // rather than s. Two consequences, both bad: surfaces at different depths
  // resolved to visibly different colors (the sidebar vs the frame around the
  // page), and the slider was badly miscalibrated — at depth 4, strength 50
  // rendered 94% and anything above ~40 was indistinguishable from 100.
  //
  // Now the blend happens here and the painted color is OPAQUE. An opaque color
  // painted by four nested elements looks identical to one painted once, so depth
  // stops mattering entirely and strength 50 means 50.
  //
  // Tradeoff, deliberately accepted: Zen's workspace gradient no longer shows
  // through below 100 — you get a blend against its flat base color instead. In
  // practice the gradient was only 6% visible at strength 50 under the old model,
  // so little is lost.

  // Zen's chrome base, resolved to rgb. getPropertyValue() hands back custom
  // properties as unresolved token streams (light-dark(...), color-mix(...)), so
  // read it through a throwaway element whose `color` computes to a real value.
  // Cached because this forces a style flush; invalidated on color-scheme change.
  let chromeBaseCache = null;
  function chromeBaseColor() {
    if (chromeBaseCache) return chromeBaseCache;
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;'
        + 'color:var(--zen-main-browser-background)';
      root.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      if (parseRgb(resolved)) chromeBaseCache = resolved;
    } catch (e) { log('chrome base probe failed', e); }
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
  //
  // Scaled by MIX_AMOUNT as well, because the edges are a deviation FROM the base
  // surface and that surface composites to MIX_AMOUNT. Pinning edge alpha to spread
  // alone holds them at full opacity while the base fades: measured at strength 50 /
  // spread 100, the stops painted at 0.7 over a base whose per-layer alpha was 0.159,
  // so the ends of the sidebar read as separate blocks of color against a nearly
  // untinted middle. Scaling keeps the pair proportional, which also makes spread and
  // strength independent knobs — spread sets how much directional variation you see
  // relative to the tint, not in absolute terms.
  function edgeStop(color) {
    const rgb = parseRgb(color);
    if (!rgb) return null;
    const alpha = (AMBIENT_SPREAD / 100) * EDGE_ALPHA_MAX * (MIX_AMOUNT / 100);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
  }

  // Push the CSS-var appearance prefs into their variables, overriding the
  // stylesheet defaults. Idempotent — safe to call on every pref change.
  //   --zpt-strength is the tint OVERLAY opacity (consumed by style.css's
  //   --zpt-tint / the rim box-shadow): 100% = opaque page tint, 0% = none.
  // How many times the tint gets painted over any given pixel. Zen's chrome nests
  // #main-window > #browser > (#appcontent | #navigator-toolbox > #titlebar), and
  // the surround picks up a 4th coat from the ring box-shadow, so every surface
  // lands on 4. Boxes that would have been a 5th (the sidebar button boxes, the
  // media card) are held transparent in style.css specifically to keep this uniform.
  //
  // It has to be uniform for the compensation below to work. If a future Zen
  // release re-nests the chrome, the symptom is surfaces disagreeing again below
  // full strength — the layer dump under `debug` is what to check.
  const TINT_DEPTH = 4;

  // Per-layer alpha that composites to MIX_AMOUNT across TINT_DEPTH layers.
  // Stacking alpha is 1-(1-a)^n, so inverting gives a = 1-(1-s)^(1/n). Without
  // this the slider was wildly non-linear: 50 rendered as 94%, and everything past
  // ~40 was indistinguishable from fully opaque.
  function compensatedStrength(amount) {
    const s = Math.max(0, Math.min(1, amount / 100));
    if (s >= 1) return 100;
    return (1 - Math.pow(1 - s, 1 / TINT_DEPTH)) * 100;
  }

  function applyCssVarPrefs() {
    root.style.setProperty('--zpt-strength', `${compensatedStrength(MIX_AMOUNT).toFixed(2)}%`);
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
    if (rawBg && MIX_AMOUNT > 0) {
      // The painted value stays the full page color; CSS applies strength as alpha
      // (--zpt-strength, already depth-compensated). The FOREGROUND pick, though,
      // has to run against an approximation of what actually lands on screen —
      // below full strength that's the page color composited over Zen's base, so
      // picking contrast against the raw page color could put black text on chrome
      // that has already gone dark.
      const tint = transformColor(rawBg);
      const fg = readableFg(blendToChromeBase(tint, MIX_AMOUNT)) || 'inherit';
      root.style.setProperty('--zen-tab-header-background', tint);
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
          // Edge alpha carries spread AND strength (see edgeStop): the stop overlays
          // a surface that itself composites to MIX_AMOUNT, so holding the deviation
          // at full opacity while the surface fades is what made the sidebar ends
          // read as blocks of unrelated color at low strength.
          const stop = rawEdges[key] ? edgeStop(transformColor(rawEdges[key])) : null;
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
      root.style.removeProperty('--zen-tab-header-background');
      root.style.removeProperty('--zen-tab-header-foreground');
      root.removeAttribute('zen-page-tint');
      clearEdgeVars();
    }
  }

  // One-shot diagnostic: report what each chrome layer actually paints once a tint
  // is live. The rim and the sidebar can resolve to different opacities depending
  // on how many ancestors happen to paint the translucent tint over a given pixel,
  // and that stack can't be derived reliably from Zen's stylesheets — some of it is
  // native macOS material (#zen-browser-background uses -moz-default-appearance),
  // which doesn't composite like a CSS background. So read the computed values
  // instead of inferring them. DEBUG-gated and fires once per window.
  let dumpedChromeLayers = false;
  function dumpChromeLayers() {
    if (!DEBUG || dumpedChromeLayers) return;
    dumpedChromeLayers = true;
    try {
      const rs = getComputedStyle(root);
      const lines = ['[zen-page-tint] chrome layer dump'];
      for (const v of ['--zpt-tint', '--zpt-strength', '--zen-tab-header-background']) {
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
    try { const u = new URL(uri); return u.origin + u.pathname; }
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

  // Per-browser record: { mm, listener, loaded }. Keyed by browser element (weak),
  // but we track the messageManager identity too: a discarded/restored tab,
  // remoteness change, or tab tear-off recreates the mm, and the listener must be
  // re-attached to the live one (the old "have we attached?" boolean guard left
  // restored tabs with no listener at all).
  const browserState = new WeakMap();

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
      const theme = msg.data || {};
      const current = browser.currentURI?.spec || '';
      // Key by the URL the sample was actually taken from (sent as href), not the
      // browser's current URI — an in-flight sample from the previous document can
      // arrive after navigation, and must not be cached/applied under the new URL.
      const sampled = theme.href || current;
      if (isInternalUrl(sampled) || hostMatches(sampled, DISABLE_HOSTS)) return;
      const key = cacheKey(sampled);
      const isCurrent = cacheKey(current) === key;
      const canApply = isCurrent && gBrowser.selectedBrowser === browser && !isTransientGlance(browser);
      log('message received', { source: theme.source, bg: theme.bg, url: sampled });

      if (theme.bg) {
        // Cache the whole sampled theme (color + directional edges), not just the
        // color: a cache hit has to be able to restore the gradient too, or
        // revisiting a tab would silently drop to a flat tint.
        cacheSet(key, { bg: theme.bg, edges: theme.edges || null });
        if (canApply) {
          applyTheme({ bg: theme.bg, edges: theme.edges || null });
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
    const readyListener = () => { log('frame script ready; pushing config'); sendConfig(browser); };
    try {
      mm.addMessageListener(MESSAGE_NAME, listener);
      mm.addMessageListener(READY_MESSAGE_NAME, readyListener);
    }
    catch (e) {
      // Drop any stale record so the next attempt retries cleanly, rather than
      // leaving a record with loaded:true that makes the cache-hit path skip the
      // frame-script reload for this (still-unlistened) browser.
      log('listener attach failed', e);
      browserState.delete(browser);
      return null;
    }
    rec = { mm, listener, readyListener, loaded: false };
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
    const mm = browser.messageManager;
    if (!mm?.sendAsyncMessage) return;
    try {
      const url = browser.currentURI?.spec || '';
      mm.sendAsyncMessage(CONFIG_MESSAGE_NAME, {
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
    const mm = browser.messageManager;
    if (!mm?.loadFrameScript) return;
    try {
      mm.loadFrameScript(FRAME_SCRIPT_URL, false);
      sendConfig(browser);
      const rec = browserState.get(browser);
      if (rec) rec.loaded = true;
      log('frame script load requested');
    } catch (e) { log('frame script load failed', e); }
  }

  function detachBrowser(browser) {
    if (!browser) return;
    removeListeners(browserState.get(browser));
    browserState.delete(browser);
    log('detached');
  }

  function sendTeardown(browser) {
    const mm = browser.messageManager;
    if (!mm?.sendAsyncMessage) return;
    try { mm.sendAsyncMessage(TEARDOWN_MESSAGE_NAME, {}); } catch {}
  }

  function sampleAndApply(browser, forceFresh = false) {
    if (!browser) return;
    if (isTransientGlance(browser)) {
      log('transient Glance selected; preserving parent tint');
      return;
    }
    const url = browser.currentURI?.spec || '';

    // Internal pages and per-site-disabled hosts keep Zen's own chrome (no tint).
    if (isInternalUrl(url) || hostMatches(url, DISABLE_HOSTS)) { applyTheme(null); return; }

    const key = cacheKey(url);

    if (forceFresh) {
      // Pre-delete so a fast subsequent TabSelect doesn't read the stale value.
      themeCache.delete(key);
      ensureAttached(browser);
      loadFrameScript(browser);
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
      const rec = ensureAttached(browser);
      if (rec && !rec.loaded) loadFrameScript(browser);
      return;
    }

    // Cache miss: need a sample.
    ensureAttached(browser);
    loadFrameScript(browser);
  }

  // Coalesce rapid back-to-back schedule calls into a single run. We race
  // requestAnimationFrame (yields to next paint) against a setTimeout safety net
  // (rAF can be throttled when the window is occluded); whichever fires first
  // wins and cancels the other.
  const SCHEDULE_SAFETY_MS = 100;
  let scheduled = false;
  let scheduledForce = false;
  let scheduleRafId = 0;
  let scheduleTimerId = 0;
  function runScheduled() {
    if (!scheduled) return; // already ran via the other path
    scheduled = false;
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduleRafId = 0;
    scheduleTimerId = 0;
    const force = scheduledForce;
    scheduledForce = false;
    sampleAndApply(gBrowser.selectedBrowser, force);
  }
  function scheduleSample(forceFresh = false) {
    if (forceFresh) scheduledForce = true;
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
    onLocationChange(progress, request, location, flags) {
      if (!progress?.isTopLevel) return;
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
      scheduleSample(true);
    },
    onStateChange() {}, onProgressChange() {}, onStatusChange() {},
    onSecurityChange() {}, onContentBlockingEvent() {},
  };
  gBrowser.addProgressListener(progressListener);

  // Initial run after the window finishes loading.
  if (document.readyState === 'complete') scheduleSample(false);
  else window.addEventListener('load', () => scheduleSample(false), { once: true });

  // OS color scheme change: every cached entry is now stale. Clear and re-sample.
  let colorSchemeQuery = null;
  let onColorSchemeChange = null;
  try {
    colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    onColorSchemeChange = () => {
      themeCache.clear();
      // Zen's chrome base is light-dark(), so it flips with the scheme — the cached
      // probe result is stale the moment this fires.
      chromeBaseCache = null;
      log('color-scheme changed, cache cleared');
      scheduleSample(true);
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
          // Clearing the cache is the ONLY propagation needed: every tab becomes a
          // miss, and the miss path already calls loadFrameScript() → sendConfig().
          // Do NOT iterate gBrowser.browsers to push config eagerly — that touches
          // .messageManager on every tab, which instantiates lazy session-restore
          // browsers and floods IPC. At this project's target tab counts it hangs the
          // window outright (observed at ~1660 tabs). scheduleSample handles the tab
          // the user is actually looking at; the rest fix themselves on select.
          if (wasOn !== (AMBIENT_SPREAD > 0)) {
            themeCache.clear();
            scheduleSample(true);
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
          themeCache.clear();
          scheduleSample(true);
          break;
      }
    },
  };
  try { Services.prefs.addObserver('zen.page-tint.', prefObserver); }
  catch (e) { log('pref observer add failed', e); }

  // Cleanup on window unload / mod hot-reload. Sine's addUnloadListener is
  // preferred (it survives hot-reload); fall back to a one-shot 'unload'.
  const cleanup = () => {
    try { gBrowser.removeProgressListener(progressListener); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabSelect', onTabSelect); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabClose', onTabClose); } catch {}
    try { glanceObserver.disconnect(); } catch {}
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
        sendTeardown(browser);
      }
    } catch {}
    applyTheme(null);
    root.removeAttribute('zen-page-tint-active');
    root.removeAttribute('zen-page-tint-live');
  };
  if (typeof addUnloadListener === 'function') addUnloadListener(cleanup);
  else window.addEventListener('unload', cleanup, { once: true });

  log('initialized');
})();
