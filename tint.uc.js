// ==UserScript==
// @name           Zen Page Tint
// @description    Adaptive Zen chrome color from the active page
// @version        1.0.0
// ==/UserScript==

(() => {
  'use strict';

  // DEBUG is read from a pref so it can be toggled at runtime via about:config
  // (zen.page-tint.debug = true). Defaults to false. Falls back to false if Services
  // isn't available for any reason.
  let DEBUG = false;
  try {
    DEBUG = Services.prefs.getBoolPref('zen.page-tint.debug', false);
  } catch (e) {}
  const log = DEBUG ? (...args) => console.log('[zen-page-tint]', ...args) : () => {};

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const FRAME_SCRIPT_URL = 'chrome://sine/content/zen-page-tint/frame.js';
  const root = document.documentElement;

  // Cache: origin+path → bg string (canonical rgb()). Bounded LRU (true access-order).
  // We store only `bg` because `fg` is always derived deterministically via readableFg(bg).
  // Storing fg too would double cache memory and risk drift if the contrast rule changes.
  const themeCache = new Map();
  const CACHE_MAX = 500;

  // Map browser → message listener fn, so we can removeMessageListener on TabClose.
  // Acts as both the "have we attached?" check and the cleanup ref — single source of truth.
  const browserListeners = new WeakMap();
  // NOTE: we intentionally do NOT track "frame script loaded per browser". When Auto Tab
  // Discard unloads + restores a tab, the content process is recreated but the browser
  // object is the same. A "loaded once per browser" WeakSet would short-circuit re-loading
  // and the new content process would never get the script, breaking samples on restored
  // tabs. The frame.js init guard handles same-process double-loads cheaply, so it's safe
  // to call loadFrameScript every time we need a fresh sample.

  function parseRgb(color) {
    if (!color) return null;
    const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  // Pick black or white text for max contrast against given bg (Rec 601 luminance).
  // The frame script normalizes ALL bg values to canonical rgb() before sending, so
  // parseRgb's narrow regex is sufficient here — no hex/HSL/named to handle.
  function readableFg(bg) {
    const rgb = parseRgb(bg);
    if (!rgb) return null;
    const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.55 ? '#000' : '#fff';
  }

  function applyTheme(bg) {
    if (bg) {
      const fg = readableFg(bg) || 'inherit';
      root.style.setProperty('--zen-tab-header-background', bg);
      root.style.setProperty('--zen-tab-header-foreground', fg);
      root.setAttribute('zen-page-tint', 'on');
    } else {
      root.style.removeProperty('--zen-tab-header-background');
      root.style.removeProperty('--zen-tab-header-foreground');
      root.removeAttribute('zen-page-tint');
    }
  }

  function cacheKey(uri) {
    try {
      const u = new URL(uri);
      return u.origin + u.pathname;
    } catch {
      return uri || '';
    }
  }

  // True LRU semantics: on access, move entry to the end of insertion order.
  function cacheGet(key) {
    const value = themeCache.get(key);
    if (value !== undefined) {
      themeCache.delete(key);
      themeCache.set(key, value);
    }
    return value;
  }

  function cacheSet(key, value) {
    if (themeCache.has(key)) {
      themeCache.delete(key); // re-insert at tail
    } else if (themeCache.size >= CACHE_MAX) {
      // Evict least-recently-used (head of insertion order).
      themeCache.delete(themeCache.keys().next().value);
    }
    themeCache.set(key, value);
  }

  // Add the persistent chrome-side message listener for a browser. Idempotent.
  function attachListener(browser) {
    if (!browser || browserListeners.has(browser)) return;
    const mm = browser.messageManager;
    if (!mm?.addMessageListener) return;

    const listener = (msg) => {
      const url = browser.currentURI?.spec || '';
      if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return;
      const key = cacheKey(url);
      const theme = msg.data || {};
      log('message received', { source: theme.source, bg: theme.bg, url: theme.href || url });
      if (!theme.bg) return;
      cacheSet(key, theme.bg);
      if (gBrowser.selectedBrowser === browser) {
        applyTheme(theme.bg);
        log('applied', { bg: theme.bg });
      }
    };

    try {
      mm.addMessageListener(MESSAGE_NAME, listener);
      browserListeners.set(browser, listener);
      log('listener attached');
    } catch (e) {
      log('listener attach failed', e);
    }
  }

  // Load the frame script into the browser's content process.
  // Called only when we actually need a fresh sample (cache miss / forceFresh).
  // Safe to call repeatedly: the frame.js init guard short-circuits when the current
  // content process already has the observer set up. After Auto Tab Discard recreates
  // a content process, the guard is undefined in the new scope and the script re-inits.
  function loadFrameScript(browser) {
    if (!browser) return;
    const mm = browser.messageManager;
    if (!mm?.loadFrameScript) return;
    try {
      mm.loadFrameScript(FRAME_SCRIPT_URL, false);
      log('frame script load requested');
    } catch (e) {
      log('frame script load failed', e);
    }
  }

  // Tear down our refs for a browser (called on TabClose).
  function detachBrowser(browser) {
    if (!browser) return;
    const mm = browser.messageManager;
    const listener = browserListeners.get(browser);
    if (mm && listener) {
      try { mm.removeMessageListener(MESSAGE_NAME, listener); } catch {}
    }
    browserListeners.delete(browser);
    log('detached');
  }

  function sampleAndApply(browser, forceFresh = false) {
    if (!browser) return;
    const url = browser.currentURI?.spec || '';

    // Skip internal pages — Zen owns these.
    if (url.startsWith('about:') || url.startsWith('chrome:') || url === '') {
      applyTheme(null);
      return;
    }

    const key = cacheKey(url);
    if (!forceFresh) {
      const hit = cacheGet(key);
      if (hit) {
        applyTheme(hit);
        // Make sure listener is attached so future mutations from this tab reach us.
        // Skip the frame-script IPC — observer is already running in content.
        attachListener(browser);
        return;
      }
    } else {
      // Pre-delete so a fast subsequent TabSelect doesn't read the stale value before
      // the fresh sample comes back over IPC.
      themeCache.delete(key);
    }

    // Cache miss or forced fresh: need a sample. Ensure both sides are wired up.
    attachListener(browser);
    loadFrameScript(browser);
  }

  // Coalesce rapid back-to-back schedule calls (TabSelect followed immediately by
  // onLocationChange, two onLocationChanges from a redirect, etc.) into a single rAF.
  // If any caller asked for forceFresh, the coalesced run honors it.
  let scheduled = false;
  let scheduledForce = false;
  function scheduleSample(forceFresh = false) {
    if (forceFresh) scheduledForce = true;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const force = scheduledForce;
      scheduled = false;
      scheduledForce = false;
      sampleAndApply(gBrowser.selectedBrowser, force);
    });
  }

  // TabSelect: user switched tabs. Cache hit fast path; else sample.
  gBrowser.tabContainer.addEventListener('TabSelect', () => scheduleSample(false));

  // TabClose: clean up our per-browser state.
  gBrowser.tabContainer.addEventListener('TabClose', (evt) => {
    const browser = evt.target?.linkedBrowser;
    if (browser) detachBrowser(browser);
  });

  // onLocationChange: top-level navigation/reload in active tab — bypass cache.
  // Filter isTopLevel so iframe/subframe loads (OAuth popups, ad frames) don't trigger
  // wasted re-samples.
  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(progress, request, location, flags) {
      if (!progress?.isTopLevel) return;
      if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
      scheduleSample(true);
    },
    onStateChange() {},
    onProgressChange() {},
    onStatusChange() {},
    onSecurityChange() {},
    onContentBlockingEvent() {},
  };
  gBrowser.addProgressListener(progressListener);

  // Initial run after the window finishes loading.
  if (document.readyState === 'complete') {
    scheduleSample(false);
  } else {
    window.addEventListener('load', () => scheduleSample(false), { once: true });
  }

  // OS color scheme change (user toggles macOS appearance, etc.). Every cached entry
  // is now stale — sites that respect prefers-color-scheme will render the other
  // theme on next visit. Clear the cache so we re-sample fresh, then refresh the
  // active tab immediately.
  let colorSchemeQuery = null;
  let onColorSchemeChange = null;
  try {
    colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    onColorSchemeChange = () => {
      themeCache.clear();
      log('color-scheme changed, cache cleared');
      scheduleSample(true);
    };
    colorSchemeQuery.addEventListener('change', onColorSchemeChange);
  } catch {}

  // Cleanup on window unload. Sine's addUnloadListener is preferred when available
  // (it survives mod hot-reload); fall back to a one-shot 'unload' on the window.
  const cleanup = () => {
    try { gBrowser.removeProgressListener(progressListener); } catch {}
    try {
      if (colorSchemeQuery && onColorSchemeChange) {
        colorSchemeQuery.removeEventListener('change', onColorSchemeChange);
      }
    } catch {}
    applyTheme(null);
  };
  if (typeof addUnloadListener === 'function') {
    addUnloadListener(cleanup);
  } else {
    window.addEventListener('unload', cleanup, { once: true });
  }

  log('initialized');
})();
