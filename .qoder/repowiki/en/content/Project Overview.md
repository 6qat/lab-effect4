# Project Overview

<cite>
**Referenced Files in This Document**
- [package.json](file://package.json)
- [packages/tcp/package.json](file://packages/tcp/package.json)
- [packages/lab/package.json](file://packages/lab/package.json)
- [packages/tcp/README.md](file://packages/tcp/README.md)
- [packages/lab/README.md](file://packages/lab/README.md)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md](file://docs/adr/0009-private-lab-and-tcp-workspaces.md)
- [packages/tcp/src/tcp-stream-engine.ts](file://packages/tcp/src/tcp-stream-engine.ts)
- [packages/tcp/src/tcp-connection-common.ts](file://packages/tcp/src/tcp-connection-common.ts)
- [packages/tcp/src/tcp-connection-bun.ts](file://packages/tcp/src/tcp-connection-bun.ts)
- [packages/tcp/src/tcp-connection-nodejs.ts](file://packages/tcp/src/tcp-connection-nodejs.ts)
- [packages/tcp/src/tcp-connection-platform.ts](file://packages/tcp/src/tcp-connection-platform.ts)
- [docs/research/effect-v4-platform-tcp-connection.md](file://docs/research/effect-v4-platform-tcp-connection.md)
</cite>

## Update Summary
**Changes Made**
- Updated project structure section to reflect migration from single-package to Bun monorepo workspace
- Added new workspace architecture overview showing packages/lab and packages/tcp separation
- Updated file references throughout to use new package paths
- Enhanced dependency analysis to show workspace relationships
- Added workspace-specific configuration and tooling details

## Table of Contents
1. [Introduction](#introduction)
2. [Workspace Architecture](#workspace-architecture)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This project is an Effect-based TCP stream library that provides a cross-platform, unified API for TCP socket connectivity across Bun, Node.js, and the Effect Platform runtime. Built on TypeScript and Effect v4, it abstracts platform-specific networking details behind a consistent interface while delivering production-grade features such as advanced connection management, retry logic with configurable schedules, connect timeouts, backpressure-aware writes, and robust lifecycle management via Effect Scopes and Layers.

The project has been restructured into a Bun monorepo workspace containing two distinct packages:
- **packages/tcp**: The core TCP stream library with platform adapters and demonstrations
- **packages/lab**: Standalone Effect v4 learning examples and experiments

The library targets:
- Beginners learning functional programming patterns through a practical, well-structured codebase.
- Experienced developers building resilient network applications that must run consistently across multiple JavaScript runtimes.

It serves both as a usable networking layer and as an educational resource demonstrating modern asynchronous I/O patterns using Effect's composable primitives (Streams, Queues, Semaphores, Deferred, Schedules, and Layered dependency injection).

**Section sources**
- [package.json:2-6](file://package.json#L2-L6)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md:1-8](file://docs/adr/0009-private-lab-and-tcp-workspaces.md#L1-L8)
- [packages/tcp/README.md:1-27](file://packages/tcp/README.md#L1-L27)
- [packages/lab/README.md:1-31](file://packages/lab/README.md#L1-L31)

## Workspace Architecture
The repository now uses a Bun monorepo workspace structure with two private packages under `packages/`:

```mermaid
graph TB
Root["lab-effect4 (Root Workspace)"]
Lab["packages/lab<br/>Effect Learning Examples"]
Tcp["packages/tcp<br/>TCP Stream Library"]
Root --> Lab
Root --> Tcp
subgraph "Lab Package"
L1["concurrency examples"]
L2["control flow examples"]
L3["mq worker example"]
end
subgraph "TCP Package"
T1["tcp-stream-engine.ts"]
T2["platform adapters"]
T3["protocol implementations"]
T4["tests & demos"]
end
Lab -.->|Independent| Tcp
```

**Updated** Major architectural migration from single-package to Bun monorepo workspace structure with packages/lab and packages/tcp directories replacing the flat src/ layout.

### Package Responsibilities
- **packages/tcp**: Contains the complete TCP stream implementation including the engine, platform adapters (Bun, Node.js, Effect Platform), protocol implementations (line framing, Cedro protocol), and HTTP demonstration client.
- **packages/lab**: Contains standalone Effect v4 learning examples covering concurrency, control flow, error handling, and messaging patterns without dependencies on the TCP package.

### Workspace Configuration
The root `package.json` defines Bun workspaces and shared scripts:
- Workspaces pattern: `"packages/*"`
- Shared commands: test, typecheck, format, lint
- Single `bun.lock` file for dependency management
- Biome for formatting and linting across all packages

**Diagram sources**
- [package.json:7-16](file://package.json#L7-L16)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md:1-8](file://docs/adr/0009-private-lab-and-tcp-workspaces.md#L1-L8)

**Section sources**
- [package.json:7-16](file://package.json#L7-L16)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md:1-8](file://docs/adr/0009-private-lab-and-tcp-workspaces.md#L1-L8)
- [packages/tcp/package.json:1-21](file://packages/tcp/package.json#L1-L21)
- [packages/lab/package.json:1-21](file://packages/lab/package.json#L1-L21)

## Core Components
- TcpStream: The primary service exposing a bidirectional communication channel with an incoming Stream of bytes and backpressure-aware send methods. It encapsulates connection lifecycle, retries, timeouts, and graceful close semantics.
- TcpStreamEngine: An abstraction over platform-specific socket implementations. Adapters implement a cold connection protocol that emits readiness, data, drain, close, and error events to the engine.
- ConnectionConfig: Typed configuration for host, port, TLS options, retry policy or schedule, and connect timeout. Validated before use.
- Error Model: A tagged error type that captures operation context (connect/read/write), messages, and underlying causes for precise error handling.

Key capabilities:
- Advanced connection management: Scoped acquisition/release, interruption-safe connect, and idempotent close.
- Retry logic: Configurable exponential backoff with jitter, max attempts/duration, or custom schedules.
- Timeouts: Connect timeout enforced centrally around adapter setup and readiness.
- Backpressure: Write serialization via a semaphore and drain-waiting to avoid overwhelming kernel buffers.
- Lifecycle: Scope-owned resources ensure cleanup on interruption or scope completion.

**Section sources**
- [packages/tcp/src/tcp-connection-common.ts:12-101](file://packages/tcp/src/tcp-connection-common.ts#L12-L101)
- [packages/tcp/src/tcp-stream-engine.ts:64-178](file://packages/tcp/src/tcp-stream-engine.ts#L64-L178)
- [packages/tcp/src/tcp-stream-engine.ts:201-341](file://packages/tcp/src/tcp-stream-engine.ts#L201-L341)

## Architecture Overview
The architecture follows a caller-first engine pattern:
- Adapters provide a cold connection function that emits events until Ready/Data/Drain/Close/Error.
- The engine coordinates readiness, event queuing, and failure mapping, returning a stable handle and an ordered event stream.
- TcpStream composes the engine with retry, timeouts, write serialization, and stream orchestration.

```mermaid
sequenceDiagram
participant App as "Application"
participant TS as "TcpStream"
participant Eng as "TcpStreamEngine"
participant Ad as "Adapter (Bun/Node/Platform)"
participant Net as "Native Socket"
App->>TS : "Acquire TcpStream"
TS->>Eng : "connect(config)"
Eng->>Ad : "cold adapter(config, emit)"
Ad->>Net : "Create/connect socket"
Net-->>Ad : "Ready/Data/Drain/Close/Error"
Ad-->>Eng : "Events mapped to engine events"
Eng-->>TS : "EstablishedConnection {socket, events}"
TS->>TS : "Retry + Timeout + Write Serialization"
TS-->>App : "TcpStream {stream, send, sendText, close}"
```

**Diagram sources**
- [packages/tcp/src/tcp-stream-engine.ts:89-178](file://packages/tcp/src/tcp-stream-engine.ts#L89-L178)
- [packages/tcp/src/tcp-connection-bun.ts:18-136](file://packages/tcp/src/tcp-connection-bun.ts#L18-L136)
- [packages/tcp/src/tcp-connection-nodejs.ts:21-119](file://packages/tcp/src/tcp-connection-nodejs.ts#L21-L119)
- [packages/tcp/src/tcp-connection-platform.ts:17-128](file://packages/tcp/src/tcp-connection-platform.ts#L17-L128)

## Detailed Component Analysis

### Shared Types and Configuration
- ConnectionConfigShape defines host, port, optional TLS, retry policy/schedule, and connectTimeout.
- Validation ensures valid host/port and returns typed errors for invalid configurations.
- Default retry schedule builds exponential backoff with jitter and caps attempts/duration.

```mermaid
flowchart TD
Start(["Validate ConnectionConfig"]) --> CheckPort{"Port is integer<br/>and in range?"}
CheckPort --> |No| FailPort["Fail with ConnectionConfigError"]
CheckPort --> |Yes| CheckHost{"Host non-empty?"}
CheckHost --> |No| FailHost["Fail with ConnectionConfigError"]
CheckHost --> |Yes| Success["Return validated config"]
```

**Diagram sources**
- [packages/tcp/src/tcp-connection-common.ts:65-88](file://packages/tcp/src/tcp-connection-common.ts#L65-L88)
- [packages/tcp/src/tcp-connection-common.ts:90-101](file://packages/tcp/src/tcp-connection-common.ts#L90-L101)

**Section sources**
- [packages/tcp/src/tcp-connection-common.ts:12-101](file://packages/tcp/src/tcp-connection-common.ts#L12-L101)

### Engine Orchestration and Lifecycle
- makeTcpStreamEngine wraps a cold adapter, manages phases (connecting/ready/closed), and exposes an EstablishedConnection with a RawSocketHandle and an ordered Stream of events.
- withConnectTimeout applies a central timeout around connect and maps failures to TcpStreamError.
- makeTcpStream composes retry, acquire/release, event fan-out, write serialization, and graceful close.

```mermaid
classDiagram
class TcpStreamEngine {
+connect(config) Effect
}
class TcpStream {
+stream Stream
+send(data) Effect
+sendText(text) Effect
+close() Effect
}
class RawSocketHandle {
+write(chunk) Effect
+close() Effect
}
TcpStream --> TcpStreamEngine : "uses"
TcpStreamEngine --> RawSocketHandle : "returns"
```

**Diagram sources**
- [packages/tcp/src/tcp-stream-engine.ts:64-67](file://packages/tcp/src/tcp-stream-engine.ts#L64-L67)
- [packages/tcp/src/tcp-stream-engine.ts:89-178](file://packages/tcp/src/tcp-stream-engine.ts#L89-L178)
- [packages/tcp/src/tcp-stream-engine.ts:201-341](file://packages/tcp/src/tcp-stream-engine.ts#L201-L341)

**Section sources**
- [packages/tcp/src/tcp-stream-engine.ts:89-178](file://packages/tcp/src/tcp-stream-engine.ts#L89-L178)
- [packages/tcp/src/tcp-stream-engine.ts:201-341](file://packages/tcp/src/tcp-stream-engine.ts#L201-L341)

### Platform Adapters
- Bun Adapter: Uses native Bun.connect with binaryType set to Uint8Array; maps data/drain/end/close/error events; write uses direct socket.write and flush; close terminates or ends the socket.
- Node.js Adapter: Uses node:net/node:tls; handles data/drain/close/error events; write uses socket.write and reports flushed status; destroy on close.
- Platform Adapter: Uses @effect/platform's Socket.Socket; creates sockets via BunSocket.makeNet or fromDuplex for TLS; integrates writer and run loop; closes via scoped owner.

```mermaid
graph LR
A["Bun Adapter"] --> E["TcpStreamEngine"]
B["Node.js Adapter"] --> E
C["Platform Adapter"] --> E
E --> D["TcpStream"]
```

**Diagram sources**
- [packages/tcp/src/tcp-connection-bun.ts:18-136](file://packages/tcp/src/tcp-connection-bun.ts#L18-L136)
- [packages/tcp/src/tcp-connection-nodejs.ts:21-119](file://packages/tcp/src/tcp-connection-nodejs.ts#L21-L119)
- [packages/tcp/src/tcp-connection-platform.ts:17-128](file://packages/tcp/src/tcp-connection-platform.ts#L17-L128)

**Section sources**
- [packages/tcp/src/tcp-connection-bun.ts:18-136](file://packages/tcp/src/tcp-connection-bun.ts#L18-L136)
- [packages/tcp/src/tcp-connection-nodejs.ts:21-119](file://packages/tcp/src/tcp-connection-nodejs.ts#L21-L119)
- [packages/tcp/src/tcp-connection-platform.ts:17-128](file://packages/tcp/src/tcp-connection-platform.ts#L17-L128)

### Backpressure and Write Serialization
- Writes are serialized with a Semaphore(1) to prevent concurrent writes.
- Partial writes and drain signals are handled by waiting on a Deferred until the buffer drains or the write completes.
- On connection close, pending writers fail with a clear TcpStreamError indicating closed state.

```mermaid
flowchart TD
WStart(["send(data)"]) --> Lock["Acquire write lock"]
Lock --> Loop{"Offset < length?"}
Loop --> |No| Done["Return success"]
Loop --> |Yes| CheckState{"Connection Open?"}
CheckState --> |No| FailClosed["Fail with TcpStreamError('closed')"]
CheckState --> |Yes| Write["Write chunk"]
Write --> Partial{"bytesWritten == 0?"}
Partial --> |Yes| WaitDrain["Wait for Drain Deferred"]
WaitDrain --> Loop
Partial --> |No| Advance["Advance offset"]
Advance --> Flush{"flushed?"}
Flush --> |Yes| Loop
Flush --> |No| WaitDrain
```

**Diagram sources**
- [packages/tcp/src/tcp-stream-engine.ts:300-332](file://packages/tcp/src/tcp-stream-engine.ts#L300-L332)

**Section sources**
- [packages/tcp/src/tcp-stream-engine.ts:300-332](file://packages/tcp/src/tcp-stream-engine.ts#L300-L332)

### Retry and Timeouts
- Retry can be disabled, configured via RetryPolicyConfig, or provided as a custom Schedule.
- Default retry uses exponential backoff with jitter and caps attempts/duration.
- Connect timeout is applied centrally; failures are normalized to TcpStreamError.

```mermaid
flowchart TD
RStart(["Attempt connect"]) --> Policy{"retrySchedule provided?"}
Policy --> |Yes| Custom["Use custom schedule"]
Policy --> |No| Default{"retry === false?"}
Default --> |Yes| NoRetry["No retry"]
Default --> |No| Build["Build default exponential+jitter schedule"]
Custom --> Attempt["engine.connect(config)"]
Build --> Attempt
NoRetry --> Attempt
Attempt --> Timeout["Apply connect timeout"]
Timeout --> Result{"Success?"}
Result --> |Yes| Return["Return connection"]
Result --> |No| Handle["Map to TcpStreamError"]
```

**Diagram sources**
- [packages/tcp/src/tcp-stream-engine.ts:238-259](file://packages/tcp/src/tcp-stream-engine.ts#L238-L259)
- [packages/tcp/src/tcp-stream-engine.ts:180-195](file://packages/tcp/src/tcp-stream-engine.ts#L180-L195)
- [packages/tcp/src/tcp-connection-common.ts:90-101](file://packages/tcp/src/tcp-connection-common.ts#L90-L101)

**Section sources**
- [packages/tcp/src/tcp-stream-engine.ts:238-259](file://packages/tcp/src/tcp-stream-engine.ts#L238-L259)
- [packages/tcp/src/tcp-stream-engine.ts:180-195](file://packages/tcp/src/tcp-stream-engine.ts#L180-L195)
- [packages/tcp/src/tcp-connection-common.ts:90-101](file://packages/tcp/src/tcp-connection-common.ts#L90-L101)

## Dependency Analysis
The workspace structure separates dependencies between packages:

### Root Workspace Dependencies
- Development tooling: Biome, TypeScript, Effect language service
- Type definitions: @types/bun, @types/node

### TCP Package Dependencies
- effect: core runtime primitives (Effect, Stream, Queue, Semaphore, Deferred, Schedule, Layer, etc.).
- @effect/platform-bun and @effect/platform-node: platform abstractions used by the Platform adapter.
- Native modules: Bun APIs for Bun adapter; node:net and node:tls for Node.js adapter.

### Lab Package Dependencies
- effect: core Effect v4 primitives for learning examples
- @effect/platform-bun: platform integration for examples
- effect-mq: message queue utilities for worker examples

```mermaid
graph TB
Root["lab-effect4 (Root)"]
Tcp["tcp (packages/tcp)"]
Lab["lab (packages/lab)"]
Root --> Tcp
Root --> Lab
Tcp --> Eff["effect (v4)"]
Tcp --> PlatB["@effect/platform-bun"]
Tcp --> PlatN["@effect/platform-node"]
Tcp --> BunAPI["Bun APIs"]
Tcp --> Net["node:net / node:tls"]
Lab --> Eff
Lab --> PlatB
Lab --> MQ["effect-mq"]
```

**Diagram sources**
- [package.json:22-28](file://package.json#L22-L28)
- [packages/tcp/package.json:15-19](file://packages/tcp/package.json#L15-L19)
- [packages/lab/package.json:15-19](file://packages/lab/package.json#L15-L19)

**Section sources**
- [package.json:22-28](file://package.json#L22-L28)
- [packages/tcp/package.json:15-19](file://packages/tcp/package.json#L15-L19)
- [packages/lab/package.json:15-19](file://packages/lab/package.json#L15-L19)

## Performance Considerations
- Backpressure-aware writes minimize memory pressure by honoring drain signals and avoiding unbounded queues for outgoing data.
- Scoped lifecycles ensure timely release of OS resources and prevent leaks during interruptions or failures.
- Centralized connect timeout prevents long-running hangs during network issues.
- Retry with jitter reduces thundering herds when reconnecting after transient failures.
- Platform differences: Bun's native socket path avoids extra buffering; Node.js path leverages stream callbacks; Platform path integrates with Effect's push-based Socket model.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common issues and how they are handled:
- Invalid configuration: Host/port validation fails early with a typed error.
- Connect timeout: Normalized to TcpStreamError with operation "connect".
- Remote close: Incoming stream ends cleanly; pending writers fail with a clear message.
- Interrupted connections: Scoped ownership ensures cleanup; no defects propagate if handled correctly.
- TLS handshake failures: Errors surface at connect or first write depending on adapter; tests assert clean failures without hanging.

**Section sources**
- [packages/tcp/src/tcp-connection-common.ts:65-88](file://packages/tcp/src/tcp-connection-common.ts#L65-L88)
- [packages/tcp/src/tcp-stream-engine.ts:180-195](file://packages/tcp/src/tcp-stream-engine.ts#L180-L195)
- [packages/tcp/src/tcp-stream-engine.ts:216-237](file://packages/tcp/src/tcp-stream-engine.ts#L216-L237)
- [docs/research/effect-v4-platform-tcp-connection.md:422-461](file://docs/research/effect-v4-platform-tcp-connection.md#L422-L461)

## Conclusion
This Effect-based TCP stream library delivers a robust, cross-platform networking solution built on modern functional programming principles. The migration to a Bun monorepo workspace structure provides better organization, independent package management, and clearer separation between the core TCP library and learning examples. By unifying Bun, Node.js, and Effect Platform under a single API within the tcp package, it enables developers to build resilient clients and services with predictable lifecycle management, backpressure-aware I/O, and composable retry and timeout strategies. Its layered architecture and comprehensive test coverage also make it an excellent learning resource for understanding contemporary asynchronous I/O patterns in TypeScript with Effect v4.

[No sources needed since this section summarizes without analyzing specific files]