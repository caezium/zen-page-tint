# Zen Page Tint

Adaptive chrome color for [Zen Browser](https://zen-browser.app/) — the URL bar, sidebar, titlebar, and outer rim tint to match the active page's background.

Built for heavy-tab sessions. Tested with 1000+ tabs open without measurable tab-switch lag.

## Why

Stock Zen uses a single accent color across the chrome. On a vibrant page it looks fine; on a page with a strong bg color the contrast feels off and the chrome reads as separate from the content. Tinting the chrome to the page bg merges them visually.

Other adaptive-color mods exist, but they tend to feel laggy at high tab counts because they:
- Schedule 5–7 separate theme recalculations per tab switch
- Animate color transitions across every `.tabbrowser-tab` element (thousands of nodes)
- Re-sample on every revisit instead of caching
- Hook synchronously into `TabSelect`, blocking the click

`zen-page-tint` is built around the opposite constraints:
- **One sample per tab switch** — rapid `TabSelect` + `onLocationChange` pairs coalesce into a single `requestAnimationFrame`
- **Per-origin LRU cache** (500 entries) — revisits are instant, zero IPC
- **Deferred via `requestAnimationFrame`** — tab clicks register before the JS runs
- **No transitions on per-tab elements** — color snaps; sidebar/toolbar still animate smoothly
- **Skips `about:` / `chrome:`** — keeps Zen's defaults where they belong

## Install

In Zen → Sine settings → **"Add your own locally from a GitHub repo"**, paste:

```
https://github.com/caezium/zen-page-tint
```

Enable in Sine, restart Zen.

> Until this is on the Sine store, you'll need `sine.allow-unsafe-js = true` in `about:config` for the script portion to load. (That's Sine's safety gate — the script only reads the current page's background color via a content-script bridge: no network calls, no external data.)

## Configuration

In `style.css` `:root`:

```css
--zpt-frame-gap: 5px;       /* gap between content area and window edge */
--zpt-frame-radius: 14px;   /* content corner radius */
--zpt-frame-shadow: ...;    /* drop shadow on content frame */
```

In `about:config`:

| Pref | Default | Effect |
|---|---|---|
| `zen.page-tint.debug` | `false` | When `true`, logs diagnostic events to the Browser Console (`Ctrl/Cmd-Shift-J`). Toggle live. |

## How it works

**`tint.uc.js`** runs in the chrome (`browser.xhtml`):
1. Listens for `TabSelect`, `onLocationChange` (top-level only), `TabClose`, and OS `prefers-color-scheme` changes.
2. On fire, coalesces via `requestAnimationFrame`, then samples the active browser.
3. Cache hit → applies `--zen-tab-header-background` + `--zen-tab-header-foreground` instantly (no IPC).
4. Cache miss → loads `frame.js` into the content process. Frame script samples + observes mutations, and pushes updates via `sendAsyncMessage`.
5. Cache is bounded LRU (500 entries) keyed by `origin + pathname`. Cleared on OS color-scheme change so prefers-color-scheme-aware sites re-sample fresh.
6. Foreground color picked via Rec 601 luminance — black or white for max contrast.

**`frame.js`** runs in the content process. Sample chain (first match wins):
1. `<meta name="theme-color">` — the site's declared signal, respecting `media` attributes (light/dark variants honored). Values are normalized to canonical `rgb()` via the canvas color parser, so hex / HSL / named colors all work.
2. **`drawWindow` pixel at viewport center (3×3 averaged)** — ground truth of what's actually rendered. Primary signal because apps like Gmail keep `<body>` light while painting dark UI on overlays/wrappers (body lies).
3. `body.backgroundColor` — fallback if drawWindow fails.
4. `html.backgroundColor`.
5. Walk up from `elementFromPoint` until a solid bg ancestor.

Also installs a `MutationObserver` on `<html>`/`<body>` with an `attributeFilter` of theme-relevant attributes (`class`, `style`, `data-theme`, `data-bs-theme`, `data-color-mode`, etc.) — avoids waking up on every aria/data churn. `load` and `pageshow` re-sample at +300ms and +2000ms with 500ms dedupe (catches slow apps that bootstrap their theme after load — Gmail).

> `drawWindow` is flagged non-standard in MDN and may be removed in a future Gecko. If that happens, the meta-tag and computed-style fallbacks still work, but Gmail-class accuracy is lost. No drop-in replacement exists today.

**`style.css`** applies the two CSS variables to URL bar, sidebar, titlebar, splitter, tab labels, and the outer window-background pseudo-elements (so the rim tints too — no purple bleed from Zen's accent color).

## Performance

Measured under a 1300-tab session:

| Path | CPU |
|---|---|
| Cache hit (revisit) | ~0.5 ms |
| Cache miss (first visit) | ~10–15 ms |
| Idle | ~0 |

The MutationObserver is filtered to ~11 theme-relevant attributes, so noisy pages (Twitch, Gmail chat indicators) don't keep waking the sampler.

## License

[MIT](LICENSE).

## Contributing

Issues and PRs welcome. Keep the per-tab-switch work bounded — cache hits should stay zero-IPC, and frame-script mutation handling should stay filtered + debounced.
