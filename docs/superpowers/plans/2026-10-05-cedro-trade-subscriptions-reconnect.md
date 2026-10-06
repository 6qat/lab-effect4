# Cedro Trade Subscriptions & Automatic Reconnection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `bun run cedro` to authenticate, wait for Cedro's confirmation (`You are connected`), subscribe to `WINV26` and `PETR4` trades, and automatically reconnect with capped backoff and subscription restoration on disconnects and network failures.

**Architecture:** Layered protocol client over Effect v4 `TcpStream`. The protocol module gains explicit trade-subscription formatting (`GQT <ticker> S\n`) and an authentication rejection matcher. The client module introduces a scoped session runner that gates subscriptions on confirmed authentication, coupled with a session supervisor that provides capped exponential backoff (1s, 2s, 4s, 8s, 16s, 30s), subscription restoration, credential redaction, and clean resource teardown on cancellation or fatal error.

**Tech Stack:** TypeScript, Effect v4 (`effect@4.0.0-rc.109`, `@effect/platform-bun@4.0.0-rc.111`), Bun (`bun:test`, `Bun.listen`, `Bun.spawn`), Biome.

**Spec:** GitHub Issue #9: `spec: receive WINV26 and PETR4 trades with automatic reconnection`

## Global Constraints

- Runtime: Bun (`bun@1.4.2`).
- Effect version: Effect v4 (`effect@4.0.0-rc.109`, `@effect/platform-bun@4.0.0-rc.111`).
- Workspace: `packages/tcp` (`packages/tcp/src/`).
- Default target: `datafeedcd3.cedrotech.com:81`.
- Authentication fields: `CEDRO_TOKEN` (magicToken), `CEDRO_USERNAME`, `CEDRO_PASSWORD` in LF-separated format.
- Validation: Non-empty credentials, no `\r` or `\n` line breaks; fail before transmission.
- Confirmation token: `You are connected`.
- Confirmation timeout: 15 seconds.
- Trade subscription syntax: `GQT <ticker> S\n`. Default tickers: `WINV26`, `PETR4`.
- Reconnect backoff schedule: 1s, 2s, 4s, 8s, 16s, capped at 30s; reset after auth & subscription restoration.
- Single-session receiver: Preserve `receiveCedroCommands` documented behavior.
- Git operations: Prioritize GitKraken MCP tools (`GitKraken:git_add`, `GitKraken:git_commit`, etc.).
- Format & lint: Biome (`bun run format`, `bun run lint`).
- Types: `bun run typecheck`.

## Review Focus

1. Packet batching with confirmation: Server emits `You are connected` and market data in a single TCP packet. The client must not discard or delay post-confirmation lines.
2. Pre-confirmation noise: Server sends banners, prompts, or `SYN` heartbeats before `You are connected`. The client must not misclassify them as auth success or auth failure.
3. Cancellation during backoff or connect: Interrupting the supervisor (e.g. via Ctrl+C / SIGINT) during sleep or connection establishment must immediately release all resources and terminate without spawning a new connection.
4. Fatal error classification: Empty credentials, line-break injections, and explicit server auth rejections must fail fast and never enter the reconnection loop.
5. Credential leakage in diagnostics: Diagnostic status messages, errors, and echoed server lines must redact all credentials from stdout and stderr.

---

### Task 1: Cedro Protocol Trade Subscriptions & Rejection Matcher

**Files:**
- Modify: `packages/tcp/src/cedro-protocol.ts`
- Test: `packages/tcp/src/cedro-protocol.test.ts`

**Interfaces:**
- Consumes: `TcpStream`, `Result`, `Effect`
- Produces:
  - `formatTradeSubCommand: (ticker: string) => Result.Result<string, CedroProtocolError>`
  - `isCedroAuthRejection: (line: string) => boolean`
  - `CedroClientShape.subscribeTrades: (tickers: ReadonlyArray<string>) => Effect.Effect<void, TcpStreamError | CedroProtocolError>`

- [ ] **Step 1: Write the failing tests for `subscribeTrades`, `formatTradeSubCommand`, and `isCedroAuthRejection`**

Add tests in `packages/tcp/src/cedro-protocol.test.ts`:
- Test that `formatTradeSubCommand("WINV26")` produces `Result.succeed("GQT WINV26 S\n")`.
- Test that `formatTradeSubCommand("")` or invalid tickers with line breaks fail with `CedroProtocolError`.
- Test that `client.subscribeTrades(["WINV26", "PETR4"])` sends `"GQT WINV26 S\n"` and `"GQT PETR4 S\n"` over `TcpStream`.
- Test that `isCedroAuthRejection` returns `true` for `"Authentication failed"`, `"Invalid password"`, `"Access denied"`, and `false` for `"You are connected"`, `"SYN"`, and banners.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tcp/src/cedro-protocol.test.ts`
Expected: FAIL due to missing `subscribeTrades` and `isCedroAuthRejection`.

- [ ] **Step 3: Implement trade subscription formatting, rejection matcher, and `subscribeTrades` in `packages/tcp/src/cedro-protocol.ts`**

- Add `formatTradeSubCommand`: validate non-empty and no `[\r\n]`, return `GQT ${ticker.trim()} S\n`.
- Add `isCedroAuthRejection`: detect explicit rejection strings (`authentication failed`, `invalid password`, `access denied`, etc.).
- Update `CedroClientShape` to include `subscribeTrades: (tickers: ReadonlyArray<string>) => Effect.Effect<void, TcpStreamError | CedroProtocolError>`.
- In `makeCedroClient`, implement `subscribeTrades`: validate `tickers.length > 0`, format each ticker, and send them via `tcp.sendText`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tcp/src/cedro-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Use `GitKraken:git_add` and `GitKraken:git_commit` with message:
`feat(tcp): add Cedro trade subscription commands and auth rejection matcher`

---

### Task 2: Single Authenticated Session with Confirmation Gate & Trade Restoration

**Files:**
- Modify: `packages/tcp/src/cedro-client.ts`
- Test: `packages/tcp/src/cedro-client.test.ts`

**Interfaces:**
- Consumes: `CedroClient`, `CedroConfig`, `isCedroAuthRejection` from `cedro-protocol.ts`
- Produces:
  - `CedroAuthTimeoutError` (Data.TaggedError)
  - `CedroAuthRejectionError` (Data.TaggedError)
  - `runCedroSession: (options: CedroSessionOptions) => Effect.Effect<void, CedroSessionError, CedroClient | Scope.Scope>`

- [ ] **Step 1: Write the failing tests for single session with auth confirmation gating**

Add tests in `packages/tcp/src/cedro-client.test.ts`:
- Test that trade subscriptions (`GQT WINV26 S\n`, `GQT PETR4 S\n`) are sent ONLY AFTER `You are connected` is received.
- Test that lines received in the same chunk as `You are connected` or before it (banners, `SYN`) are preserved and delivered to `onLine`.
- Test that missing `You are connected` within `authTimeout` fails with `CedroAuthTimeoutError`.
- Test that an explicit rejection line fails with `CedroAuthRejectionError`.
- Test that clean EOF before `You are connected` fails fast without hanging for 15s.
- Test that the existing `receiveCedroCommands` API still works without regression.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tcp/src/cedro-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runCedroSession` in `packages/tcp/src/cedro-client.ts`**

- Define `CedroAuthTimeoutError` and `CedroAuthRejectionError`.
- Implement `runCedroSession`:
  - Transmit credentials via `client.authenticate()`.
  - Use `Deferred.make<void, CedroAuthRejectionError>()` to track auth confirmation.
  - Fork scoped fiber consuming `client.lines`:
    - If confirmation not done:
      - If `line.trim() === "You are connected"`, complete Deferred successfully.
      - Else if `isAuthRejection(line)`, fail Deferred with `CedroAuthRejectionError`.
    - Deliver every line to `onLine(line)`.
    - If `client.lines` completes or fails before auth is confirmed, fail Deferred to prevent hanging.
  - Await Deferred with `Effect.timeout(authTimeout)` (catch `TimeoutException` and fail with `CedroAuthTimeoutError`).
  - Upon confirmation, execute `client.subscribeTrades(tickers)`.
  - Await line consumption fiber until stream completion.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tcp/src/cedro-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Use `GitKraken:git_add` and `GitKraken:git_commit` with message:
`feat(tcp): gate Cedro trade subscriptions behind confirmed authentication`

---

### Task 3: Supervised Reconnection Loop with Capped Exponential Backoff

**Files:**
- Modify: `packages/tcp/src/cedro-client.ts`
- Test: `packages/tcp/src/cedro-client.test.ts`

**Interfaces:**
- Consumes: `runCedroSession`, `TcpStreamLive`, `CedroClientLive`
- Produces:
  - `runCedroSupervisor: (options: CedroSupervisorOptions) => Effect.Effect<void, CedroFatalError, never>`

- [ ] **Step 1: Write the failing tests for supervisor reconnection and backoff**

Add tests in `packages/tcp/src/cedro-client.test.ts`:
- Test multi-connection reconnect: Scripted server closes connection after first trade; supervisor reconnects, authenticates afresh, restores both `WINV26` and `PETR4` subscriptions, and resumes receiving trades.
- Test backoff progression and reset: Server is down for 2 attempts; backoff progresses through configured delays (`1s, 2s...`); once authenticated and subscribed, backoff resets.
- Test auth timeout triggers reconnect: Stalled server connects but sends no confirmation; supervisor times out, releases connection scope, and reconnects.
- Test explicit auth rejection is fatal: Server sends rejection; supervisor stops immediately and does not retry.
- Test invalid credentials are fatal: Missing/empty/newline credentials stop immediately without retrying.
- Test cancellation: Interrupting during backoff sleep or during reception cancels promptly and closes all open sockets.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tcp/src/cedro-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runCedroSupervisor` in `packages/tcp/src/cedro-client.ts`**

- In `packages/tcp/src/cedro-client.ts`:
  - Maintain backoff attempt counter in a `Ref.Ref<number>`.
  - Delays: `[1000, 2000, 4000, 8000, 16000, 30000]` ms (configurable for tests).
  - Loop indefinitely:
    - Open fresh child scope: `Scope.make()`.
    - Provide fresh `TcpStreamLive({ host, port, retry: false })` and `CedroConfigLive` to `runCedroSession`.
    - On successful auth & subscription restoration: reset backoff attempt counter to 0.
    - If `runCedroSession` finishes (clean disconnect) or fails with retryable error (timeout, connection/read/write `TcpStreamError`):
      - Close the session scope cleanly.
      - Calculate backoff delay: `delays[Math.min(attempt, delays.length - 1)]`.
      - Increment attempt counter.
      - Log concise status (e.g. `[cedro] Reconnecting in ${delay / 1000}s...`).
      - Sleep for delay: `Effect.sleep(delay)`.
    - If fatal error (`CedroAuthRejectionError`, `CedroProtocolError` from config, or defect):
      - Close scope cleanly and fail the supervisor.
    - Ensure interruption (cancellation) releases the active scope and halts without further retries.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/tcp/src/cedro-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Use `GitKraken:git_add` and `GitKraken:git_commit` with message:
`feat(tcp): implement supervised reconnection with capped backoff for Cedro client`

---

### Task 4: CLI Integration, Credential Redaction, Diagnostics & Subprocess Verification

**Files:**
- Modify: `packages/tcp/src/cedro-client.ts`
- Modify: `packages/tcp/src/cedro-client.test.ts`
- Modify: `packages/tcp/README.md`

**Interfaces:**
- CLI entry point `main`:
  - `CEDRO_HOST` (default `datafeedcd3.cedrotech.com`)
  - `CEDRO_PORT` (default `81`)
  - `CEDRO_TOKEN`, `CEDRO_USERNAME`, `CEDRO_PASSWORD`
  - Subscriptions: `WINV26`, `PETR4`
  - Redacts credentials from all server lines and status diagnostics

- [ ] **Step 1: Write the failing subprocess CLI test in `packages/tcp/src/cedro-client.test.ts`**

Update the subprocess test:
- Spawns `bun run cedro`.
- Local server scripts 2 consecutive connections:
  - Connection 1: Client logs in with credentials -> Server confirms `You are connected` -> Client sends `GQT WINV26 S\n` and `GQT PETR4 S\n` -> Server sends trade lines and closes socket.
  - Connection 2: Client reconnects, logs in afresh -> Server confirms -> Client restores both subscriptions -> Server sends trade lines.
- Child process receives SIGINT via `child.kill("SIGINT")` after second session data.
- Assert stdout contains redacted lines, status notices, both instruments' data, and NO raw secret values.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/tcp/src/cedro-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `main` in `packages/tcp/src/cedro-client.ts` and documentation in `packages/tcp/README.md`**

- Wire `main` to run `runCedroSupervisor` with:
  - `tickers: ["WINV26", "PETR4"]`
  - Redaction wrapper for `onLine` and `onStatus` printing.
  - Signal handling for clean exit.
- Update `packages/tcp/README.md` to document the trade subscriptions (`WINV26` and `PETR4`), confirmed-auth sequencing, reconnection, and the updated `bun run cedro` behavior.

- [ ] **Step 4: Run all verification checks**

Run:
```bash
bun test packages/tcp/src/cedro*
bun run typecheck
bun run lint
bun run format:check
```
Expected: All tests pass, zero type errors, zero lint warnings/errors.

- [ ] **Step 5: Commit**

Use `GitKraken:git_add` and `GitKraken:git_commit` with message:
`feat(tcp): wire Cedro CLI to trade supervisor and update documentation`
