# SCID Data Viewer (`scid-viewer`)

A high-performance **VS Code extension** designed to inspect, navigate, and stream binary **Sierra Chart Intraday Data (`.scid`)** files directly within Visual Studio Code. Built with **Effect v4** and bundled with **Bun**.

---

## Features

### 1. Interactive Data Grid Custom Editor
- **Custom Editor Integration**: Associates with `*.scid` files as the default editor.
- **Sticky Summary Metadata Card**: Displays header validation (`SCID`), file version, file size, total trade count, and first/last trade timestamps.
- **Aggressor-Coded Trade Tape**:
  - `#` (Record index)
  - `Time` (Microsecond precision)
  - `Price` (Formatted decimal price)
  - `Quantity` (Total trade size)
  - `Side` (`BUY` in emerald green, `SELL` in coral red, `NEUTRAL` in muted gray)
  - `Bid Vol` & `Ask Vol`
- **Tail-First Windowing**: Automatically opens to the latest trades in the file.
- **Responsive Pagination Toolbar**: First (`⏮`), Previous (`◀`), Next (`▶`), Last (`⏭`), Jump to Index, and customizable page sizes (100, 250, 500, 1000).

### 2. Real-Time Live Tail (Follow)
- **Live Tail Toggle**: An interactive toggle button (`Live Tail: ON 🟢` / `Live Tail: OFF`) in the toolbar.
- **Non-Blocking Background Polling**: Managed via Effect v4 fibers (`Fiber.Fiber` / `Fiber.interrupt`).
- **Auto-Scroll & Append**: Automatically appends newly written trades to the bottom of the grid and scrolls into view without reloading history. Automatically pauses if the user navigates backward into historical pages.

### 3. UTC vs. Local Time Switching
- **Time Mode Button**: Instant toggle between `Time: UTC` (ISO 8601 with microseconds) and `Time: Local`.
- **In-Place Re-rendering**: Re-renders timestamps dynamically in the active webview without re-querying the disk.

### 4. Reactive View Filtering
- **Min Volume Threshold**: Filters trades below a minimum volume (e.g., block trade identification).
- **Price Search & Comparisons**: Filters by price exact match or comparison operators (`>=`, `<=`, `>`, `<`).
- **Clear Filters**: Instant reset button returning to the full page slice.

### 5. Dedicated SCID Explorer Sidebar
- **Activity Bar View**: Contributes a dedicated `SCID Explorer` sidebar container (`$(database)`).
- **Ticker Hierarchy**: Automatically scans workspace `**/*.scid` files and groups them by Ticker symbol (e.g., `WINV26`, `PETR4`, `WDOU26`).
- **Session Badges**: Lists daily partition dates with formatted trade count badges (e.g., `124,530 trades`).
- **Workspace File Watcher**: Automatically refreshes when background recording engines (such as the Cedro SCID sink) write or rotate `.scid` files.
- **One-Click Open**: Clicking any tree node opens the file in the custom data grid editor.

---

## Architecture & Effect v4 Design

- **Service Pattern**:
  - [`ScidReader`](src/reader/scid-reader.ts) is implemented as a pure Effect v4 service extending `Context.Service<ScidReader, ScidReaderShape>()("ScidReader")`.
  - Layer composition via `ScidReaderLive`.
- **Zero-Copy $O(1)$ Slicing**:
  - SCID files consist of a fixed 56-byte `s_IntradayHeader` followed by fixed 40-byte `s_IntradayRecord` structures.
  - Slicing calculates exact byte offsets: `56 + offsetIndex * 40` and reads only the requested window from disk via `fs.FileHandle.read`.
- **Strongly Typed IPC Protocol**:
  - [`protocol.ts`](src/editor/protocol.ts) defines discriminated union message schemas (`INIT`, `REQUEST_PAGE`, `PAGE_DATA`, `APPEND_RECORDS`, `TOGGLE_LIVE_TAIL`, `ERROR`).
- **Structured Fiber Cleanup**:
  - Live tail fibers are scoped to the webview lifecycle and gracefully interrupted on toggle or panel disposal (`webviewPanel.onDidDispose`).

---

## Development & Testing

From the repository root:

```bash
# Install dependencies
bun install

# Run unit tests
bun test ./packages/scid-viewer/src

# TypeScript type check
bun run --cwd packages/scid-viewer typecheck

# Code formatting and linting (Biome)
bun run --cwd packages/scid-viewer format
bun run --cwd packages/scid-viewer lint

# Build extension bundle
bun run --cwd packages/scid-viewer build
```
