# Effect v4 HTTP Server API Specification & Research

## Executive Summary

In Effect v4 (`effect: 4.0.0-rc.109+`, `@effect/platform-bun: 4.0.0-rc.111+`, `@effect/platform-node: 4.0.0-rc.111+`), the HTTP server APIs previously found under `@effect/platform` have been entirely merged into the core `effect` package under the **`effect/unstable/http/*`** namespace. 

Effect v4 modernizes the routing system, shifting from a fluid builder API to a **Layer-based routing architecture**. Rather than chaining `.get()` and `.post()` calls on an `HttpRouter`, routes are now constructed individually as `Layer`s using `HttpRouter.add` and subsequently merged into an application graph (`Layer.mergeAll`). 

This research document details the platform adapters, the new Layer-based router composition, request/response models, schema validation, and middleware integration in Effect v4.

---

## 1. Core HTTP Server Modules (`effect/unstable/http/*`)

All core HTTP server components are imported directly from `effect/unstable/http/*` (e.g., `HttpRouter`, `HttpServerRequest`, `HttpServerResponse`).

### 1.1 `HttpServer` and Run-Time Adapters
The base HTTP server interface is defined in `effect/unstable/http/HttpServer`. Platform-specific packages provide implementations as layers:
- **Bun**: `BunHttpServer.layer({ port: 3000 })` (from `@effect/platform-bun`)
- **Node.js**: `NodeHttpServer.layer({ port: 3000 })` (from `@effect/platform-node`)

These platform adapters map native Web `Request` (or Node `IncomingMessage`) primitives to `HttpServerRequest` and wrap native server lifecycles in `Scope.Scope`. They also provide related services like `HttpPlatform` and `Etag.Generator`.

### 1.2 Route Definition and the `HttpRouter`
The central routing service is `HttpRouter` (`effect/unstable/http/HttpRouter`).

In Effect v4, `HttpRouter.add` yields a `Layer.Layer` rather than returning a router object:
```typescript
import { HttpRouter } from "effect/unstable/http/HttpRouter"

export const add = <E = never, R = never>(
  method: "*" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
  path: PathInput,
  handler:
    | HttpServerResponse.HttpServerResponse
    | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    | ((request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>),
  options?: { readonly uninterruptible?: boolean }
): Layer.Layer<never, never, HttpRouter | Request.From<"Requires", Exclude<R, Provided>> | Request.From<"Error", E>>
```
Because `add` returns a `Layer`, multiple routes are combined concurrently using `Layer.mergeAll`.

### 1.3 `HttpServerRequest` and `HttpServerResponse`
- **`HttpServerRequest`**: Provides context about the current request (`url`, `method`, `headers`, `cookies`). Exposes effects to safely parse bodies: `.text`, `.json`, `.urlParamsBody`, `.stream`, `.arrayBuffer`, and `.multipart`. It also supports WebSocket upgrades via `.upgrade` which yields an `effect/unstable/socket/Socket` connection.
- **`HttpServerResponse`**: Exposes pure constructors for responses, such as `HttpServerResponse.text("hello")`, `HttpServerResponse.json({ ... })`, `HttpServerResponse.empty()`, and `HttpServerResponse.stream(stream)`.

---

## 2. Server Composition & Lifecycle (`HttpRouter.serve`)

To wire the application together and expose it over the network, `HttpRouter.serve` is used to convert the assembled route layers into a runnable `HttpServer` application.

```typescript
// Primary source: effect/src/unstable/http/HttpRouter.ts
export const serve = <A, E, R, HE, HR>(
  appLayer: Layer.Layer<A, E, R>,
  options?: {
    readonly disableLogger?: boolean
    readonly disableListenLog?: boolean
    readonly middleware?: (effect: Effect.Effect<HttpServerResponse, ...>) => Effect.Effect<HttpServerResponse, HE, HR>
  }
): Layer.Layer<A, E, HttpServer.HttpServer | ...>
```
`HttpRouter.serve(routesLayer)` requires `HttpServer.HttpServer`, meaning you `.pipe(Layer.provide(BunHttpServer.layer(...)))` onto it to fulfill the runtime platform dependency.

---

## 3. Middleware & Error Handling

### 3.1 Middleware Configuration
Middleware functions operate on the `Effect.Effect<HttpServerResponse>` handler level. Middleware can be applied locally or globally.
- **`HttpRouter.middleware(fn, { global: true })`**: Returns a layer that applies middleware globally across all handled routes.
- Built-in middlewares include `HttpRouter.cors(...)` (from `effect/unstable/http/HttpRouter`) and the logger, which is enabled by default in `serve`.

### 3.2 Error Hierarchy & The `Respondable` Protocol
Failures (both typed errors and defects) are caught by the `HttpEffect.toHandled` pipeline. Effect v4 relies on the **`Respondable` protocol** (`effect/unstable/http/HttpServerRespondable`):
- Any class or error that implements `[Respondable.symbol]()` knows how to render itself as an `HttpServerResponse`.
- By default, standard failures map intuitively:
  - `Schema.SchemaError` automatically converts into a `400 Bad Request`.
  - `Cause.NoSuchElementException` automatically converts into a `404 Not Found`.
  - Routing failures (`HttpServerError.RouteNotFound`) yield standard `404` error responses.

### 3.3 Schema Validation
Route handlers can parse typed payloads using `HttpRouter.schemaJson` and `HttpRouter.schemaNoBody`:
```typescript
import { HttpRouter } from "effect/unstable/http/HttpRouter"

// schemaJson extracts the JSON body, search parameters, headers, etc.
// Returns Effect<A, HttpServerError | SchemaError, HttpServerRequest | RouteContext>
HttpRouter.schemaJson(MySchema)
```
Responses can likewise be serialized using `HttpServerResponse.schemaJson(MySchema)(data)`.

---

## 4. Practical Examples

### 4.1 Minimal "Hello World" Server
```typescript
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

// 1. Define Routes
const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/", HttpServerResponse.text("Hello World!")),
  HttpRouter.add("GET", "/ping", Effect.succeed(HttpServerResponse.text("pong")))
)

// 2. Connect Router to HTTP Server
const App = HttpRouter.serve(Routes).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 }))
)

// 3. Launch
Effect.runFork(Layer.launch(App))
```

### 4.2 Typed JSON Request & Response with Schema
```typescript
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

const UserRequest = Schema.Struct({ name: Schema.String })
const UserResponse = Schema.Struct({ message: Schema.String })

const GreetRoute = HttpRouter.add("POST", "/greet", 
  HttpRouter.schemaJson(UserRequest).pipe(
    Effect.map((body) => ({ message: `Hello, ${body.name}!` })),
    Effect.flatMap(HttpServerResponse.schemaJson(UserResponse))
  )
)

const App = HttpRouter.serve(GreetRoute).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 }))
)
```

### 4.3 WebSocket Upgrade Support
WebSocket routes are managed seamlessly. Using `HttpServerRequest.upgrade` returns an `effect/unstable/socket/Socket` wrapped in an `Effect`.
```typescript
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"

const WsRoute = HttpRouter.add("GET", "/ws", (request) =>
  Effect.gen(function* () {
    const socket = yield* request.upgrade
    const channel = Socket.toChannelString(socket)
    
    // Wire channel or stream logic here...
    
    // The handler does not return a traditional HttpResponse. 
    // The platform adapter intercepts the upgrade and completes the handshake.
    return yield* Effect.never 
  })
)

const ServerLive = BunHttpServer.layer({ 
  port: 3000, 
  websocket: { perMessageDeflate: true } 
})

const App = HttpRouter.serve(WsRoute).pipe(Layer.provide(ServerLive))
```

---

## 5. Primary Sources & Reference Index

| Symbol / API | Primary Source File in Repo | Description |
| :--- | :--- | :--- |
| `HttpRouter.add` | `node_modules/effect/src/unstable/http/HttpRouter.ts:502` | Defines a route, yielding a `Layer`. |
| `HttpRouter.serve` | `node_modules/effect/src/unstable/http/HttpRouter.ts:1269` | Binds the route `appLayer` into the runtime server `HttpServer`. |
| `BunHttpServer.layer` | `node_modules/@effect/platform-bun/src/BunHttpServer.ts:284` | Bun platform `HttpServer` layer. |
| `HttpServerRequest` | `node_modules/effect/src/unstable/http/HttpServerRequest.ts:79` | Core request structure mapping URLs, params, body formats, and upgrades. |
| `HttpServerResponse.text` | `node_modules/effect/src/unstable/http/HttpServerResponse.ts:197` | Creates a standard string response. |
| `HttpServerRespondable` | `node_modules/effect/src/unstable/http/HttpServerRespondable.ts:38` | Protocol converting mapped errors (`SchemaError`) to Responses. |

