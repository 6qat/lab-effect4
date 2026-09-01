# TCP Networking & Financial Protocols

A foundational networking context providing resilient, runtime-agnostic TCP streams for financial market protocols and client applications.

## Language

**TcpStream**:
A bidirectional communication service providing an Effect Stream for incoming bytes and backpressured Effect operations for outgoing transmission.
_Avoid_: SocketWrapper, NetworkConnection, ClientSocket

**ConnectionConfig**:
The configuration schema specifying target host, port, TLS credentials, and reconnect retry policy for a TCP session.
_Avoid_: SocketOptions, ConnectParams

**Drain**:
The flow-control event signaled when a socket's kernel and userland write buffers have fully cleared, releasing backpressured senders.
_Avoid_: BufferFlush, WriteReady

**TcpStreamEngine**:
The underlying runtime implementation driving a `TcpStream` session, specifically Bun native sockets or Node.js `node:net`.
_Avoid_: SocketDriver, TransportProvider

