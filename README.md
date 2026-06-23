# Zen Page Tint

Adaptive chrome color for [Zen Browser](https://zen-browser.app/) — the URL bar, sidebar, titlebar, and outer rim tint to match the active page's background.

**Built for heavy-tab sessions.** Tested at 1,200+ open tabs without measurable tab-switch lag.

**Fully tunable** from a Sine settings panel — tint strength (overlay over your own Zen theme/gradient), saturation, lightness clamp, and per-site rules. See [Configuration](#configuration).

![Zen Page Tint — the chrome color follows the active page](assets/demo.gif)

*The URL bar, sidebar, titlebar, and outer rim tint to the active page as you switch tabs.*


![Live mode — the chrome follows a playing video](assets/live.gif)

*Live mode: with a video playing, the chrome continuously tracks the scene's color.*

## Why this exists

Stock Zen uses a single accent color across the chrome. On a vibrant page that looks fine; on a strongly-themed page the contrast feels off and the chrome reads as separate from the content. Tinting the chrome to the page bg merges them visually — like Arc and Dia do.

Other adaptive-color mods exist, but they tend to feel laggy at high tab counts because they:
- Schedule 5–7 separate theme recalculations per tab switch
- Animate color transitions across every `.tabbrowser-tab` element (thousands of nodes)
- Re-sample on every revisit instead of caching
- Hook synchronously into `TabSelect`, blocking the click

`zen-page-tint` is built around the opposite constraints:
- **One sample per tab switch** — `TabSelect` + `onLocationChange` pairs coalesce into a single deferred run
- **Per-origin LRU cache** (3000 entries) — revisits are instant, zero IPC
- **Deferred via `requestAnimationFrame` + setTimeout race** — tab clicks register before the JS runs, and the safety-net `setTimeout` means we don't get stuck when `rAF` is throttled
- **No transitions on per-tab elements** — color snaps; sidebar/toolbar still animate smoothly
- **Skips `about:` / `chrome:`** — keeps Zen's defaults where they belong

## Install

**From the Sine store** (recommended): in Zen, open **Sine → Marketplace**, search **Zen Page Tint**, and install. Enable it and restart Zen — updates then land automatically.

**Or add it locally from this repo:** Sine settings → **"Add your own locally from a GitHub repo"** → paste `https://github.com/caezium/zen-page-tint` → enable → restart. A local (unvetted) install also needs `sine.allow-unsafe-js = true` in `about:config` for the script portion to load.

> **No network calls, no telemetry** — the script only reads the current page's background color locally via a content-script bridge; no external data leaves your machine.

## Configuration

Everything is configurable from the **Sine settings panel** for this mod (Zen → Sine → Zen Page Tint → ⚙). Each setting maps 1:1 to an `about:config` pref, so you can also set them there directly.

**Apply live** (no restart):

| Pref | Default | Effect |
|---|---|---|
| `zen.page-tint.mix-amount` | `100` | Tint **strength** (0–100): the sampled **page** color is laid as a translucent **overlay** over Zen's own chrome (including per-workspace gradients). `100` = full page color (the default); `0` = no tint, your untouched Zen theme/gradient shows through; in between veils the gradient with the page color. (It's an opacity overlay, not a color blend, because a workspace gradient can't be reproduced by mixing a single color.) |
| `zen.page-tint.saturation` | `100` | Vibrancy (0–200) of the tint. `0` = grayscale chrome, `100` = the page's own saturation, `200` = double. |
| `zen.page-tint.min-lightness` | `0` | Lightness **floor** (0–100): keeps near-black pages from making the chrome muddy. `0` = no floor. |
| `zen.page-tint.max-lightness` | `100` | Lightness **cap** (0–100): keeps blinding-white pages from washing the chrome out. `100` = no cap. |
| `zen.page-tint.disable-hosts` | `''` | Comma-separated host list (same syntax as `live-mode-hosts`, supports `*.example.com`) where the tint is turned **off** — the chrome keeps your Zen theme on those sites. |
| `zen.page-tint.frame-gap` | `5` | Gap (px) between the content area and the window edge. |
| `zen.page-tint.frame-radius` | `14` | Content corner radius (px). |

**Need a restart** (read once at load):

| Pref | Default | Effect |
|---|---|---|
| `zen.page-tint.live-mode` | `true` | Master switch for live mode — continuous polling so the chrome tint follows video / animated content. When off, the tint is purely event-driven. |
| `zen.page-tint.live-mode-rate-ms` | `2000` | The **idle** poll interval (0.5 Hz). Sampling is adaptive: it speeds up to `rate ÷ 4` (floored at 250 ms / 4 Hz) while the color is actively changing, then backs off to this rate once it's stable. So scene changes are followed responsively while static frames stay cheap. |
| `zen.page-tint.live-mode-threshold` | `8` | Minimum per-channel color change (0–255) needed to actually re-tint the chrome during live polling. Imperceptible frame-to-frame jitter below this is ignored, so the chrome doesn't churn (and the adaptive rate backs off) on near-static scenes. `0` = re-tint on any change. |
| `zen.page-tint.live-mode-smoothing-ms` | `1000` | Duration of the CSS fade applied to **every** tint change (live ticks, event-driven samples, and tab-switch cache hits). |
| `zen.page-tint.live-mode-always-on` | `false` | When `false`, live polling only runs while a `<video>` on the page is actually playing — static pages cost nothing. Set `true` to poll every foregrounded page regardless. |
| `zen.page-tint.live-mode-hosts` | `''` | Comma-separated host allowlist; matching sites are treated as always-on. The supported workaround for players auto-detect can't see — canvas/WebGL players and cross-origin `<iframe>` embeds. Matched by hostname, so port-independent (`localhost` matches `localhost:3000`). Supports `*.example.com`. Example: `example.com, *.spotify.com, localhost`. |
| `zen.page-tint.debug` | `false` | When `true`, logs diagnostic events to the Browser Console (`Cmd-Shift-J` / `Ctrl-Shift-J`). |

The `--zpt-frame-shadow` drop shadow is still a CSS knob in `style.css` `:root` if you want to tune it.

## Known limitations

- **Boost edits on the currently open page require a refresh.** When you live-edit a [Zen Boost](https://zen-browser.app/) on a page that's already loaded, the chrome tint won't update until you refresh the page (or switch to another tab and back). Boosts apply styling via `CSSStyleSheet.insertRule` and browser-level user-stylesheets, neither of which fires a DOM `MutationObserver`. Background polling would catch it but at a constant CPU cost that didn't feel worth it — open to revisiting if folks ask.
- **YouTube in fullscreen video** mode samples the current video frame's center pixel, which is whatever's on screen at that moment. Outside fullscreen it samples the player chrome and works correctly.
- **Live mode doesn't auto-detect video inside cross-origin `<iframe>` embeds** (the common YouTube/Vimeo/Spotify embed on a third-party page). That `<video>` lives in a separate browsing context, so its play/pause events never reach the parent document and auto-detect can't see it. The tint *would* follow it correctly if polling ran — only the trigger is missing. Workaround: add the host to `zen.page-tint.live-mode-hosts` to force always-on polling there. A site's own pages (e.g. youtube.com itself, where the `<video>` is same-origin) work without this.
- **`drawWindow` is flagged non-standard in MDN** and may be removed in a future Gecko. If that happens, the meta-tag and computed-style fallbacks still work but Gmail-class accuracy is lost. No drop-in replacement exists today.

## How it works

**`tint.uc.js`** runs in the chrome (`browser.xhtml`):
1. Listens for `TabSelect`, `onLocationChange` (top-level only — iframe loads filtered out), `TabClose`, and OS `prefers-color-scheme` changes.
2. On fire, coalesces via `requestAnimationFrame` raced against a 100ms `setTimeout` safety net (rAF can be throttled when the window is occluded), then samples the active browser.
3. Cache hit → applies `--zen-tab-header-background` + `--zen-tab-header-foreground` instantly (no IPC).
4. Cache miss → loads `frame.js` into the content process. Frame script samples + observes mutations, and pushes updates via `sendAsyncMessage`.
5. Cache is bounded LRU (3000 entries) keyed by `origin + pathname`. Cleared on OS color-scheme change so prefers-color-scheme-aware sites re-sample fresh.
6. Sampled color is adjusted (saturation / lightness clamp) and the foreground (black or white) is picked against the result via Rec 601 luminance for max contrast.

**`frame.js`** runs in the content process. Sample chain (first match wins):
1. **`drawWindow` pixel of the central 60% of the viewport, downsampled to a 16×16 grid and averaged** — ground truth of what's actually painted, weighted to the dominant central tone rather than whatever single element lands dead-center. Picks up Zen Boost overlays, dark-mode toggles, Gmail-class apps where `<body>` lies about the visible color.
2. `<meta name="theme-color">` — fallback for the rare case where pixel can't read (pre-paint, fully transparent page). Note this is often the *address-bar* color a site declares for mobile, **not** its page bg — e.g. GitHub's meta is `rgb(30,35,39)` but its actual page bg is `rgb(13,17,23)` — so we prefer pixel even when meta is present. Media-aware (light/dark variants honored) and normalized to canonical `rgb()` via the canvas color parser, so hex/HSL/named all work.
3. `body.backgroundColor`.
4. `html.backgroundColor`.
5. Walk up from `elementFromPoint` until a solid-bg ancestor.

Observers in content:
- **`<html>` / `<body>` attribute mutations** — filtered to ~11 theme-relevant attributes (`class`, `style`, `data-theme`, `data-bs-theme`, `data-color-mode`, etc.) so noisy pages don't keep waking the sampler.
- **`<head>` mutations** — `childList` + `subtree characterData` + filtered attributes on `link`/`meta`/`style`. Catches stylesheet swaps and dynamic theme-color changes.
- **`load` + `pageshow`** — re-sample at +300ms and +2000ms with 500ms dedupe (catches slow apps that bootstrap their theme after `load` — Gmail).

**`style.css`** lays the page color as a translucent **overlay** (`--zpt-tint`, opacity set by the strength pref) across the URL bar, sidebar, titlebar, splitter, tab labels, and the outer window-background rim. Below full strength, Zen's own theme / workspace gradient shows through; the rim uses an inset box-shadow so the gradient survives underneath instead of being painted over.

## Performance

Measured under a 1,200+ tab session:

| Path | CPU |
|---|---|
| Cache hit (revisit) | ~0.5 ms |
| Cache miss (first visit) | ~10–15 ms |
| Idle | ~0 |

## Compatibility

- Developed on Zen 1.20b+ on macOS; also reported working on Linux (the compact-mode and contrast fixes in 1.5.x came from a CachyOS user). Windows should work too — selectors target Zen's stable chrome IDs — but it's unverified there. Reports welcome.
- Sine required (install via the Sine store, or locally from this repo).

## License

[MIT](LICENSE).

## Contributing

Issues and PRs welcome. Two guardrails:
- Keep per-tab-switch work bounded — cache hits should stay zero-IPC, and frame-script mutation handling should stay filtered + debounced.
- If you add a new sample-chain step, add a one-liner explaining the case it catches that the existing steps miss.
