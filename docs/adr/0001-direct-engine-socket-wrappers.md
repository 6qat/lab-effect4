# Direct Engine Socket Wrappers Over @effect/platform Socket

To build streaming protocol clients (e.g. Cedro and DTC), we require a bidirectional interface with pull-based `Stream` semantics for reading and backpressured Effect operations for writing. We chose to implement direct runtime engine wrappers (`Bun.connect` and `node:net`/`node:tls`) unified under a shared `TcpStream` service, rather than adopting `@effect/platform`'s `Socket.Socket` push-loop abstraction (`run(handler)`). This gives us explicit control over connection timeouts, exponential backoff retries, and write backpressure while presenting an intuitive and composable Effect Stream interface across both Bun and Node.js runtimes.

## Status
Accepted

## Considered Options
- **`@effect/platform-node` (`NodeSocket`)**: Provides an inversion-of-control push-based handler (`run(handler)`). Rejected because protocol framing, stateful decoding pipelines, and request-response patterns compose far more naturally with pull-based `Stream.Stream` pipelines.
- **Direct Engine Wrappers (`Bun.connect` / `node:net`)**: Adopted. Enables identical service signatures (`TcpStreamShape`) across runtimes with engine-specific flow control.

