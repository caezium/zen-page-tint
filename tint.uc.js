// ==UserScript==
// @name           Zen Page Tint
// @description    Adaptive Zen chrome color from the active page
// @version        0.1.0
// ==/UserScript==

(() => {
  'use strict';

  const DEBUG = false;
  const log = DEBUG ? (...args) => console.log('[zen-page-tint]', ...args) : () => {};

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const FRAME_SCRIPT_URL = 'chrome://sine/content/zen-page-tint/frame.js';
  const root = document.documentElement;

  // Cache: origin+path → { bg, fg }. Bounded LRU.
  const themeCache = new Map();
  const CACHE_MAX = 500;

  const chromeListened = new WeakSet();
  const browserListeners = new WeakMap();

  function parseRgb(color) {
    if (!color) return null;
    const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  function readableFg(bg) {
    const rgb = parseRgb(bg);
    if (!rgb) return null;
    const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.55 ? '#000' : '#fff';
  }

  function applyTheme(bg, fg) {
    if (bg) {
      root.style.setProperty('--zen-tab-header-background', bg);
      root.style.setProperty('--zen-tab-header-foreground', fg || readableFg(bg) || 'inherit');
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

  function cacheGet(key) {
    const value = themeCache.get(key);
    if (value) {
      themeCache.delete(key);
      themeCache.set(key, value);
    }
    return value;
  }

  function cacheSet(key, value) {
    if (themeCache.has(key)) {
      themeCache.delete(key);
    } else if (themeCache.size >= CACHE_MAX) {
      themeCache.delete(themeCache.keys().next().value);
    }
    themeCache.set(key, value);
  }

  function attachListener(browser) {
    if (!browser || chromeListened.has(browser)) return;
    const mm = browser.messageManager;
    if (!mm?.addMessageListener) return;

    const listener = (msg) => {
      const url = browser.currentURI?.spec || '';
      if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return;
      const key = cacheKey(url);
      const theme = msg.data || {};
      if (!theme.bg) return;
      const fg = readableFg(theme.bg) || theme.fg || null;
      cacheSet(key, { bg: theme.bg, fg });
      if (gBrowser.selectedBrowser === browser) applyTheme(theme.bg, fg);
    };

    try {
      mm.addMessageListener(MESSAGE_NAME, listener);
      chromeListened.add(browser);
      browserListeners.set(browser, listener);
    } catch (e) {
      log('listener attach failed', e);
    }
  }

  function loadFrameScript(browser) {
    if (!browser) return;
    const mm = browser.messageManager;
    if (!mm?.loadFrameScript) return;
    try {
      mm.loadFrameScript(FRAME_SCRIPT_URL, false);
    } catch (e) {
      log('frame script load failed', e);
    }
  }

  function detachBrowser(browser) {
    if (!browser) return;
    const mm = browser.messageManager;
    const listener = browserListeners.get(browser);
    if (mm && listener) {
      try { mm.removeMessageListener(MESSAGE_NAME, listener); } catch {}
    }
    browserListeners.delete(browser);
    chromeListened.delete(browser);
  }

  function sampleAndApply(browser, forceFresh = false) {
    if (!browser) return;
    const url = browser.currentURI?.spec || '';

    if (url.startsWith('about:') || url.startsWith('chrome:') || url === '') {
      applyTheme(null);
      return;
    }

    const key = cacheKey(url);
    if (!forceFresh) {
      const hit = cacheGet(key);
      if (hit) {
        applyTheme(hit.bg, hit.fg);
        attachListener(browser);
        return;
      }
    }

    attachListener(browser);
    loadFrameScript(browser);
  }

  function scheduleSample(forceFresh = false) {
    // Yield a frame so the tab switch paints first.
    requestAnimationFrame(() => sampleAndApply(gBrowser.selectedBrowser, forceFresh));
  }

  gBrowser.tabContainer.addEventListener('TabSelect', () => scheduleSample(false));

  gBrowser.tabContainer.addEventListener('TabClose', (evt) => {
    const browser = evt.target?.linkedBrowser;
    if (browser) detachBrowser(browser);
  });

  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(progress, request, location, flags) {
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

  if (document.readyState === 'complete') {
    scheduleSample(false);
  } else {
    window.addEventListener('load', () => scheduleSample(false), { once: true });
  }

  if (typeof addUnloadListener === 'function') {
    addUnloadListener(() => {
      try { gBrowser.removeProgressListener(progressListener); } catch {}
      applyTheme(null);
    });
  }
})();
