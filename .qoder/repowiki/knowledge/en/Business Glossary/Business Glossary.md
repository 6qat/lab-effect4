---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### TcpStream
- Definition：A bidirectional communication service that exposes an Effect Stream for incoming bytes and backpressured Effect operations for outgoing transmission; the central abstraction around which all TCP clients in this repo are built.

### ConnectionConfig
- Definition：The configuration schema specifying target host, port, TLS credentials, and reconnect retry policy for a TCP session.

### Drain
- Definition：The flow-control event signaled when a socket's kernel and userland write buffers have fully cleared, releasing backpressured senders waiting on it.

### TcpStreamEngine
- Definition：The underlying runtime implementation driving a TcpStream session — one of Bun native sockets, Node.js node:net/node:tls, or @effect/platform Socket.Socket.

### RawSocketHandle
- Definition：The minimal handle to an active raw socket returned by a TcpStreamEngine, providing raw byte writes with normalized backpressure signaling and teardown.

### Cedro
- Definition：A financial market-data protocol client implemented as a line-based protocol framing service over TcpStream, exposing authenticate and subscribe operations.

### DTc protocol
- Definition：Automotive diagnostics protocol documented in docs/research/dtc-protocol.md, identified as a future protocol target for the TCP streaming layer.
- Aliases：DTC
