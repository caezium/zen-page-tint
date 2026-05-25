# Zen Page Tint

Adaptive chrome color for [Zen Browser](https://zen-browser.app/) — the URL bar, sidebar, titlebar, and outer rim tint to match the active page's background.

**Built for heavy-tab sessions.** Tested at 1,200+ open tabs without measurable tab-switch lag.

<!-- TODO: drop a screenshot/GIF here. Side-by-side of chrome on a light vs dark page, or a short clip of switching between 4-5 contrasty tabs, lands much better than text. -->

## Why this exists

Stock Zen uses a single accent color across the chrome. On a vibrant page that looks fine; on a strongly-themed page the contrast feels off and the chrome reads as separate from the content. Tinting the chrome to the page bg merges them visually — like Arc and Dia do.

Other adaptive-color mods exist, but they tend to feel laggy at high tab counts because they:
- Schedule 5–7 separate theme recalculations per tab switch
- Animate color transitions across every `.tabbrowser-tab` element (thousands of nodes)
- Re-sample on every revisit instead of caching
- Hook synchronously into `TabSelect`, blocking the click

`zen-page-tint` is built around the opposite constraints:
- **One sample per tab switch** — `TabSelect` + `onLocationChange` pairs coalesce into a single deferred run
- **Per-origin LRU cache** (500 entries) — revisits are instant, zero IPC
- **Deferred via `requestAnimationFrame` + setTimeout race** — tab clicks register before the JS runs, and the safety-net `setTimeout` means we don't get stuck when `rAF` is throttled
- **No transitions on per-tab elements** — color snaps; sidebar/toolbar still animate smoothly
- **Skips `about:` / `chrome:`** — keeps Zen's defaults where they belong

## Install

In Zen → Sine settings → **"Add your own locally from a GitHub repo"**, paste:

```
https://github.com/caezium/zen-page-tint
```

Enable in Sine, restart Zen.

> Until this is on the Sine store you'll need `sine.allow-unsafe-js = true` in `about:config` for the script portion to load. (That's Sine's safety gate — the script only reads the current page's background color via a content-script bridge: no network calls, no external data.)

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
| `zen.page-tint.debug` | `false` | When `true`, logs diagnostic events to the Browser Console (`Cmd-Shift-J` / `Ctrl-Shift-J`). Toggle live. |

## Known limitations

- **Boost edits on the currently open page require a refresh.** When you live-edit a [Zen Boost](https://zen-browser.app/) on a page that's already loaded, the chrome tint won't update until you refresh the page (or switch to another tab and back). Boosts apply styling via `CSSStyleSheet.insertRule` and browser-level user-stylesheets, neither of which fires a DOM `MutationObserver`. Background polling would catch it but at a constant CPU cost that didn't feel worth it — open to revisiting if folks ask.
- **YouTube in fullscreen video** mode samples the current video frame's center pixel, which is whatever's on screen at that moment. Outside fullscreen it samples the player chrome and works correctly.
- **`drawWindow` is flagged non-standard in MDN** and may be removed in a future Gecko. If that happens, the meta-tag and computed-style fallbacks still work but Gmail-class accuracy is lost. No drop-in replacement exists today.

## How it works

**`tint.uc.js`** runs in the chrome (`browser.xhtml`):
1. Listens for `TabSelect`, `onLocationChange` (top-level only — iframe loads filtered out), `TabClose`, and OS `prefers-color-scheme` changes.
2. On fire, coalesces via `requestAnimationFrame` raced against a 100ms `setTimeout` safety net (rAF can be throttled when the window is occluded), then samples the active browser.
3. Cache hit → applies `--zen-tab-header-background` + `--zen-tab-header-foreground` instantly (no IPC).
4. Cache miss → loads `frame.js` into the content process. Frame script samples + observes mutations, and pushes updates via `sendAsyncMessage`.
5. Cache is bounded LRU (500 entries) keyed by `origin + pathname`. Cleared on OS color-scheme change so prefers-color-scheme-aware sites re-sample fresh.
6. Foreground color picked via Rec 601 luminance — black or white for max contrast.

**`frame.js`** runs in the content process. Sample chain (first match wins):
1. **`drawWindow` pixel at viewport center (3×3 averaged)** — ground truth of what's actually painted. Picks up Zen Boost overlays, dark-mode toggles, Gmail-class apps where `<body>` lies about the visible color.
2. `<meta name="theme-color">` — fallback for the rare case where pixel can't read (pre-paint, fully transparent page). Note this is often the *address-bar* color a site declares for mobile, **not** its page bg — e.g. GitHub's meta is `rgb(30,35,39)` but its actual page bg is `rgb(13,17,23)` — so we prefer pixel even when meta is present. Media-aware (light/dark variants honored) and normalized to canonical `rgb()` via the canvas color parser, so hex/HSL/named all work.
3. `body.backgroundColor`.
4. `html.backgroundColor`.
5. Walk up from `elementFromPoint` until a solid-bg ancestor.

Observers in content:
- **`<html>` / `<body>` attribute mutations** — filtered to ~11 theme-relevant attributes (`class`, `style`, `data-theme`, `data-bs-theme`, `data-color-mode`, etc.) so noisy pages don't keep waking the sampler.
- **`<head>` mutations** — `childList` + `subtree characterData` + filtered attributes on `link`/`meta`/`style`. Catches stylesheet swaps and dynamic theme-color changes.
- **`load` + `pageshow`** — re-sample at +300ms and +2000ms with 500ms dedupe (catches slow apps that bootstrap their theme after `load` — Gmail).

**`style.css`** applies the two CSS variables to URL bar, sidebar, titlebar, splitter, tab labels, and the outer window-background pseudo-elements (so the rim tints too — no accent-color bleed from Zen's theme).

## Performance

Measured under a 1,200+ tab session:

| Path | CPU |
|---|---|
| Cache hit (revisit) | ~0.5 ms |
| Cache miss (first visit) | ~10–15 ms |
| Idle | ~0 |

## Compatibility

- Tested on Zen 1.20b+ on macOS. Should work on Linux and Windows — selectors target Zen's stable chrome IDs — but I haven't verified there yet. Reports welcome.
- Sine required (currently the only install path).

## License

[MIT](LICENSE).

## Contributing

Issues and PRs welcome. Two guardrails:
- Keep per-tab-switch work bounded — cache hits should stay zero-IPC, and frame-script mutation handling should stay filtered + debounced.
- If you add a new sample-chain step, add a one-liner explaining the case it catches that the existing steps miss.
