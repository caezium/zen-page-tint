// ==UserScript==
// @name           Zen Page Tint
// @description    Adaptive Zen chrome color from the active page
// @version        1.2.0
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
  //     The IDLE/ceiling poll interval. Sampling is adaptive: while the page
  //     color is actively changing we poll faster (down to rate/4, floored at
  //     250ms / 4 Hz), then back off to this rate once the color is stable.
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

  // Parse the allowlist once. Supports exact-host and leading-wildcard patterns
  // ('*.example.com' matches 'foo.example.com' but not 'example.com'). Matched
  // against URL.hostname, so entries are port-independent.
  const LIVE_HOSTS = LIVE_HOSTS_RAW.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  function hostInLiveAllowlist(url) {
    if (LIVE_HOSTS.length === 0) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const pattern of LIVE_HOSTS) {
        if (pattern.startsWith('*.')) { if (host.endsWith(pattern.slice(1))) return true; }
        else if (host === pattern) return true;
      }
    } catch {}
    return false;
  }

  log('live-mode pref =', LIVE_MODE,
    '| rate =', LIVE_RATE_MS, 'ms',
    '| smoothing =', LIVE_SMOOTH_MS, 'ms',
    '| threshold =', LIVE_THRESHOLD,
    '| always-on =', LIVE_ALWAYS_ON,
    '| allowlist =', LIVE_HOSTS.length ? LIVE_HOSTS.join(', ') : '(none)');

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
  const TEARDOWN_MESSAGE_NAME = 'zen-page-tint:teardown';
  const FRAME_SCRIPT_URL = 'chrome://sine/content/zen-page-tint/frame.js';
  const root = document.documentElement;

  // Smoothing transitions are always armed, so the smoothing variable is set
  // unconditionally.
  root.style.setProperty('--zpt-live-smoothing-ms', `${LIVE_SMOOTH_MS}ms`);

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

  // Track the last applied color so switching between same-colored tabs (the
  // common case — most pages are white or one of a few grays) doesn't rewrite the
  // CSS variables and trigger a full restyle of every var() consumer (including
  // the per-tab rules × thousands of tabs) plus a re-armed 1s fade.
  let lastAppliedBg = undefined;
  function applyTheme(bg) {
    const next = bg || null;
    if (next === lastAppliedBg) return;
    lastAppliedBg = next;
    if (next) {
      const fg = readableFg(next) || 'inherit';
      root.style.setProperty('--zen-tab-header-background', next);
      root.style.setProperty('--zen-tab-header-foreground', fg);
      root.setAttribute('zen-page-tint', 'on');
    } else {
      root.style.removeProperty('--zen-tab-header-background');
      root.style.removeProperty('--zen-tab-header-foreground');
      root.removeAttribute('zen-page-tint');
    }
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

  function makeListener(browser) {
    return (msg) => {
      const theme = msg.data || {};
      const current = browser.currentURI?.spec || '';
      // Key by the URL the sample was actually taken from (sent as href), not the
      // browser's current URI — an in-flight sample from the previous document can
      // arrive after navigation, and must not be cached/applied under the new URL.
      const sampled = theme.href || current;
      if (isInternalUrl(sampled)) return;
      const key = cacheKey(sampled);
      const isCurrent = cacheKey(current) === key;
      log('message received', { source: theme.source, bg: theme.bg, url: sampled });

      if (theme.bg) {
        cacheSet(key, theme.bg);
        if (isCurrent && gBrowser.selectedBrowser === browser) {
          applyTheme(theme.bg);
          log('applied', { bg: theme.bg });
        }
      } else if (isCurrent && gBrowser.selectedBrowser === browser) {
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
    if (rec && rec.mm && rec.listener) {
      try { rec.mm.removeMessageListener(MESSAGE_NAME, rec.listener); } catch {}
    }
    const listener = makeListener(browser);
    try { mm.addMessageListener(MESSAGE_NAME, listener); }
    catch (e) {
      // Drop any stale record so the next attempt retries cleanly, rather than
      // leaving a record with loaded:true that makes the cache-hit path skip the
      // frame-script reload for this (still-unlistened) browser.
      log('listener attach failed', e);
      browserState.delete(browser);
      return null;
    }
    rec = { mm, listener, loaded: false };
    browserState.set(browser, rec);
    log('listener attached');
    return rec;
  }

  function sendConfig(browser) {
    if (!LIVE_MODE) return;
    const mm = browser.messageManager;
    if (!mm?.sendAsyncMessage) return;
    try {
      const url = browser.currentURI?.spec || '';
      mm.sendAsyncMessage(CONFIG_MESSAGE_NAME, {
        liveRateMs: LIVE_RATE_MS,
        alwaysOn: LIVE_ALWAYS_ON || hostInLiveAllowlist(url),
        threshold: LIVE_THRESHOLD,
        debug: DEBUG,
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
    const rec = browserState.get(browser);
    if (rec && rec.mm && rec.listener) {
      try { rec.mm.removeMessageListener(MESSAGE_NAME, rec.listener); } catch {}
    }
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
    const url = browser.currentURI?.spec || '';

    if (isInternalUrl(url)) { applyTheme(null); return; }

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
    onColorSchemeChange = () => { themeCache.clear(); log('color-scheme changed, cache cleared'); scheduleSample(true); };
    colorSchemeQuery.addEventListener('change', onColorSchemeChange);
  } catch {}

  // Cleanup on window unload / mod hot-reload. Sine's addUnloadListener is
  // preferred (it survives hot-reload); fall back to a one-shot 'unload'.
  const cleanup = () => {
    try { gBrowser.removeProgressListener(progressListener); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabSelect', onTabSelect); } catch {}
    try { gBrowser.tabContainer.removeEventListener('TabClose', onTabClose); } catch {}
    try {
      if (colorSchemeQuery && onColorSchemeChange) colorSchemeQuery.removeEventListener('change', onColorSchemeChange);
    } catch {}
    try { if (scheduleRafId) cancelAnimationFrame(scheduleRafId); } catch {}
    try { if (scheduleTimerId) clearTimeout(scheduleTimerId); } catch {}
    scheduled = false;
    // Detach every open browser's listener and tell its content process to tear
    // down (stop observers / polling). Iterates live browsers because the
    // per-browser WeakMap isn't enumerable; closed tabs already detached on
    // TabClose.
    try { for (const browser of gBrowser.browsers) { detachBrowser(browser); sendTeardown(browser); } } catch {}
    applyTheme(null);
    root.removeAttribute('zen-page-tint-active');
    root.removeAttribute('zen-page-tint-live');
  };
  if (typeof addUnloadListener === 'function') addUnloadListener(cleanup);
  else window.addEventListener('unload', cleanup, { once: true });

  log('initialized');
})();
