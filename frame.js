// Zen Page Tint — frame script
// Loaded into the content process via mm.loadFrameScript.
// Reads the page's effective background color, observes theme-related DOM mutations,
// re-samples on load/pageshow, and pushes results to the chrome process via sendAsyncMessage.
//
// Notes:
//   - All sampled colors are normalized to canonical `rgb(r, g, b)` before being sent,
//     so the chrome side can rely on a single format.
//   - drawWindow() is the ground-truth fallback; it's flagged non-standard in MDN but is
//     still present in current Gecko. If it disappears upstream, this script keeps working
//     for the meta-tag and computed-style paths but loses Gmail-class accuracy.

(() => {
  'use strict';

  try {
    // Idempotent: if we're already running in this content scope, just trigger a fresh sample.
    if (content.__zen_page_tint_inited) {
      const sample = content.__zen_page_tint_sample;
      if (typeof sample === 'function') sample(true);
      return;
    }
    content.__zen_page_tint_inited = true;

    const MESSAGE_NAME = 'zen-page-tint:theme';
    // Sampling layout:
    //   - Source: a centered rectangle covering PIXEL_SAMPLE_FRACTION of the
    //     viewport (default 60%). The outer 20% margin on each side is skipped
    //     because that's typically where scrollbars, browser-injected overlays,
    //     and content edges live — sampling them muddies the dominant color.
    //   - Destination: a PIXEL_SAMPLE_GRID x PIXEL_SAMPLE_GRID canvas. We use
    //     ctx.scale to downsample the source region into the grid, then average
    //     across all GRID*GRID cells. With drawWindow doing the actual
    //     compositing, the GPU handles the downsample; we just walk the grid.
    //   - Result: a color representative of the central area's dominant tone
    //     rather than whatever single element happens to land at viewport
    //     center. Makes a big difference on video (averages the surrounding
    //     glow color instead of the frame's focal subject) and on pages with a
    //     colored hero bordered by negative space.
    const PIXEL_SAMPLE_FRACTION = 0.6;
    const PIXEL_SAMPLE_GRID = 16;
    let lastBg = null;
    let debounceTimer = null;
    let lastRescheduleAt = 0;

    // ---- Canvas (shared for pixel sampling AND color normalization) ----
    // Lazy-init: only created on first need. Sized to PIXEL_SAMPLE_GRID square.
    // Reused across sample() calls to avoid per-event allocation/GC churn on
    // sites with frequent theme mutations.
    let pixelCanvas = null;
    let pixelCtx = null;
    function ensureCanvas() {
      if (pixelCanvas) return true;
      try {
        pixelCanvas = content.document.createElementNS(
          'http://www.w3.org/1999/xhtml',
          'canvas'
        );
        pixelCanvas.width = PIXEL_SAMPLE_GRID;
        pixelCanvas.height = PIXEL_SAMPLE_GRID;
        pixelCtx = pixelCanvas.getContext('2d');
        return !!pixelCtx;
      } catch (e) {
        pixelCanvas = null;
        pixelCtx = null;
        return false;
      }
    }

    // Normalize any CSS color string to canonical `rgb(r, g, b)`.
    // Uses the canvas 2D context's CSS parser — handles hex, hsl, named colors,
    // color() functions, etc. Returns null for invalid input or fully-transparent values.
    //
    // Why this matters: meta theme-color content is commonly "#f5f5f5" or "white". The
    // chrome side's parseRgb only matches rgb()/rgba(), so without normalization those
    // bypass the contrast computation and end up with unreadable foreground text.
    function normalizeColor(c) {
      if (!c || typeof c !== 'string') return null;
      const trimmed = c.trim();
      if (!trimmed) return null;
      if (!ensureCanvas()) return null;
      try {
        pixelCtx.clearRect(0, 0, 1, 1);
        // Setting fillStyle to an invalid string is a no-op (keeps previous value).
        // Reset to a known sentinel first so we can detect parse failure.
        pixelCtx.fillStyle = 'rgba(0, 0, 0, 0)';
        pixelCtx.fillStyle = trimmed;
        pixelCtx.fillRect(0, 0, 1, 1);
        const d = pixelCtx.getImageData(0, 0, 1, 1).data;
        if (d[3] === 0) return null; // transparent → treat as no color
        return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
      } catch (e) {
        return null;
      }
    }

    // Detect "blank" computed bg: missing, keyword 'transparent', or rgba with alpha=0.
    // getComputedStyle returns rgb()/rgba() form, but check the keyword too defensively.
    function isBlankBg(c) {
      if (!c) return true;
      if (c === 'transparent') return true;
      const m = c.match(/rgba\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      return parts.length === 4 && parts[3] === 0;
    }

    // Pick the active <meta name="theme-color"> respecting `media` attributes.
    // Spec: multiple meta tags can exist with media queries (typically light/dark);
    // the first one whose media query matches wins. A meta without media is the default.
    function pickMetaThemeColor(doc) {
      const metas = doc.querySelectorAll('meta[name="theme-color"]');
      if (!metas.length) return null;
      let fallback = null;
      for (const m of metas) {
        const value = m.getAttribute('content');
        if (!value) continue;
        const media = m.getAttribute('media');
        if (!media) {
          if (!fallback) fallback = value;
          continue;
        }
        try {
          if (content.matchMedia(media).matches) return value;
        } catch (e) {
          // Malformed media query — ignore this meta, keep looking.
        }
      }
      return fallback;
    }

    // Sample a wide central region (PIXEL_SAMPLE_FRACTION of the viewport),
    // downsample it into a PIXEL_SAMPLE_GRID x PIXEL_SAMPLE_GRID block via
    // ctx.scale + drawWindow, and average non-transparent cells. This catches
    // the dominant color of the central content rather than whatever single
    // element happens to land at viewport center.
    function readPixel() {
      try {
        const w = content.innerWidth | 0;
        const h = content.innerHeight | 0;
        if (w <= 0 || h <= 0) return null;
        if (!ensureCanvas()) return null;
        if (!pixelCtx.drawWindow) return null;

        // Source rect: centered, sized to PIXEL_SAMPLE_FRACTION of the viewport.
        // Minimum source side of 8px keeps math sane on tiny windows.
        const sw = Math.max(8, (w * PIXEL_SAMPLE_FRACTION) | 0);
        const sh = Math.max(8, (h * PIXEL_SAMPLE_FRACTION) | 0);
        const sx = ((w - sw) / 2) | 0;
        const sy = ((h - sh) / 2) | 0;

        pixelCtx.clearRect(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID);
        // Scale transforms drawWindow's source coordinates so the source
        // rectangle (sw x sh) lands inside the destination grid. The compositor
        // does the actual resampling, which is cheaper than walking 100k+
        // pixels in JS.
        pixelCtx.save();
        pixelCtx.scale(PIXEL_SAMPLE_GRID / sw, PIXEL_SAMPLE_GRID / sh);
        pixelCtx.drawWindow(content, sx, sy, sw, sh, 'rgba(0, 0, 0, 0)');
        pixelCtx.restore();

        const img = pixelCtx.getImageData(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < PIXEL_SAMPLE_GRID * PIXEL_SAMPLE_GRID; i++) {
          const off = i * 4;
          if (img[off + 3] === 0) continue; // skip transparent
          r += img[off];
          g += img[off + 1];
          b += img[off + 2];
          n++;
        }
        if (n === 0) return null; // entire region was transparent → nothing painted
        return `rgb(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0})`;
      } catch (e) {
        return null;
      }
    }

    function read() {
      try {
        const doc = content.document;
        const body = doc.body;
        const html = doc.documentElement;
        const cs = (el) => (el ? content.getComputedStyle(el) : null);
        const bodyStyle = cs(body);
        const htmlStyle = cs(html);

        let bg = null;
        let source = '';

        // Sample chain (first match wins):
        //   1. drawWindow pixel at viewport center — ground truth of what's actually
        //      painted. Picks up Zen Boost overlays, dark-mode toggles, and any other
        //      visual change regardless of what the site's <head> declares.
        //   2. <meta name="theme-color"> — fallback when pixel can't read (rare:
        //      pre-paint loading state, fully-transparent page). Note this is often
        //      the address-bar color a site declares for mobile, NOT its page bg —
        //      e.g. GitHub meta is rgb(30,35,39) but page bg is rgb(13,17,23) — so
        //      we prefer pixel even when meta is present.
        //   3. body backgroundColor.
        //   4. html backgroundColor.
        //   5. Walk up from elementFromPoint to find an ancestor with solid bg.

        // 1. drawWindow pixel — ground truth.
        const pixel = readPixel();
        if (pixel) {
          bg = pixel;
          source = 'pixel';
        }

        // 2. theme-color meta (media-aware, normalized) — fallback if pixel failed.
        if (!bg) {
          const metaValue = pickMetaThemeColor(doc);
          if (metaValue) {
            const normalized = normalizeColor(metaValue);
            if (normalized) {
              bg = normalized;
              source = 'meta';
            }
          }
        }

        // 3. body backgroundColor (fallback).
        if (!bg && bodyStyle && !isBlankBg(bodyStyle.backgroundColor)) {
          bg = bodyStyle.backgroundColor;
          source = 'body';
        }

        // 4. html backgroundColor.
        if (!bg && htmlStyle && !isBlankBg(htmlStyle.backgroundColor)) {
          bg = htmlStyle.backgroundColor;
          source = 'html';
        }

        // 5. Walk up from elementFromPoint at viewport center.
        if (!bg && body) {
          try {
            const w = content.innerWidth | 0;
            const h = content.innerHeight | 0;
            if (w > 0 && h > 0) {
              const el = doc.elementFromPoint((w / 2) | 0, (h / 2) | 0);
              let cur = el;
              let steps = 0;
              while (cur && steps < 12) {
                const csCur = content.getComputedStyle(cur);
                if (csCur && !isBlankBg(csCur.backgroundColor)) {
                  bg = csCur.backgroundColor;
                  source = 'walk:' + (cur.tagName || '?').toLowerCase();
                  break;
                }
                cur = cur.parentElement;
                steps++;
              }
            }
          } catch (e) {}
        }

        return { bg, source };
      } catch (e) {
        return { bg: null, source: 'error' };
      }
    }

    function sample(force) {
      const r = read();
      if (force || r.bg !== lastBg) {
        lastBg = r.bg;
        sendAsyncMessage(MESSAGE_NAME, {
          bg: r.bg,
          source: r.source,
          href: content.location && content.location.href,
        });
      }
    }
    content.__zen_page_tint_sample = sample;

    // Live mode — continuous polling that lets the chrome tint follow video /
    // animated content. Driven by a "should poll?" state machine combining:
    //
    //   - Visibility: only poll when this tab is the foreground tab
    //     (visibilityState === 'visible'). Backgrounded tabs cost zero.
    //   - Always-on flag: if the chrome side flagged this URL as always-on
    //     (either via the global zen.page-tint.live-mode-always-on pref or
    //     via the per-host allowlist), we poll whenever the tab is visible.
    //   - Video detected: if always-on is false, we only poll when at least
    //     one <video> element on the page is actually playing. Static pages
    //     (text, no video) cost nothing — no polling at all.
    //
    // Video state is tracked via play/pause/ended/emptied events captured at
    // the document level (bubbles from any <video>) plus a debounced
    // MutationObserver to catch dynamically-inserted players (YouTube SPA
    // navigation, ad inserts, lazy-mounted carousels).
    const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
    let liveTimer = null;
    let liveRateMs = 0;
    let liveAlwaysOn = false;
    let liveVideoIsPlaying = false;
    let liveVisibilityWired = false;
    let liveVideoListenersWired = false;
    let liveVideoObserver = null;
    let liveVideoCheckTimer = null;

    function updatePollingState() {
      const shouldPoll = liveRateMs > 0
        && content.document.visibilityState === 'visible'
        && (liveAlwaysOn || liveVideoIsPlaying);
      if (shouldPoll && !liveTimer) {
        liveTimer = content.setInterval(() => sample(false), liveRateMs);
      } else if (!shouldPoll && liveTimer) {
        try { content.clearInterval(liveTimer); } catch {}
        liveTimer = null;
      }
    }

    function checkVideoState() {
      const doc = content.document;
      if (!doc) {
        if (liveVideoIsPlaying) { liveVideoIsPlaying = false; updatePollingState(); }
        return;
      }
      let anyPlaying = false;
      try {
        const videos = doc.querySelectorAll('video');
        for (const v of videos) {
          // Playing = not paused, not ended, has enough data to actually
          // render frames. Filtering on readyState>=2 (HAVE_CURRENT_DATA)
          // avoids triggering on a <video> that's been mounted but hasn't
          // loaded yet, which would briefly start the poller for no reason.
          if (!v.paused && !v.ended && v.readyState >= 2) {
            anyPlaying = true;
            break;
          }
        }
      } catch {}
      if (liveVideoIsPlaying !== anyPlaying) {
        liveVideoIsPlaying = anyPlaying;
        updatePollingState();
      }
    }

    function scheduleVideoCheck() {
      if (liveVideoCheckTimer) return;
      liveVideoCheckTimer = content.setTimeout(() => {
        liveVideoCheckTimer = null;
        checkVideoState();
      }, 250);
    }

    function wireVideoDetection() {
      if (liveVideoListenersWired) {
        // Already set up — just re-check state in case it's stale (e.g. user
        // navigated from a video page to a non-video page and config is being
        // re-sent).
        checkVideoState();
        return;
      }
      liveVideoListenersWired = true;
      const doc = content.document;
      // Capture-phase listeners on the document so we get events from any
      // <video> regardless of where it's mounted in the tree.
      const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'abort'];
      for (const ev of events) {
        try { doc.addEventListener(ev, scheduleVideoCheck, { capture: true }); } catch {}
      }
      // Catch dynamically-inserted <video> nodes (YouTube SPA nav, etc.).
      try {
        liveVideoObserver = new content.MutationObserver(scheduleVideoCheck);
        liveVideoObserver.observe(doc.body || doc.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch {}
      checkVideoState();
    }

    function wireVisibilityListener() {
      if (liveVisibilityWired) return;
      liveVisibilityWired = true;
      try {
        content.document.addEventListener('visibilitychange', () => {
          if (content.document.visibilityState === 'visible') {
            // Catch the chrome up to anything that changed while we were paused.
            sample(true);
            // In video-detect mode the play state might have changed too
            // (autoplay started while hidden, etc.) — re-check.
            if (!liveAlwaysOn && liveVideoListenersWired) checkVideoState();
          }
          updatePollingState();
        });
      } catch {}
    }

    function configureLiveMode(rateMs, alwaysOn) {
      // Reconfigured on every config message — chrome sends one after each
      // loadFrameScript, which means every TabSelect cache-miss and every
      // top-level navigation. Cheap because listeners/observers only attach
      // once (guarded by the *Wired flags).
      liveRateMs = rateMs > 0 ? rateMs : 0;
      liveAlwaysOn = !!alwaysOn;
      wireVisibilityListener();
      if (!liveAlwaysOn && liveRateMs > 0) {
        wireVideoDetection();
      }
      updatePollingState();
    }

    function disableLiveMode() {
      liveRateMs = 0;
      liveAlwaysOn = false;
      liveVideoIsPlaying = false;
      updatePollingState();
    }

    // Frame-script message listeners want an object with a receiveMessage()
    // method. The bare-function form silently no-ops in some content scopes,
    // which is why an earlier version of live mode never received the chrome
    // side's config message. The object form is the documented API and works
    // uniformly across frame-script contexts.
    const configListener = {
      receiveMessage(msg) {
        try {
          const data = msg?.data || {};
          try {
            console.log('[zen-page-tint frame] config received, rate =', data.liveRateMs,
              '| alwaysOn =', !!data.alwaysOn);
          } catch {}
          if (data.liveRateMs > 0) configureLiveMode(data.liveRateMs, data.alwaysOn);
          else disableLiveMode();
        } catch (e) {
          try { console.error('[zen-page-tint frame] config handler error:', e); } catch {}
        }
      }
    };
    try {
      addMessageListener(CONFIG_MESSAGE_NAME, configListener);
    } catch (e) {
      try { console.error('[zen-page-tint frame] addMessageListener failed:', e); } catch {}
    }

    function debouncedSample() {
      if (debounceTimer) return;
      debounceTimer = content.setTimeout(() => {
        debounceTimer = null;
        sample(false);
      }, 250);
    }

    // Initial sample — wait for DOMContentLoaded if doc is still loading, so we don't
    // read a half-rendered loading screen (e.g., Gmail's white pre-bootstrap state).
    if (content.document.readyState === 'loading') {
      content.document.addEventListener('DOMContentLoaded', () => sample(true), {
        once: true,
        capture: true,
      });
    } else {
      sample(true);
    }

    // Observe html/body attribute changes, filtered to attributes that real sites use
    // to flip themes. Without the filter, every aria-*, data-time, class-toggle on body
    // (Twitch, Gmail chat indicators, etc.) wakes us up and triggers a drawWindow read.
    // If a site uses an unlisted attribute for theme state, add it here.
    const THEME_ATTRS = [
      'class',
      'style',
      'theme',
      'color-scheme',
      'data-theme',
      'data-mode',
      'data-bs-theme',     // Bootstrap 5
      'data-color-scheme',
      'data-color-mode',   // GitHub
      'data-dark-mode',
      'data-prefers-color-scheme',
    ];

    function startObserving() {
      const doc = content.document;
      if (!doc.body) {
        content.setTimeout(startObserving, 150);
        return;
      }
      const observer = new content.MutationObserver(debouncedSample);
      const opts = { attributes: true, attributeFilter: THEME_ATTRS };
      observer.observe(doc.documentElement, opts);
      observer.observe(doc.body, opts);
      content.__zen_page_tint_observer = observer;

      // Observe <head> for theme-affecting mutations that don't surface as
      // attribute changes on html/body. Covers:
      //   - Zen Boosts injecting a per-site <style> element and live-editing
      //     its textContent as the user drags the color picker.
      //   - Sites swapping <link rel="stylesheet"> hrefs for theme switching.
      //   - Dynamic <meta name="theme-color"> content updates.
      //   - Dev-tool / hot-reload stylesheet swaps.
      // Head churn is minimal on most sites; debouncedSample coalesces bursts.
      if (doc.head) {
        const headObserver = new content.MutationObserver(debouncedSample);
        headObserver.observe(doc.head, {
          childList: true,        // new <style>/<link>/<meta> nodes
          subtree: true,          // attr + characterData changes on children
          characterData: true,    // textContent changes inside <style> (live editing)
          attributes: true,
          attributeFilter: ['href', 'content', 'media', 'disabled'],
        });
        content.__zen_page_tint_head_observer = headObserver;
      }
    }
    startObserving();

    // Re-sample after page load completes. Multiple delays catch:
    //   - 300ms: quick apps that apply themes shortly after load
    //   - 2000ms: slow apps like Gmail that bootstrap dark mode well after 'load'
    // Each re-sample is cheap (drawWindow pixel) and only sends if bg changed.
    //
    // Both 'load' and 'pageshow' fire on a fresh navigation (load first, pageshow after),
    // so without dedupe we'd schedule 4 timers per nav. Coalesce within a 500ms window.
    function rescheduleLoad() {
      const now = Date.now();
      if (now - lastRescheduleAt < 500) return;
      lastRescheduleAt = now;
      content.setTimeout(() => sample(true), 300);
      content.setTimeout(() => sample(true), 2000);
    }
    content.addEventListener('load', rescheduleLoad, { capture: true });
    content.addEventListener('pageshow', rescheduleLoad, { capture: true });
  } catch (e) {
    // Frame scripts log to the Browser Console, not the page console — safe to
    // surface init errors so future regressions don't fail silently. Keep noise low
    // by only logging here (the outer catch).
    try { console.error('[zen-page-tint frame] init failed:', e); } catch {}
  }
})();
