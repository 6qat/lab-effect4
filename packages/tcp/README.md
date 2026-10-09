# tcp

Private workspace for `TcpStream`, its Bun, Node.js, and Effect Platform engines, and the clients that exercise them. It includes line framing, the Cedro protocol client, the HTTP-over-TCP demonstration, and their tests.

Install dependencies once from the [repository root](../../README.md). Run the HTTP demonstration from that root:

```bash
bun packages/tcp/src/tcp-connection-http-example.ts https://example.com
bun packages/tcp/src/tcp-connection-http-example.ts --engine=nodejs https://example.com
bun packages/tcp/src/tcp-connection-http-example.ts --engine=platform https://example.com
```

The default engine is `bun`. All three commands run under Bun; the engine option chooses the socket implementation. Existing module exports and the Bun-default [tcp-connection.ts](src/tcp-connection.ts) facade remain available within this project.

## Cedro client

Set `CEDRO_TOKEN`, `CEDRO_USERNAME`, and `CEDRO_PASSWORD` in your environment,
then run from the repository root:

```bash
bun run cedro
```

The command connects to `datafeedcd3.cedrotech.com:81` by default. Optional
`CEDRO_HOST` and `CEDRO_PORT` overrides select a different endpoint, including a
local test server. From the TCP workspace, use `bun run cedro`; the direct
`bun packages/tcp/src/cedro-client.ts` entry point also remains available from the
repository root.

On connection, the client immediately sends the software key (`CEDRO_TOKEN`),
username, and password, in that order, each terminated by LF (`\n`). It then
awaits Cedro's documented authentication confirmation (`You are connected`)
within a 15-second timeout. Once confirmed, it automatically requests Times &
Trades subscriptions for `WINV26` and `PETR4` using `GQT <ticker> S\n`.

The client prints incoming server lines continuously with credential values
redacted as `[REDACTED]`. On clean server disconnects, read/write network failures,
or authentication confirmation timeouts, the client automatically releases the
previous connection resources and reconnects using capped exponential backoff
(1s, 2s, 4s, 8s, 16s, capped at 30s). Upon reconnection, it authenticates afresh
and restores every requested trade subscription. Successful authentication and
subscription restoration resets the backoff delay to 1s.

Explicit authentication rejection or invalid local configuration fails fast and
terminates the command with a clear error without retrying. Ctrl+C closes the active
scoped session and terminates without initiating further retries.

Cedro's [connection guide](https://ajuda.cedrotech.com/market-data/como-estabelecer-uma-conexao-com-o-market-data-cedro/)
identifies `You are connected` as authentication confirmation. To handle incoming
lines in code with automatic supervision and reconnection, use `runCedroSupervisor`.
For a single scoped authenticated session, use `runCedroSession`; the baseline
single-session `receiveCedroCommands` helper also remains available.

## SCID Market Data Persistence

The Cedro client automatically captures and persists real-time trade streams (`V:<ticker>:A:...`)
into binary Sierra Chart Intraday Data (`.scid`) files on disk.

### File Format & Specifications

- **Header (`s_IntradayHeader`)**: 56 bytes, Little-Endian, magic `SCID`, record size 40.
- **Records (`s_IntradayRecord`)**: 40 bytes, Little-Endian, 8-byte aligned.
  - `DateTime`: Microseconds since December 30, 1899, 00:00:00 UTC (`SCDateTimeMS`).
  - `Open`, `High`, `Low`, `Close`: 4-byte IEEE 754 floats.
  - `NumTrades`, `TotalVolume`, `BidVolume`, `AskVolume`: 4-byte unsigned integers.
  - Trade aggressor mapping: Buyer aggressor (`A`) maps to `AskVolume`; Seller aggressor (`V`) maps to `BidVolume`.
- **Monotonicity**: Automatic microsecond incrementing prevents collisions and preserves strict non-decreasing ordering even across service restarts.

### Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SCID_BASE_DIR` | `data/scid` | Root directory for persisted `.scid` files. |
| `SCID_PARTITION_STRATEGY` | `daily` | Partitioning strategy: `daily` or `monolithic`. |

- **`daily`**: Partitions into ticker directories with session dates:
  `<SCID_BASE_DIR>/<TICKER>/<TICKER>-<YYYY-MM-DD>.scid` (e.g. `data/scid/WINV26/WINV26-2026-10-05.scid`).
  Automatically closes the previous day's file and initializes a fresh 56-byte header on date rollover.
- **`monolithic`**: Appends continuously to a single file per ticker:
  `<SCID_BASE_DIR>/<TICKER>.scid` (e.g. `data/scid/PETR4.scid`).

### Architecture & Guarantees

- **Multi-Ticker Demuxing**: Routes incoming lines for multiple subscribed instruments (e.g. `WINV26`, `PETR4`) to their respective file targets while safely ignoring non-trade lines and deletion frames.
- **In-Memory Buffering**: Batches records in memory with count-based immediate flush (`batchSize`) and background interval flush (`flushInterval`).
- **Scoped Teardown**: Integrates with Effect's `Scope` via `Effect.addFinalizer`, guaranteeing all buffered records are flushed uninterruptibly on process exit, cancellation, or Ctrl+C.
- **Programmatic API**: Use `makeCedroScidSink` for scoped instantiation, `CedroScidSinkLive` for layer provision, or pass `scidSink` directly to `runCedroSupervisor`.


Run this project's checks from the repository root:

```bash
bun run --cwd packages/tcp typecheck
bun run --cwd packages/tcp test
bun run --cwd packages/tcp lint
bun run --cwd packages/tcp format:check
```

Use `bun run --cwd packages/tcp format` to apply formatting and Biome fixes. Tests remain beside their source files, including the shared conformance suite used by all three engines. They run with Bun and create local TCP/TLS servers.

See the root [domain glossary](../../GLOSSARY.md), [ADRs](../../docs/adr/), and [research](../../docs/research/) for terminology and design history. General Effect learning examples live in [lab](../lab/README.md); this workspace has no dependency on them.
