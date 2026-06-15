// Zen Page Tint — frame script
// Loaded into the content process via mm.loadFrameScript.
// Reads the page's effective background color, observes theme-related DOM mutations,
// re-samples on load/pageshow, and pushes results to the chrome process via sendAsyncMessage.
//
// Lifecycle:
//   - The persistent singleton (config + teardown message listeners, stored on the
//     frame-script global `globalThis`) is installed ONCE per content process. It
//     survives loadFrameScript re-execution, which chrome triggers on every
//     navigation and every cache-miss tab select.
//   - A per-document "instance" (canvas, observers, event listeners, poll loop) is
//     rebuilt on each (re)load and torn down cleanly first. Anchoring the install
//     guard on `globalThis` (process lifetime) instead of `content` (per-document)
//     is what prevents the listener/poller accumulation that the old guard caused —
//     `content` is a fresh window object after every cross-document navigation.
//
// Notes:
//   - All sampled colors are normalized to canonical `rgb(r, g, b)` before being sent
//     (every path routes through normalizeColor / readPixel), so the chrome side can
//     rely on a single format.
//   - drawWindow() is the ground-truth fallback; it's flagged non-standard in MDN but is
//     still present in current Gecko. If it disappears upstream, this script keeps working
//     for the meta-tag and computed-style paths but loses Gmail-class accuracy.

(() => {
  'use strict';

  const MESSAGE_NAME = 'zen-page-tint:theme';
  const CONFIG_MESSAGE_NAME = 'zen-page-tint:config';
  const TEARDOWN_MESSAGE_NAME = 'zen-page-tint:teardown';

  // Already installed in this frame-script scope? A re-load means chrome wants a
  // fresh sample for the (possibly new) document — rebuild per-document state and
  // return. The heavy persistent listeners below are NOT re-registered.
  if (globalThis.__zenPageTint) {
    try { globalThis.__zenPageTint.reload(); }
    catch (e) { try { console.error('[zen-page-tint frame] reload failed:', e); } catch {} }
    return;
  }

  try {
    // ---- Sampling layout ----
    //   - Source: a centered rectangle covering PIXEL_SAMPLE_FRACTION of the
    //     viewport (default 60%). The outer margin is skipped because that's
    //     typically where scrollbars/overlays/content edges live.
    //   - Destination: a PIXEL_SAMPLE_GRID x PIXEL_SAMPLE_GRID canvas. We scale
    //     the source region into the grid (drawWindow + the GPU do the downsample)
    //     then average non-transparent cells for the dominant central tone.
    const PIXEL_SAMPLE_FRACTION = 0.6;
    const PIXEL_SAMPLE_GRID = 16;
    const VIDEO_CHECK_DEBOUNCE_MS = 250;
    const SAMPLE_DEBOUNCE_MS = 250;
    const LIVE_RATE_FLOOR_MS = 250;       // never sample faster than this (4 Hz)
    const LIVE_ACTIVE_DIVISOR = 4;        // active rate = idle rate / this
    const LIVE_STABLE_TICKS_TO_IDLE = 4;  // unchanged ticks before backing off

    // Theme-affecting attributes worth re-sampling on. Filtered so ordinary
    // aria-*/data-time/class churn doesn't wake a drawWindow read.
    const THEME_ATTRS = [
      'class', 'style', 'theme', 'color-scheme',
      'data-theme', 'data-mode', 'data-bs-theme', 'data-color-scheme',
      'data-color-mode', 'data-dark-mode', 'data-prefers-color-scheme',
    ];

    // ============================================================
    // Persistent singleton — process-lifetime, installed once.
    // ============================================================
    const singleton = {
      // Live-mode config, updated by the chrome side's config message. Persisted
      // here so a per-document reload can re-apply it without waiting for a new
      // message.
      config: { liveRateMs: 0, alwaysOn: false, threshold: 0, debug: false },
      instance: null,
      configListener: null,
      teardownListener: null,

      reload() {
        if (this.instance) { try { this.instance.dispose(); } catch {} }
        this.instance = createInstance();
        this.instance.start();
        this.instance.applyConfig();
      },

      applyConfig(data) {
        this.config = {
          liveRateMs: data && data.liveRateMs > 0 ? data.liveRateMs : 0,
          alwaysOn: !!(data && data.alwaysOn),
          threshold: data && data.threshold > 0 ? data.threshold : 0,
          debug: !!(data && data.debug),
        };
        if (this.instance) this.instance.applyConfig();
      },

      teardown() {
        if (this.instance) { try { this.instance.dispose(); } catch {} this.instance = null; }
        try { removeMessageListener(CONFIG_MESSAGE_NAME, this.configListener); } catch {}
        try { removeMessageListener(TEARDOWN_MESSAGE_NAME, this.teardownListener); } catch {}
        globalThis.__zenPageTint = null;
      },
    };

    // ============================================================
    // Per-document instance factory.
    // ============================================================
    function createInstance() {
      const inst = {
        alive: true,
        // dirty: a theme-affecting change happened while the tab was hidden, so a
        // resample is owed on next foreground (background tabs never drawWindow).
        dirty: false,
        lastBg: null,
        lastRescheduleAt: 0,
        observers: [],
        cleanups: [],          // listener removers, run on dispose
        // live state
        liveTimer: null,
        liveActiveRateMs: 0,
        liveStableTicks: 0,
        liveAlwaysOn: false,
        liveRateMs: 0,
        liveVideoIsPlaying: false,
        liveVisibilityWired: false,
        liveVideoListenersWired: false,
      };

      // Register an event listener and remember how to remove it.
      function on(target, type, handler, opts) {
        try { target.addEventListener(type, handler, opts); } catch {}
        inst.cleanups.push(() => { try { target.removeEventListener(type, handler, opts); } catch {} });
      }

      // ---- Canvas (shared for pixel sampling AND color normalization) ----
      let canvas = null;
      let ctx = null;
      function ensureCanvas() {
        if (ctx) return true;
        try {
          canvas = content.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
          canvas.width = PIXEL_SAMPLE_GRID;
          canvas.height = PIXEL_SAMPLE_GRID;
          // willReadFrequently keeps the canvas in software memory so the
          // drawWindow→getImageData readback on every sample isn't a GPU stall.
          ctx = canvas.getContext('2d', { willReadFrequently: true });
          return !!ctx;
        } catch (e) { canvas = null; ctx = null; return false; }
      }

      // Normalize any CSS color string to canonical `rgb(r, g, b)` via the canvas
      // 2D parser (handles hex, hsl, named, color(), oklch, lab, …). Returns null
      // for invalid input or fully-transparent values. Resets the transform first
      // so a leaked transform from a thrown drawWindow can't corrupt the fillRect.
      function normalizeColor(c) {
        if (!c || typeof c !== 'string') return null;
        const trimmed = c.trim();
        if (!trimmed) return null;
        if (!ensureCanvas()) return null;
        try {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, 1, 1);
          // Setting fillStyle to an invalid string is a no-op (keeps previous value),
          // so reset to a known sentinel first to detect parse failure.
          ctx.fillStyle = 'rgba(0, 0, 0, 0)';
          ctx.fillStyle = trimmed;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          if (d[3] === 0) return null; // transparent → treat as no color
          return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
        } catch (e) { return null; }
      }

      // Sample a wide central region, downsample into the grid, average non-
      // transparent cells. Uses setTransform (not save/scale/restore) so that if
      // drawWindow throws, the next call still starts from a clean identity
      // transform instead of inheriting a leaked scale that breaks all sampling.
      function readPixel() {
        if (!ensureCanvas()) return null;
        try {
          const w = content.innerWidth | 0;
          const h = content.innerHeight | 0;
          if (w <= 0 || h <= 0) return null;
          if (!ctx.drawWindow) return null;

          const sw = Math.max(8, (w * PIXEL_SAMPLE_FRACTION) | 0);
          const sh = Math.max(8, (h * PIXEL_SAMPLE_FRACTION) | 0);
          const sx = ((w - sw) / 2) | 0;
          const sy = ((h - sh) / 2) | 0;

          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID);
          ctx.setTransform(PIXEL_SAMPLE_GRID / sw, 0, 0, PIXEL_SAMPLE_GRID / sh, 0, 0);
          ctx.drawWindow(content, sx, sy, sw, sh, 'rgba(0, 0, 0, 0)');
          ctx.setTransform(1, 0, 0, 1, 0, 0);

          const img = ctx.getImageData(0, 0, PIXEL_SAMPLE_GRID, PIXEL_SAMPLE_GRID).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < PIXEL_SAMPLE_GRID * PIXEL_SAMPLE_GRID; i++) {
            const off = i * 4;
            if (img[off + 3] === 0) continue; // skip transparent
            r += img[off]; g += img[off + 1]; b += img[off + 2]; n++;
          }
          if (n === 0) return null;
          return `rgb(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0})`;
        } catch (e) {
          try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch {}
          return null;
        }
      }

      // Pick the active <meta name="theme-color"> respecting `media` attributes.
      function pickMetaThemeColor(doc) {
        const metas = doc.querySelectorAll('meta[name="theme-color"]');
        if (!metas.length) return null;
        let fallback = null;
        for (const m of metas) {
          const value = m.getAttribute('content');
          if (!value) continue;
          const media = m.getAttribute('media');
          if (!media) { if (!fallback) fallback = value; continue; }
          try { if (content.matchMedia(media).matches) return value; }
          catch (e) { /* malformed media query — skip */ }
        }
        return fallback;
      }

      // Sample chain (first match wins): pixel → meta → body → html → walk.
      // Every path is normalized so the chrome side only ever sees rgb(r, g, b).
      function read() {
        try {
          const doc = content.document;
          let bg = null;
          let source = '';

          const pixel = readPixel();
          if (pixel) { bg = pixel; source = 'pixel'; }

          if (!bg) {
            const metaValue = pickMetaThemeColor(doc);
            const normalized = metaValue ? normalizeColor(metaValue) : null;
            if (normalized) { bg = normalized; source = 'meta'; }
          }

          if (!bg && doc.body) {
            const c = normalizeColor(content.getComputedStyle(doc.body).backgroundColor);
            if (c) { bg = c; source = 'body'; }
          }

          if (!bg && doc.documentElement) {
            const c = normalizeColor(content.getComputedStyle(doc.documentElement).backgroundColor);
            if (c) { bg = c; source = 'html'; }
          }

          if (!bg && doc.body) {
            try {
              const w = content.innerWidth | 0;
              const h = content.innerHeight | 0;
              if (w > 0 && h > 0) {
                let cur = doc.elementFromPoint((w / 2) | 0, (h / 2) | 0);
                let steps = 0;
                while (cur && steps < 12) {
                  const c = normalizeColor(content.getComputedStyle(cur).backgroundColor);
                  if (c) { bg = c; source = 'walk:' + (cur.tagName || '?').toLowerCase(); break; }
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

      // Parse our own canonical `rgb(r, g, b)` strings back to a triplet.
      function parseRgbTriplet(s) {
        if (typeof s !== 'string') return null;
        const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
        return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
      }

      function maxChannelDelta(a, b) {
        const pa = parseRgbTriplet(a);
        const pb = parseRgbTriplet(b);
        if (!pa || !pb) return null;
        return Math.max(Math.abs(pa.r - pb.r), Math.abs(pa.g - pb.g), Math.abs(pa.b - pb.b));
      }

      // Different enough from the last sent color to be worth applying?
      function significantChange(newBg) {
        if (newBg === inst.lastBg) return false;
        if (inst.lastBg === null || newBg === null) return true;
        const th = singleton.config.threshold;
        if (th <= 0) return true;
        const d = maxChannelDelta(newBg, inst.lastBg);
        return d === null ? true : d >= th;
      }

      // Returns true iff it actually sent an update. `allowNull` lets callers
      // suppress sending a null (no-color) result during the pre-paint window so
      // we don't flash-clear the tint before the page has painted; later samples
      // (load/pageshow reschedule) re-evaluate and CAN send null to clear a
      // genuinely colorless page.
      function sample(force, allowNull = true) {
        if (!inst.alive) return false;
        const r = read();
        if (r.bg === null && !allowNull) return false;
        if (!(force || significantChange(r.bg))) return false;
        inst.lastBg = r.bg;
        try {
          sendAsyncMessage(MESSAGE_NAME, {
            bg: r.bg,
            source: r.source,
            href: content.location && content.location.href,
          });
        } catch (e) { /* content torn down mid-send */ }
        return true;
      }

      function debounce(fn, ms) {
        let timer = null;
        return () => {
          if (timer) return;
          timer = content.setTimeout(() => { timer = null; if (inst.alive) fn(); }, ms);
        };
      }
      const debouncedSample = debounce(() => sample(false), SAMPLE_DEBOUNCE_MS);

      // ---- Live mode (adaptive poll loop) ----
      function shouldPollNow() {
        const doc = content.document;
        return !!doc
          && inst.liveRateMs > 0
          && doc.visibilityState === 'visible'
          && (inst.liveAlwaysOn || inst.liveVideoIsPlaying);
      }
      function stopPolling() {
        if (inst.liveTimer) { try { content.clearTimeout(inst.liveTimer); } catch {} inst.liveTimer = null; }
      }
      function scheduleNextPoll() {
        const rate = inst.liveStableTicks >= LIVE_STABLE_TICKS_TO_IDLE ? inst.liveRateMs : inst.liveActiveRateMs;
        inst.liveTimer = content.setTimeout(livePollTick, rate);
      }
      function livePollTick() {
        inst.liveTimer = null;
        if (!inst.alive || !shouldPollNow()) return;
        const applied = sample(false);
        if (applied) inst.liveStableTicks = 0; else inst.liveStableTicks++;
        scheduleNextPoll();
      }
      function updatePollingState() {
        if (shouldPollNow()) { if (!inst.liveTimer) { inst.liveStableTicks = 0; scheduleNextPoll(); } }
        else stopPolling();
      }

      function checkVideoState() {
        const doc = content.document;
        if (!doc) { if (inst.liveVideoIsPlaying) { inst.liveVideoIsPlaying = false; updatePollingState(); } return; }
        let anyPlaying = false;
        try {
          for (const v of doc.querySelectorAll('video')) {
            if (!v.paused && !v.ended && v.readyState >= 2) { anyPlaying = true; break; }
          }
        } catch {}
        if (inst.liveVideoIsPlaying !== anyPlaying) { inst.liveVideoIsPlaying = anyPlaying; updatePollingState(); }
      }
      const scheduleVideoCheck = debounce(checkVideoState, VIDEO_CHECK_DEBOUNCE_MS);

      function wireVideoDetection() {
        if (inst.liveVideoListenersWired) { checkVideoState(); return; }
        inst.liveVideoListenersWired = true;
        const doc = content.document;
        // Capture-phase document listeners catch media events from any <video>,
        // including dynamically-inserted players. (Cross-origin <iframe> embeds
        // are invisible here — use the host allowlist for those.)
        for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'abort']) {
          on(doc, ev, scheduleVideoCheck, { capture: true });
        }
        checkVideoState();
      }

      function wireVisibilityListener() {
        if (inst.liveVisibilityWired) return;
        inst.liveVisibilityWired = true;
        on(content.document, 'visibilitychange', () => {
          if (content.document.visibilityState === 'visible') {
            // Only resample if something actually changed while hidden — the chrome
            // side already restored the cached color on tab select, so an
            // unconditional forced sample here would be redundant IPC + restyle.
            if (inst.dirty) { inst.dirty = false; sample(true); }
            if (!inst.liveAlwaysOn && inst.liveVideoListenersWired) checkVideoState();
          }
          updatePollingState();
        });
      }

      // Re-evaluate live mode against the current persistent config.
      function applyConfig() {
        const cfg = singleton.config;
        inst.liveRateMs = cfg.liveRateMs > 0 ? cfg.liveRateMs : 0;
        inst.liveActiveRateMs = inst.liveRateMs > 0
          ? Math.max(LIVE_RATE_FLOOR_MS, (inst.liveRateMs / LIVE_ACTIVE_DIVISOR) | 0)
          : 0;
        inst.liveAlwaysOn = !!cfg.alwaysOn;
        wireVisibilityListener();
        if (!inst.liveAlwaysOn && inst.liveRateMs > 0) wireVideoDetection();
        updatePollingState();
      }

      // Mutation observers. Background-tab mutations only mark dirty (no drawWindow);
      // a foreground change debounces a sample. Head <title> churn is ignored.
      function attachObservers(doc) {
        if (inst.observers.length) return; // idempotent: both tryAttach paths can call this
        const onMutation = () => {
          if (content.document.visibilityState !== 'visible') { inst.dirty = true; return; }
          debouncedSample();
        };
        const mo = new content.MutationObserver(onMutation);
        const opts = { attributes: true, attributeFilter: THEME_ATTRS };
        try { mo.observe(doc.documentElement, opts); } catch {}
        if (doc.body) { try { mo.observe(doc.body, opts); } catch {} }
        inst.observers.push(mo);

        if (doc.head) {
          const onHeadMutation = (records) => {
            if (content.document.visibilityState !== 'visible') { inst.dirty = true; return; }
            for (const r of records) {
              const t = r.target;
              const nn = (t && t.nodeName || '').toLowerCase();
              const pn = (t && t.parentNode && t.parentNode.nodeName || '').toLowerCase();
              if (nn === 'title' || pn === 'title') continue; // title text can't affect bg
              debouncedSample();
              return;
            }
          };
          const ho = new content.MutationObserver(onHeadMutation);
          try {
            ho.observe(doc.head, {
              childList: true, subtree: true, characterData: true,
              attributes: true, attributeFilter: ['href', 'content', 'media', 'disabled'],
            });
          } catch {}
          inst.observers.push(ho);
        }
      }

      // Attach observers once the document has a body. Body-less documents (raw
      // SVG/XML/RSS) never get one, so retry is bounded — observe documentElement
      // and give up instead of looping a 150ms timer forever.
      function startObserving() {
        const doc = content.document;
        if (doc.body) { attachObservers(doc); return; }
        let tries = 0;
        const tryAttach = () => {
          if (!inst.alive) return;
          if (doc.body || ++tries > 20) { attachObservers(doc); return; } // ~3s cap
          content.setTimeout(tryAttach, 150);
        };
        on(doc, 'DOMContentLoaded', tryAttach, { once: true, capture: true });
        content.setTimeout(tryAttach, 150);
      }

      function start() {
        // Initial sample — wait for DOMContentLoaded if still loading, so we don't
        // read a half-rendered loading screen. Suppress null at that pre-paint
        // moment (load/pageshow reschedules below handle a genuinely colorless page).
        if (content.document.readyState === 'loading') {
          on(content.document, 'DOMContentLoaded', () => sample(true, false), { once: true, capture: true });
        } else {
          sample(true, true);
        }

        startObserving();

        // Re-sample after load. 300ms catches quick theme application; 2000ms
        // catches slow bootstrappers (Gmail dark mode). Coalesced within 500ms
        // because both load and pageshow fire on a fresh navigation.
        const reschedule = () => {
          const now = Date.now();
          if (now - inst.lastRescheduleAt < 500) return;
          inst.lastRescheduleAt = now;
          content.setTimeout(() => sample(true), 300);
          content.setTimeout(() => sample(true), 2000);
        };
        // No capture: a capture-phase window listener would fire for every
        // subresource (<img>/<script>/<iframe>) load, hammering drawWindow on
        // image-heavy feeds. Without capture only the top-level load reaches us.
        on(content, 'load', reschedule);
        on(content, 'pageshow', reschedule);
      }

      function dispose() {
        inst.alive = false;
        stopPolling();
        for (const off of inst.cleanups) { try { off(); } catch {} }
        inst.cleanups.length = 0;
        for (const o of inst.observers) { try { o.disconnect(); } catch {} }
        inst.observers.length = 0;
      }

      inst.start = start;
      inst.applyConfig = applyConfig;
      inst.dispose = dispose;
      return inst;
    }

    // ---- Register persistent message listeners (object form is the reliable
    // frame-script API; the bare-function form silently no-ops in some scopes). ----
    singleton.configListener = {
      receiveMessage(msg) {
        try {
          const data = (msg && msg.data) || {};
          if (data.debug) {
            try {
              console.log('[zen-page-tint frame] config received, rate =', data.liveRateMs,
                '| alwaysOn =', !!data.alwaysOn, '| threshold =', data.threshold);
            } catch {}
          }
          singleton.applyConfig(data);
        } catch (e) {
          try { console.error('[zen-page-tint frame] config handler error:', e); } catch {}
        }
      },
    };
    singleton.teardownListener = {
      receiveMessage() {
        try { singleton.teardown(); }
        catch (e) { try { console.error('[zen-page-tint frame] teardown error:', e); } catch {} }
      },
    };
    try { addMessageListener(CONFIG_MESSAGE_NAME, singleton.configListener); }
    catch (e) { try { console.error('[zen-page-tint frame] addMessageListener failed:', e); } catch {} }
    try { addMessageListener(TEARDOWN_MESSAGE_NAME, singleton.teardownListener); } catch {}

    globalThis.__zenPageTint = singleton;
    singleton.reload();
  } catch (e) {
    try { console.error('[zen-page-tint frame] init failed:', e); } catch {}
  }
})();
