# Zen Page Tint

Adaptive chrome color for [Zen Browser](https://zen-browser.app/) — the URL bar, sidebar, titlebar, and outer rim tint to match the active page's background.

**Designed for large tab sessions.** Reuses sampled colors, avoids per-tab tint animations, and leaves unloaded tabs asleep.

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
- **Per-URL LRU cache** (3000 entries) — settled-tab revisits are instant, zero IPC; query strings and hash routes stay separate
- **Deferred via `requestAnimationFrame` + setTimeout race** — tab clicks register before the JS runs, and the safety-net `setTimeout` means we don't get stuck when `rAF` is throttled
- **No transitions on per-tab elements** — color snaps; sidebar/toolbar still animate smoothly
- **Skips `about:` / `chrome:`** — keeps Zen's defaults where they belong

## Install

This mod requires [Sine](https://github.com/CosmoCreeper/Sine). Check that Sine appears in Zen Settings before installing the mod.

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
| `zen.page-tint.brightness` | `100` | Gain (0–300) on the tint's lightness. `200` = twice as light. Applied *before* the lightness clamps, so those stay hard bounds. Acts on HSL lightness rather than multiplying RGB channels, so it can't shift hue or clip one channel first. |
| `zen.page-tint.contrast` | `100` | Pushes lightness (0–300) away from mid-grey — `200` doubles the distance from 50%, `0` flattens to grey. Acts on the single averaged color, so it deepens darks and lifts lights; it can't add local contrast the way a filter over an image would. |
| `zen.page-tint.ambient-spread` | `0` | Strength (0–100) of the **directional gradient** — see [Directional ambient gradient](#directional-ambient-gradient). `0` = flat tint (default, and the sampler skips the extra work entirely). |
| `zen.page-tint.min-lightness` | `0` | Lightness **floor** (0–100): keeps near-black pages from making the chrome muddy. `0` = no floor. |
| `zen.page-tint.max-lightness` | `100` | Lightness **cap** (0–100): keeps blinding-white pages from washing the chrome out. `100` = no cap. |
| `zen.page-tint.disable-hosts` | `''` | Comma-separated host list (same syntax as `live-mode-hosts`, supports `*.example.com`) where the tint is turned **off** — the chrome keeps your Zen theme on those sites. |
| `zen.page-tint.youtube-ambient` | `true` | On YouTube, sample the **video's own picture box** rather than a centered viewport grab, gated on the player's Ambient mode being on — see [YouTube ambient mode](#youtube-ambient-mode). Falls back to normal sampling when Ambient mode is off. |
| `zen.page-tint.light-average` | `false` | Average **page** samples in linear light, with extra weight for vivid pixels. This often produces brighter, more saturated results; the chroma weighting is an aesthetic choice. A mostly-dark page with bright content can stop reading as dark, which is why it's off by default. The YouTube source always uses this model. |
| `zen.page-tint.frame-gap` | `5` | Gap (px) between the content area and the window edge in non-compact mode. Compact mode stays flush so Zen's screen-edge hover controls remain reachable. Extremely large values can push the page viewport entirely offscreen. |
| `zen.page-tint.frame-radius` | `14` | Content corner radius (px). |

**Need a restart** (read once at load):

| Pref | Default | Effect |
|---|---|---|
| `zen.page-tint.live-mode` | `true` | Master switch for live mode — continuous polling so the chrome tint follows video / animated content. When off, the tint is purely event-driven. |
| `zen.page-tint.live-mode-rate-ms` | `2000` | The poll interval (0.5 Hz), used **verbatim** — this is how often the chrome color can change. Floored at 100 ms as a guard against an absurd value. Keep it at or above `live-mode-smoothing-ms`, or each fade is interrupted by the next sample and the chrome never settles on a color. |
| `zen.page-tint.live-mode-threshold` | `8` | Minimum per-channel color change (0–255) needed to actually re-tint during live polling. With ambient spread enabled, directional colors are checked too. Imperceptible frame-to-frame jitter below this is ignored so the chrome doesn't churn on near-static scenes. `0` = re-tint on any change. This is the sensitivity knob; `live-mode-rate-ms` is the cadence knob, and they're independent. |
| `zen.page-tint.live-mode-smoothing-ms` | `1000` | Duration of the CSS fade applied to **every** tint change (live ticks, event-driven samples, and tab-switch cache hits). |
| `zen.page-tint.live-mode-always-on` | `false` | When `false`, live polling only runs while a `<video>` on the page is actually playing — static pages cost nothing. Set `true` to poll every foregrounded page regardless. |
| `zen.page-tint.live-mode-hosts` | `''` | Comma-separated host allowlist; matching sites are treated as always-on. The supported workaround for players auto-detect can't see — canvas/WebGL players and cross-origin `<iframe>` embeds. Matched by hostname, so port-independent (`localhost` matches `localhost:3000`). Supports `*.example.com`. Example: `example.com, *.spotify.com, localhost`. |
| `zen.page-tint.debug` | `false` | When `true`, logs diagnostic events to the Browser Console (`Cmd-Shift-J` / `Ctrl-Shift-J`). |

The `--zpt-frame-shadow` drop shadow is still a CSS knob in `style.css` `:root` if you want to tune it.

## Directional ambient gradient

By default the chrome takes one flat color from the page. With `zen.page-tint.ambient-spread` above `0`, it instead takes color from the *matching side*: the left of the URL bar strip from the left of the page, the top of the sidebar from the top, and so on — so a video with a warm left edge and a cool right edge lights the chrome the same way round.

`frame.js` reduces the sampled region to a 16×16 grid. With spread enabled it also averages four directional bands (6 columns/rows in from each edge, leaving the middle to neither so the two sides stay distinguishable). This reuses the same pixel capture; at spread `0` the band calculations are skipped.

The flat color and directional gradients compose inside one overlay. Tint strength controls the opacity of that complete result, so strength `50` preserves 50% of the native background even at full spread. Applying 50% independently to a flat tint and a gradient would compound their opacity. The flat color and overall opacity fade smoothly; directional stops update at each accepted sample. All colors use the same saturation, brightness, contrast and lightness adjustments.

Two deliberate limits:

- **Spread is limited by text contrast.** Edge opacity is reduced when the resulting gradient would make the chosen foreground unreadable, including intermediate colors between its endpoints. Below full strength, contrast uses an approximation of the native background; arbitrary workspace gradients and native materials can still need manual tuning.
- **The sidebar and surround share a vertical gradient; the URL strip gets a horizontal one.** Both are inside the same window overlay, with a cutout separating their regions. Compact panels carry their gradient inside Zen's own rounded clip. The vertical field stays aligned when the sidebar moves to the right.

Only the two grid-based sample paths can produce a gradient. A page whose color comes from `<meta name="theme-color">` or a computed style yields one value with no spatial content, so it tints flat — which is correct, since there'd be nothing to infer a direction from.

This is a coarse directional approximation of the userstyle's glow. It has four edge colors and no two-dimensional image diffusion, corner samples, or page-side blur.

## YouTube ambient mode

YouTube's own "Ambient mode" (cinematic lighting) paints downscaled copies of the current video frame into canvases behind the player and CSS-blurs them into the glow around the video. With `zen.page-tint.youtube-ambient` on (the default), the sampler reads the **video's painted picture box** — the same frames that glow is built from — instead of a centered viewport grab, so the browser frame and the player glow track each other.

Two things it fixes:

- **Layout letterbox bars are excluded.** The picture box is derived from the video's intrinsic dimensions and layout box, with a 4% inset. Black bars encoded into the video itself remain part of the picture.
- **Comments and recommendations are excluded.** Sampling is confined to the video picture. Controls, subtitles, or dialogs painted over that picture can still affect the capture.

This path is always averaged as *light* (linear, chroma-weighted) regardless of `light-average`, because it's modelling light coming off a screen rather than a flat surface color.

Cropping to the video removes the static page furniture that used to damp frame-to-frame variance, so on moving content nearly every poll clears `live-mode-threshold`. That means the chrome changes at your configured `live-mode-rate-ms` — every 2 s by default. Raise the rate for a calmer frame, or raise the threshold if you'd rather it only react to real scene changes.

**Why not read YouTube's canvas directly?** The earlier canvas-copy implementation encountered `SecurityError` once cross-origin video frames arrived. This implementation instead uses the privileged `drawWindow` capture already used for ordinary pages. It samples the source picture and applies its own averaging; it does not reproduce YouTube's exact blur, color processing or cross-fade timing.

**Turning it on:** enable Ambient mode in the YouTube player's settings on a watch page. The mod checks that `#cinematics` is rendered and visible, since YouTube can retain a hidden element when Ambient mode is off. Visibility changes also resample a paused video. If another mod hides that element, ordinary page sampling is used instead.

The mod colors browser chrome directly and needs no transparency mod or page-side blur. Pixel capture, readback, styling, and compositing still have a cost; the absence of a large blur pass does not mean zero CPU or GPU overhead.

## Known limitations

- **Some live Boost edits require a refresh.** Styling changes made through `CSSStyleSheet.insertRule` or browser-level user stylesheets don't fire a DOM `MutationObserver`. Reload the page to resample them; switching away and back can reuse the cached color. Always-on foreground polling can also detect these edits when enabled.
- **YouTube in fullscreen video** uses ordinary viewport sampling whenever its ambient element is absent or hidden, which can include layout letterbox bars.
- **Live mode doesn't auto-detect video inside cross-origin `<iframe>` embeds** (the common YouTube/Vimeo/Spotify embed on a third-party page). That `<video>` lives in a separate browsing context, so its play/pause events never reach the parent document and auto-detect can't see it. The tint *would* follow it correctly if polling ran — only the trigger is missing. Workaround: add the host to `zen.page-tint.live-mode-hosts` to force always-on polling there. A site's own pages (e.g. youtube.com itself, where the `<video>` is same-origin) work without this.
- **`drawWindow` is flagged non-standard in MDN** and may be removed in a future Gecko. If that happens, the meta-tag and computed-style fallbacks still work but Gmail-class accuracy is lost. No drop-in replacement exists today.

## How it works

**`tint.uc.js`** runs in the chrome (`browser.xhtml`):
1. Listens for `TabSelect`, `onLocationChange` (top-level only — iframe loads filtered out), `TabClose`, and OS `prefers-color-scheme` changes.
2. On fire, coalesces via `requestAnimationFrame` raced against a 100ms `setTimeout` safety net (rAF can be throttled when the window is occluded), then samples the active browser.
3. A settled tab restores its own last sample immediately, including directional colors. Duplicate URLs keep separate samples, since video frames, scroll positions and app state can differ. Revisiting the same document, URL and settings needs no IPC.
4. Cache miss → loads `frame.js` into the content process. Frame script samples + observes mutations, and pushes updates via `sendAsyncMessage`.
5. Tabs without a current sample can show a provisional tint from a bounded LRU cache (3000 entries) keyed by the full URL, including query strings and fragments, while their own sampler starts. Color-source and OS color-scheme changes invalidate cached samples. Request IDs and configuration revisions reject stale replies, including replies queued before a mod hot reload.
6. Sampled colors are adjusted for saturation, brightness, contrast and lightness bounds. Black or white foreground is chosen using linear-sRGB relative luminance and contrast ratios.
7. A transient Zen Glance keeps its parent tab's tint while the parent remains visible behind it. Expanding the Glance into a normal tab hands tint ownership to the child and samples it normally.

**`frame.js`** runs in the content process. Sample chain (first match wins):
0. **YouTube's video picture box** (host-gated to `*.youtube.com`, gated on `#cinematics` being visible, only when `youtube-ambient` is on) — a `drawWindow` read of the painted video region, excluding layout letterbox bars. Falls through to step 1 when the gate isn't satisfied or the player is scrolled out of view.
1. **`drawWindow` pixel of the central 60% of the viewport, downsampled to a 16×16 grid and averaged** — ground truth of what's actually painted, weighted to the dominant central tone rather than whatever single element lands dead-center. Picks up Zen Boost overlays, dark-mode toggles, Gmail-class apps where `<body>` lies about the visible color.
2. `<meta name="theme-color">` — fallback for the rare case where pixel can't read (pre-paint, fully transparent page). Note this is often the *address-bar* color a site declares for mobile, **not** its page bg — e.g. GitHub's meta is `rgb(30,35,39)` but its actual page bg is `rgb(13,17,23)` — so we prefer pixel even when meta is present. Media-aware (light/dark variants honored) and normalized to canonical `rgb()` via the canvas color parser, so hex/HSL/named all work.
3. `body.backgroundColor`.
4. `html.backgroundColor`.
5. Walk up from `elementFromPoint` until a solid-bg ancestor.

Observers in content:
- **`<html>` / `<body>` attribute mutations** — filtered to ~11 theme-relevant attributes (`class`, `style`, `data-theme`, `data-bs-theme`, `data-color-mode`, etc.) so noisy pages don't keep waking the sampler.
- **`<head>` mutations and stylesheet loads** — filtered mutations catch stylesheet swaps and dynamic theme-color changes; a stylesheet-specific load handler catches downloads that finish after the mutation debounce. Title churn is ignored even while hidden.
- **`load` + `pageshow`** — re-sample at +300ms and +2000ms with 500ms dedupe (catches slow apps that bootstrap their theme after `load` — Gmail). Every sample checks visibility; hidden work waits until the tab is shown. Disposal cancels timers, observers and listeners.

**`style.css`** paints one overlay inside the window backdrop and each native compact-panel backdrop. The base and gradients compose inside it before tint strength applies, so 50% remains 50% with ambient spread enabled. Containers above them stay transparent. Zen retains its workspace gradients, materials, panel clipping and reveal animations. Only these leaf overlays animate their color and opacity; tab labels change immediately. Cleanup removes the overlays and restores the original inline CSS values.

## Performance

Settled tab revisits reuse samples without content-process messages. Static pages do not continuously poll by default, and background tabs suspend polling. Appearance changes avoid enumerating unloaded browsers; a regression test checks this with 1,700 simulated unloaded tabs.

Pixel capture, canvas readback, styling and compositing still cost work. The tests verify these scheduling and caching behaviors, not a current CPU/GPU percentage or a benchmark of a real large-tab session.

## Compatibility

- Developed on Zen 1.20b+ on macOS; also reported working on Linux (the compact-mode and contrast fixes in 1.5.x came from a CachyOS user). Windows should work too — selectors target Zen's stable chrome IDs — but it's unverified there. Reports welcome.
- Sine required (install via the Sine store, or locally from this repo).

## License

[MIT](LICENSE).

## Testing

Run the regression tests with Node.js 18 or later:

```sh
node --test tests/*.test.cjs
```

For renderer and message-bridge checks against an installed Zen, run:

```sh
python3 tests/zen-smoke.py
# Or pass a different Zen executable:
python3 tests/zen-smoke.py /path/to/zen
```

The smoke test launches a disposable headless profile and leaves your normal profile alone. It loads the actual scripts through a temporary resource package and substitutes Sine's frame-script transport with the same source bytes. It checks sampling, cache reuse, rendered opacity at strength 1/50/100 and spread 0/100, both sidebar sides and toolbar layouts, compact mode, fullscreen and teardown. Screenshots and pixel measurements are saved in the printed temporary directory. Manual checks are still useful for OS materials, real video players, Glance and large tab sessions.

## Contributing

Issues and PRs welcome. Two guardrails:
- Keep per-tab-switch work bounded — cache hits should stay zero-IPC, and frame-script mutation handling should stay filtered + debounced.
- If you add a new sample-chain step, add a one-liner explaining the case it catches that the existing steps miss.
