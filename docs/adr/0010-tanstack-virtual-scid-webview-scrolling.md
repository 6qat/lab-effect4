# 10. TanStack Virtual for SCID Webview Scrolling with Coordinate Downscaling

## Context

The SCID data viewer visualizes binary Sierra Chart Intraday Data (`.scid`) trade tick tapes containing up to 5,000,000+ trade records (e.g. `WINV26-2026-10-06.scid`). Previously, the webview used a custom zero-dependency virtual scrolling engine with linear math embedded inside a single template literal HTML string.

To standardize virtual windowing and leverage maintained ecosystem primitives, we evaluated migrating to `@tanstack/virtual-core`. However, standard TanStack Virtual exhibits a critical limitation on massive datasets:
Chromium/Electron caps DOM scrollable element heights at ~33.5 million pixels. At 28px per trade row, 5,000,000 records require 140,000,000px of scroll height. Out of the box, TanStack Virtual's linear `totalSize` crashes into this browser ceiling, freezing scrolling at ~1.19M rows. Furthermore, CSS `transform: translateY(112,000,000px)` on rows overflows browser compositor coordinates.

## Decision

We adopt `@tanstack/virtual-core` in the SCID webview with the following architectural choices:

1. **Vanilla TypeScript Webview Bundle**: Use headless `@tanstack/virtual-core` directly in vanilla TypeScript without a UI component framework (React/Preact). A dual-entry esbuild pipeline compiles `src/extension.ts` (`node`) and `src/editor/webview/main.ts` (`browser`), delivered via `webview.asWebviewUri` under strict Content Security Policy.
2. **Coordinate Downscaling Wrapper**: Cap the scroll container at 5,000,000px whenever the unscaled height exceeds 5,000,000px (`scaleRatio = 5,000,000 / rawHeight`). TanStack's virtualizer receives downscaled scroll offsets and items are rendered within the safe 5M px DOM coordinate space.
3. **CSS Grid Div Table**: Replace HTML `<table>/<tbody>` with semantic ARIA divs (`role="table"`, `role="row"`, `role="cell"`) styled with CSS Grid and sticky header.
4. **Container-Relative Spacers**: Visible rows are positioned inside an active window with scaled top and bottom spacers rather than absolute unscaled pixel transforms, guaranteeing no DOM node ever exceeds browser layout limits.
5. **Hybrid Chunk Cache & Reactive Live Tail**: Retain `WebviewChunkCache` (20 chunks × 500 rows) with predictive prefetching (250 margin) alongside TanStack's `overscan: 15`. On real-time `APPEND_RECORDS`, update `virtualizer.setOptions({ count: newTotal })` and pin to the true DOM `scrollHeight` when follow mode is active.
6. **Synchronous Initial State**: Embed initial file summary and the tail chunk in `<script id="scid-initial-data" type="application/json">` for instantaneous, zero-flash first paint.

## Consequences

- **Pros**:
  - Leverages standard, thoroughly tested TanStack Virtual windowing and scroll positioning algorithms.
  - Webview client code is modular, type-checked TypeScript rather than an untyped inline string.
  - Seamlessly supports both normal (<100k) and massive (5M+) tick files without hitting browser DOM height limits.
- **Cons & Trade-offs**:
  - Adds `@tanstack/virtual-core` runtime dependency to `packages/scid-viewer`.
  - Requires maintaining a dual-bundle build step in `esbuild.config.mjs`.
