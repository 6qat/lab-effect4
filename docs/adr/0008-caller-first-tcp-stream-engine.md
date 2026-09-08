# ADR 0008: Caller-First TCP Stream Engine

## Status

Accepted

## Decision

`TcpStreamEngine.connect` is a single-attempt, caller-first operation. It returns an established connection containing an idempotent `RawSocketHandle` and a cold, ordered `Stream` of data and drain events. Retry remains owned by `TcpStream`, outside the attempt module.

Runtime adapters use a package-private cold protocol with synchronous event-emission disposition. The deep module owns readiness, first-outcome-wins settlement, per-attempt event queues, stale-signal suppression, and failure mapping. The surrounding `TcpStream` module retains retry, write serialization, and established-session orchestration. Adapter event buffers have stable byte ownership.

Connect timeout is applied centrally around native connect, TLS/readiness and event setup, and Platform writer acquisition. Bun late promise settlement, Node socket destruction, and Platform owner-scope resources remain local to their adapters. A graceful close completes the event stream.

## Consequences

Failed or interrupted attempts discard their event queues, so retries cannot expose stale data. Explicit close makes the shared event sink terminal and the shared handle close is effective once, while runtime-specific close remains idempotent as a defensive adapter property. The caller receives one established connection rather than callback registration state. Runtime-specific cleanup remains testable without expanding the public engine contract.
