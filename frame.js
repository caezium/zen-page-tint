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
    const PIXEL_SAMPLE_SIZE = 3; // 3x3 region around viewport center, averaged.
    let lastBg = null;
    let debounceTimer = null;
    let lastRescheduleAt = 0;

    // ---- Canvas (shared for pixel sampling AND color normalization) ----
    // Lazy-init: only created on first need. Sized to PIXEL_SAMPLE_SIZE x PIXEL_SAMPLE_SIZE.
    // Reused across sample() calls to avoid per-event allocation/GC churn on sites with
    // frequent theme mutations.
    let pixelCanvas = null;
    let pixelCtx = null;
    function ensureCanvas() {
      if (pixelCanvas) return true;
      try {
        pixelCanvas = content.document.createElementNS(
          'http://www.w3.org/1999/xhtml',
          'canvas'
        );
        pixelCanvas.width = PIXEL_SAMPLE_SIZE;
        pixelCanvas.height = PIXEL_SAMPLE_SIZE;
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

    // Read the literal rendered pixels at viewport center via drawWindow.
    // Samples a PIXEL_SAMPLE_SIZE x PIXEL_SAMPLE_SIZE block and averages non-transparent
    // pixels — more robust than a single-pixel read against anti-aliased text edges or
    // narrow dividers happening to land at viewport center.
    function readPixel() {
      try {
        const w = content.innerWidth | 0;
        const h = content.innerHeight | 0;
        if (w <= 0 || h <= 0) return null;
        if (!ensureCanvas()) return null;
        if (!pixelCtx.drawWindow) return null;
        const half = (PIXEL_SAMPLE_SIZE / 2) | 0;
        const cx = ((w / 2) | 0) - half;
        const cy = ((h / 2) | 0) - half;
        pixelCtx.clearRect(0, 0, PIXEL_SAMPLE_SIZE, PIXEL_SAMPLE_SIZE);
        pixelCtx.drawWindow(
          content,
          cx,
          cy,
          PIXEL_SAMPLE_SIZE,
          PIXEL_SAMPLE_SIZE,
          'rgba(0, 0, 0, 0)'
        );
        const img = pixelCtx.getImageData(0, 0, PIXEL_SAMPLE_SIZE, PIXEL_SAMPLE_SIZE).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < PIXEL_SAMPLE_SIZE * PIXEL_SAMPLE_SIZE; i++) {
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
        //   1. <meta name="theme-color"> — site's declared signal, fastest & deterministic.
        //      Picked respecting the meta's `media` attribute, then normalized to rgb().
        //   2. drawWindow pixel at viewport center — ground truth of what's actually painted.
        //      Promoted over body/html sampling because Gmail-class apps keep body bg light
        //      while painting dark UI on overlays/wrappers, so body lies about visible color.
        //   3. body backgroundColor — fallback if drawWindow fails.
        //   4. html backgroundColor.
        //   5. Walk up from elementFromPoint to find an ancestor with solid bg.

        // 1. theme-color meta (media-aware, then normalized).
        const metaValue = pickMetaThemeColor(doc);
        if (metaValue) {
          const normalized = normalizeColor(metaValue);
          if (normalized) {
            bg = normalized;
            source = 'meta';
          }
        }

        // 2. drawWindow pixel — primary for accuracy.
        if (!bg) {
          const pixel = readPixel();
          if (pixel) {
            bg = pixel;
            source = 'pixel';
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
