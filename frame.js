// Zen Page Tint — frame script
// Loaded into the content process via mm.loadFrameScript.
// Samples the page's effective background color (pixel-truth via drawWindow,
// with meta theme-color and computed-style fallbacks), observes html/body
// mutations, and pushes results to the chrome process via sendAsyncMessage.

(() => {
  'use strict';

  try {
    if (content.__zen_page_tint_inited) {
      const sample = content.__zen_page_tint_sample;
      if (typeof sample === 'function') sample(true);
      return;
    }
    content.__zen_page_tint_inited = true;

    const MESSAGE_NAME = 'zen-page-tint:theme';
    let lastBg = null;
    let lastFg = null;
    let debounceTimer = null;

    // ---- Shared canvas (used for both pixel sampling AND color normalization) ----
    let pixelCanvas = null;
    let pixelCtx = null;
    function ensureCanvas() {
      if (pixelCanvas) return true;
      try {
        pixelCanvas = content.document.createElementNS(
          'http://www.w3.org/1999/xhtml',
          'canvas'
        );
        pixelCanvas.width = 1;
        pixelCanvas.height = 1;
        pixelCtx = pixelCanvas.getContext('2d');
        return !!pixelCtx;
      } catch (e) {
        pixelCanvas = null;
        pixelCtx = null;
        return false;
      }
    }

    // Normalize any CSS color string to canonical `rgb(r, g, b)` via the canvas
    // color parser — handles hex, hsl, named colors, color() functions, etc.
    // Returns null for invalid input or fully-transparent values.
    //
    // Why this matters: meta theme-color content is commonly "#f5f5f5" or "white".
    // The chrome side's parseRgb only matches rgb()/rgba(), so without normalization
    // those would bypass contrast computation and end up with unreadable foreground.
    function normalizeColor(c) {
      if (!c || typeof c !== 'string') return null;
      const trimmed = c.trim();
      if (!trimmed) return null;
      if (!ensureCanvas()) return null;
      try {
        pixelCtx.clearRect(0, 0, 1, 1);
        pixelCtx.fillStyle = 'rgba(0, 0, 0, 0)';
        pixelCtx.fillStyle = trimmed;
        pixelCtx.fillRect(0, 0, 1, 1);
        const d = pixelCtx.getImageData(0, 0, 1, 1).data;
        if (d[3] === 0) return null;
        return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
      } catch (e) {
        return null;
      }
    }

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
        } catch (e) {}
      }
      return fallback;
    }

    // Read the literal rendered pixel at viewport center via drawWindow.
    // Reliable because it captures what's actually painted, regardless of how
    // the bg was set (body/html, gradient, image, overlay div, etc.).
    function readPixel() {
      try {
        const w = content.innerWidth | 0;
        const h = content.innerHeight | 0;
        if (w <= 0 || h <= 0) return null;
        if (!ensureCanvas()) return null;
        if (!pixelCtx.drawWindow) return null;
        pixelCtx.clearRect(0, 0, 1, 1);
        pixelCtx.drawWindow(content, (w / 2) | 0, (h / 2) | 0, 1, 1, 'rgba(0, 0, 0, 0)');
        const data = pixelCtx.getImageData(0, 0, 1, 1).data;
        if (data[3] === 0) return null;
        return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
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
        //   1. <meta name="theme-color"> — site's declared signal (media-aware, normalized).
        //   2. drawWindow pixel at viewport center — ground truth of what's actually painted.
        //      Promoted over body/html because Gmail-class apps keep body bg light while
        //      painting dark UI on overlays/wrappers (body lies about visible color).
        //   3. body backgroundColor — fallback if drawWindow fails.
        //   4. html backgroundColor.
        //   5. Walk up from elementFromPoint to find an ancestor with solid bg.

        const metaValue = pickMetaThemeColor(doc);
        if (metaValue) {
          const normalized = normalizeColor(metaValue);
          if (normalized) {
            bg = normalized;
            source = 'meta';
          }
        }

        if (!bg) {
          const pixel = readPixel();
          if (pixel) {
            bg = pixel;
            source = 'pixel';
          }
        }

        if (!bg && bodyStyle && !isBlankBg(bodyStyle.backgroundColor)) {
          bg = bodyStyle.backgroundColor;
          source = 'body';
        }

        if (!bg && htmlStyle && !isBlankBg(htmlStyle.backgroundColor)) {
          bg = htmlStyle.backgroundColor;
          source = 'html';
        }

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

        const fg = (bodyStyle && bodyStyle.color) || null;
        return { bg, fg, source };
      } catch (e) {
        return { bg: null, fg: null, source: 'error' };
      }
    }

    function sample(force) {
      const r = read();
      if (force || r.bg !== lastBg || r.fg !== lastFg) {
        lastBg = r.bg;
        lastFg = r.fg;
        sendAsyncMessage(MESSAGE_NAME, {
          bg: r.bg,
          fg: r.fg,
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

    if (content.document.readyState === 'loading') {
      content.document.addEventListener('DOMContentLoaded', () => sample(true), {
        once: true,
        capture: true,
      });
    } else {
      sample(true);
    }

    function startObserving() {
      const doc = content.document;
      if (!doc.body) {
        content.setTimeout(startObserving, 150);
        return;
      }
      const observer = new content.MutationObserver(debouncedSample);
      const opts = { attributes: true };
      observer.observe(doc.documentElement, opts);
      observer.observe(doc.body, opts);
      content.__zen_page_tint_observer = observer;
    }
    startObserving();

    content.addEventListener('load', () => {
      content.setTimeout(() => sample(true), 300);
    }, { capture: true });
  } catch (e) {
    try { console.error('[zen-page-tint frame] init failed:', e); } catch {}
  }
})();
