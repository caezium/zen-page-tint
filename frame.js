// Zen Page Tint — frame script
// Loaded into the content process via mm.loadFrameScript.
// Samples the page's background color via computed styles + observes html/body
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

    // Detect "blank" background: missing, keyword 'transparent', or rgba with alpha=0.
    function isBlankBg(c) {
      if (!c) return true;
      if (c === 'transparent') return true;
      const m = c.match(/rgba\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      return parts.length === 4 && parts[3] === 0;
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
        //   1. <meta name="theme-color"> — site's declared signal.
        //   2. body backgroundColor.
        //   3. html backgroundColor.
        //   4. Walk up from elementFromPoint to find an ancestor with solid bg.

        const themeColorMeta = doc.querySelector('meta[name="theme-color"]');
        if (themeColorMeta && themeColorMeta.content) {
          bg = themeColorMeta.content;
          source = 'meta';
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

    // Observe html/body attribute changes — sites use diverse attribute names for
    // theme state, so don't filter at this stage.
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

    // Re-sample shortly after load to catch apps that apply themes post-load.
    content.addEventListener('load', () => {
      content.setTimeout(() => sample(true), 300);
    }, { capture: true });
  } catch (e) {
    try { console.error('[zen-page-tint frame] init failed:', e); } catch {}
  }
})();
