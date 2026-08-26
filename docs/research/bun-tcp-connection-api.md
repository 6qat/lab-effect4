# Bun TCP Connection and Socket API Specification & Research

## Executive Summary

Bun provides native TCP and TLS networking primitives through `Bun.listen()` (for servers) and `Bun.connect()` (for clients). Unlike Node.js's `net.Socket`—which is built around `EventEmitter` and manages transparent internal write queues—Bun's socket layer is implemented natively in Zig/C++ (leveraging `sendto(2)`, `shutdown(2)`, and `SO_LINGER`) with a **static handler interface**.

Key architectural characteristics:
- **Zero-allocation callback dispatch**: Socket event handlers (`open`, `data`, `drain`, `close`, `error`, etc.) are declared once as an object in the creation options.
- **Explicit backpressure & unbuffered writes**: `socket.write()` does not implicitly buffer unwritten bytes in JavaScript memory. It returns the exact byte count accepted by the operating system / kernel socket buffer, requiring applications or stream abstractions to handle partial writes and await the `drain` callback.
- **Strongly typed context slot (`socket.data`)**: Direct per-connection state storage without `Map` lookups.
- **Explicit Resource Management**: Native support for JavaScript `using` declarations via `[Symbol.dispose]()` (aliased to `socket.end()` or `listener.stop()`).

---

## 1. `Bun.listen` and `Bun.connect` Specifications

### 1.1 `Bun.listen` (Server)

`Bun.listen<Data = undefined>(options)` binds a listening socket on a TCP port or Unix domain socket path.

```typescript
// Function Signatures in @types/bun (bun.d.ts)
function listen<Data = undefined>(options: TCPSocketListenOptions<Data>): TCPSocketListener<Data>;
function listen<Data = undefined>(options: UnixSocketOptions<Data>): UnixSocketListener<Data>;
```

#### Options (`TCPSocketListenOptions<Data>`)
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `hostname` | `string` | *(Required for TCP)* | The interface hostname or IP to bind (e.g., `"0.0.0.0"`, `"127.0.0.1"`, `"::"`). |
| `port` | `number` | *(Required for TCP)* | The TCP port number to listen on (`0` binds to an ephemeral OS-assigned port). |
| `socket` | `SocketHandler<Data, BinaryType>` | *(Required)* | Object containing event callbacks (`open`, `data`, `drain`, `close`, `error`, etc.). |
| `data` | `Data` | `undefined` | Initial per-listener contextual data accessible via `listener.data`. |
| `tls` | `TLSOptions \| boolean` | `undefined` | TLS credentials (`cert`, `key`, `ca`, etc.). If provided, establishes a TLS server. |
| `exclusive` | `boolean` | `false` | When `true`, binds exclusively to address:port, preventing other processes from binding. |
| `allowHalfOpen` | `boolean` | `false` | When `true`, prevents automatic socket closure when remote peer sends TCP FIN. |

#### Unix Domain Socket Options (`UnixSocketOptions<Data>`)
| Option | Type | Description |
| :--- | :--- | :--- |
| `unix` | `string` | Filesystem path for the Unix domain socket (e.g., `"/tmp/service.sock"`). |
| `socket` | `SocketHandler<Data, BinaryType>` | Event callbacks. |
| `tls` | `TLSOptions \| boolean` | Optional TLS layer over the Unix domain socket. |

#### Return Type: `TCPSocketListener<Data>` / `UnixSocketListener<Data>`
```typescript
interface TCPSocketListener<Data = unknown> extends SocketListener<Data> {
  readonly port: number;
  readonly hostname: string;
}

interface SocketListener<Data = undefined> extends Disposable {
  data: Data;
  stop(closeActiveConnections?: boolean): void;
  ref(): void;
  unref(): void;
  reload(options: Pick<SocketOptions<Data>, "socket">): void;
  [Symbol.dispose](): void;
}
```

---

### 1.2 `Bun.connect` (Client)

`Bun.connect<Data = undefined>(options)` establishes an outgoing connection to a TCP host, Unix socket, or existing file descriptor.

```typescript
// Function Signatures in @types/bun (bun.d.ts)
function connect<Data = undefined>(options: TCPSocketConnectOptions<Data>): Promise<Socket<Data>>;
function connect<Data = undefined>(options: UnixSocketOptions<Data>): Promise<Socket<Data>>;
```

#### Options (`TCPSocketConnectOptions<Data>`)
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `hostname` | `string` | *(Required for TCP)* | Remote host name or IP address. |
| `port` | `number` | *(Required for TCP)* | Remote TCP port. |
| `socket` | `SocketHandler<Data, BinaryType>` | *(Required)* | Lifecycle callbacks for the client connection. |
| `data` | `Data` | `undefined` | Initial state attached to `socket.data`. |
| `tls` | `TLSOptions \| boolean` | `false` | Set to `true` to enable TLS with system trust store, or supply `TLSOptions`. |
| `exclusive` | `boolean` | `false` | Exclusive socket binding. |
| `reusePort` | `boolean` | `false` | Enables `SO_REUSEPORT` socket option. |
| `ipv6Only` | `boolean` | `false` | Restrict socket to IPv6 only. |
| `allowHalfOpen` | `boolean` | `false` | Whether to allow half-open socket states. |

#### Return Value
Returns `Promise<Socket<Data>>` which resolves to the connected `Socket<Data>` instance once established.

---

## 2. Socket Lifecycle Handlers

The `SocketHandler<Data, DataBinaryType>` interface governs all events during the lifecycle of both client and server sockets.

```typescript
interface SocketHandler<Data = unknown, DataBinaryType extends BinaryType = "buffer"> {
  open?(socket: Socket<Data>): void | Promise<void>;
  data?(socket: Socket<Data>, data: BinaryTypeList[DataBinaryType]): void | Promise<void>;
  drain?(socket: Socket<Data>): void | Promise<void>;
  close?(socket: Socket<Data>, error?: Error): void | Promise<void>;
  error?(socket: Socket<Data>, error: Error): void | Promise<void>;
  end?(socket: Socket<Data>): void | Promise<void>;
  connectError?(socket: Socket<Data>, error: Error): void | Promise<void>;
  timeout?(socket: Socket<Data>): void | Promise<void>;
  handshake?(socket: Socket<Data>, success: boolean, authorizationError: Error | null): void;
  binaryType?: "buffer" | "uint8array" | "arraybuffer";
}
```

### Handler Details & Trigger Conditions

1. **`open(socket: Socket<Data>)`**
   - **When called**: Connection is established and ready to transmit/receive.
   - **TLS Sockets**: If no `handshake` handler is provided, `open` is delayed until the TLS handshake finishes successfully.

2. **`data(socket: Socket<Data>, data: Buffer | Uint8Array | ArrayBuffer)`**
   - **When called**: Raw binary data arrives from the remote endpoint.
   - The format of `data` is dictated by `binaryType` (default: `Buffer`).

3. **`drain(socket: Socket<Data>)`**
   - **When called**: Kernel write buffers were previously filled (a call to `socket.write()` returned fewer bytes than the payload) and have now drained sufficiently to accept new writes.

4. **`close(socket: Socket<Data>, error?: Error)`**
   - **When called**: Socket is completely closed and dismantled.
   - If closed due to a connection drop or reset, `error` contains the relevant system error.

5. **`error(socket: Socket<Data>, error: Error)`**
   - **When called**: An unrecoverable I/O error or TLS error occurs during the connection lifetime.

6. **`connectError(socket: Socket<Data>, error: Error)`** *(Client only)*
   - **When called**: `Bun.connect()` fails during initial connection setup (e.g. `ECONNREFUSED`, `ETIMEDOUT`).
   - **Promise Behavior**: If `connectError` is provided, the rejected promise returned by `Bun.connect()` is suppressed from reporting unhandled promise rejections.

7. **`end(socket: Socket<Data>)`**
   - **When called**: Remote peer initiates clean shutdown by transmitting a TCP `FIN` packet.

8. **`timeout(socket: Socket<Data>)`**
   - **When called**: An inactivity deadline established via `socket.timeout(seconds)` has expired. Bun automatically terminates/closes the connection after invoking this handler.

9. **`handshake(socket: Socket<Data>, success: boolean, authorizationError: Error | null)`** *(TLS only)*
   - **When called**: TLS handshake completes. Allows inspection of certificate verification failures even if `rejectUnauthorized: false` was set.

---

## 3. Socket Write Buffer Management, Partial Writes & Backpressure

### 3.1 Non-Blocking `socket.write()`

Bun's `socket.write()` is unbuffered, non-blocking, and maps directly to the underlying `sendto(2)` system call:

```typescript
write(data: string | BufferSource, byteOffset?: number, byteLength?: number): number;
```

#### Behavior & Return Values
- **Full Write (`returns === data.byteLength`)**: All bytes were accepted by the operating system kernel buffer.
- **Partial Write (`0 <= returns < data.byteLength`)**: The kernel buffer is full. **Backpressure is active**. The remaining bytes (`data.subarray(bytesWritten)`) were **not** sent and **not** queued by Bun. The caller is responsible for buffering the remaining bytes and pausing further writes.
- **Error / Closed (`returns === -1`)**: The socket has closed, is shutting down, or encountered an unrecoverable write error.

### 3.2 Flushing & Backpressure Handling Pattern

When implementing a custom producer or streaming pipeline, unwritten chunks must be buffered and dispatched when `drain(socket)` fires:

```typescript
interface ConnectionState {
  pendingQueue: Uint8Array[];
  isDraining: boolean;
}

const server = Bun.listen<ConnectionState>({
  hostname: "127.0.0.1",
  port: 9000,
  socket: {
    open(socket) {
      socket.data = { pendingQueue: [], isDraining: false };
    },
    data(socket, chunk) {
      sendSafe(socket, chunk);
    },
    drain(socket) {
      flushQueue(socket);
    },
    close(socket) {
      socket.data.pendingQueue.length = 0;
    },
  },
});

function sendSafe(socket: Bun.Socket<ConnectionState>, data: Uint8Array) {
  // If items are already queued, maintain FIFO order
  if (socket.data.pendingQueue.length > 0) {
    socket.data.pendingQueue.push(data);
    return;
  }

  const written = socket.write(data);
  if (written < data.byteLength) {
    // Slice unwritten tail and enqueue
    const remaining = data.subarray(Math.max(0, written));
    socket.data.pendingQueue.push(remaining);
  }
}

function flushQueue(socket: Bun.Socket<ConnectionState>) {
  while (socket.data.pendingQueue.length > 0) {
    const head = socket.data.pendingQueue[0];
    const written = socket.write(head);

    if (written < head.byteLength) {
      if (written > 0) {
        socket.data.pendingQueue[0] = head.subarray(written);
      }
      return; // Still backpressured, wait for next drain event
    }

    socket.data.pendingQueue.shift();
  }
}
```

### 3.3 Explicit Socket Flushing (`socket.flush()`)

```typescript
socket.flush(): void;
```
`socket.flush()` attempts to immediately push any internal pending data to the wire. This is useful when batching writes outside standard event loop turns.

---

## 4. TLS Configuration & Runtime Security Options

Both `Bun.listen` and `Bun.connect` support SSL/TLS configuration using `TLSOptions`:

```typescript
interface TLSOptions {
  ca?: string | BufferSource | BunFile | Array<string | BufferSource | BunFile>;
  cert?: string | BufferSource | BunFile | Array<string | BufferSource | BunFile>;
  key?: string | BufferSource | BunFile | Array<string | BufferSource | BunFile>;
  passphrase?: string;
  dhParamsFile?: string;
  serverName?: string;
  lowMemoryMode?: boolean;
  rejectUnauthorized?: boolean;
  requestCert?: boolean;
  secureOptions?: number;
  ALPNProtocols?: string | BufferSource;
  ciphers?: string;
  checkServerIdentity?: (hostname: string, cert: any) => Error | undefined;
  clientRenegotiationLimit?: number;
  clientRenegotiationWindow?: number;
}
```

### 4.1 Key Security Fields

- **`ca`**: Custom CA certificate chain. Supplying this **replaces** Mozilla's default CA bundle entirely.
- **`cert` / `key`**: Server or client certificates and corresponding private keys. Supports PEM strings, `BufferSource`, or lazy `Bun.file("./cert.pem")` instances.
- **`rejectUnauthorized`**: If `false`, ignores certificate verification errors (useful for local self-signed testing; defaults to `true` or respects `NODE_TLS_REJECT_UNAUTHORIZED`).
- **`requestCert`**: Server-side flag requesting a client certificate (for mutual TLS / mTLS).
- **`ALPNProtocols`**: Supported ALPN protocols negotiated during TLS handshake (e.g. `"h2"`, `"http/1.1"`).
- **`lowMemoryMode`**: Sets `OPENSSL_RELEASE_BUFFERS = 1` in OpenSSL/BoringSSL, reducing memory retention per idle socket at a slight throughput cost.

### 4.2 Dynamic TLS Upgrade (`socket.upgradeTLS`)

Bun supports upgrading an existing plaintext TCP socket to TLS in-place (e.g. for `STARTTLS` in SMTP/IMAP or database connection negotiation):

```typescript
const [rawSocket, tlsSocket] = socket.upgradeTLS({
  tls: {
    rejectUnauthorized: true,
    serverName: "smtp.example.com",
  },
  socket: {
    open(tlsSock) {
      console.log("TLS handshake completed");
    },
    data(tlsSock, data) {
      console.log("Encrypted data received:", data);
    },
  },
});
```

### 4.3 TLS Inspection Properties & Methods

A `Socket` with TLS active exposes the following runtime methods:
- `socket.authorized: boolean` — Whether peer certificate was validated against trusted CAs.
- `socket.alpnProtocol: string | false | null` — Negotiated ALPN protocol.
- `socket.getPeerCertificate()` / `socket.getPeerX509Certificate()` — Retrieves the peer's X.509 certificate.
- `socket.getCipher()` — Negotiated cipher suite details (`{ name, standardName, version }`).
- `socket.getTLSVersion()` — Negotiated protocol version (`"TLSv1.2"`, `"TLSv1.3"`).
- `socket.exportKeyingMaterial(length, label, context)` — RFC 5705 keying material export for application-layer security.

---

## 5. Socket State Transitions, Clean Shutdown vs Forced Termination

### 5.1 ReadyState Lifecycle

The connection state is represented on `socket.readyState`:

```typescript
readonly readyState: -2 | -1 | 0 | 1 | 2;
```
- **`1` (Established / Open)**: Active connection, reads and writes enabled.
- **`0` (Closed)**: Socket is completely closed.
- **`-1` (Detached)**: Socket file descriptor has been detached/handed off.
- **`-2` (Shutdown)**: Write half closed, socket in half-closed state or shutting down.

### 5.2 Shutdown Methods Comparison

| Method | Syscall / Mechanism | TCP State | Behavior |
| :--- | :--- | :--- | :--- |
| `socket.end(data?)` | `write()` + `shutdown(fd, SHUT_WR)` | `FIN_WAIT_1` / `CLOSE_WAIT` | **Graceful write close**: Sends optional final data chunk, then sends a TCP `FIN` packet. The socket can still read incoming data until remote closes. |
| `socket.shutdown(halfClose?)` | `shutdown(fd, SHUT_WR \| SHUT_RDWR)` | Configurable | If `halfClose: true`, shuts down write-half only. If `halfClose: false`, shuts down both read and write. |
| `socket.close()` | Wrapper over `end()` + `shutdown()` | Closing | Standard application-level close wrapper. |
| `socket.terminate()` | `SO_LINGER` (`l_onoff=1, l_linger=0`) + `close(2)` | `RST` (abrupt abort) | **Immediate abortive termination**: Discards any pending write/read buffers and aborts connection immediately. |

### 5.3 Flow Control & Process Lifetime

- **`socket.pause()` & `socket.resume()`**: Stop and resume reading data from the OS socket. Halts invocation of the `data()` callback to apply read backpressure.
- **`socket.ref()` & `socket.unref()`**: Control whether the socket keeps the Bun event loop active.
- **`socket.timeout(seconds)`**: Configures socket inactivity timer.
- **`socket.setNoDelay(noDelay = true)`**: Sets `TCP_NODELAY` (disables Nagle's algorithm) for low latency.
- **`socket.setKeepAlive(enable = false, initialDelay = 0)`**: Configures TCP keep-alive probes (`SO_KEEPALIVE`, `TCP_KEEPIDLE=initialDelay/1000`, `TCP_KEEPCNT=10`, `TCP_KEEPINTVL=1`).
- **`[Symbol.dispose]()`**: Allows `using socket = await Bun.connect(...)` scoped management, automatically invoking `socket.end()`.

---

## 6. Binary Types & Zero-Copy Optimization

Bun allows configuring the binary format of incoming chunks via `SocketHandler.binaryType`:

```typescript
type BinaryType = "buffer" | "uint8array" | "arraybuffer";
```

### Comparison Matrix

| Format | Representation in `data(s, chunk)` | Performance / Zero-Copy Tradeoff |
| :--- | :--- | :--- |
| `"buffer"` *(default)* | Node.js `Buffer` instance | Convenient for Node.js compatibility (`.toString('utf-8')`, `.readUInt32BE()`), slight overhead wrapping raw memory. |
| `"uint8array"` | `Uint8Array<ArrayBuffer>` | Standard Web API typed array. Ideal for modern zero-overhead byte processing. |
| `"arraybuffer"` | `ArrayBuffer` | Raw underlying buffer slice. Avoids extra TypedArray view instantiations when transferring to Web Workers. |

### Zero-Copy Writes
For writing data, `socket.write()` directly accepts:
```typescript
string | NodeJS.TypedArray | DataView | ArrayBufferLike
```
When passing a `Uint8Array` or `ArrayBuffer`, Bun passes pointers directly to the kernel `sendto(2)` without intermediate JS string conversions or internal buffer duplication.

---

## 7. Reactive Streams / Async Integration: Gotchas & Best Practices

When bridging Bun's TCP sockets into reactive stream architectures (e.g. Effect Streams, Web `ReadableStream`/`WritableStream`, or custom async iterators), several subtleties must be managed:

### 1. `async data()` Handlers Do Not Automatically Backpressure the Socket
If `data(socket, chunk)` is an `async` function, returning a `Promise` **does not** pause socket reads while the promise is pending.
* **Gotcha**: If incoming network throughput exceeds downstream processing speed, multiple `data()` promises will execute concurrently, creating unbound memory consumption.
* **Fix**: Explicitly call `socket.pause()` before async work and `socket.resume()` when ready for the next chunk.

### 2. Manual Backpressure Management on Writes
Unlike Node.js `stream.Writable`, calling `socket.write(chunk)` does not queue unwritten bytes.
* **Gotcha**: Ignoring the return value of `socket.write()` will cause silent data loss if the socket buffer fills up.
* **Fix**: Check `written < chunk.byteLength`. If a partial write occurs, enqueue remainder and pause producer until the `drain(socket)` handler executes.

### 3. Asymmetric Error Handling in `Bun.connect`
* When `connectError` is provided in `socket`, the promise returned by `Bun.connect()` rejects, but Bun automatically marks the rejection as handled to avoid unhandled rejection crashes.
* In async/await contexts (`const sock = await Bun.connect(...)`), you should wrap the call in `try / catch` or attach `.catch()`.

### 4. Half-Closed Connections (`allowHalfOpen`)
* By default (`allowHalfOpen: false`), when a client sends a FIN packet, Bun automatically closes the entire connection.
* If implementing protocols requiring half-duplex communication (e.g. HTTP pipelining with shutdown, upload streams), set `allowHalfOpen: true` and invoke `socket.end()` explicitly upon receiving `end(socket)`.

### 5. `socket.data` Lifetime and Scoping
* Sockets share lifetime with their handler object. Store stream controllers, buffer accumulators, and session identifiers on `socket.data`. Clean up references in `close(socket)` to avoid memory leaks.

---

## 8. Summary Table: API Quick Reference

```typescript
// --- TCP Server ---
const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 8080,
  socket: {
    binaryType: "uint8array",
    open(socket) {},
    data(socket, data) {},
    drain(socket) {},
    close(socket, error) {},
    error(socket, error) {},
    end(socket) {},
    timeout(socket) {},
  },
});
server.stop(true);

// --- TCP Client ---
const client = await Bun.connect({
  hostname: "127.0.0.1",
  port: 8080,
  tls: false,
  socket: {
    open(socket) {},
    data(socket, data) {},
    connectError(socket, err) {},
    close(socket) {},
  },
});
client.write("Hello\n");
client.end();
```

---

## Sources & Type Verification

- Official Bun Documentation: [https://bun.sh/docs/api/tcp](https://bun.sh/docs/api/tcp)
- Bun Global API Reference: [https://bun.sh/docs/api/bun](https://bun.sh/docs/api/bun)
- TypeScript Definitions: `@types/bun` / `bun-types` (`bun.d.ts` lines 6080–6900)
- Bun Source Code Repository: [https://github.com/oven-sh/bun](https://github.com/oven-sh/bun)
