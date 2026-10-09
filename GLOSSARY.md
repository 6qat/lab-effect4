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
The underlying runtime implementation driving a `TcpStream` session: Bun native sockets, Node.js `node:net`/`node:tls`, or `@effect/platform` `Socket.Socket`.
_Avoid_: SocketDriver, TransportProvider

**RawSocketHandle**:
The minimal handle to an active raw socket returned by a `TcpStreamEngine`, providing raw byte writes with normalized backpressure signaling and teardown.
_Avoid_: NativeSocket, SocketInstance

**CedroSession**:
An authenticated connection through which a client receives messages from Cedro's market-data service until the session ends.
_Avoid_: LoginAttempt

**CedroSoftwareKey**:
The software credential presented to Cedro alongside an account's username and password.
_Avoid_: AccountPassword, BearerToken

**CedroSubscription**:
A request for ongoing updates from a specific Cedro market-data feed for a particular ticker.
_Avoid_: TcpConnection, Login

**CedroTrade**:
A reported execution for a ticker, delivered through Cedro's Times & Trades feed.
_Avoid_: Quote, OrderBookEntry
