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

Set `CEDRO_HOST`, `CEDRO_PORT`, `CEDRO_MAGIC_KEY`, `CEDRO_USER`, and
`CEDRO_PASSWORD` in your environment, then run from the repository root:

```bash
bun packages/tcp/src/cedro-client.ts
```

On connection, the client immediately sends the magic key, username, and password,
in that order, each terminated by LF (`\n`). It then prints incoming server lines
until disconnect; Ctrl+C closes the scoped connection. TCP packet boundaries do
not affect line framing. Login fields must be nonempty and contain no line breaks.

The server's authentication success/failure format is not yet specified. Incoming
responses are passed through as text; sending credentials does not establish that
the server accepted them. The client sends no automatic subscription commands and
does not reconnect after disconnect. To handle incoming lines in code, use
`receiveCedroCommands` with an Effect callback and provide `CedroClientLive`.

Run this project's checks from the repository root:

```bash
bun run --cwd packages/tcp typecheck
bun run --cwd packages/tcp test
bun run --cwd packages/tcp lint
bun run --cwd packages/tcp format:check
```

Use `bun run --cwd packages/tcp format` to apply formatting and Biome fixes. Tests remain beside their source files, including the shared conformance suite used by all three engines. They run with Bun and create local TCP/TLS servers.

See the root [domain glossary](../../CONTEXT.md), [ADRs](../../docs/adr/), and [research](../../docs/research/) for terminology and design history. General Effect learning examples live in [lab](../lab/README.md); this workspace has no dependency on them.
