# Zen Page Tint v2.1 — video colors across the browser, with adjustable ambient gradients

Draft for posting with the v2.1.0 release. Review the visual claims against a fresh recording before posting.

---

Zen Page Tint makes the sidebar, toolbar and frame around a page follow its colors. This update was inspired by [u/bgalazka186's YouTube ambient lighting post](https://www.reddit.com/r/zen_browser/comments/1uh1xc8/).

With YouTube's Ambient mode on, the mod samples the video's picture area, excluding the comments, recommendations and letterbox padding around the video. Turn on ambient spread and the chrome also picks up directional colors: warm at the top of a scene, cool at the bottom, for example. It works on ordinary pages too, provided there's color variation in the sampled area.

You can adjust strength, saturation, brightness, contrast and spread. Strength now applies once to the complete tint, including the gradient, so 50% preserves half of your original workspace background. That fixes the uneven sidebar blocks and mismatched page rim that appeared below full strength. Both sidebar positions and toolbar layouts are covered, and compact panels keep their rounded clipping.

This uses four directional colors rather than recreating YouTube's full blurred image. It doesn't add a page-side blur or require a transparency mod, but sampling and rendering still cost work. Video polling follows the configured interval and pauses in background tabs; ordinary static pages don't continuously poll by default.

Install **Zen Page Tint** through Sine. Settings are in the mod's Sine panel, and the [repository](https://github.com/caezium/zen-page-tint) has the full configuration reference.

---

## Recording outline

There is no source recording available, so no new GIF has been generated. The current `assets/demo.gif` and `assets/live.gif` predate these changes.

1. **Lead with a 10–12 second video clip.** Pick slow, broad color changes and keep the entire browser visible. Use the normal 2000 ms sampling interval and 1000 ms smoothing; enable ambient spread. Include the sidebar and page rim so their matching gradient is visible.
2. **Show strength over a workspace gradient.** Record 100 → 50 → 1 → 0, holding each value long enough for the fade to finish. Keep spread enabled so this demonstrates the complete tint's opacity.
3. **Show ordinary pages briefly.** Switch among a light page, a dark page and a colorful image. Hold each for roughly two seconds so the tint and readable foreground settle.
4. **Use one settings screenshot.** Capture the Sine controls after choosing the settings used in the recording. A separate compact-mode or right-sidebar screenshot is useful if those improvements are mentioned in the post.

Keep the source recording as video. Convert a short excerpt to GIF only after checking gradient banding and file size; video is the better master for smooth color transitions.

## Claims to keep bounded

- The source is the painted video region, not YouTube's processed ambient canvas. Encoded black bars, subtitles and controls over the picture can still influence it.
- Brightness and contrast adjust sampled colors; they are not equivalent to filtering an entire image before averaging.
- Automated checks cover fixed polling cadence, hidden-tab suspension and avoiding lazy-tab activation. They do not establish a current CPU/GPU percentage or a benchmark with 1,700 real tabs.
- The four-color gradient is a directional approximation. Uniform pages naturally produce little visible spread.
