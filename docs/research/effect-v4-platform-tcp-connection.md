# Effect v4 Platform TCP Connection and Socket API Specification & Research

## Executive Summary

In Effect v4 (`effect: 4.0.0-rc.109+`, `@effect/platform-bun: 4.0.0-rc.111+`, `@effect/platform-node: 4.0.0-rc.111+`), networking and socket abstractions are designed around a unified bidirectional contract defined in `effect/unstable/socket/Socket` and `effect/unstable/socket/SocketServer`. 

Rather than exposing distinct, platform-fragmented networking primitives, Effect v4 standardizes on:
1. **A Push-Based Core Socket Model (`Socket.Socket`)**: Centered on an execution loop (`run`, `runString`, `runRaw`) coupled with a scoped, backpressured `writer` effect.
2. **First-Class Channel Integration (`Socket.toChannel`)**: Seamless bridging between the push-based event loop and Effect's pull-based `Channel` / `Stream` abstractions.
3. **Platform-Agnostic Socket Server (`SocketServer.SocketServer`)**: A high-level service managing listening servers across TCP, Unix Domain Sockets, and WebSockets.
4. **Shared Platform Bindings (`@effect/platform-node-shared`)**: Both `@effect/platform-bun` and `@effect/platform-node` delegate TCP socket operations (`BunSocket`, `BunSocketServer`, `NodeSocket`, `NodeSocketServer`) to `@effect/platform-node-shared`, which interacts directly with `node:net` (natively supported in both Node.js and Bun runtime engines).

This research document details the specifications, runtime behavior, error handling models, lifecycle management, and architectural trade-offs between the official `@effect/platform` socket suite and custom native engine wrappers (such as `Bun.connect` / `Bun.listen` implementations).

---

## 1. Core Socket Abstraction (`effect/unstable/socket/Socket`)

### 1.1 The `Socket` Interface & Service Tag

The core interface is defined in `effect/unstable/socket/Socket.ts`. It models a bidirectional communication channel capable of handling binary (`Uint8Array`), string (`string`), and raw frames, alongside scoped write operations.

```typescript
// Primary source: effect/src/unstable/socket/Socket.ts

export const TypeId = "~effect/socket/Socket"
export type TypeId = typeof TypeId

export const Socket: Context.Service<Socket, Socket> = 
  Context.Service<Socket>("effect/socket/Socket")

export interface Socket {
  readonly [TypeId]: typeof TypeId

  /** Runs a binary chunk handler over incoming socket frames. */
  readonly run: <_, E = never, R = never>(
    handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }
  ) => Effect.Effect<void, SocketError | E, R>

  /** Runs a UTF-8 decoded string handler over incoming socket frames. */
  readonly runString: <_, E = never, R = never>(
    handler: (_: string) => Effect.Effect<_, E, R> | void,
    options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }
  ) => Effect.Effect<void, SocketError | E, R>

  /** Runs a raw handler accepting string or Uint8Array frames. */
  readonly runRaw: <_, E = never, R = never>(
    handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }
  ) => Effect.Effect<void, SocketError | E, R>

  /** Scoped writer effect returning a write function for outgoing chunks. */
  readonly writer: Effect.Effect<
    (chunk: Uint8Array | string | CloseEvent) => Effect.Effect<void, SocketError>,
    never,
    Scope.Scope
  >
}
```

#### Low-Level Constructor: `Socket.make`
```typescript
export const make = (options: {
  readonly runRaw: <_, E, R>(
    handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined }
  ) => Effect.Effect<void, SocketError | E, R>
  readonly run?: <_, E, R>(
    handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined }
  ) => Effect.Effect<void, SocketError | E, R>
  readonly runString?: <_, E, R>(
    handler: (_: string) => Effect.Effect<_, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined }
  ) => Effect.Effect<void, SocketError | E, R>
  readonly writer: Effect.Effect<
    (chunk: Uint8Array | string | CloseEvent) => Effect.Effect<void, SocketError>,
    never,
    Scope.Scope
  >
}): Socket
```
When `run` or `runString` are omitted from `Socket.make`, automatic encoders (`TextEncoder`) and decoders (`TextDecoder`) are synthesized on top of `runRaw`.

---

### 1.2 Execution Model & Handler Lifecycles

Unlike traditional Node.js event emitters where events fire uncoordinatedly:
1. **Push-Execution**: Calling `socket.run(handler, { onOpen })` starts the read loop for the socket. The handler function is invoked whenever a chunk arrives.
2. **Fiber Supervision & Concurrency**: Handlers can return `void` or `Effect.Effect<_, E, R>`. When returning an `Effect`, the socket implementation runs the effect inside a supervised `FiberSet` (or per-connection runtime).
3. **Execution Termination**: The `socket.run` effect remains active until:
   - The connection closes gracefully (completing with `void`).
   - A read, write, or protocol error occurs (failing with `SocketError | E`).
   - The enclosing fiber or scope is interrupted.

---

### 1.3 Scoped Writer & Flow Control (`socket.writer`)

The `socket.writer` property is an `Effect.Effect<WriterFn, never, Scope.Scope>`. 
Acquiring the writer:
1. Binds to a `Scope.Scope`.
2. Returns a write function: `(chunk: Uint8Array | string | CloseEvent) => Effect.Effect<void, SocketError>`.
3. Ensures write synchronization using internal primitives (such as `Latch.whenOpen` and finalizers that flush or close the writable side when the write scope is released).

```typescript
// CloseEvent Model (effect/src/unstable/socket/Socket.ts)
export class CloseEvent {
  readonly code: number
  readonly reason?: string | undefined
  constructor(code = 1000, reason?: string) { ... }
}
```

Writing a `CloseEvent` instructs the socket transport to initiate a graceful or forced teardown (e.g., calling `conn.destroy()` or `ws.close(code, reason)`).

---

### 1.4 Channel Integration (`Socket.toChannel`)

Effect v4 provides first-class bidirectional streaming via `Channel`. `Socket.toChannel` converts any `Socket` into a `Channel.Channel` where:
- **Upstream Input**: Batches of `Uint8Array | string | CloseEvent` written to the socket.
- **Downstream Output**: Batches of incoming `Uint8Array` chunks read from the socket.

```typescript
// Primary source: effect/src/unstable/socket/Socket.ts

export const toChannel = <IE>(
  self: Socket
): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE
>

export const toChannelString: {
  (encoding?: string): <IE>(self: Socket) => Channel.Channel<
    NonEmptyReadonlyArray<string>,
    SocketError | IE,
    void,
    NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
    IE
  >
  <IE>(self: Socket, encoding?: string): Channel.Channel<
    NonEmptyReadonlyArray<string>,
    SocketError | IE,
    void,
    NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
    IE
  >
}

export const makeChannel = <IE = never>(): Channel.Channel<
  NonEmptyReadonlyArray<Uint8Array>,
  SocketError | IE,
  void,
  NonEmptyReadonlyArray<Uint8Array | string | CloseEvent>,
  IE,
  unknown,
  Socket
>
```

#### Internal Channel Pipeline Architecture:
Inside `toChannelMap`:
1. Creates an unbounded queue (`Queue.make<A, SocketError | IE | Cause.Done>()`).
2. Forks a write scope (`Scope.fork(scope)`) and acquires `self.writer`.
3. Upstream pulls from the feeding pipeline and sequentially issues `write(chunk)`.
4. Runs `self.runRaw(...)` in a background fiber, pushing incoming decoded frames directly into the queue.
5. Returns `Queue.takeAll(queue)` as downstream channel pulls.

---

### 1.5 Socket Error Hierarchy

All socket failures are unified under `SocketError` which uses Effect's Schema-backed error system:

```typescript
// Primary source: effect/src/unstable/socket/Socket.ts

export class SocketReadError extends Schema.Error<SocketReadError>("effect/socket/Socket/SocketReadError")({
  _tag: Schema.tag("SocketReadError"),
  cause: Schema.Defect()
}) {}

export class SocketWriteError extends Schema.Error<SocketWriteError>("effect/socket/Socket/SocketWriteError")({
  _tag: Schema.tag("SocketWriteError"),
  cause: Schema.Defect()
}) {}

export class SocketOpenError extends Schema.Error<SocketOpenError>("effect/socket/Socket/SocketOpenError")({
  _tag: Schema.tag("SocketOpenError"),
  kind: Schema.Literals(["Unknown", "Timeout"]),
  cause: Schema.Defect()
}) {}

export class SocketCloseError extends Schema.Error<SocketCloseError>("effect/socket/Socket/SocketCloseError")({
  _tag: Schema.tag("SocketCloseError"),
  code: Schema.Int,
  closeReason: Schema.optional(Schema.String)
}) {}

export type SocketErrorReason =
  | SocketReadError
  | SocketWriteError
  | SocketOpenError
  | SocketCloseError

export class SocketError extends Schema.TaggedError<SocketError>(SocketErrorTypeId)("SocketError", {
  _tag: Schema.tag("SocketError"),
  reason: SocketErrorReason
}) {}
```

#### Filtering Clean Closes
`SocketCloseError.filterClean(isClean: (code: number) => boolean)` allows discriminating between regular connection termination (e.g. TCP FIN or WebSocket code 1000) and abnormal disconnections.

---

### 1.6 Additional Core Constructors

- `Socket.fromWebSocket`: Wraps a browser/runtime `WebSocket` object into a `Socket`.
- `Socket.makeWebSocket`: Creates a `Socket` effect requiring `WebSocketConstructor`.
- `Socket.layerWebSocket`: Layer providing `Socket` for a specific WebSocket URL.
- `Socket.fromTransformStream`: Builds a `Socket` from standard Web Streams `{ readable: ReadableStream, writable: WritableStream }`.
- `Socket.SendQueueCapacity`: Context reference configuring default queue bounds (defaults to `16`).

---

## 2. Platform TCP Client (`BunSocket` / `NodeSocket`)

### 2.1 Package Architecture & Platform Interop

In Effect v4, the platform architecture delegates TCP socket operations across Node and Bun via `@effect/platform-node-shared`:

```
@effect/platform-bun/BunSocket  ─────┐
                                     ├───► @effect/platform-node-shared/NodeSocket ───► node:net (TCP)
@effect/platform-node/NodeSocket ────┘
```

Both `@effect/platform-bun/BunSocket` and `@effect/platform-node/NodeSocket`:
1. Re-export all TCP client and stream constructors from `@effect/platform-node-shared/NodeSocket`.
2. Differentiate only on **WebSocket constructors**:
   - `BunSocket`: Uses `globalThis.WebSocket` directly.
   - `NodeSocket`: Checks `globalThis.WebSocket`, falling back to the `ws` package.

---

### 2.2 TCP Client Creation Functions

Primary module: `@effect/platform-node-shared/NodeSocket.ts` (re-exported by `@effect/platform-bun/BunSocket` and `@effect/platform-node/NodeSocket`).

```typescript
// Primary source: @effect/platform-node-shared/src/NodeSocket.ts

/** Opens a Node/Bun TCP connection as an Effect socket. */
export const makeNet = (
  options: Net.NetConnectOpts & {
    readonly openTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Socket.Socket>

/** Layer providing Socket.Socket by opening a TCP connection. */
export const layerNet: (
  options: Net.NetConnectOpts
) => Layer.Layer<Socket.Socket, Socket.SocketError>

/** Creates a bidirectional Channel over a TCP connection. */
export const makeNetChannel = <IE = never>(
  options: Net.NetConnectOpts
): Channel.Channel<
  Array.NonEmptyReadonlyArray<Uint8Array>,
  Socket.SocketError | IE,
  void,
  Array.NonEmptyReadonlyArray<Uint8Array | string | Socket.CloseEvent>,
  IE
>

/** Adapts an existing Node Duplex stream into a Socket.Socket. */
export const fromDuplex = <RO>(
  open: Effect.Effect<Duplex, Socket.SocketError, RO>,
  options?: {
    readonly openTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Socket.Socket, never, Exclude<RO, Scope.Scope>>
```

---

### 2.3 Underlying Lifecycle, Fiber Supervision & `fromDuplex`

When `makeNet(options)` is evaluated:
1. **Connection Initiation**: Invokes `Net.createConnection(options)`.
2. **Scope Acquisition & Finalizers**:
   - Registers a finalizer on the enclosing scope:
     ```typescript
     Scope.addFinalizer(scope, Effect.sync(() => {
       if (!conn) return
       if (conn.closed === false) {
         if ("destroySoon" in conn) {
           conn.destroySoon()
         } else {
           conn.destroy()
         }
       }
     }))
     ```
3. **Execution Inside `fromDuplex`**:
   - **`Latch` Synchronization**: A `Latch` ensures that `writer` cannot issue write calls until `conn` has completed its handshake and entered the `run` loop.
   - **`FiberSet` Dispatch**: Inside `run(handler)`:
     - Listens to `"data"` events on the duplex stream and triggers `handler(chunk)`. If `handler` returns an `Effect`, it is executed through `FiberSet.runtime(fiberSet)<R>()`.
     - Listens to `"end"`: completes `fiberSet.deferred` with `Exit.void`.
     - Listens to `"error"`: fails `fiberSet.deferred` with `SocketError(SocketReadError)`.
     - Listens to `"close"`: completes `fiberSet.deferred` with `SocketError(SocketCloseError)`.
   - **Context Service Injection (`NetSocket`)**:
     Provides the active `net.Socket` instance into the handler context via the `NetSocket` service tag:
     ```typescript
     export class NetSocket extends Context.Service<NetSocket, Net.Socket>()(
       "@effect/platform-node/NodeSocket/NetSocket"
     ) {}
     ```
   - **Writer Implementation**:
     The `writer` uses `conn.write(chunk, callback)` wrapped via `Effect.callback`. If a `CloseEvent` is supplied, `conn.destroy(...)` is called. Releasing the write scope calls `conn.end()`.

---

## 3. Platform TCP Server (`BunSocketServer` / `NodeSocketServer`)

### 3.1 The `SocketServer` Service Model

Defined in `effect/unstable/socket/SocketServer.ts`:

```typescript
// Primary source: effect/src/unstable/socket/SocketServer.ts

export class SocketServer extends Context.Service<SocketServer, {
  readonly address: Address
  readonly run: <R, E, _>(
    handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>
  ) => Effect.Effect<never, SocketServerError, R>
}>()("@effect/platform/SocketServer")

export type Address = UnixAddress | TcpAddress

export interface TcpAddress {
  readonly _tag: "TcpAddress"
  readonly hostname: string
  readonly port: number
}

export interface UnixAddress {
  readonly _tag: "UnixAddress"
  readonly path: string
}
```

#### Server Error Model:
```typescript
export class SocketServerOpenError extends Data.TaggedError("SocketServerOpenError")<{
  readonly cause: unknown
}> {}

export class SocketServerUnknownError extends Data.TaggedError("SocketServerUnknownError")<{
  readonly cause: unknown
}> {}

export type SocketServerErrorReason = SocketServerOpenError | SocketServerUnknownError

export class SocketServerError extends Data.TaggedError("SocketServerError")<{
  readonly reason: SocketServerErrorReason
}> {}
```

---

### 3.2 Server Construction & Lifecycle (`NodeSocketServer.make` / `BunSocketServer.layer`)

Primary module: `@effect/platform-node-shared/NodeSocketServer.ts` (re-exported by `@effect/platform-bun/BunSocketServer` and `@effect/platform-node/NodeSocketServer`).

```typescript
// Primary source: @effect/platform-node-shared/src/NodeSocketServer.ts

/** Creates a scoped TCP SocketServer from Node/Bun net.Server */
export const make: (
  options: Net.ServerOpts & Net.ListenOptions
) => Effect.Effect<SocketServer.SocketServer["Service"], SocketServer.SocketServerError, Scope.Scope>

/** Layer providing SocketServer for TCP listen options */
export const layer: (
  options: Net.ServerOpts & Net.ListenOptions
) => Layer.Layer<SocketServer.SocketServer, SocketServer.SocketServerError>
```

#### Internal Server Execution & Connection Queueing:
1. **Pre-Run Connection Buffer**:
   Before `socketServer.run(handler)` is invoked, incoming TCP connections are placed into a `pending = new Map<Net.Socket, () => void>()` queue so connections arriving during server startup are not lost.
2. **Scope-Bound Connection Lifecycle**:
   - `run` creates a connection scope (`Scope.make()`) and tracks connection fibers with `Fiber.runIn(scope)`.
   - For each accepted `net.Socket`:
     - Creates a scoped `Socket.Socket` via `NodeSocket.fromDuplex`.
     - Injects `NodeSocket.NetSocket` (the raw `net.Socket`) into the handler's context.
     - Runs `handler(socket)` in a dedicated background fiber.
     - Automatically destroys/closes the connection when its connection scope finalizes.
3. **Graceful Shutdown**:
   When the server's outer scope closes:
   - Destroys all active and pending sockets in the `pending` map.
   - Closes the `net.Server` via `server.close()`.

---

## 4. In-Depth Comparison: `@effect/platform` vs Custom Bun TCP

A common pattern in Bun applications is writing a custom wrapper around `Bun.connect` and `Bun.listen` (such as the repository's `src/tcp-connection.ts`). Below is an architectural and operational comparison.

### 4.1 Feature & Architecture Matrix

| Dimension | `@effect/platform-bun` (`BunSocket` / `NodeSocket`) | Custom `Bun.connect` Wrapper (`src/tcp-connection.ts`) |
| :--- | :--- | :--- |
| **Underlying Engine** | `node:net` (`net.createConnection`, `net.createServer`) | Native Bun Zig engine (`Bun.connect`, `Bun.listen`) |
| **API Paradigm** | **Push Loop** (`socket.run(handler)`) + **Channels** (`toChannel`) | **Pull Stream** (`Stream.fromQueue`) + `send()` methods |
| **Writing & Backpressure** | Node stream callback (`conn.write(chunk, cb)`), OS buffer | Direct `socket.write(chunk)` return code + `drain` event waiter |
| **Write Concurrency** | Sequenced through `writer` / Channel pipelines | Explicit `Semaphore(1)` + `MutableRef<Deferred>` for drain |
| **Portability** | Multi-runtime (Node.js, Bun, Cloudflare Workers/Browsers via ws/streams) | **Bun runtime only** (`Bun.connect`, `Bun.Socket`) |
| **Transport Versatility** | Unified interface for TCP, Unix Sockets, WebSockets, Duplex streams | Specialized strictly for Bun TCP / TLS |
| **Error Handling** | Schema-backed `SocketError` (`Read`, `Write`, `Open`, `Close`) | `Data.TaggedError("TcpStreamError")` with operation tags |
| **Connection State** | Managed via `FiberSet`, `Latch`, and Node stream event listeners | Explicit `MutableRef<ConnectionState>` (`Open` / `Closed`) |
| **Reconnection Support** | Composed with Effect combinators (`Effect.retry`, `Layer.retry`) | Built-in `RetryPolicyConfig` & `Schedule.Schedule` in layer |

---

### 4.2 Detailed Architectural Differences

#### 1. Backpressure Mechanics: Node Callback vs Bun Native Drain
- **`@effect/platform-bun`**:
  Node streams handle write queuing in JavaScript memory if the OS kernel buffer fills up, invoking the `write(chunk, cb)` callback once the kernel accepts the bytes or the buffer drains.
- **Custom Bun (`Bun.connect`)**:
  Bun's native `socket.write()` performs non-blocking kernel writes without transparent JS queuing. If a partial write occurs (e.g. 4096 out of 8192 bytes written), the caller must track the slice offset and wait for the `drain(socket)` event callback. `src/tcp-connection.ts` manages this using a `Deferred.Deferred<void, TcpStreamError>` and a `Semaphore(1)`.

#### 2. Push-Based Event Loop vs Pull-Based Stream Queue
- **`@effect/platform`**:
  Uses `socket.run(chunk => Effect.gen(...))`. This minimizes intermediate queue allocations by executing user handlers directly in response to incoming socket data events. When a pull-stream interface is desired, `Socket.toChannel` converts the push model into an Effect Channel.
- **Custom `TcpStream`**:
  Routes all incoming chunks into an unbounded Effect `Queue` (`Queue.unbounded<Uint8Array>`), exposing `Stream.fromQueue(incoming)`. While familiar for stream consumers, it incurs intermediate memory allocation for each incoming chunk before downstream consumption.

#### 3. Framing and Protocol Layering
- **`@effect/platform`**:
  Designed to sit cleanly underneath higher-level Effect protocols (such as `effect/unstable/rpc/RpcClient`, `effect/unstable/cluster/SocketRunner`, and `@effect/sql`). Protocols consume `Socket` or `Channel` directly.
- **Custom `TcpStream`**:
  Typically requires manual framing loops on top of `Stream.Stream` (e.g. `Stream.splitOn`, `Stream.decodeText`).

---

## 5. Code Examples

### 5.1 TCP Client with `@effect/platform-bun` (`run` & `writer`)

This example opens a TCP connection, acquires a writer to send a payload, and handles incoming data in a run loop.

```typescript
import { BunSocket } from "@effect/platform-bun"
import { Console, Effect, Fiber, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

const clientProgram = Effect.gen(function* () {
  // 1. Create a scoped TCP socket connection
  const socket = yield* BunSocket.makeNet({
    host: "127.0.0.1",
    port: 8080,
    openTimeout: "3 seconds"
  })

  // 2. Open a dedicated scope for writing
  const writeScope = yield* Scope.make()
  const write = yield* Scope.provide(socket.writer, writeScope)

  // 3. Start the read handler in a background fiber
  const readFiber = yield* socket.run(
    (data: Uint8Array) =>
      Console.log(`Received from server: ${new TextDecoder().decode(data)}`),
    {
      onOpen: Console.log("Connected to TCP server!")
    }
  ).pipe(Effect.fork)

  // 4. Send request data
  yield* write(new TextEncoder().encode("PING\n"))
  yield* Effect.sleep("500 millis")
  yield* write(new TextEncoder().encode("HELLO EFFECT 4\n"))

  // 5. Cleanup writer and wait for read loop or termination
  yield* Scope.close(writeScope, Effect.exit(Effect.void))
  yield* Fiber.interrupt(readFiber)
})

// Run within a top-level Scope
Effect.runPromise(Effect.scoped(clientProgram))
```

---

### 5.2 TCP Client using Bidirectional `Channel` / `Stream`

Using `Socket.toChannel` to stream data bidirectionally:

```typescript
import { BunSocket } from "@effect/platform-bun"
import { Channel, Chunk, Console, Effect, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

const channelExample = Effect.gen(function* () {
  const socket = yield* BunSocket.makeNet({
    host: "127.0.0.1",
    port: 8080
  })

  // Convert Socket to a bidirectional Channel
  const socketChannel = Socket.toChannelString(socket)

  // Stream outgoing messages and pipe through the socket channel
  const outgoingStream = Stream.make("MSG 1\n", "MSG 2\n", "QUIT\n")

  yield* outgoingStream.pipe(
    Stream.toChannel,
    Channel.pipeTo(socketChannel),
    Channel.toStream,
    Stream.runForEach((response) =>
      Console.log(`Stream received: ${response}`)
    )
  )
})

Effect.runPromise(Effect.scoped(channelExample))
```

---

### 5.3 TCP Server with `@effect/platform-bun` (`BunSocketServer`)

Creating a concurrent TCP server that accepts client connections, provides the `NetSocket` service, and gracefully shuts down.

```typescript
import { BunSocketServer } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as SocketServer from "effect/unstable/socket/SocketServer"

// Connection handler for each client
const handleConnection = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const netSocket = yield* BunSocketServer.NodeSocket.NetSocket
    const clientInfo = `${netSocket.remoteAddress}:${netSocket.remotePort}`
    yield* Console.log(`[+] Client connected from ${clientInfo}`)

    const write = yield* socket.writer

    // Echo back all received data
    yield* socket.run((chunk) =>
      Effect.gen(function* () {
        const text = new TextDecoder().decode(chunk)
        yield* Console.log(`[${clientInfo}] -> ${text.trim()}`)
        yield* write(new TextEncoder().encode(`ECHO: ${text}`))
      })
    )

    yield* Console.log(`[-] Client disconnected: ${clientInfo}`)
  })

// Main server run loop
const serverProgram = Effect.gen(function* () {
  const server = yield* SocketServer.SocketServer

  if (server.address._tag === "TcpAddress") {
    yield* Console.log(
      `Server listening on ${server.address.hostname}:${server.address.port}`
    )
  }

  // Run the server accepting connections concurrently
  yield* server.run(handleConnection)
})

// Configure Server Layer on port 8080
const ServerLive = BunSocketServer.layer({
  port: 8080,
  host: "0.0.0.0"
})

const MainLive = serverProgram.pipe(Effect.provide(ServerLive))

Effect.runPromise(Effect.scoped(MainLive))
```

---

### 5.4 Handling Clean Closes, Retries and Scoped Cleanup

```typescript
import { BunSocket } from "@effect/platform-bun"
import { Console, Effect, Layer, Schedule } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

const resilientClient = Effect.gen(function* () {
  const socket = yield* Socket.Socket

  yield* socket.runString((message) => Console.log(`Received: ${message}`))
}).pipe(
  // Filter clean close (code 1000) from unexpected failures
  Effect.catchFilter(
    Socket.SocketCloseError.filterClean((code) => code === 1000),
    () => Console.log("Connection closed cleanly by peer.")
  ),
  // Exponential backoff reconnect policy
  Effect.retry(
    Schedule.exponential("200 millis", 2.0).pipe(
      Schedule.intersect(Schedule.recurs(5))
    )
  )
)

// Provide socket layer
const SocketLayer = BunSocket.layerNet({ host: "127.0.0.1", port: 8080 })
Effect.runPromise(resilientClient.pipe(Effect.provide(SocketLayer)))
```

---

## 6. Primary Sources & Reference Index

| Symbol / API | Primary Source File in Repo / Packages | Description |
| :--- | :--- | :--- |
| `Socket.Socket` | `node_modules/effect/src/unstable/socket/Socket.ts` | Core push-based bidirectional socket interface |
| `Socket.make` | `node_modules/effect/src/unstable/socket/Socket.ts:114` | Constructor synthesizing `run`, `runString`, `writer` |
| `Socket.toChannel` | `node_modules/effect/src/unstable/socket/Socket.ts:468` | Converts `Socket` to bidirectional Effect `Channel` |
| `SocketError` | `node_modules/effect/src/unstable/socket/Socket.ts:351` | Root schema-tagged error wrapping socket failure reasons |
| `SocketCloseError` | `node_modules/effect/src/unstable/socket/Socket.ts:285` | Typed error with close code, reason, and `filterClean` |
| `SocketServer.SocketServer` | `node_modules/effect/src/unstable/socket/SocketServer.ts:24` | Service for listening servers across TCP/Unix |
| `BunSocket` | `node_modules/@effect/platform-bun/src/BunSocket.ts` | Bun entry point re-exporting `NodeSocket` + global WS |
| `BunSocketServer` | `node_modules/@effect/platform-bun/src/BunSocketServer.ts` | Bun entry point re-exporting `NodeSocketServer` |
| `NodeSocket.makeNet` | `@effect/platform-node-shared/src/NodeSocket.ts:50` | Opens `net.createConnection` as scoped `Socket.Socket` |
| `NodeSocket.fromDuplex` | `@effect/platform-node-shared/src/NodeSocket.ts:98` | Adapts Node `Duplex` stream into `Socket.Socket` |
| `NodeSocket.NetSocket` | `@effect/platform-node-shared/src/NodeSocket.ts:35` | Context service exposing underlying Node/Bun `net.Socket` |
| `NodeSocketServer.make` | `@effect/platform-node-shared/src/NodeSocketServer.ts:46` | Scoped constructor for TCP `net.Server` with connection buffering |
| `NodeSocketServer.layer` | `@effect/platform-node-shared/src/NodeSocketServer.ts:175` | `Layer.Layer` constructor for `SocketServer` |
| `Custom TcpStream` | `src/tcp-connection.ts:80` | Existing custom Bun-native `Bun.connect` reference implementation |
