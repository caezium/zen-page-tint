# Zen Page Tint

Adaptive chrome color for [Zen Browser](https://zen-browser.app/) — the URL bar, sidebar, titlebar, and outer rim tint to match the active page's background.

## Install

In Zen → Sine settings → **"Add your own locally from a GitHub repo"**, paste:

```
https://github.com/caezium/zen-page-tint
```

Enable, restart Zen.

> Until this is on the Sine store, you'll need `sine.allow-unsafe-js = true` in `about:config` for the script portion to load.

## How it works

**`tint.uc.js`** runs in the chrome (`browser.xhtml`):
1. Listens for `TabSelect`, `onLocationChange`, `TabClose`.
2. On fire, defers via `requestAnimationFrame`, then samples the active browser.
3. Cache hit → applies `--zen-tab-header-background` + `--zen-tab-header-foreground` instantly (no IPC).
4. Cache miss → loads `frame.js` into the content process. Frame script samples + observes mutations, and pushes updates via `sendAsyncMessage`.
5. Cache is bounded LRU (500 entries) keyed by `origin + pathname`.
6. Foreground color picked via Rec 601 luminance — black or white for max contrast.

**`frame.js`** runs in the content process. Sample chain (first match wins):
1. `<meta name="theme-color">`.
2. `body.backgroundColor`.
3. `html.backgroundColor`.
4. Walk up from `elementFromPoint` until a solid bg ancestor.

Also installs a `MutationObserver` on `<html>`/`<body>` to catch in-page theme toggles.

**`style.css`** applies the two CSS variables to URL bar, sidebar, titlebar, splitter, tab labels, and outer chrome surfaces.

## Configuration

In `style.css` `:root`:

```css
--zpt-frame-gap: 5px;       /* gap between content area and window edge */
--zpt-frame-radius: 14px;   /* content corner radius */
--zpt-frame-shadow: ...;    /* drop shadow on content frame */
```

## License

[MIT](LICENSE).
